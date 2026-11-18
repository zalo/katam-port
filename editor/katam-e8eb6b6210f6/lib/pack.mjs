// The GBA-shaped JSON pack the game binary loads today (--res-pack DIR, --mod),
// written byte-for-byte in the extractor's canonical layout
// (platform/res_pack.c ExtractKind), so a compiled vanilla pack can be diffed
// file-for-file against `--res-extract` output as well as `--res-check`ed.
//
// Kinds: room_props (rooms/%04u/room.json), fg_palette (gfx/palettes/fg/%u.json),
// obj_desc (objects/types.json).  The record schemas come from assets/manifest.json.

export const PACK_KINDS = ['room_props', 'fg_palette', 'obj_desc'];

export function readPack(io, dir) {
  const rooms = new Map(), palettes = new Map();
  for (const p of io.list(dir + '/rooms')) {
    const m = /rooms\/(\d+)\/room\.json$/.exec(p);
    if (m) rooms.set(Number(m[1]), JSON.parse(io.readText(p)));
  }
  for (const p of io.list(dir + '/gfx/palettes/fg')) {
    const m = /fg\/(\d+)\.json$/.exec(p);
    if (m) palettes.set(Number(m[1]), JSON.parse(io.readText(p)));
  }
  const objDesc = io.exists(dir + '/objects/types.json') ? JSON.parse(io.readText(dir + '/objects/types.json')).obj_desc : [];
  const toml = io.exists(dir + '/pack.toml') ? io.readText(dir + '/pack.toml') : null;
  return { rooms, palettes, objDesc, toml };
}

const val = (f, v) => {
  if (f.type === 'ptr32') return JSON.stringify(v);
  if (f.type.startsWith('u8x')) return '[' + v.join(', ') + ']';
  return String(v);
};

function kindOf(manifest, k) { return manifest.kinds.find((x) => x.kind === k); }

export function roomJson(manifest, id, rec) {
  const K = kindOf(manifest, 'room_props');
  let s = `{\n  "id": ${id}`;
  for (const f of K.fields) s += `,\n  "${f.name}": ${val(f, rec[f.name])}`;
  return s + '\n}\n';
}

export function fillerRoom(manifest) {
  const K = kindOf(manifest, 'room_props');
  const r = {};
  for (const f of K.fields) r[f.name] = f.type === 's16' ? -1 : f.type.startsWith('u8x') ? [0, 0] : f.type === 'u16' ? 65535 : 0;
  return r;
}

export function paletteJson(manifest, rec) {
  const K = kindOf(manifest, 'fg_palette');
  let s = `{\n  "id": ${rec.id}`;
  for (const f of K.fields) if (f.name !== K.payload.field) s += `,\n  "${f.name}": ${val(f, rec[f.name])}`;
  s += ',\n  "colors": [\n';
  s += rec.colors.map((bank) => '    [' + bank.map((c) => JSON.stringify(c)).join(', ') + ']').join(',\n');
  s += '\n  ],\n  "bit15": [' + (rec.bit15 || []).join(', ') + ']\n}\n';
  return s;
}

export function objDescJson(manifest, recs) {
  const K = kindOf(manifest, 'obj_desc');
  const lines = recs.map((r, i) => {
    let s = `    {"id": ${r.id}`;
    if (r.name !== undefined) s += `, "name": ${JSON.stringify(r.name)}`;
    for (const f of K.fields) s += `, "${f.name}": ${val(f, r[f.name])}`;
    return s + '}' + (i + 1 < recs.length ? ',' : '');
  });
  return '{\n  "obj_desc": [\n' + lines.join('\n') + '\n  ]\n}\n';
}

/** Write a complete pack.  `sha256(bytesOrString) -> hex` is injected (node crypto / SubtleCrypto). */
export function writePack(io, dir, { manifest, manifestSha256, romSha1, rooms, palettes, objDesc }, sha256) {
  const files = [];
  const put = (rel, text) => { io.writeText(`${dir}/${rel}`, text); files.push([rel, sha256(text)]); };
  const RP = kindOf(manifest, 'room_props'), FP = kindOf(manifest, 'fg_palette');
  const filler = fillerRoom(manifest);
  for (let id = 0; id < RP.count; id++) put(`rooms/${String(id).padStart(4, '0')}/room.json`, roomJson(manifest, id, rooms.get(id) || filler));
  for (let id = 0; id < FP.count; id++) {
    const p = palettes.get(id);
    if (!p) throw new Error(`fg_palette ${id} missing: the pack table has a fixed ${FP.count} entries`);
    put(`gfx/palettes/fg/${id}.json`, paletteJson(manifest, p));
  }
  put('objects/types.json', objDescJson(manifest, objDesc));
  const toml = `# Extracted from your ROM by katam-port. Do not redistribute.\n[pack]\nformat = 1\nextractor = "1.0.0"\nrom_sha1 = "${romSha1}"\nmanifest_sha256 = "${manifestSha256}"\nkinds = [${PACK_KINDS.map((k) => `"${k}"`).join(', ')}]\n`;
  io.writeText(`${dir}/pack.toml`, toml);
  files.push(['pack.toml', sha256(toml)]);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  io.writeText(`${dir}/pack.lock`, files.map(([r, h]) => `${h}  ${r}\n`).join(''));
}
