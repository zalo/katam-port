// Minimal PNG: write indexed (bit depth 4 or 8) and RGBA; read indexed.
// Deterministic (no ancillary chunks, fixed filter 0, caller's deflate).
// zlib is injected so the module has no Node dependency: node passes
// node:zlib's deflateSync/inflateSync, a browser passes e.g. fflate's.
let Z = null;
export function setZlib(z) { Z = z; }

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b, s = 0, e = b.length) { let c = 0xffffffff; for (let i = s; i < e; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function assemble(w, h, depth, colorType, raw, extra = []) {
  if (!Z) throw new Error('png: setZlib() first');
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = depth; ihdr[9] = colorType;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', Z.deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** pixels: Uint8Array w*h of indices; palette: [[r,g,b],...] (<=16 for depth 4). */
export function encodeIndexed(w, h, pixels, palette, depth = 4) {
  const rowBytes = depth === 4 ? (w + 1) >> 1 : w;
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rowBytes + 1);
    for (let x = 0; x < w; x++) {
      const v = pixels[y * w + x];
      if (depth === 4) raw[o + 1 + (x >> 1)] |= x & 1 ? v & 0xf : (v & 0xf) << 4; else raw[o + 1 + x] = v;
    }
  }
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((c, i) => plte.set(c, i * 3));
  return assemble(w, h, depth, 3, raw, [chunk('PLTE', plte)]);
}

export function encodeRGBA(w, h, rgba) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  return assemble(w, h, 8, 6, raw);
}

/** Decode an indexed PNG (depth 1/2/4/8, any filter, no interlace) -> {w, h, pixels, palette}. */
export function decodeIndexed(png) {
  if (!Z) throw new Error('png: setZlib() first');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8, w = 0, h = 0, depth = 0, ct = 0, il = 0;
  const idat = [];
  let palette = [];
  while (o < png.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); depth = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'PLTE') { palette = []; for (let i = 0; i < len; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (ct !== 3) throw new Error('png: not an indexed-colour PNG (colour type 3); save as indexed/paletted, 16 colours');
  if (il) throw new Error('png: interlaced PNGs are not supported');
  const z = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  let p = 0;
  for (const d of idat) { z.set(d, p); p += d.length; }
  const raw = Z.inflate(z);
  const bpr = Math.ceil((w * depth) / 8), bpp = 1;
  const pixels = new Uint8Array(w * h);
  let prev = new Uint8Array(bpr);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (bpr + 1)];
    const line = Uint8Array.from(raw.subarray(y * (bpr + 1) + 1, (y + 1) * (bpr + 1)));
    for (let i = 0; i < bpr; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      if (f === 1) line[i] = (line[i] + a) & 0xff;
      else if (f === 2) line[i] = (line[i] + b) & 0xff;
      else if (f === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; }
    }
    for (let x = 0; x < w; x++) {
      const bit = x * depth;
      pixels[y * w + x] = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    }
    prev = line;
  }
  return { w, h, pixels, palette };
}
