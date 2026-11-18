// Rooms: native (GBA records) <-> authoring (katam-room/1 JSON).
//
//   decompileRoom(native, ctx) -> room document
//   compileRoom(doc, ctx)      -> native blobs (same keys as native.readRoomNative)
//
// Everything the game derives or duplicates is derived here, so an author never
// writes it: the five content indices, the fg layer's size and roomId tag, the
// cell-record order and keys, the object type set, the progress list (chests
// from chest objects, door shadows from doors), list terminators and strides.
// The round-trip gate (gate.mjs) proves the derivations reproduce vanilla.
import { u16, s16, put } from './bytes.mjs';
import { encodeLZ77, encodeRL } from './compress.mjs';
import * as N from './native.mjs';
import { decodeGrid, encodeGrid, GridError } from './grid.mjs';
import { metatileOf, metaToken, metaValues, tokenOf, valueOf } from './tiles.mjs';

export const ROOM_FORMAT = 'katam-room/1';

// RoomProps fields the codec maps itself (references / derived); the rest are
// "free" fields, named through the registry or kept as raw.<cField>.
export const PROP_FREE = ['unk02', 'unk04', 'unkXmod_06', 'unkXmod_08', 'unk0A', 'unk0C', 'unk0E', 'unk10', 'priorityFlags'];

// Frozen per format version: an omitted field means this value, whatever any
// registry later says the "neutral" value is.  (Most common vanilla values.)
export const PROP_DEFAULTS = { unk02: 0, unk04: 0, unkXmod_06: 256, unkXmod_08: 256, unk0A: 0, unk0C: 0, unk0E: -1, unk10: -1, priorityFlags: 0x79 };
export const TEMPLATE_DEFAULTS = { spawnTable: 1, unk1: N.TEMPLATE_SIZE, unkA: 255, unkB: 255, unkD: 255 };
const TEMPLATE_CORE = new Set(['type', 'x', 'y']);
const TEMPLATE_DERIVED = new Set(['unk1']);      // stride
export const CHEST_TYPES = new Set([0x80, 0x81]); // OBJ_SMALL_CHEST, OBJ_BIG_CHEST
export const DOOR_FLAG_DEFAULT = 0;

const NAV_KEYS = '0123456789abcdefghijklmnopqrstuv';

export class RoomError extends Error {
  constructor(msg, where, hint) { super(msg); this.where = where; this.hint = hint; }
}

// ---------------------------------------------------------------- helpers

function bitsOut(entry, value, reg) {
  // Expand a bitfield into named booleans when the registry names its bits.
  const bits = (entry && entry.bits) || [];
  const named = bits.filter((b) => b.name && !b.shift && reg.nameOf({ ...b, usage: b.usage || 'live' }) && popcount(Number(b.mask)) === 1);
  if (!named.length) return value;
  const out = {};
  let rest = value;
  for (const b of named) { const m = Number(b.mask); out[b.name] = !!(value & m); rest &= ~m; }
  if (rest) out._otherBits = rest;
  return out;
}

function bitsIn(entry, v, where) {
  if (typeof v === 'number') return v;
  if (!v || typeof v !== 'object') throw new RoomError('expected a number or an object of named bits', where);
  const bits = (entry && entry.bits) || [];
  let out = v._otherBits || 0;
  for (const [k, on] of Object.entries(v)) {
    if (k === '_otherBits') continue;
    const b = bits.find((x) => x.name === k || (x.aliases || []).includes(k));
    if (!b) throw new RoomError(`unknown bit "${k}"`, `${where}.${k}`, `known bits: ${bits.filter((x) => x.name).map((x) => x.name).join(', ')}`);
    if (on) out |= Number(b.mask);
  }
  return out;
}

const popcount = (m) => { let c = 0; while (m) { c += m & 1; m >>>= 1; } return c; };

/** free fields of one record -> {named, raw} (omitting frozen defaults) */
function freeOut(reg, record, values, fields, defaults) {
  const named = {}, raw = {};
  for (const f of fields) {
    const v = values[f];
    if (defaults && f in defaults && defaults[f] === v) continue;
    if (!defaults && v === 0) continue;
    const entry = reg.field(record, f);
    const n = reg.nameOf(entry);
    if (n) named[n] = entry && entry.bits ? bitsOut(entry, v, reg) : v; else raw[f] = v;
  }
  return { named, raw };
}

/** inverse of freeOut: named + raw + defaults -> {cField: value} */
function freeIn(reg, record, named, raw, fields, defaults, where, extraNames = {}) {
  const out = {};
  for (const f of fields) out[f] = defaults && f in defaults ? defaults[f] : 0;
  const byName = { ...reg.nameMap(record), ...extraNames };
  for (const [k, v] of Object.entries(named || {})) {
    const f = byName[k];
    if (!f || !fields.includes(f)) continue; // not ours: caller checks unknown keys
    out[f] = bitsIn(reg.field(record, f), v, `${where}.${k}`);
  }
  for (const [k, v] of Object.entries(raw || {})) {
    if (!fields.includes(k)) throw new RoomError(`raw.${k} is not a field of ${record}`, `${where}.raw.${k}`, `fields: ${fields.join(', ')}`);
    out[k] = v;
  }
  return out;
}

// --------------------------------------------------------------- decompile

export function decompileRoom(nat, ctx) {
  const { vocab, registry: reg } = ctx;
  const B = nat.blobs, P = nat.props;
  const W = nat.widthTiles >> 1, H = nat.heightTiles >> 1;
  const doc = { format: ROOM_FORMAT, id: ctx.roomRef(nat.roomId) };
  doc.bind = { roomId: nat.roomId, content: P.objectListIdx };
  doc.size = { width: W, height: H };
  doc.music = vocab.songName[P.songIdx] ?? P.songIdx;
  doc.tileset = ctx.ref('tileset', P.pixelDataIdx);
  doc.palette = ctx.ref('palette', P.paletteDataIdx);
  doc.background = ctx.ref('background', P.backgroundIdx);

  const fr = freeOut(reg, 'room_props', P, PROP_FREE, PROP_DEFAULTS);
  if (Object.keys(fr.named).length) doc.props = fr.named;
  if (Object.keys(fr.raw).length) doc.raw = fr.raw;

  // fg layer annotations the codec derives; anything else is preserved.
  const fgRoom = u16(B.fgHeader, 0x1e);
  if (fgRoom !== nat.roomId) doc.fgLayerRoomTag = fgRoom;

  // art: 16x16 metatiles
  const metas = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) metas.push(metaToken(metatileOf(B.fgTilemap, nat.widthTiles, x, y)));
  doc.art = encodeGrid(metas, W, H, { suggest: (m) => (m === '000.0 000.0 000.0 000.0' ? '.' : null) });

  // collision
  const cvals = Array.from(B.collision);
  doc.collision = encodeGrid(cvals, W, H, { suggest: (v) => ctx.collisionGlyph(v), toLegend: (v) => ctx.collisionName(v) });

  // cell records
  const patches = [], doorCells = [];
  for (let o = 0; o < B.cellRecords.length;) {
    const tag = B.cellRecords[o], stride = u16(B.cellRecords, o + 4);
    const r = B.cellRecords.subarray(o, o + stride);
    if (tag === 1) {
      patches.push({ x: r[2], y: r[3], tiles: [0, 1, 2, 3].map((i) => tokenOf(u16(r, 8 + 2 * i))), collision: ctx.collisionName(r[0x10]) });
      if (stride !== N.CELL_PATCH_SIZE || u16(r, 6) !== 0xffff || r[0x11] !== 0xff) throw new Error(`room ${nat.roomId}: unusual patch record`);
    } else if (tag === 3) {
      doorCells.push({ x: r[2], y: r[3], to: u16(r, 8), ax: r[10], ay: r[11], flags: r[12] });
      if (stride !== N.CELL_DOOR_SIZE || u16(r, 6) !== 0xffff || r[0x0d] !== 0xff) throw new Error(`room ${nat.roomId}: unusual door record`);
    } else throw new Error(`room ${nat.roomId}: cell record tag ${tag}`);
    o += stride;
  }
  if (patches.length) doc.patches = patches;

  // doors: one per (to, ax, ay), in progress-list order (the save bit order)
  const prog = [];
  for (let o = 0; o < B.progress.length; o += 8) {
    const e = B.progress.subarray(o, o + 8);
    prog.push(e[0] === 1 ? { tag: 1, x: s16(e, 4), y: s16(e, 6) } : { tag: 2, to: u16(e, 4), ax: e[6], ay: e[7] });
  }
  const doors = [];
  for (const p of prog.filter((p) => p.tag === 2)) {
    const cells = doorCells.filter((c) => c.to === p.to && c.ax === p.ax && c.ay === p.ay);
    const flags = [...new Set(cells.map((c) => c.flags))];
    const d = { to: ctx.roomRef(p.to), arrive: { x: p.ax, y: p.ay }, cells: cells.map((c) => [c.x, c.y]) };
    if (flags.length === 1) { if (flags[0] !== DOOR_FLAG_DEFAULT) d.flags = flags[0]; } else d.cellFlags = cells.map((c) => c.flags);
    doors.push(d);
  }
  if (doors.length) doc.doors = doors;

  // objects
  const objs = [];
  for (let o = 0, i = 0; o < B.templates.length; o += B.templates[o + 1], i++) {
    const v = N.readFields(B.templates, N.TEMPLATE_FIELDS, o);
    const ob = { id: `o${i}`, type: vocab.objectTypeName[v.type] ?? v.type, x: v.x, y: v.y };
    const params = reg.objectParams(v.type);
    const raw = {};
    const pnamed = {};
    for (const [f] of N.TEMPLATE_FIELDS) {
      if (TEMPLATE_CORE.has(f) || TEMPLATE_DERIVED.has(f)) continue;
      const val = v[f];
      const def = TEMPLATE_DEFAULTS[f] ?? 0;
      if (val === def) continue;
      const pn = reg.nameOf(params[f]);
      const gn = reg.semName('object_template', f);
      if (pn) pnamed[pn] = val; else if (gn) ob[gn] = val; else raw[f] = val;
    }
    if (B.templates[o + 1] !== N.TEMPLATE_SIZE) ob.stride = B.templates[o + 1];
    if (Object.keys(pnamed).length) ob.params = pnamed;
    if (Object.keys(raw).length) ob.raw = raw;
    objs.push(ob);
  }
  doc.objects = objs;

  // nav graph (AI-Kirby): node map + nodes + 4 scripts
  const nn = B.navHeader[0x18];
  const nav = encodeGrid(Array.from(B.navMap), W, H, { suggest: (v) => NAV_KEYS[v] || null });
  nav.nodes = [];
  for (let i = 0; i < nn; i++) {
    const r = B.navNodes.subarray(i * N.NAV_NODE_SIZE, (i + 1) * N.NAV_NODE_SIZE);
    nav.nodes.push({ x: u16(r, 0x20), y: u16(r, 0x22), radius: u16(r, 0x24), nextHop: hexOf(r.subarray(0, 0x20)), extra: hexOf(r.subarray(0x26, 0x34)) });
  }
  nav.scripts = [0, 1, 2, 3].map((i) => words(B[`navScript${i}`]));
  doc.nav = nav;
  return doc;
}

const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s, where) => {
  if (typeof s !== 'string' || !/^([0-9a-f]{2})*$/.test(s)) throw new RoomError('expected lowercase hex bytes', where);
  return Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
};
function words(b) { const out = []; for (let i = 0; i + 1 < b.length - 2; i += 2) out.push(u16(b, i)); return out; }

// ----------------------------------------------------------------- compile

/** -> {blobs, roomId, content, refs, derived} ; throws RoomError with .where */
export function compileRoom(doc, ctx) {
  const { vocab, registry: reg } = ctx;
  const W = doc.size && doc.size.width, H = doc.size && doc.size.height;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 15 || H < 10) throw new RoomError('size.width/height must be integers (16-px cells), at least 15x10 (one screen)', 'size');
  const roomId = ctx.roomNum(doc.id);
  const content = ctx.contentOf(doc.id);
  const B = {};

  // RoomProps
  const P = freeIn(reg, 'room_props', doc.props, doc.raw, PROP_FREE, PROP_DEFAULTS, 'room');
  const song = typeof doc.music === 'number' ? doc.music : vocab.songs[doc.music];
  if (song === undefined) throw new RoomError(`unknown music "${doc.music}"`, 'music', 'use a song name from vocab.json (e.g. "mus_rainbow_route") or a number');
  P.songIdx = song;
  P.pixelDataIdx = ctx.refIdx('tileset', doc.tileset, 'tileset');
  P.paletteDataIdx = ctx.refIdx('palette', doc.palette, 'palette');
  P.backgroundIdx = ctx.refIdx('background', doc.background, 'background');
  P.mapDataIdx = P.solidityMapIdx = P.objectListIdx = P.unk22 = P.doorsIdx = content;
  P.objectList2Idx = 0xffff;
  P.unk26_0 = P.unk26_1 = 0;
  B.props = N.writeFields(N.ROOM_PROPS_FIELDS, P, N.ROOM_PROPS_SIZE);

  // fg layer header
  const wt = W * 2, ht = H * 2;
  B.fgHeader = new Uint8Array(N.TILED_BG_SIZE);
  put(B.fgHeader, 0, 2, wt); put(B.fgHeader, 2, 2, ht);
  put(B.fgHeader, 0x1e, 2, doc.fgLayerRoomTag ?? roomId);

  // art
  let art;
  try { art = decodeGrid(doc.art, W, H, 'art'); } catch (e) { throw new RoomError(e.message, e.where || 'art'); }
  const tm = new Uint8Array(wt * ht * 2);
  art.forEach((m, i) => {
    let four;
    try { four = metaValues(m); } catch (e) { throw new RoomError(e.message, 'art.legend'); }
    const cx = i % W, cy = (i / W) | 0, t = cy * 2 * wt + cx * 2;
    [t, t + 1, t + wt, t + wt + 1].forEach((k, j) => put(tm, k * 2, 2, four[j]));
  });
  B.fgTilemap = tm;
  B.fgTilemapPacked = encodeLZ77(tm);

  // collision
  let col;
  try { col = decodeGrid(doc.collision, W, H, 'collision'); } catch (e) { throw new RoomError(e.message, e.where || 'collision'); }
  const cmap = Uint8Array.from(col.map((v) => ctx.collisionValue(v, 'collision.legend')));
  if (cmap.length > N.COLLISION_CAP) throw new RoomError(`room has ${cmap.length} cells; the game's per-room buffer holds ${N.COLLISION_CAP}`, 'size', `shrink to width*height <= ${N.COLLISION_CAP}`);
  B.collision = cmap;
  B.collisionPacked = encodeRL(cmap);

  // cell records: patches + door cells, sorted by (y, x), keyed by the collision value there
  const recs = [];
  (doc.patches || []).forEach((p, i) => {
    const w = `patches[${i}]`;
    inBounds(p.x, p.y, W, H, w);
    const r = new Uint8Array(N.CELL_PATCH_SIZE);
    r[0] = 1; r[1] = cmap[p.y * W + p.x]; r[2] = p.x; r[3] = p.y; put(r, 4, 2, N.CELL_PATCH_SIZE); put(r, 6, 2, 0xffff);
    if (!Array.isArray(p.tiles) || p.tiles.length !== 4) throw new RoomError('tiles must be 4 tile tokens', `${w}.tiles`);
    p.tiles.forEach((t, j) => { try { put(r, 8 + 2 * j, 2, valueOf(t)); } catch (e) { throw new RoomError(e.message, `${w}.tiles[${j}]`); } });
    r[0x10] = ctx.collisionValue(p.collision, `${w}.collision`); r[0x11] = 0xff;
    recs.push({ x: p.x, y: p.y, r, key: p.key });
  });
  const doors = doc.doors || [];
  doors.forEach((d, i) => {
    const w = `doors[${i}]`;
    const to = ctx.roomNum(d.to, `${w}.to`);
    if (!d.arrive || !Number.isInteger(d.arrive.x) || !Number.isInteger(d.arrive.y)) throw new RoomError('arrive {x, y} (cells in the destination room) is required', `${w}.arrive`);
    if (!Array.isArray(d.cells) || !d.cells.length) throw new RoomError('a door needs at least one cell', `${w}.cells`);
    d.cells.forEach(([x, y], j) => {
      inBounds(x, y, W, H, `${w}.cells[${j}]`);
      const r = new Uint8Array(N.CELL_DOOR_SIZE);
      r[0] = 3; r[1] = cmap[y * W + x]; r[2] = x; r[3] = y; put(r, 4, 2, N.CELL_DOOR_SIZE); put(r, 6, 2, 0xffff);
      put(r, 8, 2, to); r[10] = d.arrive.x; r[11] = d.arrive.y;
      r[12] = d.cellFlags ? d.cellFlags[j] : (d.flags ?? DOOR_FLAG_DEFAULT); r[13] = 0xff;
      recs.push({ x, y, r });
    });
  });
  // Stable: on one cell, patches (in file order) come before door cells, as in vanilla.
  recs.sort((a, b) => a.y - b.y || a.x - b.x);
  // Key = the collision value the cell has when the record is looked up: the
  // map's value, or what an earlier patch on the same cell turned it into.
  for (let i = 0; i < recs.length; i++) {
    const { x, y, r } = recs[i];
    const prev = i && recs[i - 1].x === x && recs[i - 1].y === y ? recs[i - 1] : null;
    r[1] = prev ? (prev.r[0] === 1 ? prev.r[0x10] : prev.r[1]) : cmap[y * W + x];
    if (recs[i].key !== undefined) r[1] = recs[i].key;
  }
  B.cellRecords = concatU8(recs.map((r) => r.r));
  B.cellTerminator = Uint8Array.from(N.CELL_TERMINATOR);

  // objects
  const objs = doc.objects || [];
  const tparts = [];
  const types = new Set();
  const chests = [];
  objs.forEach((ob, i) => {
    const w = `objects[${i}]`;
    const type = typeof ob.type === 'number' ? ob.type : vocab.objectTypes[ob.type];
    if (type === undefined) throw new RoomError(`unknown object type "${ob.type}"`, `${w}.type`, 'use a name from vocab.json objectTypes (e.g. "waddle_dee_1")');
    const v = {};
    for (const [f] of N.TEMPLATE_FIELDS) v[f] = TEMPLATE_DEFAULTS[f] ?? 0;
    v.type = type; v.x = ob.x; v.y = ob.y;
    v.unk1 = ob.stride ?? N.TEMPLATE_SIZE;
    const gmap = reg.nameMap('object_template');
    const pmap = {};
    for (const [f, e] of Object.entries(reg.objectParams(type))) { const n = reg.nameOf(e); if (n) pmap[n] = f; for (const a of e.aliases || []) pmap[a] = f; }
    for (const [k, val] of Object.entries(ob)) {
      if (['id', 'type', 'x', 'y', 'stride', 'params', 'raw', 'note'].includes(k)) continue;
      if (!gmap[k]) throw new RoomError(`unknown object field "${k}"`, `${w}.${k}`, 'put undecoded fields under raw.<cField> (e.g. raw.unk22)');
      v[gmap[k]] = val;
    }
    for (const [k, val] of Object.entries(ob.params || {})) {
      if (!pmap[k]) throw new RoomError(`"${k}" is not a parameter of ${ob.type}`, `${w}.params.${k}`, `known: ${Object.keys(pmap).join(', ') || '(none decoded yet; use raw)'}`);
      v[pmap[k]] = val;
    }
    for (const [k, val] of Object.entries(ob.raw || {})) {
      if (!(k in v)) throw new RoomError(`raw.${k} is not an ObjectTemplate field`, `${w}.raw.${k}`);
      v[k] = val;
    }
    const rec = new Uint8Array(v.unk1);
    for (const [f, o, s] of N.TEMPLATE_FIELDS) put(rec, o, s, v[f]);
    tparts.push(rec);
    types.add(type);
    if (CHEST_TYPES.has(type)) chests.push({ x: v.x, y: v.y });
  });
  B.templates = concatU8(tparts);
  B.objTerminator = Uint8Array.from(N.OBJ_TERMINATOR);
  B.objTypes = Uint8Array.from([...types].sort((a, b) => a - b));
  B.objTypes2 = new Uint8Array(0);
  B.objHeader = new Uint8Array(0x10);
  B.objHeader[0x0c] = B.objTypes.length;

  // progress list: chests (object order), then door shadows (door order)
  const pe = [];
  for (const c of chests) { const e = new Uint8Array(8); e[0] = 1; e[1] = 8; e[2] = e[3] = 0xff; put(e, 4, 2, c.x); put(e, 6, 2, c.y); pe.push(e); }
  doors.forEach((d) => { const e = new Uint8Array(8); e[0] = 2; e[1] = 8; e[2] = e[3] = 0xff; put(e, 4, 2, ctx.roomNum(d.to)); e[6] = d.arrive.x; e[7] = d.arrive.y; pe.push(e); });
  if (pe.length > 15) throw new RoomError(`${pe.length} chests+doors; the save keeps 15 bits per room`, 'doors');
  B.progress = concatU8(pe);
  B.progressTerminator = Uint8Array.from(N.PROGRESS_TERMINATOR);
  B.progressHeader = new Uint8Array(8);
  B.progressHeader[4] = chests.length;

  // nav
  const nav = doc.nav || defaultNav(W, H, cmap);
  let nmap;
  try { nmap = decodeGrid(nav, W, H, 'nav'); } catch (e) { throw new RoomError(e.message, e.where || 'nav'); }
  const nodes = nav.nodes || [];
  if (!nodes.length || nodes.length > N.NAV_MAX_NODES) throw new RoomError(`nav needs 1..${N.NAV_MAX_NODES} nodes`, 'nav.nodes');
  // (vanilla room 516 names a node past its count; the validator warns, the compiler keeps it)
  nmap.forEach((v) => { if (!Number.isInteger(v) || v < 0 || v > 255) throw new RoomError(`nav map value ${v} is not a node index 0-255`, 'nav.legend'); });
  B.navMap = Uint8Array.from(nmap);
  B.navMapPacked = encodeRL(B.navMap);
  B.navNodes = new Uint8Array(nodes.length * N.NAV_NODE_SIZE);
  nodes.forEach((nd, i) => {
    const r = B.navNodes.subarray(i * N.NAV_NODE_SIZE, (i + 1) * N.NAV_NODE_SIZE);
    r.set(unhex(nd.nextHop, `nav.nodes[${i}].nextHop`).subarray(0, 0x20));
    put(r, 0x20, 2, nd.x); put(r, 0x22, 2, nd.y); put(r, 0x24, 2, nd.radius ?? 32);
    r.set(unhex(nd.extra ?? '0'.repeat(28), `nav.nodes[${i}].extra`).subarray(0, 14), 0x26);
  });
  B.navHeader = new Uint8Array(0x1c);
  B.navHeader[0x18] = nodes.length;
  const scripts = nav.scripts || [[], [], [], []];
  for (let i = 0; i < 4; i++) {
    const ws = scripts[i] || [];
    const b = new Uint8Array(ws.length * 2 + 2);
    ws.forEach((x, j) => put(b, j * 2, 2, x));
    put(b, ws.length * 2, 2, 0xffff);
    B[`navScript${i}`] = b;
  }

  return {
    roomId, content, blobs: B,
    refs: { tileset: P.pixelDataIdx, palette: P.paletteDataIdx, background: P.backgroundIdx },
    props: P,
  };
}

/** A one-node nav graph for rooms that do not define one: every cell is node
 *  0 at the room centre, scripts are a bare halt.  Helper (CPU) Kirbys will
 *  idle in such a room; see docs/design/authoring/rooms.md "nav". */
export function defaultNav(W, H) {
  const row = '0'.repeat(W);
  return {
    legend: { 0: 0 }, rows: Array(H).fill(row),
    nodes: [{ x: W * 8, y: H * 8, radius: 32, nextHop: '00' + 'ff'.repeat(31), extra: '0000' + '00ff' + '00'.repeat(10) }],
    scripts: [[], [], [], []],
  };
}

function inBounds(x, y, W, H, where) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= W || y >= H) {
    throw new RoomError(`cell (${x}, ${y}) is outside the ${W}x${H} room`, where, `0 <= x < ${W}, 0 <= y < ${H}`);
  }
}

function concatU8(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export { GridError };
