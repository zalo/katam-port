// The two pipeline steps and the round-trip gate.
//
//   decompile: ROM + extracted pack -> authoring project (vanilla)
//   compile:   authoring project(s) -> runtime output
//                 <out>/pack/      the GBA-shaped JSON pack the game loads today
//                                  (--res-pack / --res-check): room_props,
//                                  fg_palette, obj_desc
//                 <out>/native/    GBA-native blobs for the kinds the game does
//                                  not load from a pack yet (room bundle,
//                                  tilesets, backgrounds), katam-native/0
//   gate:      compile(decompile(ROM)) == ROM, blob by blob
import { Rom, VANILLA_SHA1 } from './rom.mjs';
import * as N from './native.mjs';
import { decompileRoom, compileRoom, ROOM_FORMAT } from './room.mjs';
import { decompileTileset, compileTileset, decompileBackground, compileBackground, decompilePalette, compilePalette, rgbOf, GREY } from './gfx.mjs';
import { decompileObjectType, compileObjectType } from './objects.mjs';
import { readPack, writePack } from './pack.mjs';
import { loadProject, Bindings, makeContext, pathOf, parseId, PROJECT_FORMAT, vanillaRoomId } from './project.mjs';
import { writeJson } from './json.mjs';

export const NATIVE_FORMAT = 'katam-native/0';

// ---------------------------------------------------------------- decompile

export function decompileVanilla({ io, romBytes, romTables, packDir, pack: givenPack, vocab, registry, outDir, log = () => {} }) {
  const rom = new Rom(romBytes, romTables);
  const pack = givenPack || readPack(io, packDir);
  const ctx = makeContext({ vocab, registry, bindings: null });
  const write = (id, doc) => io.writeText(`${outDir}/${pathOf(id)}`, writeJson(doc));
  io.writeText(`${outDir}/project.json`, writeJson({
    format: PROJECT_FORMAT, id: 'vanilla', name: 'Kirby & The Amazing Mirror (decompiled from your ROM)',
    note: 'Derived from the ROM. Never commit or redistribute this folder.', romSha1: VANILLA_SHA1,
    registry: registry.sources.length ? registry.sources : 'none (all undecoded fields are raw.<cField>)',
  }));
  io.writeText(`${outDir}/.gitignore`, '# ROM-derived: never commit\n*\n');
  const counts = { rooms: 0, tilesets: 0, backgrounds: 0, palettes: 0, objects: 0 };

  const roomIds = N.vanillaRoomIds(rom);
  const tsUsed = new Set(), bgUsed = new Set();
  for (const r of roomIds) {
    const nat = N.readRoomNative(rom, r);
    write(vanillaRoomId(vocab, r), decompileRoom(nat, ctx));
    tsUsed.add(nat.refs.tileset); bgUsed.add(nat.refs.background);
    counts.rooms++;
  }
  // every table entry, used or not, so the tables round-trip whole
  for (let i = 0; i < countOf(rom, 'gForegroundInfo'); i++) {
    const nat = N.readTilesetNative(rom, i);
    const pal = pack.palettes.get(i);
    const { doc, files } = decompileTileset(nat, { ...ctx, previewPalette: () => (pal ? pal.colors[0].map(rgbOf) : GREY) });
    if (pal) doc.previewPalette = ctx.ref('palette', i);
    const base = `${outDir}/${pathOf(doc.id)}`.replace(/tileset\.json$/, '');
    io.writeText(base + 'tileset.json', writeJson(doc));
    for (const [n, b] of Object.entries(files)) io.writeBytes(base + n, b);
    counts.tilesets++;
  }
  for (let i = 0; i < countOf(rom, 'gRoomTiledBGs'); i++) {
    const nat = N.readBackgroundNative(rom, i);
    const { doc, files } = decompileBackground(nat, ctx);
    const base = `${outDir}/${pathOf(doc.id)}`.replace(/background\.json$/, '');
    io.writeText(base + 'background.json', writeJson(doc));
    for (const [n, b] of Object.entries(files)) io.writeBytes(base + n, b);
    counts.backgrounds++;
  }
  for (const [, p] of [...pack.palettes].sort((a, b) => a[0] - b[0])) { const d = decompilePalette(p, ctx); write(d.id, d); counts.palettes++; }
  for (const rec of pack.objDesc) { const d = decompileObjectType(rec, ctx); write(d.id, d); counts.objects++; }
  log(`decompiled ${counts.rooms} rooms, ${counts.tilesets} tilesets, ${counts.backgrounds} backgrounds, ${counts.palettes} palettes, ${counts.objects} object types`);
  return counts;
}

/** Entries in a pointer table, from the spacing of the tables (same as the manifest's extents). */
export const TABLE_COUNTS = { gForegroundInfo: 34, gRoomTiledBGs: 36, gForegroundTilemaps: 287, gSolidityMaps: 287, gLevelObjLists: 287, gUnk_08D640A4: 287, gUnk_08D63C28: 287 };
function countOf(rom, label) { return TABLE_COUNTS[label]; }

// ------------------------------------------------------------------ compile

export function loadStack(io, dirs) {
  return dirs.map((d) => loadProject(io, d));
}

export function compileStack({ io, layers, vocab, registry, external = false }) {
  const bindings = new Bindings(vocab, layers);
  const ctx = makeContext({ vocab, registry, bindings, external });
  const vanillaLayers = new Set(layers.filter((L) => L.project && L.project.id === 'vanilla').map((L) => L.dir));
  const out = { rooms: new Map(), tilesets: new Map(), backgrounds: new Map(), palettes: new Map(), objDesc: new Map(), errors: [], bindings, vocab, vanillaLayers, projectIds: new Map(layers.map((L) => [L.dir, (L.project && L.project.id) || L.dir.split('/').pop()])) };
  for (const [id, d] of [...bindings.docs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kind = parseId(id).kind;
    const readFile = (n) => io.readBytes(`${d.base}/${n}`);
    try {
      if (kind === 'room') { const c = compileRoom(d.doc, ctx); out.rooms.set(c.roomId, { id, project: d.project, ...c }); }
      else if (kind === 'tileset') out.tilesets.set(bindings.num.get(id), { id, project: d.project, ...compileTileset(d.doc, readFile) });
      else if (kind === 'background') out.backgrounds.set(bindings.num.get(id), { id, project: d.project, ...compileBackground(d.doc, readFile) });
      else if (kind === 'palette') out.palettes.set(bindings.num.get(id), compilePalette(d.doc));
      else if (kind === 'object') out.objDesc.set(d.doc.bind.type, compileObjectType(d.doc, ctx));
    } catch (e) {
      out.errors.push({ file: d.rel, project: d.project, where: e.where || '', message: e.message, hint: e.hint });
    }
  }
  return out;
}

const PACK_ROOM = (P) => {
  const r = {};
  for (const [n] of N.ROOM_PROPS_FIELDS) if (!n.startsWith('unk26')) r[n] = P[n];
  r.unk26 = [P.unk26_0, P.unk26_1];
  return r;
};

/** Write <out>/pack (when the stack covers every pack table entry) and <out>/native. */
export function writeOutput({ io, compiled, outDir, manifest, manifestSha256 }, sha256) {
  const report = { pack: null, native: { rooms: 0, tilesets: 0, backgrounds: 0 }, inBundle: [] };
  const FP = manifest.kinds.find((k) => k.kind === 'fg_palette'), OD = manifest.kinds.find((k) => k.kind === 'obj_desc');
  const missing = [];
  for (let i = 0; i < FP.count; i++) if (!compiled.palettes.has(i)) missing.push(`palette ${i}`);
  for (let i = 0; i < OD.count; i++) if (!compiled.objDesc.has(i)) missing.push(`object type ${i}`);
  if (!missing.length) {
    const rooms = new Map();
    for (const [rid, c] of compiled.rooms) if (rid < 983) rooms.set(rid, PACK_ROOM(c.props));
    writePack(io, `${outDir}/pack`, {
      manifest, manifestSha256, romSha1: VANILLA_SHA1, rooms, palettes: compiled.palettes,
      objDesc: [...compiled.objDesc.keys()].sort((a, b) => a - b).map((k) => compiled.objDesc.get(k)),
    }, sha256);
    report.pack = `${outDir}/pack`;
  } else report.packSkipped = `the stack does not define ${missing.length} pack entries (first: ${missing[0]}); compile with --base <vanilla project>`;

  const index = { format: NATIVE_FORMAT, rooms: [], tilesets: [], backgrounds: [] };
  const dump = (rel, blobs) => {
    for (const [k, v] of Object.entries(blobs)) {
      if (v instanceof Uint8Array) io.writeBytes(`${outDir}/native/${rel}/${k}.bin`, v);
      else if (Array.isArray(v)) v.forEach((e, i) => { for (const [kk, vv] of Object.entries(e)) io.writeBytes(`${outDir}/native/${rel}/${k}${i}.${kk}.bin`, vv); });
    }
  };
  for (const [rid, c] of [...compiled.rooms].sort((a, b) => a[0] - b[0])) {
    dump(`rooms/${rid}`, c.blobs);
    index.rooms.push({ id: c.id, roomId: rid, content: c.content, refs: c.refs });
    if (!compiled.vanillaLayers.has(c.project)) report.inBundle.push(c.id);
    report.native.rooms++;
  }
  for (const [i, t] of compiled.tilesets) { dump(`tilesets/${i}`, t.blobs); index.tilesets.push(i); report.native.tilesets++; }
  for (const [i, t] of compiled.backgrounds) { dump(`backgrounds/${i}`, t.blobs); index.backgrounds.push(i); report.native.backgrounds++; }
  io.writeText(`${outDir}/native/index.json`, writeJson(index));

  // The room bundle (katam-native/1) the runtime loads: every room, tileset
  // and background the stack defines above the decompiled vanilla project.
  // Written next to the pack (OUT/pack/rooms.katn: --res-pack OUT/pack) and as
  // a mod (OUT/mod: --res-pack <your vanilla pack> --mod OUT/mod, or --mod
  // alone over the ROM).
  const b = bundleOf(compiled);
  report.bundle = { rooms: b.rooms.map((r) => [r.id, r.roomId]), tilesets: b.tilesets.length, backgrounds: b.backgrounds.length, bytes: b.bytes.length, sha256: b.bytes.length ? sha256(b.bytes) : null };
  if (b.rooms.length || b.tilesets.length || b.backgrounds.length) {
    if (report.pack) io.writeBytes(`${outDir}/pack/rooms.katn`, b.bytes);
    io.writeBytes(`${outDir}/mod/rooms.katn`, b.bytes);
    io.writeText(`${outDir}/mod/mod.toml`, `# Written by katam compile: the room bundle of this project.\n[mod]\nid = "${b.modId}"\nformat = 1\nrooms = "rooms.katn"\n`);
    report.mod = `${outDir}/mod`;
  }
  return report;
}

/** A new room's area (doc.area, else the area of the vanilla room its first
 *  door leads to, else rainbow_route) and default cell (its first door's
 *  first cell): what the runtime's room-graph tables get for ids >= 983. */
function roomGraphOf(compiled, r) {
  const d = compiled.bindings.docs.get(r.id);
  const doc = d ? d.doc : {};
  let area = doc.area;
  const doors = doc.doors || [];
  if (!area && doors.length) {
    const m = /(\d+)$/.exec(doors[0].to || '');
    const to = compiled.bindings.resolve(doors[0].to);
    const num = to ? compiled.bindings.num.get(to) : m ? Number(m[1]) : undefined;
    if (num !== undefined && num < N.NUM_ROOM_SLOTS) area = compiled.vocab.roomAreas[num];
  }
  const spawn = doors.length && doors[0].cells && doors[0].cells.length ? doors[0].cells[0] : [Math.floor((doc.size?.width || 15) / 2), Math.floor((doc.size?.height || 10) / 2)];
  return { area: N.AREA_UNK46[area] ?? 0, spawn };
}

/** The rooms/tilesets/backgrounds a stack adds or replaces over vanilla, linked. */
export function bundleOf(compiled) {
  const mine = (c) => !compiled.vanillaLayers.has(c.project);
  const rooms = [...compiled.rooms.values()].filter(mine).map((r) => ({ ...r, ...roomGraphOf(compiled, r) }));
  const tilesets = [...compiled.tilesets].filter(([, t]) => mine(t)).map(([idx, t]) => ({ idx, blobs: t.blobs }));
  const backgrounds = [...compiled.backgrounds].filter(([, t]) => mine(t)).map(([idx, t]) => ({ idx, blobs: t.blobs }));
  const ids = [...new Set(rooms.map((r) => r.project))];
  return { rooms, tilesets, backgrounds, modId: ids.length ? ids.map((d) => compiled.projectIds.get(d)).join('+') : 'none', bytes: N.linkBundle({ rooms, tilesets, backgrounds }) };
}

// --------------------------------------------------------------------- gate

/** Compare a compiled vanilla stack with the ROM, blob by blob. */
export function gate({ romBytes, romTables, compiled, pack }) {
  const rom = new Rom(romBytes, romTables);
  const res = { rooms: { ok: 0, bad: [] }, tilesets: { ok: 0, bad: [] }, backgrounds: { ok: 0, bad: [] }, palettes: { ok: 0, bad: [] }, objDesc: { ok: 0, bad: [] }, packed: { same: 0, total: 0 } };
  const packedKeys = (b) => Object.keys(b).filter((k) => k.endsWith('Packed'));
  for (const rid of N.vanillaRoomIds(rom)) {
    const want = N.readRoomNative(rom, rid);
    const got = compiled.rooms.get(rid);
    if (!got) { res.rooms.bad.push({ id: rid, diffs: [{ blob: '*', why: 'not compiled' }] }); continue; }
    const d = N.compareBlobs(want.blobs, got.blobs);
    for (const k of packedKeys(want.blobs)) { res.packed.total++; if (!d.some((x) => x.blob === k)) res.packed.same++; }
    const hard = d.filter((x) => !x.blob.endsWith('Packed'));
    if (hard.length) res.rooms.bad.push({ id: rid, diffs: hard }); else res.rooms.ok++;
  }
  for (let i = 0; i < TABLE_COUNTS.gForegroundInfo; i++) {
    const want = N.readTilesetNative(rom, i), got = compiled.tilesets.get(i);
    const d = got ? N.compareBlobs(want.blobs, got.blobs) : [{ blob: '*', why: 'not compiled' }];
    res.packed.total++; if (!d.some((x) => x.blob === 'tilesPacked')) res.packed.same++;
    const hard = d.filter((x) => !x.blob.endsWith('Packed'));
    if (hard.length) res.tilesets.bad.push({ id: i, diffs: hard }); else res.tilesets.ok++;
  }
  for (let i = 0; i < TABLE_COUNTS.gRoomTiledBGs; i++) {
    const want = N.readBackgroundNative(rom, i), got = compiled.backgrounds.get(i);
    const d = got ? N.compareBlobs(want.blobs, got.blobs) : [{ blob: '*', why: 'not compiled' }];
    res.packed.total++; if (!d.some((x) => x.blob === 'tilesPacked')) res.packed.same++;
    const hard = d.filter((x) => !x.blob.endsWith('Packed'));
    if (hard.length) res.backgrounds.bad.push({ id: i, diffs: hard }); else res.backgrounds.ok++;
  }
  for (const [i, p] of pack.palettes) {
    if (sameJson(p, compiled.palettes.get(i))) res.palettes.ok++; else res.palettes.bad.push({ id: i });
  }
  for (const rec of pack.objDesc) {
    if (sameJson(rec, compiled.objDesc.get(rec.id))) res.objDesc.ok++; else res.objDesc.bad.push({ id: rec.id });
  }
  return res;
}

export { ROOM_FORMAT };

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
export const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
