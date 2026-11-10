/* The render list: what the GPU renderer draws, built from game state.
 *
 * This is the durable half of the renderer.  The GL backend in gl_renderer.c
 * consumes it and is replaceable; the list is the contract between the game
 * and whatever draws it.  docs/RENDERER.md has the design and the numbers.
 *
 * Three coordinate spaces, and every item says which one it is in:
 *
 *   SCREEN  GBA screen coordinates, 0..239 x 0..159 on hardware.  What the
 *           emulated PPU would have drawn there.  Menus, title screens and
 *           anything the list cannot prove is world-anchored.
 *   WORLD   GBA screen coordinates relative to the game's own camera, but
 *           *unbounded*: a world layer has real content for any x, and a
 *           world sprite carries its full-precision s32 position from before
 *           the 9-bit OAM truncation and the game's on-screen cull.  The view
 *           may be any size and may be moved off the game camera (clamping at
 *           a room edge), and world items follow it.
 *   HUD     screen space, but each item is anchored to an edge or corner of
 *           the view rather than to a 240x160 rectangle.
 *
 * What is still GBA-shaped, on purpose, for this cut: tiles and palettes are
 * referenced by VRAM address and palette RAM index (the backend keeps a texture
 * cache of both, uploaded when they change), and layer composition follows the
 * GBA rules (four priorities, two blend targets, windows).  MODDING.md M9
 * replaces the VRAM references with resource ids -- RlTileLayer.map and
 * RlSprite.tile are the fields that change; the spaces, the anchoring, the
 * effect description and the sprite order do not.
 *
 * Nothing in this file, and nothing that builds a list, writes game memory.
 * The game-side hooks (PortRl*) are write-only from the simulation's point of
 * view: they copy game state into host memory and return.  `make regress`
 * with the renderer on is the check.
 */
#ifndef GUARD_PORT_RENDER_LIST_H
#define GUARD_PORT_RENDER_LIST_H

#include "gba/types.h"

#ifdef __cplusplus
extern "C" {
#endif

#define RL_SPACE_SCREEN 0
#define RL_SPACE_WORLD  1
#define RL_SPACE_HUD    2

#define RL_MAX_SPRITES  1024
#define RL_MAX_HUD_REGIONS 8
#define RL_LINES 160            /* per-line effect state, one row per GBA line */
#define RL_LINE_WORDS 40        /* see RL_LINE_* below; 10 RGBA texels */

/* A background layer.  The text/affine distinction and the tile fetch are the
 * GBA's (BGxCNT in the per-line table); what the list adds is where the
 * layer's content comes from outside the 32x32 hardware screen block, and how
 * it moves when the view moves. */
typedef struct RlTileLayer {
    u8 enabled;
    u8 space;                /* RL_SPACE_*                                   */
    u8 streamed;             /* WORLD: VRAM holds only a window of the map   */
    u8 wrapX;                /* outside the window: 1 repeat, 2 mirror      */
    u8 mirrorY;              /* ... and mirrors at its top and bottom edge */
    u8 pad_[3];
    /* WORLD, not streamed: a picture smaller than its hardware screen block
     * (a 30x30 sky in a 32x32 block).  Nonzero: samples outside it are
     * mirrored back in at its own edges rather than wrapping at the block's,
     * which would show the block's unused columns and rows. */
    s32 picW, picH;          /* pixels                                      */
    /* Added to the screen coordinate of every pixel before sampling: for a
     * parallax layer, what puts the view at its own place in the picture
     * (rl_build.c, ParallaxAxis: the layer moves at its factor times the
     * view's motion).  Zero at 240x160, for the room layer (bar a shake)
     * and for SCREEN. */
    s32 shiftX, shiftY;
    /* ... and a further fraction of a pixel, 1/256 units (0 except in a
     * frame from PortRlPresentFrame: a sub-pixel or interpolated camera). */
    s32 subX, subY;
    /* WORLD + streamed: the room's real tilemap (row-major u16 entries,
     * exactly what bg.c DMAs into the screen block), where it sits relative
     * to the screen, and the screen-space window inside which VRAM holds the
     * game's own copy (which wins: it is what the game last wrote, including
     * any tile it changed in place). */
    const u16 *map;
    s32 mapW, mapH;          /* tiles                                       */
    s32 mapScrollX, mapScrollY;  /* Background.scrollX/Y, pixels             */
    s32 mapOffX, mapOffY;        /* Background.unk1E/unk20, tiles            */
    s32 validL, validR, validT, validB;  /* screen coords                   */
    u32 mapGen;              /* bumps when map/mapW/mapH change               */
    /* Parallax factor against the game camera, 8.8 (256 = moves with the
     * world).  Informational in this cut -- shiftX/Y already apply it. */
    s32 factorX, factorY;
} RlTileLayer;

/* One hardware-sized sprite (a GBA OBJ), front to back in the list. */
typedef struct RlSprite {
    s32 x, y;                /* top-left of the bounding box, in `space`     */
    u16 attr0, attr1, attr2; /* OBJ attributes with the position fields zero */
    u8 space;
    u8 anchor;               /* HUD: index into RlFrame.hud                  */
    s16 pa, pb, pc, pd;      /* affine matrix (identity when not affine)    */
    s16 subX, subY;          /* added to x/y, 1/256 px (PortRlPresentFrame)  */
} RlSprite;

/* A HUD region: a rectangle of the 240x160 HUD and the edge it is pinned to.
 * Every HUD pixel and HUD sprite belongs to the first region containing it. */
#define RL_ANCHOR_LEFT   0
#define RL_ANCHOR_RIGHT  1
#define RL_ANCHOR_CENTER 2
#define RL_ANCHOR_TOP    0
#define RL_ANCHOR_BOTTOM 1
typedef struct RlHudRegion {
    s16 x0, y0, x1, y1;      /* in the 240x160 HUD                           */
    u8 anchorH, anchorV;
    s16 dx, dy;              /* resolved: view coord = HUD coord + (dx, dy)  */
} RlHudRegion;

/* Per-line register state, captured as the emulated display scans each line
 * (so HBlank effects are in it).  Word offsets: */
#define RL_LINE_BGOFS    0   /* 8 words: hofs0 vofs0 hofs1 vofs1 ... (u16)  */
#define RL_LINE_AFF2     8   /* refX refY pa pc for BG2                      */
#define RL_LINE_AFF3    12   /* ... and BG3                                  */
#define RL_LINE_DISPCNT 16
#define RL_LINE_BLDCNT  17
#define RL_LINE_BLDALPHA 18
#define RL_LINE_BLDY    19
#define RL_LINE_WIN0H   20
#define RL_LINE_WIN1H   21
#define RL_LINE_WIN0V   22
#define RL_LINE_WIN1V   23
#define RL_LINE_WININ   24
#define RL_LINE_WINOUT  25
#define RL_LINE_MOSAIC  26
#define RL_LINE_BGCNT   27   /* 4 words */
#define RL_LINE_AFFB    32   /* pb2 pd2 pb3 pd3 */

#define RL_MAX_LIGHTS 4

typedef struct RlFrame {
    u32 serial;              /* bumps every built frame                      */
    u8 world;                /* 1: gameplay framing (view != 240x160 allowed) */
    u8 objOneD;
    /* The view: its size in game pixels, and where its top-left sits in
     * SCREEN coordinates.  At 240x160 on the game camera this is (0,0). */
    s32 viewW, viewH;
    s32 viewX, viewY;
    /* ... plus this fraction of a pixel, 1/256 units, 0..255: the view's
     * top-left is at viewX + viewSubX / 256.  0 except in a frame from
     * PortRlPresentFrame. */
    s32 viewSubX, viewSubY;
    /* World coordinates of SCREEN (0, 0) -- the room layer's scroll, the
     * game's camera in whole pixels.  0 outside a world frame.  Diagnostics. */
    s32 camX, camY;
    /* The view's centre minus the game screen's centre, after clamping to
     * the room.  Diagnostics. */
    s32 shiftX, shiftY;
    /* Outside this rectangle (SCREEN coords) the view has no content: the
     * backend fills it with black. */
    s32 contentL, contentT, contentR, contentB;

    RlTileLayer layers[4];   /* by hardware BG number                        */
    u8 hudBg;                /* 0xFF: none                                   */
    u8 numHud;
    RlHudRegion hud[RL_MAX_HUD_REGIONS];

    const RlSprite *sprites; /* front (drawn on top) to back                 */
    u32 numSprites;
    u32 numObjWin;           /* sprites[numSprites .. +numObjWin): OBJ window */

    /* Texture-cache sources.  The backend uploads what changed. */
    const u8 *vram;          /* 96 KiB, with off-screen sprite tiles patched  */
    const u16 *palette;      /* 512 entries, BGR555                           */
    s32 lines[RL_LINES][RL_LINE_WORDS];

    /* Diagnostics: where the list came from. */
    u32 spritesFromHooks, spritesFromOam, spritesOffscreen, spritesOverflow;
    u8 hookSpritesUsed;      /* 0: OAM did not match the hooks this frame    */

    /* Sunlight (platform/render/light.c): NULL when off.  Four u8 per 8x8
     * world pixels from the room's top-left: the previous map's shadow (light
     * blocked) and light (light arriving), 0..255, then the current map's;
     * lightMix blends them (1 = current; a moving sun fades each new map in).  World x = camX + SCREEN x.  lights:
     * the room's point lights (world px), for their halo; lightK the
     * strength (0 none, 1 default).  lightLayers: the room BG (unused by
     * the shader at present -- every non-HUD layer is lit). */
    const u8 *light;
    s32 lightW, lightH;
    u32 lightGen;
    u8 lightLayers, numLights;
    float lightK;
    float lights[RL_MAX_LIGHTS][2];
    u8 lightMode;            /* RL_LIGHT_SUN / RL_LIGHT_POINT                 */
    float lightShadow, lightWarm, lightCool, lightGlow;  /* PortLightParams  */
    /* Relief: normal maps for the sprites and layers, made on the GPU from
     * their own pixels (render/relief_glsl.h).  lightRelief 0: none. */
    float lightRelief, lightShine, lightHeight, lightAngle;
    u8 lightNrmView;         /* 1: show the normals instead of the picture   */
    float lightMix;          /* previous -> current map, 0..1                 */
    float lightSunSide;      /* -1 sun on the right .. 1 on the left (35 deg) */
    float lightSprShadow;    /* characters' shadows: strength, 0 none         */
    float lightSoft;         /* penumbra, 0..1 (PortLightParams.soft)         */
    float lightCharReach;    /* how far a character's shadow reaches, px      */
    u8 lightReliefBg;        /* relief on the background layers too           */
} RlFrame;

/* --- the renderer's switches (platform/render/rl_build.c) --------------- */

extern int gPortRlEnabled;     /* hooks collect only when set                */

/* The view the player asked for: 0 means 240x160.  `autoAspect` picks the
 * width from the window at present time. */
#define RL_MIN_VIEW_W 96
#define RL_MIN_VIEW_H 64
void PortRlSetViewSize(s32 w, s32 h);
/* 1: the HUD keeps its 240-wide strip, centred; 0: pinned to the corners. */
extern int gPortRlHudStrip;
/* Kirby's position on the GBA screen and the game camera (8.8), read-only;
 * returns 0 (and the screen centre) outside a level. */
int PortRlFocus(s32 *kx, s32 *ky, s32 *camX, s32 *camY);
void PortRlGetViewSize(s32 *w, s32 *h);

/* Called from the PPU scanline loop for each line before it is drawn. */
void PortRlCaptureLine(int line, s32 aff2x, s32 aff2y, s32 aff3x, s32 aff3y);

/* Build the frame to present from the current console state and the game
 * state committed at the last UpdateScreen.  Never writes game memory. */
const RlFrame *PortRlBuildFrame(void);
/* KATAM_RL_POPSTAT=1: objects appearing/vanishing in the widened margin. */
void PortRlReportPopIn(void);
/* The last frame built, or NULL before the first. */
const RlFrame *PortRlCurrentFrame(void);

/* Sunlight, proof of concept (light.c).
 *
 * gPortLighting is the effective switch: -1 undecided, 0 off, 1 on.  It is
 * gPortLightingUser (the settings menu: -1 follow the default, 0, 1) if set,
 * else gPortLightingDefault (the web page's /lighting/ path or ?lighting=1;
 * natively KATAM_LIGHTING=1; -1 = read the env).  PortLightResolve works it
 * out again after either changes.  PortLightAttach sets f->light for a
 * Rainbow Route world frame, NULL otherwise. */
enum { RL_LIGHT_SUN = 0, RL_LIGHT_POINT = 1 };
typedef struct PortLightParams {
    int mode;           /* RL_LIGHT_*                                       */
    float strength;     /* the whole effect, 0..3                           */
    float shadow;       /* how dark full shade is, 0..0.8                   */
    float soft;         /* sun disc / light size: the penumbra, 0..1        */
    float angle;        /* sun: degrees left of straight up, -75..75        */
    float warmth;       /* lift of lit areas, 0..1                          */
    float cool;         /* blue of the shade, 0..1                          */
    float glow;         /* point lights' halo, 0..2                         */
    float relief;       /* normal-mapped shading of the art, 0 off .. 2     */
    float shine;        /* its highlight, 0..1                              */
    float height;       /* the light's height over the picture, 0.2..2      */
    int sunAnim;        /* 1: the sun crosses the sky, sunrise to sunset    */
    float sunSpeed;     /* ... at this many degrees a second, 0.5..30       */
    float sprShadow;    /* characters' shadows, raycast like the level's:
                         * strength 0 off .. 1 (the level's own)            */
    int reliefBg;       /* relief on the background layers too, 0 / 1       */
    float depth;        /* how far light reaches into solid ground, px 0..48 */
    float charReach;    /* how far a character's shadow reaches, px 16..160  */
} PortLightParams;
#define PORT_LIGHT_PARAMS_DEFAULT { RL_LIGHT_SUN, 2.0f, 0.30f, 0.35f, 35.0f, 0.35f, 0.5f, 1.0f, \
                                    1.0f, 0.10f, 0.8f, 1, 5.0f, 1.0f, 0, 12.0f, 64.0f }
extern PortLightParams gPortLightParams;
extern int gPortLighting, gPortLightingDefault, gPortLightingUser;
/* 1: lit frames show their normal maps (web ?normals=1, KATAM_RELIEF_VIEW=1);
 * 2, 3: the relief atlas's sprite art, sprite normals; 4: the shadow map. */
extern int gPortReliefView;
extern double gPortLightBuildMs;
void PortLightResolve(void);
void PortLightAttach(RlFrame *f, int roomBg);
void PortLightRefreshParams(RlFrame *f);

/* The last frame built, for showing on a display finer than the game's pixel
 * grid and faster than its 59.73 Hz.  Presentation only: the result is a
 * copy, built from what the last two PortRlBuildFrame calls recorded, and
 * nothing here reads or writes game state.
 *
 *   RL_PRESENT_SUBPIXEL  the camera at the game's own 8.8 position rather
 *                        than its whole pixel (RlFrame.viewSubX/Y, layer
 *                        subX/Y), parallax layers at their exact scroll, and
 *                        Kirby at his own 8.8 position while he moves.  A
 *                        zoomed-in view follows him by that position too.
 *   RL_PRESENT_INTERP    camera, layers and sprites (matched by the struct
 *                        Sprite they came from) lerped between the previous
 *                        sim frame and the last one: `alpha` 0 is the
 *                        previous, 1 the last.  Nothing is interpolated across
 *                        a frame gap, a room change or a jump.
 *
 * flags 0 returns the frame as built (bit-identical: the gate path).  The
 * pointer is valid until the next call. */
#define RL_PRESENT_SUBPIXEL 1
#define RL_PRESENT_INTERP   2
const RlFrame *PortRlPresentFrame(int flags, float alpha);
/* Netplay: the world was replaced by a sync at sim frame `frame` (the netsim
 * "state corrected" event).  The next frame built does not interpolate from
 * the one before -- the two are different timelines.  Hook only: a later
 * cut can blend the correction out over a few frames instead of snapping
 * (keep the pre-correction positions as the `prev` side and decay the
 * offset), which is what this entry point is for.  Presentation only. */
void PortRlNoteCorrection(u32 frame);
/* After PortRlPresentFrame: the local Kirby's top-left in the view (1/256
 * px) and the view's top-left in world coordinates (1/256 px); returns 0 if
 * Kirby was not found.  Diagnostics (KATAM_CAMLOG). */
int PortRlPresentDiag(s32 *kirbyViewX, s32 *kirbyViewY, s32 *viewWorldX, s32 *viewWorldY);

/* --- game-side hooks: write-only, see the header comment ----------------
 * Attached by linker wraps of DisplaySprite, sub_081564D8 and
 * DrawToOamBuffer (rl_build.c); game/ itself is unmodified. */

struct Sprite;
/* At the top of DisplaySprite (variant 0) and sub_081564D8 (variant 1):
 * record every OBJ the call would write, with its full-precision position,
 * whether or not the game's 240x160 cull or the 128-entry pool lets it
 * through. */
void PortRlEmitSprite(const struct Sprite *sprite, int variant);
/* End of DrawToOamBuffer: the emitted list becomes the committed one. */
void PortRlCommitSprites(void);
/* With DrawToOamBuffer, in UpdateScreen: snapshot camera, layers, room. */
void PortRlCommitScreen(void);

#ifdef __cplusplus
}
#endif

#endif /* GUARD_PORT_RENDER_LIST_H */
