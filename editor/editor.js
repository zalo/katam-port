// The KATAM level editor (/editor/): a browser front end over the authoring
// library (tools/katam/lib, the same code as the `katam` CLI).
//
// Everything happens in this browser and nothing is uploaded:
//   - the player's ROM (the copy the game page remembers, or one picked here)
//     is decompiled in memory, so tiles, backgrounds and sprites are drawn
//     from it;
//   - a project (katam-project/1: room JSON files) is edited on a canvas and
//     kept in IndexedDB between visits; Save downloads it as a .zip;
//   - Play compiles the project's rooms (katam-native/1) and hands them to the
//     game, which runs in a frame (play/, web/editor/play.js).  The frame is
//     started in the background, so Play goes straight into the room.
//
// Painting: a TERRAIN BRUSH (lib/autotile.mjs) picks edges, corners and a
// varied fill by itself, from what the original rooms do with the tile set;
// single pieces can still be placed by hand, each with the collision it
// usually has.  A door is an object: its link lives in its inspector.
const CFG = Object.assign({ lib: 'katam/lib/', data: 'data.json', play: 'play/', build: 'dev' }, window.KATAM_ED || {});
const BASE = new URL('.', import.meta.url).href;

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') e[k] = !!v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(3)) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const setKids = (el, ...kids) => el.replaceChildren(...kids.flat(3).filter((k) => k !== null && k !== undefined && k !== false));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const debounce = (fn, ms) => { let t = 0; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.cancel = () => clearTimeout(t); return f; };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off: this session only */ } };
const nice = (s) => String(s).replace(/_/g, ' ');
const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function status(t) { $('#st-text').textContent = t; }

function idb(name, version, stores) {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB is not available'));
    const rq = indexedDB.open(name, version);
    rq.onupgradeneeded = () => { for (const s of stores) if (!rq.result.objectStoreNames.contains(s)) rq.result.createObjectStore(s); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error || new Error('could not open browser storage'));
    rq.onblocked = () => rej(new Error('browser storage is busy in another tab'));
  });
}
const idbReq = (db, store, mode, fn) => new Promise((res, rej) => {
  const rq = fn(db.transaction(store, mode).objectStore(store));
  rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
});
// The game page's own database (web/shell.html "Remembering the ROM"): one
// record {bytes, name, saved} under 'current'.  Shared, so a ROM picked on
// either page serves both, and the play frame finds it by itself.
const romDb = () => idb('katam.rom', 2, ['rom', 'save']);
const edDb = () => idb('katam.editor', 1, ['kv']);

async function sha1(bytes) {
  const d = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

// zip: stored entries out, stored or deflated entries in
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes), n = f.bytes.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + n;
  }
  const csize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
function readZip(buf, inflate) {
  const b = new Uint8Array(buf), dv = new DataView(buf), out = [];
  let e = b.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  let p = dv.getUint32(e + 16, true);
  for (let i = 0, n = dv.getUint16(e + 10, true); i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || !/\.json$/i.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = b.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) { const z = new Uint8Array(raw.length + 2); z[0] = 0x78; z[1] = 0x01; z.set(raw, 2); data = inflate(z); }
    else throw new Error(`${name}: compression method ${method} (use stored or deflate)`);
    out.push({ name, text: new TextDecoder().decode(data) });
  }
  return out;
}

// original icons (no game art ships on the page)
const ICON = {
  select: '<path d="M6 3l14 9-6 1.500 3.500 7-3 1.500-3.500-7L6 19z" fill="#fff" stroke="#2a1f5c" stroke-width="1.600" stroke-linejoin="round"/>',
  brush: '<path d="M20.500 3.500c-3 0-9 5-11 8l3 3c3-2 8-8 8-11z" fill="#4aa3ff" stroke="#2a1f5c" stroke-width="1.400"/><path d="M8.600 12.600c-2.600.200-4 2-4 4.200 0 1.200-.800 2-1.800 2.400 3 1.400 7.400.400 8.200-3.200z" fill="#7b5bf0" stroke="#2a1f5c" stroke-width="1.400"/>',
  rect: '<rect x="3.500" y="5.500" width="17" height="13" rx="1.500" fill="none" stroke="#2a1f5c" stroke-width="2" stroke-dasharray="3.200 2.400"/>',
  fill: '<path d="M10 3l8 8-6.500 6.500a2 2 0 01-2.800 0L4.500 13.300a2 2 0 010-2.800z" fill="#ffd23f" stroke="#2a1f5c" stroke-width="1.500"/><path d="M19 14c1.500 2 2.500 3.400 2.500 4.500a2.500 2.500 0 01-5 0c0-1.100 1-2.500 2.500-4.500z" fill="#4aa3ff" stroke="#2a1f5c" stroke-width="1.200"/>',
  eraser: '<path d="M14.500 4l6 6-9.500 9.500H6.500L3 16z" fill="#ff8fb3" stroke="#2a1f5c" stroke-width="1.500" stroke-linejoin="round"/><path d="M8 10.500l6 6" stroke="#2a1f5c" stroke-width="1.500"/>',
  collision: '<rect x="3" y="3" width="8" height="8" rx="1.500" fill="#4aa3ff"/><rect x="13" y="3" width="8" height="8" rx="1.500" fill="#7b5bf0"/><rect x="3" y="13" width="8" height="8" rx="1.500" fill="#7b5bf0"/><rect x="13" y="13" width="8" height="8" rx="1.500" fill="#4aa3ff"/>',
  object: '<circle cx="12" cy="13" r="8" fill="#ff7a59" stroke="#2a1f5c" stroke-width="1.500"/><circle cx="9.500" cy="11.500" r="1.300" fill="#2a1f5c"/><circle cx="14.500" cy="11.500" r="1.300" fill="#2a1f5c"/><path d="M9 15.500q3 2 6 0" stroke="#2a1f5c" stroke-width="1.400" fill="none" stroke-linecap="round"/>',
  eyedropper: '<path d="M15 4.500l4.500 4.500-2 2-1-1-7.500 7.500-3.500 1 1-3.500L14 7.500l-1-1z" fill="#8fe3c0" stroke="#2a1f5c" stroke-width="1.500" stroke-linejoin="round"/>',
  layers: '<path d="M12 4l9 4.500-9 4.500-9-4.500z" fill="currentColor"/><path d="M4 13l8 4 8-4M4 16.500l8 4 8-4" stroke="currentColor" stroke-width="1.800" fill="none"/>',
  map: '<circle cx="12" cy="5" r="2.500" fill="currentColor"/><circle cx="5" cy="19" r="2.500" fill="currentColor"/><circle cx="19" cy="19" r="2.500" fill="currentColor"/><path d="M12 7.500V13M12 13l-6 4M12 13l6 4" stroke="currentColor" stroke-width="1.800" fill="none"/>',
};
const ico = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;

// --------------------------------------------------------------------- state
const S = {
  L: null, data: null, io: null, vocab: null, registry: null, vanilla: null, rom: null,
  proj: null, bind: null, ctx: null,
  room: null,               // { id, path, ro, doc, W, H, art: [token], col: [value], num }
  gfx: null,
  tool: 'brush',
  paint: null,              // { style } (a terrain brush) or { tile } (one piece, with S.tileCol)
  tile: null, tileCol: 13, colBrush: 13, objType: 'waddle_dee_1',
  sel: null,                // { kind: 'object' | 'door', i }
  zoom: lsGet('katam.ed.zoom', 2), show: Object.assign({ collision: false, objects: true, camera: false, grid: true }, lsGet('katam.ed.show2', {})),
  followCol: true, tab: 'tiles', search: '', salt: 1, openGroups: new Set(lsGet('katam.ed.groups', ['solid'])),
  undo: [], redo: [], hover: null, drag: null, pick: null, lastRoom: null,
  findings: { errors: [], warnings: [], tips: [] },
  starts: lsGet('katam.ed.starts', {}),
  dicts: new Map(), testMarks: new Map(), colClass: [], colRep: {}, objInfo: new Map(), looks: null, sprites: new Map(), browseArea: null,
};
window.katamEditor = S;   // for the console and the tests

const CLASSES = [
  ['air', 'Air (nothing)', null], ['solid', 'Solid (block)', [64, 150, 255]], ['platform', 'One-way (platform)', [70, 210, 90]],
  ['slope', 'Slope', [255, 160, 50]], ['hazard', 'Hazard (damage)', [255, 70, 90]], ['ladder', 'Ladder', [255, 230, 60]],
  ['water', 'Water', [60, 220, 230]], ['breakable', 'Breakable', [200, 130, 60]], ['door', 'Door', [255, 255, 255]], ['other', 'Other', [220, 90, 255]],
];
const CLASS_COLOR = Object.fromEntries(CLASSES.map((c) => [c[0], c[2]]));
const CLASS_LABEL = Object.fromEntries(CLASSES.map((c) => [c[0], c[1]]));
const GROUPS = [['solid', 'Ground'], ['platform', 'Platforms'], ['slope', 'Slopes'], ['hazard', 'Hazards'], ['ladder', 'Ladders'], ['water', 'Water'], ['breakable', 'Breakable'], ['air', 'Scenery'], ['other', 'Other']];
const CAT_COLOR = { enemy: '#ff8a5c', miniboss: '#d58cff', boss: '#b46bff', item: '#7df0c0', gadget: '#ffd23f', door: '#c8f76a', trigger: '#9fd0ff', camera: '#9fd0ff', effect: '#d0d0e8', other: '#d0d0e8' };
const CAT_GROUPS = [['door', 'Doors and mirrors'], ['item', 'Items and food'], ['gadget', 'Switches, blocks and gadgets'], ['enemy', 'Enemies'], ['miniboss', 'Mini-bosses'], ['boss', 'Bosses'], ['trigger', 'Triggers'], ['other', 'Other']];
const isFoe = (c) => c === 'enemy' || c === 'miniboss' || c === 'boss';

// ---------------------------------------------------------------------- boot
const curtain = (msg, { pick = false, err = false } = {}) => {
  $('#curtain').classList.remove('hidden');
  const m = $('#cur-msg'); m.textContent = msg; m.className = err ? 'err' : '';
  $('#cur-pick').hidden = !pick;
};

async function loadLibrary() {
  const names = ['io', 'png', 'zlib', 'rom', 'vocab', 'registry', 'pipeline', 'project', 'validate', 'native', 'rompack', 'room', 'gfx', 'grid', 'tiles', 'json', 'autotile', 'brushtest', 'sprites'];
  const mods = await Promise.all(names.map((n) => import(new URL(CFG.lib + n + '.mjs', BASE).href)));
  const L = Object.fromEntries(names.map((n, i) => [n, mods[i]]));
  L.png.setZlib({ deflate: L.zlib.deflate, inflate: L.zlib.inflate });
  return L;
}

async function storedRom() {
  try { const db = await romDb(); const rec = await idbReq(db, 'rom', 'readonly', (s) => s.get('current')); db.close(); return rec && rec.bytes ? { bytes: new Uint8Array(rec.bytes), name: rec.name } : null; } catch (e) { return null; }
}
async function rememberRom(bytes, name) {
  try { const db = await romDb(); await idbReq(db, 'rom', 'readwrite', (s) => s.put({ bytes, name, saved: Date.now() }, 'current')); db.close(); return true; } catch (e) { return false; }
}
const pickRom = () => new Promise((res) => {
  $('#romfile').onchange = async function () { const f = this.files[0]; this.value = ''; if (f) res({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, picked: true }); };
});

async function boot() {
  $('#st-build').textContent = 'build ' + CFG.build;
  curtain('Loading the editor…');
  const [data, L] = await Promise.all([fetch(new URL(CFG.data, BASE)).then((r) => { if (!r.ok) throw new Error('data.json: ' + r.status); return r.json(); }), loadLibrary()]);
  S.data = data; S.L = L;
  S.io = L.io.memoryIO();
  for (const [n, v] of Object.entries(data.schemas)) S.io.writeText('/schema/' + n, JSON.stringify(v));
  for (const [n, v] of Object.entries(data.semantics)) S.io.writeText('/semantics/' + n, JSON.stringify(v));
  S.vocab = L.vocab.indexVocab(data.vocab);
  S.registry = L.registry.loadRegistry(S.io, '/semantics');
  S.colClass = S.vocab.collision.map((c) => L.autotile.classOfBits(c.bits));
  const named = S.registry.collisionEnum();
  for (const [cls] of CLASSES) {
    let best = -1, bestN = -1;
    for (const [v, e] of Object.entries(named)) if (S.colClass[v] === cls && (e.cells || 0) > bestN) { best = Number(v); bestN = e.cells || 0; }
    if (best >= 0) S.colRep[cls] = best;
  }
  if (S.colClass[255] === 'door') S.colRep.door = 255;
  S.colNames = named;
  const types = (data.semantics['object_params.json'] || {}).types || {};
  for (const [name, num] of Object.entries(S.vocab.objectTypes)) {
    const t = types[hex2(num)] || {};
    S.objInfo.set(name, { num, category: t.category || (num < 0x5e ? 'enemy' : 'other'), description: t.description || '', params: (t.params || []).filter((p) => p.name) });
  }

  let rom = await storedRom();
  for (;;) {
    if (!rom) { curtain('Choose your Kirby & The Amazing Mirror ROM to begin.', { pick: true }); rom = await pickRom(); }
    curtain('Checking the ROM…');
    const sum = await sha1(rom.bytes);
    if (sum === L.rom.VANILLA_SHA1) break;
    curtain(`That file (sha1 ${sum.slice(0, 12)}…) is not the supported dump: Kirby & The Amazing Mirror (USA). Choose another file.`, { pick: true, err: true });
    rom = await pickRom();
  }
  S.rom = rom.bytes;
  S.romStored = rom.picked ? await rememberRom(rom.bytes, rom.name) : true;

  curtain('Reading the game from your ROM (in this browser)…');
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const romTables = L.rom.parseRomTables(data.romTables);
  const pack = L.rompack.packFromRom(S.rom, romTables, data.manifest);
  L.pipeline.decompileVanilla({ io: S.io, romBytes: S.rom, romTables, pack, vocab: S.vocab, registry: S.registry, outDir: '/vanilla' });
  S.vanilla = L.project.loadProject(S.io, '/vanilla');
  console.log(`[editor] game decompiled in ${Math.round(performance.now() - t0)} ms`);

  let saved = null;
  try { const db = await edDb(); saved = await idbReq(db, 'kv', 'readonly', (s) => s.get('project')); db.close(); } catch (e) { /* none */ }
  if (saved && saved.files && saved.files.length) { putFiles(saved.files); S.wantRoom = saved.cur; } else putExample();
  buildUi();
  rebind();
  const rooms = roomIds();
  if (!openRoom(rooms.includes(S.wantRoom) ? S.wantRoom : rooms[0])) { putExample(); rebind(); openRoom(roomIds()[0]); }
  $('#curtain').classList.add('hidden');
  $('#app').classList.remove('loading');
  if (lsGet('katam.ed.zoom', 0) === 0) zoomFit();
  validateSoon();
  setTimeout(prewarm, 1500);
}

// ------------------------------------------------------------------- project
const projPath = (id) => '/project/' + S.L.project.pathOf(id);
function clearProject() { for (const p of S.io.list('/project')) S.io.files.delete(p); }
function putFiles(files) { clearProject(); for (const [p, t] of files) S.io.writeText(p, t); }
function putExample(name = S.example || 'sky_garden') {
  clearProject();
  for (const [p, t] of Object.entries(S.data.examples)) if (p.startsWith(name + '/')) S.io.writeText('/project/' + p.slice(name.length + 1), t);
}
function ensureProjectFile() {
  if (!S.io.exists('/project/project.json')) S.io.writeText('/project/project.json', S.L.json.writeJson({ format: 'katam-project/1', id: 'my_levels', name: 'My levels', base: 'vanilla' }));
}
function rebind() {
  const P = S.L.project;
  S.proj = P.loadProject(S.io, '/project');
  S.bind = new P.Bindings(S.vocab, [S.vanilla, S.proj]);
  S.ctx = P.makeContext({ vocab: S.vocab, registry: S.registry, bindings: S.bind });
  if (S.room) S.room.num = S.bind.num.get(S.room.id);
}
const numOf = (id) => S.bind.num.get(S.bind.resolve(id) || id);
const mine = (id) => S.proj.docs.has(id);
const roomIds = () => [...S.proj.docs.keys()].filter((id) => id.startsWith('room:')).sort((a, b) => numOf(a) - numOf(b));
const vanillaIds = () => [...S.vanilla.docs.keys()].filter((id) => id.startsWith('room:')).sort((a, b) => numOf(a) - numOf(b));
const areaOf = (id) => id.slice(5).split('/')[0];
function roomDoc(id) {
  if (S.room && S.room.id === id) return S.room.doc;
  const r = S.bind.resolve(id);
  return r ? S.bind.docs.get(r).doc : null;
}
function roomLabel(id) {
  const d = roomDoc(id), n = numOf(id);
  if (d && d.bind) return `${n} (${nice(areaOf(id))}${mine(id) ? ', edited' : ''})`;
  return `${n} (${(d && d.name) || id.split('/').pop()})`;
}
const shortLabel = (to) => { const r = S.bind.resolve(to); return r ? 'room ' + numOf(r) : '?'; };

const persist = debounce(async () => {
  try {
    const files = S.io.list('/project').map((p) => [p, S.io.readText(p)]);
    const db = await edDb(); await idbReq(db, 'kv', 'readwrite', (s) => s.put({ files, cur: S.room && !S.room.ro ? S.room.id : S.lastRoom, saved: Date.now() }, 'project')); db.close();
  } catch (e) { console.warn('[editor] autosave failed:', e); }
}, 500);

/** A room, decoded for editing: the open one, or another one being changed from here. */
function loadRoom(id) {
  const T = S.L.tiles, G = S.L.grid;
  const rid = S.bind.resolve(id), ent = S.bind.docs.get(rid);
  const doc = JSON.parse(S.io.readText(ent.abs));
  const W = doc.size.width, H = doc.size.height;
  const art = G.decodeGrid(doc.art, W, H, 'art').map((s) => T.metaToken(T.metaValues(s)));
  const col = G.decodeGrid(doc.collision, W, H, 'collision').map((v) => S.ctx.collisionValue(v));
  doc.objects = doc.objects || []; doc.doors = doc.doors || [];
  return { id: rid, path: ent.abs, ro: !mine(rid), doc, W, H, art, col, num: numOf(rid), dirty: false };
}
function saveRoom(R) {
  if (R.ro) return;
  const G = S.L.grid, d = R.doc, empty = dict(d.tileset).empty;
  tendPatches(R);
  d.size = { width: R.W, height: R.H };
  d.art = G.encodeGrid(R.art, R.W, R.H, { suggest: (m) => (m === empty ? '.' : null) });
  d.collision = G.encodeGrid(R.col, R.W, R.H, { suggest: (v) => S.ctx.collisionGlyph(v), toLegend: (v) => S.ctx.collisionName(v) });
  S.io.writeText(R.path, S.L.json.writeJson(d));
  R.dirty = false;
  // keep the loaded copy in step, so other rooms see this one's doors without a reload
  const ent = S.proj.docs.get(R.id);
  if (ent) ent.doc = JSON.parse(S.io.readText(R.path));
  persist();
}
function flush() { if (S.room && S.room.dirty && !S.pv) saveRoom(S.room); }
/** Change another room (or the open one) through the same decoded form. */
function withRoom(id, fn) {
  const rid = S.bind.resolve(id);
  if (S.room && S.room.id === rid) { const r = fn(S.room); S.room.dirty = true; return r; }
  if (!mine(rid)) return fn(loadRoom(rid));           // an original room: look, do not write
  const R = loadRoom(rid), r = fn(R);
  saveRoom(R);
  return r;
}

function fixPaint() {
  const D = dict(S.room.doc.tileset);
  if (!S.paint || (S.paint.style && !D.styles.includes(S.paint.style)) || (S.paint.tile && !D.map.has(S.paint.tile))) {
    const st = D.styles.find((s) => s.kind === 'solid') || D.styles[0];
    if (st) S.paint = { style: st };
    else { const first = D.list.find((e) => e.cls === 'solid') || D.list[0]; S.paint = { tile: first ? first.tok : D.empty }; S.tileCol = first ? first.col : 0; }
  }
}
function openRoom(id, { keepUndo = false } = {}) {
  cancelLookPreview(true);
  flush();
  let R;
  try { R = loadRoom(id); } catch (e) { toast('This room could not be opened: ' + e.message, 6000); return false; }
  if (S.room && !S.room.ro && S.room.id !== R.id) S.lastRoom = S.room.id;
  S.room = R;
  if (!keepUndo) { S.undo = []; S.redo = []; }
  S.sel = null; S.hover = null;
  loadGfx();
  fixPaint();
  sizeCanvas();
  refreshAll();
  persist();
  return true;
}

function touch() { S.room.dirty = true; flushSoon(); validateSoon(); thumbsSoon(); requestRender(); }
const flushSoon = debounce(() => { flush(); refreshStatus(); }, 400);
function readOnly() {
  if (S.pv) { toast('You are trying a look on this room: choose “Use this look” or “Cancel” above the room first.', 4000); return true; }
  if (!S.room.ro) return false;
  toast('This is a room of the original game. Use “Edit this room” or “Copy as a new room” above it.', 4000);
  return true;
}

function snapshot() {
  const R = S.room;
  return { W: R.W, H: R.H, art: R.art.slice(), col: R.col.slice(), objects: JSON.stringify(R.doc.objects), doors: JSON.stringify(R.doc.doors),
    patches: JSON.stringify(R.doc.patches || []), look: [R.doc.tileset, R.doc.palette, R.doc.background], music: R.doc.music, name: R.doc.name };
}
function restore(s) {
  const R = S.room, resized = R.W !== s.W || R.H !== s.H;
  R.W = s.W; R.H = s.H; R.art = s.art.slice(); R.col = s.col.slice(); R.src = null;
  R.doc.objects = JSON.parse(s.objects); R.doc.doors = JSON.parse(s.doors);
  const d = R.doc, relook = s.look && (d.tileset !== s.look[0] || d.palette !== s.look[1] || d.background !== s.look[2]);
  const pt = JSON.parse(s.patches || '[]');
  if (pt.length) d.patches = pt; else delete d.patches;
  if (s.look) [d.tileset, d.palette, d.background] = s.look;
  if (s.music !== undefined) d.music = s.music;
  if (s.name !== undefined) d.name = s.name;
  if (relook) { loadGfx(); S.paint = null; fixPaint(); }
  if (S.sel && !selected()) S.sel = null;
  if (resized) sizeCanvas();
  redrawArt(); touch(); refreshInspector(); refreshMap(); refreshRooms();
  if (relook || S.tab === 'room') refreshTab();
}
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 80) S.undo.shift(); S.redo = []; refreshUndo(); }
function undo() { cancelLookPreview(); if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); refreshUndo(); }
function redo() { cancelLookPreview(); if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); refreshUndo(); }
function refreshUndo() { $('#undo').disabled = !S.undo.length; $('#redo').disabled = !S.redo.length; }

// ---------------------------------------------------------------- graphics
const rgb5 = (hex) => { const c = S.L.gfx.bgr555(hex); return [c & 31, (c >> 5) & 31, (c >> 10) & 31].map((v) => (v << 3) | (v >> 2)); };
const docOf = (id) => { const r = S.bind.resolve(id); return r ? S.bind.docs.get(r) : null; };
const gfxCache = new Map();
const HIDDEN = [16, 14, 30];      // bank 15: the flat dark piece the original hides inside walls

function gfxFor(d) {
  const key = d.tileset + '|' + d.palette + '|' + d.background;
  let g = gfxCache.get(key);
  if (g) return g;
  g = { key, tiles: new Uint8Array(0), banks: [], cache: new Map(), cvs: new Map(), bg: null };
  try {
    const ts = docOf(d.tileset), pal = docOf(d.palette);
    if (ts) g.tiles = S.L.gfx.pngToTiles(S.io.readBytes(`${ts.base}/${ts.doc.image}`), ts.doc.tileCount, ts.doc.image);
    if (pal) g.banks = pal.doc.banks.map((b) => b.map(rgb5));
    g.tileCount = ts ? ts.doc.tileCount : 0;
  } catch (e) { console.warn('[editor] tileset:', e); }
  try {
    const bg = docOf(d.background);
    if (bg) {
      const b = bg.doc, tiles = S.L.gfx.pngToTiles(S.io.readBytes(`${bg.base}/${b.image}`), b.tileCount, b.image);
      const cols = b.palette.colors.map(rgb5), off = b.palette.offset, w = b.size.width, hh = b.size.height;
      const im = new ImageData(w * 8, hh * 8);
      b.tilemap.forEach((row, ty) => row.trim().split(/\s+/).forEach((tok, tx) => {
        const v = S.L.tiles.valueOf(tok), t = v & 0x3ff, hf = v & 0x400, vf = v & 0x800, bank = v >> 12;
        if (t * 32 + 32 > tiles.length) return;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y, by = tiles[t * 32 + sy * 4 + (sx >> 1)], ci = sx & 1 ? by >> 4 : by & 15;
          const c = cols[bank * 16 + ci - off] || [24, 24, 40], o = ((ty * 8 + y) * im.width + tx * 8 + x) * 4;
          im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = 255;
        }
      }));
      g.bg = h('canvas', { width: im.width, height: im.height });
      g.bg.getContext('2d').putImageData(im, 0, 0);
    }
  } catch (e) { console.warn('[editor] background:', e); }
  gfxCache.set(key, g);
  return g;
}
function loadGfx() { S.gfx = gfxFor(S.room.doc); }

function metaImage(tok, g = S.gfx) {
  let im = g.cache.get(tok);
  if (im) return im;
  im = new ImageData(16, 16);
  let vals;
  try { vals = S.L.tiles.metaValues(tok); } catch (e) { vals = null; }
  for (let q = 0; q < 4; q++) {
    const ox = (q & 1) * 8, oy = (q >> 1) * 8;
    const v = vals ? vals[q] : 0, t = v & 0x3ff, hf = v & 0x400, vf = v & 0x800, bn = v >> 12, bank = g.banks[bn];
    const bad = !vals || t * 32 + 32 > g.tiles.length;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const o = ((oy + y) * 16 + ox + x) * 4;
      if (bad) { im.data[o] = 40; im.data[o + 1] = 30; im.data[o + 2] = 80; im.data[o + 3] = (x + y) & 1 ? 150 : 60; continue; }   // a tile the tile set does not hold
      const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y, by = g.tiles[t * 32 + sy * 4 + (sx >> 1)], ci = sx & 1 ? by >> 4 : by & 15;
      if (!ci) continue;
      const c = (bank && bank[ci]) || (bn === 15 ? HIDDEN : [255, 0, 255]);
      im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = 255;
    }
  }
  g.cache.set(tok, im);
  return im;
}
/** The same piece as a canvas (drawImage scales and blends; putImageData does not). */
function metaCanvas(tok, g = S.gfx) {
  let cv = g.cvs.get(tok);
  if (!cv) { cv = h('canvas', { width: 16, height: 16 }); cv.getContext('2d').putImageData(metaImage(tok, g), 0, 0); g.cvs.set(tok, cv); }
  return cv;
}

function redrawArt() {
  const R = S.room;
  if (!S.artCv) S.artCv = document.createElement('canvas');
  S.artCv.width = R.W * 16; S.artCv.height = R.H * 16;
  const c = S.artCv.getContext('2d');
  for (let i = 0; i < R.art.length; i++) c.putImageData(metaImage(R.art[i]), (i % R.W) * 16, ((i / R.W) | 0) * 16);
}
function drawCell(i) { S.artCv.getContext('2d').putImageData(metaImage(S.room.art[i]), (i % S.room.W) * 16, ((i / S.room.W) | 0) * 16); }

/** A whole room (art over background) at 1:1, for thumbnails. */
function roomPicture(id) {
  let W, H, art, g;
  if (S.room && S.room.id === id) ({ W, H, art } = S.room), g = S.gfx;
  else return docPicture(roomDoc(id));
  return artPicture(W, H, art, g);
}
function docPicture(d) {
  const W = d.size.width, H = d.size.height;
  let art;
  try { art = S.L.grid.decodeGrid(d.art, W, H); } catch (e) { art = []; }
  return artPicture(W, H, art, gfxFor(d));
}
function artPicture(W, H, art, g) {
  const cv = h('canvas', { width: W * 16, height: H * 16 }), c = cv.getContext('2d');
  paintBackground(c, g, W * 16, H * 16);
  const t = h('canvas', { width: W * 16, height: H * 16 }), tc = t.getContext('2d');
  for (let i = 0; i < art.length; i++) tc.putImageData(metaImage(art[i], g), (i % W) * 16, ((i / W) | 0) * 16);
  c.drawImage(t, 0, 0);
  return cv;
}
/**
 * The backdrop.  In the game it is a picture that stays (almost) still behind
 * the screen while the room scrolls, so a whole-room view cannot show "the"
 * place it has.  It is drawn the way it reads in play: resting on the bottom
 * of the room, at least as tall as the room (scaled up to 3x), repeated
 * sideways mirror-fashion so there is no seam, with its top row carried
 * upwards when the room is taller still.
 */
function paintBackground(c, g, w, hgt) {
  c.fillStyle = '#18182a'; c.fillRect(0, 0, w, hgt);
  if (!g.bg) return;
  const s = clamp(hgt / g.bg.height, 1, 3), bw = Math.round(g.bg.width * s), bh = Math.round(g.bg.height * s), y0 = hgt - bh;
  c.imageSmoothingEnabled = false;
  for (let x = 0, k = 0; x < w; x += bw, k++) {
    c.save();
    if (k & 1) { c.translate(x + bw, 0); c.scale(-1, 1); } else c.translate(x, 0);
    if (y0 > 0) c.drawImage(g.bg, 0, 0, g.bg.width, 1, 0, 0, bw, y0);
    c.drawImage(g.bg, 0, y0, bw, bh);
    c.restore();
  }
}

/** One sprite per object type, decoded from the ROM (lib/sprites.mjs); null when the type has none. */
function sprite(name) {
  if (S.sprites.has(name)) return S.sprites.get(name);
  let out = null;
  try {
    const sp = name === '@kirby' ? S.L.sprites.kirbySprite(S.rom) : S.L.sprites.objectSprite(S.rom, S.vocab.objectTypes[name]);
    if (sp && sp.w > 0 && sp.h > 0) {
      const cv = h('canvas', { width: sp.w, height: sp.h });
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sp.rgba.buffer, sp.rgba.byteOffset, sp.w * sp.h * 4), sp.w, sp.h), 0, 0);
      out = { cv, w: sp.w, h: sp.h, ox: sp.ox, oy: sp.oy };
    }
  } catch (e) { console.warn('[editor] sprite', name, e); }
  S.sprites.set(name, out);
  return out;
}
const initials = (name) => { const p = String(name).split('_').filter((w) => w && !/^\d+$/.test(w)); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : (p[0] || '')[1] || '')).toUpperCase(); };
/** A picker / inspector picture of a type: its sprite, or a coloured badge. */
function typeIcon(name, size = 44) {
  const sp = sprite(name), info = S.objInfo.get(name) || { category: 'other' };
  if (!sp) return h('i', { class: 'badge', style: `background:${CAT_COLOR[info.category] || CAT_COLOR.other}` }, initials(name));
  const cv = h('canvas', { width: size, height: size }), c = cv.getContext('2d');
  const k = Math.min(size / sp.w, size / sp.h, 2);
  c.imageSmoothingEnabled = k >= 1 ? false : true;
  c.drawImage(sp.cv, (size - sp.w * k) / 2, (size - sp.h * k) / 2, sp.w * k, sp.h * k);
  cv.style.width = cv.style.height = size + 'px';
  return cv;
}

// ------------------------------------------------- the tileset's pieces
/** For one tileset: every 16x16 piece the original rooms build with it (how
 *  often, with which collision), and the terrain brushes learned from them. */
function dict(tsId) {
  let D = S.dicts.get(tsId);
  if (D) return D;
  const map = new Map(), G = S.L.grid, T = S.L.tiles, A = S.L.autotile, rooms = [];
  for (const [id, d] of S.vanilla.docs) {
    const doc = d.doc;
    if (!id.startsWith('room:') || doc.tileset !== tsId) continue;
    const W = doc.size.width, H = doc.size.height;
    let art, col;
    try { art = G.decodeGrid(doc.art, W, H).map((s) => T.metaToken(T.metaValues(s))); col = G.decodeGrid(doc.collision, W, H).map((v) => S.ctx.collisionValue(v)); } catch (e) { continue; }
    rooms.push({ W, H, art, cls: col.map((v) => S.colClass[v]), col });
    for (let i = 0; i < art.length; i++) {
      let e = map.get(art[i]);
      if (!e) map.set(art[i], e = { tok: art[i], n: 0, cols: new Map() });
      e.n++; e.cols.set(col[i], (e.cols.get(col[i]) || 0) + 1);
    }
  }
  for (const e of map.values()) {
    let best = 0, bn = -1;
    for (const [v, n] of e.cols) if (n > bn) { best = v; bn = n; }
    e.col = best; e.cls = S.colClass[best];
  }
  const list = [...map.values()].sort((a, b) => b.n - a.n);
  const air = list.find((e) => e.cls === 'air');
  const empty = air ? air.tok : '000.0 000.0 000.0 000.0';
  // a piece with no see-through pixel is a wall, not an edge: the brush must not strew it in the air
  const look = [...S.vanilla.docs.values()].map((d) => d.doc).find((d) => d.tileset === tsId) || (S.room && S.room.doc);
  const g = look ? gfxFor(look) : null;
  const opaque = (t) => { if (!g) return false; const im = metaImage(t, g).data; for (let i = 3; i < im.length; i += 4) if (im[i] < 255) return false; return true; };
  const pixels = (t) => (g ? metaImage(t, g).data : new Uint8ClampedArray(1024));
  const rules = Object.values(S.data.autotile || {}).find((r) => r && r.tileset === tsId) || null;   // hand-checked presets (assets/schema/authoring/autotile)
  const model = A.learn(rooms, empty, { opaque, pixels, rules });
  const styles = Object.values(model.kinds).flatMap((K) => K.styles);
  D = { map, list, rooms: rooms.length, empty, model, styles };
  S.dicts.set(tsId, D);
  return D;
}
const styleLabel = (st) => st.name;

/** The (tileset, palette, background) combinations the original game uses. */
function looks() {
  if (S.looks) return S.looks;
  const m = new Map();
  for (const [id, d] of S.vanilla.docs) {
    if (!id.startsWith('room:')) continue;
    const doc = d.doc, key = doc.tileset + '|' + doc.palette + '|' + doc.background;
    let e = m.get(key);
    if (!e) m.set(key, e = { key, tileset: doc.tileset, palette: doc.palette, background: doc.background, music: doc.music, n: 0, area: areaOf(id), id, room: doc.bind && doc.bind.roomId });
    e.n++;
  }
  S.looks = [...m.values()].sort((a, b) => (a.area < b.area ? -1 : a.area > b.area ? 1 : b.n - a.n));
  for (const e of S.looks) e.label = `${nice(e.area)} — like room ${e.room} (${e.n} room${e.n > 1 ? 's' : ''})`;
  return S.looks;
}

// ---------------------------------------------------------------- the view
let renderQueued = false;
function requestRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }

function sizeCanvas() {
  const R = S.room, cv = $('#cv');
  const cw = R.W * 16 * S.zoom, ch = R.H * 16 * S.zoom;
  let k = Math.min(window.devicePixelRatio || 1, 2);
  while (k > 1 && cw * ch * k * k > 9e6) k -= 0.5;
  S.dpr = Math.max(1, k);
  cv.width = Math.round(cw * S.dpr); cv.height = Math.round(ch * S.dpr);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  redrawArt();
  requestRender();
}

/** The tile Kirby stands on when Play starts. */
function startCell() {
  const R = S.room;
  let s = S.starts[R.id];
  if (!s) {
    const d = R.doc.doors.find((x) => x.cells && x.cells[0]);
    s = d ? [d.cells[0][0], d.cells[0][1]] : (() => { const p = findSpot(R); return p ? [p.x, p.y] : [Math.min(2, R.W - 1), Math.max(0, R.H - 4)]; })();
  }
  return [clamp(s[0], 0, R.W - 1), clamp(s[1], 0, R.H - 1)];
}

function pill(c, text, x, y, fg = '#2a1f5c', bg = '#fff') {
  c.font = '700 5px ui-rounded, system-ui, sans-serif';
  const w = c.measureText(text).width + 5;
  const px = clamp(x - w / 2, 1, S.room.W * 16 - w - 1), py = Math.max(1, y);
  c.fillStyle = bg; c.strokeStyle = '#2a1f5c'; c.lineWidth = 0.600;
  c.beginPath(); c.roundRect(px, py, w, 8, 2.500); c.fill(); c.stroke();
  c.fillStyle = fg; c.textBaseline = 'middle'; c.textAlign = 'left'; c.fillText(text, px + 2.500, py + 4.300);
}
const typeName = (o) => (typeof o.type === 'number' ? S.vocab.objectTypeName[o.type] || String(o.type) : o.type);
/** An object's box on the room, in room pixels. */
function objBox(o) {
  const name = typeName(o), sp = sprite(name);
  if (!sp) return [o.x - 7, o.y - 7, 14, 14];
  // doors and chests stand on the floor of their tile in play, whatever their sprite's origin says
  if (isDoorType(name) || /chest/.test(name) || (S.objInfo.get(name) || {}).category === 'door') return [o.x - sp.ox, (Math.floor(o.y / 16) + 1) * 16 - sp.h, sp.w, sp.h];
  return [o.x - sp.ox, o.y - sp.oy, sp.w, sp.h];
}

function render() {
  const R = S.room, cv = $('#cv'), c = cv.getContext('2d');
  if (!R) return;
  const k = S.zoom * S.dpr, W = R.W * 16, H = R.H * 16;
  c.setTransform(k, 0, 0, k, 0, 0);
  c.imageSmoothingEnabled = false;
  paintBackground(c, S.gfx, W, H);
  c.drawImage(S.artCv, 0, 0);

  if (S.show.collision || S.tool === 'collision') {
    for (let i = 0; i < R.col.length; i++) {
      const col = CLASS_COLOR[S.colClass[R.col[i]]];
      if (!col) continue;
      const x = (i % R.W) * 16, y = ((i / R.W) | 0) * 16;
      c.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},.38)`; c.fillRect(x, y, 16, 16);
      c.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},.85)`; c.lineWidth = 0.700; c.strokeRect(x + 0.350, y + 0.350, 15.300, 15.300);
    }
  }
  if (S.show.collision || S.tool === 'collision' || (S.paint && S.paint.mech)) {
    const vb = mechValue(MECH[1]), vc = mechValue(MECH[2]), vf = mechValue(MECH[3]);
    for (let i = 0; i < R.col.length; i++) {
      const v = R.col[i];
      if (!isMech(v)) continue;
      const x = (i % R.W) * 16 + 8, y = ((i / R.W) | 0) * 16 + 8, bits = S.vocab.collision[v].bits;
      if (/chain_trigger/.test(bits)) { c.fillStyle = '#ff3b30'; c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.arc(x, y, 4.500, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#fff'; c.fillRect(x - 0.750, y - 3, 1.500, 3.500); c.fillRect(x - 0.750, y + 1.500, 1.500, 1.500); }
      else if (/chain_member/.test(bits)) { c.strokeStyle = '#ff9f0a'; c.lineWidth = 1.500; c.setLineDash(v === vf ? [2, 2] : []); c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x + 4, y); c.lineTo(x, y + 4); c.lineTo(x - 4, y); c.closePath(); c.stroke(); c.setLineDash([]); }
      else { c.strokeStyle = '#fff'; c.lineWidth = 1; c.beginPath(); c.moveTo(x - 3, y - 3); c.lineTo(x + 3, y + 3); c.moveTo(x + 3, y - 3); c.lineTo(x - 3, y + 3); c.stroke(); }
    }
    void vb; void vc;
  }
  const marks = S.testMarks.get(R.id);   // a brush's test level: where it has no piece of that shape
  if (marks) for (const [i, h] of marks) {
    c.strokeStyle = h === 'borrowed' ? '#ff2d2d' : '#ffd400'; c.lineWidth = 1;
    c.strokeRect((i % R.W) * 16 + 0.5, ((i / R.W) | 0) * 16 + 0.5, 15, 15);
  }
  if (S.show.grid) {
    c.lineWidth = 1 / k; c.strokeStyle = 'rgba(255,255,255,.2)';
    c.beginPath();
    for (let x = 0; x <= R.W; x++) { c.moveTo(x * 16, 0); c.lineTo(x * 16, H); }
    for (let y = 0; y <= R.H; y++) { c.moveTo(0, y * 16); c.lineTo(W, y * 16); }
    c.stroke();
  }
  // the camera never shows the last 40 px of a room
  c.fillStyle = 'rgba(20,10,50,.42)'; c.fillRect(0, H - 40, W, 40);
  c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = 0.800; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, H - 40); c.lineTo(W, H - 40); c.stroke(); c.setLineDash([]);
  if (S.zoom >= 2) pill(c, 'below the camera: not seen in play', 52, H - 37, '#fff', '#2a1f5c');

  const [sx, sy] = startCell();
  if (S.show.camera) {
    const cx = clamp(sx * 16 + 8 - 120, 0, Math.max(0, W - 240)), cy = clamp(sy * 16 + 8 - 100, 0, Math.max(0, H - 200));
    c.strokeStyle = '#fff'; c.lineWidth = 1.200; c.setLineDash([5, 3]); c.strokeRect(cx, cy, Math.min(240, W), Math.min(160, H)); c.setLineDash([]);
    pill(c, '240 × 160 (game screen)', cx + 46, cy + 3, '#fff', '#2a1f5c');
  }
  // doors with no door object on them (rooms of the original game)
  R.doc.doors.forEach((d, i) => {
    const on = S.sel && S.sel.kind === 'door' && S.sel.i === i;
    for (const [x, y] of d.cells || []) {
      if (!on && doorObject(R, x, y) >= 0 && S.show.objects) continue;
      c.strokeStyle = on ? '#ffd23f' : '#fff'; c.lineWidth = on ? 1.800 : 1.200; c.strokeRect(x * 16 + 1, y * 16 + 1, 14, 14);
    }
    if (d.cells && d.cells[0] && S.zoom >= 2) pill(c, '→ ' + shortLabel(d.to), d.cells[0][0] * 16 + 8, d.cells[0][1] * 16 - 22);
  });
  // objects on one channel work together: a line from each switch (or fuse) to what it drives
  if (S.show.objects || S.tool === 'object') {
    const src = (n) => n === 'small_button' || n === 'cannon_fuse' || n === 'big_button' || /^large_star_stone_block_(7e|88)$/.test(n);
    const linked = R.doc.objects.filter((o) => o.roomRegister && LINKS[typeName(o)]);
    for (const a of linked) {
      if (!src(typeName(a))) continue;
      for (const b of linked) {
        if (b === a || b.roomRegister !== a.roomRegister || src(typeName(b)) || ((typeName(a) === 'big_button') !== /^(door_to_hub|hub_mirror)$/.test(typeName(b)))) continue;
        c.strokeStyle = '#ffd23f'; c.lineWidth = 1.200; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); c.setLineDash([]);
        if (S.zoom >= 2) pill(c, 'ch ' + a.roomRegister, (a.x + b.x) / 2, (a.y + b.y) / 2 - 5);
      }
    }
  }
  // objects
  if (S.show.objects || S.tool === 'object') {
    R.doc.objects.forEach((o, i) => {
      const name = typeName(o), sp = sprite(name), on = S.sel && S.sel.kind === 'object' && S.sel.i === i;
      const [bx, by, bw, bh] = objBox(o);
      if (sp) c.drawImage(sp.cv, Math.round(bx), Math.round(by));
      else {
        const info = S.objInfo.get(name) || { category: 'other' };
        c.fillStyle = CAT_COLOR[info.category] || CAT_COLOR.other; c.strokeStyle = '#2a1f5c'; c.lineWidth = 1;
        c.beginPath(); c.roundRect(bx, by, bw, bh, 4); c.fill(); c.stroke();
        c.fillStyle = '#1b1440'; c.font = '900 6px ui-rounded, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(initials(name), o.x, o.y + 0.500);
      }
      if (on) {
        c.strokeStyle = '#ffd23f'; c.lineWidth = 1.500; c.setLineDash([3, 2]); c.strokeRect(bx - 1.500, by - 1.500, bw + 3, bh + 3); c.setLineDash([]);
        pill(c, nice(name), o.x, by - 11);
      }
    });
  }
  // where Play starts: Kirby
  const ks = sprite('@kirby');
  c.globalAlpha = 0.85;
  if (ks) c.drawImage(ks.cv, sx * 16 + 8 - ks.ox, sy * 16 + 16 - ks.oy - (ks.h - ks.oy));
  else { c.fillStyle = '#ff8fc0'; c.beginPath(); c.arc(sx * 16 + 8, sy * 16 + 9, 6.500, 0, 7); c.fill(); }
  c.globalAlpha = 1;
  if (S.zoom >= 2) pill(c, '▶ start', sx * 16 + 8, sy * 16 - 9, '#12301a', '#4cd964');

  // previews
  const d = S.drag;
  if (d && d.rect) {
    const [x0, y0, x1, y1] = d.rect;
    c.strokeStyle = '#ffd23f'; c.lineWidth = 1.500; c.setLineDash([4, 2]);
    c.strokeRect(Math.min(x0, x1) * 16, Math.min(y0, y1) * 16, (Math.abs(x1 - x0) + 1) * 16, (Math.abs(y1 - y0) + 1) * 16); c.setLineDash([]);
  } else if (S.hover && S.tool !== 'select' && !R.ro) {
    const [hx, hy] = S.hover;
    if (!d && (S.tool === 'brush' || S.tool === 'rect' || S.tool === 'fill') && S.paint && S.paint.tile) { c.globalAlpha = 0.6; c.drawImage(metaCanvas(S.paint.tile), hx * 16, hy * 16); c.globalAlpha = 1; }
    if (!d && S.tool === 'object') { const sp = sprite(S.objType); if (sp) { c.globalAlpha = 0.6; c.drawImage(sp.cv, hx * 16 + 8 - sp.ox, hy * 16 + 8 - sp.oy); c.globalAlpha = 1; } }
    c.strokeStyle = S.pick ? '#4cd964' : '#ffd23f'; c.lineWidth = 1.200; c.strokeRect(hx * 16 + 0.500, hy * 16 + 0.500, 15, 15);
  }
  if (S.pick && S.hover) pill(c, 'arrive here', S.hover[0] * 16 + 8, S.hover[1] * 16 - 10, '#12301a', '#4cd964');
}

function setZoom(z, anchor) {
  z = clamp(z, 1, 6);
  if (z === S.zoom) return;
  const sc = $('#scroll'), old = S.zoom;
  const ax = anchor ? anchor[0] : sc.clientWidth / 2, ay = anchor ? anchor[1] : sc.clientHeight / 2;
  const rx = (sc.scrollLeft + ax) / old, ry = (sc.scrollTop + ay) / old;
  S.zoom = z; lsSet('katam.ed.zoom', z);
  sizeCanvas();
  sc.scrollLeft = rx * z - ax; sc.scrollTop = ry * z - ay;
  $('#zoomsel').value = String(z);
  refreshStatus();
}

// ------------------------------------------------------------------- editing
const idx = (x, y) => y * S.room.W + x;
const inRoom = (x, y) => x >= 0 && y >= 0 && x < S.room.W && y < S.room.H;
function setCell(x, y, tok, col) {
  if (!inRoom(x, y)) return;
  const R = S.room, i = idx(x, y);
  if (tok !== null && R.art[i] !== tok) { R.art[i] = tok; drawCell(i); }
  if (col !== null) setCol(R, i, col);
}
/** Blocks that break: every such cell carries a record of what it turns into (`patches`). */
const isMech = (v) => /breakable|chain_/.test((S.vocab.collision[v] || {}).bits || '');
function setCol(R, i, v) {
  if (R.col[i] === v) return;
  R.col[i] = v;
  const P = R.doc.patches;
  if (P && P.length) { const x = i % R.W, y = (i / R.W) | 0, n = P.filter((q) => q.x !== x || q.y !== y); if (n.length !== P.length) R.doc.patches = n; }
}
function tendPatches(R) {
  const d = R.doc;
  let P = (d.patches || []).filter((q) => q.x < R.W && q.y < R.H);
  const count = new Map();
  for (const q of P) count.set(q.y * R.W + q.x, (count.get(q.y * R.W + q.x) || 0) + 1);
  const blank = dict(d.tileset).empty.split(' ');
  const becomes = (x, y) => (doorAt(R, x, y) >= 0 ? 'door' : 'air');
  for (let i = 0; i < R.col.length; i++) {
    if (!isMech(R.col[i])) continue;
    const x = i % R.W, y = (i / R.W) | 0, n = count.get(i) || 0;
    if (!n) P.push({ x, y, tiles: blank.slice(), collision: becomes(x, y) });
    else if (n === 1) { const q = P.find((e) => e.x === x && e.y === y); if (q.collision === 'door' || q.collision === 'air') q.collision = becomes(x, y); }
  }
  P.sort((a, b) => a.y - b.y || a.x - b.x);       // stable: several on one cell keep their order
  if (P.length) d.patches = P; else delete d.patches;
}
const MECH = [
  { id: 'break', name: 'breakable_0', label: 'Breakable block', tip: 'A block Kirby breaks by hitting or inhaling it. Paint it over a door to hide the door until the block is gone.' },
  { id: 'bomb', name: 'breakable_chain_trigger_1', label: 'Bomb block', tip: 'Break it and the explosion runs along every chain block and fuse that touches it, one after another.' },
  { id: 'chain', name: 'chain_solid', label: 'Chain block', tip: 'Solid, and cannot be broken by hand: it goes when a bomb block’s explosion reaches it. Paint it over terrain to keep how the terrain looks.' },
  { id: 'fuse', name: 'chain_gap', label: 'Fuse (empty)', tip: 'Empty space that carries the explosion on, so a bomb block can set off chain blocks that do not touch it.' },
];
const mechValue = (m) => { try { return S.ctx.collisionValue(m.name); } catch (e) { return -1; } };
/** The piece the original rooms use most for a kind of block in this tile set. */
function mechPiece(D, m) {
  const v = mechValue(m);
  let best = null;
  for (const e of D.list) if (e.col === v && e.tok !== D.empty && (!best || e.n > best.n)) best = e;
  return best ? best.tok : null;
}
function paintMech(R, D, x, y, m) {
  const i = idx(x, y), v = mechValue(m);
  let tok = m.id === 'fuse' ? null : mechPiece(D, m);
  if (!tok && m.id !== 'fuse' && R.art[i] === D.empty) tok = mechPiece(D, MECH[0]) || mechPiece(D, MECH[2]);   // nothing there to keep: show a block
  if (m.id === 'chain' && S.colClass[R.col[i]] !== 'air' && R.art[i] !== D.empty) tok = null;                    // a chain block hidden in the terrain
  setCell(x, y, tok, v);
}
/** Let the terrain brushes re-pick the pieces of `cells` and the ring around them. */
function retile(cells, want) {
  const R = S.room, D = dict(R.doc.tileset), set = new Set();
  for (const i of cells) {
    const x = i % R.W, y = (i / R.W) | 0;
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) if (inRoom(x + a, y + b)) set.add(idx(x + a, y + b));   // a piece depends on the shape two cells out
  }
  if (!R.src || R.src.length !== R.W * R.H) R.src = new Int32Array(R.W * R.H).fill(-1);   // which cell of the original each cell was copied from
  const changed = S.L.autotile.retile(D.model, { W: R.W, H: R.H, art: R.art, cls: R.col.map((v) => S.colClass[v]), col: R.col, src: R.src }, [...set], want || new Map(), S.salt);
  const marks = S.testMarks.get(R.id);
  for (const i of changed) { drawCell(i); if (marks) marks.delete(i); }
}
const kindValue = (kind) => (S.colRep[kind] !== undefined ? S.colRep[kind] : 13);
/** Put the current paint (or the eraser, or the collision brush) on a list of cells. */
function paintCells(list) {
  const R = S.room, D = dict(R.doc.tileset), touched = [], want = S.drag && S.drag.want ? S.drag.want : new Map();
  for (const [x, y] of list) {
    if (!inRoom(x, y)) continue;
    const i = idx(x, y);
    if (S.tool === 'collision') { setCol(R, i, S.colBrush); continue; }
    if (S.tool !== 'eraser' && S.paint.mech) { paintMech(R, D, x, y, S.paint.mech); continue; }
    if (S.tool === 'eraser') { if (R.art[i] !== D.empty || R.col[i] !== 0) { setCell(x, y, D.empty, 0); touched.push(i); } continue; }
    if (S.paint.style) { setCol(R, i, S.paint.slope !== undefined && S.paint.style.kind === 'solid' ? S.paint.slope : kindValue(S.paint.style.kind)); want.set(i, S.paint.style); touched.push(i); }
    else setCell(x, y, S.paint.tile, S.followCol ? S.tileCol : null);
  }
  if (touched.length) retile(touched, want);
}
function line(x0, y0, x1, y1) {
  const out = [], dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) { out.push([x0, y0]); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  return out;
}
function flood(x, y) {
  const R = S.room, from = R.art[idx(x, y)], fromCls = S.colClass[R.col[idx(x, y)]], solidLike = fromCls !== 'air';
  const seen = new Uint8Array(R.W * R.H), stack = [[x, y]], out = [];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (!inRoom(a, b)) continue;
    const i = idx(a, b);
    // terrain floods over its whole body (its pieces differ); scenery floods over one piece
    if (seen[i] || (solidLike ? S.colClass[R.col[i]] !== fromCls : R.art[i] !== from || S.colClass[R.col[i]] !== 'air')) continue;
    seen[i] = 1; out.push([a, b]);
    stack.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]);
  }
  paintCells(out);
}

const selected = () => (S.sel ? (S.sel.kind === 'object' ? S.room.doc.objects[S.sel.i] : S.room.doc.doors[S.sel.i]) : null);
function objectAt(px, py) {
  const o = S.room.doc.objects;
  for (let i = o.length - 1; i >= 0; i--) {
    const [bx, by, bw, bh] = objBox(o[i]);
    if ((px >= bx - 1 && py >= by - 1 && px <= bx + bw + 1 && py <= by + bh + 1) || (Math.abs(o[i].x - px) <= 8 && Math.abs(o[i].y - py) <= 8)) return i;
  }
  return -1;
}
const cellOfObj = (o) => [Math.floor(o.x / 16), Math.floor(o.y / 16)];
const doorAt = (R, x, y) => R.doc.doors.findIndex((d) => (d.cells || []).some((c) => c[0] === x && c[1] === y));
const isDoorType = (t) => t === 'door';
const doorObject = (R, x, y) => R.doc.objects.findIndex((o) => isDoorType(typeName(o)) && Math.floor(o.x / 16) === x && Math.floor(o.y / 16) === y);
/** The door link that belongs to a door object (same tile), or -1. */
const doorOf = (R, o) => (isDoorType(typeName(o)) ? doorAt(R, ...cellOfObj(o)) : -1);

function uniqueId(R, base) {
  const ids = new Set(R.doc.objects.map((o) => o.id));
  base = base.replace(/[^a-z0-9_]/g, '_');
  for (let n = 1; ; n++) { const id = n === 1 && !/\d$/.test(base) ? base : `${base.replace(/_?\d+$/, '')}_${n}`; if (!ids.has(id)) return id; }
}
function addObjectTo(R, type, x, y) {
  let m = 0;
  for (const o of R.doc.objects) m = Math.max(m, o.despawnBit || 0, (o.raw && o.raw.unk3) || 0);
  R.doc.objects.push(Object.assign({ id: uniqueId(R, type), type, x: x * 16 + 8, y: y * 16 + 8, despawnBit: m + 1 }, typeDefaults(type)));
  return R.doc.objects.length - 1;
}
/** What most placements of a type in the original game set: its channel and spawn flags. */
function typeDefaults(type) {
  if (!S.tdef) {
    const cnt = new Map();
    for (const [id, d] of S.vanilla.docs) {
      if (!id.startsWith('room:')) continue;
      for (const o of d.doc.objects || []) {
        const t = typeName(o);
        let e = cnt.get(t);
        if (!e) cnt.set(t, e = { n: 0, roomRegister: {}, spawnFlags: {} });
        e.n++;
        for (const k of ['roomRegister', 'spawnFlags']) if (o[k]) e[k][o[k]] = (e[k][o[k]] || 0) + 1;
      }
    }
    S.tdef = new Map();
    for (const [t, e] of cnt) {
      const out = {};
      for (const k of ['roomRegister', 'spawnFlags']) {
        const all = Object.entries(e[k]), sum = all.reduce((a, b) => a + b[1], 0);
        if (sum * 2 > e.n) out[k] = Number(all.sort((a, b) => b[1] - a[1])[0][0]);
      }
      S.tdef.set(t, out);
    }
  }
  return S.tdef.get(type) || {};
}
const LINKS = {
  small_button: 'A switch. While it is pressed, everything on its channel reacts. “Hold frames” keeps it down for a while after Kirby steps off.',
  vertical_sliding_door: 'A shutter. It is open while a switch on the same channel is pressed.',
  cannon_fuse: 'Light it with fire: when it has burned down, the cannon on the same channel fires.',
  cannon: 'Fires Kirby to another room when the fuse on the same channel has burned down.',
  jack: 'Leaves when the fuse on the same channel is lit.',
  lava_wall: 'Goes away when the large star block on the same channel is pushed into place.',
  large_star_stone_block_7e: 'Pushed into its slot, it clears its channel (see the lava wall).',
  large_star_stone_block_88: 'Pushed into its slot, it clears its channel (see the lava wall).',
  scroll_lock: 'Reads the same channels as the switches.',
  door: 'Only for the “session gated” kind: the door is shut while this slot is set.',
  big_button: 'A slot of the saved game, not of the room: pressing it opens the mirror door with the same number for good.',
  door_to_hub: 'Hidden until the big switch with the same number has been pressed (a slot of the saved game).',
  hub_mirror: 'Dormant until the big switch with the same number has been pressed (a slot of the saved game).',
};
const standable = (c) => c === 'solid' || c === 'platform' || c === 'slope' || c === 'breakable';
/** A free tile to stand on: air, something to stand on below, air above, in the camera's reach. */
function findSpot(R, near) {
  let best = null, bd = 1e9;
  const cls = (x, y) => S.colClass[R.col[y * R.W + x]];
  for (let y = 1; y < R.H - 1; y++) for (let x = 1; x < R.W - 1; x++) {
    if (cls(x, y) !== 'air' || cls(x, y - 1) !== 'air' || !standable(cls(x, y + 1)) || y + 1 > R.H - 3) continue;
    if (doorAt(R, x, y) >= 0 || R.doc.objects.some((o) => Math.floor(o.x / 16) === x && Math.floor(o.y / 16) === y)) continue;
    const d = near ? Math.abs(x - near[0]) + Math.abs(y - near[1]) : x + (R.H - y) * 0.1;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}
/** Where a door's `arrive` must point so Kirby comes out standing on tile (x, y). */
const arriveOn = (x, y) => ({ x: x + 1, y: y + 1 });
/** A door on tile (x, y) of room R: the link, the door collision, the door object. */
function addDoorTo(R, x, y, to, arrive) {
  R.doc.doors.push({ to, arrive, cells: [[x, y]] });
  if (!isMech(R.col[y * R.W + x])) setCol(R, y * R.W + x, S.colRep.door !== undefined ? S.colRep.door : 255);   // under a block that breaks, the door stays hidden until the block is gone
  if (doorObject(R, x, y) < 0) addObjectTo(R, 'door', x, y);
  return R.doc.doors.length - 1;
}
/**
 * Point door `di` of room R at `target`.  A door needs somewhere to come out
 * and, nearly always, a way back: if the target is one of the project's rooms
 * and has no door back, one is put there, and each door arrives at the other.
 */
function linkDoor(R, di, target) {
  const d = R.doc.doors[di], [cx, cy] = d.cells[0], tid = S.bind.resolve(target);
  d.to = tid;
  if (tid === R.id) { d.arrive = arriveOn(cx, cy); return 'This door leads back to itself for now: choose a room in “Leads to”.'; }
  return withRoom(tid, (T) => {
    let back = T.doc.doors.find((x) => S.bind.resolve(x.to) === R.id && x.cells && x.cells[0]);
    let msg = '';
    if (!back && !T.ro) {
      const spot = findSpot(T);
      if (spot) { back = T.doc.doors[addDoorTo(T, spot.x, spot.y, R.id, arriveOn(cx, cy))]; msg = `A door back was added in room ${T.num}.`; }
    }
    if (back) { d.arrive = arriveOn(back.cells[0][0], back.cells[0][1]); if (!T.ro) back.arrive = arriveOn(cx, cy); return msg; }
    const any = T.doc.doors.find((x) => x.cells && x.cells[0]), spot = any ? { x: any.cells[0][0], y: any.cells[0][1] } : findSpot(T) || { x: 2, y: Math.max(1, T.H - 4) };
    d.arrive = arriveOn(spot.x, spot.y);
    return T.ro ? `Room ${T.num} is a room of the original game: this door is one-way unless you edit that room too.` : '';
  });
}
function placeObject(type, x, y) {
  const R = S.room;
  if (isDoorType(type)) {
    if (doorAt(R, x, y) >= 0) return doorObject(R, x, y);
    const target = (S.lastRoom && mine(S.lastRoom) && S.lastRoom !== R.id && S.lastRoom) || roomIds().find((id) => id !== R.id) || R.id;
    const di = addDoorTo(R, x, y, target, arriveOn(x, y));
    const msg = linkDoor(R, di, target);
    toast(`Door to room ${numOf(target)}. ${msg} Change where it leads in the inspector.`, 5000);
    refreshMap();
    return doorObject(R, x, y);
  }
  return addObjectTo(R, type, x, y);
}
function moveObject(o, x, y) {
  const R = S.room, di = doorOf(R, o);
  if (di >= 0) {
    if (doorAt(R, x, y) >= 0) return;
    const [ox, oy] = cellOfObj(o), d = R.doc.doors[di];
    if (S.colClass[R.col[idx(ox, oy)]] === 'door') R.col[idx(ox, oy)] = 0;
    d.cells = [[x, y]]; R.col[idx(x, y)] = S.colRep.door !== undefined ? S.colRep.door : 255;
    // the door on the other side follows
    const tid = S.bind.resolve(d.to);
    if (tid && tid !== R.id && mine(tid)) withRoom(tid, (T) => { for (const b of T.doc.doors) if (S.bind.resolve(b.to) === R.id) b.arrive = arriveOn(x, y); });
  }
  o.x = x * 16 + 8; o.y = y * 16 + 8;
}
function removeDoorLink(R, di) {
  const d = R.doc.doors[di];
  for (const [x, y] of d.cells || []) if (x < R.W && y < R.H && S.colClass[R.col[y * R.W + x]] === 'door') R.col[y * R.W + x] = 0;
  R.doc.doors.splice(di, 1);
}
function deleteSelected() {
  const R = S.room, s = S.sel;
  if (!s || readOnly()) return;
  pushUndo();
  if (s.kind === 'object') {
    const o = R.doc.objects[s.i], di = doorOf(R, o);
    if (di >= 0) removeDoorLink(R, di);
    R.doc.objects.splice(s.i, 1);
  } else removeDoorLink(R, s.i);
  S.sel = null; touch(); refreshInspector(); refreshMap();
}

function setTool(t) {
  S.tool = t;
  $$('#tools .tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $('#cv').style.cursor = t === 'select' ? 'default' : 'crosshair';
  refreshLegend(); requestRender();
}

// pointer input: one finger / the mouse uses the tool, two fingers pan
const pointers = new Map();
function cellOf(e) {
  const r = $('#cv').getBoundingClientRect();
  const px = (e.clientX - r.left) / S.zoom, py = (e.clientY - r.top) / S.zoom;
  return { px, py, x: Math.floor(px / 16), y: Math.floor(py / 16) };
}
function onDown(e) {
  const cv = $('#cv'), sc = $('#scroll');
  document.body.classList.remove('side-open', 'bottom-open');
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  cv.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {           // a second finger: this is a pan, not a stroke
    if (S.drag && S.drag.changed) { restore(S.undo.pop()); refreshUndo(); }
    S.drag = { pan: true };
    return;
  }
  const p = cellOf(e), pan = () => { S.drag = { pan: true, mouse: [e.clientX, e.clientY, sc.scrollLeft, sc.scrollTop] }; };
  if (e.button === 1 || e.button === 2 || S.space) return pan();
  if (!inRoom(p.x, p.y)) return;
  if (S.pick) return finishPick(p.x, p.y);
  if (S.pv) { readOnly(); return; }
  const R = S.room;
  if (S.tool === 'select' || R.ro) {
    const [sx, sy] = startCell();
    const oi = S.show.objects ? objectAt(p.px, p.py) : -1, di = doorAt(R, p.x, p.y);
    if (oi >= 0) { S.sel = { kind: 'object', i: oi }; S.drag = R.ro ? {} : { move: 'object', first: true }; }
    else if (di >= 0) { S.sel = { kind: 'door', i: di }; S.drag = {}; }
    else if (p.x === sx && p.y === sy) { S.sel = null; S.drag = { move: 'start' }; }
    else if (R.ro && S.tool === 'eyedropper') { pickTile(p.x, p.y); }
    else { S.sel = null; pan(); }
    refreshInspector(); requestRender();
    return;
  }
  switch (S.tool) {
    case 'brush': case 'eraser': case 'collision':
      pushUndo(); S.drag = { paint: true, last: [p.x, p.y], changed: true, want: new Map() };
      paintCells([[p.x, p.y]]); touch();
      break;
    case 'rect': pushUndo(); S.drag = { rect: [p.x, p.y, p.x, p.y], changed: true, want: new Map() }; requestRender(); break;
    case 'fill': pushUndo(); flood(p.x, p.y); touch(); break;
    case 'eyedropper': pickTile(p.x, p.y); break;
    case 'object': {
      let oi = objectAt(p.px, p.py);
      const fresh = oi < 0;
      if (fresh) { pushUndo(); oi = placeObject(S.objType, p.x, p.y); touch(); }
      S.sel = oi >= 0 ? { kind: 'object', i: oi } : null;
      S.drag = { move: 'object', first: !fresh };
      refreshInspector(); requestRender();
      break;
    }
  }
}
function pickTile(x, y) {
  const R = S.room, i = idx(x, y), D = dict(R.doc.tileset), st = S.colClass[R.col[i]] !== 'air' ? D.model.styleOf.get(R.art[i]) : null;
  if (st) S.paint = { style: st };
  else { S.paint = { tile: R.art[i] }; S.tileCol = R.col[i]; }
  S.colBrush = R.col[i];
  setTool('brush'); refreshTab();
  toast(st ? `Picked the terrain brush “${styleLabel(st)}”.` : 'Picked this piece and its collision.');
}
function onMove(e) {
  const sc = $('#scroll');
  const prev = pointers.get(e.pointerId);
  if (prev && pointers.size === 2) {     // two-finger pan
    sc.scrollLeft -= (e.clientX - prev[0]) / 2; sc.scrollTop -= (e.clientY - prev[1]) / 2;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    return;
  }
  if (prev) pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const p = cellOf(e), d = S.drag;
  const hv = inRoom(p.x, p.y) ? [p.x, p.y] : null;
  if (!S.hover || !hv || S.hover[0] !== hv[0] || S.hover[1] !== hv[1]) { S.hover = hv; refreshStatus(); requestRender(); }
  if (!d || !prev) return;
  if (d.pan && d.mouse) { sc.scrollLeft = d.mouse[2] - (e.clientX - d.mouse[0]); sc.scrollTop = d.mouse[3] - (e.clientY - d.mouse[1]); return; }
  const x = clamp(p.x, 0, S.room.W - 1), y = clamp(p.y, 0, S.room.H - 1);
  if (d.paint) { if (x !== d.last[0] || y !== d.last[1]) { paintCells(line(d.last[0], d.last[1], x, y)); d.last = [x, y]; touch(); } }
  else if (d.rect) { d.rect[2] = x; d.rect[3] = y; requestRender(); }
  else if (d.move === 'object' && S.sel) {
    const o = selected();
    if (o && (Math.floor(o.x / 16) !== x || Math.floor(o.y / 16) !== y)) { if (d.first) { pushUndo(); d.first = false; } moveObject(o, x, y); touch(); refreshInspector(true); }
  } else if (d.move === 'start') { S.starts[S.room.id] = [x, y]; lsSet('katam.ed.starts', S.starts); requestRender(); }
}
function onUp(e) {
  pointers.delete(e.pointerId);
  const d = S.drag;
  if (pointers.size) return;
  if (d && d.rect) {
    const [x0, y0, x1, y1] = d.rect, list = [];
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) list.push([x, y]);
    S.tool = 'brush'; paintCells(list); S.tool = 'rect';
    touch();
  }
  S.drag = null;
  if (d && d.move === 'object') refreshMap();
  requestRender();
}

// ------------------------------------------------------------------ dialogs
function modal(title, body, actions) {
  const m = $('#modal');
  const close = () => { m.hidden = true; m.replaceChildren(); };
  setKids(m, h('div', { class: 'box' }, h('h2', null, title), body,
    h('div', { class: 'acts' }, actions.map((a) => h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), onclick: () => { if (!a.run || a.run() !== false) close(); } }, a.label)))));
  m.hidden = false;
  return close;
}
const confirmBox = (title, text, yes, run) => modal(title, h('p', null, text), [{ label: 'Cancel' }, { label: yes, danger: true, run }]);

const lookKey = (d) => d.tileset + '|' + d.palette + '|' + d.background;
const songLabel = (s) => (typeof s === 'number' ? 'song ' + s : nice(String(s).replace(/^(mus|se)_/, '')));
const lookPics = new Map();
/** One game screen (240 × 160) of the room a look comes from: the liveliest part of it. */
function lookPicture(l) {
  let cv = lookPics.get(l.key);
  if (cv) return cv;
  const d = S.vanilla.docs.get(l.id).doc, W = d.size.width, H = d.size.height, g = gfxFor(d), T = S.L.tiles;
  let art = [];
  try { art = S.L.grid.decodeGrid(d.art, W, H, 'art').map((s) => T.metaToken(T.metaValues(s))); } catch (e) { /* drawn empty */ }
  const empty = art.length ? [...art.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0][0] : '';
  const w = Math.min(15, W), hh = Math.min(10, H);
  let best = [0, Math.max(0, H - hh - 2)], bs = -1;
  for (let y = 0; y + hh <= H; y += 2) for (let x = 0; x + w <= W; x += 2) {
    const set = new Set(); let air = 0;
    for (let b = 0; b < hh; b++) for (let a = 0; a < w; a++) { const t = art[(y + b) * W + x + a]; if (t === empty) air++; else set.add(t); }
    const f = air / (w * hh), sc = set.size * (f > 0.3 && f < 0.8 ? 1 : 0.4) + (y + hh >= H - 2 ? 0.5 : 0);
    if (sc > bs) { bs = sc; best = [x, y]; }
  }
  const sub = [];
  for (let b = 0; b < hh; b++) for (let a = 0; a < w; a++) sub.push(art[(best[1] + b) * W + best[0] + a]);
  cv = artPicture(w, hh, sub, g);
  lookPics.set(l.key, cv);
  return cv;
}
/** Cards of the looks of one area, with pictures; `o.cur` is in use, `o.pv` is being tried. */
function lookPicker(o) {
  const all = looks(), areas = [...new Set(all.map((l) => l.area))];
  const curLook = all.find((l) => l.key === o.cur);
  if (!S.lookArea || !areas.includes(S.lookArea)) S.lookArea = curLook ? curLook.area : areas[0];
  const io = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); const l = all.find((x) => x.key === en.target.dataset.key), cv = en.target.firstChild; try { const pic = lookPicture(l); cv.width = pic.width; cv.height = pic.height; cv.getContext('2d').drawImage(pic, 0, 0); } catch (e) { console.warn('[editor] look picture:', e); } } });
  const cards = all.filter((l) => l.area === S.lookArea).map((l) => {
    const b = h('button', { class: 'look' + (l.key === o.cur ? ' on' : '') + (l.key === o.pv ? ' pv' : ''), 'data-key': l.key, disabled: !!o.disabled, title: `${l.label}. Music: ${songLabel(l.music)}`, onclick: () => o.pick(l) },
      h('canvas', { width: 240, height: 160 }), h('span', null, `like room ${l.room}`), h('small', null, l.key === o.cur ? 'in use' : l.key === o.pv ? 'trying it' : `${l.n} room${l.n > 1 ? 's' : ''}`));
    io.observe(b);
    return b;
  });
  return [h('div', { class: 'form' }, h('label', null, 'Area'), h('select', { onchange: (e) => { S.lookArea = e.target.value; o.redraw(); } }, areas.map((a) => h('option', { value: a, selected: a === S.lookArea }, nice(a))))),
    h('div', { class: 'looks' }, cards)];
}
/** The room's art under another look: kept when the tile set is the same, else the terrain is painted again from the collision. */
function lookArt(R, l) {
  if (l.tileset === R.doc.tileset) return R.art;
  const D = dict(l.tileset), A = S.L.autotile, n = R.W * R.H;
  const art = new Array(n).fill(D.empty), cls = R.col.map((v) => S.colClass[v]), want = new Map(), cells = [];
  const by = (kind) => D.styles.find((s) => s.kind === kind);
  const solid = by('solid');
  for (let i = 0; i < n; i++) {
    cells.push(i);
    if (cls[i] === 'air' || cls[i] === 'door') continue;
    if (isMech(R.col[i])) { const m = MECH.find((x) => mechValue(x) === R.col[i]) || MECH[0]; art[i] = (m.id === 'fuse' ? null : mechPiece(D, m) || mechPiece(D, MECH[0])) || D.empty; continue; }
    const st = by(A.kindOf ? A.kindOf(cls[i]) : cls[i]) || (cls[i] === 'slope' ? solid : null);
    if (st) want.set(i, st);
  }
  A.retile(D.model, { W: R.W, H: R.H, art, cls, col: R.col.slice() }, cells, want, S.salt);
  return art;
}
function previewLook(l) {
  const R = S.room;
  if (R.ro) { readOnly(); return; }
  cancelLookPreview(true);
  const d = R.doc;
  if (l.key !== lookKey(d)) {
    flush();
    let art;
    try { art = lookArt(R, l); } catch (e) { console.error(e); toast('This look could not be tried: ' + e.message, 6000); refreshTab(); return; }
    S.pv = { look: l, music: false, save: { tileset: d.tileset, palette: d.palette, background: d.background, art: R.art } };
    d.tileset = l.tileset; d.palette = l.palette; d.background = l.background; R.art = art;
    loadGfx(); redrawArt();
  }
  refreshPvBar(); refreshTab(); requestRender();
  document.body.classList.remove('side-open');
}
function cancelLookPreview(quiet) {
  if (!S.pv) return;
  const R = S.room, d = R.doc, s = S.pv.save;
  d.tileset = s.tileset; d.palette = s.palette; d.background = s.background; R.art = s.art;
  S.pv = null;
  loadGfx(); redrawArt(); refreshPvBar();
  if (!quiet) { refreshTab(); requestRender(); }
}
function applyLook() {
  const pv = S.pv;
  if (!pv) return;
  const R = S.room, d = R.doc, art = R.art, l = pv.look;
  cancelLookPreview(true);
  pushUndo();
  d.tileset = l.tileset; d.palette = l.palette; d.background = l.background; R.art = art; R.src = null;
  if (pv.music) d.music = l.music;
  if (d.patches && l.tileset !== pv.save.tileset) { const blank = dict(l.tileset).empty.split(' '); for (const q of d.patches) q.tiles = blank.slice(); }   // art of another tile set
  S.paint = null; loadGfx(); fixPaint(); redrawArt();
  R.dirty = true; flush(); validateSoon(); refreshAll();
  toast('The room has its new look. Undo brings the old one back.', 4000);
}
function refreshPvBar() {
  const bar = $('#pvbar'), pv = S.pv;
  bar.hidden = !pv;
  if (!pv) return;
  const same = pv.look.tileset === pv.save.tileset, d = S.room.doc;
  setKids(bar, h('span', null, h('b', null, `Trying the look of room ${pv.look.room} (${nice(pv.look.area)}). `), same ? 'Same tiles: only the colours and the backdrop change.' : 'Other tiles: the ground is painted again from the room’s shape, and decoration you placed by hand is not carried over.'),
    h('span', { class: 'grow' }),
    String(pv.look.music) !== String(d.music) ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: pv.music, onchange: (e) => { pv.music = e.target.checked; } }), h('span', null, `and its music (${songLabel(pv.look.music)})`)) : null,
    h('button', { class: 'btn primary', onclick: applyLook }, '✓ Use this look'),
    h('button', { class: 'btn', onclick: () => cancelLookPreview() }, 'Cancel'));
}

// The music preview plays through the game itself (the play frame, out of
// sight): only its sound driver runs, so this is the song as the room plays it.
const M = { song: null, state: '' };
const songNumber = (s) => (typeof s === 'number' ? s : S.vocab.songs[s]);
function sendSong() {
  if (!P.frame || !P.ready || M.song === null || M.state !== 'loading') return;
  P.frame.contentWindow.postMessage({ katamEd: 1, type: 'music', song: songNumber(M.song) }, location.origin);
}
function toggleSong(s) {
  if (M.song !== null && String(M.song) === String(s)) { stopSong(); return; }
  if (songNumber(s) === undefined) { toast('This song has no number to play.'); return; }
  if (!P.frame) prewarm();
  if (!P.frame) { toast(S.romStored ? 'The preview plays through the game, which cannot start while the project has errors: see the Validation list.' : 'The preview plays through the game, which needs the ROM kept in this browser.', 6000); return; }
  M.song = s; M.state = 'loading';
  sendSong(); refreshSongs();
}
function stopSong(quiet) {
  if (M.song === null) return;
  M.song = null; M.state = '';
  if (P.frame && P.ready) P.frame.contentWindow.postMessage({ katamEd: 1, type: 'music', song: -1 }, location.origin);
  if (!quiet) refreshSongs();
}
function refreshSongs() {
  const box = $('#songs');
  if (!box) return;
  const R = S.room, d = R.doc, songs = Object.keys(S.vocab.songs).filter((s) => s.startsWith('mus_') && s !== 'mus_dummy');
  if (d.music !== undefined && !songs.some((s) => String(s) === String(d.music))) songs.unshift(d.music);
  setKids(box, songs.map((s) => {
    const cur = String(s) === String(d.music), on = M.song !== null && String(M.song) === String(s);
    return h('div', { class: 'song' + (cur ? ' on' : '') + (on ? ' playing' : '') },
      h('button', { class: 'btn icon', title: on ? 'Stop' : 'Listen', 'aria-label': on ? 'Stop' : 'Listen', onclick: () => toggleSong(s) }, on ? (M.state === 'loading' ? '…' : '■') : '▶'),
      h('b', null, songLabel(s)),
      cur ? h('span', { class: 'tag' }, 'in use') : h('button', { class: 'btn tiny', disabled: R.ro, onclick: () => { if (readOnly()) return; pushUndo(); d.music = s; touch(); refreshSongs(); } }, 'Use'));
  }));
}

/** The Room tab: this room's name, size, look and music. */
function roomTab(body) {
  const R = S.room, d = R.doc, ro = R.ro, keepScroll = ($('.scrolly', body) || {}).scrollTop || 0;
  const name = h('input', { type: 'text', value: d.name || '', maxlength: 40, disabled: ro, onchange: (e) => { if (readOnly()) return; pushUndo(); d.name = e.target.value.trim() || d.name; touch(); refreshRooms(); refreshMap(); } });
  const w = h('input', { type: 'number', min: 15, max: 190, value: R.W, disabled: ro }), hh = h('input', { type: 'number', min: 13, max: 120, value: R.H, disabled: ro });
  const anchor = h('select', { disabled: ro }, h('option', { value: 'top' }, 'rows are added / removed at the top'), h('option', { value: 'bottom' }, 'rows are added / removed at the bottom'));
  const resize = () => {
    if (readOnly()) return;
    const W = clamp(Number(w.value) | 0, 15, 190), H = clamp(Number(hh.value) | 0, 13, 120);
    if (W * H > 1950) { toast(`${W} × ${H} is ${W * H} tiles; the game holds 1950 per room.`); return; }
    if (W === R.W && H === R.H) return;
    pushUndo(); resizeRoom(W, H, anchor.value);
    R.dirty = true; flush(); rebind(); openRoom(R.id, { keepUndo: true }); validateSoon();
  };
  const cur = S.pv ? lookKey(S.pv.save) : lookKey(d), curLook = looks().find((l) => l.key === cur);
  const songs = h('div', { class: 'songs', id: 'songs' });
  setKids(body, h('div', { class: 'scrolly' },
    h('div', { class: 'sec' }, `Room ${R.num}`),
    h('div', { class: 'form' },
      h('label', null, 'Name'), name,
      h('label', null, 'Size'), h('div', { class: 'row' }, w, '×', hh, h('button', { class: 'btn tiny', disabled: ro, onclick: resize }, 'Resize')),
      h('span'), anchor),
    h('p', { class: 'dim', style: 'margin:4px 0 0' }, `In tiles of 16 px; a game screen is 15 × 10, and a room is at least 15 × 13. New columns are added on the right. Now ${R.W * R.H} of 1950 tiles.`),
    h('div', { class: 'sec', style: 'margin-top:12px' }, 'Look'),
    h('p', { class: 'dim', style: 'margin:0 0 6px' }, ro ? 'The tiles, colours and backdrop of this room.' : `Tiles, colours and backdrop, as rooms of the original game combine them. Tap one to try it on your room; nothing changes until you choose “Use this look”.${curLook ? '' : ' This room has a combination of its own.'}`),
    lookPicker({ cur, pv: S.pv ? S.pv.look.key : null, disabled: ro, pick: previewLook, redraw: refreshTab }),
    h('div', { class: 'sec', style: 'margin-top:12px' }, 'Music'),
    h('p', { class: 'dim', style: 'margin:0 0 6px' }, '▶ plays a song through the game; “Use” gives it to this room.'),
    songs,
    ro ? null : h('button', { class: 'btn danger', style: 'margin-top:12px', onclick: deleteRoomDialog }, d.bind ? 'Discard my changes to this room' : 'Delete this room')));
  refreshSongs();
  $('.scrolly', body).scrollTop = keepScroll;
}
function showRoomTab() { setTab('room'); document.body.classList.remove('bottom-open'); document.body.classList.add('side-open'); }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'room';
function namespace() {
  const own = roomIds().find((id) => !roomDoc(id).bind);
  if (own) return areaOf(own);
  return slug(((S.proj.project && S.proj.project.id) || 'my_levels').split('.').pop());
}

function newRoomDialog() {
  const cur = S.room ? S.room.doc : null;
  const name = h('input', { type: 'text', value: 'New room', maxlength: 40 });
  const w = h('input', { type: 'number', min: 15, max: 190, value: 30 }), hh = h('input', { type: 'number', min: 13, max: 120, value: 14 });
  let chosen = (cur && looks().find((l) => l.key === lookKey(cur))) || looks().find((l) => l.area === 'rainbow_route') || looks()[0];
  S.lookArea = chosen.area;
  const box = h('div', { class: 'lookbox' });
  const draw = () => setKids(box, lookPicker({ cur: chosen.key, pick: (l) => { chosen = l; draw(); }, redraw: () => draw() }));
  draw();
  modal('New room', h('div', null, h('div', { class: 'form' },
    h('label', null, 'Name'), name,
    h('label', null, 'Size'), h('div', { class: 'row' }, w, '×', hh, h('span', { class: 'dim' }, 'tiles (16 px each)'))),
    h('p', { class: 'dim', style: 'margin:8px 0 4px' }, 'Pick a look: the tiles, colours, backdrop and music of a room of the original game. You can change it later in the Room tab. The room starts with a floor.'),
    box),
  [{ label: 'Cancel' }, { label: 'Create room', primary: true, run: () => {
    const W = clamp(Number(w.value) | 0, 15, 190), H = clamp(Number(hh.value) | 0, 13, 120);
    if (W * H > 1950) { toast(`${W} × ${H} is ${W * H} tiles; the game holds 1950 per room.`); return false; }
    createRoom(name.value.trim() || 'New room', W, H, chosen);
  } }]);
  name.select();
}
/** The id for a new room of the project.  New rooms are numbered in the order of their ids (983 and
 *  up), so a new id must sort after the project's others or every later room would renumber. */
function newRoomId(name) {
  const ns = namespace(), own = roomIds().filter((r) => !roomDoc(r).bind).map((r) => r.split('/').pop());
  const pre = own.some((n) => !/^r\d{3}_/.test(n) && n > 'r') ? 'z' : 'r';
  let k = 1;
  for (const n of own) { const m = new RegExp('^' + pre + '(\\d{3})_').exec(n); if (m) k = Math.max(k, Number(m[1]) + 1); }
  return `room:${ns}/${pre}${String(k).padStart(3, '0')}_${slug(name)}`;
}
function createRoom(name, W, H, lk) {
  flush();
  const id = newRoomId(name);
  const D = dict(lk.tileset), A = S.L.autotile, G = S.L.grid;
  const art = new Array(W * H).fill(D.empty), col = new Array(W * H).fill(0), cells = [], want = new Map();
  const st = D.styles.find((x) => x.kind === 'solid');
  for (let y = H - 4; y < H; y++) for (let x = 0; x < W; x++) { col[y * W + x] = 13; cells.push(y * W + x); if (st) want.set(y * W + x, st); }
  if (st) A.retile(D.model, { W, H, art, cls: col.map((v) => S.colClass[v]), col }, cells.concat(cells.map((i) => i - W)), want, S.salt);
  else { const f = D.list.find((e) => e.cls === 'solid'); if (f) for (const i of cells) art[i] = f.tok; }
  const doc = {
    format: 'katam-room/1', id, name, size: { width: W, height: H }, music: lk.music, tileset: lk.tileset, palette: lk.palette, background: lk.background,
    art: G.encodeGrid(art, W, H, { suggest: (m) => (m === D.empty ? '.' : null) }),
    collision: G.encodeGrid(col, W, H, { suggest: (v) => S.ctx.collisionGlyph(v), toLegend: (v) => S.ctx.collisionName(v) }),
    objects: [], doors: [],
  };
  ensureProjectFile();
  S.io.writeText(projPath(id), S.L.json.writeJson(doc));
  rebind(); openRoom(id); validateSoon();
  toast(`Room ${numOf(id)} created. Paint with the terrain brush, then place a door to connect it.`, 5000);
}

/**
 * The topology test level for a brush (lib/brushtest.mjs): a new room in the current room's look with
 * every shape the brush's kind can meet -- for ground, the 47 ways a cell sits among its neighbours and
 * the slope joins -- painted with the brush.  Cells where the brush has no piece of that shape are
 * marked until repainted: yellow, its own piece of the nearest shape; red, another brush's piece.
 */
function createTestRoom(st) {
  const look = S.room.doc, D = dict(look.tileset), G = S.L.grid;
  const base = D.styles.find((x) => x.kind === 'solid');
  const T = S.L.brushtest.paintTest(D.model, st, { colOf: (k) => (k === 'air' ? 0 : kindValue(k)), classOf: (v) => S.colClass[v], base: base === st ? null : base, salt: S.salt });
  if (!T) { toast('There is no test level for this kind of brush.'); return; }
  flush();
  const id = newRoomId('Test ' + st.name);
  const doc = {
    format: 'katam-room/1', id, name: `Test: ${st.name}`, size: { width: T.W, height: T.H }, music: look.music, tileset: look.tileset, palette: look.palette, background: look.background,
    art: G.encodeGrid(T.art, T.W, T.H, { suggest: (m) => (m === D.empty ? '.' : null) }),
    collision: G.encodeGrid(T.col, T.W, T.H, { suggest: (v) => S.ctx.collisionGlyph(v), toLegend: (v) => S.ctx.collisionName(v) }),
    objects: [], doors: [],
  };
  ensureProjectFile();
  S.io.writeText(projPath(id), S.L.json.writeJson(doc));
  rebind(); openRoom(id); validateSoon();
  S.room.src = Int32Array.from(T.src);
  const marks = new Map();
  T.how.forEach((h, i) => { if (h === 'near' || h === 'borrowed') marks.set(i, h); });
  S.testMarks.set(id, marks);
  render();
  const r = T.report, slopes = st.kind === 'solid' ? ` and ${r.slopes.own} of ${r.slopes.level} slopes` : '';
  toast(`Test level for “${st.name}”: its own pieces for ${r.shapes.own} of the ${r.shapes.level} shapes${slopes}. Yellow: ${r.cells.near} cells use its nearest shape; red: ${r.cells.borrowed} take another brush’s piece.`, 9000);
}

/** Bring a room of the original game into the project: as itself (it replaces the original) or as a new room. */
function adoptOriginal(vid, asCopy) {
  flush();
  const src = JSON.parse(S.io.readText(S.vanilla.docs.get(vid).abs)), n = src.bind && src.bind.roomId;
  let id = vid;
  if (asCopy) {
    const ns = namespace();
    id = `room:${ns}/copy_${n}`;
    for (let k = 2; S.bind.docs.has(id); k++) id = `room:${ns}/copy_${n}_${k}`;
    delete src.bind; delete src.nav; delete src.fgLayerRoomTag;
    src.id = id; src.name = `Copy of room ${n}`;
  }
  ensureProjectFile();
  S.io.writeText(projPath(id), S.L.json.writeJson(src));
  rebind(); openRoom(id); validateSoon();
  toast(asCopy ? `Room ${numOf(id)} is a copy of room ${n}. Its doors still lead to the original rooms.` : `Room ${n} is now part of your project: your version replaces the original when you play.`, 5000);
}

function resizeRoom(W, H, anchor) {
  const R = S.room, D = dict(R.doc.tileset), dy = anchor === 'top' ? H - R.H : 0;
  const art = new Array(W * H).fill(D.empty), col = new Array(W * H).fill(0);
  for (let y = 0; y < R.H; y++) for (let x = 0; x < Math.min(W, R.W); x++) {
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    art[ny * W + x] = R.art[y * R.W + x]; col[ny * W + x] = R.col[y * R.W + x];
  }
  const d = R.doc;
  d.objects = d.objects.map((o) => ({ ...o, y: o.y + dy * 16 })).filter((o) => o.x < W * 16 && o.y >= 0 && o.y < H * 16);
  d.doors = d.doors.map((r) => ({ ...r, cells: (r.cells || []).map(([x, y]) => [x, y + dy]) })).filter((r) => r.cells.every(([x, y]) => x < W && y >= 0 && y < H));
  if (d.patches) d.patches = d.patches.map((q) => ({ ...q, y: q.y + dy })).filter((q) => q.x < W && q.y >= 0 && q.y < H);
  if (dy) for (const id of roomIds()) {       // doors elsewhere that arrive here move with the rows
    if (id === R.id) continue;
    withRoom(id, (T) => { for (const r of T.doc.doors) if (S.bind.resolve(r.to) === R.id && r.arrive) r.arrive.y = clamp(r.arrive.y + dy, 0, H - 1); });
  }
  delete d.nav;
  if (S.starts[R.id]) { S.starts[R.id][1] += dy; lsSet('katam.ed.starts', S.starts); }
  R.W = W; R.H = H; R.art = art; R.col = col;
}
function deleteRoomDialog() {
  const R = S.room, orig = !!R.doc.bind;
  if (!orig && roomIds().length < 2) { toast('A project needs at least one room.'); return; }
  setTimeout(() => confirmBox(orig ? 'Discard your changes to this room?' : 'Delete this room?',
    orig ? `Room ${R.num} goes back to the way the original game has it.` : `Room ${R.num} (${R.doc.name || R.id}) will be removed from the project. Doors that lead to it will need a new target.`,
    orig ? 'Discard changes' : 'Delete room', () => {
      S.io.files.delete(R.path); S.room = null; rebind();
      const ids = roomIds();
      if (!ids.length) { putExample(); rebind(); }
      openRoom(roomIds()[0]); validateSoon(); persist();
    }), 0);
}

// -------------------------------------------------------------- side panels
function buildTools() {
  const T = [['select', 'Select'], ['brush', 'Brush'], ['rect', 'Rectangle'], ['fill', 'Fill'], ['eraser', 'Eraser'], ['collision', 'Collision Brush'], ['object', 'Place Object'], ['eyedropper', 'Eyedropper']];
  setKids($('#tools'),
    T.map(([id, label]) => h('button', { class: 'tool', 'data-tool': id, title: label, 'aria-label': label, html: ico(id) + label, onclick: () => { setTool(id); if (id === 'object') setTab('objects'); if (id === 'brush' || id === 'rect' || id === 'fill') setTab('tiles'); } })),
    h('span', { class: 'gap' }),
    h('button', { class: 'tool sub', title: 'Layers', html: ico('layers') + 'Layers', onclick: (e) => openMenu(e.currentTarget, 'view') }),
    h('button', { class: 'tool sub', title: 'Area Map', html: ico('map') + 'Area Map', onclick: () => { document.body.classList.toggle('bottom-open'); $('#areamap').scrollIntoView({ block: 'nearest' }); } }));
}

function setTab(t) {
  if (S.tab === 'room' && t !== 'room') stopSong(true);
  S.tab = t; S.search = '';
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  refreshTab();
}
/** A collapsible branch of a palette tree; its content is built when first opened. */
function tree(key, label, count, build, swatch) {
  const body = h('div');
  const fill = () => { if (!body.childNodes.length) setKids(body, build()); };
  const d = h('details', { class: 'tree', open: S.openGroups.has(key), ontoggle: (e) => {
    if (e.target.open) { S.openGroups.add(key); fill(); } else S.openGroups.delete(key);
    lsSet('katam.ed.groups', [...S.openGroups]);
  } }, h('summary', null, swatch || null, label, h('small', null, count)), body);
  if (S.openGroups.has(key)) fill();
  return d;
}
function styleSwatch(D, st) {
  const A = S.L.autotile, sm = A.sample(D.model, st, 5, 3);
  const cv = h('canvas', { width: sm.W * 16, height: sm.H * 16 }), c = cv.getContext('2d');
  sm.art.forEach((t, i) => c.drawImage(metaCanvas(t), (i % sm.W) * 16, ((i / sm.W) | 0) * 16));
  return h('button', { class: 'style' + (S.paint && S.paint.style === st ? ' on' : ''), title: `${styleLabel(st)}: paint, and the edges, corners and fill come by themselves`, onclick: () => { S.paint = { style: st }; if (!['brush', 'rect', 'fill'].includes(S.tool)) setTool('brush'); refreshTab(); } }, cv, styleLabel(st));
}
function mechSwatch(D, m) {
  const cv = h('canvas', { width: 48, height: 32 }), c = cv.getContext('2d'), tok = mechPiece(D, m) || (m.id === 'fuse' ? null : mechPiece(D, MECH[0]));
  c.imageSmoothingEnabled = false;
  if (tok) c.drawImage(metaCanvas(tok), 8, 0, 32, 32);
  c.translate(24, 16);
  if (m.id === 'bomb') { c.fillStyle = '#ff3b30'; c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 8, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#fff'; c.fillRect(-1.500, -5.500, 3, 6.500); c.fillRect(-1.500, 2.500, 3, 3); }
  else if (m.id === 'chain' || m.id === 'fuse') { c.strokeStyle = '#ff9f0a'; c.lineWidth = 3; c.setLineDash(m.id === 'fuse' ? [4, 3] : []); c.beginPath(); c.moveTo(0, -8); c.lineTo(8, 0); c.lineTo(0, 8); c.lineTo(-8, 0); c.closePath(); c.stroke(); }
  return h('button', { class: 'style' + (S.paint && S.paint.mech === m ? ' on' : ''), title: m.tip, onclick: () => { S.paint = { mech: m }; if (!['brush', 'rect', 'fill'].includes(S.tool)) setTool('brush'); refreshTab(); requestRender(); } }, cv, m.label);
}
function pieceGrid(D, list) {
  const shown = list.slice(0, 240);
  return [h('div', { class: 'tilegrid' }, shown.map((e) => {
    const cv = h('canvas', { width: 16, height: 16, class: S.paint && S.paint.tile === e.tok ? 'on' : '', title: `${CLASS_LABEL[e.cls]} · used ${e.n}× in the original game` });
    cv.getContext('2d').putImageData(metaImage(e.tok), 0, 0);
    cv.onclick = () => { S.paint = { tile: e.tok }; S.tileCol = e.col; if (!['brush', 'rect', 'fill'].includes(S.tool)) setTool('brush'); refreshTab(); };
    return cv;
  })), list.length > shown.length ? h('p', { class: 'dim' }, `The ${shown.length} most used of ${list.length}.`) : null];
}
function refreshTab() {
  const body = $('#tabbody'), R = S.room;
  if (S.tab === 'tiles') {
    const D = dict(R.doc.tileset), keepScroll = ($('.scrolly', body) || {}).scrollTop || 0;
    const used = new Set(R.art);
    const inRoomList = [...used].map((t) => D.map.get(t) || { tok: t, n: 0, col: 0, cls: 'air' }).sort((a, b) => b.n - a.n);
    const pieces = GROUPS.map(([cls, label]) => {
      const list = D.list.filter((e) => e.cls === cls && e.tok !== D.empty);
      const col = CLASS_COLOR[cls];
      return list.length ? tree('p:' + cls, label, list.length, () => pieceGrid(D, list), h('i', { style: col ? `background:rgb(${col})` : 'background:#6fb6ff' })) : null;
    });
    let info;
    if (S.paint && S.paint.style) {
      const st = S.paint.style;
      info = h('div', { class: 'tileinfo' }, styleSwatch(D, st).firstChild, h('b', null, `Terrain brush · ${styleLabel(st)}`),
        h('span', { class: 'dim' }, `Edges, corners and fill are copied from how the original rooms build this material (${st.tokens.size} pieces).`),
        st.kind === 'solid' ? h('div', { class: 'row', style: 'display:flex;gap:4px;flex-wrap:wrap' }, [{ value: undefined, label: 'Flat' }].concat(S.L.autotile.SLOPES).map((sl) =>
          h('button', { class: 'btn tiny' + (S.paint.slope === sl.value ? ' on' : ''), title: sl.value === undefined ? 'Paint solid ground' : `Paint ground with this slope (${sl.label})`, onclick: () => { S.paint = { style: st, slope: sl.value }; refreshTab(); } }, sl.label))) : null,
        h('div', { class: 'row', style: 'display:flex;gap:6px' }, h('button', { class: 'btn tiny', title: 'Pick a different random fill for the whole room', onclick: shuffleFill }, '🎲 Shuffle the fill'),
          S.L.brushtest.LEVELS[st.kind] ? h('button', { class: 'btn tiny', title: 'A new room with every shape this brush can meet (for ground: the 47 ways a cell sits among its neighbours, and the slope joins), painted with it. Yellow marks: it has no piece of that shape and uses its nearest; red: another brush’s piece.', onclick: () => createTestRoom(st) }, '🧪 Test level') : null));
    } else if (S.paint && S.paint.mech) {
      const m = S.paint.mech;
      info = h('div', { class: 'tileinfo' }, mechSwatch(D, m).firstChild, h('b', null, m.label), h('span', { class: 'dim' }, m.tip),
        h('span', { class: 'dim' }, 'Turn on “Show collision” to see the marks: ! is a bomb block, a diamond a chain block, a dotted diamond a fuse.'));
    } else {
      const tok = S.paint.tile, e = D.map.get(tok);
      const pv = h('canvas', { width: 16, height: 16 }); pv.getContext('2d').putImageData(metaImage(tok), 0, 0);
      info = h('div', { class: 'tileinfo' }, pv, h('b', null, `One piece · ${CLASS_LABEL[S.colClass[S.tileCol]]}`),
        h('span', { class: 'dim' }, `16 × 16 px${e ? ` · used ${e.n}× in the original game` : ''}`),
        h('div', { class: 'form' }, h('label', null, 'Collision:'), collisionSelect(S.tileCol, (v) => { S.tileCol = v; refreshTab(); }),
          h('label', { class: 'chk wide' }, h('input', { type: 'checkbox', checked: S.followCol, onchange: (ev) => { S.followCol = ev.target.checked; } }), h('span', null, 'Paint the collision with the piece'))));
    }
    setKids(body, h('div', { class: 'scrolly' },
      h('div', { class: 'sec' }, 'Terrain brushes'),
      D.styles.length ? h('div', { class: 'styles' }, D.styles.map((st) => styleSwatch(D, st))) : h('p', { class: 'dim' }, 'This tile set has no terrain the editor could learn. Use single pieces below.'),
      h('div', { class: 'sec', style: 'margin-top:10px' }, 'Blocks that break'),
      h('div', { class: 'styles' }, MECH.filter((m) => mechValue(m) >= 0).map((m) => mechSwatch(D, m))),
      h('div', { class: 'sec', style: 'margin-top:10px' }, 'Single pieces'),
      tree('p:used', 'In this room', inRoomList.length, () => pieceGrid(D, inRoomList), h('i', { style: 'background:#fff' })),
      pieces), info);
    $('.scrolly', body).scrollTop = keepScroll;
  } else if (S.tab === 'room') {
    roomTab(body);
  } else if (S.tab === 'objects') {
    const q = S.search.toLowerCase(), keepScroll = ($('.scrolly', body) || {}).scrollTop || 0;
    const known = new Set(CAT_GROUPS.map((g) => g[0]));
    const groups = CAT_GROUPS.map(([cat, label]) => {
      const list = [...S.objInfo].filter(([n, i]) => !/^(empty|unk|unused)/.test(n) && (i.category === cat || (cat === 'other' && !known.has(i.category)))
        && (!q || n.includes(q) || nice(n).includes(q))).sort((a, b) => a[1].num - b[1].num);
      if (!list.length) return null;
      const grid = () => h('div', { class: 'objgrid' }, list.map(([n, i]) => h('button', { class: 'obj' + (n === S.objType ? ' on' : ''), title: i.description || nice(n), onclick: () => { S.objType = n; setTool('object'); refreshTab(); } }, typeIcon(n), h('span', null, nice(n)))));
      if (q) return [h('div', { class: 'sec' }, label), grid()];
      return tree('o:' + cat, label, list.length, grid);
    });
    const search = h('input', { type: 'search', placeholder: 'Search…', value: S.search, oninput: (e) => { S.search = e.target.value; refreshTab(); const s = $('#tabbody input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
    setKids(body, search, h('div', { class: 'scrolly' }, groups), h('p', { class: 'dim', style: 'margin:0' }, 'Pick one, then tap the room; drag to move it. A door is an object: place it, then choose where it leads in the inspector. Switches and shutters work together when they share a channel.'));
    $('.scrolly', body).scrollTop = keepScroll;
    if (!q && !groups.some((g) => g && g.open)) { const first = groups.find(Boolean); if (first) first.open = true; }
  } else {
    const areas = [...new Set(vanillaIds().map(areaOf))];
    if (!S.browseArea) S.browseArea = areas.includes('rainbow_route') ? 'rainbow_route' : areas[0];
    const asel = h('select', { onchange: (e) => { S.browseArea = e.target.value; refreshTab(); } }, areas.map((a) => h('option', { value: a, selected: a === S.browseArea }, nice(a))));
    const list = vanillaIds().filter((id) => areaOf(id) === S.browseArea);
    const io = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) { io.unobserve(en.target); const pic = roomPicture(en.target.dataset.id); en.target.replaceChild(pic, en.target.firstChild); } }, { root: body });
    const grid = h('div', { class: 'thumbgrid' }, list.map((id) => {
      const t = h('div', { class: 'thumb' + (id === R.id ? ' on' : ''), 'data-id': id, title: 'Look at this room', onclick: () => openRoom(id) }, h('canvas', { width: 8, height: 8 }), 'Room ' + numOf(id) + (mine(id) ? ' ✎' : ''));
      io.observe(t);
      return t;
    }));
    setKids(body, h('div', { class: 'scrolly' },
      h('div', { class: 'sec' }, 'My rooms', h('button', { class: 'btn tiny', onclick: newRoomDialog }, '+ New room')),
      roomIds().map((id) => h('div', { class: 'roomrow' + (id === R.id ? ' on' : ''), onclick: () => openRoom(id) }, h('b', null, 'Room ' + roomLabel(id)), h('span', { class: 'dim' }, (() => { const d = roomDoc(id); return `${d.size.width} × ${d.size.height}`; })()))),
      h('button', { class: 'btn', style: 'margin-top:6px', onclick: examplesDialog }, 'Example projects…'),
      h('div', { class: 'sec', style: 'margin-top:10px' }, 'The original game'),
      h('p', { class: 'dim', style: 'margin:0 0 6px' }, 'Look around for ideas, copy a room to start from, or edit one to put a door to your rooms in it: the game starts in the original rooms.'),
      h('div', { class: 'form', style: 'margin-bottom:6px' }, h('label', null, 'Area'), asel), grid));
  }
}
function shuffleFill() {
  if (readOnly()) return;
  const R = S.room;
  pushUndo(); S.salt = (S.salt * 7919 + 13) % 100003;
  const cells = [];
  for (let i = 0; i < R.col.length; i++) if (S.colClass[R.col[i]] !== 'air') cells.push(i);
  retile(cells); touch();
}
function collisionSelect(cur, onchange) {
  const sel = h('select', { onchange: (e) => onchange(Number(e.target.value)) });
  for (const [cls, label] of CLASSES) {
    const vals = Object.entries(S.colNames).filter(([v]) => S.colClass[v] === cls).sort((a, b) => (b[1].cells || 0) - (a[1].cells || 0));
    if (!vals.length) continue;
    sel.append(h('optgroup', { label }, vals.map(([v, e]) => h('option', { value: v, selected: Number(v) === cur }, nice(e.name)))));
  }
  if (!S.colNames[cur]) sel.prepend(h('option', { value: cur, selected: true }, 'value ' + cur));
  return sel;
}
function refreshLegend() {
  const chips = CLASSES.filter(([cls]) => S.colRep[cls] !== undefined && cls !== 'door' && cls !== 'other').map(([cls, label, col]) =>
    h('button', { class: 'chip' + (S.tool === 'collision' && S.colClass[S.colBrush] === cls ? ' on' : ''), title: 'Collision brush: ' + label, onclick: () => { S.colBrush = S.colRep[cls]; setTool('collision'); } },
      h('i', { style: col ? `background:rgba(${col},.75)` : 'background:repeating-linear-gradient(45deg,#fff3,#fff3 3px,#0000 3px,#0000 6px)' }), label));
  setKids($('#legend'), h('b', null, 'Collision:'), chips, S.tool === 'collision' ? collisionSelect(S.colBrush, (v) => { S.colBrush = v; refreshLegend(); }) : null);
}

/** The choices of a parameter that has named values (chest contents…), ranges written out. */
function paramOptions(p) {
  const vals = p.values || p.enum;
  if (!vals) return null;
  const out = [];
  for (const [k, v] of Object.entries(vals)) {
    const m = /(\d+)\.\.(\d+)/.exec(v.description || ''), label = words(v.name || k);
    if (m && Number(m[1]) === Number(k)) for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push([n, `${label} ${n - Number(m[1]) + 1}`]);
    else out.push([Number(k), label + (v.description && v.description.length < 40 ? ` (${v.description})` : '')]);
  }
  return out;
}
function doorForm(d, di, change) {
  const R = S.room, ids = roomIds(), r = S.bind.resolve(d.to), inProj = r && mine(r);
  const sel = h('select', { disabled: R.ro, onchange: change((t) => {
    let target = t.value;
    if (target === '@vanilla') { const n = prompt('Original room number (for example 803):', r && !inProj ? numOf(r) : '803'); target = n && S.bind.resolve('room:vanilla/' + (Number(n) | 0)); if (!target) { toast('No original room has that number.'); refreshInspector(); return; } }
    const msg = linkDoor(R, di, target);
    if (msg) toast(msg, 5000);
    refreshInspector(); refreshMap(); thumbsSoon();
  }) }, ids.map((id) => h('option', { value: id, selected: id === r }, 'Room ' + roomLabel(id))),
  !inProj && r ? h('option', { value: r, selected: true }, 'Room ' + roomLabel(r)) : null, h('option', { value: '@vanilla' }, 'An original room…'));
  return [h('div', { class: 'form' },
    h('label', null, 'Leads to:'), sel,
    h('label', null, 'Comes out at:'), h('div', { class: 'row' },
      h('input', { type: 'number', value: d.arrive.x - 1, min: 0, disabled: R.ro, title: 'tile x in the target room', onchange: change((t) => { d.arrive.x = (Number(t.value) | 0) + 1; }) }),
      h('input', { type: 'number', value: d.arrive.y - 1, min: 0, disabled: R.ro, title: 'tile y in the target room', onchange: change((t) => { d.arrive.y = (Number(t.value) | 0) + 1; }) }),
      !R.ro && r ? h('button', { class: 'btn tiny', title: 'Tap the tile in the target room', onclick: () => startPick(di) }, 'Pick…') : null)),
  typeof (d.flags || 0) === 'number' ? h('div', { class: 'form' },
    h('label', null, 'Kirby faces:'), h('select', { disabled: R.ro, title: 'Which way Kirby looks when he comes out on the other side', onchange: change((t) => { const f = ((d.flags || 0) & ~3) | Number(t.value); if (f) d.flags = f; else delete d.flags; }) },
      [[0, 'as he went in'], [1, 'right'], [2, 'left']].map(([v, l]) => h('option', { value: v, selected: ((d.flags || 0) & 3) === v }, l))),
    h('label', { class: 'chk wide', title: 'Normally a door is where Kirby comes back after losing a life. Tick this for a door that should not become that place.' },
      h('input', { type: 'checkbox', checked: !!((d.flags || 0) & 0x80), disabled: R.ro, onchange: change((t) => { const f = ((d.flags || 0) & ~0x80) | (t.checked ? 0x80 : 0); if (f) d.flags = f; else delete d.flags; }) }), h('span', null, 'Not a place to come back to after losing a life'))) : null,
  r && r !== R.id ? h('button', { class: 'btn tiny', onclick: () => { openRoom(r); const T = S.room, bi = T.doc.doors.findIndex((x) => S.bind.resolve(x.to) === R.id); if (bi >= 0) { const oi = doorObject(T, ...T.doc.doors[bi].cells[0]); S.sel = oi >= 0 ? { kind: 'object', i: oi } : { kind: 'door', i: bi }; refreshInspector(); requestRender(); } } }, `Go to room ${numOf(r)} →`) : null,
  h('p', { class: 'dim' }, 'In play, press Up at the door to go through.')];
}
function refreshInspector(light) {
  const box = $('#inspector'), R = S.room, s = S.sel, o = selected();
  if (light && box.dataset.for === (s ? s.kind + s.i : '')) { const xi = $('#ins-x', box), yi = $('#ins-y', box); if (xi && o) { xi.value = (o.x - 8) / 16; yi.value = (o.y - 8) / 16; } return; }
  box.dataset.for = s ? s.kind + s.i : '';
  if (!o) { box.replaceChildren(); return; }
  const change = (fn) => (e) => { if (readOnly()) return; pushUndo(); fn(e.target); touch(); requestRender(); };
  if (s.kind === 'object') {
    const name = typeName(o), info = S.objInfo.get(name) || { category: 'other', params: [] }, di = doorOf(R, o);
    const types = [...S.objInfo.keys()].filter((n) => !/^(empty|unk|unused)/.test(n) || n === name).sort();
    const rows = [
      h('label', null, 'Type:'), h('select', { disabled: R.ro, onchange: change((t) => { if (di >= 0) removeDoorLink(R, di); o.type = t.value; delete o.params; if (isDoorType(t.value)) { const [x, y] = cellOfObj(o); const j = addDoorTo(R, x, y, R.id, arriveOn(x, y)); linkDoor(R, j, (S.lastRoom && mine(S.lastRoom) && S.lastRoom) || R.id); } refreshInspector(); refreshMap(); }) }, types.map((t) => h('option', { value: t, selected: t === name }, nice(t)))),
      h('label', null, 'Tile:'), h('div', { class: 'row' },
        h('input', { id: 'ins-x', type: 'number', step: 0.5, value: (o.x - 8) / 16, disabled: R.ro, onchange: change((t) => { if (di >= 0) moveObject(o, Math.round(Number(t.value)), Math.floor(o.y / 16)); else o.x = Math.round(Number(t.value) * 16 + 8); }) }),
        h('input', { id: 'ins-y', type: 'number', step: 0.5, value: (o.y - 8) / 16, disabled: R.ro, onchange: change((t) => { if (di >= 0) moveObject(o, Math.floor(o.x / 16), Math.round(Number(t.value))); else o.y = Math.round(Number(t.value) * 16 + 8); }) })),
    ];
    if (LINKS[name] || o.roomRegister !== undefined) {
      const cur = o.roomRegister || 0, top = Math.max(15, cur);
      rows.push(h('label', { title: LINKS[name] || '' }, 'Channel:'), h('select', { disabled: R.ro, title: LINKS[name] || '', onchange: change((t) => { const v = Number(t.value); if (v) o.roomRegister = v; else delete o.roomRegister; }) },
        h('option', { value: 0, selected: !cur }, 'none'), Array.from({ length: top }, (_, k) => h('option', { value: k + 1, selected: cur === k + 1 }, 'channel ' + (k + 1)))));
    }
    for (const p of info.params) {
      if (p.usage && p.usage !== 'live') continue;
      const v = o.params && o.params[p.name] !== undefined ? o.params[p.name] : '';
      const setv = (t) => { o.params = o.params || {}; if (t.value === '') delete o.params[p.name]; else o.params[p.name] = Number(t.value) | 0; if (!Object.keys(o.params).length) delete o.params; };
      const opts = paramOptions(p);
      rows.push(h('label', { title: p.description || '' }, words(p.name) + ':'), opts
        ? h('select', { disabled: R.ro, title: p.description || '', onchange: change(setv) }, h('option', { value: '', selected: v === '' }, 'default'), opts.map(([n, label]) => h('option', { value: n, selected: v === n }, label)),
          typeof v === 'number' && !opts.some(([n]) => n === v) ? h('option', { value: v, selected: true }, 'value ' + v) : null)
        : h('input', { type: 'number', value: typeof v === 'number' ? v : '', placeholder: 'default', title: p.description || '', disabled: R.ro, min: p.range ? p.range[0] : null, max: p.range ? p.range[1] : null, onchange: change(setv) }));
    }
    setKids(box, h('h3', null, di >= 0 ? 'Selected Door' : isFoe(info.category) ? 'Selected Enemy' : 'Selected Object'),
      h('div', { style: 'display:flex;gap:10px;align-items:flex-start' }, typeIcon(name, 48), h('div', { class: 'form', style: 'flex:1;min-width:0' }, rows)),
      di >= 0 ? doorForm(R.doc.doors[di], di, change) : null,
      LINKS[name] ? h('p', { class: 'dim' }, LINKS[name]) : null,
      di < 0 && info.description && !LINKS[name] ? h('p', { class: 'dim' }, info.description) : null,
      R.ro ? null : h('button', { class: 'btn danger tiny', onclick: deleteSelected }, 'Delete'));
  } else {
    setKids(box, h('h3', null, 'Selected Door'), doorForm(o, s.i, change), R.ro ? null : h('button', { class: 'btn danger tiny', onclick: deleteSelected }, 'Delete door'));
  }
}
function startPick(doorIndex) {
  const from = S.room.id, to = S.bind.resolve(S.room.doc.doors[doorIndex].to);
  flush();
  S.pick = { from, doorIndex };
  if (to !== from) openRoom(to);
  setTool('select'); status('Tap the tile where Kirby should come out.'); toast('Tap the tile where Kirby should come out.', 4000);
}
function finishPick(x, y) {
  const { from, doorIndex } = S.pick; S.pick = null;
  if (S.room.id !== from) openRoom(from);
  pushUndo();
  S.room.doc.doors[doorIndex].arrive = arriveOn(x, y);
  const oi = doorObject(S.room, ...S.room.doc.doors[doorIndex].cells[0]);
  S.sel = oi >= 0 ? { kind: 'object', i: oi } : { kind: 'door', i: doorIndex };
  touch(); refreshInspector(); refreshStatus();
}

function refreshRooms() {
  const R = S.room, ids = roomIds();
  setKids($('#roomsel'), ids.map((id) => h('option', { value: id, selected: id === R.id }, 'Room: ' + roomLabel(id))),
    R.ro ? h('option', { value: R.id, selected: true }, 'Original room: ' + roomLabel(R.id)) : null);
  const bar = $('#robar');
  bar.hidden = !R.ro;
  if (R.ro) setKids(bar, `Room ${R.num} of the original game (${nice(areaOf(R.id))}): look, don’t touch.`, h('span', { class: 'grow' }),
    h('button', { class: 'btn', title: 'Your version replaces the original room when you play: this is how a door to your rooms gets into the game', onclick: () => adoptOriginal(R.id, false) }, '✎ Edit this room'),
    h('button', { class: 'btn', onclick: () => adoptOriginal(R.id, true) }, 'Copy as a new room'),
    h('button', { class: 'btn', onclick: () => openRoom((S.lastRoom && mine(S.lastRoom) && S.lastRoom) || ids[0]) }, 'Back to my rooms'));
}
function refreshMap() {
  const ids = roomIds(), nodes = new Map(), edges = [];
  for (const id of ids) nodes.set(id, { id, label: String(numOf(id)), ext: false });
  for (const id of ids) for (const d of roomDoc(id).doors || []) {
    const r = S.bind.resolve(d.to) || d.to;
    if (roomDoc(id).bind && !mine(r)) continue;                     // an edited original room: only its links into the project
    if (!nodes.has(r)) nodes.set(r, { id: r, label: String(numOf(r) ?? '?'), ext: true });
    if (r !== id) edges.push([id, r]);
  }
  const depth = new Map(); let col = 0;
  for (const start of nodes.keys()) {
    if (depth.has(start)) continue;
    const q = [[start, col]];
    while (q.length) {
      const [n, dpt] = q.shift();
      if (depth.has(n)) continue;
      depth.set(n, dpt); col = Math.max(col, dpt + 1);
      for (const [a, b] of edges) { if (a === n && !depth.has(b)) q.push([b, dpt + 1]); if (b === n && !depth.has(a) && !nodes.get(n).ext) q.push([a, dpt + 1]); }
    }
  }
  const rows = new Map();
  for (const n of nodes.values()) { const c = depth.get(n.id), r = rows.get(c) || 0; rows.set(c, r + 1); n.x = 12 + c * 96; n.y = 8 + r * 40; }
  const w = Math.max(...[...nodes.values()].map((n) => n.x)) + 86, hgt = Math.max(...[...nodes.values()].map((n) => n.y)) + 38;
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', hgt); svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  const el = (t, a, txt) => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt) e.textContent = txt; return e; };
  for (const [a, b] of edges) { const A = nodes.get(a), B = nodes.get(b); svg.append(el('line', { x1: A.x + 37, y1: A.y + 14, x2: B.x + 37, y2: B.y + 14 })); }
  for (const n of nodes.values()) {
    const g = el('g', { class: 'node' + (n.id === S.room.id ? ' cur' : '') + (n.ext ? ' ext' : '') });
    g.append(el('rect', { x: n.x, y: n.y, width: 74, height: 28, rx: 8 }), el('text', { x: n.x + 37, y: n.y + 14 }, n.label));
    g.addEventListener('click', () => openRoom(n.id));
    svg.append(g);
  }
  setKids($('#areamap .body'), svg, h('p', { class: 'dim', style: 'margin:4px 0 0' }, 'Yellow: this room · dashed: a room of the original game · lines: doors'));
}
function refreshThumbs() {
  setKids($('#thumbs .body'), roomIds().map((id) => h('div', { class: 'thumb' + (id === S.room.id ? ' on' : ''), onclick: () => openRoom(id) }, roomPicture(id), roomLabel(id))),
    h('div', { class: 'thumb new', onclick: newRoomDialog }, h('div', null, h('div', { style: 'font-size:22px' }, '+'), 'New room')));
}
const thumbsSoon = debounce(refreshThumbs, 900);

// what the checker says, said plainly; `tip` = worth knowing, nothing is broken
const PLAIN = {
  unreachable: { tip: true, text: () => 'Nothing leads to this room yet. Put a door in another room and point it here (the game starts in the original rooms: Rooms tab, “The original game”).' },
  'one-way': { tip: true, text: () => 'This door has no door coming back.' },
  'camera-bottom': { text: () => 'This door lets Kirby out too close to the bottom of the room, where the camera does not reach. Keep floors above the shaded strip.' },
  'arrive-blocked': { text: () => 'This door lets Kirby out inside a wall. Select the door and use “Pick…” to choose a free tile.' },
  'arrive-bounds': { text: () => 'This door lets Kirby out outside the target room. Select the door and use “Pick…”.' },
  'door-terrain': { text: () => 'A door link has no door under it. Delete it and place a door object instead.' },
  'door-object': { tip: true, text: () => 'A door link has no door object on it, so nothing is drawn there.' },
  'limit-cells': { text: (e) => e.message },
};
function refreshIssues() {
  const f = S.findings, n = f.errors.length + f.warnings.length;
  $('#issues h3').textContent = `Validation (${n ? n + ' issue' + (n > 1 ? 's' : '') : 'no issues'})`;
  const roomOf = (e) => { const id = e.file && S.L.project.idOfPath(e.file); return id && S.bind.docs.has(id) ? id : null; };
  const row = (sev) => (e) => {
    const p = PLAIN[e.code], id = roomOf(e);
    return h('div', { class: 'issue ' + sev, style: id ? 'cursor:pointer' : '', onclick: () => { if (id && id !== S.room.id) openRoom(id); } }, sev === 'error' ? '⛔' : sev === 'tip' ? '💡' : '⚠',
      h('div', null, (id ? `Room ${numOf(id)}: ` : '') + (p ? p.text(e) : e.message), p ? null : h('small', null, [e.where, e.hint ? 'hint: ' + e.hint : ''].filter(Boolean).join(' · '))));
  };
  setKids($('#issues .body'), f.errors.map(row('error')), f.warnings.map(row('warning')), n ? null : h('p', { class: 'allgood' }, '✓ This project is ready to play.'), f.tips.map(row('tip')));
  const dot = $('#vdot');
  dot.className = 'dot ' + (f.errors.length ? 'err' : f.warnings.length ? 'warn' : 'ok');
  dot.textContent = f.errors.length ? String(f.errors.length) : f.warnings.length ? String(f.warnings.length) : '✓';
}
function refreshStatus() {
  const R = S.room;
  if (!R || S.pick) return;
  const used = new Set();
  for (const t of R.art) for (const p of t.split(' ')) used.add(p.slice(0, 3));
  status(`Room ${R.num}${R.ro ? ' (original)' : ''} · ${R.W} × ${R.H} tiles · ${nice(R.doc.tileset.replace('tileset:vanilla/', 'tile set '))}: ${used.size}/${S.gfx.tileCount || '?'} tiles · zoom ${S.zoom * 100}%${S.hover ? ` · tile ${S.hover[0]}, ${S.hover[1]}` : ''}`);
}
function refreshAll() { refreshRooms(); refreshTab(); refreshLegend(); refreshInspector(); refreshMap(); refreshThumbs(); refreshStatus(); refreshUndo(); requestRender(); }

// ------------------------------------------------------------------- menus
function openMenu(anchor, which) {
  const m = $('#menu'), item = (label, run, dis) => h('button', { disabled: dis, onclick: () => { m.hidden = true; run(); } }, label);
  const tog = (label, key) => item((S.show[key] ? '☑ ' : '☐ ') + label, () => { S.show[key] = !S.show[key]; syncShow(); });
  const items = {
    file: () => [item('New project…', newProject), item('Open a project (.zip or .json)…', () => $('#openfile').click()), item('Example projects…', examplesDialog), h('hr'),
      item('New room…', newRoomDialog), item('Look at the original game’s rooms', () => setTab('rooms')), h('hr'), item('Save: download the project (.zip)', saveZip), item('Open the game page', () => window.open('../', '_blank'))],
    edit: () => [item('Undo', undo, !S.undo.length), item('Redo', redo, !S.redo.length), h('hr'), item('Delete the selected object', deleteSelected, !S.sel), item('Shuffle the terrain fill', shuffleFill), item('Clear this room…', clearRoom), item('Room settings…', showRoomTab)],
    view: () => [tog('Collision', 'collision'), tog('Objects', 'objects'), tog('Camera (240 × 160)', 'camera'), tog('Grid', 'grid'), h('hr'), item('Zoom to fit', zoomFit), item('Zoom 100%', () => setZoom(1)), item('Zoom 300%', () => setZoom(3)), h('hr'), item('Reset the panel sizes', resetLayout)],
  }[which]();
  setKids(m, items); m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.left = clamp(r.left, 6, innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = clamp(r.bottom + 4, 6, innerHeight - m.offsetHeight - 6) + 'px';
}
function syncShow() {
  lsSet('katam.ed.show2', S.show);
  $('#sh-collision').checked = S.show.collision; $('#sh-objects').checked = S.show.objects; $('#sh-camera').checked = S.show.camera;
  $('#gridbtn').setAttribute('aria-pressed', String(S.show.grid));
  requestRender();
}
function zoomFit() {
  const sc = $('#scroll'), R = S.room;
  setZoom(clamp(Math.floor(Math.min(sc.clientWidth / (R.W * 16), sc.clientHeight / (R.H * 16))), 1, 6));
}
function clearRoom() {
  if (readOnly()) return;
  confirmBox('Clear this room?', 'Every tile, object and door of this room is removed. You can undo it.', 'Clear room', () => {
    pushUndo();
    const R = S.room, D = dict(R.doc.tileset);
    R.art.fill(D.empty); R.col.fill(0); R.doc.objects = []; R.doc.doors = []; delete R.doc.patches; S.sel = null;
    redrawArt(); touch(); refreshInspector(); refreshMap();
  });
}
/** The example projects that ship with the editor, as cards to pick from. */
function examplesDialog() {
  const names = [...new Set(Object.keys(S.data.examples).map((p) => p.split('/')[0]))];
  const cards = names.map((name) => {
    const files = Object.entries(S.data.examples).filter(([p]) => p.startsWith(name + '/'));
    const proj = JSON.parse((files.find(([p]) => p === name + '/project.json') || [0, '{}'])[1]);
    const rooms = files.filter(([p]) => p.endsWith('.room.json')).map(([, t]) => JSON.parse(t));
    let pic = h('canvas', { width: 8, height: 8 });
    try { pic = docPicture(rooms[0]); } catch (e) { /* no picture */ }
    return h('button', { class: 'excard', onclick: () => { close(); S.example = name; loadProjectFiles(null); toast(`Opened “${proj.name || name}”. Press Play here to try it.`, 4000); } },
      pic, h('b', null, proj.name || nice(name)), h('span', { class: 'dim' }, `${rooms.length} room${rooms.length === 1 ? '' : 's'}`), h('span', null, (proj.description || '').length > 150 ? proj.description.slice(0, 150).replace(/\s+\S*$/, '') + '…' : proj.description || ''));
  });
  const close = modal('Example projects', h('div', null, h('p', { class: 'dim', style: 'margin:0 0 8px' }, 'Opening one replaces the project in this browser. Save yours first if you want to keep it.'), h('div', { class: 'excards' }, cards)), [{ label: 'Cancel' }]);
}
function newProject() {
  confirmBox('Start a new project?', 'The project in this browser is replaced by one empty room. Save it first if you want to keep it.', 'New project', () => {
    flush(); clearProject(); S.room = null; S.lastRoom = null; S.starts = {}; lsSet('katam.ed.starts', S.starts);
    ensureProjectFile(); rebind();
    createRoom('First room', 30, 14, looks().find((l) => l.tileset === 'tileset:vanilla/0') || looks()[0]);
  });
}
function loadProjectFiles(files) {
  flush();
  const before = S.io.list('/project').map((p) => [p, S.io.readText(p)]), was = S.room && S.room.id;
  try { loadProjectFiles2(files); } catch (e) {
    // never leave the editor half-loaded: put back what was open and say what went wrong
    console.error('[editor] opening the project failed:', e);
    putFiles(before); S.room = null; rebind(); openRoom(roomIds().includes(was) ? was : roomIds()[0]);
    modal('That project could not be opened', h('p', null, `${e.message}. Your previous project is back. If this file came from the editor, please send it along with this message.`), [{ label: 'OK', primary: true }]);
  }
}
function loadProjectFiles2(files) {
  S.room = null; S.lastRoom = null; S.sel = null; S.undo = []; S.redo = [];
  if (!files) putExample();
  else {
    clearProject();
    let n = 0;
    for (const f of files) {
      const name = f.name.replace(/\\/g, '/');
      if (/(^|\/)project\.json$/.test(name)) { S.io.writeText('/project/project.json', f.text); continue; }
      let doc = null;
      try { doc = JSON.parse(f.text); } catch (e) { continue; }
      if (doc && doc.id && S.L.project.parseId(doc.id)) { S.io.writeText('/project/' + S.L.project.pathOf(doc.id), f.text); n++; }
    }
    ensureProjectFile();
    if (!n) { toast('No room files were found in that file.'); putExample(); }
  }
  rebind();
  const ids = roomIds();
  if (!ids.length || !openRoom(ids[0])) { putExample(); rebind(); openRoom(roomIds()[0]); }
  validateSoon(); persist();
}
async function openFiles(list) {
  try {
    const groups = await Promise.all(Array.from(list).map(async (f) => (/\.zip$/i.test(f.name) ? readZip(await f.arrayBuffer(), S.L.zlib.inflate) : [{ name: f.name, text: await f.text() }])));
    loadProjectFiles(groups.flat());
  } catch (e) { toast('Could not read that file: ' + e.message, 5000); }
}
function saveZip() {
  flush();
  const enc = new TextEncoder();
  const files = S.io.list('/project').map((p) => ({ name: p.slice('/project/'.length), bytes: enc.encode(S.io.readText(p)) }));
  const name = slug((S.proj.project && S.proj.project.name) || 'katam_project') + '.zip';
  const a = h('a', { href: URL.createObjectURL(makeZip(files)), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Saved ${name} (${files.length} files). The project is also kept in this browser.`);
}

// ---------------------------------------------------------- panel sizes
const LAYOUT0 = { side: 400, bottom: 150, insp: 250, b: [1, 1.1, 1.1] };
let layout = Object.assign({}, LAYOUT0, lsGet('katam.ed.layout', {}));
function applyLayout() {
  const app = $('#app');
  app.style.setProperty('--side', layout.side + 'px'); app.style.setProperty('--bottom', layout.bottom + 'px'); app.style.setProperty('--insp', layout.insp + 'px');
  $$('#bottom .card').forEach((c, i) => { c.style.flexGrow = layout.b[i]; });
  lsSet('katam.ed.layout', layout);
}
function resetLayout() { layout = JSON.parse(JSON.stringify(LAYOUT0)); applyLayout(); }
/** Make a gap between panels draggable. `move(dx, dy, start)` updates the layout from the drag. */
function splitter(el, move) {
  let start = null;
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); el.classList.add('drag'); start = { x: e.clientX, y: e.clientY, l: JSON.parse(JSON.stringify(layout)) }; e.preventDefault(); });
  el.addEventListener('pointermove', (e) => { if (!start) return; move(e.clientX - start.x, e.clientY - start.y, start.l); applyLayout(); });
  const end = () => { start = null; el.classList.remove('drag'); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', resetLayout);
}
function buildSplitters() {
  splitter($('#g-side'), (dx, dy, l) => { layout.side = clamp(l.side - dx, 240, Math.max(260, innerWidth - 520)); });
  splitter($('#g-bottom'), (dx, dy, l) => { layout.bottom = clamp(l.bottom - dy, 60, Math.max(80, innerHeight - 320)); });
  splitter($('#g-insp'), (dx, dy, l) => { layout.insp = clamp(l.insp - dy, 90, Math.max(100, $('#side').clientHeight - 180)); });
  const bsplit = (i) => (dx, dy, l) => {
    const total = l.b[0] + l.b[1] + l.b[2], per = total / Math.max(1, $('#bottom').clientWidth), d = dx * per;
    const a = clamp(l.b[i] + d, 0.25, l.b[i] + l.b[i + 1] - 0.25);
    layout.b = l.b.slice(); layout.b[i + 1] = l.b[i] + l.b[i + 1] - a; layout.b[i] = a;
  };
  splitter($('#g-b1'), bsplit(0)); splitter($('#g-b2'), bsplit(1));
  applyLayout();
}

// ----------------------------------------------------- validate / compile / play
function validateNow() {
  flush(); rebind();
  const L = S.L, t0 = performance.now();
  let res;
  try { res = L.validate.validatePath({ io: S.io, target: '/project', bases: ['/vanilla'], vocab: S.vocab, registry: S.registry, schemaDir: '/schema' }); } catch (e) { res = { errors: [{ code: 'internal', message: e.message }], warnings: [] }; }
  const compiled = compileProject();
  for (const e of compiled.errors) if (!res.errors.some((x) => x.message === e.message)) res.errors.push({ severity: 'error', code: 'compile', file: e.file, where: e.where, message: e.message, hint: e.hint });
  // the editor's doors put Kirby ON the arrival tile (lib/validate reads `arrive` one tile to the left): check that tile itself
  const blocked = (e) => {
    const id = S.L.project.idOfPath(e.file || ''), m = /\/doors\/(\d+)/.exec(e.where || ''), d = id && m && (roomDoc(id).doors || [])[Number(m[1])];
    const T = d && S.bind.resolve(d.to) ? loadRoom(d.to) : null;
    if (!T) return true;
    const x = d.arrive.x - 1, y = d.arrive.y - 1, c = (a, b) => (a < 0 || b < 0 || a >= T.W || b >= T.H ? 'solid' : S.colClass[T.col[b * T.W + a]]);
    return c(x, y) === 'solid' || c(x, y) === 'hazard';
  };
  res.errors = res.errors.filter((e) => e.code !== 'arrive-blocked' || blocked(e));
  const all = res.warnings.filter((w) => w.code !== 'nav-default' && !(w.code === 'arrive-blocked' && !blocked(w)));
  res.warnings = all.filter((w) => !(PLAIN[w.code] && PLAIN[w.code].tip));
  res.tips = all.filter((w) => PLAIN[w.code] && PLAIN[w.code].tip);
  S.findings = res; S.compiled = compiled;
  S.validateMs = Math.round(performance.now() - t0);
  refreshIssues();
  return res;
}
const validateSoon = debounce(() => { if (S.drag) return validateSoon(); validateNow(); }, 1100);

/** Compile the project's own rooms (the original game's are already in the ROM). */
function compileProject() {
  const out = { rooms: new Map(), tilesets: new Map(), backgrounds: new Map(), palettes: new Map(), objDesc: new Map(), errors: [], bindings: S.bind, vocab: S.vocab,
    vanillaLayers: new Set(['/vanilla']), projectIds: new Map([['/vanilla', 'vanilla'], ['/project', (S.proj.project && S.proj.project.id) || 'project']]) };
  for (const [id, d] of [...S.proj.docs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!id.startsWith('room:')) continue;
    try { const c = S.L.room.compileRoom(d.doc, S.ctx); out.rooms.set(c.roomId, { id, project: d.project, ...c }); } catch (e) { out.errors.push({ file: d.rel, project: d.project, where: e.where || '', message: e.message, hint: e.hint }); }
  }
  return out;
}

// The game runs in a frame that is started quietly in the background, so
// Play is a warp into the room, behind a cover until the room is on screen.
const P = { frame: null, ready: false, pending: null, visible: false, last: null, rooms: null, retried: false, watch: 0 };
function playMessage(hidden) {
  let bundle;
  try { bundle = S.L.pipeline.bundleOf(S.compiled); } catch (e) { if (!hidden) toast('Could not build the rooms: ' + e.message, 6000); return null; }
  const [sx, sy] = startCell(), a = arriveOn(sx, sy);
  return { katamEd: 1, type: 'play', hidden, bundle: bundle.bytes, room: S.room.num, x: a.x, y: a.y,
    // each room's number and outline: what the running game can and cannot have swapped under it
    rooms: Object.fromEntries(roomIds().map((id) => { const d = roomDoc(id); return [numOf(id), `${d.size.width}x${d.size.height}|${d.tileset}|${d.palette}|${d.background}`]; })) };
}
function ensureFrame() {
  if (P.frame) return;
  P.ready = false;
  P.frame = h('iframe', { src: new URL(CFG.play, BASE).href, allow: 'autoplay; fullscreen; gamepad', title: 'Playtest' });
  $('#playview').prepend(P.frame);
}
function prewarm() {
  if (P.frame || !S.romStored || !$('#playview').hidden) return;
  if (validateNow().errors.length) return;
  const m = playMessage(true);
  if (!m) return;
  P.pending = m; ensureFrame();
}
function play() {
  cancelLookPreview(); stopSong();
  const res = validateNow();
  if (res.errors.length) { document.body.classList.add('bottom-open'); toast('Fix the errors in the Validation list first.', 4000); return; }
  const m = playMessage(false);
  if (!m) return;
  P.retried = false;
  // The running game may be standing in any room it was given.  Re-linking is
  // safe for edits inside a room; a room that is gone, or has another size or
  // tile set (another project was opened, a room resized), cannot be swapped
  // under the game's feet -- it stops or hangs.  Then start a fresh game.
  if (P.frame && P.rooms && Object.entries(P.rooms).some(([n, sig]) => m.rooms[n] !== sig)) dropFrame();
  showPlay(m);
}
function showPlay(m) {
  P.pending = m; P.last = m; P.visible = true;
  $('#play-cover').hidden = false; $('#play-cover-msg').textContent = 'Loading the room…';
  $('#playview').hidden = false;
  ensureFrame(); sendPlay();
  P.frame.focus();
  clearTimeout(P.watch);
  P.watch = setTimeout(() => playFailed('the game did not answer'), 25000);
}
function dropFrame() { if (P.frame) P.frame.remove(); P.frame = null; P.ready = false; P.rooms = null; if (M.song !== null) { M.song = null; M.state = ''; refreshSongs(); } }
/** The game stopped or never showed the room: one fresh start, then say so. */
function playFailed(why) {
  clearTimeout(P.watch);
  const visible = P.visible, again = visible && !P.retried && P.last;
  console.warn('[editor] play frame:', why);
  dropFrame();
  if (again) { P.retried = true; showPlay(Object.assign({}, P.last, { hidden: false })); return; }
  if (visible) { $('#play-cover').hidden = false; $('#play-cover-msg').textContent = `The game could not run this room (${why}). Press “Back to editor”; if it keeps happening, save the project and send it along.`; }
}
function sendPlay() {
  if (!P.frame || !P.ready || !P.pending) return;
  P.frame.contentWindow.postMessage(P.pending, location.origin);
  P.rooms = Object.assign({}, P.rooms, P.pending.rooms);   // every room the running game may be standing in
  P.pending = null;
}
function stopPlay(destroy) {
  $('#playview').hidden = true; P.visible = false;
  P.pending = null; clearTimeout(P.watch);
  if (!P.frame) return;
  if (destroy || !P.ready) dropFrame();
  else P.frame.contentWindow.postMessage({ katamEd: 1, type: 'pause' }, location.origin);   // kept: the next play is a warp
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || e.data.katamPlay !== 1) return;
  const m = e.data;
  if (m.type === 'ready') { P.ready = true; sendPlay(); sendSong(); }
  else if (m.type === 'music') { if (M.song !== null && songNumber(M.song) === m.song) { M.state = 'playing'; refreshSongs(); } }
  else if (m.type === 'playing') { clearTimeout(P.watch); if (P.visible) { $('#play-cover').hidden = true; P.frame.focus(); } }
  else if (m.type === 'crashed') playFailed(m.text);
  else if (m.type === 'status') { $('#play-cover-msg').textContent = m.text || ''; }
});

// -------------------------------------------------------------------- wiring
function buildUi() {
  buildTools(); buildSplitters();
  document.body.append(h('input', { type: 'file', id: 'openfile', hidden: true, multiple: true, accept: '.json,.zip,application/json,application/zip', onchange: function () { if (this.files.length) openFiles(this.files); this.value = ''; } }));
  setKids($('#zoomsel'), [1, 2, 3, 4, 5, 6].map((z) => h('option', { value: z, selected: z === S.zoom }, z * 100 + '%')));
  $('#zoomsel').onchange = (e) => setZoom(Number(e.target.value));
  $('#zin').onclick = () => setZoom(S.zoom + 1); $('#zout').onclick = () => setZoom(S.zoom - 1);
  $('#gridbtn').onclick = () => { S.show.grid = !S.show.grid; syncShow(); };
  for (const k of ['collision', 'objects', 'camera']) $('#sh-' + k).onchange = (e) => { S.show[k] = e.target.checked; syncShow(); };
  syncShow();
  $('#roomsel').onchange = (e) => openRoom(e.target.value);
  $('#undo').onclick = undo; $('#redo').onclick = redo; $('#roomset').onclick = showRoomTab;
  $('#validate').onclick = () => { const r = validateNow(); document.body.classList.add('bottom-open'); toast(r.errors.length || r.warnings.length ? `${r.errors.length} error(s), ${r.warnings.length} warning(s).` : 'No issues: ready to play.'); };
  $('#play').onclick = play; $('#save').onclick = saveZip;
  $('#play-back').onclick = () => stopPlay(false);
  $('#play-restart').onclick = () => { stopPlay(true); play(); };
  $$('.btn.menu').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openMenu(b, b.dataset.menu); }; });
  document.addEventListener('click', (e) => { if (!e.target.closest('#menu') && !e.target.closest('.tool.sub')) $('#menu').hidden = true; });
  $$('.tab').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
  $('#tg-side').onclick = () => { document.body.classList.remove('bottom-open'); document.body.classList.toggle('side-open'); };
  $('#tg-bottom').onclick = () => { document.body.classList.remove('side-open'); document.body.classList.toggle('bottom-open'); };
  for (const [sel, cls] of [['#side', 'side-open'], ['#bottom', 'bottom-open']]) $(sel).prepend(h('button', { class: 'btn tiny only-compact', style: 'align-self:flex-end;margin-bottom:6px', onclick: () => document.body.classList.remove(cls) }, '✕ Close'));
  const cv = $('#cv');
  cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', () => { if (!S.drag) { S.hover = null; requestRender(); } });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#scroll').addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = $('#scroll').getBoundingClientRect(); setZoom(S.zoom + (e.deltaY < 0 ? 1 : -1), [e.clientX - r.left, e.clientY - r.top]); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || !$('#playview').hidden || !$('#modal').hidden) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveZip(); }
    else if (k === 'delete' || k === 'backspace') { if (S.sel) { e.preventDefault(); deleteSelected(); } }
    else if (k === ' ') { S.space = true; e.preventDefault(); }
    else if (k === 'escape') { S.pick = null; S.sel = null; refreshInspector(); refreshStatus(); requestRender(); }
    else if (k === '+' || k === '=') setZoom(S.zoom + 1);
    else if (k === '-') setZoom(S.zoom - 1);
    else if (!e.ctrlKey && !e.metaKey) { const t = { v: 'select', b: 'brush', r: 'rect', g: 'fill', e: 'eraser', c: 'collision', o: 'object', i: 'eyedropper' }[k]; if (t) setTool(t); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') S.space = false; });
  window.addEventListener('beforeunload', () => { flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  setTool('brush');
}

S.api = { paint: (list) => { pushUndo(); paintCells(list); touch(); flush(); }, previewLook, applyLook, cancelLookPreview, toggleSong, stopSong, M, MECH, typeDefaults, lookPicture, openRoom, createRoom, adoptOriginal, placeObject, linkDoor, validateNow, play, stopPlay, looks, dict, setZoom, setTab, setTool, roomIds, P };
// nothing fails silently: an error anywhere says so on the page as well as in the console
window.addEventListener('error', (e) => { toast('Something went wrong: ' + (e.message || e.error), 8000); });
window.addEventListener('unhandledrejection', (e) => { toast('Something went wrong: ' + ((e.reason && e.reason.message) || e.reason), 8000); });
boot().catch((e) => { console.error(e); curtain('The editor could not start: ' + e.message, { err: true }); });
