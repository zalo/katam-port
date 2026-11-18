// katam new-room: a minimal, valid room to start from (floor, walls, one
// enemy).  Art uses tileset:vanilla/29 tile 001 for solid cells and tile 000
// for air; replace the legend with real metatiles from your tileset.
import { ROOM_FORMAT } from './room.mjs';

export function scaffoldRoom(id, W = 30, H = 12) {
  W = Math.max(15, W); H = Math.max(10, H);
  const rows = [];
  for (let y = 0; y < H; y++) {
    if (y >= H - 2) rows.push('#'.repeat(W));
    else rows.push('#' + '.'.repeat(W - 2) + '#');
  }
  return {
    format: ROOM_FORMAT,
    id,
    name: 'New room',
    description: 'Scaffolded by katam new-room: a floor, two walls and one Waddle Dee. Edit art, collision, objects and doors.',
    size: { width: W, height: H },
    music: 'mus_rainbow_route',
    tileset: 'tileset:vanilla/29',
    palette: 'palette:vanilla/29',
    background: 'background:vanilla/28',
    art: { legend: { '.': '000.0 000.0 000.0 000.0', '#': '001.0 001.0 001.0 001.0' }, rows },
    collision: { legend: { '.': 0, '#': 13 }, rows },
    objects: [{ id: 'enemy1', type: 'waddle_dee_1', x: Math.floor(W / 2) * 16 + 8, y: (H - 3) * 16 + 8 }],
    doors: [],
  };
}
