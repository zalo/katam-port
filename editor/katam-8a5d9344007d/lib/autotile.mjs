// Terrain brushes: paint "ground here" and get the edges, corners and fill,
// in the room's own tileset.
//
// Mario-Maker-style editors do this with tile sets drawn for it: one piece
// per neighbour shape (16 or 47 of them) and a lookup.  This game's tile sets
// were not drawn that way: its rooms are hand-built from hundreds of pieces
// per set, a floor is three or four different rows deep, its fill is a
// picture several pieces wide rather than a repeating pattern, and one set
// holds several materials (grass ground, stone blocks, clouds).  A per-shape
// lookup over that mixes materials and breaks the pictures.
//
// So the brushes work BY EXAMPLE, from the rooms of the original game that
// use the tile set ("image analogies": the original's collision is to its
// art as your collision is to the art wanted):
//
//   - a STYLE is a material, known by its BODY: the cells of the original
//     with the same terrain on all four sides.  The body pieces form
//     communities (they sit next to each other); communities that are
//     entangled are one material; the surface cells (grass tops, lips, walls,
//     which several materials may share) belong to the body they lie on.
//   - each terrain cell is drawn by COPYING the piece of a cell of the
//     original (its SOURCE), of that style, chosen to minimise
//       1. how unlike the source's surroundings are to the cell's: same
//          terrain or not, two cells out (a top row from the row under it
//          from deep fill, an inner from an outer corner), how far the
//          terrain runs each way, and where slopes are;
//       2. how unusual the piece is for that place in the original (one-off
//          details stay rare);
//       3. for each side, how well it joins the neighbour's piece: best when
//          the neighbour copies the source's own neighbour (whole runs of the
//          original come across intact), fine when the two pieces sit side by
//          side somewhere in the original, and otherwise by how much their
//          touching pixel rows differ (when the caller gives pixels);
//     solved in reading order and then improved by a few sweeps;
//   - SLOPES are ground cells too: a slope cell copies a slope cell of the
//     same kind of slope, and the cells around it know where the slopes are
//     (the piece under a slope, the grass above it);
//   - the EDGE ART the original draws in the air against its ground (grass
//     blades over a floor, the lip of a ledge) follows the ground pieces;
//   - ties are broken by a seeded draw, so repainting does not reshuffle.
//
// Optional hand-checked knowledge per tile set (assets/schema/authoring/
// autotile/*.json, see RULES below) names, orders and prunes the styles, and
// lists pieces ("exclude") that belong to no brush, as ground or as edge art; the
// learned styles are the fallback for every tile set without it.
//
// Browser-safe, no dependencies.  The editor (web/editor/) is the user.

/** vocab.json collision "bits" -> the terrain kind the editor shows. */
export function classOfBits(bits) {
  if (!bits || bits === 'empty' || bits === 'unused') return 'air';
  if (bits.includes('hazard')) return 'hazard';
  if (bits.includes('door')) return 'door';
  if (bits.includes('water')) return 'water';
  if (bits.includes('ladder')) return 'ladder';
  if (bits.includes('breakable')) return 'breakable';
  if (bits.includes('top_solid')) return 'platform';
  if (bits.includes('slope')) return 'slope';
  if (bits.includes('solid')) return 'solid';
  return 'other';
}

/** Kinds a brush exists for, and what counts as "the same terrain" next door. */
export const BRUSH_KINDS = {
  solid: { label: 'Ground', same: (c) => c === 'solid' || c === 'slope', edge: true },   // a breakable block is drawn by its own art: the ground around it shows its edge
  platform: { label: 'Platform', same: (c) => c === 'platform', edge: false },
  ladder: { label: 'Ladder', same: (c) => c === 'ladder', edge: false },
  hazard: { label: 'Hazard', same: (c) => c === 'hazard', edge: false },
  water: { label: 'Water', same: (c) => c === 'water', edge: true },
};
/** The brush kind a terrain class is painted with: a slope is ground. */
export const kindOf = (c) => (c === 'slope' ? 'solid' : c);
const terrain = (c) => !!BRUSH_KINDS[kindOf(c)];

/**
 * The slopes the ground brush can draw, as collision values (metatile_attributes
 * names in the comments).  A cell painted with a ground style and one of these
 * collisions gets the material's slope piece of that kind.
 */
export const SLOPES = [
  { value: 11, label: 'Slope up 1:1', rise: 'R', step: 1 },        // floor_1_1_riseR
  { value: 12, label: 'Slope down 1:1', rise: 'L', step: 1 },      // floor_1_1_riseL
  { value: 5, label: 'Gentle up, low half', rise: 'R', step: 2 },  // floor_1_2_riseR_low
  { value: 6, label: 'Gentle up, high half', rise: 'R', step: 2 }, // floor_1_2_riseR_high
  { value: 7, label: 'Gentle down, high half', rise: 'L', step: 2 }, // floor_1_2_riseL_high
  { value: 8, label: 'Gentle down, low half', rise: 'L', step: 2 },  // floor_1_2_riseL_low
];

// the 24 cells around a cell: the ring next to it first (bits 0-7), then the ring two out
const NEAR = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const FAR = [];
for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) FAR.push([dx, dy]);
const AROUND = NEAR.concat(FAR);
const SIDE = [0, 1, 0, 1, 1, 0, 1, 0];          // NEAR[i] shares an edge (not just a corner)
const SIDES = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const SRC_SHIFT = 11, SRC_MASK = (1 << SRC_SHIFT) - 1;   // a source cell: room << 11 | index (a room has at most 1950 cells)

const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const sub = (m, k) => { let v = m.get(k); if (!v) m.set(k, v = new Map()); return v; };
const popcount = (v) => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/** Which of the 24 cells around (x, y) are the same terrain: the cell's shape. */
function shapeBits(w, h, x, y, isSame, edge) {
  let m = 0;
  for (let k = 0; k < 24; k++) {
    const a = x + AROUND[k][0], b = y + AROUND[k][1];
    if (a < 0 || b < 0 || a >= w || b >= h ? edge : isSame(b * w + a)) m |= 1 << k;
  }
  return m;
}

/** How far the same terrain runs up, right, down and left of a cell (0-4 each), packed. */
function depthOf(w, h, x, y, isSame, edge) {
  let out = 0;
  for (let d = 0; d < 4; d++) {
    const dx = [0, 1, 0, -1][d], dy = [-1, 0, 1, 0][d];
    let n = 0;
    for (; n < 4; n++) { const a = x + dx * (n + 1), b = y + dy * (n + 1); if (!(a < 0 || b < 0 || a >= w || b >= h ? edge : isSame(b * w + a))) break; }
    out |= n << (d * 4);
  }
  return out;
}
const depthDiff = (a, b) => Math.abs((a & 15) - (b & 15)) + Math.abs(((a >> 4) & 15) - ((b >> 4) & 15)) + Math.abs(((a >> 8) & 15) - ((b >> 8) & 15)) + Math.abs(((a >> 12) & 15) - ((b >> 12) & 15));

/** A cell's slope code: 0 when it is no slope, its collision value when known, else 1. */
const slopeCode = (cls, col, i) => (cls[i] === 'slope' || (cls[i] === 'platform' && col && col[i] >= 16 && col[i] <= 27) ? (col ? col[i] | 0 : 1) || 1 : 0);
/** The slope codes of a cell and the 8 around it, packed 6 bits each into a string key. */
function slopeSig(w, h, x, y, cls, col) {
  let any = false;
  const s = [];
  for (let k = -1; k < 8; k++) {
    const a = k < 0 ? x : x + NEAR[k][0], b = k < 0 ? y : y + NEAR[k][1];
    const v = a < 0 || b < 0 || a >= w || b >= h ? 0 : slopeCode(cls, col, b * w + a);
    if (v) any = true;
    s.push(v);
  }
  return any ? s : null;
}
const W_SLOPE_SELF = 40, W_SLOPE_SIDE = 4, W_SLOPE_CORNER = 1.5;
function slopeCost(a, b) {
  if (!a && !b) return 0;
  let c = 0;
  for (let k = 0; k < 9; k++) {
    const u = a ? a[k] : 0, v = b ? b[k] : 0;
    if (u !== v) c += k === 0 ? W_SLOPE_SELF : SIDE[k - 1] ? W_SLOPE_SIDE : W_SLOPE_CORNER;
  }
  return c;
}

/**
 * Optional hand-checked knowledge for a tile set (one JSON file per tile set):
 *   { "tileset": "tileset:vanilla/0",
 *     "styles": [ { "kind": "solid", "piece": "<a body piece token>", "name": "Grass on cobble",
 *                   "exclude": ["<token>", ...], "borrow": false }, ... ],
 *     "only": true,
 *     "exclude": ["<token>", ...] }
 * Each listed style is the learned style that holds that piece; listed styles
 * come first, in the order given, with the name given; with "only", unlisted
 * styles of a listed kind are dropped (other kinds keep what was learned).
 * The top-level "exclude" takes pieces out of every brush, ground and edge art
 * (a steel block among clouds); a style's own "exclude" takes them out of that
 * brush only, for pieces another brush rightly owns (the log ends a lumber
 * yard's soil lies against belong to its log brush, not to the soil).
 * A brush lacking a shape (a wall, an underside) borrows that shape's pieces
 * from the other brushes of its kind; "borrow": false keeps it to its own
 * nearest shapes instead (dirt cut square rather than framed in logs).
 */

/**
 * Learn a tileset's terrain from rooms: [{ W, H, art: [token], cls: [kind], col?: [collision value] }].
 * `empty` is the tileset's blank piece; `opaque(token)` says a piece has no
 * see-through pixel, `pixels(token)` gives its 16x16 RGBA (the caller has the
 * pixels; this module does not), `rules` is the tile set's hand-checked
 * knowledge (above), if any.
 */
export function learn(rooms, empty, { opaque = () => false, pixels = null, rules = null } = {}) {
  // the blank and flat-black pieces the original leaves where the camera never looks
  // `rules.exclude`: pieces of this tile set that are no part of any brush, ground or edge art
  // (steel blocks and pillars among clouds; the foot of a tree trunk standing on a lumber yard's grass)
  const exclude = new Set(rules && Array.isArray(rules.exclude) ? rules.exclude : []);
  const hidden = (t) => t === empty || exclude.has(t) || /^(...[.hvx]f ?){4}$/.test(t);
  const model = { empty, rooms: [], kinds: {}, styleOf: new Map(), rim: new Set() };
  const kindCount = new Map(), airUse = new Map();
  for (const kind of Object.keys(BRUSH_KINDS)) model.kinds[kind] = { styles: [] };

  for (const R of rooms) {
    const { W: w, H: h, art, cls } = R, col = R.col || null;
    if (w * h > SRC_MASK) continue;
    const shape = new Int32Array(w * h), depth = new Uint16Array(w * h), ok = new Uint8Array(w * h), slope = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      slope[i] = slopeCode(cls, col, i);
      const K = BRUSH_KINDS[kindOf(cls[i])];
      if (!K) continue;
      const x = i % w, y = (i / w) | 0, t = art[i];
      shape[i] = shapeBits(w, h, x, y, (j) => K.same(cls[j]), K.edge);
      depth[i] = depthOf(w, h, x, y, (j) => K.same(cls[j]), K.edge);
      if (hidden(t)) continue;
      ok[i] = 1;
      bump(sub(kindCount, t), kindOf(cls[i]));
    }
    // air pieces and how often they sit against terrain: the art a ground needs beside it
    for (let i = 0; i < w * h; i++) {
      if (cls[i] !== 'air' || art[i] === empty || exclude.has(art[i])) continue;   // an excluded piece is no edge art either
      const x = i % w, y = (i / w) | 0;
      let near = 0;
      for (const [dx, dy] of NEAR) { const a = x + dx, b = y + dy; if (a >= 0 && b >= 0 && a < w && b < h && terrain(cls[b * w + a])) { near = 1; break; } }
      const e = airUse.get(art[i]) || [0, 0]; e[0]++; e[1] += near; airUse.set(art[i], e);
    }
    model.rooms.push({ W: w, H: h, art, cls, col, shape, depth, ok, slope, style: new Array(w * h).fill(null) });
  }
  const count = new Map();
  for (const [t, m] of kindCount) count.set(t, Math.max(...m.values()));

  for (const kind of Object.keys(BRUSH_KINDS)) model.kinds[kind].styles = materials(model, kind);

  // a style is worth a brush when the original uses it enough
  for (const [kind, K] of Object.entries(model.kinds)) {
    const most = K.styles.length ? K.styles[0].cells.length : 0;
    K.styles = K.styles.filter((s) => (s.tokens.size <= 2 ? s.cells.length >= 24 : s.cells.length >= Math.max(kind === 'solid' ? 16 : 8, 0.03 * most) && (kind !== 'solid' || s.byShape.size >= 6)));
    // two platforms (ladders, ...) that are mostly the same pieces are one brush to a user: keep the bigger.
    // (Grounds share their grass and lips, so this would merge different materials.)
    if (kind !== 'solid') K.styles = K.styles.filter((s, k) => !K.styles.slice(0, k).some((o) => { let n = 0; for (const t of s.tokens) if (o.tokens.has(t)) n++; return n >= 0.5 * Math.min(s.tokens.size, o.tokens.size); }));
    for (const s of K.styles) s.label = kind === 'solid' && s.tokens.size <= 2 ? 'Block' : BRUSH_KINDS[kind].label;
    const ruled = rules && Array.isArray(rules.styles) ? rules.styles.filter((r) => (r.kind || 'solid') === kind) : [];
    if (ruled.length) {
      const picked = [];
      for (const r of ruled) {
        const s = K.styles.find((st) => !picked.includes(st) && st.tokens.has(r.piece) && st.cells.some((id) => model.rooms[id >> SRC_SHIFT].art[id & SRC_MASK] === r.piece && isBodyCell(model.rooms[id >> SRC_SHIFT], id & SRC_MASK)))
          || K.styles.find((st) => !picked.includes(st) && st.tokens.has(r.piece));
        if (!s) continue;
        if (r.name) s.title = r.name;
        if (Array.isArray(r.exclude) && r.exclude.length) dropPieces(model, s, new Set(r.exclude));
        if (r.borrow === false) s.noBorrow = true;
        picked.push(s);
      }
      K.styles = rules.only ? picked : picked.concat(K.styles.filter((s) => !picked.includes(s)));
    }
    K.styles = K.styles.slice(0, 6);
    // how usual each piece is for its shape, within the style: the original's one-off
    // details (a tuft of grass deep inside a wall) should stay rare in what is painted
    for (const s of K.styles) {
      s.usual = new Map();
      for (const [key, list] of s.byShape) {
        const m = new Map(); let top = 0;
        for (const id of list) { const t = model.rooms[id >> SRC_SHIFT].art[id & SRC_MASK]; bump(m, t); top = Math.max(top, m.get(t)); }
        for (const [t, n] of m) m.set(t, n / top);
        s.usual.set(key, m);
      }
      s.keys = [...s.byShape.keys()];
      s.near = new Map();      // shape key -> candidate sources, from the closest shapes the style has
    }
    const names = new Map();
    K.styles.forEach((s) => {
      const n = (names.get(s.label) || 0) + 1; names.set(s.label, n);
      s.index = n - 1; s.id = `${kind}:${s.label}:${n}`; s.name = s.title || `${s.label} ${n}`;
    });
  }
  // a piece seen on its own (a room loaded from a file) reads as the style that uses it most
  const uses = new Map();
  for (const R of model.rooms) for (let i = 0; i < R.style.length; i++) {
    const st = R.style[i];
    if (st && st.id) bump(sub(uses, R.art[i]), st); else { R.style[i] = null; if (st) R.ok[i] = 0; }
  }
  for (const [t, m] of uses) { let best = null, bn = 0; for (const [st, n] of m) if (n > bn) { best = st; bn = n; } model.styleOf.set(t, best); }
  // EDGE ART: the pieces the original draws in the air cells against terrain (grass
  // blades over a floor, the lip of a ledge, the underside of a ceiling), as opposed to
  // scenery that merely stands near it.  The brush owns these and nothing else in the air.
  // A piece that is mostly terrain itself, or a full opaque square (a back wall), is not an edge.
  // With pixels, a piece more than four-fifths opaque is a patch of back wall, not an edge.
  const solidish = (t) => { if (opaque(t)) return true; if (!pixels) return false; const p = pixels(t); let o = 0; for (let i = 3; i < p.length; i += 4) if (p[i] >= 128) o++; return o > 0.8 * 256; };
  for (const [t, [all, near]] of airUse) if (near >= 2 && near >= 0.7 * all && (count.get(t) || 0) < near && !solidish(t)) model.rim.add(t);
  // which pieces the original puts side by side (right of, under): a seam it drew
  model.pairH = new Map(); model.pairV = new Map();
  for (const R of model.rooms) for (let i = 0; i < R.W * R.H; i++) {
    if (!R.ok[i]) continue;
    if ((i % R.W) + 1 < R.W && R.ok[i + 1]) bump(sub(model.pairH, R.art[i]), R.art[i + 1]);
    if (i + R.W < R.W * R.H && R.ok[i + R.W]) bump(sub(model.pairV, R.art[i]), R.art[i + R.W]);
  }
  model.seam = seamCost(pixels);
  return model;
}

/** A style's own `exclude`: the cells that hold those pieces stop being its sources (no other brush gains them),
 *  and the brush draws none of them as edge art. */
function dropPieces(model, s, drop) {
  const keep = (id) => !drop.has(model.rooms[id >> SRC_SHIFT].art[id & SRC_MASK]);
  for (const id of s.cells) {
    if (keep(id)) continue;
    const R = model.rooms[id >> SRC_SHIFT], i = id & SRC_MASK;
    if (R.style[i] === s) R.style[i] = null;   // still a known neighbour for joins (pairH/pairV), just no source
  }
  s.cells = s.cells.filter(keep);
  for (const [key, list] of [...s.byShape]) { const l = list.filter(keep); if (l.length) s.byShape.set(key, l); else s.byShape.delete(key); }
  for (const t of drop) s.tokens.delete(t);
  s.drop = drop;   // and retile() puts none of them in the air beside this brush's ground
}

const isBodyCell = (R, i) => R.ok[i] && !R.slope[i] && (R.shape[i] & 0x5a) === 0x5a;   // NEAR 1,3,4,6: the four sides
const shapeKey = (shape, slope) => (shape & 255) | (slope << 8);
const MERGE = 0.12;

/** The styles (materials) of one brush kind, with every cell of the original given to one. */
function materials(model, kind) {
  const K = BRUSH_KINDS[kind];
  const mine = (R, i) => R.ok[i] && kindOf(R.cls[i]) === kind;
  // the body pieces and which sit next to which, among body cells
  const bodyG = new Map(), bodyN = new Map();
  const isBody = model.rooms.map((R) => {
    const b = new Uint8Array(R.W * R.H);
    for (let i = 0; i < b.length; i++) if (mine(R, i) && isBodyCell(R, i)) b[i] = 1;
    return b;
  });
  model.rooms.forEach((R, r) => {
    const b = isBody[r];
    for (let i = 0; i < b.length; i++) {
      if (!b[i]) continue;
      bump(bodyN, R.art[i]);
      const x = i % R.W;
      for (const j of [x + 1 < R.W ? i + 1 : -1, i + R.W < b.length ? i + R.W : -1]) if (j >= 0 && b[j]) { bump(sub(bodyG, R.art[i]), R.art[j]); bump(sub(bodyG, R.art[j]), R.art[i]); }
    }
  });
  const toks = [...bodyN.keys()].sort((a, c) => bodyN.get(c) - bodyN.get(a) || (a < c ? -1 : 1));
  const label = propagate(toks, bodyG, (l) => bodyN.get(l) || 0);
  // communities that touch a lot, for their size, are one material drawn with
  // several sets of pieces (a cliff's light and dark faces): merge them, most
  // entangled first; then small ones are details of what they touch most
  const degree = new Map(), between = new Map(), csize = new Map();
  for (const t of toks) {
    bump(csize, label.get(t), bodyN.get(t));
    for (const [u, n] of bodyG.get(t) || []) {
      const a = label.get(t), c = label.get(u);
      bump(degree, a, n);
      if (a !== c) bump(sub(between, a), c, n);
    }
  }
  // a piece stacked with itself (a stone block, a crate) is its own material however much it touches others
  const selfN = new Map(), ctoks = new Map();
  for (const t of toks) { bump(ctoks, label.get(t)); const self = (bodyG.get(t) || new Map()).get(t); if (self) bump(selfN, label.get(t), self); }
  const blocky = (l) => (ctoks.get(l) || 0) <= 2 && (selfN.get(l) || 0) >= 0.4 * (degree.get(l) || 1);
  const join = (from, to) => {
    for (const t of toks) if (label.get(t) === from) label.set(t, to);
    bump(csize, to, csize.get(from)); csize.delete(from);
    bump(degree, to, degree.get(from) || 0); degree.delete(from);
    for (const [c, n] of between.get(from) || []) { if (c === to) continue; bump(sub(between, to), c, n); const bc = sub(between, c); bc.delete(from); bump(bc, to, n); }
    between.delete(from); if (between.has(to)) between.get(to).delete(from);
  };
  for (;;) {
    let pick = null, best = MERGE;
    for (const [a, m] of between) for (const [c, n] of m) {
      const aff = n / Math.min(degree.get(a) || 1, degree.get(c) || 1);
      if (aff > best && !blocky(a) && !blocky(c)) { best = aff; pick = [a, c]; }
    }
    if (!pick) break;
    const [a, c] = pick;
    if (csize.get(a) >= csize.get(c)) join(c, a); else join(a, c);
  }
  const big = Math.max(0, ...csize.values());
  for (const l of [...csize.keys()].sort((a, c) => csize.get(a) - csize.get(c))) {
    if (!csize.has(l) || csize.get(l) >= Math.max(12, 0.03 * big) || (blocky(l) && csize.get(l) >= 12)) continue;
    let to = null, tn = 0;
    for (const [m, n] of between.get(l) || []) if (n > tn) { to = m; tn = n; }
    if (to) join(l, to);
  }
  // every cell: body cells by their piece, then outwards (what is under a cell first) up to 3 cells
  const mats = model.rooms.map((R, r) => {
    const m = new Array(R.W * R.H).fill(null);
    for (let i = 0; i < m.length; i++) if (isBody[r][i]) m[i] = label.get(R.art[i]);
    for (let d = 0; d < 3; d++) {
      const next = [];
      for (let i = 0; i < m.length; i++) {
        if (m[i] || !mine(R, i)) continue;
        const x = i % R.W, y = (i / R.W) | 0, votes = new Map();
        for (const [dx, dy, wgt] of [[0, 1, 3], [-1, 0, 2], [1, 0, 2], [0, -1, 1]]) { const a = x + dx, c = y + dy; if (a >= 0 && c >= 0 && a < R.W && c < R.H && m[c * R.W + a]) bump(votes, m[c * R.W + a], wgt); }
        let best = null, bn = 0;
        for (const [l, n] of votes) if (n > bn) { best = l; bn = n; }
        if (best) next.push(i, best);
      }
      for (let k = 0; k < next.length; k += 2) m[next[k]] = next[k + 1];
    }
    return m;
  });
  // pieces seen away from any body: the material they usually have, or a community of their own
  const tokMat = new Map();
  model.rooms.forEach((R, r) => { for (let i = 0; i < R.art.length; i++) if (mats[r][i]) bump(sub(tokMat, R.art[i]), mats[r][i]); });
  const thinG = new Map(), thinN = new Map();
  model.rooms.forEach((R, r) => {
    for (let i = 0; i < R.art.length; i++) {
      if (mats[r][i] || !mine(R, i)) continue;
      const tm = tokMat.get(R.art[i]);
      if (tm) { let best = null, bn = 0; for (const [l, n] of tm) if (n > bn) { best = l; bn = n; } mats[r][i] = best; continue; }
      bump(thinN, R.art[i]);
      const x = i % R.W;
      for (const j of [x + 1 < R.W ? i + 1 : -1, i + R.W < R.art.length ? i + R.W : -1]) if (j >= 0 && mine(R, j) && !mats[r][j] && !tokMat.has(R.art[j])) { bump(sub(thinG, R.art[i]), R.art[j]); bump(sub(thinG, R.art[j]), R.art[i]); }
    }
  });
  const thinT = [...thinN.keys()].sort((a, c) => thinN.get(c) - thinN.get(a) || (a < c ? -1 : 1));
  const thinL = propagate(thinT, thinG, (l) => thinN.get(l) || 0);
  model.rooms.forEach((R, r) => { for (let i = 0; i < R.art.length; i++) if (!mats[r][i] && mine(R, i)) mats[r][i] = '~' + thinL.get(R.art[i]); });

  const tally = new Map();
  for (const m of mats) for (const l of m) if (l) bump(tally, l);
  const styles = [...tally].sort((a, c) => c[1] - a[1]).map(([l, n]) => ({ kind, key: l, tokens: new Set(), n, cells: [], byShape: new Map() }));
  const byKey = new Map(styles.map((st) => [st.key, st]));
  model.rooms.forEach((R, r) => {
    for (let i = 0; i < mats[r].length; i++) {
      if (!mats[r][i]) continue;
      const st = byKey.get(mats[r][i]), id = (r << SRC_SHIFT) | i, key = shapeKey(R.shape[i], R.slope[i]);
      R.style[i] = st; st.tokens.add(R.art[i]); st.cells.push(id);
      let l = st.byShape.get(key); if (!l) st.byShape.set(key, l = []); l.push(id);
    }
  });
  return styles;
}

/** Label propagation: every token takes the label most of its neighbours (by how often they touch) carry. */
function propagate(toks, graph, weight) {
  const label = new Map(toks.map((t) => [t, t]));
  for (let it = 0; it < 30; it++) {
    let moved = 0;
    for (const t of toks) {
      const votes = new Map();
      for (const [u, n] of graph.get(t) || []) if (label.has(u)) bump(votes, label.get(u), n);
      let best = label.get(t), bn = votes.get(best) || 0;
      for (const [l, n] of votes) if (n > bn || (n === bn && weight(l) > weight(best))) { best = l; bn = n; }
      if (best !== label.get(t)) { label.set(t, best); moved++; }
    }
    if (!moved) break;
  }
  return label;
}

// How badly two pieces join where the original never put them together: the
// difference of the pixel rows (columns) that touch, 0 (seamless) to 1.
function seamCost(pixels) {
  if (!pixels) return () => 0.6;
  const edges = new Map(), memo = new Map();
  const edge = (t) => {
    let e = edges.get(t);
    if (e) return e;
    const p = pixels(t), top = [], bottom = [], left = [], right = [];
    for (let k = 0; k < 16; k++) {
      for (const [arr, o] of [[top, k * 4], [bottom, (240 + k) * 4], [left, k * 64], [right, k * 64 + 60]]) arr.push(p[o + 3] < 128 ? -1 : p[o], p[o + 1], p[o + 2]);
    }
    edges.set(t, e = { top, bottom, left, right });
    return e;
  };
  return (a, b, vertical) => {
    const key = a + (vertical ? '|' : '-') + b;
    let c = memo.get(key);
    if (c !== undefined) return c;
    const A = vertical ? edge(a).bottom : edge(a).right, B = vertical ? edge(b).top : edge(b).left;
    let s = 0;
    for (let k = 0; k < 48; k += 3) {
      if (A[k] < 0 || B[k] < 0) { s += A[k] < 0 && B[k] < 0 ? 0 : 255; continue; }
      s += (Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2])) / 3;
    }
    c = Math.min(1, s / 16 / 90);
    memo.set(key, c);
    return c;
  };
}

// a small, fast, seedable hash -> [0, 1)
function rnd(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const W_FOREIGN = 5, W_WALL = 2.5, W_NEAR = 6, W_FAR = 1, W_DEPTH = 1.5, W_ODD = 3, P_KNOWN = 1, P_CORNER = 1.2, P_SEAM = 7, MAX_TRY = 64, PASSES = 4;

/**
 * Candidate sources for a shape: the style's cells of that shape, else of the
 * closest shapes it has.  A material the original never drew in some shape (a
 * ground only ever seen as a floor has no underside) borrows the cells of that
 * exact shape from the other styles of its kind, at a price (W_FOREIGN).
 */
function candidates(model, style, key) {
  let list = style.near.get(key);
  if (list) return list;
  const dist = (k) => ((k >> 8) !== (key >> 8) ? 1000 : 0) + 3 * popcount((k ^ key) & 0x5a) + popcount((k ^ key) & 0xa5);
  const exact = style.byShape.get(key);
  if (exact && exact.length >= MAX_TRY / 2) list = exact;
  else {
    const keys = style.keys.slice().sort((a, b) => dist(a) - dist(b));
    list = [];
    for (const k of keys) {
      if (list.length >= MAX_TRY && dist(k) > dist(keys[0])) break;
      list.push(...style.byShape.get(k));
    }
    if ((!exact || exact.length < 8) && style.tokens.size > 2 && !style.noBorrow && (!keys.length || dist(keys[0]) >= 3)) {      // a block is stacked whole: it borrows nothing; nor does a style with a near miss of its own
      const more = [];
      for (const other of model.kinds[style.kind].styles) if (other !== style && other.tokens.size > 2 && other.byShape.has(key)) more.push(...other.byShape.get(key));
      const step = Math.max(1, Math.floor(more.length / MAX_TRY));
      for (let q = 0; q < more.length; q += step) list.push(more[q]);
    }
  }
  style.near.set(key, list);
  return list;
}

/**
 * Re-pick the pieces of `cells` (indices) in a grid:
 *   grid = { W, H, art: [token], cls: [kind], col?: [collision value], src?: Int32Array }
 *   want = Map(index -> style) for cells just painted; other terrain cells keep
 *          the style of the piece they have (pieces of no style are left alone).
 * `grid.col`, when given, tells the kinds of slope apart.
 * `grid.src`, when given (one entry per cell, -1 = unknown), remembers which
 * cell of the original each cell was copied from, between calls.
 * Returns the indices whose art changed.  Also tends the edge art in the air
 * cells around the touched terrain.
 */
export function retile(model, grid, cells, want = new Map(), salt = 0) {
  const { W: w, H: h, art, cls } = grid, col = grid.col || null;
  const src = grid.src && grid.src.length === w * h ? grid.src : new Int32Array(w * h).fill(-1);
  const changed = new Set();
  const region = [...new Set(cells)].filter((i) => i >= 0 && i < w * h).sort((a, b) => a - b);
  const styleAt = (i) => want.get(i) || (!terrain(cls[i]) ? null : src[i] >= 0 && model.rooms[src[i] >> SRC_SHIFT].art[src[i] & SRC_MASK] === art[i] ? model.rooms[src[i] >> SRC_SHIFT].style[src[i] & SRC_MASK] : model.styleOf.get(art[i])) || null;
  const set = (i, t) => { if (art[i] !== t) { art[i] = t; changed.add(i); } };
  const todo = region.filter((i) => { const s = styleAt(i); return s && s.kind === kindOf(cls[i]) && s.usual; });
  for (const i of todo) if (want.has(i)) src[i] = -1;

  const n = todo.length, at = new Int32Array(w * h).fill(-1);
  todo.forEach((i, k) => { at[i] = k; });
  const info = todo.map((i) => {
    const style = styleAt(i), B = BRUSH_KINDS[style.kind], x = i % w, y = (i / w) | 0;
    const shape = shapeBits(w, h, x, y, (j) => B.same(cls[j]), B.edge), depth = depthOf(w, h, x, y, (j) => B.same(cls[j]), B.edge);
    const sig = slopeSig(w, h, x, y, cls, col), self = slopeCode(cls, col, i);
    const list = candidates(model, style, shapeKey(shape, self)), base = [];
    const step = Math.max(1, Math.floor(list.length / MAX_TRY)), off = Math.floor(rnd(x, y, salt + 3) * step);
    for (let q = off; q < list.length; q += step) base.push(list[q]);
    const wall = SIDES.map(([dx, dy]) => { const a = x + dx, b = y + dy; return a < 0 || b < 0 || a >= w || b >= h ? null : art[b * w + a]; });   // what is in the air beside it now
    return { i, x, y, style, B, shape, depth, sig, base, wall, memo: new Map() };
  });
  const unary = (c, id) => {
    let u = c.memo.get(id);
    if (u !== undefined) return u;
    const R = model.rooms[id >> SRC_SHIFT], si = id & SRC_MASK, d = R.shape[si] ^ c.shape;
    const usual = (c.style.usual.get(shapeKey(R.shape[si], R.slope[si])) || new Map()).get(R.art[si]) || 0;
    u = W_NEAR * popcount(d & 255) + W_FAR * popcount(d >>> 8) + W_DEPTH * depthDiff(R.depth[si], c.depth) + W_ODD * (1 - Math.sqrt(usual)) + rnd(c.x * 31 + (id & 1023), c.y * 17 + (id >> 10), salt) * 0.6;
    if (R.style[si] !== c.style) u += W_FOREIGN;
    // a source drawn against a back wall (an opaque piece in the air beside it) leans on art the brush will not put there
    const sx = si % R.W, sy = (si / R.W) | 0;
    for (let k = 0; k < 4; k++) {
      if (c.shape & (1 << [1, 3, 4, 6][k])) continue;
      const a = sx + SIDES[k][0], b = sy + SIDES[k][1];
      if (a < 0 || b < 0 || a >= R.W || b >= R.H) continue;
      const t = R.art[b * R.W + a];
      if (R.cls[b * R.W + a] === 'air' && t !== model.empty && !model.rim.has(t) && c.wall[k] !== t) u += W_WALL;
    }
    if (c.sig || R.slope[si] || hasSlopeNear(R, si)) u += slopeCost(c.sig, slopeSig(R.W, R.H, si % R.W, (si / R.W) | 0, R.cls, R.col));
    c.memo.set(id, u);
    return u;
  };
  const pairCost = (ta, tb, vertical) => {
    const m = (vertical ? model.pairV : model.pairH).get(ta);
    if (m && m.has(tb)) return P_KNOWN;
    return P_KNOWN + P_SEAM * Math.max(0, model.seam(ta, tb, vertical) - 0.12);
  };
  const settled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (terrain(cls[i]) && at[i] < 0) settled[i] = 1;
  const pick = new Int32Array(n).fill(-1);
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = 0;
    for (let q = 0; q < n; q++) {
      const k = pass & 1 ? n - 1 - q : q, c = info[k], i = c.i;
      // the settled neighbours on the four sides, and the cells beside their sources
      const nb = [], cand = new Set(c.base);
      for (const [dx, dy] of NEAR) {
        const a = c.x + dx, b = c.y + dy;
        if (a < 0 || b < 0 || a >= w || b >= h) continue;
        const j = b * w + a;
        if (!settled[j] || !c.B.same(cls[j])) continue;
        nb.push(dx, dy, j);
        const s = src[j];
        if (s < 0) continue;
        const R = model.rooms[s >> SRC_SHIFT], si = s & SRC_MASK, sx = si % R.W - dx, sy = ((si / R.W) | 0) - dy;
        if (sx < 0 || sy < 0 || sx >= R.W || sy >= R.H) continue;
        const cc = sy * R.W + sx;
        if (R.ok[cc] && R.style[cc] && (R.style[cc] === c.style || (!c.style.noBorrow && R.style[cc].kind === c.style.kind && c.style.tokens.size > 2 && R.style[cc].tokens.size > 2))) cand.add((s & ~SRC_MASK) | cc);
      }
      let best = -1, bestScore = 1e9;
      for (const id of cand) {
        let score = unary(c, id);
        if (score >= bestScore) continue;
        const R = model.rooms[id >> SRC_SHIFT], si = id & SRC_MASK, sx = si % R.W, sy = (si / R.W) | 0, t = R.art[si];
        for (let m = 0; m < nb.length && score < bestScore; m += 3) {
          const dx = nb[m], dy = nb[m + 1], j = nb[m + 2], a = sx + dx, b = sy + dy;
          if (src[j] >= 0 && a >= 0 && b >= 0 && a < R.W && b < R.H && src[j] === ((id & ~SRC_MASK) | (b * R.W + a))) continue;   // the original's own neighbour
          if (dx && dy) { if (a < 0 || b < 0 || a >= R.W || b >= R.H || R.art[b * R.W + a] !== art[j]) score += P_CORNER; continue; }   // a corner: only whether the original had the same piece there
          score += dy ? (dy > 0 ? pairCost(t, art[j], true) : pairCost(art[j], t, true)) : dx > 0 ? pairCost(t, art[j], false) : pairCost(art[j], t, false);
        }
        if (score < bestScore) { bestScore = score; best = id; }
      }
      settled[i] = 1;
      if (best < 0) continue;
      if (pick[k] !== best) { moved++; pick[k] = best; }
      src[i] = best; set(i, model.rooms[best >> SRC_SHIFT].art[best & SRC_MASK]);
    }
    if (!moved) break;
  }

  // The air around the terrain.  The original's ground does not stop at its
  // collision: its art runs on into the air cells beside it.  Each air cell
  // next to terrain takes what the original has in the same place relative to
  // the cells the terrain was copied from (what is under an air cell counting
  // most).  Only blank cells and cells that already hold edge art are touched:
  // scenery placed by hand stays.
  const air = new Set();
  for (const i of todo.length ? region : []) {
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = x + dx, b = y + dy; if (a >= 0 && b >= 0 && a < w && b < h && cls[b * w + a] === 'air') air.add(b * w + a); }
  }
  for (const i of region) if (cls[i] === 'air') air.add(i);
  const around = (W_, H_, cl, px, py) => { let m = 0; for (let k = 0; k < 8; k++) { const a = px + NEAR[k][0], b = py + NEAR[k][1]; if (a >= 0 && b >= 0 && a < W_ && b < H_ && terrain(cl[b * W_ + a])) m |= 1 << k; } return m; };
  for (const j of air) {
    src[j] = -1;
    if (art[j] !== model.empty && !model.rim.has(art[j])) continue;
    const x = j % w, y = (j / w) | 0, votes = new Map();
    const here = around(w, h, cls, x, y);
    let near = 0, known = 0;
    for (let k = 0; k < 8; k++) {
      const a = x + NEAR[k][0], b = y + NEAR[k][1];
      if (a < 0 || b < 0 || a >= w || b >= h || !terrain(cls[b * w + a])) continue;
      near++;
      const s = src[b * w + a];
      if (s < 0) continue;
      known++;
      const R = model.rooms[s >> SRC_SHIFT], si = s & SRC_MASK, sx = si % R.W - NEAR[k][0], sy = ((si / R.W) | 0) - NEAR[k][1];
      if (sx < 0 || sy < 0 || sx >= R.W || sy >= R.H || R.cls[sy * R.W + sx] !== 'air') continue;
      if (around(R.W, R.H, R.cls, sx, sy) !== here) continue;      // the original's cell sits against other terrain too: its art is about that
      const t = R.art[sy * R.W + sx], st = styleAt(b * w + a);   // the brush painted there: its own exclude covers the edge art it brings along
      bump(votes, model.rim.has(t) && !(st && st.drop && st.drop.has(t)) ? t : model.empty, !SIDE[k] ? 1 : NEAR[k][1] === 1 ? 4 : 3);
    }
    if (!near) { set(j, model.empty); continue; }
    if (!known || !votes.size) continue;        // terrain the brush did not place: leave its edges alone
    let best = model.empty, bn = 0;
    for (const [t, m] of votes) if (m > bn) { best = t; bn = m; }
    set(j, best);
  }
  return [...changed];
}
const hasSlopeNear = (R, i) => {
  const x = i % R.W, y = (i / R.W) | 0;
  for (const [dx, dy] of NEAR) { const a = x + dx, b = y + dy; if (a >= 0 && b >= 0 && a < R.W && b < R.H && R.slope[b * R.W + a]) return true; }
  return false;
};

/** A small sample of a style (cols x rows of pieces), for a swatch. */
export function sample(model, style, cols = 4, rows = 3) {
  const w = cols + 2, h = rows + 2, art = new Array(w * h).fill(model.empty), cls = new Array(w * h).fill('air');
  const want = new Map(), cells = [];
  const body = style.kind === 'solid' || style.kind === 'water';
  for (let y = 2; y < h; y++) for (let x = 1; x < w - 1; x++) {
    if (!body && style.kind !== 'ladder' && y !== 2) continue;
    if (style.kind === 'ladder' && x !== (w >> 1)) continue;
    const i = y * w + x; cls[i] = style.kind; want.set(i, style); cells.push(i);
  }
  retile(model, { W: w, H: h, art, cls }, cells, want, 7);
  return { W: w, H: h, art };
}
