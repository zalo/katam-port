/* The GL backend for the render list.
 *
 * Three passes per frame, at the view's own resolution (game pixels) times a
 * whole factor k (GlrDrawScaled; 1 for GlrDraw):
 *
 *   1. OBJ: every sprite as an instanced quad into an RGBA8UI target, back to
 *      front with plain overwrite, so the front-most opaque sprite pixel wins
 *      whatever its priority -- the GBA's rule, which the PPU reproduces too.
 *      The texel holds the BGR555 colour and priority/semi-transparent bits.
 *      OBJ-window sprites go to a second, R8UI target.
 *   2. Composite: one full-view triangle.  Per pixel it evaluates the four
 *      background layers (tilemap -> tile -> palette, all integer texel
 *      fetches from the VRAM and palette caches), reads the OBJ texel, and
 *      resolves priority, windows, alpha blending and brightness exactly as
 *      platform/ppu.c does, in 5-bit integer arithmetic, so a 240x160 frame
 *      can be compared pixel for pixel.
 *   3. Present: a nearest-neighbour blit of the composite into the window at
 *      the largest integer scale that fits.
 *
 * At k > 1 every target pixel is 1/k of a game pixel, and every position is
 * carried in 1/256 px: the view's origin (RlFrame.viewSubX/Y), each layer's
 * shift (subX/Y) and each sprite's (subX/Y).  A pixel finds the texel under
 * its centre -- every texel still k pixels square, sharp -- so a camera or a
 * sprite between two whole game pixels is drawn there, which is what makes
 * scrolling smooth at a large scale.  The GBA rules (priority, windows,
 * blending) are evaluated per target pixel exactly as at k = 1, and at k = 1
 * with no fractions the arithmetic is the old integer one, bit for bit.
 *
 * With the HUD as its own layer (GlrSetHudLayer) a world frame takes two more
 * steps: passes 1 and 2 leave the HUD out, and run again for the HUD alone
 * into a HUD atlas -- one slot per HUD region, the region at HUD resolution
 * with a 32-px gutter round it for sprites that hang over its edge -- with
 * the same priority, window and colour-effect rules (a fade darkens the HUD
 * as on the GBA).  GlrPresentHud scales each slot over the world picture,
 * pinned to its corner, at a scale of the host's choosing.
 *
 * Texture cache: VRAM (96 KiB as a 256x384 R8UI texture) is uploaded by
 * dirty 256-byte rows against a shadow of what the GPU has; palette RAM and
 * the per-line register table are small and go up every frame; each world
 * layer's room tilemap lives in a 1024-wide R16UI atlas, uploaded when the
 * map changes identity or content.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "port/port.h"
#include "render/gl_api.h"
#include "render/gl_renderer.h"
#include "render/relief_glsl.h"
#include "render/rc_glsl.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define RcNowMs() emscripten_get_now()
#else
#include <time.h>
static double RcNowMs(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}
#endif

#ifdef __cplusplus
extern "C" {
#endif

#ifndef __EMSCRIPTEN__
#define GLR_DEFINE(ret, name, args) PFN_glr_##name glr_##name;
GLR_FUNCS(GLR_DEFINE)
#undef GLR_DEFINE
#endif

#define G(name) GLR_FN(name)

#define VRAM_BYTES 0x18000
#define VRAM_TEX_W 256
#define VRAM_TEX_H (VRAM_BYTES / VRAM_TEX_W)
#define MAP_TEX_W 1024

static int sReady;
static int sEs;
static char sDesc[256];

static GLuint sProgObj, sProgComp, sProgHud;
static GLuint sVaoObj, sVaoEmpty, sInstBuf;
static GLuint sTexVram, sTexPal, sTexLines, sTexMap;
static GLuint sTexObj, sTexObjWin, sTexComp;
static GLuint sFboObj, sFboObjWin, sFboComp;
static int sFboW, sFboH;

static u8 sVramShadow[VRAM_BYTES];
static int sVramValid;

static u16 *sMapShadow;
static int sMapRows;            /* allocated texture rows                      */
static int sMapBase[4];         /* linear entry index of each layer's map     */
static u32 sMapGen[4];
static const u16 *sMapPtr[4];
static int sMapLen[4];
static int sMaxTex = 2048;

static s32 *sInst;
static int sInstCap;
#define INST_INTS 16            /* per sprite instance: aA aB aC aD           */
#define INST_BYTES (INST_INTS * 4)

static int sLastW = 240, sLastH = 160;
static int sLastDst[4];

/* The HUD layer.  Atlas slot r holds HUD region r at HUD coordinates plus
 * (HudOrgX(r), HudOrgY(r)); four slots a row, two rows (RL_MAX_HUD_REGIONS). */
#define HUD_W 240
#define HUD_H 160
#define HUD_GUTTER 32
#define HUD_SLOT_W (HUD_W + 2 * HUD_GUTTER)
#define HUD_SLOT_H (HUD_H + 2 * HUD_GUTTER)
#define HUD_ATLAS_W (4 * HUD_SLOT_W)
#define HUD_ATLAS_H (2 * HUD_SLOT_H)
#define HudOrgX(r) (((r) & 3) * HUD_SLOT_W + HUD_GUTTER)
#define HudOrgY(r) (((r) >> 2) * HUD_SLOT_H + HUD_GUTTER)
static int sHudWant, sHudActive, sHudNum;
static RlHudRegion sHudReg[RL_MAX_HUD_REGIONS];
static GLuint sTexObjHud, sFboObjHud, sTexHud, sFboHud;
static GLint uHPass, uHSel, uHOrg, uBDst, uBSrc, uBSharp, uBScale, uBTexSize;

/* The host-driven present (GlrPresentRect): the source is either the
 * composite or an uploaded picture (the PPU's framebuffer, so the PPU path can
 * share the GL window with the settings menu), and sharp-bilinear goes through
 * an integer-prescaled intermediate. */
static GLuint sTexPic, sFboPic, sTexMid, sFboMid;
static int sPicW, sPicH, sMidW, sMidH;
static int sSrcPic;

/* Uniform locations. */
static GLint uObjView, uObjWinPass, uObjK;
static GLint uCSub;
static GLint uCView, uCContent, uCLayer, uCValid, uCMapGeom, uCMapScroll,
             uCNumHud, uCHudRect, uCHudD;
static GLint uCLight, uCLightGeom, uCLightK, uCLights, uCNumLights, uCLightP, uCLightMode,
             uCLightMix, uCSunSide, uCCharShP, uCLightCol, uCLamp;
static GLint uCEnvLift, uCEnvShade, uCEnvHalo, uCEnvSpec;
static GLuint sTexLight;
static int sLightW, sLightH;
static u32 sLightGen;
static const u8 *sLightPtr;

/* Relief (relief_glsl.h): the sprite pass's normal target, the atlas the
 * art is drawn into and the passes' targets, the same size.  Texture units:
 * 7 the normal atlas, 8 the sprite normals, 9 and 10 the passes' inputs. */
#define UNIT_NRM 7
#define UNIT_OBJN 8
#define UNIT_IN 9
#define UNIT_ALB 10
#define UNIT_ALB_VIEW 11             /* the art, for ?normals=2 only          */
#define UNIT_CHARSH 12               /* character shadows                     */
static GLuint sProgCharSh, sTexCharSh, sFboCharSh;
static GLint uSObjG, uSCell, uSMode, uSSunA, uSNumL, uSLv, uSDisc, uSReach, uSOccG, uSViewW, uSGroundD;
#define UNIT_OCC 13
static GLuint sTexOcc;
/* Radiance cascades (rc_glsl.h): two targets the cascades take turns in,
 * cascade 0 ending in sTexRc[0], which the composite reads on UNIT_RC. */
#define UNIT_RC 14
#define UNIT_RC_UP 15
static GLuint sProgRc, sTexRc[2], sFboRc[2];
static int sRcW, sRcH, sRcOn, sRcN[2], sRcTried;
static float sRcOrg[2], sRcLo[3], sRcHi[3], sRcInv[3];
static GLint uROccG, uRObjG, uRObjW, uROrg, uRP0, uRS0E0, uRCasc, uRGround, uRNumL,
             uRLp, uRLc, uRSky, uRSun, uRSunP, uRAmb;
static GLint uCRcOn, uCRcGeom, uCRcN, uCRcLo, uCRcHi, uCRcInv;
static GLint uRPrevG, uRPrevS;
/* The last composite, for the cascades' bounce: its view's top-left in
 * the world, scale and size; 0 sPrevOk if it was not a lit world frame. */
static int sPrevOk, sPrevK, sPrevW, sPrevH;
static float sPrevWx, sPrevWy;
static int sOccW, sOccH;
static u32 sOccGen = 0xFFFFFFFFu;
static int sCharShW, sCharShH, sCharShOn;
static GLuint sTexObjN;
static GLuint sProgObjDec, sProgRel[5];
static GLint uRelSize[5], uRelSprY0[5], uRelGenS[5], uRelGenB[5], uDecView, uDecK, uDecWin;
/* The crate's strengths (shape, detail, normal, -).  Sprites take less of
 * their painted shading as relief (detail 2, not the crate's 6): the game's
 * sprites are shaded already, and lighting that shading again turned a small
 * one chalky on top and muddy below.  Background layers (off by default:
 * Settings > Lighting > relief on backgrounds) flatter still -- at the
 * crate's defaults every cloud and pillar became a blurred grey pillow. */
static const float kReliefGenBg[4] = { 0.6f, 2.0f, 1.0f, 0.0f };
static const float kReliefGenSpr[4] = { 1.15f, 2.0f, 1.5f, 0.0f };
/* The composite's response (ambient, darkest, brightest, keep hue): sprites
 * within 0.72..1.25 of their own colours and never clipped to white;
 * background layers within 0.8..1.15.  tools/relief_check/tune.html compares
 * settings on real sprites. */
static const float kReliefRespSpr[4] = { 0.5f, 0.72f, 1.25f, 1.0f };
static const float kReliefRespBg[4] = { 0.5f, 0.8f, 1.15f, 1.0f };
static GLint uCDecode, uCNrm, uCNrmOff, uCRelief, uCSunDir, uCNrmView, uCSprY0, uCRespS, uCRespB;
static GLuint sTexAlb, sTexT1, sTexT2, sTexT3, sTexT4, sTexNrm;
static GLuint sFboAlb, sFboT1, sFboT2, sFboT3, sFboT4, sFboNrm;
static int sRelTexW, sRelTexH;   /* allocated                                */
static int sRelOk;               /* the passes compiled                      */
static int sRelOn;               /* this frame has normals                   */
static int sRelW, sRelH;         /* this frame's part of the atlas           */
static int sRelSprY0;            /* sprites from this row down               */
static GLint sNrmOff[16];        /* uNrmOff                                  */
static int sRelBg[4][4];         /* per BG: atlas x y w h, w 0 none          */
static s32 sSprSlot[RL_MAX_SPRITES][2];
static u8 sSprHas[RL_MAX_SPRITES];
static s32 *sDecInst;
static int sDecN, sDecCap;

/* --- shaders ------------------------------------------------------------- */

static const char *kCommon =
    "precision highp float;\n"
    "precision highp int;\n"
    "precision highp usampler2D;\n"
    "precision highp isampler2D;\n"
    "uniform usampler2D uVram;\n"
    "uniform usampler2D uPal;\n"
    "int vb(int a) { return int(texelFetch(uVram, ivec2(a & 255, a >> 8), 0).r); }\n"
    "int pal(int i) { return int(texelFetch(uPal, ivec2(i, 0), 0).r); }\n";

static const char *kObjVs =
    "layout(location = 0) in ivec4 aA;\n"   /* x y (view, 1/256 px) boxW boxH */
    "layout(location = 1) in ivec4 aB;\n"   /* w h tile flags            */
    "layout(location = 2) in ivec4 aC;\n"   /* pa pb pc pd               */
    "layout(location = 3) in ivec4 aD;\n"   /* relief atlas x y, has, -  */
    "uniform ivec2 uViewSize;\n"            /* the target, pixels         */
    "uniform int uK;\n"                     /* target pixels per game px  */
    "flat out ivec4 vA;\n"
    "flat out ivec4 vB;\n"
    "flat out ivec4 vC;\n"
    "flat out ivec4 vD;\n"
    "void main() {\n"
    "  int c = gl_VertexID;\n"
    "  vec2 corner = vec2(float(c & 1), float(c >> 1));\n"
    /* The box in target pixels, a pixel larger all round: the fragment
     * shader decides which pixels it really covers. */
    "  vec2 lo = vec2(aA.xy) / 256.0 * float(uK) - 1.0;\n"
    "  vec2 hi = (vec2(aA.xy) / 256.0 + vec2(aA.zw)) * float(uK) + 1.0;\n"
    "  vec2 p = mix(floor(lo), ceil(hi), corner);\n"
    "  gl_Position = vec4(p / vec2(uViewSize) * 2.0 - 1.0, 0.0, 1.0);\n"
    "  vA = aA; vB = aB; vC = aC; vD = aD;\n"
    "}\n";

/* flags: 0-3 palette bank, 4 8bpp, 5 hflip, 6 vflip, 7 affine, 8-9
 * priority, 10 semi-transparent, 12 1D mapping.
 *
 * Two programs from this source.  The sprite pass: the colour target, and a
 * second, RGBA8 one with the sprite's normal (relief_glsl.h), or a flat
 * normal with alpha 0 where it has none.  With RELIEF_DECODE: the sprite's
 * own colours, opaque, into the relief atlas, drawn there as on screen
 * (PlanRelief places it in its group's picture). */
static const char *kObjFs =
    "flat in ivec4 vA;\n"
    "flat in ivec4 vB;\n"
    "flat in ivec4 vC;\n"
    "flat in ivec4 vD;\n"
    "uniform int uWinPass;\n"
    "uniform int uK;\n"
    "#ifdef RELIEF_DECODE\n"
    "out vec4 oAlb;\n"
    "#else\n"
    "precision highp sampler2D;\n"
    "uniform sampler2D uNrmAtlas;\n"
    "layout(location = 0) out uvec4 oObj;\n"
    "layout(location = 1) out vec4 oNrm;\n"
    "#endif\n"
    "void main() {\n"
    /* This pixel's centre in view coordinates, 1/256 px, and the sprite
     * texel under it. */
    "  ivec2 c = ((ivec2(gl_FragCoord.xy) * 2 + 1) * 128) / uK;\n"
    "  ivec2 q = (c - vA.xy) >> 8;\n"
    "  if (q.x < 0 || q.y < 0 || q.x >= vA.z || q.y >= vA.w) discard;\n"
    "  int px = q.x, row = q.y;\n"
    "  int w = vB.x, h = vB.y, tile = vB.z, fl = vB.w;\n"
    "  bool is256 = (fl & 16) != 0;\n"
    "  int texX, texY;\n"
    "  if ((fl & 128) != 0) {\n"
    "    int dx = px - vA.z / 2, dy = row - vA.w / 2;\n"
    "    texX = ((vC.x * dx + vC.y * dy) >> 8) + w / 2;\n"
    "    texY = ((vC.z * dx + vC.w * dy) >> 8) + h / 2;\n"
    "  } else {\n"
    "    texX = (fl & 32) != 0 ? w - 1 - px : px;\n"
    "    texY = (fl & 64) != 0 ? h - 1 - row : row;\n"
    "  }\n"
    "  if (texX < 0 || texY < 0 || texX >= w || texY >= h) discard;\n"
    "  int m = is256 ? 2 : 1;\n"
    "  int ti = (fl & 4096) != 0 ? tile + (texY / 8) * (w / 8) * m + (texX / 8) * m\n"
    "                            : tile + (texY / 8) * 32 + (texX / 8) * m;\n"
    "  int col;\n"
    "  if (is256) {\n"
    "    int off = 0x10000 + ((ti & ~1) >> 1) * 64 + (texY & 7) * 8 + (texX & 7);\n"
    "    if (off >= 0x18000) discard;\n"
    "    int idx = vb(off);\n"
    "    if (idx == 0) discard;\n"
    "    col = pal(256 + idx);\n"
    "  } else {\n"
    "    int off = 0x10000 + ti * 32 + (texY & 7) * 4 + ((texX & 7) >> 1);\n"
    "    if (off >= 0x18000) discard;\n"
    "    int idx = vb(off);\n"
    "    idx = (texX & 1) != 0 ? (idx >> 4) : (idx & 15);\n"
    "    if (idx == 0) discard;\n"
    "    col = pal(256 + (((fl & 15) * 16 + idx) & 255));\n"
    "  }\n"
    "#ifdef RELIEF_DECODE\n"
    "  int r = col & 31, g = (col >> 5) & 31, b = (col >> 10) & 31;\n"
    "  oAlb = vec4(vec3(float((r << 3) | (r >> 2)), float((g << 3) | (g >> 2)),\n"
    "                   float((b << 3) | (b >> 2))) / 255.0, 1.0);\n"
    "#else\n"
    "  oNrm = vec4(0.5, 0.5, 1.0, 0.0);\n"
    "  if (uWinPass != 0) { oObj = uvec4(1u); return; }\n"
    "  oObj = uvec4(uint(col & 255), uint(col >> 8),\n"
    "               uint(((fl >> 8) & 3) | (((fl >> 10) & 1) << 2) | 8 | (((fl >> 13) & 1) << 4)), 0u);\n"
    "  if (vD.z != 0)\n"
    /* The map is of the sprite's group as drawn: the box pixel's normal is
     * already the screen's. */
    "    oNrm = vec4(texelFetch(uNrmAtlas, vD.xy + q, 0).xyz, 1.0);\n"
    "#endif\n"
    "}\n";

/* Character shadows: the level's sun shadows (light.c BuildSun / Visible) with
 * the sprites as the occluders, every frame, at one texel per CHARSH_CELL view
 * pixels.  From each texel five rays across the sun's disc (or three across
 * each point light's) are marched towards it through the sprite pass's target
 * (opaque, not HUD); a blocked ray counts less the further away its sprite
 * is, so a shadow is darkest at the feet and its edge widens with distance. */
#define CHARSH_CELL 2
/* The point lights' arrays and loops in the shaders, sized from RL_MAX_LIGHTS
 * so the two cannot drift apart (RELIEF_STR: relief_glsl.h). */
#define NLIGHTS_STR RELIEF_STR(RL_MAX_LIGHTS)
static const char *kCharShFs =
    "precision highp sampler2D;\n"
    "uniform highp usampler2D uObjT;\n"
    "uniform ivec3 uObjG;\n"         /* target w, h; k                    */
    "uniform float uCell;\n"
    "uniform int uMode;\n"           /* 0 sun, 1 point lights             */
    "uniform vec2 uSunA;\n"          /* angle left of overhead, disc (rad) */
    "uniform int uNumL;\n"
    "uniform vec2 uLv[" NLIGHTS_STR "];\n" /* the lights, view px          */
    "uniform float uDisc;\n"         /* a point light's half size, px     */
    "uniform float uReach;\n"        /* how far a shadow reaches, px      */
    "uniform highp usampler2D uOccT;\n" /* the room's collision cells (light.c) */
    "uniform ivec2 uOccG;\n"         /* cells w, h                        */
    "uniform vec2 uViewW;\n"         /* the view's top-left in the world   */
    "uniform float uGroundD;\n"      /* shadow into solid ground, px      */
    "out vec4 oS;\n"
    "#define STEP 2.0\n"
    "#define NSTEP 80\n"             /* 160 px at most                    */
    "bool occ(vec2 vp) {\n"
    "  ivec2 q = ivec2(floor(vp * float(uObjG.z)));\n"
    "  if (q.x < 0 || q.y < 0 || q.x >= uObjG.x || q.y >= uObjG.y) return false;\n"
    "  uint b = texelFetch(uObjT, q, 0).b;\n"
    "  return (b & 8u) != 0u && (b & 16u) == 0u;\n"
    "}\n"
    /* light.c Occ: solid, or the top 4 px of a jump-through platform. */
    "bool solid(vec2 vp) {\n"
    "  vec2 w = vp + uViewW;\n"
    "  ivec2 c = ivec2(floor(w / 16.0));\n"
    "  if (w.x < 0.0 || w.y < 0.0 || c.x >= uOccG.x || c.y >= uOccG.y) return false;\n"
    "  uint o = texelFetch(uOccT, c, 0).r;\n"
    "  return o == 1u || (o == 2u && w.y - float(c.y) * 16.0 < 4.0);\n"
    "}\n"
    /* One ray from p (d: a STEP long) out to lim px: what a sprite on it
     * casts here.  From inside solid ground it counts only if it leaves the
     * ground within uGroundD -- deeper, the ground is in the way. */
    "float ray(vec2 p, vec2 d, float lim) {\n"
    "  bool ground = solid(p);\n"
    "  for (int s = 1; s <= NSTEP; s++) {\n"
    "    float t = float(s) * STEP;\n"
    "    if (t > lim) break;\n"
    "    vec2 q = p + d * float(s);\n"
    "    if (ground) {\n"
    "      if (!solid(q)) ground = false;\n"
    "      else if (t > uGroundD) return 0.0;\n"
    "    }\n"
    "    if (occ(q)) return 1.0 - 0.9 * t / uReach;\n"
    "  }\n"
    "  return 0.0;\n"
    "}\n"
    "void main() {\n"
    "  vec2 p = gl_FragCoord.xy * uCell;\n"
    "  float sh = 0.0;\n"
    "  if (uMode == 0) {\n"
    "    for (int r = 0; r < 5; r++) {\n"
    "      float a = uSunA.x + uSunA.y * (float(r) / 4.0 - 0.5);\n"
    "      sh += ray(p, vec2(-sin(a), -cos(a)) * STEP, uReach);\n"   /* towards the sun */
    "    }\n"
    "    sh /= 5.0;\n"
    "  } else {\n"
    "    for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "      if (i >= uNumL) break;\n"
    "      vec2 L = uLv[i] - p;\n"
    "      float dist = length(L), b = 0.0;\n"
    "      if (dist < 1.0 || dist > 560.0) continue;\n"
    "      vec2 nrm = vec2(-L.y, L.x) / dist;\n"
    "      for (int r = 0; r < 3; r++) {\n"
    "        b += ray(p, normalize(uLv[i] + nrm * uDisc * float(r - 1) - p) * STEP, min(dist, uReach));\n"
    "      }\n"
    "      sh = max(sh, b / 3.0 * clamp((560.0 - dist) / 160.0, 0.0, 1.0));\n"
    "    }\n"
    "  }\n"
    "  oS = vec4(sh, 0.0, 0.0, 1.0);\n"
    "}\n";

static const char *kCompVs =
    "void main() {\n"
    "  vec2 p = vec2(float((gl_VertexID & 1) * 4) - 1.0, float((gl_VertexID & 2) * 2) - 1.0);\n"
    "  gl_Position = vec4(p, 0.0, 1.0);\n"
    "}\n";

static const char *kCompFs =
    "uniform isampler2D uLines;\n"
    "uniform usampler2D uObj;\n"
    "uniform usampler2D uObjWin;\n"
    "uniform usampler2D uMap;\n"
    "uniform ivec4 uView;\n"          /* viewX viewY viewW viewH (screen) */
    "uniform ivec4 uSub;\n"           /* viewSubX viewSubY k -            */
    "uniform ivec4 uContent;\n"       /* l t r b (screen)                */
    "uniform ivec4 uLayer[4];\n"      /* space, flags, shiftX, shiftY (1/256 px) */
    "uniform ivec4 uValid[4];\n"      /* l r t b                         */
    "uniform ivec4 uMapGeom[4];\n"    /* w h base -                      */
    "uniform ivec4 uMapScroll[4];\n"  /* scrollX scrollY offX offY       */
    "uniform int uNumHud;\n"
    "uniform ivec4 uHudRect[8];\n"
    "uniform ivec2 uHudD[8];\n"
    "uniform int uHudPass;\n"        /* 0 HUD in the view, 1 world only, 2 HUD only */
    "uniform int uHudSel;\n"         /* HUD pass: the region                */
    "uniform ivec2 uHudOrg;\n"       /* HUD pass: atlas = HUD coords + this */
    "uniform int uLight;\n"          /* sunlight: BG mask it tints, 0 off   */
    "uniform ivec4 uLightGeom;\n"    /* camX camY mapW mapH (texels)       */
    "uniform sampler2D uShadow;\n"
    "uniform float uLightK;\n"      /* strength                            */
    "uniform vec2 uLights[" NLIGHTS_STR "];\n" /* the lights, world px (their halo) */
    "uniform int uNumLights;\n"
    "uniform vec4 uLightP;\n"       /* shadow darkness, warmth, cool, glow */
    "uniform int uLightMode;\n"     /* 0 sun, 1 point lights              */
    "uniform float uLightMix;\n"    /* the map's previous (rg) -> current (ba) */
    "uniform float uSunSide;\n"     /* -1 sun on the right .. 1 on the left  */
    /* The environment's colours (RlFrame.env*, light.c, per area). */
    "uniform vec3 uLightCol[" NLIGHTS_STR "];\n" /* each lamp's colour (point-lit rooms) */
    "uniform vec2 uLamp;\n"         /* lamp range px, indoor shade          */
    "uniform vec3 uEnvLift;\n"     /* lit areas: x warmth                 */
    "uniform vec3 uEnvShade;\n"    /* shade's tint at full coolness       */
    "uniform vec3 uEnvHalo;\n"     /* the point lights' glow              */
    "uniform vec3 uEnvSpec;\n"     /* relief highlights                   */
    /* Character shadows (RunCharShadow): one texel per CHARSH_CELL view px. */
    "uniform highp sampler2D uCharSh;\n"
    "uniform vec4 uCharShP;\n"      /* strength, cell px, texture w, h      */
    /* Radiance cascades (rc_glsl.h): cascade 0, and how its light makes
     * the picture darker or lighter: Lo with none, Hi under the open sky. */
    "uniform highp usampler2D uRcT;\n"
    "uniform int uRcOn;\n"
    "uniform vec4 uRcGeom;\n"       /* probe grid top-left (world px), spacing */
    "uniform ivec2 uRcN;\n"         /* its probes                           */
    "uniform vec3 uRcLo;\n"
    "uniform vec3 uRcHi;\n"
    "uniform vec3 uRcInv;\n"        /* 1 / the open sky's light            */
    "vec3 rcAt(ivec2 t) {\n"
    "  uvec2 u = texelFetch(uRcT, t, 0).rg;\n"
    "  return vec3(unpackHalf2x16(u.x), unpackHalf2x16(u.y).x);\n"
    "}\n"
    /* Relief (relief_glsl.h): normal maps for the lighting.  uDecode.x >= 0:
     * this draw is not the composite but BG uDecode.x's colours into the
     * relief atlas, at atlas = layer coords + uNrmOff[bg].xy. */
    "uniform ivec4 uDecode;\n"
    "uniform int uNrm;\n"
    "uniform ivec4 uNrmOff[4];\n"   /* atlas - layer coords, has, -       */
    "uniform highp sampler2D uNrmAtlas;\n"
    "uniform highp sampler2D uObjN;\n"
    "uniform vec4 uRelief;\n"      /* strength, shine, -, light z        */
    "uniform vec3 uSunDir;\n"      /* towards the sun, +y up             */
    /* The response, per kind of pixel: ambient, darkest, brightest factor,
     * 1 = brighten without leaving the colour's hue (no clipping to white). */
    "uniform vec4 uRespS;\n"       /* sprites                            */
    "uniform vec4 uRespB;\n"       /* background layers                  */
    "uniform int uNrmView;\n"      /* 1 the normals; 2, 3 the atlas's sprite art, normals; 4 shadow */
    "uniform highp sampler2D uAlbAtlas;\n"
    "uniform int uSprY0;\n"        /* the atlas's first sprite row       */
    "out vec4 oColor;\n"
    "int L(int line, int w) {\n"
    "  ivec4 t = texelFetch(uLines, ivec2(w >> 2, line), 0);\n"
    "  int c = w & 3;\n"
    "  return c == 0 ? t.x : c == 1 ? t.y : c == 2 ? t.z : t.w;\n"
    "}\n"
    "int imod(int a, int b) { int r = a - (a / b) * b; return r < 0 ? r + b : r; }\n"
    "int mapEntry(int bg, int idx) {\n"
    "  int a = uMapGeom[bg].z + idx;\n"
    "  return int(texelFetch(uMap, ivec2(a & 1023, a >> 10), 0).r);\n"
    "}\n"
    "int sampleText(int bg, int x, int y, int rl) {\n"
    "  int cnt = L(rl, 27 + bg);\n"
    "  int charBase = ((cnt >> 2) & 3) * 0x4000;\n"
    "  int screenBase = ((cnt >> 8) & 31) * 0x800;\n"
    "  bool is256 = (cnt & 0x80) != 0;\n"
    "  int size = (cnt >> 14) & 3;\n"
    "  int wT = (size & 1) != 0 ? 64 : 32;\n"
    "  int hT = (size & 2) != 0 ? 64 : 32;\n"
    "  int hofs = L(rl, bg * 2), vofs = L(rl, bg * 2 + 1);\n"
    "  if ((cnt & 0x40) != 0) {\n"
    "    int mv = ((L(rl, 26) >> 4) & 15) + 1;\n"
    "    y = y - imod(y, mv);\n"
    "  }\n"
    "  int sy = (y + vofs) & (hT * 8 - 1);\n"
    "  int sx = (x + hofs) & (wT * 8 - 1);\n"
    "  int entry;\n"
    "  bool outside = false;\n"
    "  int st = uLayer[bg].y;\n"      /* 1 map, 2 window only, 4 wrapX, 8 mirrorY, 16 mirrorX, 32 picture */
    "  if ((st & 32) != 0) {\n"      /* a picture smaller than its block: mirror at its edges */
    "    int W = uMapGeom[bg].x, H = uMapGeom[bg].y;\n"
    "    if (W > 0) { sx = imod(x + hofs, 2 * W); if (sx >= W) sx = 2 * W - 1 - sx; }\n"
    "    if (H > 0) { sy = imod(y + vofs, 2 * H); if (sy >= H) sy = 2 * H - 1 - sy; }\n"
    "    st = 0;\n"
    "  }\n"
    "  if (st != 0)\n"
    "    outside = x < uValid[bg].x || x >= uValid[bg].y || y < uValid[bg].z || y >= uValid[bg].w;\n"
    /* mirrored: VRAM's columns past the picture's end are bg.c's wrapped copy */
    "  if ((st & 17) == 17 && !outside) {\n"
    "    int lx0 = uMapScroll[bg].z * 8 + uMapScroll[bg].x + x;\n"
    "    outside = lx0 < 0 || lx0 >= uMapGeom[bg].x * 8;\n"
    "  }\n"
    "  int px = sx & 7, py = sy & 7;\n"
    "  if (outside) {\n"
    "    if ((st & 1) == 0) return -1;\n"
    "    int W = uMapGeom[bg].x * 8, H = uMapGeom[bg].y * 8;\n"
    "    int lx = uMapScroll[bg].z * 8 + uMapScroll[bg].x + x;\n"
    "    int ly = uMapScroll[bg].w * 8 + uMapScroll[bg].y + y;\n"
    "    if ((st & 16) != 0) { lx = imod(lx, 2 * W); if (lx >= W) lx = 2 * W - 1 - lx; }\n"
    "    else if ((st & 4) != 0) lx = imod(lx, W);\n"
    "    if ((st & 8) != 0) { ly = imod(ly, 2 * H); if (ly >= H) ly = 2 * H - 1 - ly; }\n"
    "    if (lx < 0 || ly < 0 || lx >= W || ly >= H) return -1;\n"
    "    entry = mapEntry(bg, (ly >> 3) * uMapGeom[bg].x + (lx >> 3));\n"
    "    px = lx & 7; py = ly & 7;\n"
    "  } else {\n"
    "    int tx = sx >> 3, ty = sy >> 3;\n"
    "    int mo = screenBase;\n"
    "    if (tx >= 32) { mo += 0x800; tx -= 32; }\n"
    "    if (ty >= 32) { mo += wT > 32 ? 0x1000 : 0x800; ty -= 32; }\n"
    "    mo += (ty * 32 + tx) * 2;\n"
    "    if (mo + 1 >= 0x18000) return -1;\n"
    "    entry = vb(mo) | (vb(mo + 1) << 8);\n"
    "  }\n"
    "  int tile = entry & 0x3FF;\n"
    "  if ((entry & 0x400) != 0) px = 7 - px;\n"
    "  if ((entry & 0x800) != 0) py = 7 - py;\n"
    "  if (is256) {\n"
    "    int off = charBase + tile * 64 + py * 8 + px;\n"
    "    if (off >= 0x18000) return -1;\n"
    "    int idx = vb(off);\n"
    "    return idx == 0 ? -1 : pal(idx);\n"
    "  }\n"
    "  int off = charBase + tile * 32 + py * 4 + (px >> 1);\n"
    "  if (off >= 0x18000) return -1;\n"
    "  int idx = vb(off);\n"
    "  idx = (px & 1) != 0 ? (idx >> 4) : (idx & 15);\n"
    "  if (idx == 0) return -1;\n"
    "  return pal((((entry >> 12) & 15) * 16 + idx) & 255);\n"
    "}\n"
    "int sampleAffine(int bg, int x, int y, int rl) {\n"
    "  int cnt = L(rl, 27 + bg);\n"
    "  int b = bg == 2 ? 8 : 12;\n"
    "  int cx = L(rl, b), cy = L(rl, b + 1), pa = L(rl, b + 2), pc = L(rl, b + 3);\n"
    "  cx += L(rl, 32 + (bg - 2) * 2) * (y - rl);\n"
    "  cy += L(rl, 33 + (bg - 2) * 2) * (y - rl);\n"
    "  int charBase = ((cnt >> 2) & 3) * 0x4000;\n"
    "  int screenBase = ((cnt >> 8) & 31) * 0x800;\n"
    "  int sizeTiles = 16 << ((cnt >> 14) & 3);\n"
    "  int sizePx = sizeTiles * 8;\n"
    "  int tx = (cx + pa * x) >> 8, ty = (cy + pc * x) >> 8;\n"
    "  if ((cnt & 0x2000) != 0) { tx &= sizePx - 1; ty &= sizePx - 1; }\n"
    "  else if (tx < 0 || ty < 0 || tx >= sizePx || ty >= sizePx) return -1;\n"
    "  int mo = screenBase + (ty >> 3) * sizeTiles + (tx >> 3);\n"
    "  if (mo >= 0x18000) return -1;\n"
    "  int tile = vb(mo);\n"
    "  int off = charBase + tile * 64 + (ty & 7) * 8 + (tx & 7);\n"
    "  if (off >= 0x18000) return -1;\n"
    "  int idx = vb(off);\n"
    "  return idx == 0 ? -1 : pal(idx);\n"
    "}\n"
    "int windowControl(int sx, int sy, int rl, int dispcnt, bool objwin) {\n"
    "  if ((dispcnt & 0xE000) == 0) return 0x3F;\n"
    "  int winin = L(rl, 24), winout = L(rl, 25);\n"
    "  for (int w = 0; w < 2; w++) {\n"
    "    if ((dispcnt & (0x2000 << w)) == 0) continue;\n"
    "    int h = L(rl, 20 + w), v = L(rl, 22 + w);\n"
    "    int left = h >> 8, right = h & 255, top = v >> 8, bottom = v & 255;\n"
    "    if (right > 240 || right < left) right = 240;\n"
    "    if (bottom > 160 || bottom < top) bottom = 160;\n"
    "    if (left <= 0) left = uView.x;\n"
    "    if (right >= 240) right = uView.x + uView.z + (uSub.x != 0 ? 1 : 0);\n"
    "    if (top <= 0) top = uView.y;\n"
    "    if (bottom >= 160) bottom = uView.y + uView.w + (uSub.y != 0 ? 1 : 0);\n"
    "    if (sx >= left && sx < right && sy >= top && sy < bottom)\n"
    "      return (winin >> (w * 8)) & 0x3F;\n"
    "  }\n"
    "  if ((dispcnt & 0x8000) != 0 && objwin) return (winout >> 8) & 0x3F;\n"
    "  return winout & 0x3F;\n"
    "}\n"
    "int blendAlpha(int a, int b, int eva, int evb) {\n"
    "  int r = min(((a & 31) * eva + (b & 31) * evb) >> 4, 31);\n"
    "  int g = min((((a >> 5) & 31) * eva + ((b >> 5) & 31) * evb) >> 4, 31);\n"
    "  int bl = min((((a >> 10) & 31) * eva + ((b >> 10) & 31) * evb) >> 4, 31);\n"
    "  return r | (g << 5) | (bl << 10);\n"
    "}\n"
    "int bright(int c, int evy, bool up) {\n"
    "  int r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;\n"
    "  if (up) { r += ((31 - r) * evy) >> 4; g += ((31 - g) * evy) >> 4; b += ((31 - b) * evy) >> 4; }\n"
    "  else { r -= (r * evy) >> 4; g -= (g * evy) >> 4; b -= (b * evy) >> 4; }\n"
    "  return r | (g << 5) | (b << 10);\n"
    "}\n"
    "vec4 toRgba(int c) {\n"
    "  int r = c & 31, g = (c >> 5) & 31, b = (c >> 10) & 31;\n"
    "  r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2);\n"
    "  return vec4(float(r), float(g), float(b), 255.0) / 255.0;\n"
    "}\n"
    "void main() {\n"
    "  if (uDecode.x >= 0) {\n"
    "    int bg = uDecode.x;\n"
    "    ivec2 t = ivec2(gl_FragCoord.xy) - uNrmOff[bg].xy;\n"
    "    int rl = clamp(t.y - (uLayer[bg].w >> 8), 0, 159);\n"
    "    int md = L(rl, 16) & 7, c = -1;\n"
    "    if (md == 0 || (md == 1 && bg < 2)) c = sampleText(bg, t.x, t.y, rl);\n"
    "    else if ((md == 1 && bg == 2) || (md == 2 && bg >= 2)) c = sampleAffine(bg, t.x, t.y, rl);\n"
    "    oColor = c < 0 ? vec4(0.0) : vec4(toRgba(c).rgb, 1.0);\n"
    "    return;\n"
    "  }\n"
    /* h: the target pixel.  v: the view pixel it lies in (the HUD's grid).
     * b: its centre in SCREEN coordinates, 1/256 px -- the world's grid.
     * The HUD pass draws at k = 1 with no fraction (GlrDrawScaled). */
    "  ivec2 h = ivec2(gl_FragCoord.xy);\n"
    "  bool hudPass = uHudPass == 2;\n"
    "  ivec2 c = ((h * 2 + 1) * 128) / uSub.z;\n"
    "  ivec2 v = c >> 8;\n"
    "  ivec2 b = uView.xy * 256 + uSub.xy + c;\n"
    "  int sx = b.x >> 8, sy = b.y >> 8;\n"
    "  if (hudPass) { sx = v.x - uHudOrg.x; sy = v.y - uHudOrg.y; }\n"
    "  bool letterbox = !hudPass && (sx < uContent.x || sy < uContent.y || sx >= uContent.z || sy >= uContent.w);\n"
    "  int rl = clamp(sy, 0, 159);\n"
    "  int dispcnt = L(rl, 16);\n"
    "  if ((dispcnt & 0x80) != 0) { oColor = hudPass ? vec4(0.0) : vec4(1.0); return; }\n"
    "  int mode = dispcnt & 7;\n"
    "  int lc[4]; int lp[4]; ivec2 lxy[4];\n"
    "  for (int bg = 0; bg < 4; bg++) {\n"
    "    lc[bg] = -1;\n"
    "    lxy[bg] = ivec2(0);\n"
    "    lp[bg] = L(rl, 27 + bg) & 3;\n"
    "    if ((dispcnt & (0x100 << bg)) == 0) continue;\n"
    "    if (uLayer[bg].x < 0 || (letterbox && uLayer[bg].x != 2)) continue;\n"
    "    if (hudPass != (uLayer[bg].x == 2) && uHudPass != 0) continue;\n"
    "    int x = (b.x + uLayer[bg].z) >> 8, y = (b.y + uLayer[bg].w) >> 8;\n"
    "    if (hudPass) {\n"
    "      ivec4 R = uHudRect[uHudSel];\n"
    "      if (sx < R.x || sy < R.y || sx >= R.z || sy >= R.w) continue;\n"
    "      x = sx; y = sy;\n"
    "    } else if (uLayer[bg].x == 2) {\n"
    "      bool found = false;\n"
    "      for (int r = 0; r < 8; r++) {\n"
    "        if (r >= uNumHud) break;\n"
    "        int hx = v.x - uHudD[r].x, hy = v.y - uHudD[r].y;\n"
    "        if (hx >= uHudRect[r].x && hy >= uHudRect[r].y && hx < uHudRect[r].z && hy < uHudRect[r].w) {\n"
    "          x = hx; y = hy; found = true; break;\n"
    "        }\n"
    "      }\n"
    "      if (!found) continue;\n"
    "    }\n"
    "    lxy[bg] = ivec2(x, y);\n"
    "    if (mode == 0 || (mode == 1 && bg < 2)) lc[bg] = sampleText(bg, x, y, rl);\n"
    "    else if ((mode == 1 && bg == 2) || (mode == 2 && bg >= 2)) lc[bg] = sampleAffine(bg, x, y, rl);\n"
    "  }\n"
    "  bool objOn = (dispcnt & 0x1000) != 0;\n"
    "  uvec4 o = texelFetch(uObj, h, 0);\n"
    "  bool objOpq = objOn && (o.b & 8u) != 0u && (!letterbox || (o.b & 16u) != 0u);\n"
    "  int objPri = objOpq ? int(o.b & 3u) : 3;\n"
    "  bool semi = (o.b & 4u) != 0u;\n"
    "  int objCol = int(o.r) | (int(o.g) << 8);\n"
    "  bool objwin = !hudPass && objOn && texelFetch(uObjWin, h, 0).r != 0u;\n"
    "  int ctrl = windowControl(sx, sy, rl, dispcnt, objwin);\n"
    "  bool allowBlend = (ctrl & 0x20) != 0;\n"
    "  int bd = letterbox ? 0 : pal(0);\n"
    "  int top = -1, second = -1, topC = bd, secC = bd;\n"
    "  bool topBlend = true;\n"
    "  for (int p = 0; p < 4; p++) {\n"
    "    if (second >= 0) break;\n"
    "    for (int layer = 0; layer < 5; layer++) {\n"
    "      int idx = layer == 0 ? 4 : layer - 1;\n"
    "      int lpri = idx == 4 ? objPri : lp[idx];\n"
    "      bool opq = idx == 4 ? objOpq : lc[idx] >= 0;\n"
    "      if (lpri != p || !opq) continue;\n"
    "      if (((ctrl >> idx) & 1) == 0) continue;\n"
    "      int c = idx == 4 ? objCol : lc[idx];\n"
    "      if (top < 0) { top = idx; topC = c; topBlend = allowBlend; }\n"
    "      else { second = idx; secC = c; break; }\n"
    "    }\n"
    "  }\n"
    "  if (hudPass && top < 0) { oColor = vec4(0.0); return; }\n"
    "  int result = top < 0 ? bd : topC;\n"
    "  if (topBlend && top >= 0) {\n"
    "    int bldcnt = L(rl, 17), alpha = L(rl, 18), bldy = L(rl, 19);\n"
    "    int effect = (bldcnt >> 6) & 3;\n"
    "    int eva = min(alpha & 31, 16), evb = min((alpha >> 8) & 31, 16), evy = min(bldy & 31, 16);\n"
    "    int secBit = second < 0 ? 5 : second;\n"
    "    bool t1 = ((bldcnt >> top) & 1) != 0;\n"
    "    bool t2 = ((bldcnt >> (8 + secBit)) & 1) != 0;\n"
    /* HUD pass, nothing of the HUD under the top pixel: the second target is
     * the world, drawn elsewhere.  Blend with it if any world layer could be
     * one, as premultiplied colour + (1 - alpha) * world at present time. */
    "    bool under = hudPass && second < 0;\n"
    "    if (under) {\n"
    "      int hm = 0;\n"
    "      for (int b = 0; b < 4; b++) if (uLayer[b].x == 2) hm |= 1 << b;\n"
    "      t2 = (((bldcnt >> 8) & 0x3F) & ~hm) != 0;\n"
    "    }\n"
    "    bool alphaFx = (top == 4 && semi && t2) || (effect == 1 && t1 && t2);\n"
    "    if (alphaFx && under) {\n"
    "      oColor = vec4(toRgba(topC).rgb * float(eva) / 16.0, 1.0 - float(evb) / 16.0);\n"
    "      return;\n"
    "    }\n"
    "    if (alphaFx) result = blendAlpha(topC, secC, eva, evb);\n"
    "    else if (effect == 2 && t1) result = bright(topC, evy, true);\n"
    "    else if (effect == 3 && t1) result = bright(topC, evy, false);\n"
    "  }\n"
    /* Sunlight (light.c): the sun from the upper left, or point lights in
     * the room.  Every world layer and world sprite takes the shadow map's
     * shade and warmth (and the point lights' halo); never the HUD. */
    "  if (uNrm != 0 && (uNrmView == 2 || uNrmView == 3) && !hudPass) {\n"
    "    vec4 a = uNrmView == 2 ? texelFetch(uAlbAtlas, v + ivec2(0, uSprY0), 0)\n"
    "                           : texelFetch(uNrmAtlas, v + ivec2(0, uSprY0), 0);\n"
    "    oColor = a.a > 0.5 ? vec4(a.rgb, 1.0) : vec4(1.0, 0.0, 1.0, 1.0);\n"
    "    return;\n"
    "  }\n"
    "  if (uLight != 0 && !hudPass && !letterbox) {\n"
    "    vec2 wp = vec2(b) / 256.0 + vec2(uLightGeom.xy);\n"
    "    float K = uLightK;\n"
    "    vec3 col = toRgba(result).rgb;\n"
    "    bool hud = top == 4 ? (o.b & 16u) != 0u : (top >= 0 && uLayer[top].x == 2);\n"
    "    if (!hud && uRcOn != 0) {\n"
    /* Radiance cascades: cascade 0's four directions (45, 135, 225, 315
     * degrees, y down), bilinearly from the four probes around the pixel;
     * their sum over the open sky's sets the picture between Lo and Hi. */
    "      vec2 rf = (wp - uRcGeom.xy) / uRcGeom.z - 0.5;\n"
    "      ivec2 rq0 = ivec2(floor(rf));\n"
    "      vec2 rw = rf - vec2(rq0);\n"
    "      vec3 Lq0 = vec3(0.0), Lq1 = vec3(0.0), Lq2 = vec3(0.0), Lq3 = vec3(0.0);\n"
    "      for (int ck = 0; ck < 4; ck++) {\n"
    "        ivec2 rq = clamp(rq0 + ivec2(ck & 1, ck >> 1), ivec2(0), uRcN - 1) * 2;\n"
    "        float wq = ((ck & 1) != 0 ? rw.x : 1.0 - rw.x) * ((ck >> 1) != 0 ? rw.y : 1.0 - rw.y);\n"
    "        Lq0 += wq * rcAt(rq);\n"
    "        Lq1 += wq * rcAt(rq + ivec2(1, 0));\n"
    "        Lq2 += wq * rcAt(rq + ivec2(0, 1));\n"
    "        Lq3 += wq * rcAt(rq + ivec2(1, 1));\n"
    "      }\n"
    "      vec3 En = (Lq0 + Lq1 + Lq2 + Lq3) * 1.5707963 * uRcInv;\n"
    "      vec3 mult = min(uRcLo + (uRcHi - uRcLo) * En, vec3(1.8));\n"
    "      float plane = (top == 4 || (top >= 0 && ((uLight >> top) & 1) != 0)) ? 1.0 : 0.55;\n"
    "      if (uNrmView == 4) { oColor = vec4(min(mult * 0.6, vec3(1.0)), 1.0); return; }\n"
    "      vec3 lumW = vec3(0.30, 0.59, 0.11);\n"
    "      float lit = clamp(dot(En, lumW), 0.0, 1.0);\n"
    /* Relief: the four directions' light on the pixel's normal against on
     * a flat pixel; the highlight towards where most light comes from. */
    "      if (uNrm != 0) {\n"
    "        vec4 nt = vec4(0.0);\n"
    "        if (top == 4) nt = texelFetch(uObjN, h, 0);\n"
    "        else if (top >= 0 && uNrmOff[top].z != 0) nt = texelFetch(uNrmAtlas, lxy[top] + uNrmOff[top].xy, 0);\n"
    "        if (uNrmView == 1) { oColor = vec4(nt.a > 0.5 ? nt.rgb : vec3(0.15, 0.15, 0.3), 1.0); return; }\n"
    "        if (nt.a > 0.5) {\n"
    "          vec3 N = normalize(nt.xyz * 2.0 - 1.0);\n"
    "          float zl = uRelief.w;\n"
    "          vec3 o0 = normalize(vec3(0.7071, -0.7071, zl)), o1 = normalize(vec3(-0.7071, -0.7071, zl));\n"
    "          vec3 o2 = normalize(vec3(-0.7071, 0.7071, zl)), o3 = normalize(vec3(0.7071, 0.7071, zl));\n"
    "          float l0 = dot(Lq0, lumW), l1 = dot(Lq1, lumW), l2 = dot(Lq2, lumW), l3 = dot(Lq3, lumW);\n"
    "          float num = l0 * max(dot(N, o0), 0.0) + l1 * max(dot(N, o1), 0.0)\n"
    "                    + l2 * max(dot(N, o2), 0.0) + l3 * max(dot(N, o3), 0.0);\n"
    "          float den = (l0 + l1 + l2 + l3) * o0.z;\n"
    "          vec4 R = top == 4 ? uRespS : uRespB;\n"
    "          float ratio = den > 1e-5 ? num / den : 1.0;\n"
    "          float w = clamp(K * uRelief.x * lit * plane, 0.0, 2.0);\n"
    "          mult *= clamp(mix(1.0, R.x + (1.0 - R.x) * ratio, w), R.y, R.z);\n"
    "          vec3 Ld = o0 * l0 + o1 * l1 + o2 * l2 + o3 * l3;\n"
    "          Ld = length(Ld) > 1e-5 ? normalize(Ld) : vec3(0.0, 0.0, 1.0);\n"
    "          vec3 Hv = normalize(Ld + vec3(0.0, 0.0, 1.0));\n"
    "          float sp = max(pow(max(dot(N, Hv), 0.0), 20.0) - pow(Hv.z, 20.0), 0.0);\n"
    "          col += K * uRelief.y * lit * plane * sp * uEnvSpec;\n"
    "        }\n"
    "      }\n"
    "      col *= mix(vec3(1.0), mult, plane);\n"
    /* Brighter than the art: keep the hue, a little of the rest as white. */
    "      float mx = max(max(col.r, col.g), col.b);\n"
    "      if (mx > 1.0) col = col / mx + vec3((mx - 1.0) * 0.3);\n"
    "      if (uLightMode == 1) {\n"
    "        vec3 halo = vec3(0.0);\n"
    "        for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "          if (i >= uNumLights) break;\n"
    "          float d = length(wp - uLights[i]);\n"
    "          halo += (0.22 * exp(-d / 10.0) + 0.05 * exp(-d / 48.0)) * uLightCol[i];\n"
    "        }\n"
    "        col += K * uLightP.w * 0.5 * halo;\n"
    "        if (uNrmView == 5)\n"
    "          for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "            if (i >= uNumLights) break;\n"
    "            float d = length(wp - uLights[i]);\n"
    "            if (abs(d - 8.0) < 1.0) col = vec3(1.0, 0.0, 1.0);\n"
    "            else if (d < 3.0) col = uLightCol[i];\n"
    "          }\n"
    "      }\n"
    "    } else if (!hud) {\n"
    "      vec4 slq = texture(uShadow, wp / 8.0 / vec2(uLightGeom.zw));\n"
    "      vec2 sl = mix(slq.rg, slq.ba, uLightMix);\n"
    /* Point-lit (indoors): the room's lamps, where the art draws them, light
     * falling off with distance in each one's colour, no walls in the way;
     * away from them only Indoor shade of the shade. */
    "      vec3 lampC = uEnvLift;\n"
    "      if (uLightMode == 1) {\n"
    "        float la = 0.0;\n"
    "        vec3 lc = vec3(0.0);\n"
    "        for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "          if (i >= uNumLights) break;\n"
    "          float a = max(1.0 - length(uLights[i] - wp) / uLamp.x, 0.0);\n"
    "          la += a * a;\n"
    "          lc += a * a * uLightCol[i];\n"
    "        }\n"
    "        if (la > 1e-4) lampC = lc / la * 0.3 - 0.06;\n"
    "        la = min(la, 1.0);\n"
    "        sl = vec2(uLamp.y * clamp(1.0 - la * 1.6, 0.0, 1.0), la);\n"
    "      }\n"
    /* The characters' shadows join the level's: the darker of the two, so
     * they take its tint and darkness and never darken twice. */
    "      if (uCharShP.x > 0.0 && top >= 0 && top < 4) {\n"
    "        float cs = uCharShP.x * texture(uCharSh, (vec2(c) / 256.0) / (uCharShP.y * uCharShP.zw)).r;\n"
    "        sl = vec2(max(sl.r, cs), min(sl.g, 1.0 - cs));\n"
    "      }\n"
    "      if (uNrmView == 4) { oColor = vec4(col * 0.3 + vec3(1.0 - sl.r) * 0.7, 1.0); return; }\n"
    "      float lum = dot(col, vec3(0.30, 0.59, 0.11));\n"
    /* Shade: darker by uLightP.x, bluer by uLightP.z, at full shadow x K. */
    "      vec3 shadeC = (1.0 - uLightP.x) * mix(vec3(1.0), uEnvShade, uLightP.z);\n"
    /* The playfield (the room layer, sprites) takes the full shade; the
     * parallax art behind it, far off, 55% of it. */
    "      float plane = (top == 4 || (top >= 0 && ((uLight >> top) & 1) != 0)) ? 1.0 : 0.55;\n"
    /* Relief: the top pixel's normal (its sprite's, or its layer's) lit by
     * the sun or the room's lights, against what a flat pixel gets, so flat
     * art keeps its colours and only slopes change -- lit where they face
     * the light, darker where they turn away, with a small highlight.  None
     * of it in shade, where no direct light arrives. */
    "      if (uNrm != 0) {\n"
    "        vec4 nt = vec4(0.0);\n"
    "        if (top == 4) nt = texelFetch(uObjN, h, 0);\n"
    "        else if (top >= 0 && uNrmOff[top].z != 0) nt = texelFetch(uNrmAtlas, lxy[top] + uNrmOff[top].xy, 0);\n"
    "        if (uNrmView == 1) { oColor = vec4(nt.a > 0.5 ? nt.rgb : vec3(0.15, 0.15, 0.3), 1.0); return; }\n"
    "        if (nt.a > 0.5) {\n"
    "          vec3 N = normalize(nt.xyz * 2.0 - 1.0), Ld = uSunDir;\n"
    "          float lit = 1.0 - sl.r;\n"
    "          if (uLightMode == 1) {\n"
    "            vec3 acc = vec3(0.0);\n"
    "            for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "              if (i >= uNumLights) break;\n"
    "              vec2 d = uLights[i] - wp;\n"
    "              float att = max(1.0 - length(d) / uLamp.x, 0.0);\n"
    "              acc += att * att * normalize(vec3(d.x, -d.y, uRelief.w));\n"
    "            }\n"
    "            Ld = length(acc) > 1e-4 ? normalize(acc) : vec3(0.0, 0.0, 1.0);\n"
    "            lit = clamp(sl.g * 2.0, 0.0, 1.0);\n"
    "          }\n"
    "          vec4 R = top == 4 ? uRespS : uRespB;\n"
    "          float amb = R.x;\n"
    "          float d0 = amb + (1.0 - amb) * max(Ld.z, 0.0);\n"
    "          float d1 = amb + (1.0 - amb) * max(dot(N, Ld), 0.0);\n"
    "          float w = clamp(K * uRelief.x * lit * plane, 0.0, 2.0);\n"
    "          float fr = clamp(mix(1.0, d1 / max(d0, 1e-3), w), R.y, R.z);\n"
    "          vec3 c0 = col;\n"
    "          col = c0 * fr;\n"
    /* Brightening a saturated colour clips it towards white; stop where
     * its brightest channel is full, and let only a little of the rest
     * through as white. */
    "          if (R.w > 0.5 && fr > 1.0) {\n"
    "            float mc = max(max(c0.r, c0.g), c0.b), fe = min(fr, 1.0 / max(mc, 1e-3));\n"
    "            col = c0 * fe + (fr - fe) * mc * 0.3;\n"
    "          }\n"
    "          vec3 Hv = normalize(Ld + vec3(0.0, 0.0, 1.0));\n"
    "          float sp = max(pow(max(dot(N, Hv), 0.0), 20.0) - pow(Hv.z, 20.0), 0.0);\n"
    "          col += K * uRelief.y * lit * plane * sp * uEnvSpec;\n"
    "        }\n"
    "      }\n"
    "      col *= max(mix(vec3(1.0), shadeC, K * sl.r * plane), vec3(0.1));\n"
    /* Warmth where the light arrives.  Sun: fading from the upper left of
     * the view, and less on pale pixels so a white sky is not washed out. */
    "      float wl = K * sl.g * uLightP.y;\n"
    "      if (uLightMode == 0) {\n"
    "        vec2 sp = clamp(vec2(b) / 256.0 / vec2(240.0, 160.0), 0.0, 1.0);\n"
    "        float hx = 0.5 + (sp.x - 0.5) * uSunSide;\n"
    "        wl *= (0.35 + 0.65 * (1.0 - 0.5 * (hx + sp.y))) * (1.0 - 0.6 * lum);\n"
    "      }\n"
    "      col *= vec3(1.0) + wl * lampC;\n"
    "      if (uLightMode == 1) {\n"
    "        vec3 halo = vec3(0.0);\n"
    "        for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "          if (i >= uNumLights) break;\n"
    "          float d = length(wp - uLights[i]);\n"
    "          halo += (0.22 * exp(-d / 10.0) + 0.05 * exp(-d / 48.0)) * uLightCol[i];\n"
    "        }\n"
    "        col += K * uLightP.w * halo;\n"
    /* ?normals=5: each lamp ringed in magenta, its colour at the centre. */
    "        if (uNrmView == 5)\n"
    "          for (int i = 0; i < " NLIGHTS_STR "; i++) {\n"
    "            if (i >= uNumLights) break;\n"
    "            float d = length(wp - uLights[i]);\n"
    "            if (abs(d - 8.0) < 1.0) col = vec3(1.0, 0.0, 1.0);\n"
    "            else if (d < 3.0) col = uLightCol[i];\n"
    "          }\n"
    "      }\n"
    "    }\n"
    "    oColor = vec4(min(col, vec3(1.0)), 1.0);\n"
    "    return;\n"
    "  }\n"
    "  oColor = toRgba(result);\n"
    "}\n";

/* The HUD atlas over the window: one quad per region.  Nearest, or sharp
 * bilinear (nearest inside a texel, linear across its edge, one output pixel
 * wide) for a smooth fractional scale.  The atlas is premultiplied. */
static const char *kHudVs =
    "uniform vec4 uDst;\n"            /* NDC x0 y0 x1 y1 (y0 the top)       */
    "uniform vec4 uSrc;\n"            /* atlas texels x0 y0 x1 y1           */
    "out vec2 vT;\n"
    "void main() {\n"
    "  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));\n"
    "  gl_Position = vec4(mix(uDst.xy, uDst.zw, c), 0.0, 1.0);\n"
    "  vT = mix(uSrc.xy, uSrc.zw, c);\n"
    "}\n";

static const char *kHudFs =
    "precision highp sampler2D;\n"
    "uniform sampler2D uHud;\n"
    "uniform int uSharp;\n"
    "uniform vec2 uScale;\n"          /* output pixels per texel            */
    "uniform vec2 uTexSize;\n"
    "in vec2 vT;\n"
    "out vec4 oColor;\n"
    "void main() {\n"
    "  if (uSharp == 0) { oColor = texelFetch(uHud, ivec2(floor(vT)), 0); return; }\n"
    "  vec2 p = vT - 0.5;\n"
    "  vec2 i = floor(p);\n"
    "  vec2 f = clamp((p - i - 0.5) * uScale + 0.5, 0.0, 1.0);\n"
    "  oColor = texture(uHud, (i + 0.5 + f) / uTexSize);\n"
    "}\n";

static GLuint Compile(GLenum type, const char *extra, const char *body, const char *what)
{
    const char *srcs[4];
    GLuint sh = G(glCreateShader)(type);
    GLint ok = 0;

    srcs[0] = sEs ? "#version 300 es\n" : "#version 330 core\n";
    srcs[1] = kCommon;
    srcs[2] = extra ? extra : "";
    srcs[3] = body;
    G(glShaderSource)(sh, 4, srcs, NULL);
    G(glCompileShader)(sh);
    G(glGetShaderiv)(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[4096];
        G(glGetShaderInfoLog)(sh, sizeof(log), NULL, log);
        PortError("[katam-port] gpu: %s shader: %s", what, log);
        G(glDeleteShader)(sh);
        return 0;
    }
    return sh;
}

/* extra: put before the fragment shader's body (a #define, shared code). */
static GLuint LinkX(const char *vs, const char *extra, const char *fs, const char *what)
{
    GLuint v = Compile(GL_VERTEX_SHADER, NULL, vs, what);
    GLuint f = Compile(GL_FRAGMENT_SHADER, extra, fs, what);
    GLuint p;
    GLint ok = 0;

    if (!v || !f)
        return 0;
    p = G(glCreateProgram)();
    G(glAttachShader)(p, v);
    G(glAttachShader)(p, f);
    G(glLinkProgram)(p);
    G(glGetProgramiv)(p, GL_LINK_STATUS, &ok);
    G(glDeleteShader)(v);
    G(glDeleteShader)(f);
    if (!ok) {
        char log[4096];
        G(glGetProgramInfoLog)(p, sizeof(log), NULL, log);
        PortError("[katam-port] gpu: %s link: %s", what, log);
        return 0;
    }
    return p;
}

static GLuint Link(const char *vs, const char *fs, const char *what)
{
    return LinkX(vs, NULL, fs, what);
}

static GLuint MakeTex(GLenum ifmt, GLenum fmt, GLenum type, int w, int h)
{
    GLuint t;

    G(glGenTextures)(1, &t);
    G(glBindTexture)(GL_TEXTURE_2D, t);
    G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    G(glTexImage2D)(GL_TEXTURE_2D, 0, (GLint)ifmt, w, h, 0, fmt, type, NULL);
    return t;
}

static void SetSamplers(GLuint prog)
{
    static const char *const kNames[] = { "uVram", "uPal", "uLines", "uObj",
                                          "uObjWin", "uMap" };
    int i;

    G(glUseProgram)(prog);
    for (i = 0; i < 6; i++) {
        GLint loc = G(glGetUniformLocation)(prog, kNames[i]);
        if (loc >= 0)
            G(glUniform1i)(loc, i);
    }
}

int GlrInit(void *(*getProc)(const char *), int es)
{
    sEs = es;
#ifndef __EMSCRIPTEN__
#define GLR_LOAD(ret, name, args) \
    glr_##name = (PFN_glr_##name)getProc(#name); \
    if (glr_##name == NULL) { \
        PortError("[katam-port] gpu: no %s in this GL", #name); \
        return 0; \
    }
    GLR_FUNCS(GLR_LOAD)
#undef GLR_LOAD
#else
    (void)getProc;
#endif

    snprintf(sDesc, sizeof(sDesc), "%s / %s / %s",
             (const char *)G(glGetString)(GL_VERSION),
             (const char *)G(glGetString)(GL_RENDERER),
             (const char *)G(glGetString)(GL_SHADING_LANGUAGE_VERSION));
    G(glGetIntegerv)(GL_MAX_TEXTURE_SIZE, &sMaxTex);

    sProgObj = Link(kObjVs, kObjFs, "sprite");
    sProgComp = Link(kCompVs, kCompFs, "composite");
    sProgHud = Link(kHudVs, kHudFs, "hud");
    if (!sProgObj || !sProgComp || !sProgHud)
        return 0;
    sProgCharSh = Link(kCompVs, kCharShFs, "character shadows");
    if (sProgCharSh) {
        G(glUseProgram)(sProgCharSh);
        G(glUniform1i)(G(glGetUniformLocation)(sProgCharSh, "uObjT"), UNIT_IN);
        uSObjG = G(glGetUniformLocation)(sProgCharSh, "uObjG");
        uSCell = G(glGetUniformLocation)(sProgCharSh, "uCell");
        uSMode = G(glGetUniformLocation)(sProgCharSh, "uMode");
        uSSunA = G(glGetUniformLocation)(sProgCharSh, "uSunA");
        uSNumL = G(glGetUniformLocation)(sProgCharSh, "uNumL");
        uSLv = G(glGetUniformLocation)(sProgCharSh, "uLv");
        uSDisc = G(glGetUniformLocation)(sProgCharSh, "uDisc");
        uSReach = G(glGetUniformLocation)(sProgCharSh, "uReach");
        uSOccG = G(glGetUniformLocation)(sProgCharSh, "uOccG");
        uSViewW = G(glGetUniformLocation)(sProgCharSh, "uViewW");
        uSGroundD = G(glGetUniformLocation)(sProgCharSh, "uGroundD");
        G(glUniform1i)(G(glGetUniformLocation)(sProgCharSh, "uOccT"), UNIT_OCC);
    }
    {
        /* Relief: without it the lighting is the flat one; nothing else
         * depends on these. */
        const char *fs[5];
        int i;

        fs[0] = kRel1Fs; fs[1] = kRel2Fs; fs[2] = kRel3Fs; fs[3] = kRel4Fs; fs[4] = kRel5Fs;
        sProgObjDec = LinkX(kObjVs, "#define RELIEF_DECODE 1\n", kObjFs, "relief decode");
        sRelOk = sProgObjDec != 0;
        for (i = 0; i < 5 && sRelOk; i++) {
            sProgRel[i] = LinkX(kCompVs, kRelCommon, fs[i], "relief");
            if (!sProgRel[i]) {
                sRelOk = 0;
                break;
            }
            G(glUseProgram)(sProgRel[i]);
            uRelSize[i] = G(glGetUniformLocation)(sProgRel[i], "uSize");
            uRelSprY0[i] = G(glGetUniformLocation)(sProgRel[i], "uSprY0");
            uRelGenS[i] = G(glGetUniformLocation)(sProgRel[i], "uGenS");
            uRelGenB[i] = G(glGetUniformLocation)(sProgRel[i], "uGenB");
            {
                GLint a = G(glGetUniformLocation)(sProgRel[i], "uAlb");
                GLint b = G(glGetUniformLocation)(sProgRel[i], "uIn");
                if (a >= 0) G(glUniform1i)(a, UNIT_ALB);
                if (b >= 0) G(glUniform1i)(b, UNIT_IN);
            }
        }
        if (sRelOk) {
            SetSamplers(sProgObjDec);
            uDecView = G(glGetUniformLocation)(sProgObjDec, "uViewSize");
            uDecK = G(glGetUniformLocation)(sProgObjDec, "uK");
            uDecWin = G(glGetUniformLocation)(sProgObjDec, "uWinPass");
        } else {
            PortLog("[katam-port] gpu: relief (normal maps) unavailable; lighting stays flat");
        }
    }
    SetSamplers(sProgObj);
    uObjView = G(glGetUniformLocation)(sProgObj, "uViewSize");
    uObjWinPass = G(glGetUniformLocation)(sProgObj, "uWinPass");
    uObjK = G(glGetUniformLocation)(sProgObj, "uK");
    {
        GLint loc = G(glGetUniformLocation)(sProgObj, "uNrmAtlas");
        if (loc >= 0)
            G(glUniform1i)(loc, UNIT_NRM);
    }
    SetSamplers(sProgComp);
    uCView = G(glGetUniformLocation)(sProgComp, "uView");
    uCSub = G(glGetUniformLocation)(sProgComp, "uSub");
    uCContent = G(glGetUniformLocation)(sProgComp, "uContent");
    uCLayer = G(glGetUniformLocation)(sProgComp, "uLayer");
    uCValid = G(glGetUniformLocation)(sProgComp, "uValid");
    uCMapGeom = G(glGetUniformLocation)(sProgComp, "uMapGeom");
    uCMapScroll = G(glGetUniformLocation)(sProgComp, "uMapScroll");
    uCNumHud = G(glGetUniformLocation)(sProgComp, "uNumHud");
    uCHudRect = G(glGetUniformLocation)(sProgComp, "uHudRect");
    uCHudD = G(glGetUniformLocation)(sProgComp, "uHudD");
    uHPass = G(glGetUniformLocation)(sProgComp, "uHudPass");
    uHSel = G(glGetUniformLocation)(sProgComp, "uHudSel");
    uHOrg = G(glGetUniformLocation)(sProgComp, "uHudOrg");
    uCLight = G(glGetUniformLocation)(sProgComp, "uLight");
    uCLightGeom = G(glGetUniformLocation)(sProgComp, "uLightGeom");
    uCLightK = G(glGetUniformLocation)(sProgComp, "uLightK");
    uCLights = G(glGetUniformLocation)(sProgComp, "uLights");
    uCNumLights = G(glGetUniformLocation)(sProgComp, "uNumLights");
    uCLightP = G(glGetUniformLocation)(sProgComp, "uLightP");
    uCLightMode = G(glGetUniformLocation)(sProgComp, "uLightMode");
    uCLightMix = G(glGetUniformLocation)(sProgComp, "uLightMix");
    uCSunSide = G(glGetUniformLocation)(sProgComp, "uSunSide");
    uCEnvLift = G(glGetUniformLocation)(sProgComp, "uEnvLift");
    uCEnvShade = G(glGetUniformLocation)(sProgComp, "uEnvShade");
    uCEnvHalo = G(glGetUniformLocation)(sProgComp, "uEnvHalo");
    uCEnvSpec = G(glGetUniformLocation)(sProgComp, "uEnvSpec");
    uCCharShP = G(glGetUniformLocation)(sProgComp, "uCharShP");
    uCLightCol = G(glGetUniformLocation)(sProgComp, "uLightCol");
    uCLamp = G(glGetUniformLocation)(sProgComp, "uLamp");
    uCRcOn = G(glGetUniformLocation)(sProgComp, "uRcOn");
    uCRcGeom = G(glGetUniformLocation)(sProgComp, "uRcGeom");
    uCRcN = G(glGetUniformLocation)(sProgComp, "uRcN");
    uCRcLo = G(glGetUniformLocation)(sProgComp, "uRcLo");
    uCRcHi = G(glGetUniformLocation)(sProgComp, "uRcHi");
    uCRcInv = G(glGetUniformLocation)(sProgComp, "uRcInv");
    {
        GLint loc = G(glGetUniformLocation)(sProgComp, "uRcT");
        if (loc >= 0)
            G(glUniform1i)(loc, UNIT_RC);
        G(glUniform1i)(uCRcOn, 0);
    }
    {
        GLint loc = G(glGetUniformLocation)(sProgComp, "uCharSh");
        if (loc >= 0)
            G(glUniform1i)(loc, UNIT_CHARSH);
    }
    uCDecode = G(glGetUniformLocation)(sProgComp, "uDecode");
    uCNrm = G(glGetUniformLocation)(sProgComp, "uNrm");
    uCNrmOff = G(glGetUniformLocation)(sProgComp, "uNrmOff");
    uCRelief = G(glGetUniformLocation)(sProgComp, "uRelief");
    uCSunDir = G(glGetUniformLocation)(sProgComp, "uSunDir");
    uCNrmView = G(glGetUniformLocation)(sProgComp, "uNrmView");
    uCSprY0 = G(glGetUniformLocation)(sProgComp, "uSprY0");
    uCRespS = G(glGetUniformLocation)(sProgComp, "uRespS");
    uCRespB = G(glGetUniformLocation)(sProgComp, "uRespB");
    {
        GLint loc = G(glGetUniformLocation)(sProgComp, "uShadow");
        if (loc >= 0)
            G(glUniform1i)(loc, 6);
        loc = G(glGetUniformLocation)(sProgComp, "uNrmAtlas");
        if (loc >= 0)
            G(glUniform1i)(loc, UNIT_NRM);
        loc = G(glGetUniformLocation)(sProgComp, "uObjN");
        if (loc >= 0)
            G(glUniform1i)(loc, UNIT_OBJN);
        loc = G(glGetUniformLocation)(sProgComp, "uAlbAtlas");
        if (loc >= 0)
            G(glUniform1i)(loc, UNIT_ALB_VIEW);
        G(glUniform4i)(uCDecode, -1, 0, 0, 0);
        G(glUniform1i)(uCNrm, 0);
    }
    G(glUseProgram)(sProgHud);
    G(glUniform1i)(G(glGetUniformLocation)(sProgHud, "uHud"), 0);
    uBDst = G(glGetUniformLocation)(sProgHud, "uDst");
    uBSrc = G(glGetUniformLocation)(sProgHud, "uSrc");
    uBSharp = G(glGetUniformLocation)(sProgHud, "uSharp");
    uBScale = G(glGetUniformLocation)(sProgHud, "uScale");
    uBTexSize = G(glGetUniformLocation)(sProgHud, "uTexSize");

    G(glPixelStorei)(GL_UNPACK_ALIGNMENT, 1);
    G(glPixelStorei)(GL_PACK_ALIGNMENT, 1);
    sTexVram = MakeTex(GL_R8UI, GL_RED_INTEGER, GL_UNSIGNED_BYTE, VRAM_TEX_W, VRAM_TEX_H);
    sTexPal = MakeTex(GL_R16UI, GL_RED_INTEGER, GL_UNSIGNED_SHORT, 512, 1);
    sTexLines = MakeTex(GL_RGBA32I, GL_RGBA_INTEGER, GL_INT, RL_LINE_WORDS / 4, RL_LINES);
    sMapRows = 1;
    sTexMap = MakeTex(GL_R16UI, GL_RED_INTEGER, GL_UNSIGNED_SHORT, MAP_TEX_W, sMapRows);

    G(glGenVertexArrays)(1, &sVaoEmpty);
    G(glGenVertexArrays)(1, &sVaoObj);
    G(glGenBuffers)(1, &sInstBuf);
    G(glBindVertexArray)(sVaoObj);
    G(glBindBuffer)(GL_ARRAY_BUFFER, sInstBuf);
    {
        int a;
        for (a = 0; a < 4; a++) {
            G(glEnableVertexAttribArray)((GLuint)a);
            G(glVertexAttribIPointer)((GLuint)a, 4, GL_INT, INST_BYTES, (const void *)(uintptr_t)(a * 16));
            G(glVertexAttribDivisor)((GLuint)a, 1);
        }
    }
    G(glBindVertexArray)(0);

    sReady = 1;
    PortLog("[katam-port] gpu renderer: %s", sDesc);
    return 1;
}

const char *GlrDescribe(void)
{
    return sDesc;
}

static void EnsureTargets(int w, int h)
{
    if (w == sFboW && h == sFboH)
        return;
    if (sFboObj) {
        G(glDeleteFramebuffers)(1, &sFboObj);
        G(glDeleteFramebuffers)(1, &sFboObjWin);
        G(glDeleteFramebuffers)(1, &sFboComp);
        G(glDeleteTextures)(1, &sTexObj);
        G(glDeleteTextures)(1, &sTexObjWin);
        G(glDeleteTextures)(1, &sTexComp);
        G(glDeleteTextures)(1, &sTexObjN);
    }
    sTexObjN = MakeTex(GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, w, h);
    sTexObj = MakeTex(GL_RGBA8UI, GL_RGBA_INTEGER, GL_UNSIGNED_BYTE, w, h);
    sTexObjWin = MakeTex(GL_R8UI, GL_RED_INTEGER, GL_UNSIGNED_BYTE, w, h);
    sTexComp = MakeTex(GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, w, h);
    G(glGenFramebuffers)(1, &sFboObj);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboObj);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexObj, 0);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0 + 1, GL_TEXTURE_2D, sTexObjN, 0);
    {
        static const GLenum kBufs[2] = { GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT0 + 1 };
        G(glDrawBuffers)(2, kBufs);
    }
    if (G(glCheckFramebufferStatus)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        PortError("[katam-port] gpu: sprite target incomplete");
    G(glGenFramebuffers)(1, &sFboObjWin);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboObjWin);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexObjWin, 0);
    G(glGenFramebuffers)(1, &sFboComp);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboComp);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexComp, 0);
    if (G(glCheckFramebufferStatus)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        PortError("[katam-port] gpu: composite target incomplete");
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    sFboW = w;
    sFboH = h;
}

static void UploadVram(const u8 *vram)
{
    int row = 0;

    G(glBindTexture)(GL_TEXTURE_2D, sTexVram);
    if (!sVramValid) {
        memcpy(sVramShadow, vram, VRAM_BYTES);
        G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, 0, VRAM_TEX_W, VRAM_TEX_H,
                           GL_RED_INTEGER, GL_UNSIGNED_BYTE, sVramShadow);
        sVramValid = 1;
        return;
    }
    while (row < VRAM_TEX_H) {
        int start;

        if (memcmp(sVramShadow + row * VRAM_TEX_W, vram + row * VRAM_TEX_W, VRAM_TEX_W) == 0) {
            row++;
            continue;
        }
        start = row;
        while (row < VRAM_TEX_H
               && memcmp(sVramShadow + row * VRAM_TEX_W, vram + row * VRAM_TEX_W, VRAM_TEX_W) != 0)
            row++;
        memcpy(sVramShadow + start * VRAM_TEX_W, vram + start * VRAM_TEX_W,
               (size_t)(row - start) * VRAM_TEX_W);
        G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, start, VRAM_TEX_W, row - start,
                           GL_RED_INTEGER, GL_UNSIGNED_BYTE,
                           sVramShadow + start * VRAM_TEX_W);
    }
}

/* Lay out the streamed layers' maps in the atlas; upload what changed. */
static void UploadMaps(const RlFrame *f)
{
    int bg, need = 0, relayout = 0;
    int base[4];

    for (bg = 0; bg < 4; bg++) {
        const RlTileLayer *L = &f->layers[bg];
        int len = (L->streamed && L->map) ? L->mapW * L->mapH : 0;

        base[bg] = need;
        need += (len + MAP_TEX_W - 1) / MAP_TEX_W * MAP_TEX_W;
        if (len != sMapLen[bg] || L->map != sMapPtr[bg] || (len && L->mapGen != sMapGen[bg]))
            relayout = 1;
    }
    if (need / MAP_TEX_W > sMaxTex)
        need = 0;                       /* too big: layers fall back below */
    G(glBindTexture)(GL_TEXTURE_2D, sTexMap);
    if (need / MAP_TEX_W > sMapRows || sMapShadow == NULL) {
        if (need / MAP_TEX_W > sMapRows)
            sMapRows = need / MAP_TEX_W;
        G(glTexImage2D)(GL_TEXTURE_2D, 0, GL_R16UI, MAP_TEX_W, sMapRows, 0,
                        GL_RED_INTEGER, GL_UNSIGNED_SHORT, NULL);
        sMapShadow = (u16 *)realloc(sMapShadow, (size_t)sMapRows * MAP_TEX_W * 2);
        relayout = 1;
    }
    for (bg = 0; bg < 4; bg++) {
        const RlTileLayer *L = &f->layers[bg];
        int len = (L->streamed && L->map && need) ? L->mapW * L->mapH : 0;
        int rows;

        sMapBase[bg] = base[bg];
        if (len == 0) {
            sMapLen[bg] = 0;
            sMapPtr[bg] = NULL;
            continue;
        }
        if (!relayout && memcmp(sMapShadow + base[bg], L->map, (size_t)len * 2) == 0)
            continue;
        memcpy(sMapShadow + base[bg], L->map, (size_t)len * 2);
        rows = (len + MAP_TEX_W - 1) / MAP_TEX_W;
        G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, base[bg] / MAP_TEX_W, MAP_TEX_W, rows,
                           GL_RED_INTEGER, GL_UNSIGNED_SHORT, sMapShadow + base[bg]);
        sMapLen[bg] = len;
        sMapPtr[bg] = L->map;
        sMapGen[bg] = L->mapGen;
    }
}

static const u8 kObjW[4][4] = { {8,16,32,64}, {16,32,32,64}, {8,8,16,32}, {8,8,8,8} };
static const u8 kObjH[4][4] = { {8,16,32,64}, {8,8,16,32}, {16,32,32,64}, {8,8,8,8} };

/* Which sprites a sprite pass draws, and where. */
#define SPR_ALL   0             /* everything, HUD sprites at their view place */
#define SPR_WORLD 1             /* everything but the HUD                     */
#define SPR_HUD   2             /* the HUD only, into the HUD atlas           */

/* Fill the instance buffer back to front; returns the count.  relief: give
 * each sprite its place in the normal atlas (PlanRelief), if it has one. */
static int BuildInstances(const RlFrame *f, u32 from, u32 count, int which,
                          int tw, int th, int relief)
{
    int n = 0;
    u32 i;

    if ((int)count > sInstCap) {
        sInstCap = (int)count + 256;
        sInst = (s32 *)realloc(sInst, (size_t)sInstCap * INST_INTS * sizeof(s32));
    }
    for (i = count; i-- > 0;) {
        const RlSprite *s = &f->sprites[from + i];
        u32 shape = (s->attr0 >> 14) & 3, size = (s->attr1 >> 14) & 3;
        s32 w = kObjW[shape][size], h = kObjH[shape][size];
        int affine = (s->attr0 & 0x100) != 0;
        int dbl = affine && (s->attr0 & 0x200);
        s32 bw = w << dbl, bh = h << dbl, x, y;   /* x, y: 1/256 px */
        s32 *o = sInst + n * INST_INTS;
        int flags;

        if ((which == SPR_HUD) != (s->space == RL_SPACE_HUD) && which != SPR_ALL)
            continue;
        if (which == SPR_HUD) {
            x = (s->x + HudOrgX(s->anchor)) * 256;
            y = (s->y + HudOrgY(s->anchor)) * 256;
        } else if (s->space == RL_SPACE_HUD) {
            x = (s->x + f->hud[s->anchor].dx) * 256;
            y = (s->y + f->hud[s->anchor].dy) * 256;
        } else {
            x = (s->x - f->viewX) * 256 + s->subX - f->viewSubX;
            y = (s->y - f->viewY) * 256 + s->subY - f->viewSubY;
        }
        if (x >= tw * 256 || y >= th * 256 || x + bw * 256 <= 0 || y + bh * 256 <= 0)
            continue;
        flags = (s->attr2 >> 12) & 15;
        if (s->attr0 & 0x2000) flags |= 16;
        if (!affine && (s->attr1 & 0x1000)) flags |= 32;
        if (!affine && (s->attr1 & 0x2000)) flags |= 64;
        if (affine) flags |= 128;
        flags |= ((s->attr2 >> 10) & 3) << 8;
        if (((s->attr0 >> 10) & 3) == 1) flags |= 1024;
        if (f->objOneD) flags |= 4096;
        if (s->space == RL_SPACE_HUD) flags |= 8192;
        o[0] = x; o[1] = y; o[2] = bw; o[3] = bh;
        o[4] = w; o[5] = h; o[6] = s->attr2 & 0x3FF; o[7] = flags;
        o[8] = s->pa; o[9] = s->pb; o[10] = s->pc; o[11] = s->pd;
        o[12] = o[13] = o[14] = o[15] = 0;
        if (relief && from + i < RL_MAX_SPRITES && sSprHas[from + i]) {
            o[12] = sSprSlot[from + i][0];
            o[13] = sSprSlot[from + i][1];
            o[14] = 1;
        }
        n++;
    }
    return n;
}

static void DrawSprites(const RlFrame *f, GLuint fbo, u32 from, u32 count, int winPass,
                        int which, int tw, int th, int k)
{
    static const GLuint kZero[4] = { 0, 0, 0, 0 };
    static const GLfloat kFlat[4] = { 0.5f, 0.5f, 1.0f, 0.0f };
    int n;

    G(glBindFramebuffer)(GL_FRAMEBUFFER, fbo);
    G(glViewport)(0, 0, tw * k, th * k);
    G(glClearBufferuiv)(GL_COLOR, 0, kZero);
    if (fbo == sFboObj)
        G(glClearBufferfv)(GL_COLOR, 1, kFlat);
    n = BuildInstances(f, from, count, which, tw, th,
                       sRelOn && fbo == sFboObj && !winPass);
    if (n == 0)
        return;
    G(glUseProgram)(sProgObj);
    G(glUniform2i)(uObjView, tw * k, th * k);
    G(glUniform1i)(uObjK, k);
    G(glUniform1i)(uObjWinPass, winPass);
    G(glBindVertexArray)(sVaoObj);
    G(glBindBuffer)(GL_ARRAY_BUFFER, sInstBuf);
    G(glBufferData)(GL_ARRAY_BUFFER, (GLsizeiptr)n * INST_BYTES, sInst, GL_STREAM_DRAW);
    G(glDrawArraysInstanced)(GL_TRIANGLE_STRIP, 0, 4, n);
    G(glBindVertexArray)(0);
}

static void EnsureHudTargets(void)
{
    if (sFboHud)
        return;
    sTexObjHud = MakeTex(GL_RGBA8UI, GL_RGBA_INTEGER, GL_UNSIGNED_BYTE, HUD_ATLAS_W, HUD_ATLAS_H);
    sTexHud = MakeTex(GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, HUD_ATLAS_W, HUD_ATLAS_H);
    /* Linear for the sharp-bilinear present; texelFetch ignores it. */
    G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    G(glGenFramebuffers)(1, &sFboObjHud);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboObjHud);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexObjHud, 0);
    G(glGenFramebuffers)(1, &sFboHud);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboHud);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexHud, 0);
    if (G(glCheckFramebufferStatus)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        PortError("[katam-port] gpu: HUD target incomplete");
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
}

void GlrSetHudLayer(int on)
{
    sHudWant = on;
}

int GlrHudActive(void)
{
    return sReady && sHudActive && !sSrcPic;
}

/* The sunlight map (light.c): an RGBA8 texture (previous and current map),
 * bilinear, uploaded when it changes.  Off (f->light NULL): uLight 0 and the
 * composite is the old one. */
static void UploadLight(const RlFrame *f)
{
    /* The environment's colours: the frame's, or Rainbow Route's while it
     * carries none (all zero; render_list.h). */
    static const float kEnvRR[4][3] = {
        { 0.45f, 0.25f, -0.08f },   /* envLift  */
        { 0.90f, 0.95f, 1.20f },    /* envShade */
        { 0.55f, 0.42f, 0.20f },    /* envHalo  */
        { 1.0f, 0.92f, 0.75f },     /* envSpec  */
    };
    const float *env[4];
    int i, any = 0;

    if (!f->light || f->lightW <= 0 || f->lightH <= 0
        || f->lightW > sMaxTex || f->lightH > sMaxTex) {
        G(glUniform1i)(uCLight, 0);
        return;
    }
    G(glActiveTexture)(GL_TEXTURE0 + 6);
    if (!sTexLight || f->lightW != sLightW || f->lightH != sLightH) {
        if (sTexLight)
            G(glDeleteTextures)(1, &sTexLight);
        sTexLight = MakeTex(GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, f->lightW, f->lightH);
        G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        sLightW = f->lightW;
        sLightH = f->lightH;
        sLightPtr = NULL;
    }
    G(glBindTexture)(GL_TEXTURE_2D, sTexLight);
    if (f->light != sLightPtr || f->lightGen != sLightGen) {
        G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, 0, f->lightW, f->lightH,
                           GL_RGBA, GL_UNSIGNED_BYTE, f->light);
        sLightPtr = f->light;
        sLightGen = f->lightGen;
    }
    G(glActiveTexture)(GL_TEXTURE0 + 0);
    G(glUniform1i)(uCLight, f->lightLayers);
    G(glUniform4i)(uCLightGeom, f->camX, f->camY, f->lightW, f->lightH);
    G(glUniform1f)(uCLightK, f->lightK);
    G(glUniform2fv)(uCLights, RL_MAX_LIGHTS, &f->lights[0][0]);
    G(glUniform1i)(uCNumLights, f->numLights);
    G(glUniform4f)(uCLightP, f->lightShadow, f->lightWarm, f->lightCool, f->lightGlow);
    G(glUniform1i)(uCLightMode, f->lightMode);
    G(glUniform1f)(uCLightMix, f->lightMix);
    G(glUniform3fv)(uCLightCol, RL_MAX_LIGHTS, &f->lightCol[0][0]);
    G(glUniform2f)(uCLamp, f->lampRange > 0.0f ? f->lampRange : 200.0f, f->lightIndoor);
    G(glUniform1i)(uCNrmView, f->lightNrmView);
    G(glUniform1f)(uCSunSide, f->lightSunSide);
    env[0] = f->envLift;
    env[1] = f->envShade;
    env[2] = f->envHalo;
    env[3] = f->envSpec;
    for (i = 0; i < 12; i++)
        any |= env[i / 3][i % 3] != 0.0f;
    if (!any)
        for (i = 0; i < 4; i++)
            env[i] = kEnvRR[i];
    G(glUniform3f)(uCEnvLift, env[0][0], env[0][1], env[0][2]);
    G(glUniform3f)(uCEnvShade, env[1][0], env[1][1], env[1][2]);
    G(glUniform3f)(uCEnvHalo, env[2][0], env[2][1], env[2][2]);
    G(glUniform3f)(uCEnvSpec, env[3][0], env[3][1], env[3][2]);
}

/* --- relief: normal maps for the lighting (relief_glsl.h) -----------------
 *
 * Only for a lit world frame (f->light, light.c) with relief on.  Per frame:
 * PlanRelief packs, on shelves with transparent gutters, every enabled
 * non-HUD background layer's piece around the view (the view's layer
 * coordinates plus RELIEF_MARGIN all round) and every distinct on-screen
 * world sprite (tile, size, palette, depth: one place for a crowd of the
 * same enemy); RunRelief draws them -- the layers through the composite
 * program's decode branch, the sprites unflipped through the decode sprite
 * program -- and runs the five passes over that part of the atlas.  The
 * sprite pass then reads each sprite's normal from its place, and the
 * composite each layer's at its layer coordinates plus uNrmOff. */

static s32 FloorDiv256(s32 v)
{
    return v >= 0 ? v / 256 : -((-v + 255) / 256);
}

typedef struct ReliefPacker {
    int x, y, shelf, w;
} ReliefPacker;

static int ReliefPlace(ReliefPacker *P, int w, int h, int *ox, int *oy)
{
    if (w + 2 * RELIEF_GUTTER > P->w)
        return 0;
    if (P->x + w + RELIEF_GUTTER > P->w) {
        P->y += P->shelf + RELIEF_GUTTER;
        P->x = RELIEF_GUTTER;
        P->shelf = 0;
    }
    if (P->y + h + RELIEF_GUTTER > sMaxTex)
        return 0;
    *ox = P->x;
    *oy = P->y;
    P->x += w + RELIEF_GUTTER;
    if (h > P->shelf)
        P->shelf = h;
    return 1;
}

/* A sprite of the frame as the relief sees it: its box at whole game
 * pixels (the fraction is the group's), and what it may be grouped by. */
typedef struct ReliefSpr {
    s32 x, y, bw, bh;
    s32 sub;                    /* subX, subY packed: one fraction a group   */
    int key;                    /* palette (or 8bpp), priority, semi         */
    int idx;                    /* in f->sprites                             */
    int parent;                 /* union-find                                */
} ReliefSpr;

static int ReliefRoot(ReliefSpr *r, int i)
{
    while (r[i].parent != i) {
        r[i].parent = r[r[i].parent].parent;
        i = r[i].parent;
    }
    return i;
}

#define RELIEF_GROUP_MAX 192    /* px: a bigger group splits into its sprites */

static void PlanRelief(const RlFrame *f)
{
    static ReliefSpr r[RL_MAX_SPRITES];
    static s32 gbox[RL_MAX_SPRITES][4];   /* per root: x0 y0 x1 y1           */
    static s32 gslot[RL_MAX_SPRITES][2];
    static u8 gok[RL_MAX_SPRITES];
    ReliefPacker P;
    int bg, aw, rw, rh, n = (int)f->numSprites, m = 0;
    int i, j;

    sRelOn = 0;
    sDecN = 0;
    if (n > RL_MAX_SPRITES)
        n = RL_MAX_SPRITES;
    memset(sSprHas, 0, (size_t)n);
    memset(sRelBg, 0, sizeof(sRelBg));
    memset(sNrmOff, 0, sizeof(sNrmOff));
    if (!sRelOk || !f->light || !(f->lightRelief > 0.0f) || !f->world)
        return;
    rw = f->viewW + 1 + 2 * RELIEF_MARGIN;
    rh = f->viewH + 1 + 2 * RELIEF_MARGIN;
    aw = 1024;
    if (rw + 2 * RELIEF_GUTTER > aw)
        aw = (rw + 2 * RELIEF_GUTTER + 63) & ~63;
    if (aw > sMaxTex)
        return;
    P.x = P.y = RELIEF_GUTTER;
    P.shelf = 0;
    P.w = aw;

    for (bg = 0; bg < 4; bg++) {
        const RlTileLayer *L = &f->layers[bg];
        int ax, ay;
        s32 lx0, ly0;

        if (!f->lightReliefBg || !L->enabled || L->space == RL_SPACE_HUD
            || !ReliefPlace(&P, rw, rh, &ax, &ay))
            continue;
        /* The composite's layer coordinate is (screen * 256 + shift) >> 8. */
        lx0 = FloorDiv256(f->viewX * 256 + f->viewSubX + L->shiftX * 256 + L->subX) - RELIEF_MARGIN;
        ly0 = FloorDiv256(f->viewY * 256 + f->viewSubY + L->shiftY * 256 + L->subY) - RELIEF_MARGIN;
        sRelBg[bg][0] = ax;
        sRelBg[bg][1] = ay;
        sRelBg[bg][2] = rw;
        sRelBg[bg][3] = rh;
        sNrmOff[bg * 4 + 0] = ax - lx0;
        sNrmOff[bg * 4 + 1] = ay - ly0;
        sNrmOff[bg * 4 + 2] = 1;
    }

    /* Sprites on shelves of their own: their distance cap is another. */
    if (P.shelf) {
        P.y += P.shelf + RELIEF_GUTTER;
        P.x = RELIEF_GUTTER;
        P.shelf = 0;
    }
    sRelSprY0 = P.y;

    /* The on-screen world sprites.  A character is often several hardware
     * sprites side by side (a body and an arm, two halves); made one by one,
     * each piece would get a rim where it meets the next.  So sprites that
     * touch or overlap, with the same palette, priority, blending and
     * sub-pixel position, are one group, drawn together -- as on screen,
     * flipped and rotated, the front one on top -- and the group's normals
     * are made from the whole picture, in screen orientation. */
    for (i = 0; i < n; i++) {
        const RlSprite *s = &f->sprites[i];
        u32 shape = (s->attr0 >> 14) & 3, size = (s->attr1 >> 14) & 3;
        int affine = (s->attr0 & 0x100) != 0, dbl = affine && (s->attr0 & 0x200);
        s32 bw = kObjW[shape][size] << dbl, bh = kObjH[shape][size] << dbl, x, y;

        if (s->space == RL_SPACE_HUD)
            continue;
        x = (s->x - f->viewX) * 256 + s->subX - f->viewSubX;
        y = (s->y - f->viewY) * 256 + s->subY - f->viewSubY;
        if (x >= f->viewW * 256 || y >= f->viewH * 256 || x + bw * 256 <= 0 || y + bh * 256 <= 0)
            continue;
        r[m].x = s->x;
        r[m].y = s->y;
        r[m].bw = bw;
        r[m].bh = bh;
        r[m].sub = ((s32)(u16)s->subX << 16) | (u16)s->subY;
        r[m].key = ((s->attr0 & 0x2000) ? 16 : ((s->attr2 >> 12) & 15))
                 | (((s->attr2 >> 10) & 3) << 5) | ((((s->attr0 >> 10) & 3) == 1) << 7);
        r[m].idx = i;
        r[m].parent = m;
        m++;
    }
    for (i = 0; i < m; i++)
        for (j = i + 1; j < m; j++) {
            const ReliefSpr *a = &r[i], *b = &r[j];
            if (a->key != b->key || a->sub != b->sub)
                continue;
            if (a->x > b->x + b->bw || b->x > a->x + a->bw
                || a->y > b->y + b->bh || b->y > a->y + a->bh)
                continue;
            {
                int ra = ReliefRoot(r, i), rb = ReliefRoot(r, j);
                if (ra != rb)
                    r[rb > ra ? rb : ra].parent = rb > ra ? ra : rb;
            }
        }
    for (i = 0; i < m; i++) {
        int g = ReliefRoot(r, i);
        if (g == i) {
            gbox[g][0] = r[i].x; gbox[g][1] = r[i].y;
            gbox[g][2] = r[i].x + r[i].bw; gbox[g][3] = r[i].y + r[i].bh;
        }
    }
    for (i = 0; i < m; i++) {
        int g = ReliefRoot(r, i);
        if (r[i].x < gbox[g][0]) gbox[g][0] = r[i].x;
        if (r[i].y < gbox[g][1]) gbox[g][1] = r[i].y;
        if (r[i].x + r[i].bw > gbox[g][2]) gbox[g][2] = r[i].x + r[i].bw;
        if (r[i].y + r[i].bh > gbox[g][3]) gbox[g][3] = r[i].y + r[i].bh;
    }
    /* Too big (a long chain of one palette): every sprite its own group. */
    for (i = 0; i < m; i++) {
        int g = ReliefRoot(r, i);
        gok[i] = gbox[g][2] - gbox[g][0] > RELIEF_GROUP_MAX
                 || gbox[g][3] - gbox[g][1] > RELIEF_GROUP_MAX;
    }
    for (i = 0; i < m; i++)
        if (gok[i]) {
            r[i].parent = i;
            gbox[i][0] = r[i].x; gbox[i][1] = r[i].y;
            gbox[i][2] = r[i].x + r[i].bw; gbox[i][3] = r[i].y + r[i].bh;
        }
    for (i = 0; i < m; i++) {
        int g = ReliefRoot(r, i);
        if (g == i)
            gok[g] = (u8)ReliefPlace(&P, gbox[g][2] - gbox[g][0], gbox[g][3] - gbox[g][1],
                                     &gslot[g][0], &gslot[g][1]);
    }

    if (m > sDecCap) {
        sDecCap = m + 64;
        sDecInst = (s32 *)realloc(sDecInst, (size_t)sDecCap * INST_INTS * sizeof(s32));
    }
    /* Back to front, as the sprite pass draws: the front sprite wins. */
    for (i = m; i-- > 0;) {
        const RlSprite *s = &f->sprites[r[i].idx];
        int g = ReliefRoot(r, i), affine = (s->attr0 & 0x100) != 0, fl;
        u32 shape = (s->attr0 >> 14) & 3, size = (s->attr1 >> 14) & 3;
        s32 ox, oy, *o;

        if (!gok[g])
            continue;
        ox = gslot[g][0] + r[i].x - gbox[g][0];
        oy = gslot[g][1] + r[i].y - gbox[g][1];
        fl = (s->attr2 >> 12) & 15;
        if (s->attr0 & 0x2000) fl |= 16;
        if (!affine && (s->attr1 & 0x1000)) fl |= 32;
        if (!affine && (s->attr1 & 0x2000)) fl |= 64;
        if (affine) fl |= 128;
        if (f->objOneD) fl |= 4096;
        o = sDecInst + sDecN * INST_INTS;
        memset(o, 0, INST_BYTES);
        o[0] = ox * 256; o[1] = oy * 256; o[2] = r[i].bw; o[3] = r[i].bh;
        o[4] = kObjW[shape][size]; o[5] = kObjH[shape][size];
        o[6] = s->attr2 & 0x3FF; o[7] = fl;
        o[8] = s->pa; o[9] = s->pb; o[10] = s->pc; o[11] = s->pd;
        sDecN++;
        sSprSlot[r[i].idx][0] = ox;
        sSprSlot[r[i].idx][1] = oy;
        sSprHas[r[i].idx] = 1;
    }
    sRelW = aw;
    sRelH = P.y + P.shelf + RELIEF_GUTTER;
    sRelOn = 1;
}

static GLuint ReliefTarget(GLuint *fbo, GLenum ifmt, GLenum fmt, GLenum type, int w, int h)
{
    GLuint t = MakeTex(ifmt, fmt, type, w, h);

    G(glGenFramebuffers)(1, fbo);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, *fbo);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t, 0);
    if (G(glCheckFramebufferStatus)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        PortError("[katam-port] gpu: relief target incomplete; lighting stays flat");
        sRelOk = 0;
    }
    return t;
}

/* Grow-only, in steps of 128 rows. */
static int EnsureRelief(int w, int h)
{
    GLuint *tex[6] = { &sTexAlb, &sTexT1, &sTexT2, &sTexT3, &sTexT4, &sTexNrm };
    GLuint *fbo[6] = { &sFboAlb, &sFboT1, &sFboT2, &sFboT3, &sFboT4, &sFboNrm };
    int i;

    if (sTexAlb && w == sRelTexW && h <= sRelTexH)
        return sRelOk;
    h = (h + 127) & ~127;
    if (h < sRelTexH && w == sRelTexW)
        h = sRelTexH;
    if (h > sMaxTex)
        h = sMaxTex;
    for (i = 0; i < 6; i++)
        if (*tex[i]) {
            G(glDeleteFramebuffers)(1, fbo[i]);
            G(glDeleteTextures)(1, tex[i]);
            *tex[i] = 0;
        }
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_IN);
    sTexAlb = ReliefTarget(&sFboAlb, GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, w, h);
    sTexT1 = ReliefTarget(&sFboT1, GL_RG32UI, GL_RG_INTEGER, GL_UNSIGNED_INT, w, h);
    sTexT2 = ReliefTarget(&sFboT2, GL_RGBA32UI, GL_RGBA_INTEGER, GL_UNSIGNED_INT, w, h);
    sTexT3 = ReliefTarget(&sFboT3, GL_R32UI, GL_RED_INTEGER, GL_UNSIGNED_INT, w, h);
    sTexT4 = ReliefTarget(&sFboT4, GL_R32UI, GL_RED_INTEGER, GL_UNSIGNED_INT, w, h);
    sTexNrm = ReliefTarget(&sFboNrm, GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, w, h);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    sRelTexW = w;
    sRelTexH = h;
    if (!sRelOk)
        PortLog("[katam-port] gpu: relief disabled");
    else
        PortLog("[katam-port] gpu: relief atlas %dx%d", w, h);
    return sRelOk;
}

/* The composite program's uniforms must be set (its decode branch draws the
 * layers).  Leaves the normal atlas on UNIT_NRM. */
static void RunRelief(void)
{
    GLuint in[5], out[5];
    int bg, i;

    G(glActiveTexture)(GL_TEXTURE0 + UNIT_NRM);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_ALB_VIEW);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    if (!sRelOn)
        return;
    if (!EnsureRelief(sRelW, sRelH)) {
        sRelOn = 0;
        return;
    }
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_IN);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_ALB);
    G(glBindTexture)(GL_TEXTURE_2D, 0);

    /* The art. */
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboAlb);
    G(glViewport)(0, 0, sRelW, sRelH);
    G(glClearColor)(0.0f, 0.0f, 0.0f, 0.0f);
    G(glClear)(GL_COLOR_BUFFER_BIT);
    G(glBindVertexArray)(sVaoEmpty);
    G(glUseProgram)(sProgComp);
    G(glUniform4iv)(uCNrmOff, 4, sNrmOff);
    for (bg = 0; bg < 4; bg++) {
        if (!sRelBg[bg][2])
            continue;
        G(glViewport)(sRelBg[bg][0], sRelBg[bg][1], sRelBg[bg][2], sRelBg[bg][3]);
        G(glUniform4i)(uCDecode, bg, 0, 0, 0);
        G(glDrawArrays)(GL_TRIANGLES, 0, 3);
    }
    G(glUniform4i)(uCDecode, -1, 0, 0, 0);
    G(glViewport)(0, 0, sRelW, sRelH);
    if (sDecN) {
        G(glUseProgram)(sProgObjDec);
        G(glUniform2i)(uDecView, sRelW, sRelH);
        G(glUniform1i)(uDecK, 1);
        G(glUniform1i)(uDecWin, 0);
        G(glBindVertexArray)(sVaoObj);
        G(glBindBuffer)(GL_ARRAY_BUFFER, sInstBuf);
        G(glBufferData)(GL_ARRAY_BUFFER, (GLsizeiptr)sDecN * INST_BYTES, sDecInst, GL_STREAM_DRAW);
        G(glDrawArraysInstanced)(GL_TRIANGLE_STRIP, 0, 4, sDecN);
        G(glBindVertexArray)(sVaoEmpty);
    }

    /* The passes. */
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_ALB);
    G(glBindTexture)(GL_TEXTURE_2D, sTexAlb);
    in[0] = 0;       out[0] = sFboT1;
    in[1] = sTexT1;  out[1] = sFboT2;
    in[2] = sTexT2;  out[2] = sFboT3;
    in[3] = sTexT3;  out[3] = sFboT4;
    in[4] = sTexT4;  out[4] = sFboNrm;
    for (i = 0; i < 5; i++) {
        G(glBindFramebuffer)(GL_FRAMEBUFFER, out[i]);
        G(glUseProgram)(sProgRel[i]);
        G(glUniform2i)(uRelSize[i], sRelW, sRelH);
        G(glUniform1i)(uRelSprY0[i], sRelSprY0);
        G(glUniform4f)(uRelGenS[i], kReliefGenSpr[0], kReliefGenSpr[1], kReliefGenSpr[2], kReliefGenSpr[3]);
        G(glUniform4f)(uRelGenB[i], kReliefGenBg[0], kReliefGenBg[1], kReliefGenBg[2], kReliefGenBg[3]);
        G(glActiveTexture)(GL_TEXTURE0 + UNIT_IN);
        G(glBindTexture)(GL_TEXTURE_2D, in[i]);
        G(glDrawArrays)(GL_TRIANGLES, 0, 3);
    }
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_ALB);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_NRM);
    G(glBindTexture)(GL_TEXTURE_2D, sTexNrm);
    G(glActiveTexture)(GL_TEXTURE0);
    G(glBindVertexArray)(0);
}

/* ?normals=2 reads the art in the composite; never while it is drawn into. */
static void BindReliefView(const RlFrame *f)
{
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_ALB_VIEW);
    G(glBindTexture)(GL_TEXTURE_2D, sRelOn && f->lightNrmView == 2 ? sTexAlb : 0);
    G(glActiveTexture)(GL_TEXTURE0);
}

/* The composite's relief uniforms. */
static void SetRelief(const RlFrame *f)
{
    float a = f->lightAngle * 3.14159265f / 180.0f;
    float x = -sinf(a), y = cosf(a), z = f->lightHeight;
    float l = sqrtf(x * x + y * y + z * z);

    G(glUniform1i)(uCNrm, sRelOn);
    if (!sRelOn)
        return;
    G(glUniform4iv)(uCNrmOff, 4, sNrmOff);
    G(glUniform4f)(uCRelief, f->lightRelief, f->lightShine, 0.0f, f->lightHeight * 80.0f);
    G(glUniform4fv)(uCRespS, 1, kReliefRespSpr);
    G(glUniform4fv)(uCRespB, 1, kReliefRespBg);
    G(glUniform3f)(uCSunDir, x / l, y / l, z / l);
    G(glUniform1i)(uCNrmView, f->lightNrmView);
    G(glUniform1i)(uCSprY0, sRelSprY0);
}

/* The room's collision cells on UNIT_OCC, uploaded when they change (a
 * room, a block): the character shadows' and the cascades' ground. */
static void EnsureOcc(const RlFrame *f)
{
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_OCC);
    if (f->lightOcc && f->lightOccW > 0 && f->lightOccH > 0) {
        if (!sTexOcc || f->lightOccW != sOccW || f->lightOccH != sOccH) {
            if (sTexOcc)
                G(glDeleteTextures)(1, &sTexOcc);
            sTexOcc = MakeTex(GL_R8UI, GL_RED_INTEGER, GL_UNSIGNED_BYTE, f->lightOccW, f->lightOccH);
            sOccW = f->lightOccW;
            sOccH = f->lightOccH;
            sOccGen = f->lightOccGen - 1;
        }
        G(glBindTexture)(GL_TEXTURE_2D, sTexOcc);
        if (f->lightOccGen != sOccGen) {
            G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, 0, sOccW, sOccH, GL_RED_INTEGER, GL_UNSIGNED_BYTE, f->lightOcc);
            sOccGen = f->lightOccGen;
        }
    }
    G(glActiveTexture)(GL_TEXTURE0);
}

/* After the sprite pass, before the composite: the characters' shadows into
 * an R8 texture over the view (kCharShFs). */
static void RunCharShadow(const RlFrame *f, int k)
{
    int w = (f->viewW + CHARSH_CELL - 1) / CHARSH_CELL, h = (f->viewH + CHARSH_CELL - 1) / CHARSH_CELL;
    float a = f->lightAngle * 3.14159265f / 180.0f;
    float lv[RL_MAX_LIGHTS * 2] = { 0 };
    int i;

    G(glActiveTexture)(GL_TEXTURE0 + UNIT_CHARSH);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0);
    sCharShOn = 0;
    if (!sProgCharSh || !f->light || !f->world || !(f->lightSprShadow > 0.0f)
        || ((!sRcTried || sProgRc) && f->lightEngine == LIGHT_ENGINE_RC))
        return;
    if (!sTexCharSh || w != sCharShW || h != sCharShH) {
        if (sTexCharSh) {
            G(glDeleteFramebuffers)(1, &sFboCharSh);
            G(glDeleteTextures)(1, &sTexCharSh);
        }
        G(glActiveTexture)(GL_TEXTURE0 + UNIT_CHARSH);
        sTexCharSh = MakeTex(GL_R8, GL_RED, GL_UNSIGNED_BYTE, w, h);
        G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        G(glTexParameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        G(glBindTexture)(GL_TEXTURE_2D, 0);
        G(glActiveTexture)(GL_TEXTURE0);
        G(glGenFramebuffers)(1, &sFboCharSh);
        G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboCharSh);
        G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexCharSh, 0);
        if (G(glCheckFramebufferStatus)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
            PortError("[katam-port] gpu: character shadow target incomplete");
            G(glDeleteProgram)(sProgCharSh);
            sProgCharSh = 0;
            return;
        }
        sCharShW = w;
        sCharShH = h;
    }
    for (i = 0; i < f->numLights && i < RL_MAX_LIGHTS; i++) {
        lv[i * 2 + 0] = f->lights[i][0] - (float)(f->camX + f->viewX) - f->viewSubX / 256.0f;
        lv[i * 2 + 1] = f->lights[i][1] - (float)(f->camY + f->viewY) - f->viewSubY / 256.0f;
    }
    EnsureOcc(f);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboCharSh);
    G(glViewport)(0, 0, w, h);
    G(glUseProgram)(sProgCharSh);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_IN);
    G(glBindTexture)(GL_TEXTURE_2D, sTexObj);
    G(glUniform3i)(uSObjG, f->viewW * k, f->viewH * k, k);
    G(glUniform1f)(uSCell, (float)CHARSH_CELL);
    G(glUniform1i)(uSMode, f->lightMode);
    G(glUniform2f)(uSSunA, a, (1.0f + 16.0f * f->lightSoft) * 3.14159265f / 180.0f);
    G(glUniform1i)(uSNumL, f->numLights);
    G(glUniform2fv)(uSLv, RL_MAX_LIGHTS, lv);
    G(glUniform1f)(uSDisc, 4.0f + 56.0f * f->lightSoft);
    G(glUniform2i)(uSOccG, f->lightOcc ? sOccW : 0, f->lightOcc ? sOccH : 0);
    G(glUniform2f)(uSViewW, (float)(f->camX + f->viewX) + f->viewSubX / 256.0f,
                   (float)(f->camY + f->viewY) + f->viewSubY / 256.0f);
    G(glUniform1f)(uSGroundD, f->lightCharDepth);
    G(glUniform1f)(uSReach, f->lightCharReach < 16.0f ? 16.0f
                            : f->lightCharReach > 160.0f ? 160.0f : f->lightCharReach);
    G(glBindVertexArray)(sVaoEmpty);
    G(glDrawArrays)(GL_TRIANGLES, 0, 3);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_CHARSH);
    G(glBindTexture)(GL_TEXTURE_2D, sTexCharSh);
    G(glActiveTexture)(GL_TEXTURE0);
    sCharShOn = 1;
}

/* The environment's colours: the frame's, or Rainbow Route's while it
 * carries none (all zero; render_list.h). */
static void FrameEnv(const RlFrame *f, const float *env[4])
{
    static const float kEnvRR[4][3] = {
        { 0.45f, 0.25f, -0.08f },   /* envLift  */
        { 0.90f, 0.95f, 1.20f },    /* envShade */
        { 0.55f, 0.42f, 0.20f },    /* envHalo  */
        { 1.0f, 0.92f, 0.75f },     /* envSpec  */
    };
    int i, any = 0;

    env[0] = f->envLift;
    env[1] = f->envShade;
    env[2] = f->envHalo;
    env[3] = f->envSpec;
    for (i = 0; i < 12; i++)
        any |= env[i / 3][i % 3] != 0.0f;
    if (!any)
        for (i = 0; i < 4; i++)
            env[i] = kEnvRR[i];
}

/* The cascades' program, linked the first time the engine is chosen: its
 * compile takes a while on some drivers, and nobody else needs it. */
static int EnsureRcProgram(void)
{
    double t0;

    if (sProgRc || sRcTried)
        return sProgRc != 0;
    sRcTried = 1;
    t0 = RcNowMs();
    sProgRc = Link(kCompVs, kRcFs, "radiance cascades");
    if (!sProgRc) {
        PortLog("[katam-port] gpu: radiance cascades unavailable; the classic lighting stays");
        return 0;
    }
    G(glUseProgram)(sProgRc);
    G(glUniform1i)(G(glGetUniformLocation)(sProgRc, "uUp"), UNIT_RC_UP);
    G(glUniform1i)(G(glGetUniformLocation)(sProgRc, "uOccT"), UNIT_OCC);
    G(glUniform1i)(G(glGetUniformLocation)(sProgRc, "uObjT"), UNIT_IN);
    uROccG = G(glGetUniformLocation)(sProgRc, "uOccG");
    uRObjG = G(glGetUniformLocation)(sProgRc, "uObjG");
    uRObjW = G(glGetUniformLocation)(sProgRc, "uObjW");
    uROrg = G(glGetUniformLocation)(sProgRc, "uOrg");
    uRP0 = G(glGetUniformLocation)(sProgRc, "uP0");
    uRS0E0 = G(glGetUniformLocation)(sProgRc, "uS0E0");
    uRCasc = G(glGetUniformLocation)(sProgRc, "uCasc");
    uRGround = G(glGetUniformLocation)(sProgRc, "uGround");
    uRNumL = G(glGetUniformLocation)(sProgRc, "uNumL");
    uRLp = G(glGetUniformLocation)(sProgRc, "uLp");
    uRLc = G(glGetUniformLocation)(sProgRc, "uLc");
    uRSky = G(glGetUniformLocation)(sProgRc, "uSky");
    uRSun = G(glGetUniformLocation)(sProgRc, "uSun");
    uRSunP = G(glGetUniformLocation)(sProgRc, "uSunP");
    uRAmb = G(glGetUniformLocation)(sProgRc, "uAmb");
    uRPrevG = G(glGetUniformLocation)(sProgRc, "uPrevG");
    uRPrevS = G(glGetUniformLocation)(sProgRc, "uPrevS");
    G(glUniform1i)(G(glGetUniformLocation)(sProgRc, "uPrevT"), UNIT_RC);
    PortLog("[katam-port] gpu: radiance cascades ready (%.0f ms to compile)", RcNowMs() - t0);
    return 1;
}

/* Radiance cascades (rc_glsl.h), after the sprite pass (sprites block light),
 * before the composite: the cascades top down into the two targets, and
 * cascade 0 left on UNIT_RC with the composite's Lo, Hi and 1 / open sky.
 *
 * The look follows the classic engine's settings: with no light at all a
 * pixel gets the classic full shade (Shadow darkness x Strength, tinted by
 * Coolness; Indoor shade of it in enclosed rooms), under the open sky the
 * classic lit warmth, linearly between.  Open rooms: the sky is the area's
 * shade tint, the sun its lift (Warmth), carrying SUN_SHARE of the open
 * sky's light, its disc as wide as Shadow softness makes the classic sun's.
 * Enclosed rooms: no sky; ambient past 96 px, and the lamps, scaled so one
 * lifts the picture by 0.18 x Strength at 24 px.  Bounce light: the last
 * composite on UNIT_RC during the passes (rc_glsl.h). */
#define RC_SUN_SHARE 0.6f
static void RunRadiance(const RlFrame *f, int k)
{
    const int align = RC_SPACING << (RC_CASCADES - 1);
    const float pi = 3.14159265f;
    const float *env[4];
    float vx, vy, K = f->lightK, lp[8 * 3], lc[8 * 3], sky[3], sun[3], amb[3], open[3];
    float ssun, sunTot, a, th, reach;
    int x0, y0, x1, y1, tw, th2, i, c, n, indoor;

    sRcOn = 0;
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_RC);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0);
    if (!f->light || !f->world || f->lightEngine != LIGHT_ENGINE_RC
        || !f->lightOcc || f->lightOccW <= 0 || f->lightOccH <= 0 || !EnsureRcProgram())
        return;
    vx = (float)(f->camX + f->viewX) + f->viewSubX / 256.0f;
    vy = (float)(f->camY + f->viewY) + f->viewSubY / 256.0f;
    x0 = (int)floorf((vx - RC_MARGIN) / align) * align;
    y0 = (int)floorf((vy - RC_MARGIN) / align) * align;
    x1 = (int)ceilf((vx + f->viewW + RC_MARGIN) / align) * align;
    y1 = (int)ceilf((vy + f->viewH + RC_MARGIN) / align) * align;
    tw = (x1 - x0) / RC_SPACING * 2;
    th2 = (y1 - y0) / RC_SPACING * 2;
    if (tw > sMaxTex || th2 > sMaxTex)
        return;
    if (!sTexRc[0] || tw != sRcW || th2 != sRcH) {
        for (i = 0; i < 2; i++) {
            if (sTexRc[i]) {
                G(glDeleteFramebuffers)(1, &sFboRc[i]);
                G(glDeleteTextures)(1, &sTexRc[i]);
            }
            G(glActiveTexture)(GL_TEXTURE0 + UNIT_RC);
            sTexRc[i] = MakeTex(GL_RG32UI, GL_RG_INTEGER, GL_UNSIGNED_INT, tw, th2);
            G(glBindTexture)(GL_TEXTURE_2D, 0);
            G(glActiveTexture)(GL_TEXTURE0);
            G(glGenFramebuffers)(1, &sFboRc[i]);
            G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboRc[i]);
            G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sTexRc[i], 0);
            if (G(glCheckFramebufferStatus)(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
                PortError("[katam-port] gpu: radiance cascade target incomplete");
                G(glDeleteProgram)(sProgRc);
                sProgRc = 0;
                return;
            }
        }
        sRcW = tw;
        sRcH = th2;
    }
    EnsureOcc(f);

    /* The light: what full shade and the open sky make of the picture. */
    FrameEnv(f, env);
    indoor = f->lightMode == RL_LIGHT_POINT;
    a = f->lightAngle * pi / 180.0f;
    th = atan2f(-cosf(a), -sinf(a));          /* towards the sun, world angle */
    ssun = 2.0f / ((1.0f + 16.0f * f->lightSoft) * pi / 180.0f);
    sunTot = 2.0f * atanf(ssun * pi) / ssun;   /* the lobe's light at peak 1 */
    for (i = 0; i < 3; i++) {
        float shadeC = (1.0f - f->lightShadow) * (1.0f + (env[1][i] - 1.0f) * f->lightCool);
        float S = indoor ? f->lightIndoor : 1.0f;
        float lo = 1.0f + (shadeC - 1.0f) * K * S;
        sRcLo[i] = lo < 0.1f ? 0.1f : lo;
        sRcHi[i] = indoor ? 1.0f : 1.0f + K * f->lightWarm * env[0][i] * 0.6f;
        if (indoor) {
            sky[i] = sun[i] = 0.0f;
            amb[i] = 1.0f;
            open[i] = 2.0f * pi;
        } else {
            sky[i] = 1.0f + (env[1][i] - 1.0f) * 0.6f;
            sun[i] = (1.0f + env[0][i] * 0.6f) * 2.0f * pi * RC_SUN_SHARE / (1.0f - RC_SUN_SHARE) / sunTot;
            amb[i] = 0.0f;
            open[i] = 2.0f * pi * sky[i] + sun[i] * sunTot;
        }
        sRcInv[i] = 1.0f / open[i];
    }
    if (indoor)
        ssun = 1.0f;
    n = 0;
    for (i = 0; i < f->numLights && i < RL_MAX_LIGHTS && n < 8; i++, n++) {
        float ang = 2.0f * RC_LAMP_R / 24.0f, mxc = 0.0f;
        int ch;
        for (ch = 0; ch < 3; ch++)
            if (f->lightCol[i][ch] > mxc) mxc = f->lightCol[i][ch];
        lp[n * 3 + 0] = f->lights[i][0];
        lp[n * 3 + 1] = f->lights[i][1];
        lp[n * 3 + 2] = RC_LAMP_R;
        for (ch = 0; ch < 3; ch++) {
            float span = sRcHi[ch] - sRcLo[ch];
            float col = mxc > 1e-3f ? f->lightCol[i][ch] / mxc : 1.0f;
            lc[n * 3 + ch] = 0.18f * K * col * open[ch] / ((span < 0.05f ? 0.05f : span) * ang);
        }
    }
    reach = f->lightCharReach < 8.0f ? 8.0f : f->lightCharReach > 96.0f ? 96.0f : f->lightCharReach;

    G(glUseProgram)(sProgRc);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_IN);
    G(glBindTexture)(GL_TEXTURE_2D, sTexObj);
    G(glActiveTexture)(GL_TEXTURE0);
    G(glUniform2i)(uROccG, sOccW, sOccH);
    G(glUniform3i)(uRObjG, f->viewW * k, f->viewH * k, k);
    G(glUniform2f)(uRObjW, vx, vy);
    G(glUniform2f)(uROrg, (float)x0, (float)y0);
    G(glUniform2i)(uRP0, (x1 - x0) / RC_SPACING, (y1 - y0) / RC_SPACING);
    G(glUniform2f)(uRS0E0, (float)RC_SPACING, RC_E0);
    /* Light into the ground: here the e-fold of light through the probe's
     * own ground (rc_glsl.h), 2.5 x the setting -- the classic map's 8 px
     * texels light about that far in, and blocks read as lit, not holes. */
    G(glUniform4f)(uRGround, f->lightDepth * 2.5f, f->lightSprShadow, reach, 0.0f);
    G(glUniform1i)(uRNumL, n);
    G(glUniform3fv)(uRLp, 8, lp);
    G(glUniform3fv)(uRLc, 8, lc);
    G(glUniform4f)(uRSky, sky[0], sky[1], sky[2], 0.5f);
    G(glUniform3f)(uRSun, sun[0], sun[1], sun[2]);
    G(glUniform2f)(uRSunP, th, ssun);
    G(glUniform3f)(uRAmb, amb[0], amb[1], amb[2]);
    /* Bounce: the last picture on UNIT_RC (cascade 0 goes there after);
     * a lit white wall gives back the open sky's mean radiance x Bounce. */
    {
        int ok = sPrevOk && f->lightBounce > 0.0f && sPrevW == sFboW && sPrevH == sFboH;
        float scale = (open[0] + open[1] + open[2]) / 3.0f / (2.0f * pi);
        G(glActiveTexture)(GL_TEXTURE0 + UNIT_RC);
        G(glBindTexture)(GL_TEXTURE_2D, ok ? sTexComp : 0);
        G(glActiveTexture)(GL_TEXTURE0);
        G(glUniform4f)(uRPrevG, sPrevWx, sPrevWy, (float)sPrevK, ok ? f->lightBounce * scale : 0.0f);
        G(glUniform2i)(uRPrevS, sPrevW, sPrevH);
    }
    G(glViewport)(0, 0, tw, th2);
    G(glBindVertexArray)(sVaoEmpty);
    for (c = RC_CASCADES - 1; c >= 0; c--) {
        int out = c & 1, top = c == RC_CASCADES - 1;
        G(glActiveTexture)(GL_TEXTURE0 + UNIT_RC_UP);
        G(glBindTexture)(GL_TEXTURE_2D, top ? 0 : sTexRc[out ^ 1]);
        G(glActiveTexture)(GL_TEXTURE0);
        G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboRc[out]);
        G(glUniform4i)(uRCasc, c, top, !top && c < RC_FIX, indoor ? RC_AMB_CASCADE : -1);
        G(glDrawArrays)(GL_TRIANGLES, 0, 3);
    }
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_RC_UP);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_IN);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_RC);
    G(glBindTexture)(GL_TEXTURE_2D, sTexRc[0]);
    G(glActiveTexture)(GL_TEXTURE0);
    sRcOrg[0] = (float)x0;
    sRcOrg[1] = (float)y0;
    sRcN[0] = (x1 - x0) / RC_SPACING;
    sRcN[1] = (y1 - y0) / RC_SPACING;
    sRcOn = 1;
}

void GlrDraw(const RlFrame *f)
{
    GlrDrawScaled(f, 1);
}

void GlrDrawScaled(const RlFrame *f, int k)
{
    GLint layer[16], valid[16], geom[16], scroll[16], hudRect[32], hudD[16];
    int bg, r, hudSep = sHudWant && f->world && f->numHud > 0;
    int which = hudSep ? SPR_WORLD : SPR_ALL;

    if (!sReady)
        return;
    if (k < 1) k = 1;
    while (k > 1 && (f->viewW * k > sMaxTex || f->viewH * k > sMaxTex))
        k--;
    EnsureTargets(f->viewW * k, f->viewH * k);
    G(glDisable)(GL_BLEND);
    G(glDisable)(GL_DEPTH_TEST);
    G(glDisable)(GL_SCISSOR_TEST);
    G(glDisable)(GL_CULL_FACE);

    /* Texture cache. */
    G(glActiveTexture)(GL_TEXTURE0 + 0);
    UploadVram(f->vram);
    G(glActiveTexture)(GL_TEXTURE0 + 1);
    G(glBindTexture)(GL_TEXTURE_2D, sTexPal);
    G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, 0, 512, 1, GL_RED_INTEGER, GL_UNSIGNED_SHORT, f->palette);
    G(glActiveTexture)(GL_TEXTURE0 + 2);
    G(glBindTexture)(GL_TEXTURE_2D, sTexLines);
    G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, 0, RL_LINE_WORDS / 4, RL_LINES, GL_RGBA_INTEGER, GL_INT, f->lines);
    G(glActiveTexture)(GL_TEXTURE0 + 5);
    UploadMaps(f);
    G(glActiveTexture)(GL_TEXTURE0 + 0);
    G(glBindTexture)(GL_TEXTURE_2D, sTexVram);
    G(glActiveTexture)(GL_TEXTURE0 + 1);
    G(glBindTexture)(GL_TEXTURE_2D, sTexPal);
    G(glActiveTexture)(GL_TEXTURE0 + 2);
    G(glBindTexture)(GL_TEXTURE_2D, sTexLines);
    /* The sprite targets must not be bound as textures while drawn into. */
    G(glActiveTexture)(GL_TEXTURE0 + 3);
    G(glBindTexture)(GL_TEXTURE_2D, 0);
    G(glActiveTexture)(GL_TEXTURE0 + 4);
    G(glBindTexture)(GL_TEXTURE_2D, 0);

    G(glActiveTexture)(GL_TEXTURE0 + UNIT_OBJN);
    G(glBindTexture)(GL_TEXTURE_2D, 0);

    /* The composite's uniforms first: the relief passes draw the layers
     * through it, and the sprite pass reads their result. */
    for (bg = 0; bg < 4; bg++) {
        const RlTileLayer *L = &f->layers[bg];
        int streamed = 0;

        if (L->streamed)
            streamed = ((L->map && sMapLen[bg]) ? 1 : 2)
                     | (L->wrapX == 1 ? 4 : 0) | (L->wrapX == 2 ? 16 : 0)
                     | (L->mirrorY ? 8 : 0);
        else if (L->picW > 0 || L->picH > 0)
            streamed = 32;
        layer[bg * 4 + 0] = L->enabled ? L->space : -1;
        layer[bg * 4 + 1] = streamed;
        layer[bg * 4 + 2] = L->shiftX * 256 + L->subX;
        layer[bg * 4 + 3] = L->shiftY * 256 + L->subY;
        valid[bg * 4 + 0] = L->validL;
        valid[bg * 4 + 1] = L->validR;
        valid[bg * 4 + 2] = L->validT;
        valid[bg * 4 + 3] = L->validB;
        geom[bg * 4 + 0] = streamed == 32 ? L->picW : L->mapW;
        geom[bg * 4 + 1] = streamed == 32 ? L->picH : L->mapH;
        geom[bg * 4 + 2] = sMapBase[bg];
        geom[bg * 4 + 3] = 0;
        scroll[bg * 4 + 0] = L->mapScrollX;
        scroll[bg * 4 + 1] = L->mapScrollY;
        scroll[bg * 4 + 2] = L->mapOffX;
        scroll[bg * 4 + 3] = L->mapOffY;
    }
    memset(hudRect, 0, sizeof(hudRect));
    memset(hudD, 0, sizeof(hudD));
    for (r = 0; r < f->numHud && r < 8; r++) {
        hudRect[r * 4 + 0] = f->hud[r].x0;
        hudRect[r * 4 + 1] = f->hud[r].y0;
        hudRect[r * 4 + 2] = f->hud[r].x1;
        hudRect[r * 4 + 3] = f->hud[r].y1;
        hudD[r * 2 + 0] = f->hud[r].dx;
        hudD[r * 2 + 1] = f->hud[r].dy;
    }
    G(glUseProgram)(sProgComp);
    G(glUniform4i)(uCView, f->viewX, f->viewY, f->viewW, f->viewH);
    G(glUniform4i)(uCSub, f->viewSubX, f->viewSubY, k, 0);
    G(glUniform4i)(uCContent, f->contentL, f->contentT, f->contentR, f->contentB);
    G(glUniform4iv)(uCLayer, 4, layer);
    G(glUniform4iv)(uCValid, 4, valid);
    G(glUniform4iv)(uCMapGeom, 4, geom);
    G(glUniform4iv)(uCMapScroll, 4, scroll);
    G(glUniform1i)(uCNumHud, f->numHud);
    G(glUniform4iv)(uCHudRect, 8, hudRect);
    G(glUniform2iv)(uCHudD, 8, hudD);
    G(glUniform1i)(uHPass, hudSep ? 1 : 0);
    UploadLight(f);
    PlanRelief(f);
    RunRelief();
    G(glUseProgram)(sProgComp);
    SetRelief(f);

    /* Pass 1: sprites. */
    DrawSprites(f, sFboObj, 0, f->numSprites, 0, which, f->viewW, f->viewH, k);
    DrawSprites(f, sFboObjWin, f->numSprites, f->numObjWin, 1, which, f->viewW, f->viewH, k);
    if (hudSep) {
        EnsureHudTargets();
        DrawSprites(f, sFboObjHud, 0, f->numSprites, 0, SPR_HUD, HUD_ATLAS_W, HUD_ATLAS_H, 1);
    }
    RunCharShadow(f, k);
    RunRadiance(f, k);

    /* Pass 2: composite. */
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboComp);
    G(glViewport)(0, 0, f->viewW * k, f->viewH * k);
    G(glUseProgram)(sProgComp);
    G(glActiveTexture)(GL_TEXTURE0 + 3);
    G(glBindTexture)(GL_TEXTURE_2D, sTexObj);
    G(glActiveTexture)(GL_TEXTURE0 + 4);
    G(glBindTexture)(GL_TEXTURE_2D, sTexObjWin);
    G(glActiveTexture)(GL_TEXTURE0 + 5);
    G(glBindTexture)(GL_TEXTURE_2D, sTexMap);
    G(glActiveTexture)(GL_TEXTURE0 + UNIT_OBJN);
    G(glBindTexture)(GL_TEXTURE_2D, sTexObjN);
    G(glActiveTexture)(GL_TEXTURE0);
    BindReliefView(f);
    G(glUniform4f)(uCCharShP, sCharShOn ? f->lightSprShadow : 0.0f, (float)CHARSH_CELL,
                   (float)sCharShW, (float)sCharShH);
    G(glUniform1i)(uCRcOn, sRcOn);
    if (sRcOn) {
        G(glUniform4f)(uCRcGeom, sRcOrg[0], sRcOrg[1], (float)RC_SPACING, 0.0f);
        G(glUniform2i)(uCRcN, sRcN[0], sRcN[1]);
        G(glUniform3f)(uCRcLo, sRcLo[0], sRcLo[1], sRcLo[2]);
        G(glUniform3f)(uCRcHi, sRcHi[0], sRcHi[1], sRcHi[2]);
        G(glUniform3f)(uCRcInv, sRcInv[0], sRcInv[1], sRcInv[2]);
    }
    G(glBindVertexArray)(sVaoEmpty);
    G(glDrawArrays)(GL_TRIANGLES, 0, 3);
    sPrevOk = f->world && f->light != NULL;
    sPrevWx = (float)(f->camX + f->viewX) + f->viewSubX / 256.0f;
    sPrevWy = (float)(f->camY + f->viewY) + f->viewSubY / 256.0f;
    sPrevK = k;
    sPrevW = f->viewW * k;
    sPrevH = f->viewH * k;

    /* The HUD layer: the same composite, region by region into the atlas,
     * HUD layer and HUD sprites only, at HUD coordinates. */
    if (hudSep) {
        G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboHud);
        G(glViewport)(0, 0, HUD_ATLAS_W, HUD_ATLAS_H);
        G(glClearColor)(0.0f, 0.0f, 0.0f, 0.0f);
        G(glClear)(GL_COLOR_BUFFER_BIT);
        G(glActiveTexture)(GL_TEXTURE0 + 3);
        G(glBindTexture)(GL_TEXTURE_2D, sTexObjHud);
        G(glUniform4i)(uCView, 0, 0, HUD_W, HUD_H);
        G(glUniform4i)(uCSub, 0, 0, 1, 0);
        G(glUniform1i)(uHPass, 2);
        for (r = 0; r < f->numHud && r < RL_MAX_HUD_REGIONS; r++) {
            const RlHudRegion *h = &f->hud[r];

            G(glViewport)(HudOrgX(r) + h->x0 - HUD_GUTTER, HudOrgY(r) + h->y0 - HUD_GUTTER,
                          h->x1 - h->x0 + 2 * HUD_GUTTER, h->y1 - h->y0 + 2 * HUD_GUTTER);
            G(glUniform1i)(uHSel, r);
            G(glUniform2i)(uHOrg, HudOrgX(r), HudOrgY(r));
            G(glDrawArrays)(GL_TRIANGLES, 0, 3);
        }
        memcpy(sHudReg, f->hud, sizeof(sHudReg));
        sHudNum = f->numHud;
    }
    sHudActive = hudSep;
    G(glBindVertexArray)(0);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    sLastW = f->viewW * k;
    sLastH = f->viewH * k;
    sSrcPic = 0;
}

static void EnsureColorTarget(GLuint *tex, GLuint *fbo, int *cw, int *ch, int w, int h)
{
    if (*tex && *cw == w && *ch == h)
        return;
    if (*tex) {
        G(glDeleteFramebuffers)(1, fbo);
        G(glDeleteTextures)(1, tex);
    }
    *tex = MakeTex(GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, w, h);
    G(glGenFramebuffers)(1, fbo);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, *fbo);
    G(glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, *tex, 0);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    *cw = w;
    *ch = h;
}

void GlrUploadPicture(const u32 *pixels, int w, int h)
{
    if (!sReady || w <= 0 || h <= 0)
        return;
    EnsureColorTarget(&sTexPic, &sFboPic, &sPicW, &sPicH, w, h);
    G(glActiveTexture)(GL_TEXTURE0);
    G(glBindTexture)(GL_TEXTURE_2D, sTexPic);
    G(glTexSubImage2D)(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    sSrcPic = 1;
    sHudActive = 0;
}

void GlrLastPresentRect(int dst[4])
{
    memcpy(dst, sLastDst, sizeof(sLastDst));
}

void GlrPresentHud(int fbW, int fbH, const int world[4], double scale, int smooth)
{
    int r;

    if (!GlrHudActive() || scale <= 0.0 || fbW <= 0 || fbH <= 0)
        return;
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    G(glViewport)(0, 0, fbW, fbH);
    G(glDisable)(GL_SCISSOR_TEST);
    G(glEnable)(GL_BLEND);
    G(glBlendFuncSeparate)(GL_ONE, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    G(glUseProgram)(sProgHud);
    G(glActiveTexture)(GL_TEXTURE0);
    G(glBindTexture)(GL_TEXTURE_2D, sTexHud);
    G(glUniform1i)(uBSharp, smooth && scale != (double)(int)scale);
    G(glUniform2f)(uBScale, (float)scale, (float)scale);
    G(glUniform2f)(uBTexSize, (float)HUD_ATLAS_W, (float)HUD_ATLAS_H);
    G(glBindVertexArray)(sVaoEmpty);
    for (r = 0; r < sHudNum; r++) {
        const RlHudRegion *h = &sHudReg[r];
        /* The HUD's origin for this region's anchor, whole pixels so the
         * regions of one corner share one pixel grid. */
        int fw = (int)(HUD_W * scale + 0.5), fh = (int)(HUD_H * scale + 0.5);
        int bx = h->anchorH == RL_ANCHOR_RIGHT ? world[0] + world[2] - fw
               : h->anchorH == RL_ANCHOR_CENTER ? world[0] + (world[2] - fw) / 2 : world[0];
        int by = h->anchorV == RL_ANCHOR_BOTTOM ? world[1] + world[3] - fh : world[1];
        double x0 = h->x0 - HUD_GUTTER, x1 = h->x1 + HUD_GUTTER;
        double y0 = h->y0 - HUD_GUTTER, y1 = h->y1 + HUD_GUTTER;
        double px0 = bx + x0 * scale, px1 = bx + x1 * scale;
        double py0 = by + y0 * scale, py1 = by + y1 * scale;

        G(glUniform4f)(uBDst, (float)(px0 / fbW * 2.0 - 1.0), (float)(1.0 - py0 / fbH * 2.0),
                       (float)(px1 / fbW * 2.0 - 1.0), (float)(1.0 - py1 / fbH * 2.0));
        G(glUniform4f)(uBSrc, (float)(HudOrgX(r) + x0), (float)(HudOrgY(r) + y0),
                       (float)(HudOrgX(r) + x1), (float)(HudOrgY(r) + y1));
        G(glDrawArrays)(GL_TRIANGLE_STRIP, 0, 4);
    }
    G(glBindVertexArray)(0);
    G(glDisable)(GL_BLEND);
}

int GlrSourceSize(int *w, int *h)
{
    if (!sReady)
        return 0;
    if (sSrcPic) {
        *w = sPicW; *h = sPicH;
        return sFboPic != 0;
    }
    *w = sLastW; *h = sLastH;
    return sFboComp != 0;
}

void GlrPresentRect(int fbW, int fbH, const int src[4], const int dst[4],
                    int smooth, const float bg[3])
{
    GLuint from = sSrcPic ? sFboPic : sFboComp;
    int sx = src[0], sy = src[1], sw = src[2], sh = src[3];
    int dx = dst[0], dw = dst[2], dh = dst[3];
    int gy = fbH - (dst[1] + dh);       /* GL rows count from the bottom */

    if (!sReady)
        return;
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    G(glDisable)(GL_SCISSOR_TEST);
    G(glViewport)(0, 0, fbW, fbH);
    G(glClearColor)(bg[0], bg[1], bg[2], 1.0f);
    G(glClear)(GL_COLOR_BUFFER_BIT);
    if (!from || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0)
        return;
    if (smooth) {
        /* Sharp bilinear: nearest up to the largest whole multiple that fits,
         * then linear the rest of the way -- crisp pixels, no shimmer. */
        int kx = dw / sw, ky = dh / sh, k = kx < ky ? kx : ky;

        if (k < 1) k = 1;
        if (k > 8) k = 8;
        if (sw * k != dw || sh * k != dh) {
            EnsureColorTarget(&sTexMid, &sFboMid, &sMidW, &sMidH, sw * k, sh * k);
            G(glBindFramebuffer)(GL_READ_FRAMEBUFFER, from);
            G(glBindFramebuffer)(GL_DRAW_FRAMEBUFFER, sFboMid);
            G(glBlitFramebuffer)(sx, sy, sx + sw, sy + sh, 0, 0, sw * k, sh * k,
                                 GL_COLOR_BUFFER_BIT, GL_NEAREST);
            G(glBindFramebuffer)(GL_READ_FRAMEBUFFER, sFboMid);
            G(glBindFramebuffer)(GL_DRAW_FRAMEBUFFER, 0);
            G(glBlitFramebuffer)(0, 0, sw * k, sh * k, dx, gy + dh, dx + dw, gy,
                                 GL_COLOR_BUFFER_BIT, GL_LINEAR);
            G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
            return;
        }
    }
    G(glBindFramebuffer)(GL_READ_FRAMEBUFFER, from);
    G(glBindFramebuffer)(GL_DRAW_FRAMEBUFFER, 0);
    G(glBlitFramebuffer)(sx, sy, sx + sw, sy + sh, dx, gy + dh, dx + dw, gy,
                         GL_COLOR_BUFFER_BIT, GL_NEAREST);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
}

void GlrFitRect(int w, int h, int vw, int vh, int dst[4])
{
    int s = w / vw < h / vh ? w / vw : h / vh, dw, dh;

    if (s >= 1) {
        dw = vw * s;
        dh = vh * s;
    } else if ((long)w * vh < (long)h * vw) {
        dw = w;
        dh = (int)((long)vh * w / vw);
    } else {
        dh = h;
        dw = (int)((long)vw * h / vh);
    }
    dst[0] = (w - dw) / 2;
    dst[1] = h - dh - (h - dh) / 2;     /* centred in GL's bottom-up rows */
    dst[2] = dw;
    dst[3] = dh;
}

void GlrPresent(int w, int h)
{
    int x0, y0, dw, dh;

    if (!sReady || !sFboComp)
        return;
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    G(glViewport)(0, 0, w, h);
    G(glClearColor)(0.0f, 0.0f, 0.0f, 1.0f);
    G(glClear)(GL_COLOR_BUFFER_BIT);
    GlrFitRect(w, h, sLastW, sLastH, sLastDst);
    x0 = sLastDst[0];
    dw = sLastDst[2];
    dh = sLastDst[3];
    y0 = h - (sLastDst[1] + dh);        /* GL rows count from the bottom */
    G(glBindFramebuffer)(GL_READ_FRAMEBUFFER, sFboComp);
    G(glBindFramebuffer)(GL_DRAW_FRAMEBUFFER, 0);
    /* View row 0 is the top of the picture and texture row 0; the window's
     * row 0 is its bottom.  Flip in the blit. */
    G(glBlitFramebuffer)(0, 0, sLastW, sLastH, x0, y0 + dh, x0 + dw, y0,
                         GL_COLOR_BUFFER_BIT, GL_NEAREST);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
}

int GlrReadback(u32 *out, int maxPixels, int *w, int *h)
{
    if (!sReady || !sFboComp || sLastW * sLastH > maxPixels)
        return 0;
    G(glBindFramebuffer)(GL_FRAMEBUFFER, sFboComp);
    G(glReadPixels)(0, 0, sLastW, sLastH, GL_RGBA, GL_UNSIGNED_BYTE, out);
    G(glBindFramebuffer)(GL_FRAMEBUFFER, 0);
    *w = sLastW;
    *h = sLastH;
    return 1;
}

#ifdef __cplusplus
}
#endif
