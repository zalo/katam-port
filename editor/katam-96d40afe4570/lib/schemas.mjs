// Generates the authoring JSON Schemas (assets/schema/authoring/*.schema.json).
//
// The schemas are the contract and the documentation at once: every field has
// a `description` written for a model generating content (what it does in the
// game, the unit, the range, an example), and the enums come from vocab.json
// and the semantics registry, so they double as the prompt and as the
// editor's form definition.  Regenerate with `katam vocab` after the registry
// or the headers change; the generated files are committed.
import { PROP_FREE, PROP_DEFAULTS, TEMPLATE_DEFAULTS } from './room.mjs';
import { TEMPLATE_FIELDS, COLLISION_CAP, NAV_MAX_NODES, ROOM_PROPS_FIELDS } from './native.mjs';
import { KEY_ALPHABET } from './grid.mjs';
import { writeJson } from './json.mjs';

const B = 'katam:schema/';
const SIZE = { 1: [0, 255], 2: [0, 65535] };
const range = (size, signed) => (signed ? (size === 1 ? [-128, 127] : [-32768, 32767]) : SIZE[size]);
const keyClass = KEY_ALPHABET.replace(/[\\\]^-]/g, '\\$&');

function regDesc(e, fallback) {
  if (!e) return fallback;
  const bits = [e.description || fallback];
  if (e.unit) bits.push(`Unit: ${e.unit}.`);
  if (e.default !== undefined && e.default !== null) bits.push(`Neutral value ${e.default}.`);
  if (e.sentinel) bits.push('Special values: ' + Object.entries(e.sentinel).map(([k, v]) => `${k} = ${v}`).join('; ') + '.');
  if (e.usage === 'code_only') bits.push('Every vanilla room uses the same value; other values reach code no shipped level exercises.');
  if (e.usage === 'unused') bits.push('No game code reads this.');
  if (e.confidence) bits.push(`(registry confidence: ${e.confidence})`);
  return bits.join(' ');
}

function common(vocab, registry) {
  const coll = registry.collisionEnum();
  const collNames = Object.values(coll).map((e) => e.name);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: B + 'common',
    title: 'Shared definitions for katam authoring files',
    $defs: {
      roomRef: { type: 'string', pattern: '^room:[a-z0-9_]+/[a-z0-9_]+$', description: 'A room id, "room:<area>/<name>", e.g. "room:rainbow_route/126" (vanilla) or "room:my_mod/sky_garden". "room:vanilla/<number>" also resolves for vanilla rooms.' },
      tilesetRef: { type: 'string', pattern: '^tileset:[a-z0-9_]+/[a-z0-9_]+$', description: 'A foreground tileset id, e.g. "tileset:vanilla/29".' },
      paletteRef: { type: 'string', pattern: '^palette:[a-z0-9_]+/[a-z0-9_]+$', description: 'A foreground palette id, e.g. "palette:vanilla/29". Usually the same number as the tileset.' },
      backgroundRef: { type: 'string', pattern: '^background:[a-z0-9_]+/[a-z0-9_]+$', description: 'A background (parallax layer) id, e.g. "background:vanilla/28".' },
      tileToken: { type: 'string', pattern: '^[0-9a-f]{3}[.hvx][0-9a-f]$', description: 'One 8x8 tilemap entry, "TTTfP": TTT = tile index in hex (000-3ff), f = flip (. none, h horizontal, v vertical, x both), P = palette bank in hex. "000.0" is tile 0 unflipped in bank 0.' },
      metatile: { type: 'string', pattern: '^[0-9a-f]{3}[.hvx][0-9a-f]( [0-9a-f]{3}[.hvx][0-9a-f]){3}$', description: 'A 16x16 cell drawn as four 8x8 tile tokens, "TL TR BL BR", e.g. "001.0 002.0 021.0 022.0".' },
      collisionValue: {
        description: 'A collision (metatile attribute) value: an index 0-255 into the game\'s terrain table gCollisionAttributes. ' +
          (collNames.length ? 'Named values come from the semantics registry.' : 'No semantics registry is loaded, so values are raw: 0 = empty air, 13 = solid block, 15 = one-way platform; vocab.json "collision" lists every value with its decoded bits (solid, water, top_solid, ladder, hazard, door, slopeN...).'),
        anyOf: [{ type: 'integer', minimum: 0, maximum: 255, description: 'raw value' }, ...(collNames.length ? [{ type: 'string', enum: collNames, description: 'registry name' }] : [])],
      },
      cell: { type: 'array', prefixItems: [{ type: 'integer', minimum: 0, maximum: 255 }, { type: 'integer', minimum: 0, maximum: 255 }], minItems: 2, maxItems: 2, description: '[x, y] in 16-pixel cells, (0, 0) = top-left.' },
      gridRows: { type: 'array', items: { type: 'string', pattern: `^[${keyClass}]*$` }, description: 'One string per row, top to bottom; each row is `width` legend keys concatenated (every key in a legend has the same length, 1 or 2 characters).' },
      legendKey: { type: 'string', pattern: `^[${keyClass}]{1,2}$` },
      music: { anyOf: [{ type: 'string', enum: Object.keys(vocab.songs), description: 'song name' }, { type: 'integer', minimum: 0, maximum: 65535, description: 'song number' }], description: 'Background music, a name from game/include/constants/songs.h lowercased (e.g. "mus_rainbow_route"; a few vanilla rooms name an se_ entry), or a song number.' },
      objectType: { anyOf: [{ type: 'string', enum: Object.keys(vocab.objectTypes), description: 'object type name' }, { type: 'integer', minimum: 0, maximum: 255, description: 'type number' }], description: 'Object type: a name from game/include/constants/object_types.h without OBJ_, lowercased (e.g. "waddle_dee_1", "small_chest", "warp_star"), or the type number.' },
      ability: { anyOf: [{ type: 'string', enum: Object.keys(vocab.abilities) }, { type: 'integer', minimum: 0, maximum: 65535 }], description: 'A copy ability (game/include/constants/kirby.h without KIRBY_ABILITY_, lowercased), e.g. "fire", "sword"; "normal" = none.' },
      hexBytes: { type: 'string', pattern: '^([0-9a-f]{2})*$', description: 'Raw bytes as lowercase hex.' },
    },
  };
}

function roomSchema(vocab, registry) {
  const props = {}, raw = {};
  for (const f of PROP_FREE) {
    const def = ROOM_PROPS_FIELDS.find((x) => x[0] === f);
    const [lo, hi] = range(def[2], def[3]);
    const e = registry.field('room_props', f);
    const n = registry.nameOf(e);
    raw[f] = { type: 'integer', minimum: lo, maximum: hi, default: PROP_DEFAULTS[f], description: regDesc(e, `RoomProps.${f}: not decoded yet (provisional raw field).`) + ` Omitted = ${PROP_DEFAULTS[f]}.` };
    if (n) {
      const bits = (e.bits || []).filter((b) => b.name);
      props[n] = bits.length
        ? { anyOf: [{ type: 'integer', minimum: lo, maximum: hi }, { type: 'object', properties: Object.fromEntries([...bits.map((b) => [b.name, { type: 'boolean', description: regDesc(b, '') + ` (mask ${b.mask})` }]), ['_otherBits', { type: 'integer' }]]), additionalProperties: false }], description: regDesc(e, '') + ` Same as raw.${f}.` }
        : { type: 'integer', minimum: lo, maximum: hi, description: regDesc(e, '') + ` Same as raw.${f}; omitted = ${PROP_DEFAULTS[f]}.` };
    }
  }
  const tmplRaw = {};
  for (const [f, , size, signed] of TEMPLATE_FIELDS) {
    if (['type', 'x', 'y', 'unk1'].includes(f)) continue;
    const [lo, hi] = range(size, signed);
    const e = registry.field('object_template', f);
    tmplRaw[f] = { type: 'integer', minimum: lo, maximum: hi, description: regDesc(e, `ObjectTemplate.${f}: meaning depends on the object type and is not decoded yet.`) + ` Omitted = ${TEMPLATE_DEFAULTS[f] ?? 0}.` };
  }
  const genericNamed = {};
  for (const [f] of TEMPLATE_FIELDS) {
    const e = registry.field('object_template', f);
    const n = registry.nameOf(e);
    if (n && !['type', 'x', 'y'].includes(n)) genericNamed[n] = { type: 'integer', description: regDesc(e, '') + ` Same as raw.${f}.` };
  }
  // per-type params from the registry
  const perType = [];
  for (const [num, name] of Object.entries(vocab.objectTypeName)) {
    const ps = registry.objectParams(Number(num));
    const pp = {};
    for (const [f, e] of Object.entries(ps)) { const n = registry.nameOf(e); if (n) pp[n] = { type: 'integer', description: regDesc(e, '') + ` (template field ${f})` }; }
    if (Object.keys(pp).length) perType.push({ if: { properties: { type: { anyOf: [{ const: name }, { const: Number(num) }] } }, required: ['type'] }, then: { properties: { params: { type: 'object', properties: pp, additionalProperties: false } } } });
  }
  const C = (d) => ({ $ref: `${B}common#/$defs/${d}` });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: B + 'room',
    title: 'katam room (katam-room/1)',
    description: 'One room: its size, art, collision, objects, doors and properties. Coordinates: cells are 16x16 px, (0,0) top-left, x right, y down; objects are in pixels. A room is at least one screen (15x10 cells) and width*height must not exceed ' + COLLISION_CAP + ' cells. See docs/design/authoring/rooms.md and docs/design/authoring/AI-GUIDE.md.',
    type: 'object',
    required: ['format', 'id', 'size', 'music', 'tileset', 'palette', 'background', 'art', 'collision'],
    additionalProperties: false,
    properties: {
      format: { const: 'katam-room/1' },
      id: { ...C('roomRef'), description: 'This room\'s id; must match the file path: rooms/<area>/<name>.room.json has id "room:<area>/<name>".' },
      name: { type: 'string', description: 'Human-readable name (not used by the game).' },
      description: { type: 'string', description: 'Free text: intent, notes for the next editor or model (not used by the game).' },
      bind: { type: 'object', additionalProperties: false, description: 'Numeric ids in the game. Vanilla rooms carry them so they compile to the same slots; new rooms omit bind and the compiler allocates.', properties: { roomId: { type: 'integer', minimum: 0, maximum: 65534, description: 'gRoomProps index (vanilla: 101-982).' }, content: { type: 'integer', minimum: 0, maximum: 65534, description: 'Index shared by the room\'s tilemap, collision, object, progress and nav tables (vanilla: 0-286).' } } },
      size: { type: 'object', required: ['width', 'height'], additionalProperties: false, description: 'Room size in 16-px cells. The fg tilemap is twice this in 8-px tiles. One screen is 15x10 cells.', properties: { width: { type: 'integer', minimum: 15, maximum: 255 }, height: { type: 'integer', minimum: 10, maximum: 255 } } },
      music: C('music'),
      area: { type: 'string', enum: Object.keys(vocab.areas), description: 'New rooms only: the world area the game files the room under (the AI helpers\' room graph and the pause screens\' area lookup, gUnk_08D6CD0C.unk46). Default: the area of the vanilla room the first door leads to, else rainbow_route. Vanilla rooms ignore it (their area comes from the game).' },
      tileset: C('tilesetRef'),
      palette: C('paletteRef'),
      background: C('backgroundRef'),
      props: { type: 'object', additionalProperties: false, properties: props, description: 'Room properties with registry names (camera, parallax, flags). Empty until the semantics registry names them; use raw meanwhile.' },
      raw: { type: 'object', additionalProperties: false, properties: raw, description: 'Room properties by their C field name, for fields the registry has not named. Always accepted, even after a field gets a name.' },
      fgLayerRoomTag: { type: 'integer', description: 'Advanced: the room-id annotation in the playfield layer header; defaults to this room\'s numeric id.' },
      art: {
        type: 'object', required: ['legend', 'rows'], additionalProperties: false,
        description: 'The playfield art (HW BG3), one legend key per 16x16 cell. Each legend value is a metatile: four 8x8 tile tokens from the room\'s tileset. Art is separate from collision: what you see vs. what is solid.',
        properties: { legend: { type: 'object', propertyNames: C('legendKey'), additionalProperties: C('metatile') }, rows: C('gridRows') },
      },
      collision: {
        type: 'object', required: ['legend', 'rows'], additionalProperties: false,
        description: 'What each 16x16 cell is to physics, one legend key per cell. Conventional keys: "." empty, "#" solid, "=" one-way platform, "~" water, "^" hazard, "%" breakable, "D" door cell, "H" ladder; the legend decides.',
        properties: { legend: { type: 'object', propertyNames: C('legendKey'), additionalProperties: C('collisionValue') }, rows: C('gridRows') },
      },
      patches: {
        type: 'array', description: 'Cell changes the game applies at run time to a cell (e.g. a breakable block turning into air): new art and new collision for one cell. Several on one cell apply in order.',
        items: { type: 'object', required: ['x', 'y', 'tiles', 'collision'], additionalProperties: false, properties: {
          x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 },
          tiles: { type: 'array', items: C('tileToken'), minItems: 4, maxItems: 4, description: 'New art for the cell: TL TR BL BR.' },
          collision: C('collisionValue'),
          key: { type: 'integer', minimum: 0, maximum: 255, description: 'Advanced: the collision value that selects this patch; derived from the grid (and earlier patches on the cell) when omitted.' },
        } },
      },
      doors: {
        type: 'array', description: 'Door transitions: standing on one of `cells` and entering takes Kirby to `arrive` in room `to`. Order matters: it is the order of the per-room save bits (chests first, then doors), so append rather than reorder in an existing room. Most doors need a door-typed collision value under their cells and often a door object for the graphics.',
        items: { type: 'object', required: ['to', 'arrive', 'cells'], additionalProperties: false, properties: {
          to: C('roomRef'),
          arrive: { type: 'object', required: ['x', 'y'], additionalProperties: false, description: 'Where Kirby arrives in the destination room, in 16-px cells: the cell he lands ON (in vanilla, the floor cell right under the destination door), so the cell above it must be empty.', properties: { x: { type: 'integer', minimum: 0, maximum: 255 }, y: { type: 'integer', minimum: 0, maximum: 255 } } },
          cells: { type: 'array', items: C('cell'), minItems: 1, description: 'The cells of this room that act as the door.' },
          flags: { type: 'integer', minimum: 0, maximum: 255, description: 'Door behaviour bits (Unk_0888562C_3.unk0C): 0x80 = do not move the respawn point; 0x01 / 0x02 = arrive facing one way / the other (docs/naming/doors.md). Omitted = 0.' },
          cellFlags: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, description: 'Advanced: per-cell flags when they differ between cells of one door.' },
          note: { type: 'string' },
        } },
      },
      objects: {
        type: 'array', description: 'Things placed in the room: enemies, items, chests, gadgets, triggers. Positions are pixels (cell * 16 + 8 is a cell centre). Order is the spawn order.',
        items: { type: 'object', required: ['type', 'x', 'y'], additionalProperties: false, allOf: perType, properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$', description: 'Stable handle within the room, for mod patches and the editor (not used by the game).' },
          type: C('objectType'),
          x: { type: 'integer', minimum: -32768, maximum: 32767, description: 'pixels from the room\'s left edge' },
          y: { type: 'integer', minimum: -32768, maximum: 32767, description: 'pixels from the room\'s top edge' },
          params: { type: 'object', description: 'Type-specific parameters with registry names (see object_params in the semantics registry).' },
          raw: { type: 'object', additionalProperties: false, properties: tmplRaw, description: 'Template fields by C name for anything not yet named. Meaning depends on the type.' },
          stride: { type: 'integer', minimum: 0, maximum: 255, description: 'Advanced: record size (36).' },
          note: { type: 'string' },
          ...genericNamed,
        } },
      },
      nav: {
        type: 'object', required: ['legend', 'rows', 'nodes'], additionalProperties: false,
        description: 'Navigation graph for the computer-controlled helper Kirbys: which node region each cell belongs to, the nodes, and four per-player scripts. Optional: omitted, the compiler emits a one-node graph (helpers idle in the room).',
        properties: {
          legend: { type: 'object', propertyNames: C('legendKey'), additionalProperties: { type: 'integer', minimum: 0, maximum: 255 } },
          rows: C('gridRows'),
          nodes: { type: 'array', minItems: 1, maxItems: NAV_MAX_NODES, items: { type: 'object', required: ['x', 'y', 'nextHop'], additionalProperties: false, properties: {
            x: { type: 'integer', description: 'px' }, y: { type: 'integer', description: 'px' }, radius: { type: 'integer', description: 'px; default 32' },
            nextHop: { ...C('hexBytes'), description: '32 bytes: for each destination node, the neighbour to step to (ff = unreachable).' },
            extra: { ...C('hexBytes'), description: '14 bytes nothing in the game reads (own index + a neighbour list).' },
          } } },
          scripts: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 65535 } }, description: 'Per-player AI bytecode (u16 words, without the 0xFFFF end).' },
        },
      },
    },
  };
}

function simple(id, title, description, required, properties) {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: B + id, title, description, type: 'object', required, additionalProperties: false, properties };
}

export function buildSchemas(vocab, registry) {
  const C = (d) => ({ $ref: `${B}common#/$defs/${d}` });
  const color = { type: 'string', pattern: '^#[0-9A-F]{6}$', description: '#RRGGBB; stored as BGR555 (5 bits per channel), so use multiples of 8 (+ low bits copied from the top: #RRGGBB = c5<<3|c5>>2 round-trips exactly).' };
  return {
    common: common(vocab, registry),
    room: roomSchema(vocab, registry),
    project: simple('project', 'katam project (katam-project/1)', 'A folder of authoring files. A mod project names its base (usually the player\'s decompiled vanilla project) and adds or replaces resources by id.', ['format', 'id'], {
      format: { const: 'katam-project/1' }, id: { type: 'string', pattern: '^[a-z0-9_.-]+$' }, name: { type: 'string' }, description: { type: 'string' }, note: { type: 'string' },
      base: { type: ['string', 'null'], description: '"vanilla" for a mod on top of the game; compile/validate take the base folder with --base.' },
      authors: { type: 'array', items: { type: 'string' } }, license: { type: 'string' }, romSha1: { type: 'string' }, registry: {},
    }),
    tileset: simple('tileset', 'katam foreground tileset (katam-tileset/1)', 'The playfield\'s 8x8 tiles (VRAM char block 2) as an indexed PNG, 4 bits per pixel, 32 tiles per row; plus looping tile animations. The PNG palette is only a preview: pixel indices 0-15 are the data, colours come from the room\'s palette bank. Index 0 is transparent.', ['format', 'id', 'image', 'tileCount'], {
      format: { const: 'katam-tileset/1' }, id: C('tilesetRef'), bind: { type: 'object', properties: { index: { type: 'integer' } }, additionalProperties: false },
      image: { type: 'string', description: 'PNG next to this file.' }, tileCount: { type: 'integer', minimum: 1, maximum: 1024, description: 'Tiles to read from the image (row-major). The playfield can address 768 (char block 2-3).' },
      roomTag: { type: 'integer', description: 'Authoring annotation kept from the original data (a room id); not read by the game.' },
      previewPalette: C('paletteRef'),
      animations: { type: 'array', items: { type: 'object', required: ['tile', 'tiles', 'frames'], additionalProperties: false, properties: {
        tile: { type: 'integer', description: 'First tile overwritten.' }, tiles: { type: 'integer', description: 'Tiles per chunk.' }, chunks: { type: 'integer', description: 'Chunks per frame (default 1).' }, chunkStride: { type: 'integer', description: 'Tiles between chunks, source and destination (default 32 = one sheet row).' },
        frames: { type: 'array', minItems: 1, items: { type: 'object', required: ['gfxTile', 'duration'], additionalProperties: false, properties: { gfxTile: { type: 'integer', description: 'First tile of this frame in animImage.' }, duration: { type: 'integer', minimum: 1, description: 'frames (60 Hz)' }, pad: { type: 'integer' } } } },
      } } },
      animImage: { type: 'string' }, animTileCount: { type: 'integer' },
    }),
    background: simple('background', 'katam background (katam-background/1)', 'A parallax background layer (HW BG0): its tiles (indexed PNG), palette banks and tilemap. Shared by every room that names it.', ['format', 'id', 'size', 'image', 'tileCount', 'palette', 'tilemap'], {
      format: { const: 'katam-background/1' }, id: C('backgroundRef'), bind: { type: 'object', properties: { index: { type: 'integer' } }, additionalProperties: false },
      size: { type: 'object', required: ['width', 'height'], additionalProperties: false, properties: { width: { type: 'integer', minimum: 1, maximum: 255 }, height: { type: 'integer', minimum: 1, maximum: 1023 } }, description: '8-px tiles.' },
      image: { type: 'string' }, tileCount: { type: 'integer', minimum: 1, maximum: 1024 },
      palette: { type: 'object', required: ['offset', 'colors'], additionalProperties: false, properties: { offset: { type: 'integer', description: 'First BG palette entry written (colours; 96 = bank 6).' }, colors: { type: 'array', items: color }, bit15: { type: 'array', items: { type: 'integer' }, description: 'Entries whose unused top bit is set (kept for exactness).' } } },
      tilemap: { type: 'array', items: { type: 'string', pattern: '^[0-9a-f]{3}[.hvx][0-9a-f]( [0-9a-f]{3}[.hvx][0-9a-f])*$' }, description: 'One row per line, width tile tokens separated by spaces.' },
      roomTag: { type: 'integer' }, tilesetSizeField: { type: 'integer' }, raw: { type: 'object' },
    }),
    palette: simple('palette', 'katam foreground palette (katam-palette/1)', 'The playfield\'s six 16-colour banks (BG palette banks 0-5). Colour 0 of each bank is transparent.', ['format', 'id', 'banks'], {
      format: { const: 'katam-palette/1' }, id: C('paletteRef'), bind: { type: 'object', properties: { index: { type: 'integer' } }, additionalProperties: false },
      banks: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'array', minItems: 16, maxItems: 16, items: color } },
      bit15: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 95 } }, roomTag: { type: 'integer' },
      animations: { type: 'object', additionalProperties: false, properties: { count: { type: 'integer' }, vanillaRef: { type: 'string', description: 'Palette-cycling animations are not decoded into the authoring format yet; this keeps the original\'s.' } } },
    }),
    object: simple('object', 'katam object type (katam-object/1)', 'Per-type data of an enemy, item, gadget or boss: what the game keeps in a table (score, hit points, copy ability, tile budget). Behaviour is code; see docs/design/authoring/enemies.md.', ['format', 'id', 'bind'], {
      format: { const: 'katam-object/1' }, id: { type: 'string', pattern: '^object:[a-z0-9_]+$' }, bind: { type: 'object', required: ['type'], properties: { type: { type: 'integer', minimum: 0, maximum: 255 } }, additionalProperties: false },
      constName: { type: 'string' }, category: { type: 'string' }, ability: C('ability'), numTiles: { type: 'integer', minimum: 0, description: 'OBJ VRAM tiles reserved when it spawns.' },
      stats: { type: 'object', description: 'Registry-named descriptor fields (score, hp, ...).' }, raw: { type: 'object', description: 'Descriptor fields by C name (unk0, unk1, unk2, unk4, unk8, pad0A).' },
      code: { type: 'object', additionalProperties: false, properties: { constructor: { type: 'string' }, animation: { type: 'string' } }, description: 'ROM addresses of the type\'s constructor and animation bank: references to code, kept verbatim.' },
    }),
  };
}

export function writeSchemas(io, dir, vocab, registry) {
  const all = buildSchemas(vocab, registry);
  for (const [k, s] of Object.entries(all)) io.writeText(`${dir}/${k}.schema.json`, writeJson(s));
  return Object.keys(all).length;
}

export const SCHEMA_PREFIX = B;
