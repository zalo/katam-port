// GBA BIOS compression formats: LZ77 (type 0x10) and run-length (type 0x30).
//
// Decoders follow the BIOS exactly.  Encoders are deterministic and written to
// reproduce the streams Nintendo's tools emitted where that is possible (the
// round-trip report counts how many vanilla streams re-encode byte-identically);
// where they do not, the gate compares decompressed payloads (MODDING.md §2.6).
// Pure functions over Uint8Array: usable in node and in the browser unchanged.

export class CompressionError extends Error {}

/** Header -> {type: 1|3, size}.  Type is the HIGH nibble of byte 0. */
export function header(buf, off = 0) {
  const h = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
  return { type: (h >>> 4) & 0xf, size: h >>> 8 };
}

/** Decompress a stream at `off`.  -> {data, consumed} (consumed = compressed bytes read). */
export function decompress(buf, off = 0) {
  const { type, size } = header(buf, off);
  let p = off + 4;
  const out = new Uint8Array(size);
  let n = 0;
  if (type === 1) {
    while (n < size) {
      const flags = buf[p++];
      for (let bit = 0; bit < 8 && n < size; bit++) {
        if (flags & (0x80 >> bit)) {
          const b0 = buf[p], b1 = buf[p + 1]; p += 2;
          const len = (b0 >> 4) + 3, disp = (((b0 & 0xf) << 8) | b1) + 1;
          if (disp > n) throw new CompressionError('LZ77 back-reference before the start');
          for (let i = 0; i < len && n < size; i++, n++) out[n] = out[n - disp];
        } else {
          out[n++] = buf[p++];
        }
      }
    }
  } else if (type === 3) {
    while (n < size) {
      const flag = buf[p++];
      if (flag & 0x80) {
        const len = (flag & 0x7f) + 3, v = buf[p++];
        for (let i = 0; i < len && n < size; i++) out[n++] = v;
      } else {
        const len = (flag & 0x7f) + 1;
        for (let i = 0; i < len && n < size; i++) out[n++] = buf[p++];
      }
    }
  } else {
    throw new CompressionError(`compression type ${type} is not LZ77 (1) or RL (3)`);
  }
  return { data: out, consumed: p - off, type };
}

function hdr(type, size) {
  return [type << 4, size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff];
}

function pad4(arr) {
  while (arr.length % 4) arr.push(0);
  return Uint8Array.from(arr);
}

/** Run-length encode (greedy: runs of >= 3 equal bytes, literals up to 128). */
export function encodeRL(data) {
  const out = hdr(3, data.length);
  let i = 0;
  const lit = [];
  const flush = () => {
    while (lit.length) {
      const k = Math.min(128, lit.length);
      out.push(k - 1, ...lit.splice(0, k));
    }
  };
  while (i < data.length) {
    let r = 1;
    while (i + r < data.length && data[i + r] === data[i] && r < 130) r++;
    if (r >= 3) {
      flush();
      out.push(0x80 | (r - 3), data[i]);
      i += r;
    } else {
      lit.push(data[i++]);
      if (lit.length === 128) flush();
    }
  }
  flush();
  return pad4(out);
}

/** LZ77 encode: greedy longest match in a 4 KiB window, nearest match on ties.
 *  `vram` forbids displacement 1 (VRAM-safe streams, like Nintendo's tools). */
export function encodeLZ77(data, { vram = true } = {}) {
  const out = hdr(1, data.length);
  const minDisp = vram ? 2 : 1;
  let i = 0;
  // hash chains on 3-byte prefixes for speed
  const head = new Map();
  const prev = new Int32Array(data.length).fill(-1);
  const key = (k) => (data[k] << 16) | (data[k + 1] << 8) | data[k + 2];
  const insert = (k) => {
    if (k + 2 >= data.length) return;
    const h = key(k);
    const p = head.get(h);
    prev[k] = p === undefined ? -1 : p;
    head.set(h, k);
  };
  let inserted = 0;
  while (i < data.length) {
    const flagPos = out.length;
    out.push(0);
    let flags = 0;
    for (let bit = 0; bit < 8 && i < data.length; bit++) {
      while (inserted < i) insert(inserted++);
      let bestLen = 0, bestDisp = 0;
      if (i + 2 < data.length) {
        let c = head.get(key(i));
        while (c !== undefined && c >= 0 && i - c <= 0x1000) {
          const disp = i - c;
          if (disp >= minDisp) {
            let l = 0;
            while (l < 18 && i + l < data.length && data[c + l] === data[i + l]) l++;
            if (l > bestLen) { bestLen = l; bestDisp = disp; if (l === 18) break; }
          }
          c = prev[c];
        }
      }
      if (bestLen >= 3) {
        flags |= 0x80 >> bit;
        const d = bestDisp - 1;
        out.push(((bestLen - 3) << 4) | (d >> 8), d & 0xff);
        i += bestLen;
      } else {
        out.push(data[i++]);
      }
    }
    out[flagPos] = flags;
  }
  return pad4(out);
}
