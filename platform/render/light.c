/* Lighting for every level (branch `lighting`).
 *
 * Off unless asked for: KATAM_LIGHTING=1 (native/node) or the web page's
 * /lighting/ path or ?lighting=1 (host_web.c sets gPortLighting).  With it
 * off nothing here runs and the render list is what it always was.
 *
 * Each area has an environment (kEnvs, by the area the game's own area map
 * puts the room in, light_rooms.c): a sun -- or moon, or starlight -- with
 * its direction and colours for rooms open to the sky, and point lights
 * with their colours (torches, crystals, lava) for rooms that are not.  In
 * the default Auto mode a room is "indoors" when most of its top row of
 * cells is solid: the sun could not reach it.  Sun and Point lights force
 * one or the other everywhere.
 *
 * The sun: parallel rays from beyond the top of the room at an angle from
 * overhead (left positive).  Point lights: the lamps the background art
 * draws (FindLanterns), in their own colours, lit by the composite without
 * walls in the way and with only a light shade between them (Indoor shade):
 * an indoor room is not a cave to be dark in.  Per room, from the room's own
 * collision grid
 * (gUnk_02024ED0[slot], one byte per 16x16 cell, an index into
 * gCollisionAttributes, at most 1950 cells), a map of one texel per 8x8
 * world pixels is worked out by marching five rays from each texel across
 * the sun's angular disc or each light's disc: R = light blocked (shadow,
 * with a penumbra that widens with distance), G = light arriving, then a
 * small blur.  It is recomputed when the room changes, a byte of its grid
 * does (a block broken), or a map parameter does (at most 5 times a second
 * while a slider moves).  The GL composite samples it bilinearly in world
 * coordinates: shade darker and tinted, lit areas lifted, the point lights'
 * halo; the playfield fully, the parallax art behind it at 55%; never the
 * HUD.  Relief (render/relief_glsl.h) and the characters' shadows
 * (gl_renderer.c RunCharShadow) use the same light.  The PPU (software)
 * path is not touched.
 *
 * Runs at present time, outside the simulation, and only reads game memory.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "port/port.h"
#include "gba/gba.h"
#include "global.h"
#include "main.h"
#include "data.h"
#include "render/render_list.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define NowMs() emscripten_get_now()
#else
#include <time.h>
static double NowMs(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}
#endif

int gPortLighting = -1;          /* effective; -1 not decided yet             */
int gPortLightingDefault = -1;   /* page / env default; -1 read KATAM_LIGHTING */
int gPortLightingUser = -1;      /* the settings menu; -1 follow the default  */
PortLightParams gPortLightParams = PORT_LIGHT_PARAMS_DEFAULT;
double gPortLightBuildMs;        /* the last light-map build, for the report  */
int gPortReliefView;             /* show the normal maps                      */

void PortLightResolve(void)
{
    if (gPortLightingDefault < 0) {
        const char *e = getenv("KATAM_LIGHTING");
        gPortLightingDefault = (e && e[0] == '1') ? 1 : 0;
    }
    gPortLighting = gPortLightingUser >= 0 ? gPortLightingUser : gPortLightingDefault;
}

/* The environments, by enum AreaId (game/include/pause_area_map.h); a room
 * the area map does not list takes Rainbow Route's.  Per environment: the
 * sun's angle (degrees left of overhead; negative from the right) and two
 * looks, for open rooms (sun) and enclosed ones (point lights): strength
 * (x the Strength setting), lift of lit areas (x Warmth), shade tint at full
 * Coolness, halo of the lights (x Glow), relief highlight.  Rainbow Route's
 * open look is the one the lighting was first tuned with. */
typedef struct LightLook {
    float strength;
    float lift[3], shade[3], halo[3], spec[3];
} LightLook;
typedef struct LightEnv {
    const char *name;
    float angle;
    LightLook sun, cave;
} LightEnv;

#define LOOK_DAY { 1.0f, { 0.45f, 0.25f, -0.08f }, { 0.90f, 0.95f, 1.20f }, \
                   { 0.55f, 0.42f, 0.20f }, { 1.0f, 0.92f, 0.75f } }
#define LOOK_TORCH { 1.0f, { 0.50f, 0.30f, 0.02f }, { 0.85f, 0.90f, 1.25f }, \
                     { 0.60f, 0.42f, 0.18f }, { 1.0f, 0.85f, 0.60f } }
static const LightEnv kEnvs[] = {
    /* AREA_TUTORIAL */
    { "day", 35.0f, LOOK_DAY, LOOK_TORCH },
    /* AREA_RAINBOW_ROUTE: a warm day; torchlit caves */
    { "day", 35.0f, LOOK_DAY, LOOK_TORCH },
    /* AREA_MOONLIGHT_MANSION: moonlight from the upper right; candles inside */
    { "moon", -30.0f,
      { 0.85f, { 0.02f, 0.10f, 0.35f }, { 0.78f, 0.86f, 1.35f }, { 0.35f, 0.45f, 0.70f }, { 0.75f, 0.85f, 1.0f } },
      { 1.0f, { 0.55f, 0.32f, 0.05f }, { 0.75f, 0.82f, 1.30f }, { 0.65f, 0.45f, 0.20f }, { 1.0f, 0.85f, 0.60f } } },
    /* AREA_CABBAGE_CAVERN: a green day outside; crystal light below */
    { "crystal cave", 30.0f,
      { 1.0f, { 0.35f, 0.30f, 0.00f }, { 0.88f, 0.98f, 1.15f }, { 0.45f, 0.50f, 0.25f }, { 0.95f, 1.0f, 0.80f } },
      { 1.0f, { 0.05f, 0.35f, 0.45f }, { 0.80f, 0.92f, 1.30f }, { 0.15f, 0.55f, 0.65f }, { 0.70f, 1.0f, 1.0f } } },
    /* AREA_MUSTARD_MOUNTAIN: a hot orange sun; lava below */
    { "volcano", 20.0f,
      { 1.0f, { 0.55f, 0.18f, -0.12f }, { 1.05f, 0.88f, 1.05f }, { 0.70f, 0.35f, 0.10f }, { 1.0f, 0.75f, 0.50f } },
      { 1.1f, { 0.60f, 0.20f, -0.10f }, { 0.95f, 0.80f, 1.10f }, { 0.75f, 0.30f, 0.05f }, { 1.0f, 0.60f, 0.30f } } },
    /* AREA_CARROT_CASTLE: golden afternoon; torches in the halls */
    { "castle", 40.0f,
      { 1.0f, { 0.50f, 0.32f, 0.00f }, { 0.90f, 0.92f, 1.20f }, { 0.60f, 0.42f, 0.18f }, { 1.0f, 0.88f, 0.65f } },
      LOOK_TORCH },
    /* AREA_OLIVE_OCEAN: a bright sea sun; aqua glow in the grottoes */
    { "sea", 25.0f,
      { 1.0f, { 0.30f, 0.30f, 0.10f }, { 0.85f, 1.00f, 1.20f }, { 0.35f, 0.50f, 0.55f }, { 0.90f, 1.0f, 1.0f } },
      { 1.0f, { 0.00f, 0.30f, 0.40f }, { 0.80f, 0.95f, 1.25f }, { 0.10f, 0.45f, 0.60f }, { 0.70f, 1.0f, 1.0f } } },
    /* AREA_PEPPERMINT_PALACE: an icy sun; ice crystals inside */
    { "ice", 30.0f,
      { 1.0f, { 0.20f, 0.28f, 0.40f }, { 0.85f, 0.95f, 1.30f }, { 0.35f, 0.50f, 0.70f }, { 0.85f, 0.95f, 1.0f } },
      { 1.0f, { 0.15f, 0.30f, 0.50f }, { 0.82f, 0.92f, 1.30f }, { 0.30f, 0.50f, 0.75f }, { 0.80f, 0.95f, 1.0f } } },
    /* AREA_RADISH_RUINS: a high desert sun; amber torches in the ruins */
    { "desert", 15.0f,
      { 1.0f, { 0.55f, 0.40f, 0.00f }, { 0.92f, 0.92f, 1.15f }, { 0.65f, 0.48f, 0.15f }, { 1.0f, 0.95f, 0.70f } },
      { 1.0f, { 0.55f, 0.38f, 0.02f }, { 0.85f, 0.88f, 1.20f }, { 0.65f, 0.45f, 0.10f }, { 1.0f, 0.88f, 0.55f } } },
    /* AREA_CANDY_CONSTELLATION: starlight from the upper right; violet crystals */
    { "stars", -40.0f,
      { 0.85f, { 0.30f, 0.12f, 0.45f }, { 0.88f, 0.82f, 1.30f }, { 0.45f, 0.30f, 0.60f }, { 0.95f, 0.80f, 1.0f } },
      { 1.0f, { 0.35f, 0.10f, 0.50f }, { 0.85f, 0.80f, 1.30f }, { 0.55f, 0.25f, 0.70f }, { 0.95f, 0.75f, 1.0f } } },
    /* AREA_DIMENSION_MIRROR: mirror light from overhead; magenta crystals */
    { "mirror", 0.0f,
      { 0.9f, { 0.40f, 0.10f, 0.45f }, { 0.85f, 0.80f, 1.30f }, { 0.55f, 0.20f, 0.60f }, { 1.0f, 0.80f, 1.0f } },
      { 1.0f, { 0.45f, 0.10f, 0.45f }, { 0.85f, 0.78f, 1.30f }, { 0.65f, 0.20f, 0.65f }, { 1.0f, 0.75f, 1.0f } } },
};
#define NUM_ENVS ((int)(sizeof(kEnvs) / sizeof(kEnvs[0])))

static const LightEnv *EnvFor(u16 room)
{
    int a = PortLightRoomArea(room);
    return &kEnvs[a >= 0 && a < NUM_ENVS ? a : 1];
}

#define LIGHT_CELL 8                         /* world px per light texel    */
#define LIGHT_MAX_W (2176 / LIGHT_CELL + 2)
#define LIGHT_MAX_H (1648 / LIGHT_CELL + 2)
#define GRID_MAX 1950

/* The tunables are gPortLightParams (the settings menu's Lighting section;
 * natively KATAM_LIGHTING_STRENGTH / _MODE override strength and mode). */
#define OPEN_LIT 0.45f                       /* sunlit share of the air: outdoors */
#define LANTERN_MAX 24                       /* a room's lamps, at most     */
#define LAMP_RANGE 200.0f                    /* px a lamp lights            */
#define SUN_REACH 320.0f                     /* px a sun ray is followed    */
#define LIGHT_RAYS 5
#define LIGHT_STEP 6.0f                      /* march step, px              */

/* Per texel: the previous map's shadow and light, then the current map's.
 * The composite blends them by f->lightMix: a moving sun's map is rebuilt
 * a slice a frame, and each new one fades in over the time the next takes. */
static u8 sMask[LIGHT_MAX_W * LIGHT_MAX_H * 4];
static float sTmp[LIGHT_MAX_W * LIGHT_MAX_H * 2];
static u8 sOcc[GRID_MAX];                    /* 0 air, 1 solid, 2 thin top  */
static s32 sMaskW, sMaskH;
static u32 sGen;
static u16 sRoom = 0xFFFF;
static u32 sGridHash;
static int sHave;
static int sEnvDone;
static int sBuiltMode = -1;
static float sBuiltSoft = -1.0f, sBuiltAngle = -1.0f, sBuiltDepth = -1.0f;
static const u8 *sGrid;          /* the room's grid the map was built from */
static u32 sOccGen;              /* bumps when sOcc is worked out again     */
static double sLastBuild;
/* The room's lamps (FindLanterns): where the background art draws a
 * lantern, a lamp, a glowing crystal, on which layer, at its map pixel, in
 * its colour.  Placed on the screen again every frame from the layer's own
 * scroll, so a lamp on a parallax layer keeps its light. */
typedef struct Lantern {
    u8 bg;
    s32 mx, my;
    float col[3];
} Lantern;
static Lantern sLant[LANTERN_MAX];
static int sNumLant;
static u16 sLantRoom = 0xFFFF;
static int sLantTries;
static u32 sLantPal;
static int sBuiltReq = -1;       /* the mode asked for (LIGHT_REQ_*)        */
static const LightEnv *sEnv = &kEnvs[1];

/* The moving sun.  sPhase runs 0..1 from sunrise (SUN_ARC degrees left of
 * overhead) to sunset (as far right), in wall-clock time at sunSpeed degrees
 * a second; the lighting fades out over the last SUN_DUSK of the day and in
 * over the first, so the jump back to sunrise is never seen.  A map is built
 * SUN_JOB_FRAMES slices at a time at the angle the sun had when it started. */
#define SUN_ARC 75.0f
#define SUN_DUSK 0.06f
#define SUN_JOB_FRAMES 8
static float sPhase = 0.35f;     /* start mid-morning                      */
static double sPhaseT;
static int sJob, sJobRow;
static float sJobAngle;
static double sJobStart, sJobDur = 133.0, sSwapT;
static float sPrevAngle, sCurAngle;
static float sMix = 1.0f;
static s32 sCw, sCh;

static int Occ(s32 x, s32 y, s32 cw, s32 ch)
{
    s32 cx, cy;
    u8 o;

    if (x < 0 || y < 0)
        return 0;
    cx = x >> 4;
    cy = y >> 4;
    if (cx >= cw || cy >= ch)
        return 0;
    o = sOcc[cy * cw + cx];
    return o == 1 || (o == 2 && (y & 15) < 4);
}

/* The collision attribute of a grid byte as the march sees it. */
static u8 CellOcc(u8 g)
{
    u32 a = gCollisionAttributes[g];
    if (a & 0x200)
        return 1;
    if ((a >> 28) != 0 && !(a & 1))
        return 1;                       /* a slope: count it solid         */
    if (a & 0x4)
        return 2;                       /* jump-through platform           */
    return 0;
}

/* How far into solid ground light reaches, in march steps: a ray that starts
 * inside the ground counts from where it leaves it, if it does within this
 * many steps (gPortLightParams.depth, px), and is blocked otherwise.  0: the
 * ground is shaded from its surface down. */
static int DepthSteps(void)
{
    float d = gPortLightParams.depth;
    return d <= 0.0f ? 0 : (int)(d / LIGHT_STEP + 0.5f);
}

/* The sun: parallel rays from the upper left, beyond the top of the room.
 * Per texel, five rays spread over the sun's disc (soft: 1..17 degrees
 * across) are followed towards it for up to SUN_REACH px; a blocked ray
 * counts less the further away its occluder is (sky fill), so a shadow is
 * strongest at the foot of what casts it and its edge widens with distance.
 * R = shadow, G = sunlit (1 - shadow), for the shader's warm lift. */
static void BuildSun(s32 cw, s32 ch, s32 mw, float angle, s32 ty0, s32 ty1)
{
    int depth = DepthSteps();
    float dx[LIGHT_RAYS], dy[LIGHT_RAYS];
    float a0 = angle * 3.14159265f / 180.0f;
    float spread = (1.0f + 16.0f * gPortLightParams.soft) * 3.14159265f / 180.0f;
    int steps = (int)(SUN_REACH / LIGHT_STEP), r;
    s32 tx, ty;

    for (r = 0; r < LIGHT_RAYS; r++) {
        float a = a0 + spread * ((float)r / (LIGHT_RAYS - 1) - 0.5f);
        dx[r] = -sinf(a) * LIGHT_STEP;       /* towards the sun: up, left  */
        dy[r] = -cosf(a) * LIGHT_STEP;       /* (right for a negative angle) */
    }
    for (ty = ty0; ty < ty1; ty++) {
        for (tx = 0; tx < mw; tx++) {
            float px0 = tx * LIGHT_CELL + LIGHT_CELL * 0.5f;
            float py0 = ty * LIGHT_CELL + LIGHT_CELL * 0.5f;
            float sh = 0.0f;

            for (r = 0; r < LIGHT_RAYS; r++) {
                int s, start = 0;
                /* Inside the ground: start where the ray leaves it, if it
                 * does within DepthSteps. */
                while (start < depth && Occ((s32)(px0 + dx[r] * start),
                                        (s32)(py0 + dy[r] * start), cw, ch))
                    start++;
                for (s = start + 1; s < steps; s++) {
                    float x = px0 + dx[r] * s, y = py0 + dy[r] * s;
                    if (y < 0.0f || x < 0.0f || x >= (float)(cw * 16))
                        break;                   /* out of the room: sky    */
                    if (Occ((s32)x, (s32)y, cw, ch)) {
                        sh += 1.0f - 0.9f * (float)(s - start) / (float)steps;
                        break;
                    }
                }
            }
            sh /= LIGHT_RAYS;
            sTmp[(ty * mw + tx) * 2] = sh;
            sTmp[(ty * mw + tx) * 2 + 1] = 1.0f - sh;
        }
    }
}

/* Finding the lamps in the background art.
 *
 * Every world layer whose whole map the frame carries (the room layer and
 * the streamed pictures behind it) is read tile by tile from VRAM and the
 * palette, as the composite would draw it.  A tile is a lamp's core with a
 * quarter of its pixels near full brightness (a brick's highlight is not).
 * Core tiles that touch make a candidate; a lamp is one at most LANT_TILES
 * tiles in a LANT_SPAN-tile box, with at least LANT_HOT_MIN bright pixels,
 * whose surroundings are clearly darker and mostly not core -- which leaves
 * out the sky, clouds, snow and white walls, and specks.  Its light is placed at the hot
 * pixels' centre and takes their colour. */
#define LANT_HOT_LUMA 24                     /* of 31: a hot pixel           */
#define LANT_HOT_PIX 16                      /* of 64: a lamp's core tile    */
#define LANT_HOT_MIN 40                      /* hot pixels: a lamp, not a speck */
#define LANT_TILES 40
#define LANT_SPAN 8
#define LANT_CONTRAST 7                      /* ring luma below the lamp's   */
#define LANT_REPEAT 24                       /* a core tile used more: terrain */
#define LANT_MAP_MAX (272 * 208)

typedef struct TileStat {
    u8 hot, lum;
    u16 r, g, b;                             /* sums over the hot pixels      */
} TileStat;

static int Luma5(u16 c)
{
    return ((c & 31) * 77 + ((c >> 5) & 31) * 150 + ((c >> 10) & 31) * 29) >> 8;
}

static void StatTile(const RlFrame *f, u32 charBase, int is256, u16 e, TileStat *t)
{
    int tile = e & 0x3FF, bank = (e >> 12) & 15, px, lumSum = 0, n = 0;

    memset(t, 0, sizeof(*t));
    for (px = 0; px < 64; px++) {
        u32 off;
        int idx;
        u16 c;
        if (is256) {
            off = charBase + (u32)tile * 64 + (u32)px;
            if (off >= 0x10000) return;
            idx = f->vram[off];
            if (idx == 0) continue;
            c = f->palette[idx];
        } else {
            off = charBase + (u32)tile * 32 + (u32)(px >> 1);
            if (off >= 0x10000) return;
            idx = (px & 1) ? (f->vram[off] >> 4) : (f->vram[off] & 15);
            if (idx == 0) continue;
            c = f->palette[(bank * 16 + idx) & 255];
        }
        n++;
        lumSum += Luma5(c);
        if (Luma5(c) >= LANT_HOT_LUMA) {
            t->hot++;
            t->r += c & 31;
            t->g += (c >> 5) & 31;
            t->b += (c >> 10) & 31;
        }
    }
    t->lum = (u8)(n ? lumSum / n : 0);
}

typedef struct LampCand {
    s32 x, y;                                /* grid pixels                   */
    float col[3];
} LampCand;

/* Is world pixel (x, y) solid in the room's collision (light.c's sOcc)? */
static int SolidAt(s32 x, s32 y)
{
    s32 cx = x >> 4, cy = y >> 4;
    if (x < 0 || y < 0 || cx >= sCw || cy >= sCh)
        return 0;
    return sOcc[cy * sCw + cx] != 0;
}

/* The lamps in a grid of W x H tile entries (e[y * W + x], 0 = empty) whose
 * pixel (0, 0) is world pixel (wox, woy).  Two more tests than looks: a lamp
 * is decoration -- it hangs in the room's open air, not on its solid cells
 * -- and it is not a tile the room repeats LANT_REPEAT times over (blocks,
 * logs, ledges, ice).  People reviewing 182 rooms found nearly every
 * candidate those leave out on solid terrain. */
static int GridLamps(const RlFrame *f, u32 charBase, int is256, const u16 *e, s32 W, s32 H,
                     s32 wox, s32 woy, LampCand *out, int max)
{
    static TileStat st[LANT_MAP_MAX];
    static u8 seen[LANT_MAP_MAX];
    static s32 queue[LANT_MAP_MAX];
    static u16 rep[0x10000];
    s32 i;
    int n = 0;

    if (W <= 0 || H <= 0 || W * H > LANT_MAP_MAX)
        return 0;
    memset(rep, 0, sizeof(rep));
    for (i = 0; i < W * H; i++) {
        if (e[i])
            StatTile(f, charBase, is256, e[i], &st[i]);
        else
            memset(&st[i], 0, sizeof(st[i]));
        seen[i] = 0;
        if (st[i].hot >= LANT_HOT_PIX && rep[e[i] & 0xF3FF] < 0xFFFF)
            rep[e[i] & 0xF3FF]++;
    }
    for (i = 0; i < W * H && n < max; i++) {
        s32 head = 0, tail = 0, x0, y0, x1, y1, k, ringN = 0, ringHot = 0, solid = 0, most = 0;
        long ringLum = 0, hot = 0, hotLum, sr = 0, sg = 0, sb = 0, cxs = 0, cys = 0;
        if (seen[i] || st[i].hot < LANT_HOT_PIX)
            continue;
        seen[i] = 1;
        queue[tail++] = i;
        x0 = x1 = i % W;
        y0 = y1 = i / W;
        while (head < tail) {
            s32 c = queue[head++], cx = c % W, cy = c / W, d;
            /* Eight neighbours: a candelabra's bulbs touch at corners. */
            const s32 nb[8][2] = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 },
                                   { 1, 1 }, { -1, 1 }, { 1, -1 }, { -1, -1 } };
            if (cx < x0) x0 = cx;
            if (cx > x1) x1 = cx;
            if (cy < y0) y0 = cy;
            if (cy > y1) y1 = cy;
            hot += st[c].hot;
            sr += st[c].r; sg += st[c].g; sb += st[c].b;
            solid += SolidAt(wox + cx * 8 + 4, woy + cy * 8 + 4);
            if (rep[e[c] & 0xF3FF] > most)
                most = rep[e[c] & 0xF3FF];
            cxs += (long)st[c].hot * (cx * 8 + 4);
            cys += (long)st[c].hot * (cy * 8 + 4);
            for (d = 0; d < 8; d++) {
                s32 nx = cx + nb[d][0], ny = cy + nb[d][1], m;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H)
                    continue;
                m = ny * W + nx;
                if (!seen[m] && st[m].hot >= LANT_HOT_PIX && tail < LANT_MAP_MAX) {
                    seen[m] = 1;
                    queue[tail++] = m;
                }
            }
        }
        if (tail > LANT_TILES || x1 - x0 >= LANT_SPAN || y1 - y0 >= LANT_SPAN || hot < LANT_HOT_MIN)
            continue;                   /* too big (sky, snow, a white wall) or a speck */
        if (solid * 2 > tail || most > LANT_REPEAT)
            continue;                   /* terrain: on solid cells, or a tile used all over */
        /* The ring two tiles round it must be darker, and mostly not hot. */
        for (k = y0 - 2; k <= y1 + 2; k++) {
            s32 x;
            for (x = x0 - 2; x <= x1 + 2; x++) {
                s32 m;
                if (x < 0 || k < 0 || x >= W || k >= H)
                    continue;
                if (x >= x0 && x <= x1 && k >= y0 && k <= y1)
                    continue;
                m = k * W + x;
                ringN++;
                ringLum += st[m].lum;
                ringHot += st[m].hot >= LANT_HOT_PIX;
            }
        }
        hotLum = hot ? (sr * 77 + sg * 150 + sb * 29) / (hot * 256) : 0;
        if (ringN == 0 || ringHot * 4 > ringN || ringLum / ringN > hotLum - LANT_CONTRAST)
            continue;
        {
            LampCand *c = &out[n++];
            float r = (float)sr / hot, g = (float)sg / hot, b = (float)sb / hot;
            float m = r > g ? (r > b ? r : b) : (g > b ? g : b), mn;
            c->x = (s32)(cxs / hot);
            c->y = (s32)(cys / hot);
            c->col[0] = r / m;
            c->col[1] = g / m;
            c->col[2] = b / m;
            mn = c->col[0] < c->col[1] ? c->col[0] : c->col[1];
            if (c->col[2] < mn)
                mn = c->col[2];
            if (mn > 0.8f) {                /* a white lamp: warm white      */
                c->col[0] = 1.0f; c->col[1] = 0.85f; c->col[2] = 0.6f;
            }
        }
    }
    return n;
}

static int AddLamp(u8 bg, s32 x, s32 y, const float *col)
{
    int j;
    for (j = 0; j < sNumLant; j++)
        if (sLant[j].bg == bg && abs(sLant[j].mx - x) < 24 && abs(sLant[j].my - y) < 24)
            return 0;
    if (sNumLant >= LANTERN_MAX)
        return 0;
    sLant[sNumLant].bg = bg;
    sLant[sNumLant].mx = x;
    sLant[sNumLant].my = y;
    memcpy(sLant[sNumLant].col, col, sizeof(sLant[sNumLant].col));
    sNumLant++;
    return 1;
}

/* The layers whose whole map the frame carries: their lamps at map pixels.
 * Only with the palette settled: a fade washes every colour towards white
 * or black on the way. */
static void FindLanterns(const RlFrame *f)
{
    static LampCand cand[LANTERN_MAX];
    int bg, found = 0, j;

    {
        Lantern mine[LANTERN_MAX];
        int nm = 0;
        for (bg = 0; bg < 4; bg++) {
            const RlTileLayer *L = &f->layers[bg];
            u32 cnt = (u32)f->lines[0][RL_LINE_BGCNT + bg];
            int k, n;
            /* Layers that move with the room only: a lamp (or a moon) on a
             * far parallax picture is behind the room, not in it. */
            if (!L->enabled || L->space != RL_SPACE_WORLD || !L->streamed || !L->map
                || L->factorX != 256 || L->factorY != 256)
                continue;
            n = GridLamps(f, ((cnt >> 2) & 3) * 0x4000, (cnt & 0x80) != 0, L->map, L->mapW, L->mapH,
                          f->camX - (L->mapOffX * 8 + L->mapScrollX) - L->shiftX,
                          f->camY - (L->mapOffY * 8 + L->mapScrollY) - L->shiftY,
                          cand, LANTERN_MAX - nm);
            for (k = 0; k < n && nm < LANTERN_MAX; k++, nm++) {
                mine[nm].bg = (u8)bg;
                mine[nm].mx = cand[k].x;
                mine[nm].my = cand[k].y;
                memcpy(mine[nm].col, cand[k].col, sizeof(mine[nm].col));
            }
        }
        found = nm;
        sNumLant = 0;
        for (j = 0; j < nm; j++)
            AddLamp(mine[j].bg, mine[j].mx, mine[j].my, mine[j].col);
    }
    if (gPortReliefView == 5)
        PortLog("[katam-port] light: room %u: %d lamps from the maps", (unsigned)sLantRoom, found);
}


/* Sun or point lights for this room: what was asked for, or (Auto) what
 * people judged the room to be (light_rooms.c), or failing that the sun if
 * it would light enough of the room's open air -- the room's sun map
 * is worked out (into sTmp) and its sunlit share of air cells measured.  A
 * cave, a hall under a roof, is lit by its lights instead. */
static int DecideMode(u16 room, const u8 *grid, s32 cw, s32 ch, int req, float angle)
{
    s32 mw = (cw * 16) / LIGHT_CELL, mh = (ch * 16) / LIGHT_CELL, tx, ty, i;
    float lit = 0.0f;
    int air = 0, judged = PortLightRoomIndoor(room);

    if (req == LIGHT_REQ_SUN)
        return RL_LIGHT_SUN;
    if (req == LIGHT_REQ_POINT)
        return RL_LIGHT_POINT;
    if (judged >= 0)
        return judged ? RL_LIGHT_POINT : RL_LIGHT_SUN;
    for (i = 0; i < cw * ch; i++)
        sOcc[i] = CellOcc(grid[i]);
    BuildSun(cw, ch, mw, angle, 0, mh);
    for (ty = 0; ty < mh; ty++)
        for (tx = 0; tx < mw; tx++)
            if (sOcc[(ty * LIGHT_CELL / 16) * cw + tx * LIGHT_CELL / 16] == 0) {
                air++;
                lit += 1.0f - sTmp[(ty * mw + tx) * 2];
            }
    return air > 0 && lit >= OPEN_LIT * (float)air ? RL_LIGHT_SUN : RL_LIGHT_POINT;
}

/* The 3x3 box blur of sTmp, into the current map. */
static void BlurToCur(s32 mw, s32 mh)
{
    s32 tx, ty;

    for (ty = 0; ty < mh; ty++) {
        for (tx = 0; tx < mw; tx++) {
            float sum0 = 0.0f, sum1 = 0.0f;
            int n = 0, dx, dy;
            for (dy = -1; dy <= 1; dy++)
                for (dx = -1; dx <= 1; dx++) {
                    s32 x = tx + dx, y = ty + dy;
                    if (x < 0 || y < 0 || x >= mw || y >= mh)
                        continue;
                    sum0 += sTmp[(y * mw + x) * 2];
                    sum1 += sTmp[(y * mw + x) * 2 + 1];
                    n++;
                }
            sMask[(ty * mw + tx) * 4 + 2] = (u8)(sum0 / (float)n * 255.0f + 0.5f);
            sMask[(ty * mw + tx) * 4 + 3] = (u8)(sum1 / (float)n * 255.0f + 0.5f);
        }
    }
}

/* The previous map := what is on screen now (mix of previous and current),
 * so a new current map takes over without a jump. */
static void BakePrev(s32 mw, s32 mh, float mix)
{
    s32 k;

    for (k = 0; k < mw * mh; k++) {
        u8 *t = &sMask[k * 4];
        t[0] = (u8)(t[0] + (t[2] - t[0]) * mix + 0.5f);
        t[1] = (u8)(t[1] + (t[3] - t[1]) * mix + 0.5f);
    }
}

static void Build(const u8 *grid, s32 cw, s32 ch, float angle, int mode)
{
    s32 mw = (cw * 16) / LIGHT_CELL, mh = (ch * 16) / LIGHT_CELL;
    s32 i;

    for (i = 0; i < cw * ch; i++)
        sOcc[i] = CellOcc(grid[i]);
    if (mode == RL_LIGHT_POINT)
        memset(sTmp, 0, (size_t)mw * mh * 2 * sizeof(float));   /* the lamps are the composite's */
    else
        BuildSun(cw, ch, mw, angle, 0, mh);
    sBuiltMode = mode;
    sBuiltReq = gPortLightParams.mode;
    sBuiltSoft = gPortLightParams.soft;
    sBuiltDepth = gPortLightParams.depth;
    sGrid = grid;
    sOccGen++;
    sBuiltAngle = angle;

    BlurToCur(mw, mh);
    BakePrev(mw, mh, 1.0f);
    sMaskW = mw;
    sMaskH = mh;
    sCw = cw;
    sCh = ch;
    sPrevAngle = sCurAngle = angle;
    sMix = 1.0f;
    sJob = 0;
    sSwapT = NowMs();
    sGen++;
}

/* The moving sun's next slice; a finished map becomes the current one. */
static void SunStep(float target, double now)
{
    s32 rows = (sMaskH + SUN_JOB_FRAMES - 1) / SUN_JOB_FRAMES, end;

    if (!sJob) {
        sJob = 1;
        sJobRow = 0;
        sJobAngle = target;
        sJobStart = now;
    }
    end = sJobRow + rows < sMaskH ? sJobRow + rows : sMaskH;
    BuildSun(sCw, sCh, sMaskW, sJobAngle, sJobRow, end);
    sJobRow = end;
    if (sJobRow < sMaskH)
        return;
    BakePrev(sMaskW, sMaskH, sMix);
    sPrevAngle = sPrevAngle + (sCurAngle - sPrevAngle) * sMix;
    BlurToCur(sMaskW, sMaskH);
    sCurAngle = sJobAngle;
    if (fabsf(sCurAngle - sPrevAngle) > 60.0f) {
        /* Sunset back to sunrise, in the dark: no fade across the sky. */
        BakePrev(sMaskW, sMaskH, 1.0f);
        sPrevAngle = sCurAngle;
    }
    sJobDur = now - sJobStart > 16.0 ? now - sJobStart : 16.0;
    sSwapT = now;
    sMix = 0.0f;
    sJob = 0;
    sGen++;
}

static void Attach(RlFrame *f, int roomBg);

/* The frame's environment colours and its lamps: each placed on the screen
 * from its layer's scroll this frame (map pixel -> screen -> world), the
 * nearest RL_MAX_LIGHTS to the view's centre.  Lamps light point-lit rooms
 * only. */
static void FrameLook(RlFrame *f)
{
    const LightLook *L = sBuiltMode == RL_LIGHT_POINT ? &sEnv->cave : &sEnv->sun;
    float cx = (float)(f->camX + f->viewX) + f->viewW * 0.5f;
    float cy = (float)(f->camY + f->viewY) + f->viewH * 0.5f;
    float wx[LANTERN_MAX], wy[LANTERN_MAX], d[LANTERN_MAX];
    int used[LANTERN_MAX];
    int i, k, n = 0, m = 0;

    memcpy(f->envLift, L->lift, sizeof(f->envLift));
    memcpy(f->envShade, L->shade, sizeof(f->envShade));
    memcpy(f->envHalo, L->halo, sizeof(f->envHalo));
    memcpy(f->envSpec, L->spec, sizeof(f->envSpec));
    f->lightMode = (u8)sBuiltMode;
    f->lightIndoor = gPortLightParams.indoorShade;
    f->lampRange = LAMP_RANGE;
    if (sBuiltMode == RL_LIGHT_POINT)
        for (i = 0; i < sNumLant; i++) {
            const RlTileLayer *Ly = &f->layers[sLant[i].bg];
            if (!Ly->map)
                continue;
            /* The composite samples map pixel mapOff*8 + mapScroll + screen
             * + shift; the world is screen + cam. */
            wx[m] = (float)(sLant[i].mx - (Ly->mapOffX * 8 + Ly->mapScrollX) - Ly->shiftX + f->camX);
            wy[m] = (float)(sLant[i].my - (Ly->mapOffY * 8 + Ly->mapScrollY) - Ly->shiftY + f->camY);
            d[m] = (wx[m] - cx) * (wx[m] - cx) + (wy[m] - cy) * (wy[m] - cy);
            used[m] = i;
            m++;
        }
    while (n < RL_MAX_LIGHTS && n < m) {
        int best = -1;
        for (k = 0; k < m; k++)
            if (used[k] >= 0 && (best < 0 || d[k] < d[best]))
                best = k;
        f->lights[n][0] = wx[best];
        f->lights[n][1] = wy[best];
        memcpy(f->lightCol[n], sLant[used[best]].col, sizeof(f->lightCol[n]));
        used[best] = -1;
        n++;
    }
    f->numLights = (u8)n;
}

/* A frame shown again (the menu's pause, a frozen frame): the look's
 * parameters as they are now, so a change shows on the same picture.  The
 * map and the sun's place stay as built. */
void PortLightRefreshParams(RlFrame *f)
{
    const PortLightParams *P = &gPortLightParams;
    int anim = sBuiltMode == RL_LIGHT_SUN && P->sunAnim;
    float base = P->mode == LIGHT_REQ_SUN ? P->angle : sEnv->angle;

    if (!f || !f->light)
        return;
    /* A map parameter changed on a held frame: build the map again from
     * the same room's grid (the game is not running, so it is the same). */
    if (sGrid && f->light == sMask
        && (P->mode != sBuiltReq || P->soft != sBuiltSoft || P->depth != sBuiltDepth
            || (sBuiltMode == RL_LIGHT_SUN && !anim && base != sBuiltAngle))) {
        Build(sGrid, sCw, sCh, anim ? sCurAngle : base,
              DecideMode(sRoom, sGrid, sCw, sCh, P->mode, sEnv->angle));
    }
    /* Every time, not only after a rebuild: the presented frame is copied
     * from the built one on each present, which brings back the fields of
     * the map it was built with. */
    if (sGrid && f->light == sMask) {
        float shown = sPrevAngle + (sCurAngle - sPrevAngle) * sMix;
        f->lightGen = sGen;
        f->lightMix = sMix;
        f->lightAngle = shown;
        f->lightSunSide = sinf(shown * 3.14159265f / 180.0f) / sinf(35.0f * 3.14159265f / 180.0f);
        if (f->lightSunSide > 1.0f) f->lightSunSide = 1.0f;
        if (f->lightSunSide < -1.0f) f->lightSunSide = -1.0f;
        FrameLook(f);
    }
    f->lightCharReach = P->charReach;
    f->lightCharDepth = P->charDepth;
    f->lightSoft = P->soft;
    f->lightRelief = gPortLightParams.reliefOn ? gPortLightParams.relief : 0.0f;
    f->lightShine = gPortLightParams.shine;
    f->lightHeight = gPortLightParams.height;
    f->lightSprShadow = gPortLightParams.sprShadow;
    f->lightSoft = gPortLightParams.soft;
    f->lightReliefBg = (u8)gPortLightParams.reliefBg;
    f->lightNrmView = (u8)gPortReliefView;
    f->lightShadow = gPortLightParams.shadow;
    f->lightCool = gPortLightParams.cool;
    f->lightGlow = gPortLightParams.glow;
    if (!(sBuiltMode == RL_LIGHT_SUN && gPortLightParams.sunAnim))
        f->lightK = gPortLightParams.strength * (sBuiltMode == RL_LIGHT_POINT ? sEnv->cave.strength
                                                                             : sEnv->sun.strength);
}

/* With KATAM_LIGHTING_LOG: the mean CPU cost of a frame's attach (the grid
 * hash, plus any rebuild) every 600 frames. */
void PortLightAttach(RlFrame *f, int roomBg)
{
    static double sum;
    static int frames, logOn = -1;
    double t0;

    if (logOn < 0)
        logOn = getenv("KATAM_LIGHTING_LOG") != NULL;
    if (!logOn || gPortLighting == 0) {
        Attach(f, roomBg);
        return;
    }
    t0 = NowMs();
    Attach(f, roomBg);
    sum += NowMs() - t0;
    if (++frames == 600) {
        fprintf(stderr, "[katam-port] light: attach %.4f ms/frame mean over 600 frames\n",
                sum / frames);
        sum = 0;
        frames = 0;
    }
}

static void Attach(RlFrame *f, int roomBg)
{
    const struct LevelInfo *li;
    const u8 *grid;
    s32 cw, ch, n, i;
    u32 h = 2166136261u;
    double now;
    int anim, mode;
    const LightEnv *env;
    float target, shown, warmK = 1.0f;

    f->light = NULL;
    if (gPortLighting < 0)
        PortLightResolve();
    if (!gPortLighting || !f->world || roomBg < 0 || roomBg > 3)
        return;
    if (!sEnvDone) {
        const char *e = getenv("KATAM_LIGHTING_STRENGTH");
        if (e)
            gPortLightParams.strength = (float)atof(e);
        e = getenv("KATAM_LIGHTING_MODE");
        if (e)
            gPortLightParams.mode = e[0] == 'p' ? LIGHT_REQ_POINT
                                  : e[0] == 's' ? LIGHT_REQ_SUN : LIGHT_REQ_AUTO;
        e = getenv("KATAM_LIGHTING_RELIEF");
        if (e)
            gPortLightParams.relief = (float)atof(e);
        e = getenv("KATAM_RELIEF_VIEW");   /* 1..5, as the web's ?normals= */
        if (e && e[0] >= '1' && e[0] <= '5')
            gPortReliefView = e[0] - '0';
        sEnvDone = 1;
    }
    li = &gCurLevelInfo[gLocalPlayerId];
    if (li->currentRoom == 0xFFFF || li->unk65E > 3 || PortLightRoomUnlit(li->currentRoom))
        return;
    cw = li->roomWidth / 16;
    ch = li->roomHeight / 16;
    n = cw * ch;
    if (cw <= 0 || ch <= 0 || n > GRID_MAX || cw * 16 / LIGHT_CELL > LIGHT_MAX_W
        || ch * 16 / LIGHT_CELL > LIGHT_MAX_H)
        return;
    grid = gUnk_02024ED0[li->unk65E];
    {
        /* The lamps: found when the room is new, and again while its palette
         * still changes (a fade-in) during its first few seconds. */
        u32 ph = 2166136261u;
        int k;
        for (k = 0; k < 512; k++)
            ph = (ph ^ f->palette[k]) * 16777619u;
        static int settled;
        static u16 lastPal[512];
        int changed = 0;
        for (k = 0; k < 512; k++)
            changed += f->palette[k] != lastPal[k];
        memcpy(lastPal, f->palette, sizeof(lastPal));
        if (li->currentRoom != sLantRoom) {
            sLantRoom = li->currentRoom;
            sLantTries = 0;
            sLantPal = ph ^ 1u;
            sNumLant = 0;
            settled = 0;
        }
        /* A fade changes most of the palette at once; an animated colour
         * (water, a flame) a few.  Find the lamps once the palette has
         * held for a fifth of a second (a room's fade-in done, or a flash's),
         * if it is not the palette they were last found with. */
        if (changed > 128)
            settled = 0;
        else
            settled++;
        if (settled == 12 && ph != sLantPal && sLantTries < 6 && PortLightRoomLamps(li->currentRoom)) {
            FindLanterns(f);
            sLantPal = ph;
            sLantTries++;
        }
        if (gPortReliefView == 5 && settled == 13) {
            int j;
            for (j = 0; j < 4; j++)
                PortLog("[katam-port] light: room %u bg%d space %d streamed %d map %d %dx%d factor %d,%d off %d,%d scroll %d,%d shift %d,%d",
                        (unsigned)sLantRoom, j, f->layers[j].space, f->layers[j].streamed,
                        f->layers[j].map != NULL, (int)f->layers[j].mapW, (int)f->layers[j].mapH,
                        (int)f->layers[j].factorX, (int)f->layers[j].factorY,
                        (int)f->layers[j].mapOffX, (int)f->layers[j].mapOffY,
                        (int)f->layers[j].mapScrollX, (int)f->layers[j].mapScrollY,
                        (int)f->layers[j].shiftX, (int)f->layers[j].shiftY);
        }
    }
    for (i = 0; i < n; i++)
        h = (h ^ grid[i]) * 16777619u;
    h ^= (u32)cw << 16;
    now = NowMs();
    env = EnvFor(li->currentRoom);
    /* Sun or lights: decided when the room (or the asked-for mode) is new. */
    mode = (!sHave || li->currentRoom != sRoom || h != sGridHash
            || gPortLightParams.mode != sBuiltReq)
           ? DecideMode(li->currentRoom, grid, cw, ch, gPortLightParams.mode, env->angle) : sBuiltMode;
    anim = mode == RL_LIGHT_SUN && gPortLightParams.sunAnim;
    {
        /* The day's clock: wall time, not frames (a 120 Hz display presents
         * twice as often), and a long gap (a hidden tab) is not a jump. */
        double dt = now - sPhaseT;
        if (sPhaseT == 0.0 || dt < 0.0 || dt > 100.0)
            dt = 0.0;
        sPhaseT = now;
        if (anim) {
            sPhase += (float)(dt / 1000.0) * gPortLightParams.sunSpeed / (2.0f * SUN_ARC);
            sPhase -= floorf(sPhase);
        }
        target = anim ? SUN_ARC - 2.0f * SUN_ARC * sPhase
               : gPortLightParams.mode == LIGHT_REQ_SUN ? gPortLightParams.angle : env->angle;
    }
    {
        /* A changed map parameter (a menu slider): rebuild at most 5 times a
         * second while it moves, and once more when it settles.  The moving
         * sun's angle is the pipeline's business (SunStep). */
        const PortLightParams *P = &gPortLightParams;
        int stale = P->mode != sBuiltReq || mode != sBuiltMode || P->soft != sBuiltSoft
                    || P->depth != sBuiltDepth
                    || (mode == RL_LIGHT_SUN && !anim && target != sBuiltAngle);
        if (stale && now - sLastBuild >= 200.0)
            sHave = 0;
    }
    if (!sHave || li->currentRoom != sRoom || h != sGridHash) {
        double t0 = NowMs();
        sLastBuild = t0;
        sEnv = env;
        Build(grid, cw, ch, target, mode);
        gPortLightBuildMs = NowMs() - t0;
        if (gPortReliefView == 5)
            PortLog("[katam-port] light: room %u env %s mode %s", (unsigned)li->currentRoom,
                    env->name, sBuiltMode == RL_LIGHT_POINT ? "point" : "sun");
        if (getenv("KATAM_LIGHTING_LOG"))
            fprintf(stderr, "[katam-port] light: room %u %dx%d cells -> %dx%d map, %s, %d lights, in %.2f ms\n",
                    (unsigned)li->currentRoom, (int)cw, (int)ch, (int)sMaskW,
                    (int)sMaskH, sBuiltMode == RL_LIGHT_POINT ? "point" : "sun",
                    sNumLant, gPortLightBuildMs);
        {   /* KATAM_LIGHTING_DUMP=file.pgm: the shadow channel, for looking at */
            const char *d = getenv("KATAM_LIGHTING_DUMP");
            FILE *fp = d ? fopen(d, "wb") : NULL;
            if (fp) {
                s32 k;
                fprintf(fp, "P5\n%d %d\n255\n", (int)sMaskW, (int)sMaskH);
                for (k = 0; k < sMaskW * sMaskH; k++)
                    fputc(255 - sMask[k * 4 + 2], fp);
                fclose(fp);
            }
        }
        sRoom = li->currentRoom;
        sGridHash = h;
        sHave = 1;
    } else if (anim) {
        SunStep(target, now);
    }
    sMix = anim ? (float)((now - sSwapT) / sJobDur) : 1.0f;
    if (sMix > 1.0f)
        sMix = 1.0f;
    if (sMix < 0.0f)
        sMix = 0.0f;
    shown = sPrevAngle + (sCurAngle - sPrevAngle) * sMix;
    f->light = sMask;
    f->lightW = sMaskW;
    f->lightH = sMaskH;
    f->lightGen = sGen;
    f->lightLayers = (u8)(1u << roomBg);
    f->lightK = gPortLightParams.strength * (sBuiltMode == RL_LIGHT_POINT ? sEnv->cave.strength
                                                                         : sEnv->sun.strength);
    f->lightMix = sMix;
    f->lightSunSide = sinf(shown * 3.14159265f / 180.0f) / sinf(35.0f * 3.14159265f / 180.0f);
    if (f->lightSunSide > 1.0f) f->lightSunSide = 1.0f;
    if (f->lightSunSide < -1.0f) f->lightSunSide = -1.0f;
    if (anim) {
        /* Dawn and dusk: the light fades out at the ends of the day; a low
         * sun is warmer. */
        float e = sPhase < SUN_DUSK ? sPhase / SUN_DUSK
                : sPhase > 1.0f - SUN_DUSK ? (1.0f - sPhase) / SUN_DUSK : 1.0f;
        float low = fabsf(shown) / SUN_ARC;
        f->lightK *= e * e * (3.0f - 2.0f * e);
        warmK = 1.0f + 0.8f * low * low;
    }
    f->lightShadow = gPortLightParams.shadow;
    f->lightWarm = gPortLightParams.warmth * warmK;
    f->lightCool = gPortLightParams.cool;
    f->lightGlow = gPortLightParams.glow;
    f->lightRelief = gPortLightParams.reliefOn ? gPortLightParams.relief : 0.0f;
    f->lightShine = gPortLightParams.shine;
    f->lightHeight = gPortLightParams.height;
    f->lightAngle = shown;
    f->lightNrmView = (u8)gPortReliefView;
    f->lightSprShadow = gPortLightParams.sprShadow;
    f->lightSoft = gPortLightParams.soft;
    f->lightCharReach = gPortLightParams.charReach;
    f->lightCharDepth = gPortLightParams.charDepth;
    f->lightOcc = sOcc;
    f->lightOccW = sCw;
    f->lightOccH = sCh;
    f->lightOccGen = sOccGen;
    f->lightReliefBg = (u8)gPortLightParams.reliefBg;
    FrameLook(f);
}
