import { StudioDevice, DemoDevice, rememberedPorts, rememberPort } from './device.js';
import {
  ALL_USAGES, KEY_GROUPS, MOD_BITS, PAGE_KEYBOARD, PAGE_CONSUMER,
  encodeUsage, decodeUsage, usageLabel, usageName, usageForCode, modsLabel,
} from './hid.js';

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
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
  unsaved: false,
  view: 'remap',
  live: true,
  pressed: new Set(),     // HID usage keys (page*65536+id) currently held
  tested: new Set(),      // key positions pressed in tester
  advBehavior: null,
  advParams: { p1: null, p2: null },
  advPicker: null,        // 'p1' | 'p2' while choosing a key
  renaming: false,
  confirmDelete: false,
  lastPressed: null,
  ovFilter: 'all',
};

const KIND_RULES = [
  ['kp', /^key ?press$/], ['trans', /^transparent$/], ['none', /^none$/],
  ['mo', /^momentary layer$/], ['tog', /^toggle layer$/], ['to', /^to layer$/],
  ['lt', /^layer[- ]?tap$/], ['mt', /^mod[- ]?tap$/], ['bt', /^bluetooth$/],
  ['out', /^output selection$/], ['unlock', /^studio unlock$/],
];
const kindOf = (name) => (KIND_RULES.find(([, re]) => re.test(name.toLowerCase())) || [null])[0];

const layers = () => S.keymap?.layers || [];
const curLayer = () => layers()[S.layerIndex];
const layerName = (l, i) => (l?.name && l.name.trim()) || (i === 0 ? 'Base' : `Layer ${i}`);
const layerById = (id) => { const i = layers().findIndex((l) => l.id === id); return i < 0 ? null : { layer: layers()[i], index: i }; };
const behavior = (id) => S.behaviors.find((b) => b.id === id);

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
    $('#welcome').hidden = true;
    S.layerIndex = 0; S.selected = null;
    setView('remap');
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
    $('#editor').hidden = true; $('#tester').hidden = true; $('#welcome').hidden = false;
    renderTop();
  }
}

async function reloadKeymap() {
  S.keymap = await S.device.getKeymap();
  S.layerIndex = Math.min(S.layerIndex, layers().length - 1);
}

async function assign(binding) {
  const layer = curLayer();
  if (S.selected === null || !layer) return;
  const pos = S.selected;
  await guard(async () => {
    await S.device.setBinding(layer.id, pos, binding);
    layer.bindings[pos] = { ...binding };
    S.unsaved = true;
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
  document.querySelectorAll('.views button').forEach((b) => { b.classList.toggle('active', b.dataset.view === S.view); b.disabled = !S.device; });
}

function setView(v) {
  S.view = v;
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
  root.append(h('div', { class: 'ov-filters' },
    h('button', { class: 'ov-filter' + (filter === 'all' ? ' on' : ''), onclick: () => { S.ovFilter = 'all'; renderOverview(); } }, 'All ', h('b', {}, String(entries.length))),
    Object.entries(TYPES).filter(([k]) => counts[k]).map(([k, t]) => h('button', {
      class: 'ov-filter' + (filter === k ? ' on' : ''), onclick: () => { S.ovFilter = k; renderOverview(); },
    }, h('i', { style: `background:${t.color}` }), t.label + ' ', h('b', {}, String(counts[k])))),
  ));
  const shown = entries.filter((e) => filter === 'all' || e.t === filter);
  if (!shown.length) {
    root.append(h('div', { class: 'empty board-card' }, 'No special keys yet. Every key just types its letter.'));
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
  root.append(h('p', { class: 'hint', style: 'margin-top:18px' }, 'Double-press keys (tap dance), combos and macros show up here if they are in your firmware. Creating new ones needs a firmware change. Ask Claude and it can add them.'));
}

function renderAll() {
  renderTop();
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
      onclick: () => { S.layerIndex = i; S.renaming = false; S.confirmDelete = false; S.advBehavior = null; renderAll(); },
    }, h('span', { class: 'num' }, String(i)), layerName(l, i))),
    h('button', {
      class: 'tab add',
      disabled: !(S.keymap.availableLayers > 0),
      title: S.keymap.availableLayers > 0 ? `Add a layer (${S.keymap.availableLayers} free)` : 'No free layer slots in this firmware',
      onclick: () => guard(async () => {
        const res = await S.device.addLayer();
        await reloadKeymap();
        S.layerIndex = res.index; S.unsaved = true; renderAll();
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
      l.name = input.value.trim(); S.renaming = false; S.unsaved = true; renderAll();
    });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') { S.renaming = false; renderLayerbar(); } });
    actions.append(input, h('button', { class: 'icon-btn', onclick: done }, 'Done'));
    setTimeout(() => input.focus(), 0);
  } else {
    actions.append(
      h('button', { class: 'icon-btn', title: 'Rename layer', onclick: () => { S.renaming = true; renderLayerbar(); } }, 'Rename'),
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
}

function moveLayer(from, to) {
  guard(async () => { await S.device.moveLayer(from, to); await reloadKeymap(); S.layerIndex = to; S.unsaved = true; renderAll(); });
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

function drawBoard(el, { labelLayer, onClick, testerMode }) {
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
    if (!testerMode && pos === S.selected) cls.push('selected');
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
    : [h('span', {}, 'Press a key on your keyboard to see where it is')]));
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
  panel.append(h('div', { class: 'cats' }, CATS.filter(([k]) => k !== 'bt' || S.byKind.bt || S.byKind.out).map(([k, label]) =>
    h('button', { class: 'cat' + (S.cat === k ? ' active' : ''), onclick: () => { S.cat = k; renderPanel(); } }, label))));
  const body = h('div', { class: 'panel-body' });
  panel.append(body);
  ({ keys: catKeys, media: catMedia, layers: catLayers, bt: catBt, special: catSpecial, advanced: catAdvanced }[S.cat] || catKeys)(body, binding);
}

function currentUsageKey(binding) {
  const b = behavior(binding?.behaviorId);
  if (b?.kind !== 'kp') return null;
  const d = decodeUsage(binding.param1);
  return d.page * 0x10000 + d.id;
}

function keyGrid(container, { groups, onPick, currentKey, compact }) {
  const q = S.search.trim().toLowerCase();
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
  const list = h('div', { class: 'adv-list' }, S.behaviors.map((x) => h('button', {
    class: 'adv-item' + (x.id === b.id ? ' active' : ''),
    onclick: () => {
      S.advBehavior = x.id;
      S.advParams = x.id === binding.behaviorId ? { p1: binding.param1, p2: binding.param2 } : { p1: null, p2: null };
      S.advPicker = null; renderPanel();
    },
  }, x.name)));
  const edit = h('div', { class: 'adv-edit' }, h('h3', {}, b.name));
  const sets = b.metadata || [];
  if (noParam(b)) {
    edit.append(h('p', { class: 'hint' }, 'This action has no settings.'));
  } else {
    const p1Descs = sets.flatMap((s) => s.param1 || []);
    edit.append(paramField('p1', p1Descs));
    const set = sets.find((s) => (s.param1 || []).some((d) => matches(d, S.advParams.p1)));
    if (set?.param2?.length) edit.append(paramField('p2', set.param2));
  }
  const ready = noParam(b) || isComplete(b);
  edit.append(h('div', { style: 'margin-top:20px' }, h('button', {
    class: 'btn primary', disabled: !ready,
    onclick: () => assign({ behaviorId: b.id, param1: S.advParams.p1 ?? 0, param2: S.advParams.p2 ?? 0 }),
  }, 'Apply to key')));
  body.append(h('div', { class: 'adv' }, list, edit));
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
        keyGrid(grid, { groups: [...KEY_GROUPS, 'Media'], onPick: (u) => set(encodeUsage(u.page, u.id)) });
        wrap.append(grid);
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
  if (S.view === 'overview') return;
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
  renderTop();
  if (new URLSearchParams(location.search).has('demo')) start(true);
}

boot();
