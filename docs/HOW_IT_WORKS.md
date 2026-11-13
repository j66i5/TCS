# How it works — a guided tour

Plain-language tour of the systems as they exist **now** (end of M0). Updated every session. Words in
`code font` are names you can search for in the repository.

## The battle (M6)

The app opens a generated battle: a platoon attacks a platoon that holds two objectives (red rings with their
holder's colour; the line under the top bar shows who holds what and the time left, 40 minutes). By default you
command the German platoon attacking from the west; `?side=red` gives you the Russians, `?attacker=red` makes
the Russians attack, `?map=farmland` (or woodland, industrial) another map, `?seed=` another battle. The other
side is commanded by the computer: in defence it lies in its positions and fires at will out to 300 m, pulls
back squads that have lost half their men and counterattacks a lost objective while it is strong enough; in
attack (on foot) it swings its way in away from the second objective, whose defenders it blinds with smoke, moves
up to places about 330 m out from which its squads can actually fire on the objective (a squad that went to ground
on the way gets up and goes on after 15 s), calls mortar fire and a smoke screen to land as it arrives, then half
its squads fire on the defenders man by man while the others run in under the smoke on a flank and assault by
fire and movement with grenades; then the second objective; past its doctrine's loss limit (30 %) it breaks off
and withdraws. On foot it needs most of 15 minutes to get in (see "Does an attack work?").
**Winning:** points for the objectives you hold at the end (main 100, second 50), minus 5 for each of your men
down; a side that breaks or has nobody left loses at once. **Save** keeps the battle in the browser; **Load**
brings it back exactly. At the end the **after-action review** shows the result and why, both casualty lists
(who, where wounded), a timeline (men falling, objectives changing hands, units breaking) and, on the
battlefield, a **heat map** (dots where shots came from, crosses where men fell).
`?scenario=demo` opens the old one-squad sandbox.

**Mortars and smoke (M6.5).** The attacker has two platoons. Each side can call mortar fire (the line under the
top bar shows the rounds left; the attacker has more, and more smoke): pick **Mortar** or **Smoke** and tap the
target. The selected unit's leader calls it by radio; the first round lands after a minute or more (German
120 mm: 90 s, Russian 82 mm: 75 s), then one every few seconds, scattered about the point. High explosive bursts
like a big grenade; smoke lays grey clouds for two minutes or more that nobody can see through (bullets still
go through). The AI attacker calls high explosive and a smoke screen as its first squad nears its support line,
goes in as they land and keeps both coming (high explosive every 45 s until its own men are close, smoke on the
side it attacks from and on the other objective's defenders); the AI defender shells attackers it sees out in the
open.

## How to play (M5)

Tap one of your men to select his unit. The bar at the bottom holds the orders:
- **Move**: tap the map for each point of the route; the pace button sets the pace of the next leg (walk,
  run, sneak, crawl — the route shows it in colour). At the end stands the formation marker: one ring per man,
  in the shape of the formation (change it with the formation button). Drag the marker to move it, drag the
  yellow handle at the arrow to turn it, the yellow handle at its side to make it wider or narrower. **Go**
  sends the order; **Undo** drops the last point, **Cancel** the whole plan. The men lay themselves out exactly
  so, take cover close to their places and face the way the arrow points.
- **Assault** / **Withdraw**: tap the point, Go (the drills of M4.3).
- **Fire**: tap the target — on an enemy marker to fire at that enemy. **Grenade** / **All grenades**: tap.
- **Halt**, **cease fire**, the posture button.
- **Rules**: the unit's standing rules — fire (at will / return fire / hold), open fire within (any range or
  400 / 200 / 100 m), on contact (go to ground / push on / fall back), ammunition (conserve / normal /
  maximum) — and its state (fit, wounded, down; steady, pinned...).
Pause (❚❚) any time: orders can be given while paused; they go out over the radio when time runs. Speeds 1x,
2x, 4x.

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

**Drawing the map (M7.5b: the flat pixel look).** The ground is painted pixel by pixel in flat, muted colours
(the `appearance.json` palette): each 4 m square its own colour, its edges wobbled a little so fields do not look
like a staircase, a thin darker line where one kind of ground meets another, furrows in ploughed fields and rows
in crops, a light speckle. Trees and bushes are round pixel crowns with a dark rim, a lighter top-left and a hard
shadow; orchards stand in rows. Roads, streams, ponds, hedges, walls and fences are painted in with a one-pixel
outline. There is no hill shading: the shape of the ground shows as contour lines (every 2.5 m, bold every 10 m),
and only when zoomed out. The whole map is one picture at about 1 pixel per metre; close up, squares of 64 m are
painted again at 4 pixels per metre as you look at them (one per frame, the last 48 kept). Buildings are two
layers: the floor (boards, walls with door gaps and windows) under the men, and the roof above them (see "The
screen" below). The look before M7.5b — described next — is kept behind `?look=classic` for a while.

**Classic look.** The ground is painted once into one picture: colours blended between neighbouring cells
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

## Bullets

Every bullet in flight is its own object with a position, a height and a velocity. Sixty times a second each
one is slowed by the air (more strongly as it gets slower, as real bullets are — the numbers are fitted to
published velocity tables), pulled down by gravity, and moved along. The straight stretch it covers in that
sixtieth of a second (up to 15 m) is checked against the ground, walls, fences, hedges, embankments and house
walls, so a fast bullet can never jump over a thin wall. Doors and windows let bullets through; woods and scrub
stop a bullet now and then.

At a wall three things can happen. If it strikes at a shallow angle it may **ricochet** (each material has its
own largest ricochet angle: sheet metal about 20°, concrete 12°, soil 8°). Otherwise it **penetrates** if it
still has enough punch for that material and thickness — every bullet has a published steel-penetration figure
that shrinks as it slows, and every material is worth so many millimetres of steel per millimetre (a wall hit
at a slant is thicker along the bullet's path); going through costs speed and bends its path slightly.
Otherwise it **stops**. Soft-core bullets also break up on brick, concrete, soil and wood when they hit very
fast, so they do not gain penetration at close range. Example from the cover lab: a 5.56 mm bullet passes a
hedge, a wooden fence, a car door and a 41 cm log wall, but is stopped by a single brick wall, 5 cm of concrete
or a row of sandbags; the Russian steel-core 5.45 mm bullet also gets through those three at close range, but
not at 300 m. Double brick, a 45 cm sandbag wall, reinforced concrete and stone walls stop both.

Tracer rounds are drawn as clear orange streaks, all other bullets as faint ones, and every strike leaves a
small puff. What happens when a bullet meets a man is described under "Getting hit".

## Shooting

A soldier's rifle holds one magazine; his other magazines are items in his load. A **fire order** names a point.
Each man of the unit turns to it and fires at the rate the range calls for: aimed single shots every 2–3
seconds beyond about 100 m, about a shot a second closer, short bursts inside 30 m. Every shot takes one round
out of the magazine in his weapon. When it is empty he changes it (about 3 seconds) and keeps the empty one;
when only the magazine in his weapon is left he stops and reports "low on ammunition". Now and then a weapon
jams and takes a few seconds to clear. Nobody fires with a comrade in front of his muzzle.

**Where a shot goes** is not looked up in a table. The man has an aiming error — small when he is skilled,
prone, rested and calm, larger when he is poorly trained, crouching or standing, tired, with a racing pulse, or
firing fast, and for the first seconds after he starts on a new point — and the weapon adds its own scatter.
Kneeling or standing with a wall, fence, hedge or tree within arm's reach, he rests the weapon on it and shoots
tighter. He also has to judge the range, and a wrong guess puts his
shots high or low. The bullet then simply flies; whether it hits is geometry. On the firing range a regular
soldier lying down hits a man-sized board about half the time at 300 m (a little better with the G36's optic),
a veteran about 70 %, a conscript about 40–45 %; standing, about 20–25 %.

**Ammunition management:** the unit decides how long firing makes sense. It fires at the full rate for half a
minute; if nothing comes back at it, it slows to one aimed shot per man every ten seconds, and after another
minute it ceases fire and reports "no target". Enemy rounds cracking past or landing near it put it back to the
full rate at once. In a lull (no fire order) each man swaps a magazine that is less than about two-thirds full
for a full one and keeps the partly used one.

## Getting hit

Every soldier has a simple body outline that depends on his posture: standing he is a 1.75 m tall shape
divided by height into legs, pelvis, abdomen, chest (with the arms beside it), neck and head; prone he is a
low shape 1.75 m long with the head toward where he faces. Each bullet's path is checked against the men near
it. The part it enters first is where he is struck; a round passing beside his head misses. Bullets do not
know sides, so men can hit their own comrades. A bullet that is not stopped by armour comes out the other
side, much slowed, and can still wound the man behind.

What he wears is in his load: a helmet and a vest are items that say which parts they cover, how much of each
part seen from the front and from the side, and how much they stop. The rifle plates stop every rifle bullet in
the game; the soft parts of the vest and the helmet do not (owner's decision: helmets are for fragments). A
round stopped by a plate knocks the man flat for about four seconds and bruises him.

A round that gets through makes a **wound record**: where, how severe, how fast it bleeds, whether it affects
breathing. Severe head, neck and chest wounds can kill at once. Otherwise a clock runs: blood is lost at the
wound's rate (small bleeds stop by themselves), he passes out after losing about a third of his blood and dies
at about half; an untreated chest wound that stops him breathing kills in some minutes. Nobody gives first aid
yet. Until then a wounded man carries on as well as he can: a leg wound slows him or leaves him crawling, an
arm wound or strong pain spoils his aim or stops him using his rifle.

The unconscious and the dead stay on the map (pale shape with a red cross; dark shape). A wounded man who
carries on has a white-and-red spot. If the leader falls the next man takes over, and someone reports "man
down" on the radio. The **casualty lab** (`npm run lab -- casualty`) fires at hundreds of men and prints what
happened to them.

## Grenades

A grenade is an item a man carries, like a magazine. The order "grenade at this point" is carried out by one
man: whoever is nearest and can throw that far (about 30 m standing, less crouching or lying), otherwise a man
with a grenade launcher. Getting it ready takes a few seconds and can be interrupted — a man who is hit
meanwhile does not throw and keeps the grenade. Then the grenade flies as a projectile on an arc, with an
error that grows with distance.

The thrower picks his throw: normally a lob, but a flat throw under a ceiling or through a window, or a high
one over a wall, if the lob would hit something; if nothing would get it there he does not throw and says so. After
throwing he gets down. A hand grenade has a time fuse: it bounces and rolls a little
after landing (further on hard ground), comes back off a wall, and bursts when the seconds are up. Men who have
it land near them throw themselves flat; a man within about three metres runs from it first. A launcher round bursts when it strikes, provided it
has flown far enough to arm; otherwise it is a dud.

The burst does three things. **Blast** wounds men within a couple of metres and stuns men out to about ten
metres for a few seconds; a wall in between protects. **Fragments** — hundreds to thousands — fly outward as
real projectiles, lose speed very quickly, and wound whoever they meet; helmet and vest stop many; a man lying
down is hit far less, also because small folds in the ground stop fragments that skim it. **Damage**: a small crater, and a hole in a thin wall such as a wooden fence, which
bullets and men can then pass through. Houses now have roofs, so a grenade lobbed onto a house bursts on the
roof instead of falling inside. The **fragmentation lab** (`npm run lab -- fragmentation`) bursts grenades
among rings of men and prints who was hurt at which distance.

## The squads

The game starts with two real squads of six: German Panzergrenadiers dismounted from a Puma (leader, machine
gunner with the MG5, Panzerfaust man, marksman with the G28, a man with the AG36 grenade launcher, a rifleman)
and a Russian motor-rifle squad from a BMP (leader, PKP machine gunner, RPG grenadier and his assistant, two
riflemen with GP-25 launchers). Who is in a squad, with which weapon and which load, is a data file. Every man
carries listed items — weapon, magazines or belts, grenades, helmet, vest, water, rations, first-aid kit — and
their weight slows and tires him. A machine gun fires bursts of five from a belt with a tracer every fifth
round; the marksman's telescopic sight makes him more accurate at long range.

## Seeing

Whether one point can see another is worked out along the straight line between them, in 3D. Hills and banks
block it; walls block it unless the line passes through a door, window or hole; a wire fence lets almost all
of the view through, a wooden fence half, a hedge a tenth; a roof blocks a line that crosses it. Crops, grass,
scrub and woods thin the view the more of them the line passes through below their top: a man standing in a
field of corn is in plain sight, the same man lying in it is practically invisible. The result is a number
between 0 and 1 (`npm run lab -- sight` prints typical cases). The same check keeps men from firing into a bank
right in front of them: they kneel or stand to fire over it, or hold their fire and say so. With Debug on, the
ground the selected unit's leader cannot see is darkened.

## Spotting

Every soldier looks around once a second. For each enemy within 1.2 km there is a chance he sees him now: high
for a man standing or walking near him in the open, low for one far away or lying down, almost nil for one
lying still in crops or behind a hedge — and nil behind a hill, a wall or a roof. Moving or firing gives a man
away — unless a wood stands between. Looking the other way, a soldier rarely notices anyone; a 3x sight helps
at long range, night-vision goggles at night, and nothing is seen beyond the fog. Once seen, an
enemy is easy to keep in view.

**Contacts.** Each man also remembers: where he last saw an enemy, the direction (and a rough distance) of shots
he heard, and what comrades told him. He tells the men of his unit what he sees and hears — by voice to those
nearby within a second, by radio to the others after a few seconds — and the unit calls new contacts out on
the radio log. Old contacts grow vaguer and are forgotten after two minutes. A fire order can name an enemy:
each man then fires where he believes that enemy is, and follows him as reports come in.

**Fog of war.** You see the enemy only as your men know him: a solid diamond where one of your men sees him now,
a hollow one where he was last seen or reported, with a ring for how far off that may be, a dashed ring with a
cross for shots heard. Old contacts fade over two minutes. Tap an enemy marker in fire mode to fire at him.
Debug shows the enemy as he really is.
`npm run lab -- spotting` prints how long it takes in typical cases; with Debug on, a thin line joins each man
to every enemy he can see.

## Under fire

Every enemy round that cracks past a man within about 4 m — or strikes near him — **suppresses** him a little
(heavier rounds more); a grenade or shell bursting nearby a lot. Suppression fades within seconds when the fire
stops. A suppressed man aims worse and is slower to spot; heavily suppressed he is **pinned**: he drops flat,
stops moving and fires only now and then until it lets up (a yellow ring). **Stress** builds more slowly: under
fire, when a comrade falls close by, when his leader falls, when he is wounded himself; experience and a leader
nearby steady him. A stressed man is shaken (fires less, faint ring); at the end of his tether he **panics**: he
lies flat and does not fire (a red ring) until he has calmed down. In practice a machine gun pins the men it
fires at within a couple of seconds at 200 m and within about 8 s at 600 m; a fire team within about 6 s; a
single aimed rifle seldom pins anyone. `npm run lab -- suppression` prints the table. Debug labels show
suppression / stress per man.

**Men inside a vehicle** (owner's choice, 2026-11-13: "only own vehicle") see nothing outside, so they are shaken
only by what happens to their own vehicle: a comrade falling *inside it*, its armour being penetrated (a big
blow) or struck by a cannon round, a heavy bullet or a burst that does not get through (a small one). Comrades
falling outside, a neighbouring carrier burning or a leader falling in another vehicle do not reach them; once
they are out they feel everything as before. (Before, a cook-off could panic the men in the carriers 20 m away
and break a mounted platoon within seconds.)

## Thinking for themselves

Between orders each man decides a few things for himself, once a second. **Fire rules** (per unit, set with
the `rules` order): *free* — fire at any enemy you see; *return* (the default) — only once your unit has been
fired on in the last 30 s; *hold* — never without an order. A cease-fire order holds until the unit is fired on
again. He engages an enemy he sees within the range his weapon is used at (rifle 400 m, a 4x-or-more sight
600 m, machine gun 800 m), choosing the one who matters most: close, firing (a machine gun most of all),
standing. He stops when he has lost sight of him. An order always wins over his own choice. **Under fire** and
visible to the enemy he knows of, he runs to the nearest spot within 15 m where that enemy cannot see him lying
down — preferably one he can fire from on his knees (a bank, a low wall). **Out of spare magazines or belts**,
he gets one from the nearest comrade within 30 m who has more than two (or carries belts for the gun): the
comrade runs up behind him and hands it over in 3 s. With Debug on, a line shows each man's own decision
(orange: the enemy he engages, blue: the cover he runs to, green: the man he brings ammunition to).

## Squad drills

**Contact.** A unit on the move that comes under fire after a quiet spell stops, its men go down and seek cover
and fire back under their fire rule; the radio says "contact! Taking cover." **Assault** (order, with a point):
the unit splits into two halves (its two teams, else every other man). One half runs 30 m toward the point and
goes down while the other fires at the point; then they swap, until the last 25 m, which they rush together,
spreading round the point and facing on ("on the objective"). If the runners are pinned the turn passes after
40 s; a runner who is pinned on the way stays down and the others go on without waiting for him. **Withdraw**
(order, with a rally point): the same backwards, the halt firing toward the enemy it knows;
the last 30 m together ("back at the rally point"). **Breaking.** When half a unit's able men have panicked, the
unit breaks ("falling back!"): every man runs about 150 m away from the enemy they know, does not fire and does
not take orders ("unable"). Once they are there and nothing has been fired at them for 30 s they rally
("rallied"), still uneasy (stress reduced to 60 %).

## Surrender

A man who is wounded and can no longer fight gives himself up when an enemy he knows of is within about 50 m
and no fit comrade is within about 30 m. A panicked or fleeing man gives up when an enemy he knows of is within
about 30 m, comrades or not. Attackers are tougher: a man of the attacking side, or of a squad in the middle of an assault, does not give up when he panics (he runs back instead), and a wounded attacker gives up only when an enemy is within about 25 m. From then on he is out of the fight: he takes no orders, does not fire and does
not use the radio; a white flag shows over him. The enemy stops shooting at him once they have SEEN him give
up (until then he can still be hit, and shells and grenades aimed at the area can still hit him). An enemy who
comes within a few metres takes him prisoner (a white square); when it is quiet, one enemy nearby who saw it
walks over to take him and then goes back. A surrendered or captured man costs his side the same as a man
down. Your fire tap on an enemy your men know has surrendered gives no order.

## Vehicles and riding in them (M7)
A **vehicle** (so far the German Puma and the Russian BMP-2) is a thing on the map with a fuel tank and stowed
ammunition, crewed by a small unit of its own: commander, gunner, driver. It drives by a physical model (engine
power, the two tracks, gears, ground and rain), finds its way on a map of where a hull fits, flattens fences and
hedges, drives round walls and houses, waits for its own men and runs over the enemy's. Without an able driver
it does not move; if the driver falls, the commander moves into his seat after about 20 seconds (the dead or
wounded man stays aboard). The vehicles shoot (below) and can be knocked out (armour, below).

**Riding.** Men in a vehicle stay soldiers sitting in seats: they move with it, see nothing outside, cannot fire
or be shot at, and never give up while aboard; they still count for holding an objective. A squad told to
**Mount** runs to the back of its own vehicle and climbs in one man at a time through each door, after the ramp
opens; the vehicle waits meanwhile. A wounded man lying within a few metres of the ramp is carried in by two
comrades; men lying farther off stay where they are (the medics come in a later milestone). **Dismount**: the
vehicle stops, the ramp opens and the men get out one at a time, landing a few metres behind it, crouching. Give
a squad aboard any other order (move, assault, fire ...) and it gets out first, then does it. A man who runs out
of magazines walks over to a stopped vehicle of his side nearby and takes three from its stowage.

**Guns (M7.3).** Each vehicle has a turret with a 30 mm cannon (armour-piercing and high-explosive rounds on two
ready belts) and a machine gun beside it. Every round is counted: off the ready belt as it is fired, and when a
belt runs low and the vehicle is standing still, the crew refills it from the rounds stowed in the hull (about
90 seconds; both vehicles can, by the owner's choice). The turret turns at its real speed toward the target; a
stabilised turret keeps pointing at it while the hull turns. The gun fires only when it is laid, the line from
the muzzle is clear and none of its own men on foot is in the way. Where the rounds go follows from the sight
(the Puma's laser rangefinder makes it more accurate at range), the gunner's skill and whether the vehicle is
moving. The crew picks its own targets when its fire rules allow ("return fire" also answers fire on its
platoon): an enemy vehicle first (armour-piercing), then men firing now, nearest first — high explosive at their
feet for a group or a man beyond 400 m, the machine gun for a single man close by; never high explosive close to
its own men. A cannon shell that strikes a man bursts on him. You can order a vehicle to fire at a point or an
enemy marker (with "Gun: AP / HE / machine gun", or leave the choice to the crew), to cease fire (an order to a
squad does not silence its vehicle; one to the platoon does), and to throw a **smoke screen** (its smoke
grenades are counted; when they are gone it says so). Debug with a vehicle selected shows where the turret
points, what it aims at and why.

**Seeing vehicles.** A vehicle is big: the area of its hull and turret seen from where a man stands decides how
easily it is spotted (side-on far more than head-on; only the turret of a hull behind a crest). Its crew look
out through their sights — the commander all round, the gunner where the turret points; the driver drives —
and see further than a man (to 3 km). Thermal sights see a vehicle through ordinary smoke at half strength;
eyes and day sights not at all. Engines are heard: idling about 400 m, driving about 1.2 km, less in rain, more
downwind. An enemy vehicle shows on your map as a hull outline once your men have seen it, with its type once
seen within about 1.5 km.

**Armour (M7.4a).** Each vehicle has an armour plate on every face of its hull and turret (front, sides, rear,
roof), with its thickness, its material and how far it leans back. A round that strikes a plate has to get
through the plate's thickness *along its path*: a plate leaning back, or struck at an angle, is thicker that way.
A bullet or cannon round gets through if its penetration at the speed it strikes is at least that much; at a very
glancing angle it may bounce off. A rocket (shaped charge) bursts on the plate and its jet gets through if its
penetration (which does not depend on speed) is enough; composite armour is especially good against jets; a
rocket that strikes at a very flat angle may fail to go off. What gets through goes on inside along its path:
men in their seats are wounded (by the same rules as any wound) and parts of the vehicle are damaged — engine,
tracks, gun, ammunition, fuel — and a cone of fragments of the plate and the round strikes whatever is behind the
hole (the owner's choice). A rocket's jet weakens as it goes; a cannon round that still has enough left flies out
through the far side. A hit on fuel or ammunition may start a fire, and a hit on the ammunition may blow it up at
once. High explosive bursts on the plate: it holes only a very thin plate (a mortar bomb on a BMP-2's roof), but
can break a track. Rifle bullets never get through either vehicle.
- *Puma*: its heavy front (add-on composite modules) stops 30 mm rounds and — the owner's choice — a single RPG-7
  rocket; its sides, rear and roof stop machine-gun rounds up to 14.5 mm, but not a 30 mm round or a rocket.
- *BMP-2*: its front stops 23 mm and 12.7 mm, its sides stop rifle-calibre armour-piercing rounds but not 12.7 mm;
  every cannon round and rocket goes through it.

**Knocked out.** A wrecked engine or track: the vehicle is *immobilised*; a wrecked gun: *disarmed*. The crew of
an immobilised vehicle whose gun still works stays and fights while hits bounce off; it **bails out** — with any
passengers — when the vehicle is penetrated again, when it burns, when it can neither move nor fire, or when no
crewman can act any more (owner's choice). Men who cannot move stay inside. A burning vehicle is left at once;
it burns out after about two minutes, and its ammunition may blow up before that: *destroyed*; men still inside
are burnt. A destroyed or abandoned vehicle is a **wreck**: both sides know of it at once (it is drawn for both),
men take cover beside it and nobody drives through it; it is listed in the battle's result for the campaign.
Points (owner's choice): a vehicle destroyed or abandoned costs its side 20 points, immobilised 10.

**Guided missile on the BMP-2 (owner's choice, 2026-11-13).** The BMP-2 has its anti-tank missile launcher on the
turret roof: one 9M113M Konkurs-M on the launcher and three more stowed (four in all, as published; each is a
counted item). The missile is wire-guided by the gunner (semi-automatic command to line of sight): once fired it
speeds up to about 208 m/s and flies wherever the gunner's sight points — he keeps the cross on the target and the
missile follows, so it also hits a target that moves. It needs at least 75 m and reaches 4 km (the wire's
length): about 5 s to 1 km, 10 s to 2 km, 15 s to 3 km. **It misses** when the gunner cannot keep the target in
his sight: a crest, a house or a hull in the way, thick woods, or **smoke** (his is a day sight: nothing through
smoke — the Puma's own smoke screen works if it stands before the missile arrives); when he is hit, stunned or
knocked out; when the BMP-2 is knocked out; and with an even chance each time his own vehicle is struck by a
cannon round, a heavy bullet or a burst while he guides. Then the missile flies on unguided, thrown off its line,
and falls. It fires only with the vehicle halted, and while it flies the gunner does nothing else. Its tandem
warhead gets through the Puma anywhere, the front included (750 mm of steel armour behind reactive armour, as
published for the Konkurs-M — more than the Puma's front stops in the game). Putting the next missile on takes
40 s, halted. **When the crew uses it**: at an enemy vehicle beyond 1000 m, or nearer when its 30 mm armour-
piercing round cannot get through the face the enemy shows (a Puma's front) — else the cannon. The **Anti-tank**
button with a BMP-2 selected fires the missile (or armour-piercing if none is ready). `npm run lab -- missile`
prints the hit table (a regular gunner at a halted Puma on open ground: practically every missile hits and gets
through at 1 and 2 km, nine in ten at 3 km; with the Puma's smoke screen at 3 km it is lost). This is a simple
model; guided weapons in full (other guidance types, sensors, countermeasures) come with M9.

**Panzerfaust and RPG (M7.4a).** The German anti-tank man carries a Panzerfaust 3 (the firing unit and one round
— the round is a tube he throws away after the shot), the Russian one an RPG-7 with two PG-7VL rockets (his
assistant carries three more and brings one over when he has none). A shot takes a few seconds to aim; he lays on
where he believes the target is, leads a moving vehicle by the rocket's flight time and sets the elevation from
the rocket's real flight (it speeds up when its motor fires and slows in the air); his aim and his judgement of
the range are not perfect, and wind pushes the rocket. The anti-tank lab: against a halted BMP-2 side-on, a
Panzerfaust hits nearly always at 100 m and about half the time at 300–400 m; an RPG-7 against a Puma likewise —
but never gets through its front. **When they fire on their own** is a standing rule of each unit (Rules panel,
"Anti-tank weapons"): *vehicles only* (the default for new units, owner's choice), *vehicles and positions* (also
at enemies in houses and at machine guns) or *only on order*; always within the unit's fire rule. You can order a
shot at anything with the **Anti-tank** button and a tap (the best-placed man with a loaded launcher fires once).
Nobody fires with a comrade in the danger zone behind the tube or a wall right behind him, nor from inside a house
unless it is large or has a hole blown in it (owner's choice).

**Parts of a vehicle (M7.4b).** Besides engine, tracks, gun, ammunition and fuel, a round that gets inside can
now damage the transmission (immobilised), the turret drive (below half: the turret is turned by hand, four times
slower), the stabiliser (it then shoots badly on the move), the coaxial machine gun (the cannon and the machine gun
are knocked out separately; with both gone the vehicle is disarmed), the sights (gunner and commander look through
their small vision blocks and shoot three times worse), the radio (the crew — and a squad riding inside — is off the
net: orders and reports no longer reach it), the smoke dischargers and the fire extinguisher. An engine below half
gives half power; a damaged track pulls less. The vehicle's panel lists every damaged part with its condition.

**Fire and the extinguisher.** When a vehicle catches fire, its fire-extinguishing system tries first: one charge
(counted, like every other item; the Puma carries two, the BMP-2 two) puts the fire out with a fair chance (Puma
better than BMP-2; a fire in the ammunition is twice as hard to put out). If it fails and a charge is left, it
tries again a moment later; with none left — or with the extinguisher wrecked — the crew gets out as before.

**Crews that back off.** A crew whose vehicle can still drive decides once a second whether to fight on or to
**reverse out**: when it has been penetrated, struck by a rocket (even one that did not get through, like an RPG on
a Puma's front), lost its weapons, when its commander is shaken, or when enemy infantry is close and it has not been
told to fire at will. It fires its smoke screen toward the danger and backs away about 60 m — in reverse if the
danger is in front, so its front armour and gun still face it — and stays there for half a minute. The radio says
"under anti-tank fire, reversing out!". A crew that has bailed out is a small squad on foot from then on: you can
select it and give it orders like any squad (the AI sends it back to the rear). Men who run out of ammunition may take
it from one of their own side's vehicles, abandoned ones included, if it carries what their weapon uses — never from
an enemy vehicle (owner's choice, 2026-11-13).

**Anti-tank fire by the AI (M7.4b).** Before, men fired their Panzerfaust or RPG only if they happened to see a
vehicle within range at the right moment (about one rocket a battle). Now the AI commander gives anti-tank tasks:
every few seconds it looks at the enemy vehicles its men have seen or been told of in the last ten seconds, and
orders each man with a loaded launcher who has one within range to fire at it (always within his unit's anti-tank
rule); if a comrade stands in the danger zone behind him, he first steps a few metres aside. Up to two men are sent
after a halted vehicle a little out of range, to a point well inside their range. Attacking squads get out at once
when their vehicle's crew sees enemy infantry within 400 m or an enemy vehicle within 600 m, and in a withdrawal the
vehicles first back away before turning for home.

**In a battle** (the default since M7.4a; `&vehicles=0` gives the battle on foot): the attacking platoons
start aboard on their side of the map, **in dead ground** (owner's choice, 2026-11-13): the scenario looks, every
20 m over the attacker's side (at least 600 m from the objectives), for spots that none of the defenders can see —
not from its vehicles' sights, not from its men's places — behind a crest, a wood or houses, and puts the hulls
there, close together and as near the middle of the attacker's edge as it can; where too few such spots exist it
takes the least seen ones (on flat open ground that is the old line at the edge). The Germans in four Pumas (the fourth carries the platoon leader and his radio
operator), the Russians in three BMP-2s (the platoon commander in the back of the first). The AI drives them up
to a point out of sight of the objectives, 300 m short of them for the Germans and 400 m for the Russians (from
their published doctrine), and the squads get out and go on as before; they get out at once if a vehicle is hit.
If the attack fails, squads within 100 m of their vehicle get back in and ride back. The defender's vehicles
stand behind its position with only their crews and fire at will. Once the squads are out, the German Pumas stay
where they dropped them and support by fire from there; the Russian BMP-2s follow their squads about 150 m behind
(both from the research on each army's doctrine). During the assault each vehicle fires at an enemy its side
knows near the objective, never close to its own men.

## The screen: order bar, unit list, labels (M7.5a)
The battle opens with **nothing selected**. The **order bar** is always there; until you pick a unit its buttons
are greyed out. Pick a unit by tapping one of your men or vehicles on the map, or its tile in the **unit list**.
The bar then offers only what that unit can do right now: a squad gets Anti-tank only while someone still has a
Panzerfaust (or RPG) with a round for it, the grenade buttons only while it has grenades, Mortar and Smoke only
while your mortars have rounds left; a vehicle gets move, fire (the gun choice cycles through the rounds its
guns really have), the smoke screen while its dischargers are loaded, and Dismount while men ride in it; a unit
with just one man left can move, fire, throw, change posture, halt and cease fire.

**Moving the bar.** Hold the grip (⠿) at its start and drag: a highlighted strip shows which edge it will go to;
let go and it docks there — a full-width strip at the top or bottom, or a full-height column at the left or
right. Your phone remembers the choice. Until you move it, it sits at the bottom with the phone upright and at
the right with the phone on its side. On a narrow screen the bar is one row; buttons that do not fit (the rarer
ones first: smoke, mortar, all grenades, withdraw, rules ...) wait behind **⋯**.

**The unit list** is a slim strip of tiles down the side (the right side when the bar is docked left): each tile
shows the unit's symbol, callsign and how many of its men are fit (5/6), and a coloured edge for its state —
green ready, light blue moving, orange firing, grey riding, yellow pinned (or a damaged vehicle), red broken,
dimmed out of action. The ☰ at its head opens the full list with the details; on a wide screen it is always open.

**Labels never pile up.** Callsigns are placed beside their unit so that no two overlap, none covers another
labelled unit, a bar or the screen edge; the selected unit's label always wins, and the ones that fit nowhere are
left out until there is room (zoom in). A squad that got out next to its vehicle shares its label ("Puma 1 ·
Trupp 1").

**The top bar** (M7.5b) is one row: time, pause and speeds; on a narrow screen Save, Load, the map and Debug wait
behind **⋯**. Under it one short line: each objective with a small square in the colour of the side holding it
(grey: nobody; "(!)" while contested), the time left and your mortar rounds (HE/smoke). Zoomed far out every vehicle becomes a small symbol (vehicles close together are stacked: "Puma 1 ×4
+18" = four vehicles, 18 men riding); a platoon's infantry symbol appears only for the men on foot.

**Looks are data too.** Each side's uniform tones and vehicle paint, and the colours of the flat map to come, are in
`appearance.json` files. They are kept apart from everything the battle is computed from, so changing a colour can
never change the outcome of a battle or a saved game.

## Zoom levels, pixel soldiers and roofs (M7.5b)
The battle opens zoomed in on your first squad (or the vehicle it rides in). How things are drawn depends on the
zoom:
- **Close** (16 pixels per metre or more): every roof is lifted off, so you look into the buildings; soldiers at
  their true size.
- **Figures** (8–16 px/m): each soldier is a small top-down pixel figure, always at his true size next to houses and
  vehicles (owner's choice, 2026-11-13): 8 to 16 pixels. Smaller than that a figure cannot be read, so the dots
  take over.
- **Dots** (1.2–8 px/m): men are small dots in their side's colour, vehicles at their real size; contour lines show.
- **Symbols** (below 1.2 px/m): one symbol per unit and per vehicle. You cannot zoom out further than the whole map.
A level changes a little later on the way back (10 %), so a pinch at a boundary does not flicker.

**The figures** are our own pixel art: a man standing, walking (a boot shows behind him, left and right in turn),
crouching, lying, crawling; down (on his back, rifle beside him), dead (face down, greyed, blood), surrendered
(hands up, a white cloth), taken prisoner (kneeling, hands on the helmet). His weapon shows: a rifle, a longer
machine gun with its belt box, a marksman rifle with a scope, a tube on his back when he carries a Panzerfaust or
RPG; a flash at the muzzle when he fires; blood and a white dressing when he is wounded but fighting on. He turns
in 16 steps. Each side wears its own uniform tones (from the appearance data), and a thin blue or red outline
says whose he is; your selected unit's men have a thin white ring.

**Roofs.** A roof is drawn over each building until one of your own men (on foot, able) is inside it or within
8 m of its walls, or until you zoom in close: then it fades away and shows the floor, the walls, the doors and the
windows. Enemy men never lift a roof.

## Inside the houses (M7.5c)
Every building now has an inside, on every floor: **rooms**, **inner walls** with open **doorways**, **stairs**
between floors and **windows upstairs** (each ground-floor window again on every floor, and a window above every
door). The map generator makes them after it has placed every building, with its own random numbers, so the rest
of the map is exactly what it was. Houses and farmhouses get two to five rooms (the room with the front door is
the hall), offices and blocks of flats a corridor with rooms on either side, barns, sheds, warehouses and churches
one big room. Every room can be reached from a door (checked for every generated map).

What it changes in the battle:
- **Seeing and shooting:** an inner wall blocks sight and stops or slows a bullet like any wall (brick, 12 cm);
  you see and shoot through a doorway. The floor between two storeys blocks sight and stops or is pierced like the
  roof (same material). Upstairs windows let you see into and out of the upper floors.
- **Blast:** an inner wall or a floor shields a man from a burst on its other side; a charge can blow a hole in an
  inner wall, and men can then walk through it.
- **Walking in:** tap a move inside a house and the squad goes in: each man by his own way through the nearest door
  and the doorways, to his own place in that room (a window first; more rooms of the house if the room is full),
  where he crouches facing out. Order them somewhere outside and they come out by the doors and form up again. Men
  walk through doors only (not windows); holes blown in a wall count as doors. Indoors a man under fire stays in
  the house (its walls are his cover) instead of running outside to find cover.
- **Anti-tank rockets** are not fired from a small room (the room he stands in counts, not the whole house).
- **On screen:** when the roof fades you see the rooms, the inner walls with their doorways (a light threshold),
  the hall a shade lighter and the stairs with their steps and an arrow up. In Debug the paths inside each house
  are drawn: doorway points (cyan), doors to the outside (orange) and the lines a man may walk.

## Upstairs (M7.5d)
Men can now go up and down the **stairs**. A man's height above the ground is part of his position: 0 outdoors and
on the ground floor, 2.8 m (one storey) on the first floor, and in between on the stairs, which he climbs at about
half his pace. Everything that depends on how high a man stands uses that height: what he sees from a window, where
his rifle, rocket or grenade starts, where others aim at him, which blast reaches him (the floor between two storeys
shields a man upstairs from a grenade bursting below him), whom he can take prisoner.
- **Moving upstairs:** the floor switch (buttons G, 1, 2 … at the right of the map) shows the floor you are looking
  at; a move tapped inside a house goes to that floor. The squad spreads over the rooms (about one man per 4–5 m²,
  windows first, then the other rooms, then the other floors) instead of crowding into one corner.
- **Occupy:** select a squad, press **Occupy** and tap a house: every man takes a window, those facing the nearest
  enemy your men know first, on all floors (upper floors see further), kneeling or standing so his rifle clears
  the sill; the men left over take places inside. From there they fire out of the windows.
- **On screen:** close in, men are drawn at their true size so the rooms read right. The floor switch appears when
  your selected unit is inside or a house of more than one storey is opened up close in, and it follows the
  selected unit's floor until you pick one yourself. The plan of the floor shown is drawn over the ground floor;
  men on another floor are drawn faint with a small badge giving their floor.
- `npm run lab -- sight` has rows for an observer at a first-floor window: he sees over a 2 m hedge, but a man
  lying right behind a wall stays hidden.

The AI does not yet use buildings on purpose (M7.5e, for the owner to decide).

## Does an attack work?

`npm run lab -- attack` runs a squad attacking across 300 m of open ground. Against a squad lying behind a low
stone wall it fails every time (the attackers break or lose half their men after two or three are hit). Against
the same squad lying in the open it fails faster still (prone men at 300 m are hard to hit, men running upright
are not). With a second squad firing on the position from the start line the whole time, about 4 attacks in 10
succeed, usually because the defenders break. Bound lengths come from the faction's doctrine (`boundM`,
`finalAssaultM`), the same for both sides for now.

In the platoon battle (two platoons attacking one dug-in platoon, balance pass 2026-11-13,
`docs/research/inf-assault.md`) the attack on foot gets home in about 1 battle in 10 when the battle lasts 15
minutes (it reaches the objective about as time runs out) and in 4 (German attack on the village) to 6 (Russian
attack on farmland) in 10 over the app's 40 minutes. Before that pass it nearly never did: its fire line lay where
the first shot came from, out of rifle reach; the defenders of the second objective shot three quarters of the
attackers from the flank; and the two attacking platoons fired through each other. Nobody fires through a man of
his own side now, whichever platoon he belongs to.

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

- `npm test` runs 321 automated tests (317 plus 4 timing tests run on their own), including:
  - **determinism**: the same battle run twice gives identical fingerprints ("hashes") every 5 s; a battle
    saved halfway, loaded and continued ends identically to one that ran straight through — also when both
    sides are computer-controlled and the AIs' own memory has to be saved;
  - **golden replays**: recorded battles must still produce their recorded fingerprints — a change shows up
    immediately;
  - **fixture faction**: the made-up faction loads and fights;
  - **architecture guards**: the simulation never touches real time, real randomness or the screen;
  - **performance floor**: 304 soldiers moving on a 2 × 2 km map must run at least 8× faster than real time
    (about 18× here with 304 men moving; with 20,000 bullets in the air about 5.5×, floor 3×).
- `npm run screenshot` opens the app in a headless browser at phone and desktop size and saves pictures that
  are checked by eye.
- The Stop hook refuses to let a Claude session end while the typecheck or tests fail.

## What is not there yet

No first aid,
men and squads fight on their own (fire back, take cover, share ammunition, react to contact, bound, break and rally) but doctrine does not differ between the sides yet, and no AI beyond "wander to a random point every 30 s" — the enemy never
shoots by itself. Those are milestones M4–M7.
