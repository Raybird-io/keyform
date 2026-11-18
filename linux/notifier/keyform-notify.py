#!/usr/bin/env python3
"""
Keyform notifier: shows which layer your keyboard is on.

How it works
  The Keyform firmware briefly sends a reserved key code (0xA5 + layer ID) whenever the active
  layer changes. Computers ignore those codes, so nothing is typed. This program reads them
  straight from the keyboard (/dev/hidraw*), shows a notification, and tells Keyform.

Files
  ~/.config/keyform/notify.json   settings (Keyform sends them; you can also edit it)
  ~/.config/keyform/token         secret key shared with your installed Keyform
  $XDG_RUNTIME_DIR/keyform-layer  current layer name, for status bars (cleared at logout)

Live link for Keyform (this computer only, needs the secret key as ?t=...)
  GET  /events     current layer, live (server-sent events)
  GET  /state      current layer once, as JSON
  POST /settings   notification settings from Keyform

Usage
  keyform-notify             run (normally started by the systemd user service)
  keyform-notify --devices   list matching keyboards
  keyform-notify --test N    show the notification for layer ID N
"""
import glob, hmac, json, os, re, select, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CONF_DIR = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'keyform')
CONFIG = os.path.join(CONF_DIR, 'notify.json')
TOKEN_FILE = os.path.join(CONF_DIR, 'token')
DOWNLOADS = os.path.expanduser('~/Downloads')
RUNTIME = os.environ.get('XDG_RUNTIME_DIR') or '/tmp'
ICON = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), 'icons/hicolor/scalable/apps/keyform.svg')
REPORT_BASE, REPORT_COUNT = 0xA5, 11   # must match firmware/zmk-config/src/layer_report.c
PORT = 47811


def log(*a):
    print('keyform-notify:', *a, flush=True)


# ---------------------------------------------------------------- settings

def clean(raw, trusted=False):
    """Keep only known settings with sane values. Anything else is dropped.
    trusted=True (your own file) also allows a custom notification icon."""
    raw = raw if isinstance(raw, dict) else {}
    text = lambda v, n: re.sub(r'[\x00-\x1f\x7f]', '', str(v))[:n]
    hex4 = lambda v, d: v.lower() if isinstance(v, str) and re.fullmatch(r'[0-9a-fA-F]{4}', v) else d
    kb = raw.get('keyboard') if isinstance(raw.get('keyboard'), dict) else {}
    out = {
        'keyboard': {'vendor': hex4(kb.get('vendor'), '1d50'), 'product': hex4(kb.get('product'), '615e')},
        'timeout_ms': min(max(int(raw.get('timeout_ms', 2000)) if str(raw.get('timeout_ms', '')).isdigit() else 2000, 500), 10000),
        'notify_unknown_layers': raw.get('notify_unknown_layers', True) is True,
        'layers': {},
    }
    layers = raw.get('layers') if isinstance(raw.get('layers'), dict) else {}
    for key, entry in list(layers.items())[:32]:
        if str(key).isdigit() and int(key) < REPORT_COUNT and isinstance(entry, dict):
            out['layers'][str(int(key))] = {
                'name': text(entry.get('name', ''), 40),
                'notify': entry.get('notify', True) is True,
                'message': text(entry.get('message', ''), 120),
            }
    if trusted and isinstance(raw.get('icon'), str):
        out['icon'] = raw['icon'][:300]
    return out


def write_json(path, data):
    """Write a file in one step, so it's never half-written."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def adopt_downloads():
    """Fallback when the live link is off: Keyform saves keyform-notify.json to Downloads.
    Take the newest copy into the settings, then remove all copies, so nothing piles up."""
    copies = sorted(glob.glob(os.path.join(DOWNLOADS, 'keyform-notify*.json')), key=os.path.getmtime)
    if not copies:
        return
    try:
        write_json(CONFIG, clean(json.load(open(copies[-1]))))
        log('took settings from', copies[-1])
    except Exception as e:
        log('ignoring', copies[-1], e)
    for c in copies:
        try:
            os.remove(c)
        except OSError:
            pass


_cache = {'mtime': None, 'cfg': clean({})}


def settings():
    """Current settings; the file is only read again when it changed."""
    try:
        mtime = os.path.getmtime(CONFIG)
    except OSError:
        return _cache['cfg']
    if mtime != _cache['mtime']:
        try:
            _cache['cfg'] = clean(json.load(open(CONFIG)), trusted=True)
        except Exception as e:
            log('could not read', CONFIG, e)
        _cache['mtime'] = mtime
    return _cache['cfg']


def layer_name(layer_id, cfg):
    name = cfg['layers'].get(str(layer_id), {}).get('name')
    return name or ('Base' if layer_id == 0 else f'Layer {layer_id}')


# ---------------------------------------------------------------- keyboard

def find_devices(vendor, product):
    """The keyboard's HID devices (USB and Bluetooth), found by vendor and product ID."""
    want = f'{int(vendor, 16):08X}:{int(product, 16):08X}'
    found = []
    for uevent in glob.glob('/sys/class/hidraw/hidraw*/device/uevent'):
        try:
            ids = [l.split('=', 1)[1].strip() for l in open(uevent) if l.startswith('HID_ID=')]
        except OSError:
            continue
        if ids and ids[0].upper().endswith(want):
            found.append('/dev/' + os.path.basename(os.path.dirname(os.path.dirname(uevent))))
    return sorted(found)


def layer_codes(report):
    """Layer IDs present in a keyboard report (report ID 1)."""
    if not report or report[0] != 1:
        return set()
    if len(report) <= 9:  # 6-key report: id, modifiers, reserved, 6 key codes
        return {b - REPORT_BASE for b in report[3:] if REPORT_BASE <= b < REPORT_BASE + REPORT_COUNT}
    return {i for i in range(REPORT_COUNT)  # NKRO report: id, modifiers, one bit per key
            if 2 + (REPORT_BASE + i) // 8 < len(report) and report[2 + (REPORT_BASE + i) // 8] >> ((REPORT_BASE + i) % 8) & 1}


# ---------------------------------------------------------------- notifications

class Notifier:
    def __init__(self):
        self.last_shown = None

    def on_layer(self, layer_id, cfg):
        entry = cfg['layers'].get(str(layer_id))
        if entry is None and not cfg['notify_unknown_layers']:
            return
        if entry is not None and not entry['notify']:
            return  # e.g. a hold layer like Nav, so letting go of Fn doesn't notify again
        if layer_id == self.last_shown:
            return
        self.last_shown = layer_id
        name = layer_name(layer_id, cfg)
        message = (entry or {}).get('message') or f'{name} layer'
        try:
            with open(os.path.join(RUNTIME, 'keyform-layer'), 'w') as f:
                f.write(name + '\n')
        except OSError:
            pass
        icon = cfg.get('icon') or (ICON if os.path.exists(ICON) else 'input-keyboard')
        try:  # arguments as a list: no shell, so a message can never run a command
            subprocess.run(['notify-send', '-a', 'Keyform', '-i', icon, '-t', str(cfg['timeout_ms']),
                            '-h', 'string:x-canonical-private-synchronous:keyform-layer',
                            '-h', 'string:synchronous:keyform-layer', message], timeout=5)
        except Exception as e:
            log('notify-send failed:', e)


# ---------------------------------------------------------------- live link for Keyform

class LiveState:
    """The keyboard's current layer, shared with Keyform."""

    def __init__(self):
        self.cond = threading.Condition()
        self.version = 0
        self.data = {'id': None, 'name': None, 'assumed': True, 'keyboard': False}

    def set(self, **changes):
        with self.cond:
            if all(self.data.get(k) == v for k, v in changes.items()):
                return
            self.data.update(changes)
            self.version += 1
            self.cond.notify_all()

    def wait(self, version, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.version != version, timeout=timeout)
            return self.version, dict(self.data)


def read_token():
    try:
        return open(TOKEN_FILE).read().strip()
    except OSError:
        return ''


def start_live_link(state):
    token = read_token()
    if not token:
        log('live link off: no secret key yet (run ./linux/install.sh)')
        return

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def allowed(self):
            given = parse_qs(urlparse(self.path).query).get('t', [''])[0]
            if hmac.compare_digest(given, token):
                return True
            self.send_response(403)
            self.end_headers()
            return False

        def start(self, code, ctype=None):
            self.send_response(code)
            self.send_header('Access-Control-Allow-Origin', '*')  # safe: nothing works without the key
            if ctype:
                self.send_header('Content-Type', ctype)
            self.end_headers()

        def do_GET(self):
            if not self.allowed():
                return
            path = urlparse(self.path).path
            if path == '/state':
                self.start(200, 'application/json')
                self.wfile.write(json.dumps(state.wait(-1, 0)[1]).encode())
            elif path == '/events':
                self.start(200, 'text/event-stream')
                version, data = state.wait(-1, 0)
                try:
                    while True:
                        self.wfile.write(b'data: ' + json.dumps(data).encode() + b'\n\n')
                        self.wfile.flush()
                        new, data = state.wait(version, 25)
                        if new == version:
                            self.wfile.write(b': ping\n\n')  # notices when Keyform has closed
                            self.wfile.flush()
                        version = new
                except OSError:
                    pass
            else:
                self.start(404)

        def do_POST(self):
            if not self.allowed():
                return
            if urlparse(self.path).path != '/settings':
                return self.start(404)
            try:
                length = min(int(self.headers.get('Content-Length', 0)), 32768)
                cfg = clean(json.loads(self.rfile.read(length)))
                old = settings()
                if 'icon' in old:
                    cfg['icon'] = old['icon']  # keep your own icon choice
                write_json(CONFIG, cfg)
                if state.data['id'] is not None:
                    state.set(name=layer_name(state.data['id'], cfg))
                self.start(204)
            except Exception as e:
                log('rejected settings:', e)
                self.start(400)

    try:
        server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)  # 127.0.0.1: this computer only
    except OSError as e:
        log(f'live link off: port {PORT} busy ({e})')
        return
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f'live link on 127.0.0.1:{PORT}')


# ---------------------------------------------------------------- main loop

def run(device_override=None):
    notifier, state = Notifier(), LiveState()
    adopt_downloads()
    start_live_link(state)
    open_devs = {}   # path -> [file descriptor, layer codes in the previous report]
    next_scan = 0
    while True:
        cfg = settings()
        # look for the keyboard: often while it's missing, rarely once found (to spot Bluetooth too)
        if time.time() >= next_scan:
            adopt_downloads()
            paths = [device_override] if device_override else find_devices(cfg['keyboard']['vendor'], cfg['keyboard']['product'])
            for p in paths:
                if p in open_devs:
                    continue
                try:
                    open_devs[p] = [os.open(p, os.O_RDONLY | os.O_NONBLOCK), set()]
                    log('listening on', p)
                    if not state.data['keyboard']:  # a keyboard that just appeared starts on its base layer
                        state.set(id=0, name=layer_name(0, cfg), assumed=True, keyboard=True)
                except OSError as e:
                    log('cannot open', p, '-', e, '(see the udev rule in the README)')
            next_scan = time.time() + (60 if open_devs else 3)
        if not open_devs:
            if device_override:
                return 1
            time.sleep(max(0.1, next_scan - time.time()))
            continue
        # sleep until the keyboard sends something (no busy waiting)
        ready, _, _ = select.select([d[0] for d in open_devs.values()], [], [], max(0.1, next_scan - time.time()))
        for p, dev in list(open_devs.items()):
            if dev[0] not in ready:
                continue
            try:
                data = os.read(dev[0], 64)
            except BlockingIOError:
                continue
            except OSError:
                data = b''
            if not data:  # unplugged
                os.close(dev[0])
                del open_devs[p]
                log('lost', p)
                if not open_devs:
                    state.set(keyboard=False)
                    next_scan = 0
                    if device_override:
                        return 0
                continue
            codes = layer_codes(data)
            if codes - dev[1]:
                cfg = settings()  # pick up settings that changed while waiting
            for layer_id in sorted(codes - dev[1]):
                state.set(id=layer_id, name=layer_name(layer_id, cfg), assumed=False, keyboard=True)
                notifier.on_layer(layer_id, cfg)
            dev[1] = codes


def main(argv):
    if '--devices' in argv:
        cfg = settings()
        print('\n'.join(find_devices(cfg['keyboard']['vendor'], cfg['keyboard']['product'])) or 'No matching keyboard found.')
        return 0
    if '--test' in argv:
        Notifier().on_layer(int(argv[argv.index('--test') + 1]), settings())
        return 0
    try:
        return run(argv[argv.index('--device') + 1] if '--device' in argv else None) or 0
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
