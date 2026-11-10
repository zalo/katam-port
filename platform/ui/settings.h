/* Player settings: presentation only.
 *
 * Everything here changes how a frame is shown or heard, never what the game
 * does: the renderer choice (PPU or render list, both of which read the same
 * console state), the GPU view rectangle and its scaling, the HUD's anchoring,
 * and the output volume.  None of them is written to game memory, none is in a
 * recording, and `make regress` (which never loads them) is unaffected.  The
 * one exception is deliberate: the game's spawn/despawn windows follow the
 * widest view the settings allow, which present.c hands the simulation as a
 * recorded request (PortSimViewRequest, docs/VIEW.md "Spawn margin").  While
 * a netplay session holds them at the original, a view past the spawn margin
 * shows pop-in; PortLayoutPastSpawnMargin says when.
 *
 * The settings menu (ui_menu.cpp) is a view over this struct; a later HTML or
 * native UI can drive the same struct and call PortSettingsChanged().
 *
 * Persisted as "key=value" lines: localStorage on the web
 * (host_web.c), settings.ini in SDL's pref dir natively (host_sdl.c).
 */
#ifndef GUARD_PORT_UI_SETTINGS_H
#define GUARD_PORT_UI_SETTINGS_H

#ifdef __cplusplus
extern "C" {
#endif

enum { PS_RENDER_GPU = 0, PS_RENDER_PPU = 1 };
enum { PS_ASPECT_AUTO = 0, PS_ASPECT_3_2, PS_ASPECT_4_3, PS_ASPECT_16_10,
       PS_ASPECT_16_9, PS_ASPECT_21_9, PS_ASPECT_FILL, PS_ASPECT_COUNT };
enum { PS_SCALE_INTEGER = 0, PS_SCALE_FIT, PS_SCALE_SMOOTH, PS_SCALE_COUNT };
enum { PS_HUD_CORNERS = 0, PS_HUD_STRIP };
#define PS_HUD_SCALE_MAX 8

typedef struct PortSettings {
    int renderer;       /* PS_RENDER_*                                      */
    float zoom;         /* 1.0 = 160 world rows visible, as on the GBA      */
    int dynZoom;        /* ease in while the camera rests (docs/VIEW.md)    */
    int aspect;         /* PS_ASPECT_*                                      */
    int scaling;        /* PS_SCALE_*                                       */
    unsigned letterbox; /* 0xRRGGBB                                         */
    int hud;            /* PS_HUD_*                                         */
    int hudScale;       /* 0 auto (the size at zoom 1), else N window pixels
                         * per HUD pixel; PS_HUD_SCALE_MAX at most          */
    int vsync;          /* native: present on the display's refresh         */
    int showFps;
    int volume;         /* 0..100                                           */
    int mute;
    float uiScale;      /* menu size multiplier, 1.0 = automatic            */
    int smoothCam;      /* GPU: the camera at the game's sub-pixel position */
    int interp;         /* GPU: lerp between sim frames at display rate     */
    /* Lighting (GPU renderer, every level; platform/render/light.c). */
    int lightOn;        /* -1 the page's default (/lighting/), 0 off, 1 on   */
    int lightMode;      /* LIGHT_REQ_AUTO / _SUN / _POINT                   */
    float lightStrength, lightShadow, lightSoft, lightAngle, lightWarm,
          lightCool, lightGlow;   /* PortLightParams                        */
    float lightRelief, lightShine, lightHeight;   /* ... normal maps        */
    int lightSunAnim;   /* the sun crosses the sky                          */
    float lightSunSpeed;  /* ... degrees a second                           */
    float lightSprShadow; /* sprites' drop shadows, 0 off                   */
    int lightReliefBg;  /* relief on background layers too                  */
    float lightDepth;   /* light into solid ground, px                      */
    float lightCharReach; /* character shadow length, px                    */
    float lightCharDepth; /* character shadows into solid ground, px        */
    int lightReliefOn;  /* normal maps at all (relief, shine)               */
} PortSettings;

extern PortSettings gPortSettings;

void PortSettingsDefaults(PortSettings *s);
/* Apply "key=value" lines over *s; unknown keys and bad values are skipped. */
void PortSettingsParse(PortSettings *s, const char *text);
/* Every lighting setting but the on/off switch to its default. */
void LightDefaults(PortSettings *s);
/* Returns the length written (always NUL-terminated). */
int PortSettingsFormat(const PortSettings *s, char *buf, int size);
void PortSettingsClamp(PortSettings *s);
float PortAspectValue(int aspect, float windowAspect);
const char *PortAspectName(int aspect);

/* The view rectangle and where it goes on screen.
 *
 * fbW x fbH is the drawable in device pixels.  For gameplay on the GPU path
 * (`world`), viewW x viewH is the world viewport to ask the render list for;
 * otherwise the source is srcW x srcH (240x160 menus, the PPU picture) and
 * the view is that.  dst is where the source lands, top-left origin. */
typedef struct PortLayout {
    int viewW, viewH;
    int dst[4];
    int smooth;
} PortLayout;

void PortLayoutCompute(const PortSettings *s, int fbW, int fbH, int world,
                       float zoom, int srcW, int srcH, PortLayout *out);
/* Fit an srcW x srcH picture into the framebuffer per the scaling mode;
 * Scale is the factor Fit uses (framebuffer pixels per source pixel). */
void PortLayoutFit(const PortSettings *s, int fbW, int fbH, int srcW, int srcH,
                   int dst[4]);
double PortLayoutScale(const PortSettings *s, int fbW, int fbH, int srcW, int srcH);
/* The HUD's own scale (framebuffer pixels per HUD pixel) for a world picture
 * landing at world[4] = {x, y, w, h}: the setting, or with Auto the scale the
 * world itself has at zoom 1 in this framebuffer -- so zooming changes the
 * world, not the HUD -- and never more than lets the whole 240x160 HUD fit
 * inside the world picture. */
double PortLayoutHudScale(const PortSettings *s, int fbW, int fbH, const int world[4]);
/* The game creates objects 48 px past the 240x160 screen and removes them
 * 48 px past it.  The windows widen with the view, except while a session
 * holds them at the original; then a view wider/taller than this shows
 * objects popping in. */
#define PORT_SPAWN_MARGIN 48
int PortLayoutPastSpawnMargin(int viewW, int viewH);

#ifdef __cplusplus
}
#endif

#endif
