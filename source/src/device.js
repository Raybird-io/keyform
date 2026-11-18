// Two interchangeable back-ends with the same methods:
//  - StudioDevice: a real ZMK keyboard over USB (Web Serial) using the official ZMK Studio client
//  - DemoDevice:   an in-memory Rechteck so the app can be tried without a keyboard
import { create_rpc_connection, call_rpc } from '@zmkfirmware/zmk-studio-ts-client';
import { DEMO_KEYS, DEMO_LAYERS } from './demo-data.js';

const LOCKED = 0;

export class StudioDevice {
  constructor() {
    this.listeners = new Set();
    this.isDemo = false;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  // port: an already-permitted SerialPort (auto-connect). Without it the browser asks the user to pick one.
  async connect(port) {
    if (!('serial' in navigator)) {
      throw new Error('This browser cannot talk to USB keyboards. Please open this page in Chrome, Edge or Firefox 151+ on a computer.');
    }
    this.port = port || (await navigator.serial.requestPort({}));
    this.transport = await openPort(this.port);
    this.conn = create_rpc_connection(this.transport);
    this.readNotifications();
    this.transport.abortController.signal.addEventListener('abort', () => this.emit({ type: 'disconnected' }));
    const info = await this.call({ core: { getDeviceInfo: true } });
    this.name = info.core?.getDeviceInfo?.name || 'ZMK keyboard';
    return this.name;
  }

  async readNotifications() {
    const reader = this.conn.notification_readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.core?.lockStateChanged !== undefined) this.emit({ type: 'lock', locked: value.core.lockStateChanged === LOCKED });
        if (value.keymap?.unsavedChangesStatusChanged !== undefined) this.emit({ type: 'unsaved', unsaved: value.keymap.unsavedChangesStatusChanged });
      }
    } catch (e) {
      this.emit({ type: 'disconnected' });
    } finally {
      reader.releaseLock();
    }
  }

  async call(req) {
    const resp = await call_rpc(this.conn, req);
    if (resp.meta?.simpleError !== undefined) throw new Error('The keyboard reported an error (' + resp.meta.simpleError + ').');
    if (resp.meta?.noResponse) throw new Error('The keyboard did not answer.');
    return resp;
  }

  async disconnect() { try { this.transport?.abortController.abort(); } catch {} }

  async isLocked() {
    const r = await this.call({ core: { getLockState: true } });
    return r.core?.getLockState === LOCKED;
  }

  async getBehaviors() {
    const list = await this.call({ behaviors: { listAllBehaviors: true } });
    const ids = list.behaviors?.listAllBehaviors?.behaviors || [];
    const out = [];
    for (const id of ids) {
      const d = await this.call({ behaviors: { getBehaviorDetails: { behaviorId: id } } });
      const det = d.behaviors?.getBehaviorDetails;
      if (det) out.push({ id: det.id, name: det.displayName, metadata: det.metadata || [] });
    }
    return out;
  }

  async getLayout() {
    const r = await this.call({ keymap: { getPhysicalLayouts: true } });
    const pl = r.keymap?.getPhysicalLayouts;
    const layout = pl?.layouts?.[pl.activeLayoutIndex] || pl?.layouts?.[0];
    return { name: layout?.name || 'Keyboard', keys: layout?.keys || [] };
  }

  async getKeymap() {
    const r = await this.call({ keymap: { getKeymap: true } });
    return r.keymap?.getKeymap;
  }

  async setBinding(layerId, keyPosition, binding) {
    const r = await this.call({ keymap: { setLayerBinding: { layerId, keyPosition, binding } } });
    const res = r.keymap?.setLayerBinding;
    if (res !== 0 && res !== undefined) throw new Error('The keyboard refused that change (code ' + res + ').');
  }

  async addLayer() {
    const r = await this.call({ keymap: { addLayer: {} } });
    const res = r.keymap?.addLayer;
    if (!res?.ok) throw new Error('No free layer slots left. The firmware needs more reserved layers.');
    return res.ok;
  }

  async removeLayer(layerIndex) {
    const r = await this.call({ keymap: { removeLayer: { layerIndex } } });
    if (!r.keymap?.removeLayer?.ok) throw new Error('Could not remove that layer.');
  }

  async moveLayer(startIndex, destIndex) {
    const r = await this.call({ keymap: { moveLayer: { startIndex, destIndex } } });
    if (!r.keymap?.moveLayer?.ok) throw new Error('Could not move that layer.');
  }

  async renameLayer(layerId, name) {
    const r = await this.call({ keymap: { setLayerProps: { layerId, name } } });
    const res = r.keymap?.setLayerProps;
    if (res !== 0 && res !== undefined) throw new Error('Could not rename that layer.');
  }

  async hasUnsaved() {
    const r = await this.call({ keymap: { checkUnsavedChanges: true } });
    return !!r.keymap?.checkUnsavedChanges;
  }

  async save() {
    const r = await this.call({ keymap: { saveChanges: true } });
    if (!r.keymap?.saveChanges?.ok) throw new Error('Saving failed. Please try again.');
  }

  async discard() {
    await this.call({ keymap: { discardChanges: true } });
  }
}

// Same as the library's serial transport, but for a port we already have permission for
async function openPort(port) {
  const abortController = new AbortController();
  await port.open({ baudRate: 12500 }).catch((e) => {
    if (e instanceof DOMException && e.name === 'InvalidStateError') return; // already open
    if (e instanceof DOMException && e.name === 'NetworkError') {
      throw new Error('Could not open the keyboard. Close zmk.studio or any other app using it, then try again.', { cause: e });
    }
    throw e;
  });
  const info = port.getInfo();
  const label = (info.usbVendorId?.toString() || '') + ':' + (info.usbProductId?.toString() || '');
  abortController.signal.addEventListener('abort', async () => {
    try { await port.writable?.close(); } catch {}
    try { await port.readable?.cancel(); } catch {}
    try { await port.close(); } catch {}
  }, { once: true });
  return { label, abortController, readable: port.readable, writable: port.writable };
}

// Ports this page was allowed to use before, best match first
export async function rememberedPorts() {
  if (!('serial' in navigator) || !navigator.serial.getPorts) return [];
  const ports = await navigator.serial.getPorts();
  let last = null;
  try { last = JSON.parse(localStorage.getItem('keyform.lastPort') || 'null'); } catch {}
  const score = (p) => { const i = p.getInfo(); return last && i.usbVendorId === last.v && i.usbProductId === last.p ? 1 : 0; };
  return ports.sort((a, b) => score(b) - score(a));
}

export function rememberPort(port) {
  try { const i = port.getInfo(); localStorage.setItem('keyform.lastPort', JSON.stringify({ v: i.usbVendorId, p: i.usbProductId })); } catch {}
}

// ---------------------------------------------------------------------------

const hid = { name: 'Key', hidUsage: { keyboardMax: 0xff, consumerMax: 0xfff } };
const DEMO_BEHAVIORS = [
  { id: 1, key: 'kp', name: 'Key Press', metadata: [{ param1: [hid], param2: [] }] },
  { id: 2, key: 'trans', name: 'Transparent', metadata: [] },
  { id: 3, key: 'none', name: 'None', metadata: [] },
  { id: 4, key: 'mo', name: 'Momentary Layer', metadata: [{ param1: [{ name: 'Layer', layerId: {} }], param2: [] }] },
  { id: 5, key: 'tog', name: 'Toggle Layer', metadata: [{ param1: [{ name: 'Layer', layerId: {} }], param2: [] }] },
  { id: 6, key: 'to', name: 'To Layer', metadata: [{ param1: [{ name: 'Layer', layerId: {} }], param2: [] }] },
  { id: 7, key: 'lt', name: 'Layer-Tap', metadata: [{ param1: [{ name: 'Layer', layerId: {} }], param2: [{ name: 'Tap', hidUsage: hid.hidUsage }] }] },
  { id: 8, key: 'mt', name: 'Mod-Tap', metadata: [{ param1: [{ name: 'Hold', hidUsage: hid.hidUsage }], param2: [{ name: 'Tap', hidUsage: hid.hidUsage }] }] },
  {
    id: 9, key: 'bt', name: 'Bluetooth', metadata: [
      { param1: [{ name: 'Next Profile', constant: 1 }, { name: 'Previous Profile', constant: 2 }, { name: 'Clear All Profiles', constant: 4 }, { name: 'Clear Selected Profile', constant: 0 }], param2: [] },
      { param1: [{ name: 'Select Profile', constant: 3 }, { name: 'Disconnect Profile', constant: 5 }], param2: [{ name: 'Profile', range: { min: 0, max: 4 } }] },
    ],
  },
  { id: 10, key: 'out', name: 'Output Selection', metadata: [{ param1: [{ name: 'Toggle Outputs', constant: 0 }, { name: 'USB Output', constant: 1 }, { name: 'BLE Output', constant: 2 }], param2: [] }] },
  { id: 11, key: 'gresc', name: 'Grave/Escape', metadata: [] },
  { id: 12, key: 'caps', name: 'Caps Word', metadata: [] },
  { id: 13, key: 'rep', name: 'Key Repeat', metadata: [] },
  { id: 14, key: 'boot', name: 'Bootloader', metadata: [] },
  { id: 15, key: 'reset', name: 'Reset', metadata: [] },
  { id: 16, key: 'unlock', name: 'Studio Unlock', metadata: [] },
  { id: 17, key: 'dbl', name: 'Double Tap', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 18, key: 'dblf', name: 'Double Tap (Fast)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 19, key: 'dblr', name: 'Double Tap (Relaxed)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 20, key: 'dbl155', name: 'Double Tap (155 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 21, key: 'dbl160', name: 'Double Tap (160 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 22, key: 'dbl165', name: 'Double Tap (165 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 23, key: 'dbl170', name: 'Double Tap (170 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 24, key: 'dbl175', name: 'Double Tap (175 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 25, key: 'dbl180', name: 'Double Tap (180 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 26, key: 'dbl185', name: 'Double Tap (185 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 27, key: 'dbl190', name: 'Double Tap (190 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 28, key: 'dbl195', name: 'Double Tap (195 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 29, key: 'dbl205', name: 'Double Tap (205 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 30, key: 'dbl210', name: 'Double Tap (210 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 31, key: 'dbl215', name: 'Double Tap (215 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 32, key: 'dbl220', name: 'Double Tap (220 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 33, key: 'dbl225', name: 'Double Tap (225 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 34, key: 'dbl230', name: 'Double Tap (230 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 35, key: 'dbl235', name: 'Double Tap (235 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 36, key: 'dbl240', name: 'Double Tap (240 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 37, key: 'dbl245', name: 'Double Tap (245 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 38, key: 'dbl255', name: 'Double Tap (255 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 39, key: 'dbl260', name: 'Double Tap (260 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 40, key: 'dbl265', name: 'Double Tap (265 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 41, key: 'dbl270', name: 'Double Tap (270 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 42, key: 'dbl275', name: 'Double Tap (275 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 43, key: 'dbl280', name: 'Double Tap (280 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 44, key: 'dbl285', name: 'Double Tap (285 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 45, key: 'dbl290', name: 'Double Tap (290 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 46, key: 'dbl295', name: 'Double Tap (295 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
  { id: 47, key: 'dbl300', name: 'Double Tap (300 ms)', metadata: [{ param1: [{ name: 'Tap', hidUsage: hid.hidUsage }], param2: [{ name: 'Double tap', hidUsage: hid.hidUsage }] }] },
        ];

export class DemoDevice {
  constructor() {
    this.listeners = new Set();
    this.isDemo = true;
    this.name = 'Rechteck (demo)';
    const idOf = Object.fromEntries(DEMO_BEHAVIORS.map((b) => [b.key, b.id]));
    this.saved = {
      layers: DEMO_LAYERS.map((l) => ({ id: l.id, name: l.name, bindings: l.b.map(([k, p1, p2]) => ({ behaviorId: idOf[k], param1: p1, param2: p2 })) })),
      nextId: 2,
    };
    this.state = structuredClone(this.saved);
    this.slots = 8;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }
  changed() { this.emit({ type: 'unsaved', unsaved: true }); }
  async connect() { return this.name; }
  async disconnect() {}
  async isLocked() { return false; }
  async getBehaviors() { return DEMO_BEHAVIORS.map(({ id, name, metadata }) => ({ id, name, metadata })); }
  async getLayout() { return { name: 'Rechteck 60%', keys: DEMO_KEYS }; }
  async getKeymap() {
    return { layers: structuredClone(this.state.layers), availableLayers: this.slots - this.state.layers.length, maxLayerNameLength: 20 };
  }
  layerById(id) { return this.state.layers.find((l) => l.id === id); }
  async setBinding(layerId, pos, binding) { this.layerById(layerId).bindings[pos] = { ...binding }; this.changed(); }
  async addLayer() {
    if (this.state.layers.length >= this.slots) throw new Error('No free layer slots left. The firmware needs more reserved layers.');
    const layer = { id: this.state.nextId++, name: '', bindings: DEMO_KEYS.map(() => ({ behaviorId: 2, param1: 0, param2: 0 })) };
    this.state.layers.push(layer);
    this.changed();
    return { index: this.state.layers.length - 1, layer: structuredClone(layer) };
  }
  async removeLayer(i) { this.state.layers.splice(i, 1); this.changed(); }
  async moveLayer(a, b) { const [l] = this.state.layers.splice(a, 1); this.state.layers.splice(b, 0, l); this.changed(); }
  async renameLayer(id, name) { this.layerById(id).name = name; this.changed(); }
  async hasUnsaved() { return JSON.stringify(this.state) !== JSON.stringify(this.saved); }
  async save() { this.saved = structuredClone(this.state); this.emit({ type: 'unsaved', unsaved: false }); }
  async discard() { this.state = structuredClone(this.saved); this.emit({ type: 'unsaved', unsaved: false }); }
}
