// brushtest.mjs -- the topology test level for terrain brushes
// (docs/design/BRUSH-CLASSIFICATION.md, "The test level").
//
// One collision layout per brush kind, the same for every tile set, so any
// brush can be painted on it and compared with any other.  The ground layout
// holds every way a ground cell can sit among its eight neighbours (the 47
// "blob" shapes: blobOf in autotile.mjs) at least once, in level-like
// pieces -- loose blocks and bars, a window of one-wide lines, crosses with
// filled quadrants, a block with holes one in from each side, a block with
// arms, things standing on the floor, a wall with ledges both ways -- and
// slopes against flat ground, walls, each other and a second storey: 1:1 and
// gentle hills, a peak, a valley, a slope into a wall, two-high hills, gentle
// into 1:1 and back.  The other kinds' layouts are runs, stacks and pools on a
// floor of the tile set's ground.  Every layout fits a room (at most 1950
// cells; 75 x 26 for the ground).
//
//   '#' ground  '/' '\' 1:1 slope up / down  'a' 'b' gentle up (low, high half)
//   'c' 'd' gentle down (high, low half)  '=' one-way platform  'H' ladder
//   '~' water  '^' hazard  '.' air
//
// Browser-safe, no dependencies beyond autotile.mjs.  Users: the editor
// (Tiles tab, a brush's Test level) and tools/katam/dev/brush_sheet.mjs.
import { retile, provenance, shapesOf, blobOf, SLOPES } from './autotile.mjs';

export const LEVELS = {
  solid: [
    "...........................................................................",
    "..............#..#..##..###................................................",
    "..#..##..###..#..#..##..###................................................",
    ".................#......###................................................",
    "...........................................................................",
    "..#######...##.##..##...#######............................................",
    "..#..#..#..###.###.###..##.####....#.......................................",
    "..#..#..#...#...#...##..#######....#.......................................",
    "..#######...............#####.#...###......................................",
    "..#..#..#...#...#...##..#.#####.#######....................................",
    "..#..#..#..###.###.###..####.##...###......................................",
    "..#######...##.##..##...#######....#.......................................",
    "...................................#.......................................",
    "...........................................................................",
    ".........................................../##\\.....ab#cd....../#\\.........",
    "............##########..................../####\\..ab#####cd..ab###\\../#cd..",
    "............##########...................#################################.",
    "...............###.......................#################################.",
    "...............###.......#.................................................",
    "..####.........###.......#..##.##....................................###...",
    "..####.........###.......#..##.##....................................###...",
    "..####.........###.......#..##.##......../###\\../\\..ab##cd..##\\/###./###...",
    "##########..###############################################################",
    "##########..###############################################################",
    "###########################################################################",
    "###########################################################################",
  ],
  platform: [
    "........................................",
    "........................................",
    "........................................",
    "...===...=...==...======................",
    "........................................",
    "..............................##........",
    "...===........................##........",
    "...===.....................===##===.....",
    "..............................##........",
    "..............................##........",
    "..............................##........",
    ".........======...............##........",
    "###################=======##############",
    "###################.......##############",
    "########################################",
    "########################################",
  ],
  ladder: [
    "..............................",
    "..............................",
    "..............................",
    ".................H............",
    ".................H............",
    ".................H....######..",
    "...........===###H###....H....",
    "............H....H.......H....",
    ".........H..H....H.......H....",
    ".........H..H....H.......H....",
    "......H..H..H....H............",
    "...H..H..H..H....H............",
    "##############################",
    "##############################",
    "##############################",
    "##############################",
  ],
  water: [
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "........................................",
    "..................#.........#...........",
    "..................#...###...#...........",
    "..................#...###...#...........",
    "..................#~~~###~~~#...#.......",
    "..................#~~~~~~~~~#...#~~~~~~~",
    "..................#~~~~~~~~~#...#~~~~~~~",
    "..................#~~~~~~~~~#...#~~~~~~~",
    "###~~~~~~~~###~#########################",
    "###~~~~~~~~###~#########################",
    "###~~~~~~~~###~#########################",
    "########################################",
  ],
  hazard: [
    "..............................",
    "..............................",
    "..............................",
    "..............................",
    "..............................",
    "..............................",
    ".......................^^^....",
    "......................#####...",
    "......................#####...",
    "...^..^^^...^^^^^^^^..#####...",
    "##############################",
    "##############################",
    "##############################",
    "##############################",
  ],
};

const SLOPE_VALUE = { '/': 11, '\\': 12, a: 5, b: 6, c: 7, d: 8 };
const KIND = { '#': 'solid', '=': 'platform', H: 'ladder', '~': 'water', '^': 'hazard' };

/** The 47 shapes (blobOf values), in order. */
export const BLOBS = [...new Set(Array.from({ length: 256 }, (_, m) => blobOf(m)))].sort((a, b) => a - b);

/** A shape for people: the sides that are the same terrain, then the corners that are not. */
export function blobLabel(b) {
  const sides = [[2, 'up'], [8, 'left'], [16, 'right'], [64, 'down']].filter(([k]) => b & k).map(([, n]) => n);
  const holes = [[1, 2, 8, 'up-left'], [4, 2, 16, 'up-right'], [32, 64, 8, 'down-left'], [128, 64, 16, 'down-right']]
    .filter(([k, p, q]) => b & p && b & q && !(b & k)).map(([, , , n]) => n);
  return (sides.length ? 'joined ' + sides.join(', ') : 'alone') + (holes.length ? '; open ' + holes.join(', ') : '');
}

/**
 * Paint `style` (a brush from autotile.learn) on its kind's test level.
 *   colOf(kind)  the collision value a brush of that kind paints (the editor's kindValue)
 *   classOf(v)   a collision value's terrain class (classOfBits of its bits)
 *   base         the tile set's ground brush, for the floor under the other kinds
 *                (null: that floor keeps its collision and no art)
 * Returns { kind, W, H, art, col, cls, src, how, report }: how[i] is where the piece
 * of a cell the style painted came from ('own', 'near', 'borrowed': autotile
 * provenance), and report sums it up:
 *   shapes   the level's shapes for this kind, and those the style has its own pieces for
 *   slopes   likewise for the six slopes (ground only)
 *   cells    how many cells got 'own', 'near' and 'borrowed' pieces
 */
export function paintTest(model, style, { colOf, classOf, base = null, salt = 7 }) {
  const rows = LEVELS[style.kind];
  if (!rows) return null;
  const H = rows.length, W = rows[0].length, n = W * H;
  const art = new Array(n).fill(model.empty), col = new Array(n).fill(colOf('air')), cls = new Array(n).fill('air');
  const want = new Map(), cells = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, ch = rows[y][x];
    cells.push(i);
    if (ch === '.') continue;
    const kind = KIND[ch] || 'solid';
    col[i] = SLOPE_VALUE[ch] !== undefined ? SLOPE_VALUE[ch] : colOf(kind);
    cls[i] = classOf(col[i]);
    const st = kind === style.kind ? style : kind === 'solid' ? base : null;
    if (st) want.set(i, st);
  }
  const src = new Int32Array(n).fill(-1);
  const grid = { W, H, art, col, cls, src };
  retile(model, grid, cells, want, salt);
  const how = new Array(n).fill(null), count = { own: 0, near: 0, borrowed: 0 };
  const inLevel = new Set(), slopesIn = new Set();
  for (const [i, st] of want) {
    if (st !== style) continue;
    how[i] = provenance(model, grid, i, style);
    if (how[i]) count[how[i]]++;
    const ch = rows[(i / W) | 0][i % W];
    if (SLOPE_VALUE[ch] !== undefined) slopesIn.add(SLOPE_VALUE[ch]);
    else inLevel.add(shapeAt(rows, KIND[ch], i % W, (i / W) | 0));
  }
  const has = shapesOf(style), own = [...inLevel].filter((b) => has.has(b));
  const slopes = SLOPES.map((s) => s.value).filter((v) => slopesIn.has(v));
  const report = {
    shapes: { level: inLevel.size, own: own.length, missing: [...inLevel].filter((b) => !has.has(b)).sort((a, b) => a - b) },
    slopes: { level: slopes.length, own: slopes.filter((v) => [...has].some((k) => k >> 8 === v)).length },
    cells: count,
  };
  return { kind: style.kind, W, H, art, col, cls, src, how, report };
}

// a level cell's shape among the cells of its kind (slopes count as ground; the room's edge
// counts as ground and water, as in autotile BRUSH_KINDS)
const SAME = { solid: '#/\\abcd', platform: '=', ladder: 'H', water: '~', hazard: '^' };
const EDGE = { solid: true, water: true };
function shapeAt(rows, kind, x, y) {
  const H = rows.length, W = rows[0].length;
  let m = 0;
  [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].forEach(([dx, dy], k) => {
    const a = x + dx, b = y + dy;
    if (a < 0 || b < 0 || a >= W || b >= H ? !!EDGE[kind] : SAME[kind].includes(rows[b][a])) m |= 1 << k;
  });
  return blobOf(m);
}
