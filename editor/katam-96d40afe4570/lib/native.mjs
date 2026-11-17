// The runtime ("native") layer: GBA-shaped records and payloads, exactly as the
// game reads them.  This module is the ONLY place that knows those layouts.
//
// A native value is plain data: Uint8Array blobs whose pointer fields are left
// zero, plus `links` naming what each pointer field points at.  Placement (ROM
// addresses for identity, arena addresses for a mod) is a separate, later step,
// so two natives can be compared blob by blob without caring where either lives.
//
//   readRoomNative(rom, roomId)      ROM -> native        (decompile input, gate reference)
//   readTilesetNative(rom, idx)      gForegroundInfo[idx]
//   readBackgroundNative(rom, idx)   gRoomTiledBGs[idx]
//   compareNative(a, b)              blob-by-blob diff for the round-trip gate
//
// Layout facts and where they were established are in docs/ROOM-FORMAT.md,
// docs/naming/room-tables.md and docs/naming/doors.md; every terminator size
// below was measured over all 286 rooms (docs/design/authoring/rooms.md).
import { u8, u16, u32, put } from './bytes.mjs';
import { decompress } from './compress.mjs';

export const ROOM_PROPS_SIZE = 0x28;
export const NUM_ROOM_SLOTS = 983;
export const NUM_CONTENT = 287;
export const TILED_BG_SIZE = 0x20;
export const TEMPLATE_SIZE = 0x24;
export const CELL_PATCH_SIZE = 0x12;      // struct Unk_0888562C   (tag 1)
export const CELL_DOOR_SIZE = 0x0e;       // struct Unk_0888562C_3 (tag 3)
export const NAV_NODE_SIZE = 0x34;        // struct LevelInfo_1E8_14
export const COLLISION_CAP = 1950;        // sizeof gUnk_02024ED0[slot]
export const NAV_MAX_NODES = 32;          // LevelInfo_1E8_14.unk0[0x20]

// Terminators, measured on every vanilla list (all 286 rooms, one shape each).
export const OBJ_TERMINATOR = Uint8Array.from([0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
export const CELL_TERMINATOR = Uint8Array.from([0, 0, 0, 0, 0, 0, 0xff, 0xff]);
export const PROGRESS_TERMINATOR = Uint8Array.from([0, 0, 0xff, 0xff]);

/** RoomProps field table: [name, offset, size, signed] */
export const ROOM_PROPS_FIELDS = [
  ['songIdx', 0, 2, false], ['unk02', 2, 2, false], ['unk04', 4, 2, false],
  ['unkXmod_06', 6, 2, true], ['unkXmod_08', 8, 2, true], ['unk0A', 10, 2, false],
  ['unk0C', 12, 2, false], ['unk0E', 14, 2, true], ['unk10', 16, 2, true],
  ['priorityFlags', 18, 2, false], ['pixelDataIdx', 20, 2, false], ['paletteDataIdx', 22, 2, false],
  ['mapDataIdx', 24, 2, false], ['solidityMapIdx', 26, 2, false], ['objectList2Idx', 28, 2, false],
  ['backgroundIdx', 30, 2, false], ['objectListIdx', 32, 2, false], ['unk22', 34, 2, false],
  ['doorsIdx', 36, 2, false], ['unk26_0', 38, 1, false], ['unk26_1', 39, 1, false],
];

/** struct ObjectTemplate (include/data.h): [name, offset, size, signed] */
export const TEMPLATE_FIELDS = [
  ['spawnTable', 0, 1, false], ['unk1', 1, 1, false], ['unk2', 2, 1, false], ['unk3', 3, 1, false],
  ['unk4', 4, 1, false], ['unk5', 5, 1, false], ['x', 6, 2, true], ['y', 8, 2, true],
  ['unkA', 10, 1, false], ['unkB', 11, 1, false], ['type', 12, 1, false], ['unkD', 13, 1, false],
  ['subtype1', 14, 1, false], ['unkF', 15, 1, false], ['subtype2', 16, 1, false], ['unk11', 17, 1, false],
  ['unk12', 18, 2, false], ['unk14', 20, 2, false], ['unk16', 22, 2, false], ['unk18', 24, 2, false],
  ['unk1A', 26, 2, true], ['unk1C', 28, 2, true], ['unk1E', 30, 2, false], ['unk20', 32, 2, false],
  ['unk22', 34, 2, false],
];

export function getField(b, off, size, signed) {
  let v = size === 1 ? b[off] : size === 2 ? u16(b, off) : u32(b, off);
  if (signed) v = size === 1 ? (v << 24) >> 24 : size === 2 ? (v << 16) >> 16 : v | 0;
  return v;
}

export function setField(b, off, size, v) {
  put(b, off, size, v);
}

export function readFields(b, fields, base = 0) {
  const out = {};
  for (const [n, o, s, sg] of fields) out[n] = getField(b, base + o, s, sg);
  return out;
}

export function writeFields(fields, values, size) {
  const b = new Uint8Array(size);
  for (const [n, o, s] of fields) setField(b, o, s, values[n] ?? 0);
  return b;
}

/** Room ids that are real rooms (the other slots are 0xFFFF filler). */
export function vanillaRoomIds(rom) {
  const base = rom.table('gRoomProps');
  const out = [];
  for (let r = 0; r < NUM_ROOM_SLOTS; r++) if (rom.u16(base + r * ROOM_PROPS_SIZE + 0x20) < NUM_CONTENT) out.push(r);
  return out;
}

function copy(b) { return Uint8Array.from(b); }

function zeroed(b, offs) {
  const c = copy(b);
  for (const o of offs) put(c, o, 4, 0);
  return c;
}

function lz(rom, addr) {
  const d = decompress(rom.from(addr));
  return { data: d.data, packed: copy(rom.slice(addr, (d.consumed + 3) & ~3)) };
}

/** Walk a self-striding list.  strideAt(addr) -> stride (0 ends). Returns [records..., end]. */
function walk(rom, addr, tagOf, strideOf) {
  const recs = [];
  for (let n = 0; ; n++) {
    if (n > 4096) throw new Error(`list at 0x${addr.toString(16)} does not terminate`);
    const st = strideOf(addr);
    if (tagOf(addr) === 0 || st === 0) return { recs, end: addr };
    recs.push({ addr, stride: st });
    addr += st;
  }
}

/** Everything one room owns, as native blobs.  Shared resources (tileset,
 *  fg palette, background) are referenced by index, not copied. */
export function readRoomNative(rom, roomId) {
  const pAddr = rom.table('gRoomProps') + roomId * ROOM_PROPS_SIZE;
  const propsBytes = copy(rom.slice(pAddr, ROOM_PROPS_SIZE));
  const props = readFields(propsBytes, ROOM_PROPS_FIELDS);
  const n = { roomId, props, blobs: {} };
  const B = n.blobs;
  B.props = propsBytes;

  // Playfield layer (BG3): RoomTiledBG + LZ77 tilemap.  Its tileset/palette
  // fields are zero in every vanilla entry; the real ones come via
  // gForegroundInfo / gForegroundPalettes.
  const fg = rom.entry('gForegroundTilemaps', props.mapDataIdx);
  const fgHdr = rom.slice(fg, TILED_BG_SIZE);
  for (const o of [0x08, 0x10]) if (u32(fgHdr, o)) throw new Error(`room ${roomId}: fg layer has its own tileset/palette pointer (not seen in vanilla)`);
  B.fgHeader = zeroed(fgHdr, [0x18]);
  const fgTm = lz(rom, rom.ptr(fg + 0x18));
  B.fgTilemap = fgTm.data;
  B.fgTilemapPacked = fgTm.packed;
  n.widthTiles = u16(fgHdr, 0);
  n.heightTiles = u16(fgHdr, 2);

  // Extra layer (BG2): never used in vanilla (objectList2Idx == 0xFFFF everywhere).
  if (props.objectList2Idx !== 0xffff) throw new Error(`room ${roomId}: extra BG layer present (not seen in vanilla)`);

  // Collision: RL map + cell records (tag 1 patch, tag 3 door), sorted by (y, x).
  const sm = rom.entry('gSolidityMaps', props.solidityMapIdx);
  const col = lz(rom, rom.ptr(sm));
  B.collision = col.data;
  B.collisionPacked = col.packed;
  const cl = walk(rom, rom.u32(sm + 4), (a) => rom.u8(a), (a) => rom.u16(a + 4));
  B.cellRecords = copy(rom.slice(cl.recs.length ? cl.recs[0].addr : cl.end, cl.end - (cl.recs.length ? cl.recs[0].addr : cl.end)));
  B.cellTerminator = copy(rom.slice(cl.end, CELL_TERMINATOR.length));

  // Object list: LevelInfo_1E4 header, templates, derived type set.
  const ol = rom.entry('gLevelObjLists', props.objectListIdx);
  const olHdr = rom.slice(ol, 0x10);
  const tl = walk(rom, rom.ptr(ol), () => 1, (a) => rom.u8(a + 1));
  const t0 = tl.recs.length ? tl.recs[0].addr : tl.end;
  B.templates = copy(rom.slice(t0, tl.end - t0));
  B.objTerminator = copy(rom.slice(tl.end, OBJ_TERMINATOR.length));
  B.objHeader = zeroed(olHdr, [0, 4, 8]);
  B.objTypes = copy(rom.slice(u32(olHdr, 4), olHdr[0x0c]));
  B.objTypes2 = copy(rom.slice(u32(olHdr, 8), olHdr[0x0d]));

  // Progress list (gUnk_08D640A4): chests then door shadows, 8-byte entries.
  const pl = rom.entry('gUnk_08D640A4', props.doorsIdx);
  const plHdr = rom.slice(pl, 8);
  const pw = walk(rom, rom.u32(pl), (a) => rom.u8(a + 1), (a) => rom.u8(a + 1));
  const p0 = pw.recs.length ? pw.recs[0].addr : pw.end;
  B.progress = copy(rom.slice(p0, pw.end - p0));
  B.progressTerminator = copy(rom.slice(pw.end, PROGRESS_TERMINATOR.length));
  B.progressHeader = zeroed(plHdr, [0]);

  // Nav graph (gUnk_08D63C28): 4 per-player scripts (u16, 0xFFFF-terminated),
  // RL node map, node array.
  const nv = rom.entry('gUnk_08D63C28', props.unk22);
  const nvHdr = rom.slice(nv, 0x1c);
  B.navHeader = zeroed(nvHdr, [0, 4, 8, 12, 0x10, 0x14]);
  for (let i = 0; i < 4; i++) {
    let a = rom.ptr(nv + 4 * i), len = 0;
    while (rom.u16(a + len) !== 0xffff) { len += 2; if (len > 0x2000) throw new Error('nav script does not terminate'); }
    B[`navScript${i}`] = copy(rom.slice(a, len + 2));
  }
  const nm = lz(rom, rom.ptr(nv + 0x10));
  B.navMap = nm.data;
  B.navMapPacked = nm.packed;
  B.navNodes = copy(rom.slice(rom.ptr(nv + 0x14), nvHdr[0x18] * NAV_NODE_SIZE));

  n.refs = { tileset: props.pixelDataIdx, palette: props.paletteDataIdx, background: props.backgroundIdx };
  return n;
}

/** gForegroundInfo[idx]: LZ77 tileset for char block 2 + tile animations. */
export function readTilesetNative(rom, idx) {
  const fi = rom.entry('gForegroundInfo', idx);
  const hdr = rom.slice(fi, 0x10);
  const B = {};
  B.header = zeroed(hdr, [0, 4, 8]);
  const ts = lz(rom, u32(hdr, 0));
  B.tiles = ts.data;
  B.tilesPacked = ts.packed;
  const nAnims = u16(hdr, 0x0c);
  const anims = [];
  let gfxEnd = 0;
  for (let i = 0; i < nAnims; i++) {
    const a = u32(hdr, 8) + i * 0x14;
    const rec = rom.slice(a, 0x14);
    const nFrames = u16(rec, 0x10), nChunks = u16(rec, 0x12), copySize = u32(rec, 4), stride = u32(rec, 8);
    const frames = copy(rom.slice(u32(rec, 0x0c), nFrames * 8));
    for (let f = 0; f < nFrames; f++) {
      const end = u32(frames, f * 8) + (nChunks - 1) * stride + copySize;
      if (end > gfxEnd) gfxEnd = end;
    }
    anims.push({ record: zeroed(rec, [0x0c]), frames });
  }
  B.anims = anims;
  B.animGfx = nAnims ? copy(rom.slice(u32(hdr, 4), gfxEnd)) : new Uint8Array(0);
  return { idx, roomId: u16(hdr, 0x0e), blobs: B, animGfxPtr: u32(hdr, 4) };
}

/** gRoomTiledBGs[idx]: shared background layer (BG0): LZ77 tiles, raw palette, raw tilemap. */
export function readBackgroundNative(rom, idx) {
  const a = rom.entry('gRoomTiledBGs', idx);
  const hdr = rom.slice(a, TILED_BG_SIZE);
  const w = u16(hdr, 0), h = u16(hdr, 2);
  const B = {};
  B.header = zeroed(hdr, [0x08, 0x10, 0x18]);
  const ts = lz(rom, u32(hdr, 0x08));
  B.tiles = ts.data;
  B.tilesPacked = ts.packed;
  B.palette = copy(rom.slice(u32(hdr, 0x10), u16(hdr, 0x16) * 2));
  B.tilemap = copy(rom.slice(u32(hdr, 0x18), w * h * 2));
  return { idx, width: w, height: h, blobs: B };
}

/** Compare two natives blob by blob.  -> [{blob, a, b, at}] for every difference. */
export function compareBlobs(a, b, prefix = '') {
  const diffs = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k], y = b[k];
    const name = prefix + k;
    if (x instanceof Uint8Array || y instanceof Uint8Array) {
      if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) { diffs.push({ blob: name, why: 'missing on one side' }); continue; }
      if (x.length !== y.length) { diffs.push({ blob: name, why: `length ${x.length} != ${y.length}` }); continue; }
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { diffs.push({ blob: name, why: `byte ${i}: 0x${x[i].toString(16)} != 0x${y[i].toString(16)}` }); break; }
    } else if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) { diffs.push({ blob: name, why: 'array length' }); continue; }
      x.forEach((e, i) => diffs.push(...compareBlobs(e, y[i], `${name}[${i}].`)));
    } else if (x && typeof x === 'object') {
      diffs.push(...compareBlobs(x, y || {}, name + '.'));
    }
  }
  return diffs;
}

export { u8 };

// ------------------------------------------------------------ room bundles
//
// katam-native/1: the room bundle the runtime loads (MODDING.md R2;
// platform/res_rooms.c).  A position-independent object file: blobs, the
// pointer fields inside them (relocations), and table entries that say which
// blob a game table slot points at (or, for an array table, which blob is the
// record itself).  The runtime places the blobs in the resource arena, grows
// each named table past its vanilla extent when an index needs it, and patches
// the pointers -- it knows no room layout; every layout fact stays here.
//
//   0x00 "KATN"  u32 version (1)  u32 nBlobs  u32 nRelocs  u32 nEntries
//   0x14 u32 dataOffset  u32 totalSize  u32 0
//   0x20 nBlobs   x {u32 offset (from dataOffset), u32 size, u32 align, u32 0}
//        nRelocs  x {u32 blob, u32 at, u32 target blob, u32 addend}: blob[at] = &target + addend
//        nEntries x {char table[24] (NUL-padded rom_tables.h label), u32 index, u32 blob, u32 inline}
//   dataOffset: the blob bytes, each 4-aligned
//
// The bytes are a function of the compiled content only (no addresses), so
// their SHA-256 is the bundle's term in the content hash.

export const BUNDLE_FORMAT = 'katam-native/1';
export const BUNDLE_MAGIC = 'KATN';
export const BUNDLE_VERSION = 1;
const TABLE_NAME_LEN = 24;

/** The game tables a bundle may name: [label, vanilla count, inline record size or 0 for a pointer table]. */
export const BUNDLE_TABLES = {
  gRoomProps: [NUM_ROOM_SLOTS, ROOM_PROPS_SIZE],
  gForegroundTilemaps: [NUM_CONTENT, 0],
  gSolidityMaps: [NUM_CONTENT, 0],
  gLevelObjLists: [NUM_CONTENT, 0],
  gUnk_08D640A4: [NUM_CONTENT, 0],
  gUnk_08D63C28: [NUM_CONTENT, 0],
  gForegroundInfo: [34, 0],
  gRoomTiledBGs: [36, 0],
  gUnk_08D6CD0C: [1000, 0],      // room -> struct Unk_08D6CD0C: AI room graph + area (1000 slots, 286 used)
  gUnk_0893CB44: [984, 2],       // room -> default cell (u8 x, u8 y), read by sub_08002D40
};

/** vocab area name -> Unk_08D6CD0C.unk46 (the switch in pause_world_map.c WorldMapGetCoorFromRoom). */
export const AREA_UNK46 = {
  rainbow_route: 0, moonlight_mansion: 1, cabbage_cavern: 2, mustard_mountain: 3, carrot_castle: 4,
  olive_ocean: 5, peppermint_palace: 6, radish_ruins: 7, candy_constellation: 8, tutorial: 9, dimension_mirror: 10,
};
export const ROOM_GRAPH_SIZE = 0x4c;

class Linker {
  constructor() { this.blobs = []; this.relocs = []; this.entries = []; }
  blob(bytes, align = 4) { this.blobs.push({ bytes: bytes.length ? bytes : new Uint8Array(4), align }); return this.blobs.length - 1; }
  /** a record whose pointer fields (`ptrs`: {offset: target blob}) the runtime fills */
  record(bytes, ptrs) {
    const b = this.blob(Uint8Array.from(bytes));
    for (const [at, t] of Object.entries(ptrs)) { put(this.blobs[b].bytes, Number(at), 4, 0); this.relocs.push([b, Number(at), t, 0]); }
    return b;
  }
  entry(table, index, blob) {
    const T = BUNDLE_TABLES[table];
    if (!T) throw new Error(`bundle: ${table} is not a table the loader can grow`);
    if (T[1] && this.blobs[blob].bytes.length !== T[1]) throw new Error(`bundle: ${table} records are ${T[1]} bytes`);
    this.entries.push([table, index, blob, T[1] ? 1 : 0]);
  }
  bytes() {
    const nb = this.blobs.length, nr = this.relocs.length, ne = this.entries.length;
    const dataOffset = 0x20 + nb * 16 + nr * 16 + ne * (TABLE_NAME_LEN + 12);
    const offs = [];
    let at = 0;
    for (const b of this.blobs) { at = (at + 3) & ~3; offs.push(at); at += b.bytes.length; }
    const total = dataOffset + ((at + 3) & ~3);
    const out = new Uint8Array(total);
    for (let i = 0; i < 4; i++) out[i] = BUNDLE_MAGIC.charCodeAt(i);
    put(out, 4, 4, BUNDLE_VERSION); put(out, 8, 4, nb); put(out, 12, 4, nr); put(out, 16, 4, ne);
    put(out, 20, 4, dataOffset); put(out, 24, 4, total);
    let o = 0x20;
    this.blobs.forEach((b, i) => { put(out, o, 4, offs[i]); put(out, o + 4, 4, b.bytes.length); put(out, o + 8, 4, b.align); o += 16; });
    for (const [b, a, t, add] of this.relocs) { put(out, o, 4, b); put(out, o + 4, 4, a); put(out, o + 8, 4, t); put(out, o + 12, 4, add); o += 16; }
    for (const [name, idx, b, inl] of this.entries) {
      for (let i = 0; i < name.length; i++) out[o + i] = name.charCodeAt(i);
      put(out, o + TABLE_NAME_LEN, 4, idx); put(out, o + TABLE_NAME_LEN + 4, 4, b); put(out, o + TABLE_NAME_LEN + 8, 4, inl);
      o += TABLE_NAME_LEN + 12;
    }
    this.blobs.forEach((b, i) => out.set(b.bytes, dataOffset + offs[i]));
    return out;
  }
}

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Link compiled rooms ({roomId, content, blobs}), tilesets and backgrounds
 *  ({idx, blobs}) into a katam-native/1 bundle.  Every pointer field is a
 *  relocation; the field sets are the ones readRoomNative & co. zero. */
export function linkBundle({ rooms = [], tilesets = [], backgrounds = [] }) {
  const L = new Linker();
  for (const r of [...rooms].sort((a, b) => a.roomId - b.roomId)) {
    const B = r.blobs, c = r.content;
    if (r.roomId >= 0x10000 - 1) throw new Error(`room id ${r.roomId} does not fit the game's u16 (0xFFFF means "no room")`);
    L.entry('gRoomProps', r.roomId, L.blob(Uint8Array.from(B.props)));
    // playfield layer: RoomTiledBG, tilemap pointer at 0x18 (tileset/palette 0: vanilla never sets them)
    L.entry('gForegroundTilemaps', c, L.record(B.fgHeader, { 0x18: L.blob(B.fgTilemapPacked) }));
    // collision: SolidityMap {RL map, cell records + terminator}
    L.entry('gSolidityMaps', c, L.record(new Uint8Array(8), { 0: L.blob(B.collisionPacked), 4: L.blob(cat(B.cellRecords, B.cellTerminator)) }));
    // objects: LevelInfo_1E4 {templates + terminator, type set, second type set, counts}
    L.entry('gLevelObjLists', c, L.record(B.objHeader, { 0: L.blob(cat(B.templates, B.objTerminator)), 4: L.blob(B.objTypes), 8: L.blob(B.objTypes2) }));
    // progress list (chests, door shadows): {entries + terminator, counts}
    L.entry('gUnk_08D640A4', c, L.record(B.progressHeader, { 0: L.blob(cat(B.progress, B.progressTerminator)) }));
    // nav graph: LevelInfo_1E8 {4 scripts, RL node map, nodes, count}
    const nav = { 0x10: L.blob(B.navMapPacked), 0x14: L.blob(B.navNodes) };
    for (let i = 0; i < 4; i++) nav[4 * i] = L.blob(B[`navScript${i}`]);
    L.entry('gUnk_08D63C28', c, L.record(B.navHeader, nav));
    // Only for rooms past the original ids: vanilla rooms keep the game's own
    // room-graph record and default cell.
    if (r.roomId >= NUM_ROOM_SLOTS) {
      // struct Unk_08D6CD0C: no neighbour list (unk48 = 0), unk47 = 0x80 (the
      // AI helpers' "not a routing target" flag: sub_080140B0/sub_080141EC
      // then send a helper back to its previous goal), the area, the room id.
      const g = new Uint8Array(ROOM_GRAPH_SIZE);
      put(g, 0x44, 2, r.roomId);
      g[0x46] = r.area ?? 0;
      g[0x47] = 0x80;
      L.entry('gUnk_08D6CD0C', r.roomId, L.record(g, { 0: L.blob(new Uint8Array(8)) }));
      L.entry('gUnk_0893CB44', r.roomId, L.blob(Uint8Array.from(r.spawn || [0, 0])));
    }
  }
  for (const t of [...tilesets].sort((a, b) => a.idx - b.idx)) {
    const B = t.blobs;
    // the animation records are one array (ForegroundInfo.unk8 + i*0x14), each with a frame-table pointer at 0x0c
    let animArr = -1;
    if (B.anims.length) {
      const frames = B.anims.map((a) => L.blob(a.frames));
      const arr = cat(...B.anims.map((a) => Uint8Array.from(a.record)));
      animArr = L.blob(arr);
      frames.forEach((f, k) => { put(arr, k * 0x14 + 0x0c, 4, 0); L.relocs.push([animArr, k * 0x14 + 0x0c, f, 0]); });
    }
    const ptrs = { 0: L.blob(B.tilesPacked), 4: L.blob(B.animGfx) };
    if (animArr >= 0) ptrs[8] = animArr;
    L.entry('gForegroundInfo', t.idx, L.record(B.header, ptrs));
  }
  for (const g of [...backgrounds].sort((a, b) => a.idx - b.idx)) {
    const B = g.blobs;
    L.entry('gRoomTiledBGs', g.idx, L.record(B.header, { 0x08: L.blob(B.tilesPacked), 0x10: L.blob(B.palette), 0x18: L.blob(B.tilemap) }));
  }
  return L.bytes();
}

/** Parse a bundle back (tests, `katam describe`): {blobs, relocs, entries}. */
export function readBundle(b) {
  if (String.fromCharCode(...b.subarray(0, 4)) !== BUNDLE_MAGIC) throw new Error('not a katam-native bundle (no KATN magic)');
  if (u32(b, 4) !== BUNDLE_VERSION) throw new Error(`bundle version ${u32(b, 4)}, this tool reads ${BUNDLE_VERSION}`);
  const nb = u32(b, 8), nr = u32(b, 12), ne = u32(b, 16), data = u32(b, 20);
  let o = 0x20;
  const blobs = [], relocs = [], entries = [];
  for (let i = 0; i < nb; i++, o += 16) blobs.push(b.subarray(data + u32(b, o), data + u32(b, o) + u32(b, o + 4)));
  for (let i = 0; i < nr; i++, o += 16) relocs.push({ blob: u32(b, o), at: u32(b, o + 4), target: u32(b, o + 8), addend: u32(b, o + 12) });
  for (let i = 0; i < ne; i++, o += TABLE_NAME_LEN + 12) {
    let n = '';
    for (let k = 0; k < TABLE_NAME_LEN && b[o + k]; k++) n += String.fromCharCode(b[o + k]);
    entries.push({ table: n, index: u32(b, o + TABLE_NAME_LEN), blob: u32(b, o + TABLE_NAME_LEN + 4), inline: u32(b, o + TABLE_NAME_LEN + 8) });
  }
  return { blobs, relocs, entries };
}
