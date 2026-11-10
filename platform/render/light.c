/* Sunlight for Rainbow Route (proof of concept, branch `lighting`).
 *
 * Off unless asked for: KATAM_LIGHTING=1 (native/node) or the web page's
 * /lighting/ path or ?lighting=1 (host_web.c sets gPortLighting).  With it
 * off nothing here runs and the render list is what it always was.
 *
 * Two modes (gPortLightParams, the settings menu's Lighting section):
 * the sun (default) -- parallel rays from the upper left, beyond the top of
 * the room, at gPortLightParams.angle degrees from overhead -- or warm point
 * lights hanging in the room's sky (one per 640 px of room width).  Per
 * room, from the room's own collision grid (gUnk_02024ED0[slot], one byte
 * per 16x16 cell, an index into gCollisionAttributes), a map of one RG
 * texel per 8x8 world pixels is worked out by marching five rays from each
 * texel across the sun's angular disc or each light's disc: R = light
 * blocked (shadow, with a penumbra that widens with distance), G = light
 * arriving, then a small blur.  It is recomputed when the room changes, a
 * byte of its grid does (a block broken), or a map parameter does (at most
 * 5 times a second while a slider moves), so a frame costs a hash of at
 * most 1950 bytes.  The GL composite samples it bilinearly in world
 * coordinates (stable while the camera moves): shade darker and cooler,
 * lit areas warmer, the point lights' halo; the playfield fully, the
 * parallax art behind it at 55%; never the HUD.  With relief on (the
 * default), every sprite and layer pixel also has a normal, made each frame
 * on the GPU from the art itself (render/relief_glsl.h, a port of Sprite
 * Normals), and the sun or the lights shade it: slopes facing the light
 * brighter, turned away darker, flat art unchanged, none of it in shadow.
 * Outside the world framing, or outside Rainbow Route, the frame carries no
 * light map and the composite is the old one.  The PPU (software) path is not touched.
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

/* Rainbow Route's rooms: the AREA_RAINBOW_ROUTE entries of the game's own
 * area-map table (game/src/pause_area_map.c, sAreaMapRoomInfos, static there,
 * so copied rather than linked -- 51 ids, no ROM bytes). */
static const u16 kRainbowRooms[] = {
    0x7e, 0x22d, 0xbe, 0xc2, 0x321, 0xb0, 0xc0, 0x24e, 0xb1, 0x217, 0x21a,
    0x218, 0x219, 0x21e, 0x21f, 0x8d, 0x8f, 0x22c, 0x22b, 0x22a, 0x6c, 0x8c,
    0x67, 0x68, 0x6b, 0x6a, 0x65, 0x6e, 0x1f7, 0x1fb, 0x89, 0x88, 0x7f,
    0x1f8, 0xae, 0x77, 0x76, 0xad, 0xaf, 0xac, 0xab, 0x75, 0x73, 0x8b,
    0x216, 0x23a, 0x23b, 0x214, 0x8a, 0xb2, 0x8e,
};

static int IsRainbowRoute(u16 room)
{
    unsigned i;
    for (i = 0; i < sizeof(kRainbowRooms) / sizeof(kRainbowRooms[0]); i++)
        if (kRainbowRooms[i] == room)
            return 1;
    return 0;
}

#define LIGHT_CELL 8                         /* world px per light texel    */
#define LIGHT_MAX_W (2176 / LIGHT_CELL + 2)
#define LIGHT_MAX_H (1648 / LIGHT_CELL + 2)
#define GRID_MAX 1950

/* The tunables are gPortLightParams (the settings menu's Lighting section;
 * natively KATAM_LIGHTING_STRENGTH / _MODE override strength and mode). */
#define LIGHT_RANGE 560.0f                   /* px a light reaches          */
#define LIGHT_SPACING 640                    /* px between a room's lights  */
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
static float sLights[RL_MAX_LIGHTS][2];
static int sNumLights;

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

/* Where the lights hang: one per LIGHT_SPACING px of room width, each in
 * the most open spot (most air in a 9x9-cell window, higher preferred) of
 * the upper half of the room near its column -- the sky of an outdoor room.
 * Anchored to the room, so shadows do not swim. */
static void PlaceLights(s32 cw, s32 ch)
{
    int i, n = (cw * 16 + LIGHT_SPACING - 1) / LIGHT_SPACING;

    if (n < 1)
        n = 1;
    if (n > RL_MAX_LIGHTS)
        n = RL_MAX_LIGHTS;
    for (i = 0; i < n; i++) {
        s32 c0 = n == 1 ? cw / 3 : (s32)(((2 * i + 1) * cw) / (2 * n));
        s32 cx, cy, bx = c0, by = ch / 2, ymax = ch / 2 > 2 ? ch / 2 : 2;
        float best = -1e9f;

        for (cy = 1; cy <= ymax && cy < ch; cy++)
            for (cx = c0 - 5; cx <= c0 + 5; cx++) {
                int air = 0, x, y;
                float score;
                if (cx < 0 || cx >= cw || sOcc[cy * cw + cx] != 0)
                    continue;
                for (y = cy - 4; y <= cy + 4; y++)
                    for (x = cx - 4; x <= cx + 4; x++)
                        if (x >= 0 && y >= 0 && x < cw && y < ch && sOcc[y * cw + x] == 0)
                            air++;
                score = air - 0.6f * cy - 0.3f * (cx > c0 ? cx - c0 : c0 - cx);
                if (score > best) {
                    best = score;
                    bx = cx;
                    by = cy;
                }
            }
        sLights[i][0] = bx * 16 + 8;
        sLights[i][1] = by * 16 + 8;
    }
    sNumLights = n;
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

/* 0..1: how much of light (lx,ly)'s disc the point sees. */
static float Visible(float px0, float py0, float lx0, float ly0, float d0,
                     s32 cw, s32 ch)
{
    int depth = DepthSteps();
    float nx = -(ly0 - py0) / d0, ny = (lx0 - px0) / d0, lit = 0.0f;
    int r;

    /* Rays to points across the light's disc, perpendicular to the line to
     * it: the penumbra widens with distance from the occluder, as an area
     * light's does. */
    for (r = 0; r < LIGHT_RAYS; r++) {
        float o = (4.0f + 56.0f * gPortLightParams.soft)
                  * ((float)r / (LIGHT_RAYS - 1) * 2.0f - 1.0f);
        float lx = lx0 + nx * o, ly = ly0 + ny * o;
        float dx = lx - px0, dy = ly - py0, d = sqrtf(dx * dx + dy * dy);
        int n = (int)(d / LIGHT_STEP), s, start = 0, blocked = 0;
        float sx, sy;

        if (d < 1.0f) {
            lit += 1.0f;
            continue;
        }
        sx = dx / d * LIGHT_STEP;
        sy = dy / d * LIGHT_STEP;
        /* Inside the ground: start where the ray leaves it (within
         * DepthSteps), so the face of a lit block is lit that far in. */
        while (start < n && start < depth
               && Occ((s32)(px0 + sx * start), (s32)(py0 + sy * start), cw, ch))
            start++;
        for (s = start + 1; s < n; s++)
            if (Occ((s32)(px0 + sx * s), (s32)(py0 + sy * s), cw, ch)) {
                blocked = 1;
                break;
            }
        lit += blocked ? 0.0f : 1.0f;
    }
    return lit / LIGHT_RAYS;
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

static void BuildPoints(s32 cw, s32 ch, s32 mw, s32 mh)
{
    s32 tx, ty;

    PlaceLights(cw, ch);

    /* Per texel: shadow = how much light is blocked (fading out towards
     * the edge of each light's reach), light = how much arrives, falling
     * off with distance.  Daylight stays neutral away from both. */
    for (ty = 0; ty < mh; ty++) {
        for (tx = 0; tx < mw; tx++) {
            float px0 = tx * LIGHT_CELL + LIGHT_CELL * 0.5f;
            float py0 = ty * LIGHT_CELL + LIGHT_CELL * 0.5f;
            float sh = 0.0f, li = 0.0f;
            int l;

            for (l = 0; l < sNumLights; l++) {
                float dx = sLights[l][0] - px0, dy = sLights[l][1] - py0;
                float d = sqrtf(dx * dx + dy * dy), v, fade, att;
                if (d >= LIGHT_RANGE)
                    continue;
                v = d < 1.0f ? 1.0f : Visible(px0, py0, sLights[l][0], sLights[l][1], d, cw, ch);
                fade = (LIGHT_RANGE - d) / 160.0f;
                if (fade > 1.0f)
                    fade = 1.0f;
                att = 1.0f - d / LIGHT_RANGE;
                sh += (1.0f - v) * fade;
                li += v * att * att;
            }
            sTmp[(ty * mw + tx) * 2] = sh > 1.0f ? 1.0f : sh;
            sTmp[(ty * mw + tx) * 2 + 1] = li > 1.0f ? 1.0f : li;
        }
    }
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

static void Build(const u8 *grid, s32 cw, s32 ch, float angle)
{
    s32 mw = (cw * 16) / LIGHT_CELL, mh = (ch * 16) / LIGHT_CELL;
    s32 i;

    for (i = 0; i < cw * ch; i++) {
        u32 a = gCollisionAttributes[grid[i]];
        if (a & 0x200)
            sOcc[i] = 1;
        else if ((a >> 28) != 0 && !(a & 1))
            sOcc[i] = 1;                     /* a slope: count it solid     */
        else if (a & 0x4)
            sOcc[i] = 2;                     /* jump-through platform       */
        else
            sOcc[i] = 0;
    }
    if (gPortLightParams.mode == RL_LIGHT_POINT) {
        BuildPoints(cw, ch, mw, mh);
    } else {
        BuildSun(cw, ch, mw, angle, 0, mh);
        sNumLights = 0;
    }
    sBuiltMode = gPortLightParams.mode;
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

/* A frame shown again (the menu's pause, a frozen frame): the look's
 * parameters as they are now, so a change shows on the same picture.  The
 * map and the sun's place stay as built. */
void PortLightRefreshParams(RlFrame *f)
{
    const PortLightParams *P = &gPortLightParams;
    int anim = P->mode == RL_LIGHT_SUN && P->sunAnim, i;

    if (!f || !f->light)
        return;
    /* A map parameter changed on a held frame: build the map again from
     * the same room's grid (the game is not running, so it is the same). */
    if (sGrid && f->light == sMask
        && (P->mode != sBuiltMode || P->soft != sBuiltSoft || P->depth != sBuiltDepth
            || (P->mode == RL_LIGHT_SUN && !anim && P->angle != sBuiltAngle))) {
        Build(sGrid, sCw, sCh, anim ? sCurAngle : P->angle);
        f->lightGen = sGen;
        f->lightMode = (u8)sBuiltMode;
        f->lightMix = 1.0f;
        f->lightAngle = sCurAngle;
        f->numLights = (u8)sNumLights;
        for (i = 0; i < sNumLights; i++) {
            f->lights[i][0] = sLights[i][0];
            f->lights[i][1] = sLights[i][1];
        }
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
    if (!(gPortLightParams.mode == RL_LIGHT_SUN && gPortLightParams.sunAnim))
        f->lightK = gPortLightParams.strength;
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
    int anim;
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
            gPortLightParams.mode = (e[0] == 'p') ? RL_LIGHT_POINT : RL_LIGHT_SUN;
        e = getenv("KATAM_LIGHTING_RELIEF");
        if (e)
            gPortLightParams.relief = (float)atof(e);
        e = getenv("KATAM_RELIEF_VIEW");
        if (e && e[0] >= '1' && e[0] <= '4')
            gPortReliefView = e[0] - '0';
        sEnvDone = 1;
    }
    li = &gCurLevelInfo[gLocalPlayerId];
    if (li->currentRoom == 0xFFFF || !IsRainbowRoute(li->currentRoom) || li->unk65E > 3)
        return;
    cw = li->roomWidth / 16;
    ch = li->roomHeight / 16;
    n = cw * ch;
    if (cw <= 0 || ch <= 0 || n > GRID_MAX || cw * 16 / LIGHT_CELL > LIGHT_MAX_W
        || ch * 16 / LIGHT_CELL > LIGHT_MAX_H)
        return;
    grid = gUnk_02024ED0[li->unk65E];
    for (i = 0; i < n; i++)
        h = (h ^ grid[i]) * 16777619u;
    h ^= (u32)cw << 16;
    now = NowMs();
    anim = gPortLightParams.mode == RL_LIGHT_SUN && gPortLightParams.sunAnim;
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
        target = anim ? SUN_ARC - 2.0f * SUN_ARC * sPhase : gPortLightParams.angle;
    }
    {
        /* A changed map parameter (a menu slider): rebuild at most 5 times a
         * second while it moves, and once more when it settles.  The moving
         * sun's angle is the pipeline's business (SunStep). */
        const PortLightParams *P = &gPortLightParams;
        int stale = P->mode != sBuiltMode || P->soft != sBuiltSoft || P->depth != sBuiltDepth
                    || (P->mode == RL_LIGHT_SUN && !anim && P->angle != sBuiltAngle);
        if (stale && now - sLastBuild >= 200.0)
            sHave = 0;
    }
    if (!sHave || li->currentRoom != sRoom || h != sGridHash) {
        double t0 = NowMs();
        sLastBuild = t0;
        Build(grid, cw, ch, target);
        gPortLightBuildMs = NowMs() - t0;
        if (getenv("KATAM_LIGHTING_LOG"))
            fprintf(stderr, "[katam-port] light: room %u %dx%d cells -> %dx%d map, %s, %d lights, in %.2f ms\n",
                    (unsigned)li->currentRoom, (int)cw, (int)ch, (int)sMaskW,
                    (int)sMaskH, sBuiltMode == RL_LIGHT_POINT ? "point" : "sun",
                    sNumLights, gPortLightBuildMs);
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
    f->lightK = gPortLightParams.strength;
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
    f->lightMode = (u8)sBuiltMode;
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
    f->numLights = (u8)sNumLights;
    for (i = 0; i < sNumLights; i++) {
        f->lights[i][0] = sLights[i][0];
        f->lights[i][1] = sLights[i][1];
    }
}
