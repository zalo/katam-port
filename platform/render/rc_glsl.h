/* Radiance cascades: the alternative lighting engine (Settings, Lighting,
 * Engine: Radiance cascades; gPortLightParams.engine).
 *
 * A 2D global illumination solve over the view, every frame, after
 *   Radiance Cascades: A Novel Approach to Calculating Global Illumination
 *   -- Alexander Sannikov
 * with its merge and the "bilinear fix" laid out as in the Shadertoy
 * implementations by fad (mtlBzX) and Suslik, and the sky's light over an
 * interval of directions in closed form from
 *   Analytic Direct Illumination -- Mathis, https://www.shadertoy.com/view/NttSW7
 *
 * The scene is the game's own: the room's collision cells (light.c sOcc,
 * 16 px: solid, slopes counted solid, the top 4 px of a jump-through
 * platform) block light; opaque world sprites block it within the character
 * shadow length of a probe (and not for a probe inside one, so a sprite is
 * lit, not black); the room's lamps (light.c, found in the art) are discs
 * that emit their colour.  A ray that leaves the last cascade's interval
 * unblocked sees the sky: Mathis's sky (brighter overhead) plus a sun lobe
 * at the area's sun angle, integrated over the ray's own interval of
 * directions -- so the sun's disc and penumbra are exact at any cascade
 * resolution.  Enclosed (point-lit) rooms have no sky; a ray that gets past
 * cascade uCasc.w unblocked sees a flat ambient instead (occlusion within
 * that range: corners, tunnels), and the lamps light the rest.
 *
 * Bounce: a ray stopped by a solid sees what the last picture showed just
 * inside it (the composite of the frame before, lit by the cascades then),
 * x Bounce light -- light off sunlit ground into shade, coloured by the
 * ground; one more bounce each frame.  Outside the last picture, none.
 *
 * Layout (world-locked: the probe grid's origin is a multiple of the top
 * cascade's spacing, so a still scene's light does not swim as the camera
 * scrolls): cascade i has (P0 >> i) probes a side, spaced S0 << i px, each
 * with (2 << i)^2 directions stored as a (2 << i) block of texels, so every
 * cascade is the same 2*P0 texture.  Direction j of D covers angles
 * [j, j+1] * 2pi / D, measured in world space (x right, y down).  Interval
 * i runs from E0 * 4^(i-1) (0 for cascade 0) to E0 * 4^i px.  A texel holds
 * the mean radiance over its directions (rgb) and the transmittance (a),
 * packed as half floats in RG32UI (no float colour buffers needed). */
#ifndef KATAM_RC_GLSL_H
#define KATAM_RC_GLSL_H

#define RC_CASCADES 5
#define RC_SPACING 2            /* cascade 0's probe spacing, world px          */
#define RC_E0 6.0f              /* cascade 0's interval, px (3 x the spacing)    */
#define RC_MARGIN 48            /* px of the world around the view also solved  */
#define RC_FIX 3                /* cascades 0..RC_FIX-1 use the bilinear fix    */
#define RC_LAMP_R 3.0f          /* a lamp's disc, px                            */
#define RC_AMB_CASCADE 2        /* enclosed rooms: ambient past 96 px unblocked */

static const char *kRcFs =
    "uniform usampler2D uUp;\n"       /* the cascade above (UNIT_RC_UP)       */
    "uniform usampler2D uOccT;\n"     /* collision cells (UNIT_OCC)           */
    "uniform usampler2D uObjT;\n"     /* the sprite pass's target (UNIT_IN)   */
    "uniform ivec2 uOccG;\n"          /* cells w, h                           */
    "uniform ivec3 uObjG;\n"          /* sprite target w, h, k                */
    "uniform vec2 uObjW;\n"           /* its top-left in the world, px        */
    "uniform vec2 uOrg;\n"            /* the probe grid's top-left, world px  */
    "uniform ivec2 uP0;\n"            /* cascade 0's probes                   */
    "uniform vec2 uS0E0;\n"           /* cascade 0's spacing, interval, px    */
    "uniform ivec4 uCasc;\n"          /* this cascade, top?, bilinear fix?, ambient cascade */
    "uniform vec4 uGround;\n"         /* light into ground px, sprite opacity, sprite reach px */
    "uniform int uNumL;\n"
    "uniform vec3 uLp[8];\n"          /* lamps: world x, y, radius            */
    "uniform vec3 uLc[8];\n"          /* lamps: radiance                      */
    "uniform vec4 uSky;\n"            /* sky radiance, overhead gradient      */
    "uniform vec3 uSun;\n"            /* the sun lobe's peak radiance          */
    "uniform vec2 uSunP;\n"           /* its angle (world), sqrt(sharpness)   */
    "uniform vec3 uAmb;\n"            /* enclosed rooms' ambient radiance      */
    "uniform sampler2D uPrevT;\n"     /* the last picture (UNIT_RC), for bounce */
    "uniform vec4 uPrevG;\n"          /* its top-left in the world, k, bounce x scale (0 none) */
    "uniform ivec2 uPrevS;\n"         /* its size                            */
    "out uvec2 oR;\n"
    "#define PI 3.14159265\n"
    "uvec2 pk(vec4 v) { return uvec2(packHalf2x16(v.rg), packHalf2x16(v.ba)); }\n"
    "vec4 upk(uvec2 u) { return vec4(unpackHalf2x16(u.x), unpackHalf2x16(u.y)); }\n"
    /* Above the room: air.  Below: solid.  Beside: its edge column goes on. */
    "int cellAt(ivec2 c) {\n"
    "  if (c.y < 0) return 0;\n"
    "  if (c.y >= uOccG.y) return 1;\n"
    "  c.x = clamp(c.x, 0, uOccG.x - 1);\n"
    "  return int(texelFetch(uOccT, c, 0).r);\n"
    "}\n"
    "bool solidAt(vec2 w) {\n"
    "  ivec2 c = ivec2(floor(w / 16.0));\n"
    "  int o = cellAt(c);\n"
    "  return o == 1 || (o == 2 && w.y - float(c.y) * 16.0 < 4.0);\n"
    "}\n"
    "bool sprAt(vec2 w) {\n"
    "  ivec2 q = ivec2(floor((w - uObjW) * float(uObjG.z)));\n"
    "  if (q.x < 0 || q.y < 0 || q.x >= uObjG.x || q.y >= uObjG.y) return false;\n"
    "  uint b = texelFetch(uObjT, q, 0).b;\n"
    "  return (b & 8u) != 0u && (b & 16u) == 0u;\n"
    "}\n"
    /* The sky's light over directions [a0, a1] (Mathis): Sky (1 - g sin a),
     * brighter overhead (y is down), plus Sun / (1 + S (a - sun)^2). */
    "vec3 skyInt(float a0, float a1) {\n"
    "  vec3 s = uSky.rgb * ((a1 - a0) + uSky.a * (cos(a1) - cos(a0)));\n"
    "  float u0 = mod(a0 - uSunP.x + PI, 2.0 * PI) - PI;\n"
    "  float u1 = u0 + (a1 - a0);\n"
    "  return s + uSun * (atan(uSunP.y * u1) - atan(uSunP.y * u0)) / uSunP.y;\n"
    "}\n"
    /* What the segment a -> b sees, for a probe at o: vec4(radiance, the
     * transmittance).  From inside solid ground (inS) light comes through
     * the probe's own ground fading by e every uGround.x px of it (beyond 6
     * of those, none), so the face of the ground is lit at its edges and
     * dark inside; any other solid blocks.  Inside a sprite (inP) sprites
     * do not block. */
    "vec4 trace(vec2 o, bool inS, bool inP, vec2 a, vec2 b) {\n"
    "  vec2 d = b - a;\n"
    "  float len = max(length(d), 1e-4), ao = length(a - o);\n"
    "  float sHit = 2.0;\n"
    "  vec3 rad = vec3(0.0);\n"
    "  for (int i = 0; i < 8; i++) {\n"
    "    if (i >= uNumL) break;\n"
    "    vec2 m = a - uLp[i].xy;\n"
    "    float A = dot(d, d), B = dot(m, d), C = dot(m, m) - uLp[i].z * uLp[i].z;\n"
    "    float disc = B * B - A * C;\n"
    "    if (disc < 0.0) continue;\n"
    "    float s = C <= 0.0 ? 0.0 : (-B - sqrt(disc)) / A;\n"
    "    if (s >= 0.0 && s <= 1.0 && s < sHit) { sHit = s; rad = uLc[i]; }\n"
    "  }\n"
    /* The cells, DDA, up to the nearest lamp. */
    "  float lam = max(uGround.x, 0.5), run = 0.0;\n"
    "  bool orig = inS;\n"
    "  if (inS && ao > 0.0) {\n"
    "    vec2 dn = (a - o) / ao;\n"
    "    float lim = min(ao, 6.0 * lam);\n"
    "    for (int i = 0; i < 40; i++) {\n"
    "      float t = (float(i) + 0.5) * 1.5;\n"
    "      if (t >= lim) break;\n"
    "      if (!solidAt(o + dn * t)) { orig = false; break; }\n"
    "      run = t;\n"
    "    }\n"
    "    if (orig) {\n"
    "      if (ao >= 6.0 * lam) return vec4(0.0);\n"
    "      run = ao;\n"
    "    }\n"
    "  }\n"
    "  float sMax = min(sHit, 1.0);\n"
    "  ivec2 c = ivec2(floor(a / 16.0));\n"
    "  ivec2 st = ivec2(d.x > 0.0 ? 1 : -1, d.y > 0.0 ? 1 : -1);\n"
    "  vec2 inv = vec2(abs(d.x) > 1e-5 ? 1.0 / abs(d.x) : 1e9, abs(d.y) > 1e-5 ? 1.0 / abs(d.y) : 1e9);\n"
    "  vec2 nb = vec2(c + max(st, ivec2(0))) * 16.0;\n"
    "  vec2 tm = abs(nb - a) * inv, td = 16.0 * inv;\n"
    "  float s0 = 0.0;\n"
    "  for (int i = 0; i < 220; i++) {\n"
    "    float s1 = min(min(tm.x, tm.y), sMax);\n"
    "    int oc = cellAt(c);\n"
    "    if (oc != 0) {\n"
    "      float lo = s0, hi = s1;\n"
    "      if (oc == 2) {\n"
    "        float top = float(c.y) * 16.0;\n"
    "        if (abs(d.y) < 1e-5) { if (a.y < top || a.y >= top + 4.0) lo = 2.0; }\n"
    "        else {\n"
    "          float q0 = (top - a.y) / d.y, q1 = (top + 4.0 - a.y) / d.y;\n"
    "          lo = max(lo, min(q0, q1)); hi = min(hi, max(q0, q1));\n"
    "        }\n"
    "      }\n"
    "      if (lo < hi) {\n"
    "        if (!orig) { sHit = lo; rad = vec3(0.0); break; }\n"
    "        run += (hi - lo) * len;\n"
    "        if (run >= 6.0 * lam) { sHit = lo; rad = vec3(0.0); break; }\n"
    "      } else orig = false;\n"
    "    } else orig = false;\n"
    "    if (s1 >= sMax) break;\n"
    "    if (c.y < 0 && d.y <= 0.0) break;\n"     /* over the room, rising: sky */
    "    if (tm.x < tm.y) { c.x += st.x; tm.x += td.x; } else { c.y += st.y; tm.y += td.y; }\n"
    "    s0 = s1;\n"
    "  }\n"
    "  if (sHit <= 1.0 && uPrevG.w > 0.0 && rad == vec3(0.0)) {\n"
    "    ivec2 q = ivec2(floor((a + d * sHit + d / len - uPrevG.xy) * uPrevG.z));\n"
    "    if (q.x >= 0 && q.y >= 0 && q.x < uPrevS.x && q.y < uPrevS.y)\n"
    "      rad = texelFetch(uPrevT, q, 0).rgb * uPrevG.w;\n"
    "  }\n"
    "  vec4 r = vec4(rad, sHit <= 1.0 ? 0.0 : 1.0) * exp(-run / lam);\n"
    /* Sprites, near the probe only: a blocked ray counts less the further
     * off its sprite is, so a character's shadow fades along its length. */
    "  float sEnd = min(min(sHit, 1.0), (uGround.z - ao) / len);\n"
    "  if (uGround.y > 0.0 && !inP && sEnd > 0.0) {\n"
    "    float stp = 1.5 / len;\n"
    "    for (int i = 0; i < 64; i++) {\n"
    "      float s = (float(i) + 0.5) * stp;\n"
    "      if (s > sEnd) break;\n"
    "      if (sprAt(a + d * s)) {\n"
    "        r *= 1.0 - uGround.y * (1.0 - 0.9 * (ao + s * len) / uGround.z);\n"
    "        break;\n"
    "      }\n"
    "    }\n"
    "  }\n"
    "  return r;\n"
    "}\n"
    "vec2 dirOf(float a) { return vec2(cos(a), sin(a)); }\n"
    "void main() {\n"
    "  ivec2 px = ivec2(gl_FragCoord.xy);\n"
    "  int ci = uCasc.x, B = 2 << ci;\n"
    "  ivec2 pr = px / B, dd = px - pr * B;\n"
    "  int j = dd.y * B + dd.x;\n"
    "  float da = 2.0 * PI / float(B * B);\n"
    "  float sp = uS0E0.x * float(1 << ci);\n"
    "  vec2 P = uOrg + (vec2(pr) + 0.5) * sp;\n"
    "  float t0 = ci == 0 ? 0.0 : uS0E0.y * float(1 << (2 * ci - 2));\n"
    "  float t1 = uS0E0.y * float(1 << (2 * ci));\n"
    "  bool inS = solidAt(P), inP = sprAt(P);\n"
    "  vec3 amb = uCasc.w == ci ? uAmb : vec3(0.0);\n"
    "  bool top = uCasc.y != 0, fix = !top && uCasc.z != 0;\n"
    "  int B1 = B * 2;\n"
    "  float sp1 = sp * 2.0;\n"
    "  ivec2 n1 = max(uP0 >> (ci + 1), ivec2(1));\n"
    "  vec2 f = (P - uOrg) / sp1 - 0.5;\n"
    "  ivec2 b0 = ivec2(floor(f));\n"
    "  vec2 w = f - vec2(b0);\n"
    "  vec4 W = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y);\n"
    "  vec4 acc = vec4(0.0);\n"
    "  /* One ray (the top cascade: then the sky; the plain merge: then the mean\n"
    "   * of the four probes above), or with the bilinear fix sixteen -- for each\n"
    "   * of the four probes above and its four directions under ours, from our\n"
    "   * probe to where that probe's interval starts, then its light. */\n"
    "  int nr = fix ? 16 : 1;\n"
    "  for (int r = 0; r < 16; r++) {\n"
    "    if (r >= nr) break;\n"
    "    int s = r >> 2, k = r & 3, jj = 4 * j + s;\n"
    "    ivec2 q = clamp(b0 + ivec2(k & 1, k >> 1), ivec2(0), n1 - 1);\n"
    "    vec2 dir = fix ? dirOf((float(jj) + 0.5) * da * 0.25) : dirOf((float(j) + 0.5) * da);\n"
    "    vec2 end = fix ? uOrg + (vec2(q) + 0.5) * sp1 + dir * t1 : P + dir * t1;\n"
    "    vec4 n = trace(P, inS, inP, P + dir * t0, end);\n"
    "    vec4 far = vec4(0.0);\n"
    "    if (top) far = vec4(skyInt(float(j) * da, float(j + 1) * da) / da, 1.0);\n"
    "    else if (n.a > 0.0) {\n"
    "      if (fix) far = upk(texelFetch(uUp, q * B1 + ivec2(jj % B1, jj / B1), 0).rg);\n"
    "      else\n"
    "        for (int m = 0; m < 16; m++) {\n"
    "          ivec2 qm = clamp(b0 + ivec2(m & 1, (m >> 1) & 1), ivec2(0), n1 - 1);\n"
    "          int jm = 4 * j + (m >> 2);\n"
    "          far += W[m & 3] * 0.25 * upk(texelFetch(uUp, qm * B1 + ivec2(jm % B1, jm / B1), 0).rg);\n"
    "        }\n"
    "    }\n"
    "    float wt = fix ? W[k] * 0.25 : 1.0;\n"
    "    acc += wt * vec4(n.rgb + n.a * (far.rgb + amb), n.a * far.a);\n"
    "  }\n"
    "  oR = pk(acc);\n"
    "}\n";

#endif
