import { StudioDevice, DemoDevice, rememberedPorts, rememberPort } from './device.js';
import {
  ALL_USAGES, KEY_GROUPS, MOD_BITS, PAGE_KEYBOARD, PAGE_CONSUMER,
  encodeUsage, decodeUsage, usageLabel, usageName, usageForCode, modsLabel,
} from './hid.js';

const $ = (sel, el = document) => el.querySelector(sel);
// Makes an element. Text is always added as plain text, never as HTML.
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};

// ---------------------------------------------------------------- state
const S = {
  device: null,
  behaviors: [],          // {id, name, metadata, kind}
  byKind: {},
  layout: null,           // {name, keys}
  keymap: null,           // {layers, availableLayers, maxLayerNameLength}
  layerIndex: 0,
  selected: null,         // key position
  cat: 'keys',
  mods: 0,
  search: '',
  ovQuery: '',            // Overview search
  miniQuery: '',          // search in the small "Choose key" picker
  unsaved: false,
  view: 'home',
  activeLayer: null,      // live layer from the notifier: {id, name, assumed, keyboard}
  liveLink: 'off',        // 'on' when the notifier's live link is reachable
  live: true,
  pressed: new Set(),     // HID usage keys (page*65536+id) currently held
  tested: new Set(),      // key positions pressed in tester
  advBehavior: null,
  advParams: { p1: null, p2: null },
  advPicker: null,        // 'p1' | 'p2' while choosing a key
  renaming: false,
  confirmDelete: false,
  copyOpen: false,        // "Copy keys from…" row open
  copySource: null,       // layer id chosen in that row
  notifyOpen: false,      // notification settings row open
  applyTo: new Set(),     // extra layer ids a key change is also written to
  lastPressed: null,
  ovFilter: 'all',
};

const KIND_RULES = [
  ['kp', /^key ?press$/], ['trans', /^transparent$/], ['none', /^none$/],
  ['mo', /^momentary layer$/], ['tog', /^toggle layer$/], ['to', /^to layer$/],
  ['lt', /^layer[- ]?tap$/], ['mt', /^mod[- ]?tap$/], ['bt', /^bluetooth$/],
  ['out', /^output selection$/], ['unlock', /^studio unlock$/], ['dbl', /^double tap( \(.*\))?$/],
];
const kindOf = (name) => (KIND_RULES.find(([, re]) => re.test(name.toLowerCase())) || [null])[0];

const layers = () => S.keymap?.layers || [];
const curLayer = () => layers()[S.layerIndex];
const layerName = (l, i) => (l?.name && l.name.trim()) || (i === 0 ? 'Base' : `Layer ${i}`);
const layerById = (id) => { const i = layers().findIndex((l) => l.id === id); return i < 0 ? null : { layer: layers()[i], index: i }; };
const behavior = (id) => S.behaviors.find((b) => b.id === id);
// Double Tap comes in several speeds, one firmware behavior each:
// "Double Tap" (200 ms), "Double Tap (Fast)" (150), "Double Tap (Relaxed)" (250), "Double Tap (175 ms)"...
const DEFAULT_MS = 200;
const speedMs = (b) => {
  const m = b?.name.match(/\(([^)]+)\)/);
  if (!m) return DEFAULT_MS;
  const named = { fast: 150, normal: 200, relaxed: 250 }[m[1].toLowerCase()];
  return named || parseInt(m[1], 10) || DEFAULT_MS;
};
const dblVariants = () => S.behaviors.filter((b) => b.kind === 'dbl').sort((a, b) => speedMs(a) - speedMs(b));
const isTrans = (bnd) => behavior(bnd?.behaviorId)?.kind === 'trans';
const sameBinding = (a, b) => !!a && !!b && a.behaviorId === b.behaviorId && (a.param1 >>> 0) === (b.param1 >>> 0) && (a.param2 >>> 0) === (b.param2 >>> 0);

// ---------------------------------------------------------------- labels
function constName(b, which, value) {
  for (const set of b.metadata || []) for (const d of set[which] || []) if (d.constant === value) return d.name;
  return null;
}

function labelFor(binding, layerIdx = S.layerIndex) {
  const b = behavior(binding?.behaviorId);
  if (!b) return { main: '?', sub: '', cls: 'dim' };
  const p1 = binding.param1 >>> 0, p2 = binding.param2 >>> 0;
  const lname = (id) => { const f = layerById(id); return f ? layerName(f.layer, f.index) : `L${id}`; };
  switch (b.kind) {
    case 'kp': {
      const d = decodeUsage(p1);
      if (d.page === PAGE_CONSUMER) return { main: usageLabel(p1), sub: 'media', cls: 'k-media' };
      const shiftedSym = (d.mods === 0x02 || d.mods === 0x20) && d.usage?.shifted;
      if (d.mods && !shiftedSym) return { main: usageLabel(d.page * 0x10000 + d.id), sub: modsLabel(d.mods), cls: 'k-mod' };
      return { main: usageLabel(p1), sub: shiftedSym ? 'shift+' + d.usage.label : '', cls: shiftedSym ? 'k-mod' : '' };
    }
    case 'trans': {
      for (let i = layerIdx - 1; i >= 0; i--) {
        const below = layers()[i]?.bindings[binding._pos];
        const bb = below && behavior(below.behaviorId);
        if (bb && bb.kind !== 'trans') return { ...labelFor({ ...below, _pos: binding._pos }, i), sub: '', cls: 'dim' };
      }
      return { main: '', sub: '', cls: 'dim' };
    }
    case 'none': return { main: '—', sub: '', cls: 'dim' };
    case 'mo': return { main: lname(p1), sub: 'hold layer', cls: 'k-layer' };
    case 'tog': return { main: lname(p1), sub: 'toggle', cls: 'k-layer' };
    case 'to': return { main: lname(p1), sub: 'switch to', cls: 'k-layer' };
    case 'lt': return { main: usageLabel(p2), sub: 'hold ' + lname(p1), cls: 'k-layer' };
    case 'mt': return { main: usageLabel(p2), sub: 'hold ' + usageLabel(p1), cls: 'k-layer' };
    case 'dbl': return { main: usageLabel(p1), sub: '2× ' + usageLabel(p2) + (speedMs(b) === DEFAULT_MS ? '' : ` ${speedMs(b)}ms`), cls: 'k-layer' };
    case 'bt': {
      const n = (constName(b, 'param1', p1) || '').toLowerCase();
      if (n.includes('all')) return { main: 'BT', sub: 'clear all', cls: 'k-bt' };
      if (n.includes('clear')) return { main: 'BT', sub: 'clear', cls: 'k-bt' };
      if (n.includes('disconnect')) return { main: `BT ${p2 + 1}`, sub: 'disconnect', cls: 'k-bt' };
      if (n.includes('select')) return { main: `BT ${p2 + 1}`, sub: '', cls: 'k-bt' };
      if (n.includes('next')) return { main: 'BT', sub: 'next', cls: 'k-bt' };
      if (n.includes('prev')) return { main: 'BT', sub: 'previous', cls: 'k-bt' };
      return { main: 'BT', sub: n, cls: 'k-bt' };
    }
    case 'out': {
      const n = (constName(b, 'param1', p1) || '').toLowerCase();
      return { main: n.includes('usb') ? 'USB' : n.includes('ble') ? 'BLE' : 'USB/BLE', sub: 'output', cls: 'k-bt' };
    }
    default: {
      const short = { 'grave/escape': 'Esc `', 'caps word': 'CapsWd', 'key repeat': 'Repeat', bootloader: 'Boot', reset: 'Reset', 'studio unlock': 'Unlock' }[b.name.toLowerCase()];
      return { main: short || b.name, sub: short ? '' : 'action' };
    }
  }
}

const TYPES = {
  layer: { label: 'Layer', color: 'var(--layer)' },
  taphold: { label: 'Tap-hold', color: 'var(--tap)' },
  dance: { label: 'Double press', color: 'var(--tap)' },
  shortcut: { label: 'Shortcut', color: 'var(--mod)' },
  media: { label: 'Media', color: 'var(--accent)' },
  bt: { label: 'Bluetooth', color: 'var(--bt)' },
  special: { label: 'Special', color: 'var(--muted)' },
  other: { label: 'Other', color: 'var(--muted)' },
};

// Returns null for an ordinary key (plain letter, transparent, none)
function classify(binding) {
  const b = behavior(binding?.behaviorId);
  if (!b) return null;
  const nm = b.name.toLowerCase();
  switch (b.kind) {
    case 'trans': case 'none': return null;
    case 'kp': {
      const d = decodeUsage(binding.param1);
      if (d.page === PAGE_CONSUMER) return 'media';
      return d.mods ? 'shortcut' : null;
    }
    case 'mo': case 'tog': case 'to': return 'layer';
    case 'lt': case 'mt': return 'taphold';
    case 'bt': case 'out': return 'bt';
  }
  if (/dance|double/.test(nm)) return 'dance';
  if (/tap|hold/.test(nm)) return 'taphold';
  if (/sticky layer/.test(nm)) return 'layer';
  if (/grave|caps word|repeat|bootloader|reset|unlock|sticky key|key toggle/.test(nm)) return 'special';
  return 'other';
}

function describeLong(binding) {
  const b = behavior(binding?.behaviorId);
  if (!b) return 'Unknown action';
  const p1 = binding.param1 >>> 0, p2 = binding.param2 >>> 0;
  const lname = (id) => { const f = layerById(id); return f ? `"${layerName(f.layer, f.index)}"` : `layer ${id}`; };
  const nm = b.name.toLowerCase();
  switch (b.kind) {
    case 'kp': {
      const d = decodeUsage(p1);
      if (d.page === PAGE_CONSUMER) return 'Media key: ' + usageName(p1);
      return d.mods ? 'Sends ' + usageName(p1) : usageName(p1);
    }
    case 'trans': return 'Transparent: does whatever the layer below does';
    case 'none': return 'Does nothing';
    case 'mo': return `Hold to use layer ${lname(p1)}`;
    case 'tog': return `Press to turn layer ${lname(p1)} on or off`;
    case 'to': return `Switches to layer ${lname(p1)}`;
    case 'lt': return `Tap: ${usageName(p2)}  ·  Hold: layer ${lname(p1)}`;
    case 'mt': return `Tap: ${usageName(p2)}  ·  Hold: ${usageName(p1)}`;
    case 'dbl': return `Tap: ${usageName(p1)}  ·  Double tap: ${usageName(p2)}` + `  ·  waits ${speedMs(b)} ms for a second tap`;
    case 'bt': {
      const n = constName(b, 'param1', p1) || 'Bluetooth';
      return /select|disconnect/i.test(n) ? `Bluetooth: ${n} (device ${p2 + 1})` : `Bluetooth: ${n}`;
    }
    case 'out': return 'Output: ' + (constName(b, 'param1', p1) || 'switch');
  }
  if (nm === 'grave/escape') return 'Escape, or ` (backtick) when Shift or Win is held';
  if (nm === 'caps word') return 'Caps Word: types the next word in capitals';
  if (nm === 'key repeat') return 'Repeats the last key you pressed';
  if (nm === 'bootloader') return 'Puts the keyboard into update (flashing) mode';
  if (nm === 'reset') return 'Restarts the keyboard';
  if (nm === 'studio unlock') return 'Unlocks ZMK Studio / Keyform editing';
  const parts = [b.name];
  const c1 = constName(b, 'param1', p1);
  if (c1) parts.push(c1); else if (p1) parts.push(String(p1));
  if (p2) parts.push(String(p2));
  return parts.join(' · ');
}

function describeBinding(binding) {
  const b = behavior(binding?.behaviorId);
  if (!b) return 'Unknown';
  if (b.kind === 'kp') return usageName(binding.param1);
  if (b.kind === 'trans') return 'Transparent (uses the layer below)';
  const l = labelFor(binding);
  return [b.name, l.main && l.main !== b.name ? l.main : ''].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- device actions
async function guard(fn) {
  try { return await fn(); } catch (e) {
    const msg = e?.condition === 1 ? 'The keyboard is locked. Press your Studio unlock key, then try again.' : (e?.message || String(e));
    toast(msg, true);
    console.error(e);
  }
}

const prefs = {
  get auto() { try { return localStorage.getItem('keyform.auto') !== 'off'; } catch { return true; } },
  set auto(v) { try { localStorage.setItem('keyform.auto', v ? 'on' : 'off'); } catch {} },
};

let connecting = false;
async function start(demo, port, { quiet } = {}) {
  if (connecting || S.device) return;
  connecting = true;
  const dev = demo ? new DemoDevice() : new StudioDevice();
  busy('Connecting…');
  try {
    await dev.connect(port);
    if (dev.port) rememberPort(dev.port); // so next time we can connect without asking
    const name = dev.name;
    S.device = dev;
    dev.on(onDeviceEvent);
    if (await dev.isLocked()) {
      busy('Keyboard locked', 'Press the Studio unlock key on your keyboard to continue.');
      await new Promise((res) => { const off = dev.on((ev) => { if (ev.type === 'lock' && !ev.locked) { off(); res(); } }); });
    }
    busy('Reading your keyboard…');
    const behaviors = await dev.getBehaviors();
    S.behaviors = behaviors.map((b) => ({ ...b, kind: kindOf(b.name) })).sort((a, b) => a.name.localeCompare(b.name));
    S.byKind = Object.fromEntries(S.behaviors.filter((b) => b.kind).map((b) => [b.kind, b]));
    S.layout = await dev.getLayout();
    S.keymap = await dev.getKeymap();
    S.unsaved = await dev.hasUnsaved();
    $('#devname').textContent = name;
    $('#devpill').classList.add('on');
    S.layerIndex = 0; S.selected = null;
    setView('home');
    syncNotifier();
    if (await tidyLayers()) { renderAll(); toast('Moved your hold layer to the end so your Fn key works on every layer. Click Save to keep it.'); }
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    if (!quiet && e?.name !== 'NotFoundError') toast(e?.message || String(e), true);
  } finally {
    connecting = false;
    busy(null);
  }
}

// Connect without the picker to a keyboard the browser already allowed
async function autoConnect() {
  if (!prefs.auto || S.device || connecting) return;
  const ports = await rememberedPorts();
  if (!ports.length) return;
  $('#autostatus').hidden = false;
  for (const p of ports) {
    await start(false, p, { quiet: true });
    if (S.device) break;
  }
  $('#autostatus').hidden = true;
}

function onDeviceEvent(ev) {
  if (ev.type === 'unsaved') { S.unsaved = ev.unsaved; renderTop(); }
  if (ev.type === 'disconnected') {
    if (!S.device) return;
    toast('Keyboard disconnected.', true);
    S.device = null;
    $('#devpill').classList.remove('on');
    $('#devname').textContent = 'Not connected';
    setView('home');
  }
}

async function reloadKeymap() {
  S.keymap = await S.device.getKeymap();
  S.layerIndex = Math.min(S.layerIndex, layers().length - 1);
  syncNotifier();
  const ids = new Set(layers().map((l) => l.id));
  for (const id of S.applyTo) if (!ids.has(id)) S.applyTo.delete(id);
}

async function assign(binding) {
  const layer = curLayer();
  if (S.selected === null || !layer) return;
  const pos = S.selected;
  const targets = [layer, ...layers().filter((l) => l !== layer && S.applyTo.has(l.id))];
  await guard(async () => {
    let n = 0;
    for (const l of targets) {
      // a see-through key on the base layer would do nothing, so the base keeps its key
      if (l === layers()[0] && behavior(binding.behaviorId)?.kind === 'trans') continue;
      if (l !== layer && sameBinding(l.bindings[pos], binding)) { n++; continue; }
      await S.device.setBinding(l.id, pos, binding);
      l.bindings[pos] = { ...binding };
      n++;
    }
    if (targets.length > 1) toast(`Set on ${n} layer${n === 1 ? '' : 's'}.`);
    S.unsaved = true;
    if (['mo', 'lt', 'tog', 'to'].includes(behavior(binding.behaviorId)?.kind) && await tidyLayers()) { S.selected = null; renderAll(); return; }
    renderBoard();
    renderPanel();
    renderTop();
    const el = document.querySelector(`.key[data-pos="${pos}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  });
}

const kp = (page, id, mods = 0) => ({ behaviorId: S.byKind.kp.id, param1: encodeUsage(page, id, mods), param2: 0 });

// ---------------------------------------------------------------- rendering
function renderTop() {
  $('#save').disabled = !S.device || !S.unsaved;
  $('#discard').disabled = !S.device || !S.unsaved;
  $('#unsaved').hidden = !S.unsaved;
  document.querySelectorAll('.views button').forEach((b) => { b.classList.toggle('active', b.dataset.view === S.view); b.disabled = !S.device && b.dataset.view !== 'home'; });
}

function setView(v) {
  if (!S.device) v = 'home';
  S.view = v;
  $('#home').hidden = v !== 'home';
  $('#welcome').hidden = !!S.device || v !== 'home';
  $('#editor').hidden = v !== 'remap' || !S.device;
  $('#tester').hidden = v !== 'test' || !S.device;
  $('#overview').hidden = v !== 'overview' || !S.device;
  renderAll();
  if (v === 'remap' && S.selected !== null) setTimeout(() => document.querySelector('.key.selected')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
}

// Small keyboard thumbnail with one key highlighted, so you can see where a key is
function miniMap(pos) {
  const keys = S.layout.keys, U = 6;
  const maxX = Math.max(...keys.map((k) => k.x + k.width)) / 100;
  const maxY = Math.max(...keys.map((k) => k.y + k.height)) / 100;
  return h('span', { class: 'ov-map', style: `width:${maxX * U}px;height:${maxY * U}px` }, keys.map((k, i) => h('i', {
    class: i === pos ? 'on' : '',
    style: `left:${(k.x / 100) * U}px;top:${(k.y / 100) * U}px;width:${(k.width / 100) * U - 1}px;height:${(k.height / 100) * U - 1}px`,
  })));
}

function positionHint(pos) {
  const bnd = layers()[0]?.bindings[pos];
  const b = behavior(bnd?.behaviorId);
  if (b?.kind === 'kp' && !classify(bnd)) return `the ${usageLabel(bnd.param1)} key`;
  return `key ${pos + 1}`;
}

function renderOverview() {
  const root = $('#overview');
  root.replaceChildren();
  const entries = [];
  layers().forEach((l, li) => l.bindings.forEach((bnd, pos) => {
    const t = classify(bnd);
    if (t) entries.push({ li, pos, t, bnd });
  }));
  const counts = {};
  for (const e of entries) counts[e.t] = (counts[e.t] || 0) + 1;
  const filter = S.ovFilter && counts[S.ovFilter] ? S.ovFilter : 'all';
  root.append(h('div', { class: 'ov-head' },
    h('div', {}, h('h2', {}, 'Overview'), h('p', { class: 'hint', style: 'margin:4px 0 0' }, 'Every key that does more than type a single character, on every layer. Click one to edit it.')),
  ));
  const q = h('input', { class: 'search ov-search', placeholder: 'Search keys on all layers… (e.g. "double tap", "game", "bluetooth", "Q")', value: S.ovQuery });
  q.addEventListener('input', () => { S.ovQuery = q.value; renderOverview(); const n = $('.ov-search'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
  q.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' && q.value) { S.ovQuery = ''; renderOverview(); $('.ov-search').focus(); } });
  root.append(h('div', { class: 'toolbar ov-searchbar' }, q));
  root.append(h('div', { class: 'ov-filters' },
    h('button', { class: 'ov-filter' + (filter === 'all' ? ' on' : ''), onclick: () => { S.ovFilter = 'all'; renderOverview(); } }, 'All ', h('b', {}, String(entries.length))),
    Object.entries(TYPES).filter(([k]) => counts[k]).map(([k, t]) => h('button', {
      class: 'ov-filter' + (filter === k ? ' on' : ''), onclick: () => { S.ovFilter = k; renderOverview(); },
    }, h('i', { style: `background:${t.color}` }), t.label + ' ', h('b', {}, String(counts[k])))),
  ));
  // search: every word must appear in what the key does, its name, its layer or where it sits
  const words = S.ovQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = (e) => {
    const lab = labelFor({ ...e.bnd, _pos: e.pos }, e.li);
    return [layerName(layers()[e.li], e.li), lab.main, lab.sub, describeLong(e.bnd), positionHint(e.pos), `key ${e.pos + 1}`, TYPES[e.t].label].join(' ').toLowerCase();
  };
  const shown = entries.filter((e) => (filter === 'all' || e.t === filter) && (!words.length || words.every((w) => haystack(e).includes(w))));
  if (!entries.length) {
    root.append(h('div', { class: 'empty board-card' }, 'No special keys yet. Every key just types its letter.'));
  } else if (!shown.length) {
    root.append(h('div', { class: 'empty board-card' }, `No keys match "${S.ovQuery.trim()}".`));
  }
  layers().forEach((l, li) => {
    const rows = shown.filter((e) => e.li === li);
    if (!rows.length) return;
    root.append(h('div', { class: 'ov-layer' },
      h('div', { class: 'ov-layer-head' }, h('span', { class: 'num' }, String(li)), layerName(l, li), h('small', {}, `${rows.length} key${rows.length === 1 ? '' : 's'}`)),
      rows.map((e) => {
        const t = TYPES[e.t];
        const lab = labelFor({ ...e.bnd, _pos: e.pos }, e.li);
        return h('button', {
          class: 'ov-row',
          onclick: () => { S.layerIndex = e.li; S.selected = e.pos; S.advBehavior = null; S.cat = e.t === 'layer' ? 'layers' : e.t === 'bt' ? 'bt' : e.t === 'media' ? 'media' : e.t === 'shortcut' ? 'keys' : e.t === 'special' ? 'special' : 'advanced'; setView('remap'); },
        },
          h('span', { class: 'ov-pos' }, miniMap(e.pos), h('small', {}, e.li === 0 ? `key ${e.pos + 1}` : positionHint(e.pos))),
          h('span', { class: 'ov-arrow' }, '→'),
          h('span', { class: 'ov-what' }, h('b', {}, [lab.main, lab.sub].filter(Boolean).join(' · ')), h('span', {}, describeLong(e.bnd))),
          h('span', { class: 'ov-type', style: `color:${t.color};border-color:${t.color}` }, t.label),
        );
      })));
  });
  root.append(h('p', { class: 'hint', style: 'margin-top:18px' }, 'Double-tap keys: pick a key, then Advanced → Double Tap (needs the Double Tap firmware). Combos and macros show up here if they are in your firmware; creating those needs a firmware change.'));
}

// ---------------------------------------------------------------- live layer + home page
const LIVE_URL = 'http://127.0.0.1:47811';
// Secret key shared with the notifier. The installer writes it into the installed copy of this
// page, so only your Keyform can use the link (not websites or other programs).
const LIVE_KEY = document.querySelector('meta[name="keyform-token"]')?.content || '';
const liveUrl = (path) => `${LIVE_URL}${path}?t=${encodeURIComponent(LIVE_KEY)}`;

// The notifier hears the keyboard's layer changes and shares them on this computer only.
// When it isn't running, try again after 2 s, then 4, 8 … up to once a minute.
let liveRetry = 2000;
function startLiveLink() {
  if (!LIVE_KEY || typeof EventSource === 'undefined') { S.liveLink = 'nokey'; refreshLive(); return; }
  const es = new EventSource(liveUrl('/events'));
  es.onmessage = (e) => {
    try { S.activeLayer = JSON.parse(e.data); } catch {}
    if (S.liveLink !== 'on') { S.liveLink = 'on'; liveRetry = 2000; syncNotifier(); }
    refreshLive();
  };
  es.onerror = () => {
    es.close();
    if (S.liveLink !== 'off') { S.liveLink = 'off'; refreshLive(); }
    setTimeout(startLiveLink, liveRetry);
    liveRetry = Math.min(liveRetry * 2, 60000);
  };
}

function refreshLive() {
  if (S.view === 'home') renderHome();
  if (S.device && S.view === 'remap') renderLayerbar();
}

// The active layer as Keyform knows it: name and position from the keymap when connected
function activeInfo() {
  const a = S.activeLayer;
  if (!a || a.id === null || a.id === undefined || !a.keyboard || S.liveLink !== 'on') return null;
  const f = S.keymap ? layerById(a.id) : null;
  return f ? { id: a.id, name: layerName(f.layer, f.index), index: f.index, assumed: a.assumed } : { id: a.id, name: a.name || `Layer ${a.id}`, index: null, assumed: a.assumed };
}

function renderHome() {
  const root = $('#home');
  root.replaceChildren();
  const info = activeInfo();
  let status;
  if (S.liveLink === 'nokey') status = 'For the live layer, open Keyform from your app menu (the installed copy).';
  else if (S.liveLink !== 'on') status = 'Live layer needs the Keyform notifier on this PC. Install it with linux/install.sh.';
  else if (!S.activeLayer?.keyboard) status = 'The notifier can\'t see your keyboard right now. Plug it in by USB.';
  else if (info?.assumed) status = 'On its base layer: it hasn\'t switched since it was plugged in.';
  else status = 'Live from your keyboard.';

  const liveRow = h('div', { class: 'home-live' + (info ? '' : ' idle') },
    h('div', { class: 'home-badge' }, info ? String(info.index ?? info.id) : '–'),
    h('div', { class: 'home-text' },
      h('div', { class: 'home-label' }, 'Current layer'),
      h('div', { class: 'home-name' }, info ? info.name : 'Unknown'),
      h('div', { class: 'home-status' }, status)));

  if (!S.device) { root.append(liveRow); return; }  // the connect card shows below

  // left: the keys on the layer that is on right now; click one to edit it
  const shown = info?.index ?? 0;
  const board = h('div', { class: 'board' });
  const preview = h('div', { class: 'home-card home-preview' },
    h('div', { class: 'home-card-head' }, h('span', {}, `Keys on ${layerName(layers()[shown], shown)}`),
      h('small', {}, info ? 'follows your keyboard · click a key to edit it' : 'click a key to edit it')),
    h('div', { class: 'home-board' }, board));

  // right: every layer with its notification, and the status of things
  const specials = layers().map((l) => l.bindings.filter((b) => classify(b)).length);
  const layerList = h('div', { class: 'home-card' },
    h('div', { class: 'home-card-head' }, h('span', {}, 'Layers'), h('small', {}, `${S.keymap.availableLayers ?? 0} free slots`)),
    h('div', { class: 'home-rows' }, layers().map((l, i) => {
      const n = notifySettings(l);
      const bell = h('button', {
        class: 'home-bell' + (n.notify ? ' on' : ''),
        title: n.notify ? 'Notifies when this layer turns on. Click to turn off.' : 'No notification. Click to turn on.',
        onclick: (e) => { e.stopPropagation(); setNotify(l, { notify: !n.notify }); renderHome(); },
      }, n.notify ? '🔔' : '🔕');
      const open = () => { S.layerIndex = i; S.selected = null; setView('remap'); };
      // a div, not a button: the bell inside is a button, and buttons can't contain buttons
      return h('div', { class: 'home-row link' + (info?.index === i ? ' is-live' : ''), role: 'button', tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
        h('span', { class: 'home-num' }, String(i)),
        h('span', { class: 'home-row-text' },
          h('b', {}, layerName(l, i), info?.index === i ? h('span', { class: 'live-dot' }) : null),
          h('small', {}, `${n.notify ? '“' + (n.message || layerName(l, i) + ' layer') + '”' : 'No notification'} · ${specials[i]} special`)),
        bell);
    })));

  const counts = {};
  layers().forEach((l) => l.bindings.forEach((b) => { const t = classify(b); if (t) counts[t] = (counts[t] || 0) + 1; }));
  const statusCard = h('div', { class: 'home-card' },
    h('div', { class: 'home-card-head' }, h('span', {}, 'Status')),
    h('div', { class: 'home-rows' },
      h('div', { class: 'home-row static' }, h('span', { class: 'home-row-text' }, h('b', {}, $('#devname').textContent), h('small', {}, 'Keyboard connected'))),
      h('div', { class: 'home-row static' + (S.unsaved ? ' warn' : '') },
        h('span', { class: 'home-row-text' }, h('b', {}, S.unsaved ? 'Unsaved changes' : 'All changes saved'), h('small', {}, S.unsaved ? 'Only kept until the keyboard restarts' : 'Stored on the keyboard')),
        S.unsaved ? h('button', { class: 'btn primary small', onclick: () => $('#save').click() }, 'Save') : null),
      h('div', { class: 'home-row static' }, h('span', { class: 'home-row-text' },
        h('b', {}, S.liveLink === 'on' ? 'Notifier running' : 'Notifier not reachable'),
        h('small', {}, S.liveLink === 'on' ? 'Live layer and notifications are on' : 'Notifications and live layer are off'))),
      h('button', { class: 'home-row', onclick: () => setView('overview') }, h('span', { class: 'home-row-text' },
        h('b', {}, `${Object.values(counts).reduce((a, b) => a + b, 0)} special keys`),
        h('small', {}, Object.entries(TYPES).filter(([k]) => counts[k]).map(([k, t]) => `${t.label} ${counts[k]}`).join(' · ') || 'None yet')))));

  root.append(h('div', { class: 'home-cols' },
    h('div', { class: 'home-main' }, liveRow, preview),
    h('div', { class: 'home-side' }, layerList, statusCard)));
  drawBoard(board, { labelLayer: shown, preview: true, onClick: (pos) => { S.layerIndex = shown; S.selected = pos; setView('remap'); } });
}

function renderAll() {
  renderTop();
  if (S.view === 'home') renderHome();
  if (!S.device) return;
  if (S.view === 'remap') { renderLayerbar(); renderBoard(); renderPanel(); renderLive(); }
  else if (S.view === 'overview') renderOverview();
  else renderTester();
}

function renderLayerbar() {
  const bar = $('#layerbar');
  bar.replaceChildren();
  const tabs = h('div', { class: 'tabs' },
    layers().map((l, i) => h('button', {
      class: 'tab' + (i === S.layerIndex ? ' active' : ''),
      onclick: () => { S.layerIndex = i; S.renaming = false; S.confirmDelete = false; S.copyOpen = false; S.copySource = null; S.advBehavior = null; renderAll(); },
    }, h('span', { class: 'num' }, String(i)), layerName(l, i), activeInfo()?.index === i ? h('span', { class: 'live-dot', title: 'This layer is on right now' }) : null)),
    h('button', {
      class: 'tab add',
      disabled: !(S.keymap.availableLayers > 0),
      title: S.keymap.availableLayers > 0 ? `Add a layer (${S.keymap.availableLayers} free)` : 'No free layer slots in this firmware',
      onclick: () => guard(async () => {
        const res = await S.device.addLayer();
        await reloadKeymap();
        S.layerIndex = res.index; S.unsaved = true;
        await keepHoldLayersLast();
        renderAll();
        toast('Layer added. Give it a key to reach it from another layer.');
      }),
    }, '+ Add layer'),
  );
  const l = curLayer();
  const i = S.layerIndex;
  const actions = h('div', { class: 'layer-actions' });
  if (S.renaming) {
    const input = h('input', { class: 'rename', value: l.name || '', maxlength: S.keymap.maxLayerNameLength || 20, placeholder: layerName(l, i) });
    const done = () => guard(async () => {
      await S.device.renameLayer(l.id, input.value.trim());
      l.name = input.value.trim(); S.renaming = false; S.unsaved = true; renderAll(); syncNotifier();
    });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') { S.renaming = false; renderLayerbar(); } });
    actions.append(input, h('button', { class: 'icon-btn', onclick: done }, 'Done'));
    setTimeout(() => input.focus(), 0);
  } else {
    actions.append(
      h('button', { class: 'icon-btn', title: 'Rename layer', onclick: () => { S.renaming = true; renderLayerbar(); } }, 'Rename'),
      h('button', {
        class: 'icon-btn',
        title: S.keymap.availableLayers > 0 ? 'Make a new layer with all the keys of this one' : 'No free layer slots in this firmware',
        disabled: !(S.keymap.availableLayers > 0),
        onclick: () => duplicateLayer(i),
      }, 'Duplicate'),
      h('button', {
        class: 'icon-btn' + (S.copyOpen ? ' on' : ''),
        title: 'Copy the keys of another layer into this one',
        disabled: layers().length < 2,
        onclick: () => { S.copyOpen = !S.copyOpen; S.copySource = null; renderLayerbar(); },
      }, 'Copy keys from…'),
      h('button', {
        class: 'icon-btn' + (S.notifyOpen ? ' on' : ''),
        title: 'Desktop notification when this layer turns on (needs the Keyform notifier on your PC)',
        onclick: () => { S.notifyOpen = !S.notifyOpen; S.copyOpen = false; renderLayerbar(); },
      }, (notifySettings(l).notify ? '🔔' : '🔕') + ' Notify'),
      h('button', { class: 'icon-btn', title: 'Move left', disabled: i <= 1, onclick: () => moveLayer(i, i - 1) }, '←'),
      h('button', { class: 'icon-btn', title: 'Move right', disabled: i === 0 || i >= layers().length - 1, onclick: () => moveLayer(i, i + 1) }, '→'),
      h('button', {
        class: 'icon-btn danger' + (S.confirmDelete ? ' confirm' : ''),
        title: i === 0 ? 'The base layer cannot be removed' : 'Remove layer',
        disabled: i === 0,
        onclick: () => {
          if (!S.confirmDelete) { S.confirmDelete = true; renderLayerbar(); setTimeout(() => { S.confirmDelete = false; if (S.view === 'remap' && S.device) renderLayerbar(); }, 3000); return; }
          guard(async () => { await S.device.removeLayer(i); await reloadKeymap(); S.confirmDelete = false; S.selected = null; S.unsaved = true; renderAll(); });
        },
      }, S.confirmDelete ? 'Click to confirm' : 'Remove'),
    );
  }
  bar.append(tabs, actions);
  if (S.copyOpen) bar.append(copyRow(l, i));
  if (S.notifyOpen) bar.append(notifyRow(l, i));
}

// ---------------------------------------------------------------- layer notifications
// Stored per layer ID (IDs don't change when layers are reordered), exported for the desktop notifier.
const notifyStore = {
  get() { try { return JSON.parse(localStorage.getItem('keyform.notify') || '{}'); } catch { return {}; } },
  set(v) { try { localStorage.setItem('keyform.notify', JSON.stringify(v)); } catch {} },
};

function notifySettings(l) {
  const saved = notifyStore.get()[l.id] || {};
  return { notify: saved.notify ?? !holdLayerIds().has(l.id), message: saved.message || '' };
}

function setNotify(l, patch) {
  const all = notifyStore.get();
  all[l.id] = { ...notifySettings(l), ...patch };
  notifyStore.set(all);
  syncNotifier();
}

function notifierConfig() {
  const info = S.device?.port?.getInfo?.() || {};
  const hex = (n, d) => (n === undefined ? d : n.toString(16).padStart(4, '0'));
  return {
    keyboard: { vendor: hex(info.usbVendorId, '1d50'), product: hex(info.usbProductId, '615e') },
    timeout_ms: 2000,
    notify_unknown_layers: true,
    layers: Object.fromEntries(layers().map((l, i) => {
      const n = notifySettings(l);
      return [String(l.id), { name: layerName(l, i), notify: n.notify, message: n.message || `${layerName(l, i)} layer` }];
    })),
  };
}

// Send settings (layer names, messages) straight to the notifier; no file to move around.
let syncTimer;
function syncNotifier() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushNotifier().catch(() => {}), 300);
}
async function pushNotifier() {
  if (!S.device || S.liveLink !== 'on' || S.device.isDemo) return false;
  const r = await fetch(liveUrl('/settings'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(notifierConfig()) });
  return r.ok;
}

function saveNotifierFile() {
  const cfg = notifierConfig();
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })), download: 'keyform-notify.json' });
  document.body.append(a); a.click(); a.remove();
  toast('Saved keyform-notify.json to Downloads. The notifier picks it up automatically.');
}

function notifyRow(l, i) {
  const n = notifySettings(l);
  const msg = h('input', { class: 'rename notify-msg', value: n.message, maxlength: 80, placeholder: `${layerName(l, i)} layer` });
  msg.addEventListener('keydown', (e) => e.stopPropagation());
  msg.addEventListener('change', () => setNotify(l, { message: msg.value.trim() }));
  const tog = h('input', { type: 'checkbox', checked: n.notify });
  tog.addEventListener('change', () => { setNotify(l, { notify: tog.checked }); renderLayerbar(); });
  return h('div', { class: 'copy-row notify-row' },
    h('label', { class: 'switch' }, tog, h('span', { class: 'track' }), `Notify when "${layerName(l, i)}" turns on`),
    h('span', { class: 'lbl' }, 'Message:'), msg,
    S.liveLink === 'on'
      ? h('span', { class: 'synced' }, '✓ Saved to the notifier automatically')
      : h('button', { class: 'btn primary', onclick: () => { setNotify(l, { message: msg.value.trim() }); saveNotifierFile(); } }, 'Save notifier settings'),
    h('button', { class: 'icon-btn', onclick: () => { S.notifyOpen = false; renderLayerbar(); } }, 'Close'),
    h('p', { class: 'hint', style: 'flex-basis:100%;margin:2px 0 0' },
      'Hold layers like Nav are off by default, so holding Fn doesn\'t notify. Emoji work too, e.g. "🎮 Game on". ',
      S.liveLink === 'on' ? 'Changes and layer names reach the notifier by themselves.' : 'The notifier isn\'t reachable, so Save writes a file to Downloads that it picks up. Needs the notifier on your PC: run ', S.liveLink === 'on' ? null : h('code', {}, 'linux/install.sh'), S.liveLink === 'on' ? null : ' once.'));
}

function copyRow(l, i) {
  const others = layers().map((x, xi) => [x, xi]).filter(([x]) => x !== l);
  const src = S.copySource !== null ? layerById(S.copySource) : null;
  const emptyCount = src ? l.bindings.filter((b, p) => isTrans(b) && !isTrans(src.layer.bindings[p]) && !sameBinding(b, src.layer.bindings[p])).length : 0;
  const run = (onlyEmpty) => guard(async () => {
    try {
      const n = await copyKeys(l, src.layer, { onlyEmpty });
      S.copyOpen = false; S.copySource = null;
      if (n) S.unsaved = true;
      await keepHoldLayersLast();
      renderAll();
      toast(n ? `Copied ${n} key${n === 1 ? '' : 's'} from "${layerName(src.layer, src.index)}".` : 'Nothing to copy: those keys are already the same.');
    } finally { busy(null); }
  });
  return h('div', { class: 'copy-row' },
    h('span', { class: 'lbl' }, `Copy keys into "${layerName(l, i)}" from:`),
    h('div', { class: 'chips' }, others.map(([x, xi]) => h('button', {
      class: 'chip wide' + (S.copySource === x.id ? ' current' : ''),
      onclick: () => { S.copySource = x.id; renderLayerbar(); },
    }, layerName(x, xi)))),
    src ? h('div', { class: 'copy-go' },
      h('button', { class: 'btn primary', onclick: () => run(false) }, 'Replace all keys'),
      h('button', { class: 'btn', disabled: !emptyCount, onclick: () => run(true) }, `Only fill empty keys (${emptyCount})`),
    ) : null,
    h('button', { class: 'icon-btn', onclick: () => { S.copyOpen = false; S.copySource = null; renderLayerbar(); } }, 'Cancel'),
  );
}

// Write source's keys into target. onlyEmpty: only fill keys that are see-through on target.
async function copyKeys(target, source, { onlyEmpty = false } = {}) {
  const isBase = target === layers()[0];
  const jobs = [];
  source.bindings.forEach((b, pos) => {
    const cur = target.bindings[pos];
    if (onlyEmpty && !isTrans(cur)) return;
    if (isBase && isTrans(b)) return;
    if (sameBinding(cur, b)) return;
    jobs.push([pos, { behaviorId: b.behaviorId, param1: b.param1, param2: b.param2 }]);
  });
  for (let i = 0; i < jobs.length; i++) {
    if (i % 3 === 0) busy('Copying keys…', `${i} of ${jobs.length}`);
    const [pos, b] = jobs[i];
    await S.device.setBinding(target.id, pos, b);
    target.bindings[pos] = b;
  }
  return jobs.length;
}

// Copy a whole layer into a new one, placed right after the original.
// Placing it there (below any hold layers) keeps Fn/hold keys working while the copy is switched on.
function duplicateLayer(i) {
  const src = layers()[i];
  const srcName = layerName(src, i);
  guard(async () => {
    try {
      busy('Duplicating layer…');
      const res = await S.device.addLayer();
      await reloadKeymap();
      let idx = res.index;
      const copy = layers()[idx];
      const max = S.keymap.maxLayerNameLength || 20;
      const name = (srcName.slice(0, max - 5) + ' copy').trim();
      await S.device.renameLayer(copy.id, name);
      copy.name = name;
      await copyKeys(copy, layers()[i]);
      if (idx !== i + 1) {
        busy('Duplicating layer…', 'Putting it next to ' + srcName);
        await S.device.moveLayer(idx, i + 1);
        idx = i + 1;
      }
      await reloadKeymap();
      S.layerIndex = idx; S.selected = null; S.unsaved = true; S.copyOpen = false;
      await keepHoldLayersLast();
      renderAll();
      toast(`"${name}" created. Rename it, change what you need, then give it a Toggle key (Layers tab) to switch it on and off.`);
    } finally { busy(null); }
  });
}

// ZMK lets later layers cover earlier ones. A hold layer (Fn/Nav) placed before a layer that is
// switched on would be hidden, so its Fn key would do nothing there. To keep Fn working on every
// layer, hold layers are always kept last. A hold layer is one reached only by Hold / Layer-Tap keys.
function holdLayerIds() {
  const held = new Set(), switched = new Set();
  for (const l of layers()) for (const bnd of l.bindings) {
    const k = behavior(bnd?.behaviorId)?.kind;
    if (k === 'mo' || k === 'lt') held.add(bnd.param1);
    if (k === 'tog' || k === 'to') switched.add(bnd.param1);
  }
  return new Set([...held].filter((id) => !switched.has(id) && layerById(id)?.index > 0));
}

async function keepHoldLayersLast() {
  const hold = holdLayerIds();
  const order = layers().map((l) => l.id);
  const want = [...order.filter((id) => !hold.has(id)), ...order.filter((id) => hold.has(id))];
  if (want.every((id, i) => id === order[i])) return [];
  const curId = curLayer()?.id;
  const moved = [];
  for (let t = 0; t < want.length; t++) {
    const from = order.indexOf(want[t]);
    if (from === t) continue;
    await S.device.moveLayer(from, t);
    order.splice(t, 0, order.splice(from, 1)[0]);
    if (hold.has(want[t])) moved.push(want[t]);
  }
  const names = [...hold].map((id) => { const f = layerById(id); return `"${layerName(f.layer, f.index)}"`; });
  await reloadKeymap();
  const ci = layers().findIndex((l) => l.id === curId);
  if (ci >= 0) S.layerIndex = ci;
  S.unsaved = true;
  return names;
}

async function tidyLayers() {
  const names = await keepHoldLayersLast();
  if (names.length) toast(`Moved ${names.join(' and ')} to the end so your Fn key works on every layer.`);
  return names.length > 0;
}

function moveLayer(from, to) {
  guard(async () => { await S.device.moveLayer(from, to); await reloadKeymap(); S.layerIndex = to; S.unsaved = true; await tidyLayers(); renderAll(); });
}

function boardGeometry(container) {
  const keys = S.layout.keys;
  const maxX = Math.max(...keys.map((k) => k.x + k.width)) / 100;
  const maxY = Math.max(...keys.map((k) => k.y + k.height)) / 100;
  const avail = Math.max(320, container.clientWidth - 52);
  const u = Math.max(30, Math.min(66, Math.floor(avail / maxX)));
  return { u, w: maxX * u, hgt: maxY * u };
}

// Shrink text to fit a key, and wrap onto extra lines before shrinking too far
function fitText(text, width, maxFs, charW, minFs, maxLines, maxHeight) {
  text = String(text ?? '');
  const breakable = text.replace(/([+\/·])/g, '$1\u200b');
  const n = Math.max(1, text.length);
  for (let lines = 1; lines <= maxLines; lines++) {
    const perLine = Math.ceil(n / lines) + (lines > 1 ? 1 : 0);
    let fs = Math.min(maxFs, width / (perLine * charW));
    if (lines > 1) {
      const longest = Math.max(...text.split(/[\s+\/·]/).map((w) => w.length), 1);
      fs = Math.min(fs, maxHeight / (lines * 1.12), width / (longest * charW));
    }
    if (fs >= minFs || lines === maxLines) return { text: lines > 1 ? breakable : text, fs: Math.max(minFs - (lines === maxLines ? 1.5 : 0), Math.floor(fs * 10) / 10), lines };
  }
}

function drawBoard(el, { labelLayer, onClick, testerMode, preview }) {
  const { u, w, hgt } = boardGeometry(el.parentElement);
  el.style.width = w + 'px';
  el.style.height = hgt + 'px';
  el.style.setProperty('--kfs', Math.max(10, Math.round(u * 0.23)) + 'px');
  el.replaceChildren();
  const pressedPos = positionsForPressed(labelLayer);
  const gap = Math.max(3, Math.round(u * 0.07));
  const baseFs = Math.max(10, Math.round(u * 0.23));
  S.layout.keys.forEach((k, pos) => {
    const binding = layers()[labelLayer]?.bindings[pos];
    const lab = binding ? labelFor({ ...binding, _pos: pos }, labelLayer) : { main: '', sub: '' };
    const cls = ['key', lab.cls || ''];
    if (!testerMode && !preview && pos === S.selected) cls.push('selected');
    if (pressedPos.direct.has(pos) || pressedPos.layerKeys.has(pos)) cls.push('pressed');
    else if (pressedPos.ghost.has(pos)) cls.push('ghost');
    if (testerMode && S.tested.has(pos)) cls.push('tested');
    const style = `left:${(k.x / 100) * u + gap / 2}px;top:${(k.y / 100) * u + gap / 2}px;width:${(k.width / 100) * u - gap}px;height:${(k.height / 100) * u - gap}px;` +
      (k.r ? `transform-origin:${((k.rx - k.x) / 100) * u}px ${((k.ry - k.y) / 100) * u}px;transform:rotate(${k.r / 100}deg);` : '');
    const innerW = (k.width / 100) * u - gap - 8;
    const innerH = (k.height / 100) * u - gap - 6;
    const main = fitText(lab.main, innerW, baseFs, 0.62, 9, lab.sub ? 2 : 3, innerH * (lab.sub ? 0.5 : 1));
    const sub = lab.sub ? fitText(lab.sub.toUpperCase(), innerW, 9.5, 0.72, 7.5, 3, innerH * 0.5) : null;
    el.append(h('div', { class: cls.join(' '), style, 'data-pos': pos, title: binding ? describeLong(binding) : '', onclick: onClick ? () => onClick(pos) : null },
      h('span', { class: 'main' + (main.lines > 1 ? ' wrap' : ''), style: `font-size:${main.fs}px;-webkit-line-clamp:${main.lines}` }, main.text),
      sub ? h('span', { class: 'sub' + (sub.lines > 1 ? ' wrap' : ''), style: `font-size:${sub.fs}px;-webkit-line-clamp:${sub.lines}` }, sub.text) : null));
  });
}

function renderBoard() {
  drawBoard($('#board'), {
    labelLayer: S.layerIndex,
    onClick: (pos) => { S.selected = S.selected === pos ? null : pos; S.advPicker = null; S.advBehavior = null; renderBoard(); renderPanel(); },
  });
}

// HID usages (page*65536+id) a binding can send to the computer
function usagesOf(bnd) {
  const b = behavior(bnd?.behaviorId);
  if (!b) return [];
  const k = (v) => { const d = decodeUsage(v); return d.page * 0x10000 + d.id; };
  if (b.kind === 'kp') return [k(bnd.param1)];
  if (b.kind === 'mt') return [k(bnd.param1), k(bnd.param2)];
  if (b.kind === 'lt') return [k(bnd.param2)];
  if (b.name.toLowerCase() === 'grave/escape') return [PAGE_KEYBOARD * 0x10000 + 0x29, PAGE_KEYBOARD * 0x10000 + 0x35];
  return [];
}

// What a key does on a layer, following transparent keys down to the layer below
function effective(pos, layerIdx) {
  for (let i = layerIdx; i >= 0; i--) {
    const bnd = layers()[i]?.bindings[pos];
    const b = bnd && behavior(bnd.behaviorId);
    if (!b) return null;
    if (b.kind !== 'trans') return bnd;
  }
  return null;
}

// Which keys to light up for the usages currently held down (live key display).
//  direct: keys on the shown layer that send it
//  ghost:  keys on another layer that send it (you are holding a layer key)
//  layerKeys: the keys on the shown layer that lead to that other layer
function positionsForPressed(layerIdx) {
  const res = { direct: new Set(), ghost: new Set(), layerKeys: new Set(), viaLayer: null };
  if (!S.pressed.size) return res;
  const keys = S.layout.keys;
  const found = new Set();
  keys.forEach((_, pos) => {
    for (const u of usagesOf(effective(pos, layerIdx))) if (S.pressed.has(u)) { res.direct.add(pos); found.add(u); }
  });
  const missing = [...S.pressed].filter((u) => !found.has(u));
  if (!missing.length) return res;
  const viaLayers = new Set();
  layers().forEach((l, li) => {
    if (li === layerIdx) return;
    keys.forEach((_, pos) => {
      const bnd = l.bindings[pos];
      if (behavior(bnd?.behaviorId)?.kind === 'trans') return;
      if (usagesOf(bnd).some((u) => missing.includes(u))) { res.ghost.add(pos); viaLayers.add(l.id); }
    });
  });
  if (viaLayers.size) {
    const first = layerById([...viaLayers][0]);
    res.viaLayer = first ? layerName(first.layer, first.index) : null;
    keys.forEach((_, pos) => {
      const bnd = effective(pos, layerIdx);
      const b = behavior(bnd?.behaviorId);
      if (b && ['mo', 'tog', 'to', 'lt'].includes(b.kind) && viaLayers.has(bnd.param1)) res.layerKeys.add(pos);
    });
  }
  return res;
}

function renderLive() {
  $('#livetoggle').checked = S.live;
  $('#lastkey').replaceChildren(...(S.lastPressed
    ? [h('span', {}, 'Last key:'), h('kbd', {}, S.lastPressed), S.lastVia ? h('span', { class: 'via' }, `via ${S.lastVia} layer`) : null]
    : [h('span', {}, 'Press a key on your keyboard to see where it is')]).filter(Boolean));  // replaceChildren would print "null" otherwise
}

// ---------------------------------------------------------------- assignment panel
const CATS = [
  ['keys', 'Keys'], ['media', 'Media'], ['layers', 'Layers'], ['bt', 'Bluetooth'], ['special', 'Special'], ['advanced', 'Advanced'],
];

function renderPanel() {
  const panel = $('#panel');
  panel.replaceChildren();
  if (S.selected === null) {
    panel.append(h('div', { class: 'empty' }, h('b', {}, 'Click any key'), ' on the keyboard above to change what it does on the ', h('b', {}, layerName(curLayer(), S.layerIndex)), ' layer.'));
    return;
  }
  const binding = curLayer().bindings[S.selected];
  panel.append(h('div', { class: 'panel-head' },
    h('div', {}, h('div', { class: 'title' }, `Key ${S.selected + 1}`), h('div', { class: 'meta' }, `on layer ${layerName(curLayer(), S.layerIndex)}`)),
    h('div', { class: 'current' }, 'Currently', h('kbd', {}, describeBinding(binding)),
      S.byKind.trans && S.layerIndex > 0 ? h('button', { class: 'icon-btn', onclick: () => assign({ behaviorId: S.byKind.trans.id, param1: 0, param2: 0 }) }, 'Clear') : null,
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => { S.selected = null; renderBoard(); renderPanel(); } }, '✕')),
  ));
  if (layers().length > 1) panel.append(applyToRow());
  panel.append(h('div', { class: 'cats' }, CATS.filter(([k]) => k !== 'bt' || S.byKind.bt || S.byKind.out).map(([k, label]) =>
    h('button', { class: 'cat' + (S.cat === k ? ' active' : ''), onclick: () => { S.cat = k; renderPanel(); } }, label))));
  const body = h('div', { class: 'panel-body' });
  panel.append(body);
  ({ keys: catKeys, media: catMedia, layers: catLayers, bt: catBt, special: catSpecial, advanced: catAdvanced }[S.cat] || catKeys)(body, binding);
}

// "Also set on" layer chips: a change to this key is written to every chosen layer
function applyToRow() {
  const cur = curLayer();
  const others = layers().map((l, i) => [l, i]).filter(([l]) => l !== cur);
  const all = others.every(([l]) => S.applyTo.has(l.id));
  return h('div', { class: 'apply-row' + (S.applyTo.size ? ' active' : '') },
    h('span', { class: 'lbl' }, 'Also set on:'),
    others.map(([l, i]) => h('button', {
      class: 'toggle-chip' + (S.applyTo.has(l.id) ? ' on' : ''),
      title: `Also put this key on the ${layerName(l, i)} layer`,
      onclick: () => { S.applyTo.has(l.id) ? S.applyTo.delete(l.id) : S.applyTo.add(l.id); renderPanel(); },
    }, layerName(l, i))),
    h('button', {
      class: 'link-btn',
      onclick: () => { if (all) S.applyTo.clear(); else others.forEach(([l]) => S.applyTo.add(l.id)); renderPanel(); },
    }, all ? 'None' : 'All layers'),
    S.applyTo.size ? h('span', { class: 'apply-note' }, `Your next change goes on ${S.applyTo.size + 1} layers`) : null,
  );
}

function currentUsageKey(binding) {
  const b = behavior(binding?.behaviorId);
  if (b?.kind !== 'kp') return null;
  const d = decodeUsage(binding.param1);
  return d.page * 0x10000 + d.id;
}

function keyGrid(container, { groups, onPick, currentKey, compact, query }) {
  const q = (query ?? S.search).trim().toLowerCase();
  for (const g of groups) {
    const items = ALL_USAGES.filter((u) => u.group === g && (!q || u.name.toLowerCase().includes(q) || u.label.toLowerCase() === q || (u.code || '').toLowerCase().includes(q)));
    if (!items.length) continue;
    container.append(h('div', { class: 'group' }, compact ? null : h('h4', {}, g), h('div', { class: 'chips' }, items.map((u) =>
      h('button', {
        class: 'chip' + (u.label.length > 3 ? ' wide' : '') + (currentKey === u.page * 0x10000 + u.id ? ' current' : ''),
        title: u.name,
        onclick: () => onPick(u),
      }, u.label)))));
  }
  if (!container.children.length) container.append(h('p', { class: 'hint' }, 'Nothing matches that search.'));
}

function searchBox(onInput) {
  const s = h('input', { class: 'search', placeholder: 'Search keys… (e.g. "page", "f5", "enter")', value: S.search });
  s.addEventListener('input', () => { S.search = s.value; onInput(); });
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

function catKeys(body, binding) {
  const list = h('div');
  const redraw = () => { list.replaceChildren(); keyGrid(list, { groups: KEY_GROUPS, currentKey: currentUsageKey(binding), onPick: (u) => assign(kp(u.page, u.id, S.mods)) }); };
  const mods = h('div', { class: 'mods' }, h('span', { class: 'lbl' }, 'Hold with:'),
    MOD_BITS.filter((m) => m.side === 'L').map((m) => h('button', {
      class: 'mod' + (S.mods & m.bit ? ' on' : ''), title: `Send ${m.name} together with the key, e.g. Ctrl + C`,
      onclick: (e) => { S.mods ^= m.bit; e.currentTarget.classList.toggle('on'); },
    }, m.short)));
  body.append(h('div', { class: 'toolbar' }, searchBox(redraw), mods), list);
  redraw();
}

function catMedia(body, binding) {
  body.append(h('p', { class: 'hint' }, 'Media and system keys. These work on most computers without extra software.'));
  const list = h('div');
  keyGrid(list, { groups: ['Media'], compact: true, currentKey: currentUsageKey(binding), onPick: (u) => assign(kp(u.page, u.id)) });
  body.append(list);
}

function catLayers(body, binding) {
  body.append(h('p', { class: 'hint' }, 'Make this key reach another layer. "Hold" is like a Fn key: the layer is active while you hold it. "Toggle" turns it on and off. "Switch to" jumps to it until you switch back.'));
  const rows = h('div', { class: 'layer-rows' });
  const b = behavior(binding.behaviorId);
  layers().forEach((l, i) => {
    const opts = [['mo', 'Hold'], ['tog', 'Toggle'], ['to', 'Switch to']].filter(([k]) => S.byKind[k]);
    rows.append(h('div', { class: 'layer-row' },
      h('div', { class: 'name' }, layerName(l, i), h('small', {}, i === S.layerIndex ? 'this layer' : `layer ${i}`)),
      h('div', { class: 'chips' }, opts.map(([k, label]) => h('button', {
        class: 'chip wide' + (b?.kind === k && binding.param1 === l.id ? ' current' : ''),
        onclick: () => assign({ behaviorId: S.byKind[k].id, param1: l.id, param2: 0 }),
      }, label)))));
  });
  body.append(rows);
  if (S.byKind.lt) body.append(h('p', { class: 'hint', style: 'margin-top:16px' }, 'Want a key that types something when tapped but switches layer when held? Use ', h('b', {}, 'Advanced → Layer-Tap'), '.'));
}

function catBt(body, binding) {
  const bt = S.byKind.bt;
  const cur = behavior(binding.behaviorId);
  if (bt) {
    const selConst = (bt.metadata.flatMap((s) => s.param1)).find((d) => /select/i.test(d.name))?.constant;
    const range = bt.metadata.find((s) => s.param1.some((d) => d.constant === selConst))?.param2?.find((d) => d.range)?.range || { min: 0, max: 4 };
    body.append(h('div', { class: 'group' }, h('h4', {}, 'Connect to device (profile)'), h('div', { class: 'chips' },
      Array.from({ length: range.max - range.min + 1 }, (_, n) => n + range.min).map((n) => h('button', {
        class: 'chip wide' + (cur?.kind === 'bt' && binding.param1 === selConst && binding.param2 === n ? ' current' : ''),
        onclick: () => assign({ behaviorId: bt.id, param1: selConst, param2: n }),
      }, `Device ${n + 1}`)))));
    const others = bt.metadata.filter((s) => !s.param2?.length).flatMap((s) => s.param1).filter((d) => d.constant !== undefined);
    body.append(h('div', { class: 'group' }, h('h4', {}, 'Bluetooth actions'), h('div', { class: 'chips' }, others.map((d) => h('button', {
      class: 'chip wide' + (cur?.kind === 'bt' && binding.param1 === d.constant ? ' current' : ''),
      onclick: () => assign({ behaviorId: bt.id, param1: d.constant, param2: 0 }),
    }, d.name)))));
  }
  const out = S.byKind.out;
  if (out) {
    const opts = out.metadata.flatMap((s) => s.param1).filter((d) => d.constant !== undefined);
    body.append(h('div', { class: 'group' }, h('h4', {}, 'USB or Bluetooth output'), h('div', { class: 'chips' }, opts.map((d) => h('button', {
      class: 'chip wide' + (cur?.kind === 'out' && binding.param1 === d.constant ? ' current' : ''),
      onclick: () => assign({ behaviorId: out.id, param1: d.constant, param2: 0 }),
    }, d.name)))));
  }
  body.append(h('p', { class: 'hint' }, 'Tip: "Device 1" is the first Bluetooth slot. Press it, then pair from your computer\'s Bluetooth settings.'));
}

function noParam(b) { return !b.metadata?.length || b.metadata.every((s) => !(s.param1?.length) && !(s.param2?.length)); }

function catSpecial(body, binding) {
  const list = S.behaviors.filter((b) => noParam(b));
  body.append(h('p', { class: 'hint' }, 'Special actions built into your keyboard\'s firmware. "Transparent" lets the key do whatever it does on the layer below. "Bootloader" puts the keyboard in update mode.'));
  body.append(h('div', { class: 'chips' }, list.map((b) => h('button', {
    class: 'chip wide' + (binding.behaviorId === b.id ? ' current' : ''),
    onclick: () => assign({ behaviorId: b.id, param1: 0, param2: 0 }),
  }, b.name))));
}

// Generic editor driven by the metadata each behavior reports
function catAdvanced(body, binding) {
  if (!S.advBehavior || !behavior(S.advBehavior)) {
    S.advBehavior = binding.behaviorId;
    S.advParams = { p1: binding.param1, p2: binding.param2 };
  }
  const b = behavior(S.advBehavior);
  const dbls = dblVariants();
  const mainDbl = dbls.find((x) => speedMs(x) === DEFAULT_MS) || dbls[0];
  const shown = S.behaviors.filter((x) => x.kind !== 'dbl' || x === mainDbl);
  const list = h('div', { class: 'adv-list' }, shown.map((x) => h('button', {
    class: 'adv-item' + (x.id === b.id || (x.kind === 'dbl' && b.kind === 'dbl') ? ' active' : ''),
    onclick: () => {
      if (x.kind === 'dbl' && behavior(binding.behaviorId)?.kind === 'dbl') x = behavior(binding.behaviorId); // keep the key's speed
      S.advBehavior = x.id;
      S.advParams = x.id === binding.behaviorId ? { p1: binding.param1, p2: binding.param2 } : { p1: null, p2: null };
      // Double Tap: start with the key's current letter as the single-tap key
      if (x.kind === 'dbl' && x.id !== binding.behaviorId && behavior(binding.behaviorId)?.kind === 'kp') S.advParams.p1 = binding.param1;
      S.advPicker = null; renderPanel();
    },
  }, x.kind === 'dbl' ? 'Double Tap' : x.name)));
  const edit = h('div', { class: 'adv-edit' }, h('h3', {}, b.kind === 'dbl' ? 'Double Tap' : b.name));
  const sets = b.metadata || [];
  if (noParam(b)) {
    edit.append(h('p', { class: 'hint' }, 'This action has no settings.'));
  } else {
    const p1Descs = sets.flatMap((s) => s.param1 || []);
    edit.append(paramField('p1', p1Descs));
    const set = sets.find((s) => (s.param1 || []).some((d) => matches(d, S.advParams.p1)));
    if (set?.param2?.length) edit.append(paramField('p2', set.param2));
  }
  if (b.kind === 'dbl' && dbls.length > 1) {
    const msList = dbls.map(speedMs);
    const closest = (ms) => dbls.reduce((best, v) => (Math.abs(speedMs(v) - ms) < Math.abs(speedMs(best) - ms) ? v : best), dbls[0]);
    const val = h('b', { class: 'speed-val' }, `${speedMs(b)} ms`);
    const slider = h('input', { type: 'range', class: 'speed-slider', min: Math.min(...msList), max: Math.max(...msList), step: 5, value: speedMs(b) });
    slider.addEventListener('keydown', (e) => e.stopPropagation());
    const fill = () => slider.style.setProperty('--p', `${((slider.value - slider.min) / (slider.max - slider.min || 1)) * 100}%`);
    fill();
    slider.addEventListener('input', () => { fill(); val.textContent = `${speedMs(closest(+slider.value))} ms`; });
    slider.addEventListener('change', () => { S.advBehavior = closest(+slider.value).id; renderPanel(); });
    const nudge = (d) => { const i = dbls.indexOf(b) + d; if (dbls[i]) { S.advBehavior = dbls[i].id; renderPanel(); } };
    edit.append(h('div', { class: 'field' }, h('label', {}, 'Wait for second tap'),
      h('div', { class: 'speed-row' },
        h('button', { class: 'icon-btn', title: '5 ms faster', disabled: dbls.indexOf(b) <= 0, onclick: () => nudge(-1) }, '−'),
        slider,
        h('button', { class: 'icon-btn', title: '5 ms slower', disabled: dbls.indexOf(b) >= dbls.length - 1, onclick: () => nudge(1) }, '+'),
        val,
        speedMs(b) !== DEFAULT_MS ? h('button', { class: 'link-btn', onclick: () => { S.advBehavior = closest(DEFAULT_MS).id; renderPanel(); } }, `Reset to ${DEFAULT_MS}`) : null),
      h('button', { class: 'link-btn', style: 'padding-left:0;margin-top:6px', onclick: () => setAllDoubleTapSpeeds(b) }, `Use ${speedMs(b)} ms for all double-tap keys`),
      h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Lower: single taps come through quicker, but you need to double tap faster. Higher: easier double taps, slightly slower single taps.')));
  }
  const ready = noParam(b) || isComplete(b);
  edit.append(h('div', { style: 'margin-top:20px' }, h('button', {
    class: 'btn primary', disabled: !ready,
    onclick: () => assign({ behaviorId: b.id, param1: S.advParams.p1 ?? 0, param2: S.advParams.p2 ?? 0 }),
  }, 'Apply to key')));
  body.append(h('div', { class: 'adv' }, list, edit));
}

// Give every Double Tap key, on every layer, the chosen speed (keeps their keys)
function setAllDoubleTapSpeeds(variant) {
  guard(async () => {
    try {
      const jobs = [];
      layers().forEach((l) => l.bindings.forEach((bnd, pos) => {
        if (behavior(bnd?.behaviorId)?.kind === 'dbl' && bnd.behaviorId !== variant.id) jobs.push([l, pos, bnd]);
      }));
      for (let i = 0; i < jobs.length; i++) {
        busy('Changing speed…', `${i} of ${jobs.length}`);
        const [l, pos, bnd] = jobs[i];
        const nb = { behaviorId: variant.id, param1: bnd.param1, param2: bnd.param2 };
        await S.device.setBinding(l.id, pos, nb);
        l.bindings[pos] = nb;
      }
      if (jobs.length) S.unsaved = true;
      renderAll();
      toast(jobs.length ? `All double-tap keys now wait ${speedMs(variant)} ms. Click Save to keep it.` : 'All double-tap keys already use that speed.');
    } finally { busy(null); }
  });
}

function matches(d, v) {
  if (v === null || v === undefined) return false;
  if (d.constant !== undefined) return d.constant === v;
  if (d.range) return v >= d.range.min && v <= d.range.max;
  return !!(d.hidUsage || d.layerId);
}

function isComplete(b) {
  const set = (b.metadata || []).find((s) => (s.param1 || []).some((d) => matches(d, S.advParams.p1)));
  if (!set) return false;
  if (set.param2?.length) return set.param2.some((d) => matches(d, S.advParams.p2));
  return true;
}

function paramField(which, descs) {
  const val = S.advParams[which];
  const set = (v) => { S.advParams[which] = v; if (which === 'p1') S.advParams.p2 = null; S.advPicker = null; renderPanel(); };
  const wrap = h('div', { class: 'field' });
  const consts = descs.filter((d) => d.constant !== undefined);
  const named = descs.find((d) => d.constant === undefined);
  wrap.append(h('label', {}, named?.name || (which === 'p1' ? 'Option' : 'Value')));
  if (consts.length) wrap.append(h('div', { class: 'chips' }, consts.map((d) => h('button', { class: 'chip wide' + (val === d.constant ? ' current' : ''), onclick: () => set(d.constant) }, d.name))));
  for (const d of descs) {
    if (d.range) {
      const inp = h('input', { class: 'num-in', type: 'number', min: d.range.min, max: d.range.max, value: val ?? d.range.min });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => { S.advParams[which] = Math.max(d.range.min, Math.min(d.range.max, Number(inp.value))); renderPanel(); });
      if (val === null) S.advParams[which] = d.range.min;
      wrap.append(h('div', { class: 'picked' }, inp, h('span', { class: 'hint', style: 'margin:0' }, `${d.range.min} – ${d.range.max}`)));
    }
    if (d.layerId) {
      wrap.append(h('div', { class: 'chips' }, layers().map((l, i) => h('button', { class: 'chip wide' + (val === l.id ? ' current' : ''), onclick: () => set(l.id) }, layerName(l, i)))));
    }
    if (d.hidUsage) {
      const picking = S.advPicker === which;
      wrap.append(h('div', { class: 'picked' },
        val !== null && val !== undefined ? h('kbd', {}, usageName(val)) : h('span', { class: 'hint', style: 'margin:0' }, 'No key chosen'),
        h('button', { class: 'icon-btn', onclick: () => { S.advPicker = picking ? null : which; renderPanel(); } }, picking ? 'Close' : 'Choose key')));
      if (picking) {
        const grid = h('div', { class: 'mini-grid' });
        const list = h('div');
        const draw = () => { list.replaceChildren(); keyGrid(list, { groups: [...KEY_GROUPS, 'Media'], query: S.miniQuery, onPick: (u) => { S.miniQuery = ''; set(encodeUsage(u.page, u.id)); } }); };
        const q = h('input', { class: 'search mini-search', placeholder: 'Search keys… (e.g. "numpad 1", "f5", "volume")', value: S.miniQuery });
        q.addEventListener('input', () => { S.miniQuery = q.value; draw(); });
        q.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { S.miniQuery = ''; S.advPicker = null; renderPanel(); }
          if (e.key === 'Enter') list.querySelector('.chip')?.click();   // Enter picks the first match
        });
        grid.append(q, list);
        draw();
        wrap.append(grid);
        requestAnimationFrame(() => q.focus());
      }
    }
  }
  return wrap;
}

// ---------------------------------------------------------------- key tester
function renderTester() {
  drawBoard($('#tboard'), { labelLayer: 0, testerMode: true });
  const total = S.layout.keys.length;
  $('#tcount').textContent = `${S.tested.size} of ${total} keys tested`;
  $('#tprog').style.width = (100 * S.tested.size / total) + '%';
}

// ---------------------------------------------------------------- live keys
function onKey(e, down) {
  if (!S.device) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (S.view === 'overview' || S.view === 'home') return;
  if (S.view === 'remap' && !S.live) return;
  const u = usageForCode(e.code);
  e.preventDefault();
  if (!u) return;
  const key = u.page * 0x10000 + u.id;
  if (down) { S.pressed.add(key); S.lastPressed = u.name; } else S.pressed.delete(key);
  if (down) {
    const r = positionsForPressed(S.view === 'test' ? 0 : S.layerIndex);
    S.lastVia = r.direct.size ? null : r.viaLayer;
    if (S.view === 'test') for (const set of [r.direct, r.ghost, r.layerKeys]) for (const p of set) S.tested.add(p);
  }
  if (S.view === 'remap') { renderBoard(); renderLive(); } else renderTester();
}

// ---------------------------------------------------------------- ui helpers
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), err ? 5000 : 2600);
}

function busy(title, text) {
  const o = $('#overlay');
  if (!title) { o.hidden = true; return; }
  o.hidden = false;
  o.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'spinner' }), h('b', {}, title), text ? h('p', {}, text) : null));
}

// ---------------------------------------------------------------- boot
function boot() {
  $('#connect').addEventListener('click', () => start(false));
  $('#demo').addEventListener('click', () => start(true));
  if (!('serial' in navigator)) {
    $('#connect').disabled = true;
    $('#nosupport').hidden = false;
  } else {
    const auto = $('#autoconnect');
    auto.checked = prefs.auto;
    auto.addEventListener('change', () => { prefs.auto = auto.checked; if (auto.checked) autoConnect(); });
    navigator.serial.addEventListener('connect', () => setTimeout(autoConnect, 600));
    setTimeout(autoConnect, 50);
  }
  $('#save').addEventListener('click', () => guard(async () => { await S.device.save(); S.unsaved = false; renderTop(); toast('Saved to your keyboard.'); }));
  $('#discard').addEventListener('click', () => guard(async () => { await S.device.discard(); await reloadKeymap(); S.unsaved = false; renderAll(); toast('Changes discarded.'); }));
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => { S.pressed.clear(); setView(b.dataset.view); }));
  $('#livetoggle').addEventListener('change', (e) => { S.live = e.target.checked; S.pressed.clear(); renderBoard(); });
  $('#treset').addEventListener('click', () => { S.tested.clear(); renderTester(); });
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => { S.pressed.clear(); if (S.device) renderAll(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderAll, 80); });
  window.addEventListener('beforeunload', (e) => { if (S.unsaved) { e.preventDefault(); e.returnValue = ''; } });
  setView('home');
  startLiveLink();
  if (new URLSearchParams(location.search).has('demo')) start(true);
}

boot();
