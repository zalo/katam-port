/* Building the render list: game-side hooks and the per-frame assembly.
 *
 * Two halves with different rules.
 *
 * The hooks (PortRlEmitSprite, PortRlCommitSprites, PortRlCommitScreen,
 * PortRlHudScope) run *inside the simulation*, called from game code.  They
 * read game memory and write host memory and nothing else -- no game global,
 * no task, no queue, no OAM.  If they did, the simulation would depend on
 * whether a renderer is attached and netplay determinism would be gone.  The
 * regression harness runs with them on to prove it.
 *
 * PortRlBuildFrame runs at present time, outside the simulation, and turns
 * (console memory + the state the hooks committed) into an RlFrame.
 *
 * Timing.  The game's frame is: logic (TasksExec, where DisplaySprite and the
 * camera run) -> VBlankIntrWait (present: the PPU draws what was committed
 * one UpdateScreen ago) -> UpdateScreen (shadow registers, OAM and the queued
 * tilemap refills go out).  So the frame presented at N shows the logic of
 * N-1, and the list has to be built from the state as of the *commit*, not
 * from the live game structures, which are already a frame ahead.  Reading
 * `bg->scrollX` live is a one-frame seam error at the edge of the streamed
 * window, which is what the old widescreen path did.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "port/port.h"
#include "gba/gba.h"
#include "global.h"
#include "main.h"
#include "data.h"
#include "bg.h"
#include "sprite.h"
#include "task.h"
#include "hud.h"
#include "kirby.h"
#include "render/render_list.h"

#ifdef __cplusplus
extern "C" {
#endif

int gPortRlEnabled;

#define RL_MAX_SHAKE 16          /* px; see sScreen.shakeX                     */

/* --- the committed screen (see PortRlCommitScreen) ----------------------- */

typedef struct {
    u32 tilesVram, tilemapVram;
    u32 map;
    u16 w, h, offX, offY, unk22, unk24, cols, rows, flags;
    u16 scrollX, scrollY;
} BgSnap;

static struct {
    int valid;
    u16 room;
    u16 roomFlags;
    BgSnap bg[3];                /* LevelInfo.unkC0[0..2]                     */
    s32 rectL, rectT, rectR, rectB;  /* camera rectangle, world pixels         */
    s32 factor[3][2];            /* 8.8, per record                          */
    u32 serial;
    /* For PortRlPresentFrame: the exact positions behind the whole pixels.
     * recFp: each record's scroll in 1/256 px, the record's own whole-pixel
     * scroll (offX * 8 + scrollX) plus the fraction the game dropped (the
     * camera's for the room, altViewport's for the two parallax records);
     * just the whole pixel when the fraction cannot be proven to belong to
     * it.  kirby: each player's 8.8 position, offset as the room layer is
     * (a camera shake moves the room, not the sprites), and per sprite
     * struct whether its anchor is that position's whole pixel. */
    s32 recFp[3][2];
    s32 camVpX, camVpY;          /* viewportPosition, 8.8                     */
    /* A camera shake (RequestScreenShake -> viewportModX/Y_44/46, added to the
     * room's scroll only by sub_080019F8): the room scroll minus the camera's
     * whole pixel.  Sprites and the parallax layers do not shake on the GBA.
     * Larger offsets than a shake are not one (the vertical auto-scroll wrap
     * reuses viewportModY_46) and read as 0. */
    s32 shakeX, shakeY;
    s32 kirbyFp[4][2];
    /* Per sprite struct (base.sprite, sprites[0], sprites[1]): whether its
     * anchor is that position's pixel, rounded either way the game does it
     * -- (x >> 8) - (camera >> 8) for objects, (x - camera) >> 8 for Kirby. */
    u8 kirbyOk[4][3];
} sScreen;

/* --- sprite emission ----------------------------------------------------- */

typedef struct {
    RlSprite s;
    u8 z;                /* the OAM link layer, (unk14 >> 6) & 0x1F          */
    u8 inOam;            /* the game wrote this one to its OAM pool         */
    const void *owner;   /* the struct Sprite it came from                   */
    s32 ax, ay;          /* its anchor (sprite->x/y as drawn), for matching  */
} PendingSprite;

typedef struct {
    u32 vramOff;         /* byte offset into VRAM                           */
    const u8 *src;
    u32 len;
} TilePatch;

#define MAX_PATCHES 256

static PendingSprite sEmit[RL_MAX_SPRITES];
static u32 sNumEmit, sEmitDropped;
static TilePatch sEmitPatch[MAX_PATCHES];
static u32 sNumEmitPatch;

static PendingSprite sCommitted[RL_MAX_SPRITES];
static u32 sNumCommitted;
static TilePatch sCommitPatch[MAX_PATCHES];
static u32 sNumCommitPatch;
static u32 sCommitSerial;

static s32 SignExtend(s32 v, int bits)
{
    s32 m = 1 << (bits - 1);
    v &= (1 << bits) - 1;
    return (v ^ m) - m;
}

/* Is this one of the HUD's own sprites?  They live in the gameplay HUD
 * task's struct (struct GameplayHud.unk20, hud.c), so the address says so
 * without the game having to. */
static int IsHudSprite(const struct Sprite *sprite)
{
    uintptr_t task = (uintptr_t)(struct Task *)gGameplayHudTask;
    uintptr_t base, p = (uintptr_t)sprite;

    if (task < GBA_IWRAM_BASE || task >= GBA_IWRAM_BASE + GBA_IWRAM_SIZE)
        return 0;
    base = (uintptr_t)TaskGetStructPtr((struct Task *)task);
    return p >= base + offsetof(struct GameplayHud, unk20)
        && p < base + sizeof(struct GameplayHud);
}

/* The tiles a "full" sprite frame wants uploaded, as bg.c-style patches into
 * a renderer-side copy of OBJ VRAM.  The game uploads them only for a sprite
 * that passed its own on-screen test, so a sprite in the widened margin would
 * otherwise show whatever frame it last had on screen.  Same source list and
 * the same coalescing as DisplaySprite's queue, written to host memory. */
static void EmitTilePatches(const struct Sprite *sprite, union SpriteAttributes spriteAttrs)
{
    const s32 *list;
    const u8 *base, *run, *next;
    u32 tile, count, i, runLen, idx;
    s32 dst;

    idx = spriteAttrs.full->unkC & 0xFFFFFF;
    count = spriteAttrs.full->unkC >> 24;
    list = gSpriteTables->unk18 + idx;
    if (list[0] >= 0) {
        tile = 0x20;
        const void *v = gSpriteTables->tiles4bpp;
        base = (const u8 *)v;
    } else {
        tile = 0x40;
        const void *v = gSpriteTables->tiles8bpp;
        base = (const u8 *)v;
    }
    dst = (s32)sprite->tilesVram;
    if (dst < 0x06010000 || dst >= 0x06018000)
        return;
    runLen = tile;
    run = base + list[0] * tile;
    for (i = 1; i <= count; i++) {
        next = (i < count) ? base + list[i] * tile : NULL;
        if (next != NULL && run + runLen == next) {
            runLen += tile;
            continue;
        }
        if (sNumEmitPatch < MAX_PATCHES
            && (u32)(dst - 0x06000000) + runLen <= 0x18000) {
            sEmitPatch[sNumEmitPatch].vramOff = (u32)(dst - 0x06000000);
            sEmitPatch[sNumEmitPatch].src = run;
            sEmitPatch[sNumEmitPatch].len = runLen;
            sNumEmitPatch++;
        }
        dst += runLen;
        runLen = tile;
        run = next;
    }
}

/* DisplaySprite and sub_081564D8, minus every side effect.
 *
 * The arithmetic is the game's, line for line, so that the attributes agree
 * with what lands in OAM -- PortRlBuildFrame checks that they do, every frame,
 * and falls back to OAM if not.  The differences: positions are kept as s32
 * instead of being masked to 9 and 8 bits, the 240x160 cull and the 128-entry
 * pool are recorded rather than obeyed, and the subframe offsets are sign
 * extended (DisplaySprite adds them unsigned and lets the mask sort it out;
 * sub_081564D8 sign extends explicitly -- same low bits either way). */
void PortRlEmitSprite(const struct Sprite *sprite, int variant)
{
    union SpriteAttributes spriteAttrs;
    s32 x, y, w, h, ax, ay;
    u16 a0bits = 0, a1bits = 0, a2bits;
    int vflip = 0, hflip = 0, accepted, k, n;
    s32 pool;
    const u16 *oamData;
    int uploadDone, hud;

    if (!gPortRlEnabled || sprite->unk4 == -1)
        return;
    hud = IsHudSprite(sprite);

    if (!(sprite->unk4 >> 28))
        spriteAttrs.sub = &gSpriteTables->attrs[sprite->animId].sub[sprite->unk4];
    else
        spriteAttrs.full = &gSpriteTables->attrs[sprite->animId].full[sprite->unk4];

    x = sprite->x;
    y = sprite->y;
    if (sprite->unk8 & 0x20000) {
        x -= gUnk_030023F4.unk0;
        y -= gUnk_030023F4.unk2;
    }
    ax = x;                 /* the anchor, before the frame's offsets */
    ay = y;
    w = spriteAttrs.sub->width;
    h = spriteAttrs.sub->height;
    if (sprite->unk8 & 0x20) {
        a0bits |= 0x100;
        a1bits |= (sprite->unk8 & 0x1F) << 9;
        if (sprite->unk8 & 0x40) {
            x -= spriteAttrs.sub->width >> 1;
            y -= spriteAttrs.sub->height >> 1;
            w <<= 1;
            h <<= 1;
            a0bits |= 0x200;
        }
    } else {
        if (sprite->unk8 & 0x800)
            y -= h - spriteAttrs.sub->offsetY;
        else
            y -= spriteAttrs.sub->offsetY;
        if (sprite->unk8 & 0x400)
            x -= w - spriteAttrs.sub->offsetX;
        else
            x -= spriteAttrs.sub->offsetX;
        if (((sprite->unk8 >> 11) & 1) != (spriteAttrs.sub->bitfield >> 15))
            vflip = 1;
        if (((spriteAttrs.sub->bitfield >> 14) ^ (sprite->unk8 >> 10)) & 1)
            hflip = 1;
    }
    a0bits |= (sprite->unk8 & 0x180) * 8;
    a2bits = (u16)(((sprite->palId << 12) | ((sprite->unk8 & 0x3000) >> 2)) & 0xFFFF);

    accepted = !w || (x + w >= gPortOamMinX && x <= gPortOamMaxX
                      && h + y >= gPortOamMinY && y <= gPortOamMaxY);
    pool = gUnk_030024F0;              /* entries the pool has handed out */
    if (pool > 128) pool = 128;
    oamData = gSpriteTables->oamData[sprite->animId];
    n = spriteAttrs.sub->numSubframes;
    uploadDone = accepted;

    for (k = 0; k < n; k++) {
        const u16 *t = &oamData[3 * ((spriteAttrs.sub->bitfield & 0x3FFF) + k)];
        u16 t0 = t[0], t1 = t[1], t2 = t[2];
        s32 x1 = SignExtend(t1 & 0x1FF, 9);
        s32 y1 = SignExtend(t0 & 0xFF, 8);
        u32 shapeAndSize = ((t0 & 0xC000) >> 12) | ((t1 & 0xC000) >> 14);
        u16 a0 = (u16)(t0 & 0xFE00), a1 = (u16)(t1 & 0xFE00), a2 = t2;
        int inOam;
        PendingSprite *p;

        if (vflip) {
            a1 ^= 0x2000;
            y1 = h - gUnk_08D6084C[shapeAndSize][1] - y1;
        }
        if (hflip) {
            a1 ^= 0x1000;
            x1 = w - gUnk_08D6084C[shapeAndSize][0] - x1;
        }
        a0 |= a0bits;
        a1 |= a1bits;
        a2 |= a2bits;
        if (a0 & 0x2000)
            a2 += a2 & 0x3FF;
        a2 += (u16)((sprite->tilesVram - 0x6010000u) >> 5);

        /* The pool hands out 128 entries; past that the game returns from
         * the call, skipping the rest of the subframes and the tile upload. */
        if (variant == 0) {
            int want = accepted;
            inOam = want && pool < 128;
            if (want) {
                if (pool < 128) pool++;
                else uploadDone = 0;
            }
        } else {
            int want = accepted
                && (y + y1 + gUnk_08D6084C[shapeAndSize][1] >= gPortOamMinY
                    && y + y1 <= gPortOamMaxY)
                && (x + x1 + gUnk_08D6084C[shapeAndSize][0] >= gPortOamMinX
                    && x + x1 <= gPortOamMaxX);
            inOam = want && pool < 128;
            if (want) {
                if (pool < 128) pool++;
                else uploadDone = 0;
            }
        }

        if (sNumEmit >= RL_MAX_SPRITES) {
            sEmitDropped++;
            continue;
        }
        p = &sEmit[sNumEmit++];
        p->s.x = x + x1;
        p->s.y = y + y1;
        p->s.attr0 = a0;
        p->s.attr1 = a1;
        p->s.attr2 = a2;
        p->s.space = hud ? RL_SPACE_HUD : RL_SPACE_WORLD;
        p->s.anchor = 0;
        p->s.pa = 0x100; p->s.pb = 0; p->s.pc = 0; p->s.pd = 0x100;
        p->z = (u8)((sprite->unk14 & 0x7C0) >> 6);
        if (p->z > 0x1F) p->z = 0x1F;
        p->inOam = (u8)inOam;
        p->owner = sprite;
        p->ax = ax;
        p->ay = ay;
    }

    if ((sprite->unk4 >> 28) == 1 && (sprite->unk8 & 0x4000000) && !uploadDone)
        EmitTilePatches(sprite, spriteAttrs);
}

/* DrawToOamBuffer walks the 32 link layers in order and each layer in the
 * order its sprites were submitted: a stable sort by layer.  The committed
 * list is that order, with the sprites the game did not write kept in place. */
/* --- pop-in census (KATAM_RL_POPSTAT=1) -----------------------------------
 *
 * The game creates objects inside a window 48 pixels beyond the 240x160
 * screen and destroys them beyond the same margin; a wider view sees past
 * that.  Changing the game's windows changes the simulation, which this
 * renderer must not do, so instead it counts: every frame, which sprite
 * owners (struct Sprite addresses) appeared or vanished, and where.  An
 * appearance inside the view but outside the 240x160 screen is an object
 * popping in where a player can see it.  Printed at exit. */
#define POP_MAX 512
static struct { const void *owner; s32 cx, cy; } sPopPrev[POP_MAX], sPopCur[POP_MAX];
static int sPopPrevN, sPopEnabled = -1;
static u32 sPopFrames, sPopFramesWithMargin;
static u32 sPopAppearNative, sPopAppearMargin, sPopVanishNative, sPopVanishMargin;
static u32 sPopMarginHist[8];   /* by distance past the screen edge, 16px bins */
static s32 sPopViewX, sPopViewY, sPopViewW = PORT_SCREEN_W, sPopViewH = PORT_SCREEN_H;

static int PopInView(s32 x, s32 y)
{
    return x >= sPopViewX && x < sPopViewX + sPopViewW
        && y >= sPopViewY && y < sPopViewY + sPopViewH;
}

static int PopInScreen(s32 x, s32 y)
{
    return x >= 0 && x < PORT_SCREEN_W && y >= 0 && y < PORT_SCREEN_H;
}

static s32 PopDistance(s32 x, s32 y)
{
    s32 d = 0;
    if (x < 0) d = -x;
    if (x >= PORT_SCREEN_W && x - PORT_SCREEN_W + 1 > d) d = x - PORT_SCREEN_W + 1;
    if (y < 0 && -y > d) d = -y;
    if (y >= PORT_SCREEN_H && y - PORT_SCREEN_H + 1 > d) d = y - PORT_SCREEN_H + 1;
    return d;
}

static u16 sPopRoom = 0xFFFF;
static u32 sPopSettle;

static void PopCensus(void)
{
    int n = 0, i, j, margin = 0, count;

    /* A room change makes everything appear at once; that is not pop-in.
     * Half a second for the transition to finish. */
    if (sScreen.room != sPopRoom || !sScreen.valid) {
        sPopRoom = sScreen.valid ? sScreen.room : 0xFFFF;
        sPopSettle = 30;
    }
    count = sPopSettle == 0;
    if (sPopSettle)
        sPopSettle--;

    for (i = 0; i < (int)sNumEmit && n < POP_MAX; i++) {
        const PendingSprite *p = &sEmit[i];
        if (p->s.space != RL_SPACE_WORLD)
            continue;
        for (j = 0; j < n; j++)
            if (sPopCur[j].owner == p->owner)
                break;
        if (j < n)
            continue;
        sPopCur[n].owner = p->owner;
        sPopCur[n].cx = p->s.x + 8;
        sPopCur[n].cy = p->s.y + 8;
        n++;
    }
    for (i = 0; i < n; i++) {
        for (j = 0; j < sPopPrevN; j++)
            if (sPopPrev[j].owner == sPopCur[i].owner)
                break;
        if (j < sPopPrevN)
            continue;
        if (!count)
            continue;
        if (PopInScreen(sPopCur[i].cx, sPopCur[i].cy))
            sPopAppearNative++;
        else if (PopInView(sPopCur[i].cx, sPopCur[i].cy)) {
            s32 d = PopDistance(sPopCur[i].cx, sPopCur[i].cy) / 16;
            sPopAppearMargin++;
            sPopMarginHist[d > 7 ? 7 : d]++;
            margin = 1;
        }
    }
    for (j = 0; j < sPopPrevN; j++) {
        for (i = 0; i < n; i++)
            if (sPopPrev[j].owner == sPopCur[i].owner)
                break;
        if (i < n || !count)
            continue;
        if (PopInScreen(sPopPrev[j].cx, sPopPrev[j].cy))
            sPopVanishNative++;
        else if (PopInView(sPopPrev[j].cx, sPopPrev[j].cy)) {
            sPopVanishMargin++;
            margin = 1;
        }
    }
    memcpy(sPopPrev, sPopCur, (size_t)n * sizeof(sPopCur[0]));
    sPopPrevN = n;
    sPopFrames += (u32)count;
    sPopFramesWithMargin += (u32)margin;
}

void PortRlReportPopIn(void)
{
    if (sPopEnabled != 1)
        return;
    PortLog("[katam-port] pop-in census, view %dx%d: %u frames (room entries "
            "excluded), %u with an object appearing or vanishing in the margin past 240x160", (int)sPopViewW,
            (int)sPopViewH, (unsigned)sPopFrames, (unsigned)sPopFramesWithMargin);
    PortLog("[katam-port]   appear: %u on the 240x160 screen, %u in the margin; "
            "vanish: %u on screen, %u in the margin", (unsigned)sPopAppearNative,
            (unsigned)sPopAppearMargin, (unsigned)sPopVanishNative,
            (unsigned)sPopVanishMargin);
    PortLog("[katam-port]   margin appearances by distance past the screen edge "
            "(16px bins): %u %u %u %u %u %u %u %u",
            (unsigned)sPopMarginHist[0], (unsigned)sPopMarginHist[1],
            (unsigned)sPopMarginHist[2], (unsigned)sPopMarginHist[3],
            (unsigned)sPopMarginHist[4], (unsigned)sPopMarginHist[5],
            (unsigned)sPopMarginHist[6], (unsigned)sPopMarginHist[7]);
}

void PortRlCommitSprites(void)
{
    u32 counts[33];
    u32 i;

    if (!gPortRlEnabled)
        return;
    if (sPopEnabled < 0)
        sPopEnabled = getenv("KATAM_RL_POPSTAT") != NULL;
    if (sPopEnabled)
        PopCensus();
    memset(counts, 0, sizeof(counts));
    for (i = 0; i < sNumEmit; i++)
        counts[sEmit[i].z + 1]++;
    for (i = 1; i < 33; i++)
        counts[i] += counts[i - 1];
    for (i = 0; i < sNumEmit; i++)
        sCommitted[counts[sEmit[i].z]++] = sEmit[i];
    sNumCommitted = sNumEmit;
    memcpy(sCommitPatch, sEmitPatch, sNumEmitPatch * sizeof(TilePatch));
    sNumCommitPatch = sNumEmitPatch;
    sNumEmit = 0;
    sNumEmitPatch = 0;
    sCommitSerial++;
}

/* --- screen commit ------------------------------------------------------- */

void PortRlCommitScreen(void)
{
    struct LevelInfo *li;
    int i;

    if (!gPortRlEnabled)
        return;
    li = &gCurLevelInfo[gLocalPlayerId];
    sScreen.valid = (li->currentRoom != 0xFFFF);
    sScreen.serial++;
    if (!sScreen.valid)
        return;
    sScreen.room = li->currentRoom;
    sScreen.roomFlags = gRoomProps[li->currentRoom].priorityFlags;
    for (i = 0; i < 3; i++) {
        const struct Background *bg = &li->unkC0[i];
        BgSnap *s = &sScreen.bg[i];

        s->tilesVram = bg->tilesVram;
        s->tilemapVram = bg->tilemapVram;
        s->map = bg->unk10;
        s->w = bg->unk14;
        s->h = bg->unk16;
        s->offX = bg->unk1E;
        s->offY = bg->unk20;
        s->unk22 = bg->unk22;
        s->unk24 = bg->unk24;
        s->cols = bg->unk26;
        s->rows = bg->unk28;
        s->flags = bg->unk2E;
        s->scrollX = bg->scrollX;
        s->scrollY = bg->scrollY;
    }
    sScreen.rectL = li->unk_S32Vec2_6C.x >> 8;
    sScreen.rectT = li->unk_S32Vec2_6C.y >> 8;
    sScreen.rectR = li->unk_S32Vec2_74.x >> 8;
    sScreen.rectB = li->unk_S32Vec2_74.y >> 8;
    /* sub_080019F8: record 1 is the room and moves with the camera; record 2
     * (BG0) at unkB8/unkBA and record 0 (BG2) at unk_S16Vec2_B4, unless the
     * room auto-scrolls that layer, in which case it ignores the camera. */
    sScreen.factor[1][0] = sScreen.factor[1][1] = 256;
    sScreen.factor[2][0] = (sScreen.roomFlags & 4) ? 0 : li->unkB8;
    sScreen.factor[2][1] = (sScreen.roomFlags & 4) ? 0 : li->unkBA;
    sScreen.factor[0][0] = (sScreen.roomFlags & 2) ? 0 : li->unk_S16Vec2_B4.x;
    sScreen.factor[0][1] = (sScreen.roomFlags & 2) ? 0 : li->unk_S16Vec2_B4.y;

    /* The fractions (see sScreen.recFp).  sub_080019F8: the room scrolls to
     * viewportPosition >> 8 (+ a shake offset), BG0 to altViewport_34 >> 8,
     * BG2 to altViewport_24 >> 8; each fraction counts only if the whole
     * pixel it belongs to is the one the record holds. */
    sScreen.camVpX = li->viewportPosition.x;
    sScreen.camVpY = li->viewportPosition.y;
    for (i = 0; i < 3; i++) {
        const BgSnap *s = &sScreen.bg[i];
        s32 wx = s->offX * 8 + s->scrollX, wy = s->offY * 8 + s->scrollY;
        s32 fx, fy;
        u16 hx, hy;

        if (i == 1) {
            fx = li->viewportPosition.x; fy = li->viewportPosition.y;
        } else if (i == 2) {
            fx = li->altViewport_34.x; fy = li->altViewport_34.y;
        } else {
            fx = li->altViewport_24.x; fy = li->altViewport_24.y;
        }
        hx = (u16)(fx >> 8);
        hy = (u16)(fy >> 8);
        if (i == 1) {
            s32 dx = (s16)(u16)(s->scrollX - hx), dy = (s16)(u16)(s->scrollY - hy);

            sScreen.shakeX = (dx >= -RL_MAX_SHAKE && dx <= RL_MAX_SHAKE) ? dx : 0;
            sScreen.shakeY = (dy >= -RL_MAX_SHAKE && dy <= RL_MAX_SHAKE) ? dy : 0;
            hx = (u16)(hx + sScreen.shakeX);
            hy = (u16)(hy + sScreen.shakeY);
        }
        sScreen.recFp[i][0] = wx * 256 + (hx == s->scrollX ? (fx & 0xFF) : 0);
        sScreen.recFp[i][1] = wy * 256 + (hy == s->scrollY ? (fy & 0xFF) : 0);
    }
    {
        s32 ci = sScreen.bg[1].offX * 8 + sScreen.bg[1].scrollX - sScreen.shakeX;
        s32 cj = sScreen.bg[1].offY * 8 + sScreen.bg[1].scrollY - sScreen.shakeY;
        s32 vx = li->viewportPosition.x >> 8, vy = li->viewportPosition.y >> 8;

        s32 fx = li->viewportPosition.x & 0xFF, fy = li->viewportPosition.y & 0xFF;

        for (i = 0; i < 4; i++) {
            const struct Kirby *k = &gKirbys[i];
            const struct Sprite *spr[3];
            s32 cx = k->base.x + (ci - vx) * 256, cy = k->base.y + (cj - vy) * 256;
            int j;

            spr[0] = &k->base.sprite; spr[1] = &k->sprites[0]; spr[2] = &k->sprites[1];
            for (j = 0; j < 3; j++) {
                s32 ax = spr[j]->x + ci, ay = spr[j]->y + cj;

                sScreen.kirbyOk[i][j] = !(spr[j]->unk8 & 0x20000)
                    && (ax == (cx >> 8) || ax == ((cx - fx) >> 8))
                    && (ay == (cy >> 8) || ay == ((cy - fy) >> 8));
            }
            sScreen.kirbyFp[i][0] = cx;
            sScreen.kirbyFp[i][1] = cy;
        }
    }
}

/* --- per-line capture ---------------------------------------------------- */

static RlFrame sFrame;

#define IO16(off) (*(vu16 *)(GBA_IO_BASE + (off)))

void PortRlCaptureLine(int line, s32 aff2x, s32 aff2y, s32 aff3x, s32 aff3y)
{
    s32 *l;
    int i;

    if (!gPortRlEnabled || line < 0 || line >= RL_LINES)
        return;
    l = sFrame.lines[line];
    for (i = 0; i < 8; i++)
        l[RL_LINE_BGOFS + i] = IO16(REG_OFFSET_BG0HOFS + i * 2) & 0x1FF;
    l[RL_LINE_AFF2 + 0] = aff2x;
    l[RL_LINE_AFF2 + 1] = aff2y;
    l[RL_LINE_AFF2 + 2] = (s16)IO16(REG_OFFSET_BG2PA);
    l[RL_LINE_AFF2 + 3] = (s16)IO16(REG_OFFSET_BG2PC);
    l[RL_LINE_AFF3 + 0] = aff3x;
    l[RL_LINE_AFF3 + 1] = aff3y;
    l[RL_LINE_AFF3 + 2] = (s16)IO16(REG_OFFSET_BG3PA);
    l[RL_LINE_AFF3 + 3] = (s16)IO16(REG_OFFSET_BG3PC);
    l[RL_LINE_DISPCNT] = IO16(REG_OFFSET_DISPCNT);
    l[RL_LINE_BLDCNT] = IO16(REG_OFFSET_BLDCNT);
    l[RL_LINE_BLDALPHA] = IO16(REG_OFFSET_BLDALPHA);
    l[RL_LINE_BLDY] = IO16(REG_OFFSET_BLDY);
    l[RL_LINE_WIN0H] = IO16(REG_OFFSET_WIN0H);
    l[RL_LINE_WIN1H] = IO16(REG_OFFSET_WIN1H);
    l[RL_LINE_WIN0V] = IO16(REG_OFFSET_WIN0V);
    l[RL_LINE_WIN1V] = IO16(REG_OFFSET_WIN1V);
    l[RL_LINE_WININ] = IO16(REG_OFFSET_WININ);
    l[RL_LINE_WINOUT] = IO16(REG_OFFSET_WINOUT);
    l[RL_LINE_MOSAIC] = IO16(REG_OFFSET_MOSAIC);
    for (i = 0; i < 4; i++)
        l[RL_LINE_BGCNT + i] = IO16(REG_OFFSET_BG0CNT + i * 2);
    l[RL_LINE_AFFB + 0] = (s16)IO16(REG_OFFSET_BG2PB);
    l[RL_LINE_AFFB + 1] = (s16)IO16(REG_OFFSET_BG2PD);
    l[RL_LINE_AFFB + 2] = (s16)IO16(REG_OFFSET_BG3PB);
    l[RL_LINE_AFFB + 3] = (s16)IO16(REG_OFFSET_BG3PD);
}

/* --- frame assembly ------------------------------------------------------ */

static s32 sWantW = PORT_SCREEN_W, sWantH = PORT_SCREEN_H;

void PortRlSetViewSize(s32 w, s32 h)
{
    if (w <= 0 || h <= 0) {
        w = PORT_SCREEN_W;
        h = PORT_SCREEN_H;
    }
    /* Smaller than the GBA screen is a zoom in: the view then sits inside
     * the 240x160 the game composed (see the clamp in PortRlBuildFrame). */
    if (w < RL_MIN_VIEW_W) w = RL_MIN_VIEW_W;
    if (h < RL_MIN_VIEW_H) h = RL_MIN_VIEW_H;
    w &= ~1;
    h &= ~1;
    if (w > 1024) w = 1024;
    if (h > 512) h = 512;
    sWantW = w;
    sWantH = h;
}

/* Presentation switches (platform/ui): the HUD's horizontal anchoring. */
int gPortRlHudStrip;

/* Where Kirby is on the GBA screen and where the game's camera is, for the
 * host's zoom logic.  Reads only.  0 when there is no level to ask about. */
int PortRlFocus(s32 *kx, s32 *ky, s32 *camX, s32 *camY)
{
    const struct LevelInfo *li = &gCurLevelInfo[gLocalPlayerId];
    s32 x = (gKirbys[gLocalPlayerId].base.x >> 8) - (li->viewportPosition.x >> 8);
    s32 y = (gKirbys[gLocalPlayerId].base.y >> 8) - (li->viewportPosition.y >> 8);

    *camX = li->viewportPosition.x;
    *camY = li->viewportPosition.y;
    if (li->currentRoom == 0xFFFF || x <= 0 || x >= PORT_SCREEN_W
        || y <= 0 || y >= PORT_SCREEN_H) {
        *kx = PORT_SCREEN_W / 2;
        *ky = PORT_SCREEN_H / 2;
        return 0;
    }
    *kx = x;
    *ky = y;
    return 1;
}

void PortRlGetViewSize(s32 *w, s32 *h)
{
    *w = sWantW;
    *h = sWantH;
}

static RlSprite sOut[RL_MAX_SPRITES + 128];
static RlSprite sOutWin[RL_MAX_SPRITES + 128];
static u8 sVram[0x18000];
static u16 sPal[512];
static u32 sMapGen[4];
static const u16 *sMapPtr[4];
static s32 sMapW[4], sMapH[4];

/* --- what PortRlPresentFrame needs from each built frame ------------------
 *
 * Two of these, the last frame built and the one before it.  A group is one
 * PortRlEmitSprite call: a struct Sprite drawn at one anchor (the same struct
 * drawn twice in a frame is two groups, told apart by `occ`).  Matching a
 * group across frames by (struct, occ) is what lets a sprite be
 * interpolated; its subframes all move with the anchor, so an animation
 * frame changing the layout under it does not stop the anchor moving
 * smoothly. */
#define MOT_HASH 4096
typedef struct {
    const void *owner;
    s32 occ, ax, ay;         /* anchor, SCREEN coords of its frame           */
    s32 bx, by;              /* the anchor in world coords, 1/256 px         */
    s32 fx, fy;              /* where it really is: bx/by, or Kirby's 8.8    */
    s32 next;                /* next group of the same struct, -1            */
} MotGroup;

typedef struct {
    u8 valid, world;
    u16 room;
    u32 commit;              /* sCommitSerial: consecutive frames differ by 1 */
    s32 ciX, ciY;            /* world coords of SCREEN (0, 0); 0 if no room  */
    s32 camFp[2];            /* the room's exact scroll, 1/256 px            */
    s32 layFp[4][2], layInt[4][2];
    u8 layOk[4];             /* hardware BG n is a WORLD layer of a record   */
    u8 kirbyFocus;           /* local Kirby inside the 240x160 screen        */
    u8 corrected;            /* netplay replaced the world before this frame */
    u8 shakeHw;              /* hardware BG + 1 of the room layer, 0 if none */
    s32 shakeD[2];           /* its shake rescaled to the zoom, 1/256 px     */
    s32 kirbyFp[4][2];
    s32 nGroups;
    MotGroup g[RL_MAX_SPRITES];
    s32 hash[MOT_HASH];      /* struct -> its first group, -1                */
} Motion;

static Motion sMot[2];
static int sMotCur;
static u8 sCorrectionPending;

void PortRlNoteCorrection(u32 frame)
{
    (void)frame;
    sCorrectionPending = 1;
}
static s32 sOutGroup[RL_MAX_SPRITES + 128], sOutWinGroup[RL_MAX_SPRITES + 128];

/* The view rectangle's limits as PortRlBuildFrame worked them out (SCREEN
 * coords), to redo the view in 1/256 px. */
static struct { s32 rl, rr, rt, rb; } sViewLim;

static u32 MotHash(const void *owner)
{
    uintptr_t v = (uintptr_t)owner;
    return (u32)((v >> 2) ^ (v >> 13)) & (MOT_HASH - 1);
}

/* The group of (owner, occ) in m, or NULL. */
static const MotGroup *MotFind(const Motion *m, const void *owner, s32 occ)
{
    u32 h = MotHash(owner);
    s32 i;

    for (; m->hash[h] >= 0; h = (h + 1) & (MOT_HASH - 1)) {
        if (m->g[m->hash[h]].owner != owner)
            continue;
        for (i = m->hash[h]; i >= 0; i = m->g[i].next)
            if (m->g[i].occ == occ)
                return &m->g[i];
        return NULL;
    }
    return NULL;
}

/* The group for this anchor of this struct, made if new; -1 if full. */
static s32 MotGroupFor(Motion *m, const void *owner, s32 ax, s32 ay)
{
    u32 h = MotHash(owner);
    s32 i, last = -1, occ = 0;
    MotGroup *g;

    for (; m->hash[h] >= 0; h = (h + 1) & (MOT_HASH - 1))
        if (m->g[m->hash[h]].owner == owner)
            break;
    for (i = m->hash[h]; i >= 0; i = m->g[i].next) {
        if (m->g[i].ax == ax && m->g[i].ay == ay)
            return i;
        last = i;
        occ++;
    }
    if (m->nGroups >= RL_MAX_SPRITES)
        return -1;
    i = m->nGroups++;
    g = &m->g[i];
    g->owner = owner;
    g->occ = occ;
    g->ax = ax;
    g->ay = ay;
    g->next = -1;
    if (last >= 0)
        m->g[last].next = i;
    else
        m->hash[h] = i;
    return i;
}

/* Is this source map safe to read in full?  The same question view.c asks,
 * for the same reason: a stale Background record on a menu can describe a map
 * a long way past anything real. */
static int SourceMapUsable(u32 a, s32 w, s32 h)
{
    u32 bytes;

    if (!a || w <= 0 || h <= 0 || w > 0x1000 || h > 0x1000)
        return 0;
    bytes = (u32)w * (u32)h * 2;
    if (a >= GBA_EWRAM_BASE && a + bytes <= GBA_EWRAM_BASE + GBA_EWRAM_SIZE)
        return 1;
    if (a >= GBA_ROM_BASE && a + bytes <= GBA_ROM_BASE + gPortRomSize)
        return 1;
    return 0;
}

static void OamToSprite(const u16 *oam, int i, RlSprite *s)
{
    u16 a0 = oam[i * 4 + 0], a1 = oam[i * 4 + 1];
    s32 x = a1 & 0x1FF, y = a0 & 0xFF;

    /* The PPU's fold points at 240x160: these sprites carry no more
     * precision than OAM gave them. */
    if (x >= PORT_SCREEN_W) x -= 512;
    if (y >= PORT_SCREEN_H) y -= 256;
    s->x = x;
    s->y = y;
    s->attr0 = (u16)(a0 & 0xFF00);
    s->attr1 = (u16)(a1 & 0xFE00);
    s->attr2 = oam[i * 4 + 2];
    s->space = RL_SPACE_SCREEN;
    s->anchor = 0;
}

static const u8 kObjW[4][4] = { {8,16,32,64}, {16,32,32,64}, {8,8,16,32}, {8,8,8,8} };
static const u8 kObjH[4][4] = { {8,16,32,64}, {8,8,16,32}, {16,32,32,64}, {8,8,8,8} };

/* The on-screen box of a sprite: its size, doubled for double-size affine. */
static void ObjBox(const RlSprite *s, s32 *w, s32 *h)
{
    u32 shape = (s->attr0 >> 14) & 3, size = (s->attr1 >> 14) & 3;
    int dbl = (s->attr0 & 0x300) == 0x300;

    *w = kObjW[shape][size] << dbl;
    *h = kObjH[shape][size] << dbl;
}

static int SpriteHidden(u16 a0)
{
    return (!(a0 & 0x100) && (a0 & 0x200)) || ((a0 >> 10) & 3) == 3;
}

static void FillAffine(const u16 *oam, RlSprite *s)
{
    if (s->attr0 & 0x100) {
        u32 slot = (s->attr1 >> 9) & 0x1F;
        s->pa = (s16)oam[slot * 16 + 3];
        s->pb = (s16)oam[slot * 16 + 7];
        s->pc = (s16)oam[slot * 16 + 11];
        s->pd = (s16)oam[slot * 16 + 15];
    } else {
        s->pa = 0x100; s->pb = 0; s->pc = 0; s->pd = 0x100;
    }
}

static void PushSprite(RlFrame *f, const u16 *oam, RlSprite s, u32 *n, u32 *nw, s32 group)
{
    if (SpriteHidden(s.attr0))
        return;
    FillAffine(oam, &s);
    s.subX = s.subY = 0;
    if (((s.attr0 >> 10) & 3) == 2) {
        if (*nw < RL_MAX_SPRITES + 128) {
            sOutWinGroup[*nw] = group;
            sOutWin[(*nw)++] = s;
        }
    } else if (*n < RL_MAX_SPRITES + 128) {
        sOutGroup[*n] = group;
        sOut[(*n)++] = s;
    }
    (void)f;
}

static void BuildSprites(RlFrame *f, Motion *m)
{
    const u16 *oam = (const u16 *)GBA_OAM_BASE;
    u32 i, k = 0, n = 0, nw = 0;
    int ok = 1;

    /* Do the hooks describe what is actually in OAM?  Every entry the game
     * wrote must be there, in order, with the same attributes. */
    for (i = 0; i < sNumCommitted && ok; i++) {
        const PendingSprite *p = &sCommitted[i];

        if (!p->inOam)
            continue;
        if (k >= 128
            || oam[k * 4 + 0] != (u16)(p->s.attr0 | (p->s.y & 0xFF))
            || oam[k * 4 + 1] != (u16)(p->s.attr1 | (p->s.x & 0x1FF))
            || oam[k * 4 + 2] != p->s.attr2)
            ok = 0;
        k++;
    }
    f->hookSpritesUsed = (u8)ok;
    f->spritesFromHooks = f->spritesFromOam = 0;
    f->spritesOffscreen = f->spritesOverflow = 0;

    if (ok) {
        for (i = 0; i < sNumCommitted; i++) {
            const PendingSprite *p = &sCommitted[i];
            s32 g = p->s.space == RL_SPACE_HUD ? -1 : MotGroupFor(m, p->owner, p->ax, p->ay);

            PushSprite(f, oam, p->s, &n, &nw, g);
            f->spritesFromHooks++;
            if (!p->inOam) {
                s32 bw, bh;
                ObjBox(&p->s, &bw, &bh);
                if (p->s.x >= PORT_SCREEN_W || p->s.y >= PORT_SCREEN_H
                    || p->s.x + bw <= 0 || p->s.y + bh <= 0)
                    f->spritesOffscreen++;
                else
                    f->spritesOverflow++;
            }
        }
    } else {
        k = 0;
    }
    /* Whatever OAM holds beyond what the hooks account for -- a frozen
     * frame's sprites, or everything when the hooks did not match. */
    for (i = k; i < 128; i++) {
        RlSprite s;

        OamToSprite(oam, (int)i, &s);
        if (SpriteHidden(s.attr0))
            continue;
        PushSprite(f, oam, s, &n, &nw, -1);
        f->spritesFromOam++;
    }
    memcpy(&sOut[n], sOutWin, nw * sizeof(RlSprite));
    memcpy(&sOutGroup[n], sOutWinGroup, nw * sizeof(s32));
    f->sprites = sOut;
    f->numSprites = n;
    f->numObjWin = nw;
}

/* Does this Background record describe hardware BG `hw` as the display has
 * it right now?  Screen base, char base, and for a streamed layer the low
 * scroll bits the record implies. */
static int RecordMatches(const BgSnap *s, int hw, const s32 *line0)
{
    u32 cnt = (u32)line0[RL_LINE_BGCNT + hw];
    u32 screen = 0x06000000u + ((cnt >> 8) & 0x1F) * 0x800;
    u32 chars = 0x06000000u + ((cnt >> 2) & 3) * 0x4000;

    if (screen != s->tilemapVram || chars != s->tilesVram)
        return 0;
    if (s->flags & 0x20) {
        if ((u32)line0[RL_LINE_BGOFS + hw * 2] != (u32)(s->scrollX & 7)
            || (u32)line0[RL_LINE_BGOFS + hw * 2 + 1] != (u32)(s->scrollY & 7))
            return 0;
    }
    return 1;
}

static s32 Clamp(s32 v, s32 lo, s32 hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

/* --- parallax at any view size ---------------------------------------------
 *
 * The game scrolls a parallax record to A + f * camera (sub_080019F8: A is
 * the room's constant offset, f the rate, both per axis).  A view of another
 * size, at world position V, samples it from
 *
 *     o(V) = A + f * V + K
 *
 * so the layer moves at f times the *view's* motion -- zoomed in, where the
 * view follows Kirby inside the 240x160 screen, as much as zoomed out, where
 * it stops at the room's edges while the game's camera goes on.  K is the
 * framing: K0 = (1 - f) * (native - view) / 2 puts the view's centre where
 * the game shows the screen's (0 at 240x160: the PPU's picture).  When the
 * picture is wide enough that the view, moving at rate f over the whole range
 * the view can take in this room, never leaves it, K is moved the least that
 * keeps it inside (a picture made to fit the room keeps fitting at 2x); a
 * factor-0 background is then a fixed picture.  Otherwise the view runs off
 * the picture: a picture that the game itself wraps (it runs off its own end
 * at 240) keeps wrapping, any other is mirrored at its edges.
 *
 * Which of the three a layer is depends on the room alone, so it is decided
 * once (sPar) and not re-tested every frame: the test sits exactly on the
 * boundary for a picture made to fit, and whole-pixel rounding flipped it
 * between repeat and mirror from one frame to the next (the zoomed-out
 * flicker). */
typedef struct {
    u8 on;                    /* this axis is a parallax axis this frame     */
    u8 latched;
    u8 tiles;                 /* the game wraps it: repeat, never fit       */
    u16 room;
    uintptr_t map;
    s32 img, f, camMin, camMax;
    s64 A;                    /* 1/256 px, as latched                       */
    s32 f8;                   /* rate, 8.8                                   */
    s64 K;                    /* 1/256 px                                    */
} ParAxis;
static ParAxis sPar[4][2];

/* The rate sub_080019F8 really scrolls at: (pos >> 4) * (factor >> 4). */
static s32 EffFactor(s32 f)
{
    return (f >> 4) * 16;
}

/* Where the view goes for a camera at `cam` (world), by PortRlBuildFrame's
 * rules: `pref` the wanted offset from the camera, the world range [wl, wr)
 * it may show, never off the native screen (wider) or out of it (narrower). */
static s32 ViewAt(s32 cam, s32 pref, s32 view, s32 native, s32 wl, s32 wr)
{
    s32 v = (wr - wl >= view) ? Clamp(pref, wl - cam, wr - cam - view) : (wl + wr - view) / 2 - cam;

    v = Clamp(v, native - view < 0 ? native - view : 0, native - view > 0 ? native - view : 0);
    return cam + v;
}

/* Decide one axis of a parallax layer for this frame: Afp the game's offset
 * (1/256), f8 its rate, img the picture (px; 0 unknown), camMin/camMax the
 * game camera's range, cam the camera now, [wl, wr) the view's world range.
 * Returns the mode past the picture: 1 repeat, 2 mirror. */
static int ParallaxAxis(ParAxis *a, uintptr_t map, s32 img, s32 f8,
                        int autoScroll, s64 Afp, s32 cam, s32 camMin, s32 camMax,
                        s32 view, s32 native, s32 wl, s32 wr)
{
    s64 K0 = (s64)(256 - f8) * (native - view) / 2;     /* (1-f)(native-view)/2 px */
    s32 vmin, vmax;
    s64 omin, omax, lo, hi;

    a->on = 1;
    a->f8 = f8;
    a->K = K0;
    if (camMax < camMin)
        camMin = camMax = cam;
    if (!a->latched || a->room != sScreen.room || a->map != map || a->img != img
        || a->f != f8 || a->camMin != camMin || a->camMax != camMax
        || Afp - a->A > 2 * 256 || a->A - Afp > 2 * 256) {
        /* Does the game's own 240-wide window run off the picture over the
         * camera's range?  1 px of slack: a picture made to fit sits on it. */
        s64 s0 = Afp + (s64)f8 * camMin, s1 = Afp + (s64)f8 * camMax;

        if (s0 > s1) { s64 t = s0; s0 = s1; s1 = t; }
        a->latched = 1;
        a->room = sScreen.room;
        a->map = map;
        a->img = img;
        a->f = f8;
        a->camMin = camMin;
        a->camMax = camMax;
        a->A = Afp;
        a->tiles = autoScroll || img <= 0 || s0 < -256
                   || s1 + (s64)native * 256 > (s64)img * 256 + 256;
    }
    if (view == native)
        return 1;
    if (a->tiles)
        return 1;
    vmin = ViewAt(camMin, view < native ? -0x100000 : (native - view) / 2, view, native, wl, wr);
    vmax = ViewAt(camMax, view < native ? 0x100000 : (native - view) / 2, view, native, wl, wr);
    omin = (s64)f8 * vmin;
    omax = (s64)f8 * vmax;
    if (omin > omax) { s64 t = omin; omin = omax; omax = t; }
    lo = -Afp - omin;
    hi = (s64)(img - view) * 256 - Afp - omax;
    if (lo <= hi)
        a->K = K0 < lo ? lo : K0 > hi ? hi : K0;
    return 2;
}

/* Where view pixel 0 samples the layer, 1/256 px of the layer: Sfp the
 * layer's scroll and camFp the camera (both 1/256), vfp the view's offset
 * from the camera (1/256, SCREEN coords). */
static s64 ParallaxOrigin(const ParAxis *a, s64 Sfp, s64 vfp)
{
    return Sfp + ((s64)a->f8 * vfp) / 256 + a->K;
}

/* The groups' world positions.  A group drawn from one of Kirby's sprite
 * structs, at the whole pixel of his 8.8 position, is placed at that
 * position instead -- on an axis he moved along since the last frame.  At
 * rest the game parks him on the last 1/256 before a tile edge as often as
 * on the edge itself, and drawing that as a whole pixel down would sink him
 * into the floor: at rest he stays where the GBA draws him. */
static void MotFinish(Motion *m, const Motion *mp)
{
    int moving = mp->valid && !m->corrected && mp->commit + 1 == m->commit && mp->world && m->world
                 && mp->room == m->room;
    s32 i, k, j;

    memcpy(m->kirbyFp, sScreen.kirbyFp, sizeof(m->kirbyFp));

    for (i = 0; i < m->nGroups; i++) {
        MotGroup *g = &m->g[i];

        g->bx = g->fx = (g->ax + m->ciX) * 256;
        g->by = g->fy = (g->ay + m->ciY) * 256;
        if (!m->world)
            continue;
        for (k = 0; k < 4; k++) {
            const struct Kirby *kb = &gKirbys[k];
            const void *spr[3];

            spr[0] = &kb->base.sprite; spr[1] = &kb->sprites[0]; spr[2] = &kb->sprites[1];
            for (j = 0; j < 3; j++)
                if (g->owner == spr[j] && g->occ == 0 && sScreen.kirbyOk[k][j])
                    break;
            if (j == 3)
                continue;
            if (moving && mp->kirbyFp[k][0] != m->kirbyFp[k][0])
                g->fx = m->kirbyFp[k][0];
            if (moving && mp->kirbyFp[k][1] != m->kirbyFp[k][1])
                g->fy = m->kirbyFp[k][1];
            break;
        }
    }
    m->valid = 1;
}

const RlFrame *PortRlBuildFrame(void)
{
    RlFrame *f = &sFrame;
    const s32 *line0 = f->lines[0];
    u32 dispcnt = (u32)line0[RL_LINE_DISPCNT];
    int fgRec = -1, i;
    s32 W = sWantW, H = sWantH;
    const Motion *mp;
    Motion *m;

    sMotCur ^= 1;
    m = &sMot[sMotCur];
    mp = &sMot[sMotCur ^ 1];
    memset(m, 0, offsetof(Motion, g));
    memset(m->hash, 0xFF, sizeof(m->hash));
    for (i = 0; i < 8; i++)
        sPar[i >> 1][i & 1].on = 0;
    m->commit = sCommitSerial;
    m->corrected = sCorrectionPending;
    sCorrectionPending = 0;

    f->serial++;
    f->objOneD = (dispcnt & DISPCNT_OBJ_1D_MAP) != 0;
    memset(f->layers, 0, sizeof(f->layers));
    f->hudBg = 0xFF;
    f->numHud = 0;
    f->world = 0;

    /* Gameplay?  The room record (unkC0[1]) has to describe a streamed text
     * layer the display is really showing, with a source map we can read. */
    if (sScreen.valid && (dispcnt & 7) == 0 && !(dispcnt & DISPCNT_FORCED_BLANK)) {
        const BgSnap *s = &sScreen.bg[1];
        int hw = s->flags & 3;

        if ((s->flags & 0x20) && !(s->flags & (0x40 | 0x80 | 0x100))
            && (dispcnt & (DISPCNT_BG0_ON << hw))
            && RecordMatches(s, hw, line0)
            && SourceMapUsable(s->map, s->w, s->h))
            fgRec = 1;
    }

    if (fgRec < 0) {
        /* Native framing: the GBA picture, unchanged, on the GBA screen. */
        f->viewW = PORT_SCREEN_W;
        f->viewH = PORT_SCREEN_H;
        f->viewX = f->viewY = 0;
        f->shiftX = f->shiftY = 0;
        f->contentL = 0; f->contentT = 0;
        f->contentR = PORT_SCREEN_W; f->contentB = PORT_SCREEN_H;
        f->camX = f->camY = 0;
        for (i = 0; i < 4; i++) {
            f->layers[i].enabled = 1;
            f->layers[i].space = RL_SPACE_SCREEN;
        }
    } else {
        const BgSnap *fg = &sScreen.bg[1];
        /* World x of screen x 0: the camera, without a shake -- the view,
         * the clamps and every sprite follow it; only the room layer shakes
         * (below, scaled to the zoom). */
        s32 camX = fg->offX * 8 + fg->scrollX - sScreen.shakeX;
        s32 camY = fg->offY * 8 + fg->scrollY - sScreen.shakeY;
        s32 rl, rr, rt, rb, vx0, vy0, vx, vy;

        f->world = 1;
        f->viewW = W;
        f->viewH = H;

        /* Where the view may go, in screen coordinates.  The game's own
         * camera rectangle (sub_08002DA0) is inset from the map by 8 pixels
         * at the top, left and right and by 40 at the bottom.  A wider view
         * gets the 8-pixel margins back -- authored rows of the room -- but
         * not the bottom 40, which the game never shows and which in places
         * is not drawn at all (room 101 is empty below its ground), and no
         * more, so a scroll lock (a rectangle narrower than the room) still
         * hides what it hides.  Never past the map itself. */
        rl = sScreen.rectL - 8 - camX;
        rr = sScreen.rectR + 8 - camX;
        rt = sScreen.rectT - 8 - camY;
        rb = sScreen.rectB - camY;
        if (rr - rl < PORT_SCREEN_W || rl > 0 || rr < PORT_SCREEN_W) {
            rl = -camX;
            rr = fg->w * 8 - camX;
        }
        if (rb - rt < PORT_SCREEN_H || rt > 0 || rb < PORT_SCREEN_H) {
            rt = -camY;
            rb = fg->h * 8 - camY;
        }
        if (rl < -camX) rl = -camX;
        if (rt < -camY) rt = -camY;
        if (rr > fg->w * 8 - camX) rr = fg->w * 8 - camX;
        if (rb > fg->h * 8 - camY) rb = fg->h * 8 - camY;

        /* Centre the view on the game's camera, then keep it inside the
         * rectangle -- unless the rectangle is narrower than the view, in
         * which case centre the rectangle and letterbox the rest.  Never so
         * far that the 240x160 the game composed leaves the view. */
        vx0 = -(W - PORT_SCREEN_W) / 2;
        vy0 = -(H - PORT_SCREEN_H) / 2;
        /* A view narrower or shorter than the screen (zoomed in) follows
         * Kirby inside it rather than the screen's centre: at a room edge
         * the camera stops and he keeps walking (docs/VIEW.md). */
        if (W < PORT_SCREEN_W || H < PORT_SCREEN_H) {
            s32 kx, ky, cx, cy;

            PortRlFocus(&kx, &ky, &cx, &cy);
            if (W < PORT_SCREEN_W) vx0 = kx - W / 2;
            if (H < PORT_SCREEN_H) vy0 = ky - H / 2;
        }
        vx = (rr - rl >= W) ? Clamp(vx0, rl, rr - W) : (rl + rr - W) / 2;
        vy = (rb - rt >= H) ? Clamp(vy0, rt, rb - H) : (rt + rb - H) / 2;
        /* Never so far that the 240x160 the game composed leaves the view
         * (wider), or the view leaves it (narrower). */
        vx = Clamp(vx, PORT_SCREEN_W - W < 0 ? PORT_SCREEN_W - W : 0,
                   PORT_SCREEN_W - W > 0 ? PORT_SCREEN_W - W : 0);
        vy = Clamp(vy, PORT_SCREEN_H - H < 0 ? PORT_SCREEN_H - H : 0,
                   PORT_SCREEN_H - H > 0 ? PORT_SCREEN_H - H : 0);
        f->viewX = vx;
        f->viewY = vy;
        f->shiftX = vx - (PORT_SCREEN_W - W) / 2;
        f->shiftY = vy - (PORT_SCREEN_H - H) / 2;
        f->contentL = rl < 0 ? rl : 0;
        f->contentR = rr > PORT_SCREEN_W ? rr : PORT_SCREEN_W;
        f->contentT = rt < 0 ? rt : 0;
        f->contentB = rb > PORT_SCREEN_H ? rb : PORT_SCREEN_H;
        f->camX = camX;
        f->camY = camY;
        sViewLim.rl = rl; sViewLim.rr = rr;
        sViewLim.rt = rt; sViewLim.rb = rb;
        m->world = 1;
        m->room = sScreen.room;
        m->ciX = camX;
        m->ciY = camY;
        m->camFp[0] = sScreen.recFp[1][0] - sScreen.shakeX * 256;
        m->camFp[1] = sScreen.recFp[1][1] - sScreen.shakeY * 256;
        /* The room's shake at this zoom (the view is 160 / zoom tall), in
         * 1/256 px, as a change to what the hardware scroll already holds.
         * Zoomed in it is shrunk to its 1x size on screen; zoomed out it
         * keeps its game-pixel size, so on screen it shrinks with the zoom
         * -- never larger than at 1x either way. */
        {
            s32 hs = H < PORT_SCREEN_H ? H : PORT_SCREEN_H;

            m->shakeD[0] = (s32)(((s64)sScreen.shakeX * 256 * hs) / PORT_SCREEN_H) - sScreen.shakeX * 256;
            m->shakeD[1] = (s32)(((s64)sScreen.shakeY * 256 * hs) / PORT_SCREEN_H) - sScreen.shakeY * 256;
        }
        {
            /* PortRlFocus's test, on the committed frame. */
            const s32 *k = sScreen.kirbyFp[gLocalPlayerId & 3];
            s32 kx = (k[0] >> 8) - camX, ky = (k[1] >> 8) - camY;
            m->kirbyFocus = kx > 0 && kx < PORT_SCREEN_W && ky > 0 && ky < PORT_SCREEN_H;
        }

        for (i = 0; i < 4; i++) {
            f->layers[i].enabled = 1;
            f->layers[i].space = RL_SPACE_SCREEN;
        }
        for (i = 0; i < 3; i++) {
            const BgSnap *s = &sScreen.bg[i];
            int hw = s->flags & 3;
            RlTileLayer *L = &f->layers[hw];
            s32 ox = s->scrollX & 7, oy = s->scrollY & 7;

            if (!RecordMatches(s, hw, line0))
                continue;
            L->space = RL_SPACE_WORLD;
            m->layOk[hw] = 1;
            m->layFp[hw][0] = sScreen.recFp[i][0];
            m->layFp[hw][1] = sScreen.recFp[i][1];
            m->layInt[hw][0] = s->offX * 8 + s->scrollX;
            m->layInt[hw][1] = s->offY * 8 + s->scrollY;
            L->factorX = sScreen.factor[i][0];
            L->factorY = sScreen.factor[i][1];
            if (i != 1) {
                /* A parallax record: where the view samples it, and what
                 * lies past the picture (ParallaxAxis). */
                const s32 cam[2] = { camX, camY };
                const s32 cmin[2] = { sScreen.rectL, sScreen.rectT };
                const s32 cmax[2] = { sScreen.rectR - PORT_SCREEN_W, sScreen.rectB - PORT_SCREEN_H };
                const s32 view[2] = { W, H }, nat[2] = { PORT_SCREEN_W, PORT_SCREEN_H };
                const s32 vo[2] = { f->viewX, f->viewY };
                const s32 wl[2] = { rl + camX, rt + camY }, wr[2] = { rr + camX, rb + camY };
                const s32 img[2] = { s->w * 8, s->h * 8 };
                const s32 fr[2] = { L->factorX, L->factorY };
                int as = (sScreen.roomFlags & (i == 2 ? 4 : 2)) != 0, ax;

                for (ax = 0; ax < 2; ax++) {
                    ParAxis *a = &sPar[hw][ax];
                    s32 fe = EffFactor(fr[ax]);
                    s64 Sfp = m->layFp[hw][ax];
                    s64 Afp = Sfp - ((s64)fe * m->camFp[ax]) / 256;
                    int mode = ParallaxAxis(a, s->map, img[ax], fe, as, Afp, cam[ax],
                                            cmin[ax], cmax[ax], view[ax], nat[ax], wl[ax], wr[ax]);
                    s32 sh = (s32)(ParallaxOrigin(a, Sfp, (s64)vo[ax] * 256) >> 8)
                             - (m->layInt[hw][ax] + vo[ax]);

                    if (ax == 0) {
                        L->shiftX = sh;
                        L->wrapX = (u8)mode;
                    } else {
                        L->shiftY = sh;
                    }
                }
            } else {
                L->shiftX += (m->shakeD[0] + (m->shakeD[0] >= 0 ? 128 : -128)) / 256;
                L->shiftY += (m->shakeD[1] + (m->shakeD[1] >= 0 ? 128 : -128)) / 256;
                m->shakeHw = (u8)(hw + 1);
            }
            if (!(s->flags & 0x20)) {
                /* Loaded whole into its screen block, and the hardware wraps
                 * it at the block's size.  When the picture is smaller than
                 * the block (most skies are 30x30 tiles in a 32x32 block) the
                 * 240x160 screen never reaches past it, but a wider or taller
                 * view does, and the wrap shows the block's unused columns as
                 * a striped seam every 256 pixels.  Mirror at the picture's
                 * own edges instead -- continuous, like a narrow streamed
                 * picture (ParallaxAxis).  Not at 240x160, which stays the PPU's. */
                u32 cnt = (u32)line0[RL_LINE_BGCNT + hw];
                s32 bw = (cnt & 0x4000) ? 64 : 32, bh = (cnt & 0x8000) ? 64 : 32;

                if ((W != PORT_SCREEN_W || H != PORT_SCREEN_H)
                    && s->w > 0 && s->h > 0 && s->w <= bw && s->h <= bh
                    && (s->w < bw || s->h < bh)) {
                    L->picW = s->w < bw ? s->w * 8 : 0;  /* 0: that axis wraps for real */
                    L->picH = s->h < bh ? s->h * 8 : 0;
                }
                continue;
            }

            /* Streamed: VRAM holds a 32x22 window of the map.  Its last two
             * rows are read from past the bottom of the map (bg.c does no
             * vertical wrap and never needed to: they land below line 160),
             * so the window ends where the map does. */
            L->streamed = 1;
            L->validL = -ox;
            L->validR = (s->cols + 1) * 8 - ox;
            L->validT = -oy;
            L->validB = (s->rows + 1) * 8 - oy;
            if (s->h > 0) {
                s32 below = ((s32)s->h - (s->offY + s->scrollY / 8)) * 8 - oy;
                if (below < L->validB)
                    L->validB = below;
            }
            if ((s->flags & (0x40 | 0x80 | 0x100))
                || !SourceMapUsable(s->map, s->w, s->h))
                continue;               /* window only: clip outside it */

            L->map = (const u16 *)(uintptr_t)s->map;
            L->mapW = s->w;
            L->mapH = s->h;
            L->mapScrollX = s->scrollX;
            L->mapScrollY = s->scrollY;
            L->mapOffX = s->offX;
            L->mapOffY = s->offY;
            /* The room itself stops at its edges -- the view is kept inside
             * them and anything else is letterbox.  A parallax layer is a
             * picture behind the room: past its left or right end it repeats
             * or is mirrored as ParallaxAxis decided (above).  Past its top
             * or bottom (a view taller than the sky, zoomed out) it is
             * mirrored at the edge: continuous, where repeating the edge row
             * drew vertical streaks the height of the overhang and wrapping
             * would put the ground under the clouds.  ParallaxAxis (above) has
             * already framed a picture tall enough to cover the view. */
            if (i != 1)
                L->mirrorY = 1;
            else
                L->wrapX = 0;
            if (L->map != sMapPtr[hw] || L->mapW != sMapW[hw] || L->mapH != sMapH[hw]) {
                sMapPtr[hw] = L->map;
                sMapW[hw] = L->mapW;
                sMapH[hw] = L->mapH;
                sMapGen[hw]++;
            }
            L->mapGen = sMapGen[hw];
        }

        /* The HUD: BG1 on screen block 28 (sub_080338B4).  Four regions,
         * each pinned to its own corner.  The split columns are where the
         * HUD's own elements end: the bottom strip is ability name (tiles
         * 0-6), lives (7-11) and the health bar (13-19) on the left and the
         * area name or enemy health (20-29) on the right, so x=160 cuts
         * between elements rather than through the health bar. */
        if ((dispcnt & DISPCNT_BG1_ON)
            && (((u32)line0[RL_LINE_BGCNT + 1] >> 8) & 0x1F) == 28) {
            static const s16 kRegions[4][6] = {
                /* x0, y0, x1, y1, anchorH, anchorV */
                {   0,  0, 120,  80, RL_ANCHOR_LEFT,  RL_ANCHOR_TOP },
                { 120,  0, 240,  80, RL_ANCHOR_RIGHT, RL_ANCHOR_TOP },
                {   0, 80, 160, 160, RL_ANCHOR_LEFT,  RL_ANCHOR_BOTTOM },
                { 160, 80, 240, 160, RL_ANCHOR_RIGHT, RL_ANCHOR_BOTTOM },
            };
            int r;

            f->hudBg = 1;
            f->layers[1].space = RL_SPACE_HUD;
            for (r = 0; r < 4; r++) {
                RlHudRegion *h = &f->hud[r];

                h->x0 = kRegions[r][0]; h->y0 = kRegions[r][1];
                h->x1 = kRegions[r][2]; h->y1 = kRegions[r][3];
                h->anchorH = (u8)(gPortRlHudStrip ? RL_ANCHOR_CENTER : kRegions[r][4]);
                h->anchorV = (u8)kRegions[r][5];
                h->dx = (s16)(h->anchorH == RL_ANCHOR_RIGHT ? W - PORT_SCREEN_W
                              : h->anchorH == RL_ANCHOR_CENTER ? (W - PORT_SCREEN_W) / 2 : 0);
                h->dy = (s16)(h->anchorV == RL_ANCHOR_BOTTOM ? H - PORT_SCREEN_H : 0);
            }
            f->numHud = 4;
        }
    }

    {
        /* KATAM_RL_LAYERLOG=file: one line per built world frame, per layer
         * mode and shift, for measuring parallax (docs/RENDERER.md). */
        static FILE *lf;
        static int lfInit;
        if (!lfInit) {
            const char *e = getenv("KATAM_RL_LAYERLOG");
            lfInit = 1;
            lf = e ? fopen(e, "w") : NULL;
        }
        if (lf && f->world) {
            fprintf(lf, "%u room %u cam %d %d view %d %d sh %d %d kirby %d %d",
                    (unsigned)f->serial, (unsigned)sScreen.room, (int)f->camX, (int)f->camY,
                    (int)f->viewX, (int)f->viewY, (int)f->shiftX, (int)f->shiftY,
                    (int)(sScreen.kirbyFp[gLocalPlayerId & 3][0] >> 8),
                    (int)(sScreen.kirbyFp[gLocalPlayerId & 3][1] >> 8));
            for (i = 0; i < 3; i++) {
                const BgSnap *s = &sScreen.bg[i];
                int hw = s->flags & 3;
                const RlTileLayer *L = &f->layers[hw];
                if (L->space != RL_SPACE_WORLD)
                    continue;
                fprintf(lf, " | r%d hw%d f %d %d S %d %d img %d %d fl %x st %d fit %d%d wr %d my %d pic %d %d shift %d %d val %d %d",
                        i, hw, (int)L->factorX, (int)L->factorY,
                        s->offX * 8 + s->scrollX, s->offY * 8 + s->scrollY, s->w * 8, s->h * 8,
                        s->flags, L->streamed, sPar[hw][0].on, sPar[hw][0].tiles, L->wrapX, L->mirrorY,
                        (int)L->picW, (int)L->picH, (int)L->shiftX, (int)L->shiftY,
                        (int)L->validL, (int)L->validR);
            }
            fputc('\n', lf);
            fflush(lf);
        }
    }

    BuildSprites(f, m);
    MotFinish(m, mp);
    for (i = 0; i < 4; i++)
        f->layers[i].subX = f->layers[i].subY = 0;
    f->viewSubX = f->viewSubY = 0;

    {
        /* KATAM_RL_LAYERS=mask: draw only these BGs (bit n = BGn), for
         * looking at one layer at a time. */
        static int mask = -2;
        if (mask == -2) {
            const char *e = getenv("KATAM_RL_LAYERS");
            mask = e ? (int)strtol(e, NULL, 0) : -1;
        }
        if (mask >= 0)
            for (i = 0; i < 4; i++)
                if (!(mask & (1 << i)))
                    f->layers[i].enabled = 0;
    }
    {
        static int debug = -1;
        if (debug < 0)
            debug = getenv("KATAM_RL_DEBUG") != NULL;
        if (debug && (f->serial % 120) == 0) {
            PortLog("[rl] frame %u world=%d room=%u view %d,%d %dx%d shift %d,%d content %d..%d x %d..%d",
                    (unsigned)f->serial, f->world, (unsigned)sScreen.room, (int)f->viewX, (int)f->viewY,
                    (int)f->viewW, (int)f->viewH, (int)f->shiftX, (int)f->shiftY,
                    (int)f->contentL, (int)f->contentR, (int)f->contentT, (int)f->contentB);
            for (i = 0; i < 3; i++) {
                const BgSnap *b = &sScreen.bg[i];
                PortLog("[rl]   rec%d hw%d flags %04X map %08X %ux%u off %u,%u scroll %u,%u win %u,%u at %u,%u match %d",
                        i, b->flags & 3, b->flags, (unsigned)b->map, b->w, b->h, b->offX, b->offY,
                        b->scrollX, b->scrollY, b->cols, b->rows, b->unk22, b->unk24,
                        RecordMatches(b, b->flags & 3, line0));
            }
        }
    }

    /* HUD sprites: the region holding the box centre decides the anchor.
     * Outside a world frame they are ordinary screen sprites. */
    for (i = 0; i < (int)(f->numSprites + f->numObjWin); i++) {
        RlSprite *s = &sOut[i];

        if (s->space != RL_SPACE_HUD)
            continue;
        if (f->numHud == 0) {
            s->space = RL_SPACE_SCREEN;
            continue;
        }
        {
            s32 bw, bh, cx, cy;
            int r;

            ObjBox(s, &bw, &bh);
            cx = s->x + bw / 2;
            cy = s->y + bh / 2;

            s->anchor = 0;
            for (r = 0; r < f->numHud; r++) {
                const RlHudRegion *h = &f->hud[r];
                if (cx >= h->x0 && cx < h->x1 && cy >= h->y0 && cy < h->y1) {
                    s->anchor = (u8)r;
                    break;
                }
            }
        }
    }

    /* The tile cache's source: VRAM, with the off-screen sprites' frames
     * patched into a copy so they animate in the margin. */
    memcpy(sVram, (const void *)GBA_VRAM_BASE, sizeof(sVram));
    for (i = 0; i < (int)sNumCommitPatch; i++) {
        const TilePatch *p = &sCommitPatch[i];
        memcpy(sVram + p->vramOff, p->src, p->len);
    }
    if (f->world) {
        sPopViewX = f->viewX; sPopViewY = f->viewY;
        sPopViewW = f->viewW; sPopViewH = f->viewH;
    }
    f->vram = sVram;
    memcpy(sPal, (const void *)GBA_PLTT_BASE, sizeof(sPal));
    f->palette = sPal;
    f->light = NULL;
    if (gPortLighting != 0)
        PortLightAttach(f, fgRec >= 0 ? (int)(sScreen.bg[1].flags & 3) : -1);
    return f;
}

const RlFrame *PortRlCurrentFrame(void)
{
    return sFrame.serial ? &sFrame : NULL;
}

/* --- presentation: sub-pixel camera and interpolation --------------------- */

static RlFrame sPres;
static RlSprite sPresSpr[RL_MAX_SPRITES + 128];
static s32 sDiag[4];
static int sDiagOk;

/* a + (b - a) * t / 256, t in 0..256 (256 gives b exactly). */
static s32 Lerp(s32 a, s32 b, s32 t)
{
    return a + (s32)(((s64)(b - a) * t) >> 8);
}

static int Near(s32 a, s32 b, s32 px)
{
    s32 d = a - b;
    return d <= px * 256 && d >= -px * 256;
}

static s32 ClampFp(s32 v, s32 lo, s32 hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

/* Where the view goes, in 1/256 px.  The same rules as PortRlBuildFrame --
 * centred on the camera, or on Kirby when zoomed in; inside the room's
 * rectangle; never off the 240x160 the game composed -- applied to the
 * presented camera instead of the game's whole pixel.  `g` is that camera
 * relative to the game's (SCREEN coords), `kx/ky` Kirby in SCREEN coords. */
static void PresentView(RlFrame *o, s32 gx, s32 gy, int focus, s32 kx, s32 ky,
                        s32 *vx, s32 *vy)
{
    s32 W = o->viewW, H = o->viewH, vx0, vy0, x, y;

    vx0 = -(W - PORT_SCREEN_W) * 128;
    vy0 = -(H - PORT_SCREEN_H) * 128;
    if (W < PORT_SCREEN_W || H < PORT_SCREEN_H) {
        /* Kirby relative to the presented camera's 240x160 screen. */
        s32 fx = kx - gx, fy = ky - gy;

        if (!focus || fx <= 0 || fx >= PORT_SCREEN_W * 256
            || fy <= 0 || fy >= PORT_SCREEN_H * 256) {
            fx = PORT_SCREEN_W / 2 * 256;
            fy = PORT_SCREEN_H / 2 * 256;
        }
        if (W < PORT_SCREEN_W) vx0 = fx - W / 2 * 256;
        if (H < PORT_SCREEN_H) vy0 = fy - H / 2 * 256;
    }
    x = gx + vx0;
    y = gy + vy0;
    x = (sViewLim.rr - sViewLim.rl >= W)
        ? ClampFp(x, sViewLim.rl * 256, (sViewLim.rr - W) * 256)
        : (sViewLim.rl + sViewLim.rr - W) / 2 * 256;
    y = (sViewLim.rb - sViewLim.rt >= H)
        ? ClampFp(y, sViewLim.rt * 256, (sViewLim.rb - H) * 256)
        : (sViewLim.rt + sViewLim.rb - H) / 2 * 256;
    x = gx + ClampFp(x - gx, (PORT_SCREEN_W - W < 0 ? PORT_SCREEN_W - W : 0) * 256,
                     (PORT_SCREEN_W - W > 0 ? PORT_SCREEN_W - W : 0) * 256);
    y = gy + ClampFp(y - gy, (PORT_SCREEN_H - H < 0 ? PORT_SCREEN_H - H : 0) * 256,
                     (PORT_SCREEN_H - H > 0 ? PORT_SCREEN_H - H : 0) * 256);
    *vx = x;
    *vy = y;
}

/* KATAM_RL_PRESLOG=file: per present, BG0's sample origin against the
 * view's world position (1/256 px), for measuring the presented parallax. */
static FILE *sPresLog;

const RlFrame *PortRlPresentFrame(int flags, float alpha)
{
    const Motion *c = &sMot[sMotCur], *p = &sMot[sMotCur ^ 1];
    RlFrame *o = &sPres;
    s32 t, n, i, gx = 0, gy = 0, px = 0, py = 0, vx = 0, vy = 0;
    const void *kirby = &gKirbys[gLocalPlayerId & 3].base.sprite;
    int lerp;

    {
        static int init;
        if (!init) {
            const char *e = getenv("KATAM_RL_PRESLOG");
            init = 1;
            sPresLog = e ? fopen(e, "w") : NULL;
        }
    }
    sDiagOk = 0;
    if (!flags || !sFrame.serial || !c->valid) {
        /* As built; the diagnostics in whole pixels. */
        n = (s32)(sFrame.numSprites + sFrame.numObjWin);
        for (i = 0; i < n && c->valid; i++) {
            s32 gi = sOutGroup[i];

            if (gi >= 0 && gi < c->nGroups && c->g[gi].owner == kirby && c->g[gi].occ == 0) {
                sDiag[0] = (c->g[gi].ax - sFrame.viewX) * 256;
                sDiag[1] = (c->g[gi].ay - sFrame.viewY) * 256;
                sDiagOk = 1;
                break;
            }
        }
        sDiag[2] = (sFrame.camX + sFrame.viewX) * 256;
        sDiag[3] = (sFrame.camY + sFrame.viewY) * 256;
        PortLightRefreshParams(&sFrame);
        return sFrame.serial ? &sFrame : NULL;
    }
    t = (flags & RL_PRESENT_INTERP) ? (s32)(alpha * 256.0f + 0.5f) : 256;
    if (t < 0) t = 0;
    if (t > 256) t = 256;
    lerp = t < 256 && p->valid && !c->corrected && p->commit + 1 == c->commit
        && p->world == c->world && p->room == c->room;
    if (lerp && c->world
        && !(Near(p->camFp[0], c->camFp[0], 64) && Near(p->camFp[1], c->camFp[1], 64)))
        lerp = 0;               /* the camera jumped: a door, a warp */

    memcpy(o, &sFrame, sizeof(*o));
    n = (s32)(sFrame.numSprites + sFrame.numObjWin);
    memcpy(sPresSpr, sFrame.sprites, (size_t)n * sizeof(RlSprite));
    o->sprites = sPresSpr;

    if (c->world) {
        const s32 *kc = c->kirbyFp[gLocalPlayerId & 3], *kp = p->kirbyFp[gLocalPlayerId & 3];
        s32 kx = kc[0], ky = kc[1];

        px = lerp ? Lerp(p->camFp[0], c->camFp[0], t) : c->camFp[0];
        py = lerp ? Lerp(p->camFp[1], c->camFp[1], t) : c->camFp[1];
        gx = px - c->ciX * 256;
        gy = py - c->ciY * 256;
        if (lerp && Near(kp[0], kc[0], 32) && Near(kp[1], kc[1], 32)) {
            kx = Lerp(kp[0], kc[0], t);
            ky = Lerp(kp[1], kc[1], t);
        }
        PresentView(o, gx, gy, c->kirbyFocus, kx - c->ciX * 256, ky - c->ciY * 256,
                    &vx, &vy);
        o->viewX = vx >> 8;
        o->viewY = vy >> 8;
        o->viewSubX = vx & 255;
        o->viewSubY = vy & 255;
        o->shiftX = (vx - gx - (PORT_SCREEN_W - o->viewW) * 128) >> 8;
        o->shiftY = (vy - gy - (PORT_SCREEN_H - o->viewH) * 128) >> 8;
        for (i = 0; i < 4; i++) {
            RlTileLayer *L = &o->layers[i];
            s32 sx, sy, shx, shy;

            if (L->space != RL_SPACE_WORLD || !c->layOk[i])
                continue;
            sx = c->layFp[i][0];
            sy = c->layFp[i][1];
            if (lerp && p->layOk[i] && Near(p->layFp[i][0], sx, 64) && Near(p->layFp[i][1], sy, 64)) {
                sx = Lerp(p->layFp[i][0], sx, t);
                sy = Lerp(p->layFp[i][1], sy, t);
            }
            /* The room layer: its own fraction, and the presented camera's
             * offset from the game's undone (the composite adds it to every
             * layer).  A parallax layer: o(V) at the presented view's world
             * position (ParallaxAxis), from the lerped layer scroll. */
            shx = sx - c->layInt[i][0] * 256 - gx;
            shy = sy - c->layInt[i][1] * 256 - gy;
            if (sPar[i][0].on)
                shx = (s32)(ParallaxOrigin(&sPar[i][0], sx, (s64)vx - gx) - (s64)c->layInt[i][0] * 256 - vx);
            if (sPar[i][1].on)
                shy = (s32)(ParallaxOrigin(&sPar[i][1], sy, (s64)vy - gy) - (s64)c->layInt[i][1] * 256 - vy);
            if (sPresLog && i == 0)
                fprintf(sPresLog, "%u %d %d %d %lld\n", (unsigned)sFrame.serial, t,
                        (int)(c->ciX * 256 + vx), (int)sPar[i][0].f8,
                        (long long)shx + (s64)c->layInt[i][0] * 256 + vx);
            if (c->shakeHw == i + 1) {
                shx += c->shakeD[0];
                shy += c->shakeD[1];
            }
            L->shiftX = shx >> 8;
            L->shiftY = shy >> 8;
            L->subX = shx & 255;
            L->subY = shy & 255;
        }
    }

    for (i = 0; i < n; i++) {
        s32 gi = sOutGroup[i], dx, dy;
        const MotGroup *g, *q;

        if (gi < 0 || gi >= c->nGroups)
            continue;
        g = &c->g[gi];
        dx = g->fx;
        dy = g->fy;
        if (lerp && (q = MotFind(p, g->owner, g->occ)) != NULL
            && Near(q->fx, g->fx, 32) && Near(q->fy, g->fy, 32)) {
            dx = Lerp(q->fx, g->fx, t);
            dy = Lerp(q->fy, g->fy, t);
        }
        sPresSpr[i].subX = (s16)ClampFp(dx - g->bx, -32767, 32767);
        sPresSpr[i].subY = (s16)ClampFp(dy - g->by, -32767, 32767);
        if (g->owner == kirby && g->occ == 0 && !sDiagOk) {
            sDiag[0] = (g->ax - o->viewX) * 256 + sPresSpr[i].subX - o->viewSubX;
            sDiag[1] = (g->ay - o->viewY) * 256 + sPresSpr[i].subY - o->viewSubY;
            sDiagOk = 1;
        }
    }
    sDiag[2] = (o->camX + o->viewX) * 256 + o->viewSubX;
    sDiag[3] = (o->camY + o->viewY) * 256 + o->viewSubY;
    PortLightRefreshParams(o);
    return o;
}

int PortRlPresentDiag(s32 *kirbyViewX, s32 *kirbyViewY, s32 *viewWorldX, s32 *viewWorldY)
{
    *kirbyViewX = sDiag[0];
    *kirbyViewY = sDiag[1];
    *viewWorldX = sDiag[2];
    *viewWorldY = sDiag[3];
    return sDiagOk;
}

/* --- the hooks' attachment to the game ------------------------------------
 *
 * Linker wraps (-Wl,--wrap=..., CMakeLists.txt and the Makefile), not edits
 * to game/: every call the game makes to these three from another file comes
 * here first.  The game's machine code is then byte-for-byte what it was, and
 * that matters more than it should -- the regression hash canonicalises host
 * addresses in game memory by exact match, and the game leaves stale bytes of
 * host function pointers in memory it reuses, so moving a single game
 * function moved the sim hash with no behaviour changed (docs/RENDERER.md,
 * "Proving the simulation unchanged").  None of the three is called from
 * inside its own file, so the wrap sees every call.
 *
 * Where --wrap does not exist (Apple's linker), PORT_RL_NO_WRAP leaves the
 * game calling its own functions and the render list falls back to OAM for
 * sprites -- correct, just without the extra precision. */
#ifndef PORT_RL_NO_WRAP
void __real_DisplaySprite(struct Sprite *sprite);
void __real_sub_081564D8(struct Sprite *sprite);
void __real_DrawToOamBuffer(void);

void __wrap_DisplaySprite(struct Sprite *sprite)
{
    PortRlEmitSprite(sprite, 0);
    __real_DisplaySprite(sprite);
}

void __wrap_sub_081564D8(struct Sprite *sprite)
{
    PortRlEmitSprite(sprite, 1);
    __real_sub_081564D8(sprite);
}

/* Called from UpdateScreenDma/CpuSet as the frame's OAM goes out: the
 * moment the sprites and the camera that the next present shows are fixed.
 * Logic does not run between here and the end of UpdateScreen, so the camera
 * and the Background records are what the tilemap refill uses too. */
void __wrap_DrawToOamBuffer(void)
{
    __real_DrawToOamBuffer();
    PortRlCommitSprites();
    PortRlCommitScreen();
}
#endif

#ifdef __cplusplus
}
#endif
