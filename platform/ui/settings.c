/* Player settings: defaults, persistence format, layout.  See settings.h. */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port/port.h"
#include "ui/settings.h"
#include "render/render_list.h"

#define PORT_HUD_W 240
#define PORT_HUD_H 160

#ifdef __cplusplus
extern "C" {
#endif

PortSettings gPortSettings;

void PortSettingsDefaults(PortSettings *s)
{
    memset(s, 0, sizeof(*s));
    s->renderer = PS_RENDER_GPU;
    s->zoom = 1.0f;
    s->dynZoom = 0;
    s->aspect = PS_ASPECT_AUTO;
    s->scaling = PS_SCALE_FIT;
    s->letterbox = 0x0C0E11;
    s->hud = PS_HUD_CORNERS;
    s->hudScale = 0;
    s->vsync = 1;
    s->showFps = 0;
    s->volume = 100;
    s->mute = 0;
    s->uiScale = 1.0f;
    /* Off by default: on phones in landscape it drags the frame rate
     * down after a minute or so of play (2026-11-09). */
    s->smoothCam = 0;
    s->interp = 1;
    s->lightOn = -1;
    LightDefaults(s);
}

/* The lighting settings saved by a build before LIGHT_SETTINGS_VER are
 * dropped for the current defaults, once (the on/off switch is kept): the
 * defaults moved a long way while the lighting was being tuned, and every
 * value was saved by anyone who touched any setting. */
#define LIGHT_SETTINGS_VER 3
void LightDefaults(PortSettings *s)
{
    {
        static const PortLightParams kL = PORT_LIGHT_PARAMS_DEFAULT;
        s->lightMode = kL.mode;
        s->lightStrength = kL.strength;
        s->lightShadow = kL.shadow;
        s->lightSoft = kL.soft;
        s->lightAngle = kL.angle;
        s->lightWarm = kL.warmth;
        s->lightCool = kL.cool;
        s->lightGlow = kL.glow;
        s->lightRelief = kL.relief;
        s->lightShine = kL.shine;
        s->lightHeight = kL.height;
        s->lightSunAnim = kL.sunAnim;
        s->lightSunSpeed = kL.sunSpeed;
        s->lightSprShadow = kL.sprShadow;
        s->lightReliefBg = kL.reliefBg;
        s->lightDepth = kL.depth;
        s->lightCharReach = kL.charReach;
        s->lightCharDepth = kL.charDepth;
        s->lightReliefOn = kL.reliefOn;
    }
}

static int ClampI(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }
static float ClampF(float v, float lo, float hi)
{
    if (!(v == v)) return lo;           /* NaN */
    return v < lo ? lo : v > hi ? hi : v;
}

void PortSettingsClamp(PortSettings *s)
{
    s->renderer = ClampI(s->renderer, 0, 1);
    s->zoom = ClampF(s->zoom, 0.5f, 2.0f);
    s->dynZoom = !!s->dynZoom;
    s->aspect = ClampI(s->aspect, 0, PS_ASPECT_COUNT - 1);
    s->scaling = ClampI(s->scaling, 0, PS_SCALE_COUNT - 1);
    s->letterbox &= 0xFFFFFF;
    s->hud = ClampI(s->hud, 0, 1);
    s->hudScale = ClampI(s->hudScale, 0, PS_HUD_SCALE_MAX);
    s->vsync = !!s->vsync;
    s->showFps = !!s->showFps;
    s->volume = ClampI(s->volume, 0, 100);
    s->mute = !!s->mute;
    s->uiScale = ClampF(s->uiScale, 0.6f, 2.0f);
    s->smoothCam = !!s->smoothCam;
    s->interp = !!s->interp;
    s->lightOn = ClampI(s->lightOn, -1, 1);
    s->lightMode = ClampI(s->lightMode, 0, 2);
    s->lightStrength = ClampF(s->lightStrength, 0.0f, 3.0f);
    s->lightShadow = ClampF(s->lightShadow, 0.0f, 0.8f);
    s->lightSoft = ClampF(s->lightSoft, 0.0f, 1.0f);
    s->lightAngle = ClampF(s->lightAngle, -75.0f, 75.0f);
    s->lightWarm = ClampF(s->lightWarm, 0.0f, 1.0f);
    s->lightCool = ClampF(s->lightCool, 0.0f, 1.0f);
    s->lightGlow = ClampF(s->lightGlow, 0.0f, 2.0f);
    s->lightRelief = ClampF(s->lightRelief, 0.0f, 2.0f);
    s->lightShine = ClampF(s->lightShine, 0.0f, 1.0f);
    s->lightHeight = ClampF(s->lightHeight, 0.2f, 2.0f);
    s->lightSunAnim = !!s->lightSunAnim;
    s->lightSunSpeed = ClampF(s->lightSunSpeed, 0.5f, 30.0f);
    s->lightSprShadow = ClampF(s->lightSprShadow, 0.0f, 1.0f);
    s->lightReliefBg = !!s->lightReliefBg;
    s->lightDepth = ClampF(s->lightDepth, 0.0f, 48.0f);
    s->lightCharReach = ClampF(s->lightCharReach, 16.0f, 160.0f);
    s->lightCharDepth = ClampF(s->lightCharDepth, 0.0f, 48.0f);
    s->lightReliefOn = !!s->lightReliefOn;
}

void PortSettingsParse(PortSettings *s, const char *text)
{
    const char *p = text;
    int lightVer = -1, lightKeys = 0;

    while (p != NULL && *p != '\0') {
        char key[32], val[64];
        const char *eol = strchr(p, '\n');
        const char *eq = strchr(p, '=');
        size_t kl, vl;

        if (eol == NULL) eol = p + strlen(p);
        if (eq != NULL && eq < eol) {
            kl = (size_t)(eq - p);
            vl = (size_t)(eol - eq - 1);
            if (kl < sizeof(key) && vl < sizeof(val)) {
                memcpy(key, p, kl); key[kl] = '\0';
                memcpy(val, eq + 1, vl); val[vl] = '\0';
                if (vl && val[vl - 1] == '\r') val[vl - 1] = '\0';
#define INT_KEY(name, field) else if (strcmp(key, name) == 0) s->field = (int)strtol(val, NULL, 0);
#define FLT_KEY(name, field) else if (strcmp(key, name) == 0) s->field = (float)strtod(val, NULL);
                if (0) {}
                INT_KEY("renderer", renderer)
                FLT_KEY("zoom", zoom)
                INT_KEY("dynzoom", dynZoom)
                INT_KEY("aspect", aspect)
                INT_KEY("scaling", scaling)
                else if (strcmp(key, "letterbox") == 0) s->letterbox = (unsigned)strtoul(val, NULL, 16);
                INT_KEY("hud", hud)
                INT_KEY("hudscale", hudScale)
                INT_KEY("vsync", vsync)
                INT_KEY("fps", showFps)
                INT_KEY("volume", volume)
                INT_KEY("mute", mute)
                FLT_KEY("uiscale", uiScale)
                /* "smoothcam2": the default changed to off, and the old key
                 * was saved as 1 by anyone who touched any setting, so it is
                 * ignored -- everyone starts from the new default once. */
                INT_KEY("smoothcam2", smoothCam)
                INT_KEY("interp", interp)
                INT_KEY("light", lightOn)
                INT_KEY("lightmode", lightMode)
                FLT_KEY("lightk", lightStrength)
                FLT_KEY("lightshadow", lightShadow)
                FLT_KEY("lightsoft", lightSoft)
                FLT_KEY("lightangle", lightAngle)
                FLT_KEY("lightwarm", lightWarm)
                FLT_KEY("lightcool", lightCool)
                FLT_KEY("lightglow", lightGlow)
                FLT_KEY("lightrelief", lightRelief)
                /* "lightshine2": the default went from 0.35 to 0.1, and the
                 * old key was saved by anyone who touched any setting. */
                FLT_KEY("lightshine2", lightShine)
                FLT_KEY("lightheight", lightHeight)
                INT_KEY("lightsunanim", lightSunAnim)
                FLT_KEY("lightsunspeed", lightSunSpeed)
                /* "lightcharshadow": the raycast character shadows.  The
                 * drop shadows before them were "lightsprshadow"/"...2";
                 * a value saved for those means something else, so it is
                 * ignored -- as smoothcam2 above. */
                FLT_KEY("lightcharshadow", lightSprShadow)
                INT_KEY("lightreliefbg", lightReliefBg)
                FLT_KEY("lightdepth", lightDepth)
                FLT_KEY("lightcharreach", lightCharReach)
                FLT_KEY("lightchardepth", lightCharDepth)
                INT_KEY("lightreliefon", lightReliefOn)
                else if (strcmp(key, "lightver") == 0) lightVer = (int)strtol(val, NULL, 0);
#undef INT_KEY
#undef FLT_KEY
                if (strncmp(key, "light", 5) == 0 && strcmp(key, "light") != 0
                    && strcmp(key, "lightver") != 0)
                    lightKeys = 1;
            }
        }
        p = *eol ? eol + 1 : eol;
    }
    if (lightKeys && lightVer < LIGHT_SETTINGS_VER)
        LightDefaults(s);
    PortSettingsClamp(s);
}

int PortSettingsFormat(const PortSettings *s, char *buf, int size)
{
    int n = snprintf(buf, (size_t)size,
        "renderer=%d\nzoom=%.3f\ndynzoom=%d\naspect=%d\nscaling=%d\n"
        "letterbox=%06X\nhud=%d\nhudscale=%d\nvsync=%d\nfps=%d\nvolume=%d\n"
        "mute=%d\nuiscale=%.2f\n",
        s->renderer, (double)s->zoom, s->dynZoom, s->aspect, s->scaling,
        s->letterbox, s->hud, s->hudScale, s->vsync, s->showFps, s->volume,
        s->mute, (double)s->uiScale);
    if (n >= 0 && n < size)
        n += snprintf(buf + n, (size_t)(size - n), "smoothcam2=%d\ninterp=%d\n",
                      s->smoothCam, s->interp);
    if (n >= 0 && n < size)
        n += snprintf(buf + n, (size_t)(size - n),
                      "lightver=%d\nlight=%d\nlightmode=%d\nlightk=%.3f\nlightshadow=%.3f\n"
                      "lightsoft=%.3f\nlightangle=%.1f\nlightwarm=%.3f\n"
                      "lightcool=%.3f\nlightglow=%.3f\nlightrelief=%.3f\n"
                      "lightshine2=%.3f\nlightheight=%.3f\nlightsunanim=%d\n"
                      "lightsunspeed=%.2f\nlightcharshadow=%.3f\nlightreliefbg=%d\n"
                      "lightdepth=%.1f\nlightcharreach=%.1f\nlightchardepth=%.1f\nlightreliefon=%d\n",
                      LIGHT_SETTINGS_VER, s->lightOn, s->lightMode, (double)s->lightStrength,
                      (double)s->lightShadow, (double)s->lightSoft,
                      (double)s->lightAngle, (double)s->lightWarm,
                      (double)s->lightCool, (double)s->lightGlow,
                      (double)s->lightRelief, (double)s->lightShine,
                      (double)s->lightHeight, s->lightSunAnim, (double)s->lightSunSpeed,
                      (double)s->lightSprShadow, s->lightReliefBg,
                      (double)s->lightDepth, (double)s->lightCharReach,
                      (double)s->lightCharDepth, s->lightReliefOn);
    return n < size ? n : size - 1;
}

float PortAspectValue(int aspect, float windowAspect)
{
    switch (aspect) {
    case PS_ASPECT_3_2:   return 3.0f / 2.0f;
    case PS_ASPECT_4_3:   return 4.0f / 3.0f;
    case PS_ASPECT_16_10: return 16.0f / 10.0f;
    case PS_ASPECT_16_9:  return 16.0f / 9.0f;
    case PS_ASPECT_21_9:  return 21.0f / 9.0f;
    case PS_ASPECT_FILL:  return windowAspect > 0.2f ? windowAspect : 1.5f;
    case PS_ASPECT_AUTO:
    default:
        /* The window's own shape, between the GBA's and ultrawide: a
         * landscape phone fills, a portrait one keeps the original. */
        return ClampF(windowAspect, 1.5f, 21.0f / 9.0f);
    }
}

const char *PortAspectName(int aspect)
{
    static const char *const k[PS_ASPECT_COUNT] = {
        "Auto (window, 3:2 to 21:9)", "Original 3:2 (240x160)", "4:3", "16:10",
        "16:9", "21:9", "Fill window",
    };
    return (aspect >= 0 && aspect < PS_ASPECT_COUNT) ? k[aspect] : "?";
}

static void Centre(int fbW, int fbH, int w, int h, int dst[4])
{
    dst[0] = (fbW - w) / 2;
    dst[1] = (fbH - h) / 2;
    dst[2] = w;
    dst[3] = h;
}

double PortLayoutScale(const PortSettings *s, int fbW, int fbH, int srcW, int srcH)
{
    double k = fmin((double)fbW / srcW, (double)fbH / srcH);

    if (s->scaling == PS_SCALE_INTEGER && k >= 1.0)
        k = floor(k);
    return k;
}

void PortLayoutFit(const PortSettings *s, int fbW, int fbH, int srcW, int srcH,
                   int dst[4])
{
    double k = PortLayoutScale(s, fbW, fbH, srcW, srcH);

    Centre(fbW, fbH, (int)(srcW * k + 0.5), (int)(srcH * k + 0.5), dst);
}

double PortLayoutHudScale(const PortSettings *s, int fbW, int fbH, const int world[4])
{
    double k, fit;

    if (s->hudScale > 0) {
        k = s->hudScale;
    } else {
        PortLayout one;

        PortLayoutCompute(s, fbW, fbH, 1, 1.0f, PORT_HUD_W, PORT_HUD_H, &one);
        k = PortLayoutScale(s, fbW, fbH, one.viewW, one.viewH);
    }
    fit = fmin((double)world[2] / PORT_HUD_W, (double)world[3] / PORT_HUD_H);
    return k < fit ? k : fit;
}

void PortLayoutCompute(const PortSettings *s, int fbW, int fbH, int world,
                       float zoom, int srcW, int srcH, PortLayout *out)
{
    float winA, a, visH;
    double vw, vh, k;

    if (fbW < 1) fbW = 1;
    if (fbH < 1) fbH = 1;
    out->smooth = s->scaling == PS_SCALE_SMOOTH;
    if (!world) {
        out->viewW = srcW;
        out->viewH = srcH;
        PortLayoutFit(s, fbW, fbH, srcW, srcH, out->dst);
        return;
    }
    winA = (float)fbW / (float)fbH;
    a = PortAspectValue(s->aspect, winA);
    visH = 160.0f / ClampF(zoom, 0.25f, 4.0f);
    vh = visH;
    vw = visH * a;
    /* Inside what the render list can draw, keeping the shape. */
    if (vw < RL_MIN_VIEW_W) { vh *= RL_MIN_VIEW_W / vw; vw = RL_MIN_VIEW_W; }
    if (vh < RL_MIN_VIEW_H) { vw *= RL_MIN_VIEW_H / vh; vh = RL_MIN_VIEW_H; }
    if (vw > 1024) { vh *= 1024 / vw; vw = 1024; }
    if (vh > 512)  { vw *= 512 / vh;  vh = 512; }
    out->viewW = ((int)(vw + 0.5)) & ~1;
    out->viewH = ((int)(vh + 0.5)) & ~1;
    if (out->viewW < RL_MIN_VIEW_W) out->viewW = RL_MIN_VIEW_W;
    if (out->viewH < RL_MIN_VIEW_H) out->viewH = RL_MIN_VIEW_H;
    k = PortLayoutScale(s, fbW, fbH, out->viewW, out->viewH);
    Centre(fbW, fbH, (int)(out->viewW * k + 0.5), (int)(out->viewH * k + 0.5),
           out->dst);
    (void)srcW; (void)srcH;
}

int PortLayoutPastSpawnMargin(int viewW, int viewH)
{
    /* The spawn margin follows the view (platform/view.c) unless a session
     * holds it at the original. */
    if (PortSimViewCovers(viewW, viewH))
        return 0;
    return viewW > 240 + 2 * PORT_SPAWN_MARGIN || viewH > 160 + 2 * PORT_SPAWN_MARGIN;
}

#ifdef __cplusplus
}
#endif
