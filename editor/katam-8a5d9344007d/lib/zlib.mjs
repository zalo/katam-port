// A small synchronous zlib for the browser (png.mjs takes its zlib injected;
// node passes node:zlib).  deflate writes stored blocks only -- valid zlib,
// no compression, which is all an in-memory decompile -> compile round trip
// needs; inflate reads anything (stored, fixed and dynamic Huffman), so PNGs
// from a paint program load too.  RFC 1950/1951.

function adler32(b) {
  let a = 1, s = 0;
  for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; s = (s + a) % 65521; }
  return ((s << 16) | a) >>> 0;
}

export function deflate(data) {
  const n = data.length, blocks = Math.max(1, Math.ceil(n / 65535));
  const out = new Uint8Array(2 + n + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0, k = 0; k < blocks; k++) {
    const len = Math.min(65535, n - i);
    out[o++] = k === blocks - 1 ? 1 : 0;
    out[o++] = len & 255; out[o++] = len >> 8; out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
    out.set(data.subarray(i, i + len), o); o += len; i += len;
  }
  const a = adler32(data);
  out[o++] = a >>> 24; out[o++] = (a >>> 16) & 255; out[o++] = (a >>> 8) & 255; out[o++] = a & 255;
  return out;
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huff(lengths) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16), syms = new Uint16Array(lengths.length);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  lengths.forEach((l, s) => { if (l) syms[offs[l]++] = s; });
  return { counts, syms };
}

export function inflate(src) {
  let pos = 2, bit = 0, buf = 0;   // skip the zlib header
  let out = new Uint8Array(Math.max(1024, src.length * 4)), n = 0;
  const need = (k) => { if (n + k > out.length) { const o = new Uint8Array(Math.max(out.length * 2, n + k)); o.set(out); out = o; } };
  const bits = (k) => {
    while (bit < k) { if (pos >= src.length) throw new Error('inflate: truncated'); buf |= src[pos++] << bit; bit += 8; }
    const v = buf & ((1 << k) - 1); buf >>>= k; bit -= k; return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.counts[len];
      if (code - c < first) return h.syms[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      buf = 0; bit = 0;
      const len = src[pos] | (src[pos + 1] << 8); pos += 4;
      need(len); out.set(src.subarray(pos, pos + len), n); n += len; pos += len;
      continue;
    }
    let lit, dist;
    if (type === 1) {
      const l = new Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
      lit = huff(l); dist = huff(new Array(30).fill(5));
    } else if (type === 2) {
      const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hc; i++) cl[CLORDER[i]] = bits(3);
      const ch = huff(cl), lens = [];
      while (lens.length < hl + hd) {
        const s = decode(ch);
        if (s < 16) lens.push(s);
        else if (s === 16) { const p = lens[lens.length - 1]; for (let r = 3 + bits(2); r; r--) lens.push(p); }
        else if (s === 17) for (let r = 3 + bits(3); r; r--) lens.push(0);
        else for (let r = 11 + bits(7); r; r--) lens.push(0);
      }
      lit = huff(lens.slice(0, hl)); dist = huff(lens.slice(hl));
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const s = decode(lit);
      if (s < 256) { need(1); out[n++] = s; continue; }
      if (s === 256) break;
      const len = LBASE[s - 257] + bits(LEXT[s - 257]);
      const ds = decode(dist);
      const d = DBASE[ds] + bits(DEXT[ds]);
      need(len);
      for (let i = 0; i < len; i++, n++) out[n] = out[n - d];
    }
  } while (!last);
  return out.slice(0, n);
}
