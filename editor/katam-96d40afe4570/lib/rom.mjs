// A read-only view of the player's ROM, addressed by GBA bus address.
// Table addresses come from the committed game/generated/port/rom_tables.h
// (labels and addresses only, no bytes) via parseRomTables().
import { u8, u16, s16, u32 } from './bytes.mjs';

export const ROM_BASE = 0x08000000;
export const VANILLA_SHA1 = '274b102b6d940f46861a92b4e65f89a51815c12c';

export class BadPointer extends Error {}

/** "ROM_TABLE(gRoomProps, 0x089331AC)" lines -> {gRoomProps: 0x089331AC, ...} */
export function parseRomTables(text) {
  const out = {};
  for (const m of text.matchAll(/ROM_TABLE\((\w+),\s*(0x[0-9A-Fa-f]+)\)/g)) out[m[1]] = parseInt(m[2], 16);
  return out;
}

export class Rom {
  constructor(bytes, tables) {
    this.b = bytes;
    this.t = tables;
  }
  off(a, n = 1) {
    const o = a - ROM_BASE;
    if (o < 0 || o + n > this.b.length) throw new BadPointer(`0x${a.toString(16)} is outside the ROM`);
    return o;
  }
  isPtr(a) { return a >= ROM_BASE && a < ROM_BASE + this.b.length; }
  u8(a) { return u8(this.b, this.off(a)); }
  u16(a) { return u16(this.b, this.off(a, 2)); }
  s16(a) { return s16(this.b, this.off(a, 2)); }
  u32(a) { return u32(this.b, this.off(a, 4)); }
  ptr(a) {
    const p = this.u32(a);
    if (!this.isPtr(p)) throw new BadPointer(`0x${p.toString(16)} (read at 0x${a.toString(16)}) does not point into the ROM`);
    return p;
  }
  slice(a, n) { const o = this.off(a, n); return this.b.subarray(o, o + n); }
  /** The bytes from `a` to the end (for decoders that find their own length). */
  from(a) { return this.b.subarray(this.off(a)); }
  table(label) {
    const a = this.t[label];
    if (a === undefined) throw new Error(`rom_tables.h has no ${label}`);
    return a;
  }
  entry(label, i) { return this.ptr(this.table(label) + 4 * i); }
}
