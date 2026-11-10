/* The area each room belongs to, for the lighting (render_list.h).
 *
 * The ids are the game's own area-map table, game/src/pause_area_map.c:
 * sAreaMapRoomInfos (static there, so copied rather than linked -- room ids
 * only, no ROM bytes), in its order, partitioned by AreaId as that file's
 * sAreaMapRoomInfoOffset / sAreaMapRoomInfoLength (AREAMAP_ROOMINFO_OFFSET_*)
 * partition it.  263 ids, none in two areas.  AREA_TUTORIAL and
 * AREA_DIMENSION_MIRROR have no entries there (length 0): the game tells
 * those rooms apart by their room header's area byte instead
 * (GetKirbyRoomFlagIndex), so for a room the area map does not list that
 * byte is read; -1 if it says nothing.
 */
#include "port/port.h"
#include "gba/gba.h"
#include "global.h"
#include "pause_area_map.h"
#include "data.h"
#include "render/render_list.h"

/* The rooms the game has (the port adds its own above this). */
#define GAME_ROOMS 983

static const u16 kAreaRooms[] = {
    /* AREA_RAINBOW_ROUTE (51) */
    0x7e, 0x22d, 0xbe, 0xc2, 0x321, 0xb0, 0xc0, 0x24e, 0xb1, 0x217, 0x21a,
    0x218, 0x219, 0x21e, 0x21f, 0x8d, 0x8f, 0x22c, 0x22b, 0x22a, 0x6c, 0x8c,
    0x67, 0x68, 0x6b, 0x6a, 0x65, 0x6e, 0x1f7, 0x1fb, 0x89, 0x88, 0x7f, 0x1f8,
    0xae, 0x77, 0x76, 0xad, 0xaf, 0xac, 0xab, 0x75, 0x73, 0x8b, 0x216, 0x23a,
    0x23b, 0x214, 0x8a, 0xb2, 0x8e,
    /* AREA_MOONLIGHT_MANSION (26) */
    0x2bc, 0x90, 0x93, 0x92, 0x91, 0x95, 0x2e4, 0x2c4, 0x2e7, 0xb4, 0x2c2,
    0x2be, 0x2e8, 0x2c5, 0x2c3, 0x2c0, 0x2c7, 0x2c8, 0x2e5, 0x2e6, 0x316,
    0x2e9, 0x2c6, 0x2c1, 0xc3, 0x94,
    /* AREA_CABBAGE_CAVERN (21) */
    0x1f4, 0x1fc, 0x210, 0x20f, 0x203, 0x201, 0x1fd, 0x1fe, 0x1f5, 0x202,
    0x205, 0x212, 0x20b, 0x211, 0x200, 0x1ff, 0x250, 0x204, 0x24f, 0x213, 0xbf,
    /* AREA_MUSTARD_MOUNTAIN (25) */
    0x138, 0x13d, 0x139, 0x145, 0x215, 0x130, 0x143, 0x13b, 0x142, 0x13c,
    0x134, 0x141, 0x222, 0x221, 0x220, 0x21c, 0x21d, 0x21b, 0x144, 0x146,
    0x136, 0x186, 0x223, 0x13e, 0x12c,
    /* AREA_CARROT_CASTLE (23) */
    0x258, 0x2cc, 0x2da, 0x2d0, 0x2de, 0x2dd, 0x2cd, 0x2e1, 0x2e0, 0x2df,
    0x2ca, 0x2cf, 0xaa, 0xb5, 0x7a, 0x78, 0x79, 0xe2, 0x2db, 0x2dc, 0x2e2,
    0x2e3, 0xc1,
    /* AREA_OLIVE_OCEAN (29) */
    0x82, 0x83, 0x33a, 0x84, 0x85, 0x86, 0x33b, 0x33c, 0x337, 0x338, 0x33f,
    0x32e, 0x33d, 0x32b, 0x33e, 0x227, 0x229, 0x340, 0x32a, 0x322, 0x333,
    0x335, 0x336, 0x330, 0x32f, 0x37a, 0x339, 0x87, 0x320,
    /* AREA_PEPPERMINT_PALACE (31) */
    0xe0, 0xdb, 0xe6, 0xd6, 0xd1, 0x122, 0x123, 0xce, 0xe5, 0xe4, 0xcd, 0xd2,
    0xca, 0xd0, 0xd3, 0xde, 0xe3, 0xcb, 0xcc, 0xdc, 0xe1, 0xe8, 0xe7, 0xd7,
    0xd4, 0xd8, 0xdf, 0xd9, 0xdd, 0xda, 0xc8,
    /* AREA_RADISH_RUINS (29) */
    0x26e, 0x262, 0x2b2, 0x269, 0x20e, 0x81, 0x25b, 0x26f, 0x25c, 0x25e, 0x26c,
    0x26d, 0x25d, 0x259, 0x263, 0x264, 0x261, 0x266, 0x26a, 0x268, 0x265,
    0x260, 0x26b, 0x20d, 0x1f6, 0x20c, 0x71, 0x66, 0x72,
    /* AREA_CANDY_CONSTELLATION (28) */
    0x199, 0x1a9, 0x1ab, 0x194, 0x197, 0x191, 0x198, 0x195, 0x19b, 0x1a2,
    0x19e, 0x192, 0x1a3, 0x1a8, 0x1a6, 0x19f, 0x1a7, 0x1a5, 0x1a0, 0x19d,
    0x193, 0x1ea, 0x196, 0x1aa, 0x1a4, 0x1a1, 0x19c, 0x190,
};

/* Where each area's ids start in kAreaRooms; area a is
 * [kAreaStart[a], kAreaStart[a + 1]).  The game's AREAMAP_ROOMINFO_OFFSET_*. */
static const u16 kAreaStart[NUM_AREA_IDS + 1] = {
    0x000,  /* AREA_TUTORIAL (none)   */
    0x000,  /* AREA_RAINBOW_ROUTE     */
    0x033,  /* AREA_MOONLIGHT_MANSION */
    0x04d,  /* AREA_CABBAGE_CAVERN    */
    0x062,  /* AREA_MUSTARD_MOUNTAIN  */
    0x07b,  /* AREA_CARROT_CASTLE     */
    0x092,  /* AREA_OLIVE_OCEAN       */
    0x0af,  /* AREA_PEPPERMINT_PALACE */
    0x0ce,  /* AREA_RADISH_RUINS      */
    0x0eb,  /* AREA_CANDY_CONSTELLATION */
    0x107,  /* AREA_DIMENSION_MIRROR (none) */
    0x107,  /* end                    */
};

/* The table and the partition agree (a negative array size if not). */
typedef char kAreaRoomsCountCheck[
    sizeof(kAreaRooms) / sizeof(kAreaRooms[0]) == 0x107 ? 1 : -1];

int PortLightRoomArea(u16 room)
{
    int a;
    unsigned i;

    /* First area that lists it wins (none lists one twice). */
    for (a = 0; a < NUM_AREA_IDS; a++)
        for (i = kAreaStart[a]; i < kAreaStart[a + 1]; i++)
            if (kAreaRooms[i] == room)
                return a;
    /* Not on the area map (the tutorial, the Dimension Mirror): the room
     * header's own area byte, as GetKirbyRoomFlagIndex reads it -- 0..8
     * Rainbow Route..Candy Constellation, 9 the tutorial, 10 the Mirror. */
    if (room < GAME_ROOMS && gUnk_08D6CD0C[room]) {
        u8 b = gUnk_08D6CD0C[room]->unk46;
        if (b <= 8)
            return AREA_RAINBOW_ROUTE + b;
        if (b == 9)
            return AREA_TUTORIAL;
        if (b == 10)
            return AREA_DIMENSION_MIRROR;
    }
    return -1;
}

/* Indoors or out, as people judged each room from the game's own picture
 * (one view per room, 2026-11-10): the lighting's Auto mode uses point
 * lights indoors and the area's sun outside.  A room not judged falls back
 * to light.c's test (how much of the room's air the sun would light).  The
 * world map screens are no rooms to light. */
static const u16 kIndoorRooms[] = {
    110, 126, 127, 137, 146, 175, 176, 180, 181, 202, 205, 208, 209, 211,
    212, 215, 217, 219, 222, 223, 224, 225, 227, 228, 229, 230, 290, 304,
    308, 310, 312, 313, 316, 317, 325, 390, 405, 411, 417, 419, 424, 425,
    426, 503, 504, 507, 533, 535, 537, 540, 541, 545, 551, 553, 555, 556,
    557, 570, 600, 601, 603, 604, 605, 606, 608, 609, 610, 611, 612, 613,
    614, 616, 617, 618, 619, 620, 621, 622, 623, 700, 702, 704, 705, 706,
    707, 708, 709, 710, 711, 712, 714, 716, 717, 732, 733, 734, 735, 736,
    738, 739, 741, 743, 744, 811, 815, 816, 819, 823, 824, 826, 827, 829,
    830, 831, 832, 911, 913, 914, 915, 951,
};
static const u16 kOutdoorRooms[] = {
    102, 107, 115, 117, 118, 119, 120, 121, 134, 136, 139, 141, 143, 147,
    148, 149, 171, 177, 178, 190, 192, 203, 210, 216, 218, 322, 401, 402,
    403, 406, 407, 408, 413, 414, 416, 422, 427, 490, 502, 532, 539, 544,
    719, 730, 742, 800, 803, 810, 814, 822, 825, 828, 950, 970, 980,
};
static const u16 kMapRooms[] = {
    193, 194, 291, 590, 690, 790, 890,
};

static int InTable(const u16 *t, unsigned n, u16 room)
{
    unsigned i;
    for (i = 0; i < n; i++)
        if (t[i] == room)
            return 1;
    return 0;
}
#define IN(t, r) InTable(t, sizeof(t) / sizeof(t[0]), r)

int PortLightRoomIndoor(u16 room)
{
    if (IN(kIndoorRooms, room))
        return 1;
    if (IN(kOutdoorRooms, room))
        return 0;
    return -1;
}

int PortLightRoomUnlit(u16 room)
{
    return IN(kMapRooms, room);
}

/* Rooms whose background art has lamps the lighting finds and places
 * right: people reviewed every room's lamps (two rounds, 2026-11-10) and
 * found them on real lamps here -- mostly Moonlight Mansion's wall lamps --
 * and elsewhere almost only on bright terrain, water and ice.  Elsewhere the
 * lamps are not used; an indoor room is lit softly instead. */
static const u16 kLampRooms[] = { 225, 227, 600, 704, 707, 708, 711, 741 };

int PortLightRoomLamps(u16 room)
{
    return IN(kLampRooms, room);
}
