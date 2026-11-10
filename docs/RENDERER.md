# The GPU renderer (first cut)

`--renderer gpu` (native) / `?renderer=gpu` (web) draws the game with OpenGL
ES 3.0 / WebGL2 / GL 3.3 core from a **render list** built from game state.
The emulated PPU (`platform/ppu.c`) stays the default; `--renderer both` runs
the two and shows the GPU picture, for comparison.

    katam --renderer gpu --gpu-view 400x224 rom.gba      # fixed world viewport
    katam --renderer gpu --gpu-view auto rom.gba         # follows the window's aspect, 160 tall
    katam --renderer both --compare-log cmp.txt ...      # per-frame GPU vs PPU pixel diff
    katam --renderer gpu --shot-at 1700:out/f1700 ...    # out/f1700-gpu.png (+ -ppu.png with both)
    katam.html?renderer=gpu&view=400x224                 # web; without view= the stage's aspect

## Why GLES 3.0 / WebGL2

One code path for every target: WebGL2 *is* GLES 3.0, Mesa/NVIDIA/AMD give
GLES 3 on Linux, desktop 3.3 core on Windows/macOS takes the same shaders with
a different `#version` line. Integer textures (`R8UI`, `R16UI`, `RGBA32I`) and
`texelFetch` let the shader do exact GBA tile/palette arithmetic. No loader
library: `platform/render/gl_api.h` lists the ~55 entry points and resolves
them through `SDL_GL_GetProcAddress` (native) or links them (emscripten).
Headless: SDL's `offscreen` driver gives an EGL context (NVIDIA, radeonsi or
llvmpipe here); the web build was checked in a headless Chromium with
SwiftShader WebGL2.

## Layout

| file | role |
|---|---|
| `platform/render/render_list.h` | **the contract**: layers, sprites, HUD regions, per-line effect state, texture-cache sources |
| `platform/render/rl_build.c` | builds it: game hooks (linker wraps) and per-frame assembly; never writes game memory |
| `platform/render/gl_renderer.c` | the GL backend; knows only the render list; replaceable |
| `platform/native/host_sdl.c`, `platform/web/host_web.c` | context creation, present, screenshots |

### The render list

* **Spaces.** `SCREEN` (GBA screen coords; menus and anything unproven),
  `WORLD` (screen coords relative to the game camera but unbounded: layers
  have content at any x, sprites carry full s32 positions), `HUD` (anchored
  to a corner of the view, per region).
* **Layers** (`RlTileLayer`, one per hardware BG): space, parallax factor and
  the resulting shift, and for a streamed room layer the room's real tilemap
  (EWRAM, `Background.unk10`) plus the screen-space window in which VRAM holds
  the game's own copy (VRAM wins there: it is what the game last wrote,
  including blocks changed in place). Outside the window the map is sampled;
  parallax pictures wrap, mirror or are re-fitted (below).
* **Sprites** (`RlSprite`), front to back: OBJ attributes with the position
  fields zero, s32 x/y, affine matrix, space, HUD anchor. Not limited to 128.
* **HUD regions**: four rectangles of the 240x160 HUD, each pinned to its
  corner; x=160 splits the bottom strip between the health bar (cols 13-19)
  and the area name / enemy health (cols 20-29), so nothing tears.
* **Effects**: a per-line register table captured as the emulated display
  scans (scroll, affine reference points, DISPCNT, BLD*, WIN*, MOSAIC,
  BGxCNT), so HBlank effects are in it.
* **Texture-cache sources**: VRAM (with off-screen sprites' animation frames
  patched in from ROM, see below) and palette RAM. The backend uploads VRAM
  by dirty 256-byte rows, palette and line table every frame, room maps
  when they change.

M9 (MODDING.md) replaces the VRAM/palette references (`RlTileLayer.map`,
`RlSprite.attr2`'s tile and palette) with resource ids; spaces, anchors,
order and the effect description stay.

### Where the data comes from

* **Sprites**: `-Wl,--wrap=DisplaySprite,--wrap=sub_081564D8` call
  `PortRlEmitSprite` first, which repeats the game's attribute arithmetic
  without side effects, keeping positions before the 9-bit mask and before
  the 240x160 cull and the 128-entry pool. `--wrap=DrawToOamBuffer` commits
  the list in DrawToOamBuffer's own order (stable by link layer) and
  snapshots the camera and Background records -- the frame the next present
  shows. Every frame the committed sprites the game *did* write are checked
  against real OAM, entry by entry; on any mismatch that frame uses OAM only
  (1 frame in 20950 over the four recordings). OAM entries the hooks do not
  account for (a frozen pause frame) are appended from OAM.
  The game is not edited: wraps keep its machine code byte-identical, which
  keeps the regression hash's layout artifacts out of the way (below). HUD
  sprites are recognised by address (they live in the HUD task's struct).
  Off-screen "full" sprites never get their per-frame tiles uploaded by the
  game; the list patches them into its own VRAM copy from the ROM tables so
  they animate in the margin. (Apple's ld has no `--wrap`: `PORT_RL_NO_WRAP`
  falls back to OAM sprites.)
* **Layers/camera**: committed at the same moment, validated at present
  against the live BGxCNT/scroll registers (screen base, char base, low
  scroll bits); a record that does not match leaves that BG as a SCREEN layer.

## What the GPU draws vs the PPU

At 240x160 the GPU draws *everything* the PPU does -- text and affine BGs,
regular/affine/double-size sprites, 1D/2D mapping, priorities, WIN0/WIN1/
OBJWIN, alpha blending (BLDCNT and semi-transparent OBJ), brightness up/down,
vertical BG mosaic, forced blank, per-line HBlank effects -- with the same
5-bit integer arithmetic. **Measured: 0 differing pixels on every frame of
all four recordings** (attract 6600, boot_to_level 1400, play_rooms 7300,
warp_sweep 5650 frames; NVIDIA GLES 3.2 and Mesa radeonsi), and on the 407
native-framed frames of a 400x224 play_rooms run. No screen falls back to the
PPU. Not implemented in either: OBJ mosaic, bitmap modes (unused).

## Widescreen

Gameplay frames ("world": the room record validates and the room layer is a
streamed text BG) use the requested view; everything else (title, menus,
pause, transitions without a room) is drawn at 240x160 and integer-scaled.

* **Camera.** Centred on the game's camera, then clamped -- in the renderer,
  the game's camera is untouched -- to the game's own camera rectangle
  (`unk_S32Vec2_6C/74`) widened by the 8-px margins it insets from the map on
  top/left/right (not the bottom 40, never shown and empty in room 101), and
  never past the map. A scroll lock (a rectangle narrower than the room)
  keeps hiding what it hides. If the room is smaller than the view the rest
  is **letterboxed black**; the HUD is drawn over the bars. Chosen over
  showing the backdrop (the old purple void) or the map's far end (the
  wrap): it never shows content the game did not author for that spot.
* **Streamed windows** end where the map ends (bg.c reads two rows past it).
* **Parallax.** Every parallax layer moves at its factor times the
  *view's* motion, at any zoom, and is framed so the view's centre shows
  what the game shows at the screen's; where it can, the framing keeps the
  view inside the picture over the whole room. Past the picture's left or
  right end it repeats if the game itself wraps it, and is mirrored
  otherwise. Past its top or bottom (a view taller than the sky: rooms 202,
  402, 554 at 0.5x zoom) it is mirrored at the picture's edge; repeating the
  edge row drew vertical streaks there. See "Parallax at any zoom" below.
* **HUD**: four corner regions, BG1 and HUD sprites both; see below for
  its size.
* **Screen shake** (`RequestScreenShake` -> `viewportModX/Y_44/46`, added
  to the room layer's scroll only): the view, its clamps, the letterbox and
  every sprite follow the unshaken camera.  Zoomed in, the room layer's
  shake is rescaled by viewH / 160 so it is no bigger on screen than at 1x;
  zoomed out it keeps its game-pixel size, so on screen it shrinks with the
  zoom.  At 240x160 the scale is 1 and the picture is the PPU's.  Offsets over 16 px are not a
  shake (the vertical auto-scroll wrap reuses viewportModY_46) and pass
  through unchanged.

### Parallax at any zoom

sub_080019F8 scrolls a parallax record to `A + f * camera` per axis (A the
room's offset, f from LevelInfo `unkB8/unkBA` or `unk_S16Vec2_B4`). A view of
another size at world position V samples the layer from

    o(V) = A + f * V + K

(`ParallaxAxis` / `ParallaxOrigin`, rl_build.c), in 1/256 px, in the
integer build path (from the record's exact scroll, then floored) and in the
presented path (from the lerped scroll and the presented view) alike. K is
the framing: `(1 - f) * (240 - W) / 2` puts the view's centre on what the
game shows at the screen's centre (0 at 240x160: the PPU's picture). When
the picture is wide enough that the view, moving at rate f over every
position the view can take in this room (`ViewAt` at the camera rectangle's
ends), stays inside it, K is moved the least that keeps it there; a
factor-0 background is then a fixed picture. Otherwise the picture repeats
past its ends if the game wraps it at 240 (its window runs off the picture
over the camera range, or the room auto-scrolls it), and is mirrored if not.
Which of these applies depends on the room, so it is decided once per room
and layer (re-decided only if the map, rate, camera range or offset change)
rather than every frame.

Three bugs this replaced:

* **Zoomed-out flicker.** The old `FitAxis` decided repeat / mirror / re-fit
  every frame from whole-pixel scrolls. For a picture made to fit the room
  (the tutorial's 360-px sky, f = 32/256; rooms 101, 104, 106, 502) the
  "does it run off its end" test sits exactly on the boundary, and
  truncation flipped it between repeat and mirror from one frame to the
  next, so the whole layer outside the 360-px picture changed every few
  frames (271 flips in play_rooms at 744x320, 256 in tutorial_walk; 72
  frames of 300 with more than 2% of the window changing at once, in the
  presented path too). Mirrored, the columns inside the VRAM window past
  the picture's end were bg.c's wrapped copy, so the seam also moved with
  the window; the composite now treats a mirrored layer's samples past the
  picture as outside the window.
* **Zoomed-in parallax going the wrong way.** The parallax term was
  `(f - 1) * (view - wanted view)`, and zoomed in the wanted view is the one
  that follows Kirby, so the term was 0 and the layer moved with the view
  (rate 1) whenever Kirby moved inside the 240x160 screen: on screen the
  background stood still or ran with Kirby while the camera caught up. At
  120x80 the layer's rate per pixel of view motion measured 2-4 times its
  factor (room 101: 47/256 for 16; the tutorial: 71/256 for 32), with 48
  frames in play_rooms where it moved against the view. Now the view's world position is
  what the rate applies to.
* **Rate.** The game multiplies `(pos >> 4) * (factor >> 4)`, so the real
  rate is the factor rounded down to a multiple of 16 (room 101's 27 is 16);
  the parallax term used the unrounded factor and drifted against the game's
  own scroll when the view stopped at a room edge.

Measured (`KATAM_RL_LAYERLOG=FILE`: per built frame, per layer mode and
shift; `KATAM_RL_PRESLOG=FILE`: per present, BG0's origin and the view's
world position): mode flips 271 -> 0 (play_rooms, 744x320 and 960x400) and
256 -> 0 (tutorial_walk); the measured rate is now the effective factor in
every room at 744x320, 960x400, 186x80 and 120x80 (rooms with under ~40 px
of motion within +-1 px), with no frame moving against the view; in the
presented path (UI mode, 0.5x and 2x zoom, interpolation at a fake 120 Hz)
the origin moves at exactly f x the view's motion per present (error under
0.01 px), where zoomed in it measured 61/256 for f = 32/256. 240x160 stays
the PPU's (`--compare-log`, play_rooms, warp_sweep, aim, tutorial_walk).
`tests/recordings/tutorial_walk.txt` (fresh save, the tutorial room, right
across it and back at 744x320) keeps it under regression.

### HUD layer

The HUD lives in GBA screen space, 240x160, and the world view does not:
zoomed in, the view is narrower and shorter than the HUD, so drawn in view
pixels its regions overlap and the bottom strip leaves the picture; zoomed
out, it shrinks with the world. So the HUD has a size of its own, tied to
the window: **Auto** is the scale the world has at zoom 1 in this window
(`PortLayoutHudScale`; the scripted path uses the scale a 240x160 picture
would get), or the player's fixed 1x-8x; either way capped so the whole
240x160 HUD fits inside the world picture (a portrait phone, Fill window).

When that scale is the world's and the view is at least 240x160 -- zoom 1,
Auto, any aspect -- the HUD stays in the composite exactly as before (the
corner offsets are whole view pixels), which keeps the 240x160 picture
identical to the PPU's. Otherwise (`GlrSetHudLayer`):

* The sprite and composite passes leave the HUD out (the layer in
  `RL_SPACE_HUD`, the sprites in it) and run again for the HUD alone into a
  HUD atlas: one slot per region, at HUD coordinates with a 32-px gutter for
  HUD sprites that hang over their region's edge (a sprite belongs to the
  region holding its centre, as before, so nothing tears at x=160 or 120).
  Same priority, window and per-line colour-effect rules, evaluated on the
  HUD's own lines: a fade darkens or brightens the HUD exactly when it does
  on the GBA. Where alpha blending has the world as its second target the
  HUD pixel is written premultiplied (eva/16 of it, 1 - evb/16 of the world)
  and blended at present -- the one place this is an approximation (no
  5-bit rounding); a world layer the GBA would have drawn *over* the HUD by
  priority is under it here.
* `GlrPresentHud` draws each slot over the world picture, pinned to its
  corner (or centred, original strip), nearest or -- with Smooth scaling and
  a fractional scale -- sharp bilinear.

Non-world frames (title, menus, pause) have no HUD regions and are the
240x160 picture as always. Checked: forcing the layer at 1:1
(`KATAM_HUD_LAYER=1`, window 240x160) gives the same window, pixel for
pixel, as the in-composite HUD on every 15th frame of play_rooms and
warp_sweep (956 frames, fades included). `--shot-at F:PREFIX` also writes
`PREFIX-win.png`, the presented window, which is the picture that has the
HUD layer in it (`PREFIX-gpu.png` is the composite only).

### Object pop-in

The game spawns objects 48 px (3 cells) past the 240x160 screen and destroys
them past a 48-px margin. Those windows now follow the GPU view as a recorded
simulation input (docs/VIEW.md, "Spawn margin"; the numbers below are from
before that, with the stock windows). `KATAM_SPAWNSTAT=WxH` counts spawns and
despawns inside a view, which is the measure that matters now (0 scroll-in
spawns in view at 746x320, against 32 before). `KATAM_RL_POPSTAT=1` counts
sprites appearing/vanishing inside the view but outside 240x160 (room entries
excluded), animation and emitted effects included:

| view | play_rooms | warp_sweep | attract |
|---|---|---|---|
| 320x180 | 174 / 6938 frames (110 appear, 86 vanish) | 165 / 4739 | 174 / 6538 |
| 400x224 | 262 / 6938 (162, 160) | 316 / 4739 | 176 / 6538 |
| 480x270 | 354 / 6938 (211, 216) | 407 / 4739 | 188 / 6538 |

So ~2.5% of gameplay frames at 320 wide and ~4-7% at 400-480 show an object
popping in or out in the margin; most appearances are 0-48 px past the edge
(the spawn window and off-screen projectiles), 48+ px only from 400 up.

## Proving the simulation unchanged

The hooks only read game memory. Checked with the coordinator's gate
(`tests/layout_neutral.sh`, `tools/layout_diff.py` from the resources
branch): against the parent build, keys/vid/sram/pix match on every frame of
all four recordings with the renderer off, and the `sim` differences are the
same host pointers at other addresses (the port's static data moved because
the image grew). Goldens re-recorded; only `sim` moved. With the renderer on
(`gpu` at 400x224 and `both`), the same binary's keys/sim/vid/sram match a
renderer-off run on every frame. `KATAM_VIDEODRIVER=offscreen
KATAM_REGRESS_ARGS="--renderer gpu" tests/regress.sh` runs regress with it on.

The renderer-only SDL entry points are declared `noplt` so the PLT does not
grow and move the game's code (the sim hash canonicalises function pointers
by exact address; see the coordinator's note on layout sensitivity).

Unrelated finding: `PortSetRenderEnabled(0)` (used by rollback resim) makes
`PortPresentFrame` skip `PortRenderFrame` entirely, i.e. the HBlank DMA and
HBlank/VCount interrupts, although its comment says only composition is
skipped. The GPU path does not use it (`gPortPpuCompose` instead).

## Display rate, scaling

The window is resizable; the view (game pixels) is independent of it and is
integer-scaled (nearest) into it, fractional only below 1x. With `--vsync`
the GPU path presents at the display's rate (`PaceFrame`; on the web every
`requestAnimationFrame` paint), between 59.73 Hz sim frames.

## Smooth motion (interactive GPU path)

Presentation only: nothing below reads anything the hooks did not already
copy, and nothing is written back. The simulation clock is untouched -- the
host paces sim frames exactly as before (`--turbo`, `--replay` included);
only what each present draws changes. Settings **Smooth camera** and
**Interpolation** (menu: Display; `smoothcam2=`, `interp=`). Smooth camera is **off** by
default since 2026-11-09: on phones in landscape it dragged the frame rate
down after about a minute of play. Interpolation stays on.

**Why it juddered.** The world was composed in game pixels and scaled up,
so the camera moved in whole game pixels -- 2x zoom on a 1080p screen is
13.5 screen pixels a step -- and the game's own camera advances unevenly
in whole pixels (8.8 position, 1.06 px/frame walking: steps of 1,1,1,2...).
On top of that a 60 Hz display shows a 59.73 Hz game with a repeated frame
every 3.7 s, and a 120/144 Hz one repeats every frame unevenly.

**Smooth camera** (`PortRlPresentFrame`, `RL_PRESENT_SUBPIXEL`).

* The camera is placed at the game's 8.8 `viewportPosition`; each parallax
  layer at its exact `altViewport` scroll (sub_080019F8 drops the fraction
  when it writes the whole-pixel scroll); each fraction is only used if its
  whole pixel is the one the Background record holds. The composite then
  draws at k target pixels per game pixel (k = the whole part of the display
  scale, under a pixel budget: 3840x2160 native, 2560x1440 web), and every
  target pixel samples the texel under its centre at a 1/256-px position
  (`GlrDrawScaled`) -- the texels stay sharp k-pixel squares, and the
  remaining fraction of the scale is the present's stretch (nearest, or
  sharp bilinear with Smooth scaling).
* World sprites move with the tiles: they keep their whole-pixel world
  positions, so nothing swims against the background. The exception is
  Kirby (each player's three sprite structs, recognised by address and
  checked against his position the way the game rounds it): while he moves
  along an axis he is drawn at his own 8.8 position, so a camera following
  him does not make him vibrate a pixel against the screen. At rest he is
  where the GBA draws him -- the game parks him on x.996 as often as on x.0,
  and drawing that as written would sink him into the floor; the switch
  happens between two frames, and with interpolation on it is lerped.
* Zoomed in, the view follows Kirby's 8.8 position (as of the committed
  frame) instead of his whole pixel.
* The HUD (in the composite or as its own layer) stays on its own pixel
  grid, pinned; the 240x160 picture at zoom 1 with **Smooth camera** off is
  the integer path, bit for bit.

**Interpolation** (`RL_PRESENT_INTERP`). Each built frame keeps a motion
record (camera, layer scrolls, Kirby, and every sprite group: one
`PortRlEmitSprite` call, keyed by its `struct Sprite` and occurrence, with
its anchor). A present at time t draws alpha = (t - due) / period between
the previous sim frame and the last, `due` being when the host's schedule
said the last frame was due (`PortShowFrameDue`; native `sNextFrame`, web
`portFrameDue`), so presents evenly spaced in time show the world evenly
spaced. Camera, layers and sprite anchors are lerped; a sprite's subframes
follow its anchor, so animation frames changing under it do not stop the
motion. Nothing is interpolated across a frame gap (rollback catch-up), a
room change, a camera jump of 64+ px, a sprite jump of 32+ px, a sprite
with no match, or a netplay world sync (`PortRlNoteCorrection`, a hook the
netsim "state corrected" event calls; it snaps today, and is the place to
blend corrections out instead). Tile content, palette and effects are the
last frame's: only positions are blended.

Only where the host presents between frames: native with VSync on (not
`--turbo`, not a scripted run -- a scripted run's pictures depend on the
frame alone; `KATAM_INTERP=1` overrides for measuring), and the web, where
`PortWebAwaitFrame` hands back each paint that comes before the next frame
is due so it can be drawn.

**Latency.** Input is read at the start of a sim frame as before. Without
interpolation a present shows the last frame as soon as it exists; with it,
the picture shown at t is the state of t - one period, so it costs up to
one sim frame (16.7 ms), on average a little over half of one against a
display that would have shown that frame at its next refresh. Never more
than +1 frame: alpha is clamped to [0, 1] and the last frame is reached
the moment the next is due. The trade-off is the usual one; players who
want the minimum turn Interpolation off (Smooth camera costs no latency).

**Cost.** The composite runs per present at k x k the pixels -- on the GPU
here (RTX 4090) the 1080p picture at 120 Hz is far under budget; a weak
GPU can cap k with `KATAM_SMOOTH_KMAX=N`.

**Measured** (`KATAM_CAMLOG`, play_rooms frames 1300-2400 in UI mode at
2x zoom, 1920x1080, `KATAM_FAKE_HZ` standing in for a blocking vblank;
per-present camera step in game pixels, jumps excluded):

| | presents | step sd | step-to-step change (jerk) sd | presents with no motion | Kirby on-screen step sd |
|---|---|---|---|---|---|
| 60 Hz, before (integer) | 1105 | 0.635 | 0.814 | 159 | 0.550 |
| 60 Hz, smooth camera | 1105 | 0.484 | 0.191 | 113 | 0.351 |
| 60 Hz, + interpolation | 1105 | 0.479 | 0.128 | 110 | 0.350 |
| 120 Hz, before | 2210 | 0.701 | 1.239 | 1264 | 0.391 |
| 120 Hz, smooth camera | 2209 | 0.638 | 1.171 | 1217 | 0.252 |
| 120 Hz, + interpolation | 2210 | 0.263 | 0.216 | 223 | 0.176 |

(The remaining step sd is the camera really speeding up and slowing down;
"no motion" at 60 Hz is the camera at rest.) On a steady walk (frames
1420-1530) the jerk goes 0.772 -> 0.103 -> 0.081 at 60 Hz and 1.215 ->
1.146 -> 0.250 at 120 Hz, and Kirby's on-screen step sd 0.437 -> 0.

## Lighting and relief (branch `lighting`)

Off unless asked for: the page at `/lighting/`, `?lighting=1`, or
`KATAM_LIGHTING=1`; every level; GPU renderer only.
`platform/render/light.c` builds a per-room shadow map from the collision grid
(its header has the details) and the composite tints world pixels with it.

Each area has an environment (`kEnvs` in light.c, by the area the game's own
area map gives the room -- `platform/render/light_rooms.c`, falling back to the
room header's area byte for the tutorial and the Dimension Mirror): a sun's
direction and look for open rooms and a point-light look for enclosed ones --
day and torches (Rainbow Route), moonlight and candles (Moonlight Mansion), a
green day and crystal light (Cabbage Cavern), an orange sun and lava (Mustard
Mountain), golden afternoon (Carrot Castle), sea sun and aqua grottoes (Olive
Ocean), ice (Peppermint Palace), desert sun and amber torches (Radish Ruins),
starlight and violet crystals (Candy Constellation), mirror light and magenta
crystals (Dimension Mirror).  The renderer takes the colours from the frame
(`envLift`, `envShade`, `envHalo`, `envSpec`).

Settings > Lighting *Auto* (the default) decides per room: indoors or out as
people judged each room from its picture (`light_rooms.c`, 182 rooms), and for
a room not judged, the area's sun map is built and if it lights under 45% of
the room's open air the room is lit as indoors.  The world map screens are
not lit.

**Lamps** are found in the background art (light.c `FindLanterns`): every
layer that moves with the room and whose whole map the frame carries is read
tile by tile from VRAM and the palette, once the palette has held still for
12 frames after the room's fade-in.  A tile with a quarter of its pixels near
full brightness is a lamp's core (a brick's highlight is not); core tiles
touching, corners included (a candelabra's bulbs), make a lamp if the group
is at most 40 tiles in an 8-tile box, has at least 40 bright pixels, and the
two tiles round it are clearly darker -- which leaves out the sky, snow,
white walls and specks -- and it hangs in open air (not on solid cells) and
is not a tile the room repeats more than 24 times (blocks, logs, ledges).

How well that works was measured, not guessed: every room was captured with
the lamps ringed (`?normals=5`) and Sonnet agents reviewed the pictures.  The
first cut put 24 rings on real lamps and 385 on bright terrain; the two
terrain tests above cut the false ones to 22 against 7 real, nearly all in
water and ice.  Real lamp art is rare in this game (Moonlight Mansion's wall
lamps, a few sconces and orbs), so lamps are used only in the rooms where
reviewers confirmed them (`kLampRooms`); every other indoor room is lit
softly, without point lights.  Not lit as lamps yet: lava and stained glass
(large glowing areas, which the size test leaves out on purpose).  The light goes at the bright pixels' centre in their
colour (a white lamp, warm white), re-placed every frame from its layer's
scroll; the nearest 8 go to the renderer.  The composite lights them without
walls in the way: lift and glow in each lamp's colour, falling off over
200 px, and away from them only *Indoor shade* (0.12 by default) of the
shade -- an indoor room is not a cave to be dark in.  `?normals=5` rings each
lamp in magenta (and logs what was found, per room).  *Sun* and
*Point lights* force one everywhere (the sun angle slider applies with Sun).
Saved lighting settings from before `LIGHT_SETTINGS_VER` 3 are reset to the
defaults once.

The sun can cross the sky (Settings > Lighting > *Sun crosses the sky*, on
by default; *Sun speed* in degrees a second): sunrise far left to sunset far
right, the lighting fading out at dusk and in at dawn so the jump back is
never seen.  A moving sun's shadow map is rebuilt an eighth at a time each
frame, and each finished map fades in over the time the next one takes (the
map texture holds the previous and the current map; `lightMix` blends them),
so the shadows glide at a fraction of a full build's cost per frame.
`?normals=4` shows the shadow map.

*Light into the ground* (0-48 px, 12 by default; it was a fixed 36): a ray
that starts inside solid ground counts from where it leaves it only if it
does within this distance, otherwise the ground there is in shade.  0 shades
solid ground from its surface down -- which also shows where the collision
grid and the art disagree (solid cells with nothing drawn on them).

**Character shadows** (Settings > Lighting, 1 = as dark as the level's, 0
off): the level's own sun shadows with Kirby and the enemies as the
occluders.  Every lit frame, after the sprite pass, `RunCharShadow` marches
five rays across the sun's disc (three across each point light's) from each
2x2 view pixels towards the light through the sprite target, counting a
blocked ray less the further away its sprite is -- `BuildSun`'s rule -- into
an R8 texture over the view, out to *Character shadow length* (16-160 px,
64 by default).  A ray that starts inside solid ground (the room's collision
cells, uploaded from light.c) counts only if it leaves the ground within
*Character shadows into the ground* (0-48 px, 6 by default): deeper, the
ground is in the way.  The composite takes the darker of that and the
level's shadow for background pixels, so the two share one tint and
darkness and never stack.  (Before them, each silhouette was simply dropped
a few pixels away from the sun; that read as smudges and is gone.)

Default strength is 2.  **Relief** gives that light something to shade; on
sprites only, unless *Relief on backgrounds too* is ticked -- at the crate's
defaults every cloud and pillar became a blurred grey pillow, and the
background settings are now much flatter.  Every lit frame, every
on-screen world sprite and the part of every non-HUD background layer around
the view get a normal map made from their own pixels, on the GPU, by a port of
[Sprite Normals](https://github.com/Hugo-Dz/spritefusion-sprite-normals) (MIT;
`platform/render/relief_glsl.h`, and `third_party/spritefusion-sprite-normals/`
for what was ported and where it differs).  It has to run in the renderer: the
art only exists once the game has decoded it into VRAM.

Per frame, before the sprite pass:

1. `PlanRelief` packs the layers' pieces (view + 20 px all round, in the
   composite's own layer coordinates) and the on-screen world sprites onto
   shelves of an RGBA8 atlas with transparent gutters.  Sprites are packed in
   *groups*: a character is often several hardware sprites side by side, and
   made one by one each piece got a rim where it meets the next (a crease down
   the sword knight).  Sprites that touch or overlap with the same palette,
   priority, blending and sub-pixel position are one group, one picture.
2. `RunRelief` draws the layers through the composite program's decode branch
   and each group's sprites, as on screen (flipped, rotated, front one on
   top), through a decode variant of the sprite program, then runs the crate's
   steps as five full-atlas passes (half floats in integer targets, which
   every GLES 3.0 can render to).
3. The sprite pass writes a second target, each pixel's normal read at its
   place in its group's picture; the composite reads that for sprite pixels
   and the atlas for layer pixels.

The composite shades the top pixel's normal against the sun's direction or the
room's lights, relative to what a flat pixel gets, so flat art keeps its
colours; shade (no direct light) gets none of it.

Sprites are tuned apart from the layers (`kReliefGenSpr`, `kReliefRespSpr`).
With the crate's defaults a small sprite looked awful: it is nearly all rim,
and its painted shading, read as relief at detail strength 6 and lit again,
doubled -- the standing Kirby went chalky on top and muddy below, colours
clipped to white.  Sprites therefore use detail strength 2, stay within
0.72-1.25 of their own colour, and brighten without leaving their hue; the
puffed-up Kirby keeps its dome and highlight.  `tools/relief_check/tune.html`
was used to choose this on real sprites.  Settings > Display >
Lighting: **Normal maps** (one switch for all of it: no passes when off), **Relief**, **Shine**,
**Light height** (shine 0.1 by default).  `?normals=1` (`KATAM_RELIEF_VIEW=1`) shows the normal maps
instead of the picture; `?normals=2` and `=3` show the atlas's sprite groups
and their normals, pixel for pixel.  For comparing looks on one picture:
`Module._PortWebFreeze(1)` holds the game on its frame and keeps presenting it,
and `Module.ccall('PortWebSetting', null, ['string'], ['lightrelief=0'])`
applies settings lines as the menu does.

Checked against the crate's own CLI with `tools/relief_check/`: on 20-48 px
test sprites the port's normals differ from the CLI's by at most 1/255 per
channel, at the crate's defaults and at `--detail-strength 2`.  `make regress-wasm` is unchanged (renderer only).  Not measured: the
cost on a phone GPU.

### Engine: radiance cascades

Settings > Lighting > *Engine: Radiance cascades* (`lightengine=1`, or
`?engine=rc` for one visit) swaps the classic engine above -- the sun's
shadow map, analytic lamps, the character shadow pass -- for one 2D global
illumination solve each frame: `platform/render/rc_glsl.h` (the shader and
its layout) and `RunRadiance` in `gl_renderer.c`.  After Alexander
Sannikov's *Radiance Cascades*, with the merge and the bilinear fix as in
the Shadertoy versions by fad and Suslik, and the sky's light over an
interval of directions in closed form from Mathis's *Analytic Direct
Illumination* (shadertoy.com/view/NttSW7).

- **Scene**, all the game's own: the room's collision cells block light (the
  same 16 px cells and rules as the classic map); opaque world sprites block
  it within *Character shadow length* of a probe (and a probe inside a
  sprite sees past it, so characters are lit, not black); the room's lamps
  are 3 px discs in their own colour.  A probe inside solid ground sees
  through its own ground with light fading by e every 2.5 x *Light into the
  ground* px, so blocks and the ground's face are lit at their edges.
- **Sky**: a ray that gets past the last cascade unblocked sees Mathis's sky
  (the area's shade tint, brighter overhead) plus a sun lobe at the area's
  angle (its lift colour, 60% of the open sky's light, as wide as *Shadow
  softness* makes the classic sun) -- integrated over the ray's own
  directions, so the sun's penumbra is exact at any cascade resolution.  The
  moving sun needs nothing extra: the solve is per frame.  Enclosed rooms
  have no sky; a ray past 96 px unblocked sees a flat ambient instead, and
  the lamps light the rest (through the room, walls in the way).
- **Bounce** (*Bounce light*, 0.5): a ray stopped by a solid sees what the
  last frame showed just inside it, x Bounce -- sunlit ground lights the
  shade above it in its own colour, one more bounce each frame.
- **Layout**: 5 cascades, probes 2 px apart (world-locked to multiples of
  32 px, so a still scene's light does not swim as the camera scrolls) over
  the view + 48 px, 4 directions per probe at cascade 0 and 4 x as many per
  cascade up, intervals 0-6, 6-24, 24-96, 96-384, 384-1536 px.  Rays march
  the collision cells by DDA (and the sprite target in 1.5 px steps near the
  probe).  Cascades 0-2 use the bilinear fix (16 rays a texel), 3-4 the plain
  merge.  Half floats in RG32UI targets, as the relief passes.
- **Look**: the classic engine's settings set it -- no light at all gives
  the classic full shade (Shadow darkness x Strength, tinted by Coolness;
  *Indoor shade* of it indoors), the open sky the classic lit warmth,
  linearly between; brighter than that (near lamps) keeps the hue.  Relief
  shades each pixel's normal by the light from cascade 0's four directions.

`?normals=4` shows the cascades' light instead of the shadow map.  60 frames
a second at 1280x640 on a Radeon integrated GPU (headless Chromium) with
either engine; the program is compiled the first time the engine is chosen.
Not measured: phones.

## Next

* **Effects** (S each): OBJ mosaic; windows as world-space shapes instead of
  the 240-wide edge heuristic; HBlank tables beyond line 160 synthesised
  rather than clamped.
* **Block-mapped layers** (`Background.unk2E & 0x40`, a table of tile
  blocks): today window-only in wide views; flatten on CPU into the atlas (S).
* **Asset-by-id (M9, L)**: replace `map`/tile/palette references with
  resource ids; tiles as atlas textures, the composite unchanged in shape.
* **Per-element HUD anchors** (S): regions from hud.c's own element list.
  The HUD layer's atlas takes any number of regions up to 8 unchanged.
* **Culling**: done. The spawn/despawn windows follow the view, as a
  recorded input (docs/VIEW.md, "Spawn margin"). Netplay holds them at
  240x160 until v2 agrees on a session view.
