/* The shared presentation path: one GL window for both renderers, the view
 * rectangle from the settings, and the menu drawn over it.
 *
 * Presentation only.  The renderer switch toggles gPortRlEnabled (the render
 * list hooks, which only read game memory) and gPortPpuCompose (whether the
 * emulated PPU composes pixels; its scan, HBlank DMA and interrupts run
 * either way), exactly the two states `--renderer gpu` and `--renderer ppu`
 * select at start-up; docs/RENDERER.md has the proof both leave keys/sim/vid/
 * sram alone.  The view size is a render-list input; the one thing that
 * reaches the game is the *request* for the widest view (PortSimViewRequest),
 * which goes through the input log as a recorded event.  Nothing here writes
 * game memory.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port/port.h"
#include "render/render_list.h"
#include "render/gl_renderer.h"
#include "ui/settings.h"
#include "ui/ui.h"

#ifdef __cplusplus
extern "C" {
#endif

extern int gPortPpuCompose;     /* platform/ppu.c */

/* Set by the host: between sim frames it presents again at the display's
 * rate (native with vsync, the web's requestAnimationFrame), not in a turbo
 * or scripted run.  Interpolation only makes sense then -- presented once
 * per sim frame it would only add delay -- and it must not touch a scripted
 * run's pictures, which depend on nothing but the frame. */
int gPortShowDisplayRate;

/* Smooth camera and interpolation (docs/RENDERER.md, "Smooth motion").
 *
 * The world is drawn at k target pixels per game pixel, k the whole part of
 * the scale it is shown at, so a fraction of a game pixel is a visible step;
 * capped by a pixel budget, past which the rest of the scale is the present's
 * stretch as before.  Interpolation shows the world at alpha between the
 * previous sim frame (0) and the last (1), alpha from a clock that follows
 * the host's 59.7275 Hz schedule: on time, a present at the moment a sim
 * frame lands shows the previous one, and the last one is reached as the
 * next is due -- one sim frame (16.7 ms) of extra delay at most, less on
 * average than a display that repeats frames. */
#define SIM_PERIOD_MS (1000.0 / 59.7275)
#ifdef __EMSCRIPTEN__
#define WORLD_PIXEL_BUDGET (2560 * 1440)
#else
#define WORLD_PIXEL_BUDGET (3840 * 2160)
#endif
static double sSimT;
static int sHaveSimT, sLastWorld;
static FILE *sCamLog;
static int sCamLogInit;
static struct { u32 serial; float alpha; int k, world, ok; s32 vx, vy, kx, ky; } sShown;

static double sDueMs = -1.0;

void PortShowFrameDue(double dueMs)
{
    sDueMs = dueMs;
}

static void NoteSimFrame(double nowMs)
{
    double want = sSimT + SIM_PERIOD_MS;

    /* The host's own schedule, when it says: the moment this frame was due.
     * Interpolating against that, presents evenly spaced in time show the
     * world evenly spaced, however late in its slot a frame ran. */
    if (sDueMs >= 0.0 && sDueMs <= nowMs + SIM_PERIOD_MS && sDueMs > nowMs - 4 * SIM_PERIOD_MS) {
        sSimT = sDueMs;
        sHaveSimT = 1;
        sDueMs = -1.0;
        return;
    }
    sDueMs = -1.0;

    /* Frames land on the host's schedule plus however long the frame took
     * to run; follow the schedule and only slowly the clock, and start over
     * after a stall (a menu pause, a hidden tab, a turbo burst). */
    if (!sHaveSimT || nowMs - want > SIM_PERIOD_MS || want - nowMs > SIM_PERIOD_MS)
        sSimT = nowMs;
    else
        sSimT = want + (nowMs - want) * 0.05;
    sHaveSimT = 1;
}

static int InterpOn(void)
{
    return gPortSettings.interp && gPortShowDisplayRate;
}

static float Alpha(double nowMs)
{
    double a = (nowMs - sSimT) / SIM_PERIOD_MS;

    return a < 0.0 ? 0.0f : a > 1.0 ? 1.0f : (float)a;
}

/* Draw the frame's world picture for this present. */
static void DrawWorld(const RlFrame *f, int fbW, int fbH, double nowMs)
{
    int flags = (gPortSettings.smoothCam ? RL_PRESENT_SUBPIXEL : 0)
              | (InterpOn() ? RL_PRESENT_INTERP : 0);
    float alpha = (flags & RL_PRESENT_INTERP) ? Alpha(nowMs) : 1.0f;
    const RlFrame *pf = PortRlPresentFrame(flags, alpha);
    int k = 1;

    if (pf == NULL)
        pf = f;
    if (gPortSettings.smoothCam && pf->world) {
        double s = PortLayoutScale(&gPortSettings, fbW, fbH, pf->viewW, pf->viewH);

        k = s < 1.0 ? 1 : (int)s;
        while (k > 1 && (double)pf->viewW * k * pf->viewH * k > WORLD_PIXEL_BUDGET)
            k--;
        {
            /* KATAM_SMOOTH_KMAX=N: cap k (testing, slow GPUs). */
            static int kmax = -1;
            if (kmax < 0) {
                const char *e = getenv("KATAM_SMOOTH_KMAX");
                kmax = e ? atoi(e) : 0;
            }
            if (kmax > 0 && k > kmax)
                k = kmax;
        }
    }
    GlrDrawScaled(pf, k);

    sShown.serial = f->serial;
    sShown.alpha = alpha;
    sShown.k = k;
    sShown.world = pf->world;
    sShown.ok = PortRlPresentDiag(&sShown.kx, &sShown.ky, &sShown.vx, &sShown.vy);
}

/* KATAM_CAMLOG=FILE: the host calls this as each picture goes to the display;
 * one line each -- time, frame, alpha, k, world, the view's top-left in the
 * world (1/256 px), Kirby found, Kirby's top-left in the view (1/256 px).
 * How smooth the presented motion is, measured. */
void PortShowNoteSwap(double nowMs)
{
    if (!sCamLogInit) {
        const char *e = getenv("KATAM_CAMLOG");
        sCamLogInit = 1;
        sCamLog = e ? fopen(e, "w") : NULL;
    }
    if (sCamLog && sLastWorld)
        fprintf(sCamLog, "%.3f %u %.3f %d %d %d %d %d %d %d\n", nowMs, (unsigned)sShown.serial,
                (double)sShown.alpha, sShown.k, sShown.world, (int)sShown.vx, (int)sShown.vy,
                sShown.ok, (int)sShown.kx, (int)sShown.ky);
}

static int sReady, sGpuAvail, sUsingGpu = -1, sUi;
static int sDst[4], sSrc[4];
static int sWorldViewW = 240, sWorldViewH = 160;

/* Dynamic zoom (docs/VIEW.md): ease in while the camera rests, out fast when
 * it moves.  Here it only changes how much of the world the render list is
 * asked to show. */
static float sDynZoom = 1.0f;
static s32 sPrevCamX, sPrevCamY;
static int sHaveCam;
static float sCamSpeed;

/* Rates, for the menu and the FPS overlay. */
static double sRateT0;
static int sRateSims, sRateDraws;

static void ApplyRenderer(void)
{
    int want = sGpuAvail && gPortSettings.renderer == PS_RENDER_GPU;

    if (want == sUsingGpu)
        return;
    sUsingGpu = want;
    gPortRlEnabled = want;
    gPortPpuCompose = !want;
    PortLog("[katam-port] renderer: %s", want ? "gpu (render list)" : "ppu");
}

void PortSettingsApplyEarly(void)
{
    PortSettingsClamp(&gPortSettings);
    gPortRlHudStrip = gPortSettings.hud == PS_HUD_STRIP;
    {
        const PortSettings *s = &gPortSettings;
        PortLightParams *L = &gPortLightParams;
        L->mode = s->lightMode;
        L->strength = s->lightStrength;
        L->shadow = s->lightShadow;
        L->soft = s->lightSoft;
        L->angle = s->lightAngle;
        L->warmth = s->lightWarm;
        L->cool = s->lightCool;
        L->glow = s->lightGlow;
        L->relief = s->lightRelief;
        L->shine = s->lightShine;
        L->height = s->lightHeight;
        L->sunAnim = s->lightSunAnim;
        L->sunSpeed = s->lightSunSpeed;
        L->sprShadow = s->lightSprShadow;
        L->reliefBg = s->lightReliefBg;
        L->depth = s->lightDepth;
        L->charReach = s->lightCharReach;
        L->charDepth = s->lightCharDepth;
        L->reliefOn = s->lightReliefOn;
        L->indoorShade = s->lightIndoor;
        L->engine = s->lightEngine;
        L->bounce = s->lightBounce;
        gPortLightingUser = s->lightOn;
        PortLightResolve();
    }
    PortHostSetVolume(gPortSettings.mute ? 0.0f : gPortSettings.volume / 100.0f);
}

void PortSettingsChanged(void)
{
    char buf[1024];

    PortSettingsApplyEarly();
    PortHostSetVsync(gPortSettings.vsync);
    if (sReady)
        ApplyRenderer();
    PortSettingsFormat(&gPortSettings, buf, sizeof(buf));
    PortHostSaveSettings(buf);
}

int PortShowInit(int es, int gpuAvailable)
{
    sGpuAvail = gpuAvailable;
    sReady = 1;
    ApplyRenderer();
    sUi = PortUiInit(es);
    if (!sUi)
        PortError("[katam-port] settings menu did not start");
    gPortUiStatus.gpuAvailable = gpuAvailable;
    gPortUiStatus.gpuDesc = GlrDescribe();
    return 1;
}

int PortShowReady(void)
{
    return sReady;
}

int PortShowUsingGpu(void)
{
    return sUsingGpu == 1;
}

static void UpdateDynZoom(void)
{
    s32 kx, ky, cx, cy, dx, dy;
    float speed, target;

    if (!gPortSettings.dynZoom) {
        sDynZoom = 1.0f;
        sHaveCam = 0;
        return;
    }
    if (!PortRlFocus(&kx, &ky, &cx, &cy)) {
        sHaveCam = 0;
        return;
    }
    if (!sHaveCam) {
        sPrevCamX = cx; sPrevCamY = cy; sHaveCam = 1;
    }
    dx = cx - sPrevCamX; if (dx < 0) dx = -dx;
    dy = cy - sPrevCamY; if (dy < 0) dy = -dy;
    sPrevCamX = cx; sPrevCamY = cy;
    if ((dx > dy ? dx : dy) > 0x180 * 8)
        return;                 /* a room change teleports the camera */
    /* Camera speed in 8.8 px/frame, smoothed; a pixel a frame is "moving". */
    speed = (float)(dx > dy ? dx : dy);
    sCamSpeed += (speed - sCamSpeed) * 0.125f;
    if (sCamSpeed > 256.0f) sCamSpeed = 256.0f;
    target = 1.5f - 0.5f * sCamSpeed / 256.0f;
    if (target < sDynZoom) {
        sDynZoom -= 0.0625f;            /* out in about a fifth of a second */
        if (sDynZoom < target) sDynZoom = target;
    } else if (target > sDynZoom) {
        sDynZoom += 0.0078f;            /* in over about a second and a half */
        if (sDynZoom > target) sDynZoom = target;
    }
}

static void CountRates(double nowMs, int sim)
{
    if (sRateT0 == 0)
        sRateT0 = nowMs;
    sRateDraws++;
    sRateSims += sim;
    if (nowMs - sRateT0 >= 500.0) {
        double secs = (nowMs - sRateT0) / 1000.0;

        gPortUiStatus.simFps = (float)(sRateSims / secs);
        gPortUiStatus.drawFps = (float)(sRateDraws / secs);
        sRateT0 = nowMs;
        sRateSims = sRateDraws = 0;
    }
}

static void Draw(int fbW, int fbH, float dpr, double nowMs)
{
    float bg[3];
    int w, h;

    bg[0] = ((gPortSettings.letterbox >> 16) & 255) / 255.0f;
    bg[1] = ((gPortSettings.letterbox >> 8) & 255) / 255.0f;
    bg[2] = (gPortSettings.letterbox & 255) / 255.0f;
    if (GlrSourceSize(&w, &h)) {
        sSrc[0] = 0; sSrc[1] = 0; sSrc[2] = w; sSrc[3] = h;
        PortLayoutFit(&gPortSettings, fbW, fbH, w, h, sDst);
    } else {
        memset(sSrc, 0, sizeof(sSrc));
        memset(sDst, 0, sizeof(sDst));
    }
    GlrPresentRect(fbW, fbH, sSrc, sDst,
                   gPortSettings.scaling == PS_SCALE_SMOOTH, bg);
    if (GlrHudActive())
        GlrPresentHud(fbW, fbH, sDst, PortLayoutHudScale(&gPortSettings, fbW, fbH, sDst),
                      gPortSettings.scaling == PS_SCALE_SMOOTH);
    if (sUi)
        PortUiDraw(fbW, fbH, dpr, nowMs);
}

void PortShowNewFrame(int fbW, int fbH, float dpr, double nowMs,
                      const unsigned int *ppu, int ppuW, int ppuH)
{
    const RlFrame *f = sUsingGpu == 1 ? PortRlCurrentFrame() : NULL;
    PortLayout lay;
    float zoom;

    if (!sReady)
        return;
    UpdateDynZoom();
    zoom = gPortSettings.zoom * sDynZoom;
    /* The world view for the next frame built (applies to gameplay frames;
     * menus are always 240x160). */
    PortLayoutCompute(&gPortSettings, fbW, fbH, 1, zoom, 240, 160, &lay);
    sWorldViewW = lay.viewW;
    sWorldViewH = lay.viewH;
    PortRlSetViewSize(lay.viewW, lay.viewH);
    /* The game's spawn window is sized for the widest view this may show:
     * the settings' zoom, before the dynamic ease-in (which only zooms in).
     * A recorded simulation input, not presentation -- platform/view.c. */
    {
        PortLayout wide;

        PortLayoutCompute(&gPortSettings, fbW, fbH, 1, gPortSettings.zoom,
                          240, 160, &wide);
        if (sUsingGpu == 1)
            PortSimViewRequest(wide.viewW, wide.viewH);
        else
            PortSimViewRequest(240, 160);
    }

    if (f != NULL) {
        /* The HUD as its own layer whenever drawing it in the view would
         * give it the wrong size or not fit: the view is smaller than the
         * HUD (zoomed in), or its scale is not the world's (zoomed, or a
         * HUD size picked).  Otherwise -- zoom 1 and Auto -- it stays in
         * the composite, the GBA's own picture. */
        int d[4];
        double kw, kh;

        PortLayoutFit(&gPortSettings, fbW, fbH, f->viewW, f->viewH, d);
        kw = PortLayoutScale(&gPortSettings, fbW, fbH, f->viewW, f->viewH);
        kh = PortLayoutHudScale(&gPortSettings, fbW, fbH, d);
        static int force = -2;

        if (force == -2) {
            /* KATAM_HUD_LAYER=0/1: never/always the separate HUD layer, to
             * compare the two (docs/RENDERER.md). */
            const char *e = getenv("KATAM_HUD_LAYER");
            force = e ? atoi(e) : -1;
        }
        GlrSetHudLayer(f->world && f->numHud > 0
                       && (force >= 0 ? force
                           : (f->viewW < 240 || f->viewH < 160 || fabs(kw - kh) > 1e-6)));
        gPortUiStatus.hudScaleNow = (float)kh;
        NoteSimFrame(nowMs);
        DrawWorld(f, fbW, fbH, nowMs);
        sLastWorld = 1;
        gPortUiStatus.viewW = f->viewW;
        gPortUiStatus.viewH = f->viewH;
        gPortUiStatus.world = f->world;
    } else {
        GlrUploadPicture(ppu, ppuW, ppuH);
        sLastWorld = 0;
        gPortUiStatus.viewW = ppuW;
        gPortUiStatus.viewH = ppuH;
        gPortUiStatus.world = 0;
    }
    gPortUiStatus.gpu = sUsingGpu == 1;
    gPortUiStatus.zoomNow = zoom;
    CountRates(nowMs, 1);
    Draw(fbW, fbH, dpr, nowMs);
}

void PortShowAgain(int fbW, int fbH, float dpr, double nowMs)
{
    const RlFrame *f;

    if (!sReady)
        return;
    /* Between sim frames: the interpolated world for this moment. */
    if (sLastWorld && sUsingGpu == 1 && InterpOn() && (f = PortRlCurrentFrame()) != NULL)
        DrawWorld(f, fbW, fbH, nowMs);
    CountRates(nowMs, 0);
    Draw(fbW, fbH, dpr, nowMs);
}

#ifdef __cplusplus
}
#endif
