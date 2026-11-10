/* Normal maps for the game's own pixel art, generated on the GPU.
 *
 * A port of Sprite Normals (Hugo Duprez, MIT; third_party/spritefusion-
 * sprite-normals/README.katam has what was ported and how it differs).  The
 * crate turns a sprite into a normal map from two things: its silhouette
 * (a height that rises with the distance from the nearest transparent pixel,
 * ln-shaped so a blob gets a rounded rim and not a cone) and its painted
 * shading (Oklab lightness, blurred twice, read as surface detail).  A Sobel
 * of the sum is the normal.
 *
 * The game's art only exists in VRAM once the game has decoded it, so the
 * maps are made every frame, here: gl_renderer.c (RunRelief) draws every
 * on-screen sprite, unflipped and unrotated, and the part of every world
 * background layer around the view into an RGBA8 atlas with transparent
 * gutters, then these five full-atlas passes turn it into an RGBA8 normal
 * atlas (xyz * 0.5 + 0.5, OpenGL convention: +y up; alpha 1 where the art is
 * opaque).  Each step is the crate's, in the same order:
 *
 *   1  mask, Oklab lightness L, and the distance along the row to the
 *      nearest transparent pixel                      (color.rs, distance.rs)
 *   2  the exact distance (rows combined), the shape height from it;
 *      the horizontal halves of the two masked blurs of L      (relief.rs)
 *   3  horizontal half of the shape's blur; vertical halves of L's, divided
 *      out: detail = 6 * (0.7 fine + 0.3 broad)                 (field.rs)
 *   4  vertical half of the shape's blur, plus the detail: the height
 *   5  Sobel of the height -> normal, strength 1.5               (lib.rs)
 *
 * Intermediates are half floats packed in uint targets, because integer
 * formats are colour-renderable on every GLES 3.0 / WebGL2 without an
 * extension and float formats are not.  Outside uSize reads as transparent,
 * as the crate's zero padding does.
 */
#ifndef GUARD_PORT_RELIEF_GLSL_H
#define GUARD_PORT_RELIEF_GLSL_H

/* The distance to the silhouette is exact up to this many pixels and capped
 * there (the crate's is unbounded; see README.katam): 32 for sprites, which
 * makes every GBA sprite (64x64 at most, so 32 deep at most) the crate's
 * exactly; 12 for background layers, whose solid ground would otherwise be
 * one dome the size of the room.  Sprites are packed below uSprY0. */
#define RELIEF_R 12
#define RELIEF_R_SPRITE 32
/* What a pixel's normal can depend on, at most: RELIEF_R + the shape blur's
 * 4 + Sobel's 1, rounded up.  A layer's piece of the atlas reaches this far
 * past the view, so the view never sees the piece's own edge. */
#define RELIEF_MARGIN 20
/* Between two sprites: the blurs (4 each side) plus Sobel. */
#define RELIEF_GUTTER 10

#define RELIEF_STR2(x) #x
#define RELIEF_STR(x) RELIEF_STR2(x)

static const char *kRelCommon =
    "precision highp sampler2D;\n"
    "#define RR " RELIEF_STR(RELIEF_R) "\n"
    "#define RS " RELIEF_STR(RELIEF_R_SPRITE) "\n"
    "uniform ivec2 uSize;\n"
    "uniform int uSprY0;\n"
    "bool inside(ivec2 p) { return p.x >= 0 && p.y >= 0 && p.x < uSize.x && p.y < uSize.y; }\n"
    "int capAt(ivec2 p) { return p.y >= uSprY0 ? RS : RR; }\n"
    /* Gaussians, normalised over their taps (field.rs gaussian): sigma 0.6
     * (radius 2), 1.2 and 1.15 (radius 4).  Index |offset|. */
    "const float K06[3] = float[3](0.663818329, 0.165524567, 0.002566269);\n"
    "const float K12[5] = float[5](0.332490284, 0.234953687, 0.082907187, 0.014608604, 0.001285381);\n"
    "const float K115[5] = float[5](0.346925535, 0.237706882, 0.076464213, 0.011547439, 0.000818699);\n";

/* 1: albedo -> (row distance, L * a | a). */
static const char *kRel1Fs =
    "uniform sampler2D uAlb;\n"
    "out uvec2 oT;\n"
    "bool opaqueAt(ivec2 p) { return inside(p) && texelFetch(uAlb, p, 0).a > 0.03; }\n"
    "float lin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }\n"
    "float cbrt(float x) { return pow(max(x, 0.0), 1.0 / 3.0); }\n"
    "float oklabL(vec3 s) {\n"
    "  vec3 r = vec3(lin(s.r), lin(s.g), lin(s.b));\n"
    "  float l = cbrt(dot(r, vec3(0.41222146, 0.53633255, 0.051445995)));\n"
    "  float m = cbrt(dot(r, vec3(0.2119035, 0.6806995, 0.10739696)));\n"
    "  float q = cbrt(dot(r, vec3(0.08830246, 0.28171885, 0.6299787)));\n"
    "  return 0.21045426 * l + 0.7936178 * m - 0.004072047 * q;\n"
    "}\n"
    "void main() {\n"
    "  ivec2 p = ivec2(gl_FragCoord.xy);\n"
    "  vec4 c = texelFetch(uAlb, p, 0);\n"
    "  float hd = 0.0, a = 0.0, L = 0.0;\n"
    "  if (c.a > 0.03) {\n"
    "    int cap = capAt(p);\n"
    "    hd = float(cap + 1);\n"
    "    for (int i = 1; i <= RS; i++) {\n"
    "      if (i > cap) break;\n"
    "      if (!opaqueAt(p + ivec2(i, 0)) || !opaqueAt(p - ivec2(i, 0))) { hd = float(i); break; }\n"
    "    }\n"
    "    a = c.a;\n"
    "    L = oklabL(c.rgb);\n"
    "  }\n"
    "  oT = uvec2(packHalf2x16(vec2(hd, L * a)), packHalf2x16(vec2(a, 0.0)));\n"
    "}\n";

/* 2: -> (shape, H06(La) | H06(a), H12(La) | H12(a)). */
static const char *kRel2Fs =
    "uniform highp usampler2D uIn;\n"
    "out uvec4 oT;\n"
    "vec3 t1(ivec2 p) {\n"                 /* row distance, L*a, a */
    "  if (!inside(p)) return vec3(0.0);\n"
    "  uvec2 u = texelFetch(uIn, p, 0).rg;\n"
    "  vec2 x = unpackHalf2x16(u.x);\n"
    "  return vec3(x, unpackHalf2x16(u.y).x);\n"
    "}\n"
    "void main() {\n"
    "  ivec2 p = ivec2(gl_FragCoord.xy);\n"
    "  vec3 c = t1(p);\n"
    "  float shape = 0.0;\n"
    "  if (c.z > 0.0) {\n"
    /* The exact Euclidean distance, from the rows' (distance.rs edt). */
    "    int cap = capAt(p);\n"
    "    float best = c.x * c.x;\n"
    "    for (int dy = 1; dy <= RS; dy++) {\n"
    "      float d2 = float(dy * dy);\n"
    "      if (dy > cap || d2 >= best) break;\n"
    "      float u = t1(p + ivec2(0, dy)).x, v = t1(p - ivec2(0, dy)).x;\n"
    "      best = min(best, min(u * u, v * v) + d2);\n"
    "    }\n"
    "    float inset = max(min(sqrt(best), float(cap)) - 0.5, 0.0);\n"
    /* relief.rs: shape_strength * reach * ln(1 + inset / reach). */
    "    shape = 1.15 * 4.0 * log(1.0 + inset / 4.0);\n"
    "  }\n"
    "  vec4 h = vec4(0.0);\n"               /* H06(La) H06(a) H12(La) H12(a) */
    "  for (int i = -4; i <= 4; i++) {\n"
    "    vec3 u = t1(p + ivec2(i, 0));\n"
    "    int j = abs(i);\n"
    "    float w06 = j <= 2 ? K06[j] : 0.0, w12 = K12[j];\n"
    "    h += vec4(u.y * w06, u.z * w06, u.y * w12, u.z * w12);\n"
    "  }\n"
    "  oT = uvec4(packHalf2x16(vec2(shape, h.x)), packHalf2x16(vec2(h.y, h.z)),\n"
    "             packHalf2x16(vec2(h.w, 0.0)), 0u);\n"
    "}\n";

/* 3: -> (H115(shape), detail). */
static const char *kRel3Fs =
    "uniform highp usampler2D uIn;\n"
    "out uint oT;\n"
    "void main() {\n"
    "  ivec2 p = ivec2(gl_FragCoord.xy);\n"
    "  float hs = 0.0;\n"
    "  vec4 v = vec4(0.0);\n"               /* V06 H06(La), V06 H06(a), V12 ... */
    "  for (int i = -4; i <= 4; i++) {\n"
    "    int j = abs(i);\n"
    "    ivec2 q = p + ivec2(i, 0), r = p + ivec2(0, i);\n"
    "    if (inside(q)) hs += K115[j] * unpackHalf2x16(texelFetch(uIn, q, 0).r).x;\n"
    "    if (inside(r)) {\n"
    "      uvec4 u = texelFetch(uIn, r, 0);\n"
    "      vec2 a = unpackHalf2x16(u.r), b = unpackHalf2x16(u.g), c = unpackHalf2x16(u.b);\n"
    "      float w06 = j <= 2 ? K06[j] : 0.0;\n"
    "      v += vec4(a.y * w06, b.x * w06, b.y * K12[j], c.x * K12[j]);\n"
    "    }\n"
    "  }\n"
    /* field.rs masked_gaussian: numerator / max(denominator, 1e-8). */
    "  float fine = v.x / max(v.y, 1e-8), broad = v.z / max(v.w, 1e-8);\n"
    "  oT = packHalf2x16(vec2(hs, 6.0 * (0.7 * fine + 0.3 * broad)));\n"
    "}\n";

/* 4: -> the height, V115(H115(shape)) + detail, as float bits. */
static const char *kRel4Fs =
    "uniform highp usampler2D uIn;\n"
    "out uint oT;\n"
    "void main() {\n"
    "  ivec2 p = ivec2(gl_FragCoord.xy);\n"
    "  float s = 0.0;\n"
    "  for (int i = -4; i <= 4; i++) {\n"
    "    ivec2 q = p + ivec2(0, i);\n"
    "    if (inside(q)) s += K115[abs(i)] * unpackHalf2x16(texelFetch(uIn, q, 0).r).x;\n"
    "  }\n"
    "  oT = floatBitsToUint(s + unpackHalf2x16(texelFetch(uIn, p, 0).r).y);\n"
    "}\n";

/* 5: Sobel -> normal (field.rs sobel, lib.rs slopes_to_normal). */
static const char *kRel5Fs =
    "uniform highp usampler2D uIn;\n"
    "uniform sampler2D uAlb;\n"
    "out vec4 oN;\n"
    "float H(ivec2 p) { return inside(p) ? uintBitsToFloat(texelFetch(uIn, p, 0).r) : 0.0; }\n"
    "void main() {\n"
    "  ivec2 p = ivec2(gl_FragCoord.xy);\n"
    "  if (texelFetch(uAlb, p, 0).a <= 0.03) { oN = vec4(0.5, 0.5, 1.0, 0.0); return; }\n"
    /* Rows grow downwards, as the image's do. */
    "  float ul = H(p + ivec2(-1, -1)), u = H(p + ivec2(0, -1)), ur = H(p + ivec2(1, -1));\n"
    "  float l = H(p + ivec2(-1, 0)), r = H(p + ivec2(1, 0));\n"
    "  float dl = H(p + ivec2(-1, 1)), d = H(p + ivec2(0, 1)), dr = H(p + ivec2(1, 1));\n"
    "  float dx = (ur + 2.0 * r + dr - ul - 2.0 * l - dl) * 0.125;\n"
    "  float dy = (dl + 2.0 * d + dr - ul - 2.0 * u - ur) * 0.125;\n"
    "  vec3 n = normalize(vec3(-dx * 1.5, dy * 1.5, 1.0));\n"
    "  oN = vec4(n * 0.5 + 0.5, 1.0);\n"
    "}\n";

#endif /* GUARD_PORT_RELIEF_GLSL_H */
