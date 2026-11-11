# How it works — a guided tour

Plain-language tour of the systems as they exist **now** (end of M0). Updated every session. Words in
`code font` are names you can search for in the repository.

## The big picture

The game is split into a **simulation** and everything around it.

- The **simulation** (`packages/sim`) is the battle itself: where every man is, what he carries, what orders
  are on their way. It knows nothing about screens, phones or real time. It moves forward in small fixed
  steps called **ticks** — 60 per second of game time.
- The **app** (`packages/app`) is what you open in the browser. It watches the real clock and tells the
  simulation "do another tick" as often as needed. It draws the picture and turns your taps into orders.
- The **tools** (`packages/tools`) run the same simulation without a screen, thousands of times faster than
  real time, to test it.

Because the simulation never looks at the real clock and never uses "real" randomness, running the same battle
twice with the same starting conditions gives *exactly* the same result, down to the last decimal. That is
called **determinism**. It is what makes replays, save games, automated testing and (one day) multiplayer
possible.

## The pieces

**Data, not code.** Everything about a faction lives in JSON text files in `packages/data/factions/<id>/`:
ranks, roles, name lists, unit templates, equipment items, doctrine values, and radio phrases. The engine never
says "if German, do X". To prove it, the tests load a third, made-up faction (`xf`, in
`packages/data/fixtures/`) and fight a battle with it.

**The loader** (`packages/data`) reads those files and checks them: required fields present, numbers in
plausible ranges, every rank and role a unit template mentions actually exists, every entry has a source or is
flagged "low confidence". Mistakes are reported with the file and the exact spot.

**Soldiers are individuals.** Each soldier has a name (drawn from the faction's name lists), a rank, a role,
skills drawn from the unit's quality level (conscript, regular, veteran), a load of counted items, and fields
waiting for later milestones: fatigue, heart rate, stress, morale, wounds.

**Items are real.** A magazine is an item with a mass; the rounds in it are counted. A half-empty magazine is
kept separately from full ones. Items sit in **containers** — a soldier's load, and later a vehicle, a crate or
a depot. There is one way to move items from one container to another (`transferItems`), and it is used for
everything: passing ammunition, cross-loading, medical kit.

**Orders are the only way in.** Your taps, the computer opponent and a replay all do exactly one thing: create
an **order** (a small record: when, from which side, to which unit, what to do). Nothing else from outside may
change the battle.

**Events are the only way out.** The simulation announces what happened — "order received", "order
delivered", radio message, "unit arrived" — as **events**. The picture, the radio log and the test tools all
listen to events instead of poking around inside the simulation.

**Text goes through a string table.** Radio messages are not stored as sentences but as keys like
`radio.ack.move`. The string table turns a key into text — in the faction's own phrasing ("Trupp 1: roger,
moving." vs "Gruppa 1: understood, moving out.") and later in other languages.

## The map

A map is 2 × 2 km by default, cut into a grid of 4 × 4 m squares (cells).

- **Height**: every corner of every cell has a height. Between corners the height is blended smoothly, so
  hills are gentle slopes, not steps.
- **Ground and plants**: every cell has a ground type (grass, ploughed field, asphalt, yard, water ...) and
  optionally plants (crops, scrub, woodland, orchard ...). Each type comes from the terrain data files and says
  how fast you can cross it on foot, on wheels or on tracks, how much it hides you, and later how much it
  stops bullets.
- **Things with exact shapes** are drawn as lines and outlines on top: walls, fences, hedges, embankments
  (each with height, thickness and material), buildings (outline, storeys, wall material and thickness,
  doors and windows), roads and water.
- **Damage** (holes in walls, craters, shot-up trees) belongs to the battle, not to the map, so it is saved
  with the battle. Nothing creates damage yet; shooting arrives in M2.

**Generated maps.** `generateMap` builds a map from a kind and a seed number. The same seed always gives the
same map on every device, so a map never needs to be sent anywhere — the seed is enough. For a village it:
shapes gentle hills (and a valley if a stream runs through); lays the main road and a crossing road; picks a
street village or a clustered village; places farm plots along the roads (house near the road, yard, barn
closing the yard, garden, orchard at the back, a wall or fence with a gate in front, fences between plots), a
church with a walled churchyard, maybe a pond and a few apartment blocks; then fills the rest with long field
strips (stubble, crops, ploughed, meadow) with hedges, tree lines and field tracks, and woods where a noise
pattern is high. Woodland-edge, farmland and industrial maps follow the same idea with their own recipes.
Every generated map is checked: no buildings overlap or touch a road or water, no wall, fence or hedge
crosses a road (a road always cuts a gate through them), every group of roads reaches the map edge, and the
amounts of buildings, woods and fields are in a plausible range for its kind. The tests check 48 maps; the
`npm run map -- --all --seeds 40` tool checks 160.

**Drawing the map.** The ground is painted once into one picture: colours blended between neighbouring cells
so edges look natural, tree crowns in woods, rows of trees in orchards, light and shade on slopes (light from
the north-west) and faint contour lines every 2.5 m (stronger every 10 m). Roads, water, hedges, walls and
buildings (roof colour, ridge line and a shadow) are drawn on top. Moving or zooming the camera only moves
the finished picture.

## Finding the way

When a move order arrives, the team leader's route is planned on a **navigation grid** of 2 × 2 m squares
made from the map: each square says how long it takes to cross on foot (from the ground and plants under it),
houses and deep water are closed, and walls, fences and hedges cost the time it takes to climb them. A search
(A*, a standard method that expands the cheapest-looking squares first) finds the quickest route; it then
straightens it into a few waypoints. If a gate is close it goes through the gate; if the gate is far it climbs.
Each man walks a parallel copy of the route next to the leader when the ground allows, otherwise he joins the
route and leaves it at the end for his own spot. On the way, each man's speed is his walking or running speed
divided by how hard the ground is (woods, ploughed fields, climbing). If there is no way at all, the leader
answers "no route" on the radio.

In the app, the **Debug** button shows the grid: red = closed, orange = walls/fences/hedges, yellow = slow.

## The soldier's body

Each man has a **posture** (standing, crouching, prone). Changing it takes time: going prone takes about a
second when lightly loaded, longer with a heavy load. Each pace has its posture (crawling is prone, sneaking is
crouched), so a man ordered to crawl first goes down, then moves.

His **speed** starts from the pace (walk 1.4 m/s, run 3.5 m/s ...) and is reduced by: the posture, the slope
(uphill is slower; gentle downhill is fastest, as in a standard hiking formula), the weight he carries, how tired
he is, and the ground (woods, ploughed fields, climbing walls).

His **fatigue** (0 = fresh, 1 = spent) grows when he works harder than he can sustain — running, crawling,
climbing, carrying a lot, in the heat — and recovers when he walks easy or rests. A loaded soldier running is
clearly winded after two to three minutes and fresh again after about five minutes' rest. His **heart rate**
follows his effort. The movement lab (`npm run lab -- movement`) prints a table of these numbers.

## Moving as a squad

A squad moves in a **formation** (wedge by default; file or line from the formation button), with the spacing
from its faction's doctrine (10 m). The leader's route is planned on a version of the navigation grid where open
ground is a little more expensive than ground with cover (woods, scrub, the strip along a hedge, wall or house),
so the route bends toward cover when that costs at most about 30 % more. Each man walks his place in the
formation next to the leader's route, goes round walls and houses where his line would cross them, and slows
down or hurries to keep his place. When the squad stops, every man looks for the best cover within about 15 m of
his place, goes there, lies down and faces outward. Zoomed far out, each unit is shown as one symbol.

## One order, traced step by step

You tap the map at a point 200 m east and 90 m south of the map corner, with the blue team selected.

1. **Tap → order.** The UI (`packages/ui/src/input.ts`) turns your finger position into map metres. The app
   (`packages/app/src/main.ts`) creates the order
   `{ tick: 61, issuer: "blue", target: <team>, kind: "move", waypoints: [{ x: 200, y: 90, mode: "walk" }] }`
   and submits it.
2. **Inbox.** The order waits in the simulation's inbox until its tick (`systems/orders.ts`).
3. **Received.** At tick 61 it is checked: is that your unit? is the point on the map? is "walk" a known
   movement mode? If not, it is rejected with a reason (the radio log shows it). Here it is fine, so the
   **communication model** (`comms.ts`) decides how long it takes to reach the team: 1 second plus a random
   0–1 second (radio traffic, the leader being busy). The random part comes from the battle's own seeded
   random numbers, so a replay gets exactly the same delays. Event: `order.received`.
4. **Delivered.** A second or two later (say tick 150) the team gets the order. Every man is given his destination: the tapped point
   plus his own offset from the team leader, so the team keeps its shape (a stand-in until real formations
   arrive in M1). Events: `order.delivered`, and a `radio` event from the team leader with the key
   `radio.ack.move`.
5. **Radio log.** The app looks up `radio.ack.move` for the leader's faction and shows
   "00:02 Trupp 1: roger, moving." in blue.
6. **Moving.** Every tick, `movementSystem` moves each man 1/60 of a second at walking speed (1.4 m/s, a value
   from `core/movement-modes.json`) toward his next waypoint.
7. **Drawing.** The renderer (`packages/render`) draws each man as a dot with a little heading line; it blends
   between the last two ticks so motion looks smooth on any screen. The hollow ring where you tapped turns
   filled once the order is acknowledged.
8. **Arrival.** When all men have reached their points: event `unit.arrived`, radio "Trupp 1: in position."

## How we know it works

- `npm test` runs 154 automated tests, including:
  - **determinism**: the same battle run twice gives identical fingerprints ("hashes") every 5 s; a battle
    saved halfway, loaded and continued ends identically to one that ran straight through — also when both
    sides are computer-controlled and the AIs' own memory has to be saved;
  - **golden replays**: recorded battles must still produce their recorded fingerprints — a change shows up
    immediately;
  - **fixture faction**: the made-up faction loads and fights;
  - **architecture guards**: the simulation never touches real time, real randomness or the screen;
  - **performance floor**: 304 soldiers moving on a 2 × 2 km map must run at least 8× faster than real time
    (currently ~460×, but there is no shooting yet).
- `npm run screenshot` opens the app in a headless browser at phone and desktop size and saves pictures that
  are checked by eye.
- The Stop hook refuses to let a Claude session end while the typecheck or tests fail.

## What is not there yet

No shooting, no wounds, no spotting (everyone sees everything), no real squad
organisation, no AI beyond "wander to a random point every 30 s". Those are milestones M1–M6.
