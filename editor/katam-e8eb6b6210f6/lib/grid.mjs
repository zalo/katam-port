// Grids as row strings with a legend.
//
// A layer is {legend: {key: value}, rows: ["....##", ...]}: every row is the
// same length, every key has the same width (1 or 2 characters), and a row is
// the concatenation of `width` keys.  One line per row keeps diffs readable;
// a model writes it the way it would write ASCII art.
//
// Keys come from KEY_ALPHABET (printable ASCII minus space, quote, backslash,
// so a row needs no JSON escaping).
// Letters and digits first: keys a decoder assigns on its own carry no meaning.
// The punctuation that reads as something (. # = ~ ^ % D H) is only used when
// a caller suggests it for a value that means that.
export const KEY_ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCEFGIJKLMNOPQRSTUVWXYZ0123456789DH.#=~^%-+:;,_*@!$&|/<>?()[]{}\'`';

export class GridError extends Error {
  constructor(msg, where) { super(msg); this.where = where; }
}

/** Parse a layer into a flat array of legend values (row-major). */
export function decodeGrid(layer, width, height, where = 'layer') {
  const { legend, rows } = layer;
  if (!legend || typeof legend !== 'object') throw new GridError('missing legend', `${where}.legend`);
  if (!Array.isArray(rows)) throw new GridError('missing rows', `${where}.rows`);
  const keys = Object.keys(legend);
  if (!keys.length) throw new GridError('empty legend', `${where}.legend`);
  const kw = keys[0].length;
  for (const k of keys) if (k.length !== kw) throw new GridError(`legend keys must all be ${kw} character(s); "${k}" is not`, `${where}.legend`);
  if (rows.length !== height) throw new GridError(`${rows.length} rows, room is ${height} high`, `${where}.rows`);
  const out = new Array(width * height);
  rows.forEach((row, y) => {
    if (row.length !== width * kw) throw new GridError(`row ${y} is ${row.length / kw} cells, room is ${width} wide`, `${where}.rows[${y}]`);
    for (let x = 0; x < width; x++) {
      const k = row.substr(x * kw, kw);
      if (!(k in legend)) throw new GridError(`row ${y} col ${x}: key "${k}" is not in the legend`, `${where}.rows[${y}]`);
      out[y * width + x] = legend[k];
    }
  });
  return out;
}

/** Build a layer from a flat array of values.  `keyFor(value, i)` may suggest a
 *  key (used when free); `toLegend(value)` gives the legend value. */
export function encodeGrid(values, width, height, { suggest = () => null, toLegend = (v) => v } = {}) {
  const distinct = [];
  const seen = new Map();
  for (const v of values) { const id = JSON.stringify(v); if (!seen.has(id)) { seen.set(id, null); distinct.push(v); } }
  const kw = distinct.length <= KEY_ALPHABET.length ? 1 : 2;
  const used = new Set();
  const all = kw === 1 ? [...KEY_ALPHABET] : [...KEY_ALPHABET].flatMap((a) => [...KEY_ALPHABET].map((b) => a + b));
  const legend = {};
  let next = 0;
  for (const v of distinct) {
    let k = suggest(v);
    if (k && kw === 2) k = k.length === 1 ? k + k : k;
    if (!k || k.length !== kw || used.has(k)) {
      while (used.has(all[next])) next++;
      k = all[next];
    }
    used.add(k);
    seen.set(JSON.stringify(v), k);
    legend[k] = toLegend(v);
  }
  const rows = [];
  for (let y = 0; y < height; y++) {
    let s = '';
    for (let x = 0; x < width; x++) s += seen.get(JSON.stringify(values[y * width + x]));
    rows.push(s);
  }
  return { legend, rows };
}
