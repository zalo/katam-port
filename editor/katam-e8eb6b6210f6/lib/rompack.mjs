// The pack records decompile needs (fg palettes, object descriptors), read
// straight from the player's ROM with the committed manifest -- the same
// values platform/res_pack.c's extractor writes as JSON, as readPack()
// returns them.  For the browser (web/playtest/), which has the ROM but no
// --res-extract; tests/authoring_roundtrip.sh checks the two agree.
import { Rom } from './rom.mjs';
import { colorOf } from './gfx.mjs';

const hex8 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

function readField(rom, a, f) {
  switch (f.type) {
    case 'u8': return rom.u8(a + f.offset);
    case 'u16': return rom.u16(a + f.offset);
    case 's16': return rom.s16(a + f.offset);
    case 'u32': return rom.u32(a + f.offset);
    case 'ptr32': return hex8(rom.u32(a + f.offset));
    default: {
      const m = /^u8x(\d+)$/.exec(f.type);
      if (m) return Array.from({ length: Number(m[1]) }, (_, i) => rom.u8(a + f.offset + i));
      throw new Error(`rompack: field type ${f.type}`);
    }
  }
}

/** -> {palettes: Map(id -> record), objDesc: [records]} as readPack() gives. */
export function packFromRom(romBytes, romTables, manifest) {
  const rom = new Rom(romBytes, romTables);
  const K = (k) => manifest.kinds.find((x) => x.kind === k);
  const FP = K('fg_palette'), OD = K('obj_desc');
  const palettes = new Map();
  const fpBase = parseInt(FP.addr, 16);
  for (let id = 0; id < FP.count; id++) {
    const rec = rom.u32(fpBase + 4 * id);
    const r = { id };
    for (const f of FP.fields) if (f.name !== FP.payload.field) r[f.name] = readField(rom, rec, f);
    const pal = rom.u32(rec + FP.fields.find((f) => f.name === FP.payload.field).offset);
    r.colors = [];
    r.bit15 = [];
    for (let b = 0; b < FP.payload.banks; b++) {
      const bank = [];
      for (let c = 0; c < FP.payload.colors; c++) {
        const v = rom.u16(pal + 2 * (b * FP.payload.colors + c));
        bank.push(colorOf(v & 0x7fff));
        if (v & 0x8000) r.bit15.push(b * FP.payload.colors + c);
      }
      r.colors.push(bank);
    }
    palettes.set(id, r);
  }
  const objDesc = [];
  const odBase = parseInt(OD.addr, 16);
  for (let id = 0; id < OD.count; id++) {
    const r = { id };
    if (OD.names && OD.names[id] !== undefined) r.name = OD.names[id];
    for (const f of OD.fields) r[f.name] = readField(rom, odBase + id * OD.stride, f);
    objDesc.push(r);
  }
  return { rooms: new Map(), palettes, objDesc, toml: null };
}
