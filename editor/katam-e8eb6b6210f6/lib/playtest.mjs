// Playtest helpers shared by `katam playtest` (native) and the web playtest
// page (web/playtest/): where to put Kirby, and the input script that gets
// the game from power-on to gameplay.
//
// Getting to gameplay: --warp alone does not leave the title/intro (the warp
// waits for a level, and the game never starts one without input).  The boot
// is the regression recordings' own (tools/make_recordings.py boot()): tap
// A+Right on a 20-frame period from frame 120, which with a fresh save walks
// through the title, file select and intro into the first level by frame
// ~1200; the warp is at frame 1300.  The same prefix the warp_sweep golden
// replays every run, so it is known to reach a level on every build.
// platform/playtest.c does the same thing for the web page (PortPlaytestBoot).

export const BOOT_TAP_FROM = 120;
export const BOOT_TAP_PERIOD = 20;
export const BOOT_TAP_MASK = 0x011;       // A | Right
export const WARP_FRAME = 1300;
export const SETTLE_FRAMES = 90;          // the warp's fade and the room load

const hex3 = (v) => v.toString(16).padStart(3, '0');

/** Where to arrive in room `roomNum`: the arrive cell of a door that leads
 *  into it (the stack's doors, sorted by source id, then door order), or the
 *  room's own first door cell, or its centre.  `door` picks the N-th incoming
 *  door; `at` = [x, y] overrides. */
export function chooseArrival(compiled, roomNum, { door = 0, at = null } = {}) {
  if (at) return { x: at[0], y: at[1], how: 'given' };
  const b = compiled.bindings;
  const incoming = [];
  for (const [id, d] of [...b.docs].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (!id.startsWith('room:')) continue;
    (d.doc.doors || []).forEach((dr, i) => {
      const to = b.resolve(dr.to);
      const n = to ? b.num.get(to) : (/(\d+)$/.exec(dr.to || '') || [])[1];
      if (Number(n) === roomNum && dr.arrive) incoming.push({ x: dr.arrive.x, y: dr.arrive.y, how: `door ${i} of ${id}` });
    });
  }
  if (incoming.length) return incoming[Math.min(door, incoming.length - 1)];
  const me = b.byNum.room.get(roomNum);
  const doc = me ? b.docs.get(me).doc : null;
  if (doc && doc.doors && doc.doors[0] && doc.doors[0].cells && doc.doors[0].cells.length) {
    const [x, y] = doc.doors[0].cells[0];
    return { x, y: y + 1, how: `under its own door 0` };
  }
  const w = doc ? doc.size.width : 15, h = doc ? doc.size.height : 10;
  return { x: w >> 1, y: h - 2, how: 'room centre (no door leads here)' };
}

/** Parse a playtest input script: katam-input lines whose frames count from
 *  arrival (k F MASK, MASK hex), or "hold MASK FROM TO" shorthand. */
export function parseScript(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('katam-input') || l.startsWith('frames')) continue;
    let m;
    if ((m = /^k\s+(-?\d+)\s+([0-9a-fA-F]+)$/.exec(l))) out.push([Number(m[1]), parseInt(m[2], 16)]);
    else if ((m = /^hold\s+([0-9a-fA-Fx]+)\s+(-?\d+)\s+(-?\d+)$/.exec(l))) { out.push([Number(m[2]), parseInt(m[1].replace(/^0x/i, ''), 16)]); out.push([Number(m[3]), 0]); }   // MASK is hex, like k's
    else throw new Error(`input script: cannot read "${l}" (k FRAME HEXMASK, or hold MASK FROM TO; frames count from arrival)`);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** A katam-input/1 recording: boot, warp into (room, x, y), then `script`
 *  (frames relative to arrival), `frames` frames of play after arrival. */
export function playtestRecording({ room, x, y, frames = 600, script = [], note = '' }) {
  const arrive = WARP_FRAME + SETTLE_FRAMES;
  const total = arrive + frames;
  const L = ['katam-input 1', `# katam playtest: boot, warp to room ${room} cell (${x},${y}) at frame ${WARP_FRAME}, play ${frames} frames from ${arrive}`];
  if (note) L.push(`# ${note}`);
  L.push(`frames ${total}`);
  let last = -1;
  const key = (f, m) => { if (m !== last) { L.push(`k ${f} ${hex3(m)}`); last = m; } };
  key(0, 0);
  for (let f = BOOT_TAP_FROM; f < WARP_FRAME; f++) key(f, (f - BOOT_TAP_FROM) % BOOT_TAP_PERIOD < BOOT_TAP_PERIOD / 2 ? BOOT_TAP_MASK : 0);
  key(WARP_FRAME, 0);
  L.push(`warp ${WARP_FRAME} 0 ${room} ${x} ${y}`);
  for (const [f, m] of script) if (arrive + f < total) key(Math.max(WARP_FRAME + 1, arrive + f), m);
  return { text: L.join('\n') + '\n', warpFrame: WARP_FRAME, arriveFrame: arrive, totalFrames: total };
}
