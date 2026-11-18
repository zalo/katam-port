// Tilesets, backgrounds and palettes: native <-> authoring (PNG + JSON).
//
// Tile pixels are 4bpp GBA tiles (32 bytes, 8 rows of 4 bytes, low nibble =
// left pixel).  On disk they are an indexed PNG, bit depth 4, 32 tiles (256 px)
// wide, tile n at (n % 32, n / 32): the decomp/gbagfx convention.  The PNG's
// own palette is only a preview (greyscale ramp, or a palette bank when one is
// known); the pixel *indices* are the data, so any indexed-PNG editor works.
import { u16, u32, put } from './bytes.mjs';
import { encodeLZ77 } from './compress.mjs';
import { encodeIndexed, decodeIndexed } from './png.mjs';
import { tokenOf, valueOf } from './tiles.mjs';

export const SHEET_TILES = 32;
export const GREY = Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17]);

export const colorOf = (c) => '#' + [c & 31, (c >> 5) & 31, (c >> 10) & 31].map((v) => ((v << 3) | (v >> 2)).toString(16).padStart(2, '0').toUpperCase()).join('');
export function bgr555(s, where = 'color') {
  const m = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(s);
  if (!m) throw new Error(`${where}: "${s}" is not #RRGGBB`);
  return (parseInt(m[1], 16) >> 3) | ((parseInt(m[2], 16) >> 3) << 5) | ((parseInt(m[3], 16) >> 3) << 10);
}
export const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16));

/** 4bpp tile bytes -> indexed PNG (bit depth 4). */
export function tilesToPng(bytes, palette = GREY) {
  if (bytes.length % 32) throw new Error(`tile data is ${bytes.length} bytes, not a whole number of 4bpp tiles`);
  const n = bytes.length / 32;
  const w = SHEET_TILES * 8, h = Math.max(1, Math.ceil(n / SHEET_TILES)) * 8;
  const px = new Uint8Array(w * h);
  for (let t = 0; t < n; t++) {
    const tx = (t % SHEET_TILES) * 8, ty = ((t / SHEET_TILES) | 0) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const b = bytes[t * 32 + y * 4 + (x >> 1)];
      px[(ty + y) * w + tx + x] = x & 1 ? b >> 4 : b & 0xf;
    }
  }
  return encodeIndexed(w, h, px, palette, 4);
}

/** indexed PNG -> 4bpp tile bytes, `count` tiles (row-major from the top-left). */
export function pngToTiles(png, count, where = 'image') {
  const { w, h, pixels } = decodeIndexed(png);
  if (w % 8 || h % 8) throw new Error(`${where}: ${w}x${h} is not a whole number of 8x8 tiles`);
  const per = w / 8;
  if (count > per * (h / 8)) throw new Error(`${where}: holds ${per * (h / 8)} tiles, metadata says ${count}`);
  const out = new Uint8Array(count * 32);
  for (let t = 0; t < count; t++) {
    const tx = (t % per) * 8, ty = ((t / per) | 0) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const v = pixels[(ty + y) * w + tx + x];
      if (v > 15) throw new Error(`${where}: pixel (${tx + x}, ${ty + y}) uses colour index ${v}; 4bpp tiles allow 0-15`);
      out[t * 32 + y * 4 + (x >> 1)] |= x & 1 ? v << 4 : v;
    }
  }
  return out;
}

// ------------------------------------------------------------- tilesets

export const TILESET_FORMAT = 'katam-tileset/1';

export function decompileTileset(nat, ctx) {
  const B = nat.blobs;
  const doc = { format: TILESET_FORMAT, id: ctx.ref('tileset', nat.idx), bind: { index: nat.idx }, image: 'tiles.png', tileCount: B.tiles.length / 32 };
  doc.roomTag = nat.roomId;
  const files = { 'tiles.png': tilesToPng(B.tiles, ctx.previewPalette ? ctx.previewPalette(nat.idx) : GREY) };
  if (B.anims.length) {
    doc.animations = B.anims.map((a) => {
      const r = a.record;
      const t32 = (v, what) => { if (v % 32) throw new Error(`tileset ${nat.idx}: ${what} ${v} is not tile-aligned`); return v / 32; };
      const frames = [];
      for (let f = 0; f < u16(r, 0x10); f++) {
        const fr = { gfxTile: t32(u32(a.frames, f * 8), 'gfx offset'), duration: u16(a.frames, f * 8 + 4) };
        const pad = u16(a.frames, f * 8 + 6);
        if (pad) fr.pad = pad;
        frames.push(fr);
      }
      return { tile: t32(u32(r, 0), 'vram offset'), tiles: t32(u32(r, 4), 'copy size'), chunks: u16(r, 0x12), chunkStride: t32(u32(r, 8), 'stride'), frames };
    });
    doc.animImage = 'anim.png';
    doc.animTileCount = B.animGfx.length / 32;
    files['anim.png'] = tilesToPng(B.animGfx);
  }
  return { doc, files };
}

export function compileTileset(doc, readFile) {
  const B = {};
  B.tiles = pngToTiles(readFile(doc.image), doc.tileCount, doc.image);
  B.tilesPacked = encodeLZ77(B.tiles);
  B.header = new Uint8Array(0x10);
  const anims = doc.animations || [];
  put(B.header, 0x0c, 2, anims.length);
  put(B.header, 0x0e, 2, doc.roomTag ?? 0);
  B.anims = anims.map((a) => {
    const r = new Uint8Array(0x14);
    put(r, 0, 4, a.tile * 32); put(r, 4, 4, a.tiles * 32); put(r, 8, 4, (a.chunkStride ?? 32) * 32);
    put(r, 0x10, 2, a.frames.length); put(r, 0x12, 2, a.chunks ?? 1);
    const frames = new Uint8Array(a.frames.length * 8);
    a.frames.forEach((f, i) => { put(frames, i * 8, 4, f.gfxTile * 32); put(frames, i * 8 + 4, 2, f.duration); put(frames, i * 8 + 6, 2, f.pad ?? 0); });
    return { record: r, frames };
  });
  B.animGfx = anims.length ? pngToTiles(readFile(doc.animImage), doc.animTileCount, doc.animImage) : new Uint8Array(0);
  return { idx: doc.bind && doc.bind.index, blobs: B };
}

// ----------------------------------------------------------- backgrounds

export const BACKGROUND_FORMAT = 'katam-background/1';

export function decompileBackground(nat, ctx) {
  const B = nat.blobs, h = B.header;
  const palOff = u16(h, 0x14), palSize = u16(h, 0x16);
  const colors = [], bit15 = [];
  for (let i = 0; i < palSize; i++) { const c = u16(B.palette, i * 2); colors.push(colorOf(c)); if (c & 0x8000) bit15.push(i); }
  const rows = [];
  for (let y = 0; y < nat.height; y++) {
    const r = [];
    for (let x = 0; x < nat.width; x++) r.push(tokenOf(u16(B.tilemap, (y * nat.width + x) * 2)));
    rows.push(r.join(' '));
  }
  const doc = {
    format: BACKGROUND_FORMAT, id: ctx.ref('background', nat.idx), bind: { index: nat.idx },
    size: { width: nat.width, height: nat.height },
    image: 'tiles.png', tileCount: B.tiles.length / 32,
    palette: { offset: palOff, colors }, tilemap: rows, roomTag: u16(h, 0x1e),
  };
  if (bit15.length) doc.palette.bit15 = bit15;
  if (u32(h, 0x0c) !== doc.tileCount) doc.tilesetSizeField = u32(h, 0x0c);
  const raw = { unk4: u16(h, 4), unk6: h[6], unk7: h[7], unk1C: u16(h, 0x1c) };
  for (const k of Object.keys(raw)) if (!raw[k]) delete raw[k];
  if (Object.keys(raw).length) doc.raw = raw;
  // preview the tiles in the bank most of the tilemap uses
  const files = { 'tiles.png': tilesToPng(B.tiles) };
  return { doc, files };
}

export function compileBackground(doc, readFile) {
  const B = {};
  const W = doc.size.width, H = doc.size.height;
  B.tiles = pngToTiles(readFile(doc.image), doc.tileCount, doc.image);
  B.tilesPacked = encodeLZ77(B.tiles);
  const cols = doc.palette.colors;
  B.palette = new Uint8Array(cols.length * 2);
  const b15 = new Set(doc.palette.bit15 || []);
  cols.forEach((c, i) => put(B.palette, i * 2, 2, bgr555(c, `palette.colors[${i}]`) | (b15.has(i) ? 0x8000 : 0)));
  if (doc.tilemap.length !== H) throw new Error(`tilemap has ${doc.tilemap.length} rows, size.height is ${H}`);
  B.tilemap = new Uint8Array(W * H * 2);
  doc.tilemap.forEach((row, y) => {
    const t = row.trim().split(/\s+/);
    if (t.length !== W) throw new Error(`tilemap[${y}] has ${t.length} tiles, size.width is ${W}`);
    t.forEach((tok, x) => put(B.tilemap, (y * W + x) * 2, 2, valueOf(tok)));
  });
  const h = new Uint8Array(0x20);
  const raw = doc.raw || {};
  put(h, 0, 2, W); put(h, 2, 2, H); put(h, 4, 2, raw.unk4 || 0); h[6] = raw.unk6 || 0; h[7] = raw.unk7 || 0;
  put(h, 0x0c, 4, doc.tilesetSizeField ?? doc.tileCount);
  put(h, 0x14, 2, doc.palette.offset); put(h, 0x16, 2, cols.length);
  put(h, 0x1c, 2, raw.unk1C || 0); put(h, 0x1e, 2, doc.roomTag ?? 0);
  B.header = h;
  return { idx: doc.bind && doc.bind.index, blobs: B };
}

// -------------------------------------------------------------- palettes
// Foreground palettes are a pack kind today (fg_palette): the authoring file
// is a renamed view of the pack record, and compiles back to the exact pack
// JSON, which --res-check proves byte-identical to the ROM.

export const PALETTE_FORMAT = 'katam-palette/1';

export function decompilePalette(pack, ctx) {
  const doc = { format: PALETTE_FORMAT, id: ctx.ref('palette', pack.id), bind: { index: pack.id }, banks: pack.colors };
  if (pack.bit15 && pack.bit15.length) doc.bit15 = pack.bit15;
  doc.roomTag = pack.roomId;
  doc.animations = { count: pack.unk8, vanillaRef: pack.unk4 };
  return doc;
}

export function compilePalette(doc) {
  const out = { id: doc.bind.index, unk4: (doc.animations && doc.animations.vanillaRef) || '0x00000000', unk8: (doc.animations && doc.animations.count) || 0, roomId: doc.roomTag ?? 0, colors: doc.banks };
  out.bit15 = doc.bit15 || [];
  return out;
}
