// HID usage tables used for labels, the key picker and the live key display.
// ZMK encodes a key as: (implicit modifiers << 24) | (usage page << 16) | usage id

export const PAGE_KEYBOARD = 0x07;
export const PAGE_CONSUMER = 0x0c;

export const MOD_BITS = [
  { bit: 0x01, short: 'Ctrl', side: 'L', name: 'Left Ctrl' },
  { bit: 0x02, short: 'Shift', side: 'L', name: 'Left Shift' },
  { bit: 0x04, short: 'Alt', side: 'L', name: 'Left Alt' },
  { bit: 0x08, short: 'Win', side: 'L', name: 'Left Win/Cmd' },
  { bit: 0x10, short: 'Ctrl', side: 'R', name: 'Right Ctrl' },
  { bit: 0x20, short: 'Shift', side: 'R', name: 'Right Shift' },
  { bit: 0x40, short: 'Alt', side: 'R', name: 'Right Alt' },
  { bit: 0x80, short: 'Win', side: 'R', name: 'Right Win/Cmd' },
];

// [id, label, long name, group, KeyboardEvent.code, shifted label]
const KB = [];
const add = (id, label, name, group, code, shifted) => KB.push({ page: PAGE_KEYBOARD, id, label, name, group, code, shifted });

'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => add(0x04 + i, c, c, 'Letters', 'Key' + c));
const shiftedDigits = '!@#$%^&*()';
'1234567890'.split('').forEach((c, i) => add(0x1e + i, c, c, 'Numbers', 'Digit' + c, shiftedDigits[i]));

add(0x28, 'Enter', 'Enter', 'Editing', 'Enter');
add(0x29, 'Esc', 'Escape', 'Editing', 'Escape');
add(0x2a, 'Bksp', 'Backspace', 'Editing', 'Backspace');
add(0x2b, 'Tab', 'Tab', 'Editing', 'Tab');
add(0x2c, 'Space', 'Space', 'Editing', 'Space');
add(0x4c, 'Del', 'Delete', 'Editing', 'Delete');
add(0x49, 'Ins', 'Insert', 'Editing', 'Insert');
add(0x39, 'Caps', 'Caps Lock', 'Editing', 'CapsLock');

add(0x2d, '-', 'Minus', 'Symbols', 'Minus', '_');
add(0x2e, '=', 'Equals', 'Symbols', 'Equal', '+');
add(0x2f, '[', 'Left bracket', 'Symbols', 'BracketLeft', '{');
add(0x30, ']', 'Right bracket', 'Symbols', 'BracketRight', '}');
add(0x31, '\\', 'Backslash', 'Symbols', 'Backslash', '|');
add(0x33, ';', 'Semicolon', 'Symbols', 'Semicolon', ':');
add(0x34, "'", 'Quote', 'Symbols', 'Quote', '"');
add(0x35, '`', 'Grave', 'Symbols', 'Backquote', '~');
add(0x36, ',', 'Comma', 'Symbols', 'Comma', '<');
add(0x37, '.', 'Period', 'Symbols', 'Period', '>');
add(0x38, '/', 'Slash', 'Symbols', 'Slash', '?');
add(0x64, 'ISO \\', 'ISO backslash', 'Symbols', 'IntlBackslash');
add(0x32, 'ISO #', 'ISO hash', 'Symbols', 'IntlHash');

add(0x52, '↑', 'Up', 'Navigation', 'ArrowUp');
add(0x51, '↓', 'Down', 'Navigation', 'ArrowDown');
add(0x50, '←', 'Left', 'Navigation', 'ArrowLeft');
add(0x4f, '→', 'Right', 'Navigation', 'ArrowRight');
add(0x4a, 'Home', 'Home', 'Navigation', 'Home');
add(0x4d, 'End', 'End', 'Navigation', 'End');
add(0x4b, 'PgUp', 'Page Up', 'Navigation', 'PageUp');
add(0x4e, 'PgDn', 'Page Down', 'Navigation', 'PageDown');

add(0xe0, 'Ctrl', 'Left Ctrl', 'Modifiers', 'ControlLeft');
add(0xe1, 'Shift', 'Left Shift', 'Modifiers', 'ShiftLeft');
add(0xe2, 'Alt', 'Left Alt', 'Modifiers', 'AltLeft');
add(0xe3, 'Win', 'Left Win/Cmd', 'Modifiers', 'MetaLeft');
add(0xe4, 'RCtrl', 'Right Ctrl', 'Modifiers', 'ControlRight');
add(0xe5, 'RShift', 'Right Shift', 'Modifiers', 'ShiftRight');
add(0xe6, 'RAlt', 'Right Alt / AltGr', 'Modifiers', 'AltRight');
add(0xe7, 'RWin', 'Right Win/Cmd', 'Modifiers', 'MetaRight');
add(0x65, 'Menu', 'Menu / App', 'Modifiers', 'ContextMenu');

for (let i = 1; i <= 12; i++) add(0x3a + i - 1, 'F' + i, 'F' + i, 'Function', 'F' + i);
for (let i = 13; i <= 24; i++) add(0x68 + i - 13, 'F' + i, 'F' + i, 'Function', 'F' + i);
add(0x46, 'PrtSc', 'Print Screen', 'Function', 'PrintScreen');
add(0x47, 'ScrLk', 'Scroll Lock', 'Function', 'ScrollLock');
add(0x48, 'Pause', 'Pause / Break', 'Function', 'Pause');

add(0x53, 'NumLk', 'Num Lock', 'Numpad', 'NumLock');
add(0x54, 'N/', 'Numpad /', 'Numpad', 'NumpadDivide');
add(0x55, 'N*', 'Numpad *', 'Numpad', 'NumpadMultiply');
add(0x56, 'N-', 'Numpad -', 'Numpad', 'NumpadSubtract');
add(0x57, 'N+', 'Numpad +', 'Numpad', 'NumpadAdd');
add(0x58, 'NEnt', 'Numpad Enter', 'Numpad', 'NumpadEnter');
'123456789'.split('').forEach((c, i) => add(0x59 + i, 'N' + c, 'Numpad ' + c, 'Numpad', 'Numpad' + c));
add(0x62, 'N0', 'Numpad 0', 'Numpad', 'Numpad0');
add(0x63, 'N.', 'Numpad .', 'Numpad', 'NumpadDecimal');

// Consumer (media) keys
const CONSUMER = [
  [0xcd, '⏯', 'Play / Pause', 'MediaPlayPause'],
  [0xb5, '⏭', 'Next track', 'MediaTrackNext'],
  [0xb6, '⏮', 'Previous track', 'MediaTrackPrevious'],
  [0xb7, '⏹', 'Stop', 'MediaStop'],
  [0xe2, 'Mute', 'Mute', 'AudioVolumeMute'],
  [0xe9, 'Vol+', 'Volume up', 'AudioVolumeUp'],
  [0xea, 'Vol−', 'Volume down', 'AudioVolumeDown'],
  [0x6f, 'Bri+', 'Brightness up', null],
  [0x70, 'Bri−', 'Brightness down', null],
  [0xb8, 'Eject', 'Eject', 'Eject'],
  [0x224, 'Back', 'Browser back', 'BrowserBack'],
  [0x225, 'Fwd', 'Browser forward', 'BrowserForward'],
  [0x227, 'Reload', 'Browser refresh', 'BrowserRefresh'],
  [0x223, 'Home', 'Browser home', 'BrowserHome'],
  [0x221, 'Search', 'Search', 'BrowserSearch'],
  [0x18a, 'Mail', 'Mail', 'LaunchMail'],
  [0x192, 'Calc', 'Calculator', 'LaunchApp2'],
  [0x194, 'Files', 'File browser', 'LaunchApp1'],
].map(([id, label, name, code]) => ({ page: PAGE_CONSUMER, id, label, name, group: 'Media', code }));

export const ALL_USAGES = [...KB, ...CONSUMER];
export const KEY_GROUPS = ['Letters', 'Numbers', 'Editing', 'Symbols', 'Navigation', 'Modifiers', 'Function', 'Numpad'];

const byKey = new Map(ALL_USAGES.map((u) => [u.page * 0x10000 + u.id, u]));
const byCode = new Map(ALL_USAGES.filter((u) => u.code).map((u) => [u.code, u]));

export function encodeUsage(page, id, mods = 0) {
  return ((mods & 0xff) * 0x1000000 + ((page & 0xff) << 16) + (id & 0xffff)) >>> 0;
}

export function decodeUsage(value) {
  const v = value >>> 0;
  const mods = Math.floor(v / 0x1000000) & 0xff;
  let page = (v >>> 16) & 0xff;
  const id = v & 0xffff;
  if (page === 0) page = PAGE_KEYBOARD;
  return { mods, page, id, usage: byKey.get(page * 0x10000 + id) };
}

export function usageForCode(code) {
  return byCode.get(code);
}

export function modsLabel(mods) {
  const parts = [];
  for (const m of MOD_BITS) if (mods & m.bit) parts.push((m.side === 'R' ? 'R' : '') + m.short);
  return parts.join('+');
}

// Short label for a key code value, e.g. "A", "Ctrl+C", "!" (Shift+1)
export function usageLabel(value) {
  const { mods, page, id, usage } = decodeUsage(value);
  const base = usage ? usage.label : `0x${page.toString(16)}:${id.toString(16)}`;
  if (!mods) return base;
  if ((mods === 0x02 || mods === 0x20) && usage && usage.shifted) return usage.shifted;
  return modsLabel(mods) + '+' + base;
}

export function usageName(value) {
  const { mods, usage, page, id } = decodeUsage(value);
  const base = usage ? usage.name : `Usage ${page}:${id}`;
  return mods ? modsLabel(mods) + ' + ' + base : base;
}
