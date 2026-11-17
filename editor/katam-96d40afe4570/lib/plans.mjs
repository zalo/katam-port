// `katam reach`: designed, not implemented yet (katam playtest is implemented).  The plan
// is printed by the CLI (exit status 3 = "not implemented") so a script or a
// model calling them learns what they will do and what to use meanwhile.
const PLANS = {
  reach: `katam reach ROOM... -- not implemented yet (docs/design/AUTHORING.md section "reach").

Will answer: from each door / arrival point of a room, which other doors and
arrivals can Kirby get to?  Model: a graph over standable cells (an empty cell
with a floor -- solid, top_solid or slope -- below).  Edges: walk left/right
along floors and slopes; fall; jump (an envelope of cells derived from
Kirby's jump impulse, gravity and air speed -- the kirby.physics.* entries of
the semantics tuning inventory -- and checked against the native build by
recording jumps); float (Kirby flies indefinitely,
so with "float" on, any empty cell connected to the arrival through air is
reachable -- the default, matching the game; --no-float models a mini/stone
ability or water ceilings); ladders climb; water swims; hazards are
traversable but reported; breakable blocks are passable with --abilities.
Doors are edges between rooms (the world graph), checked both ways.
Output: per room, the reachable door set and unreachable doors with the
blocking cells; --json for tools.  Until then: katam validate checks
references, arrivals and one-way doors, and katam render --overlay doors
draws doors and arrivals.`,
};
export const plan = (cmd) => PLANS[cmd];
