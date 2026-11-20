# How it works — a guided tour

Plain-language tour of the systems as they exist **now** (end of M0). Updated every session. Words in
`code font` are names you can search for in the repository.

## The battle (M6)

The app opens a generated battle: a platoon attacks a platoon that holds two objectives (red rings with their
holder's colour; the line under the top bar shows who holds what and the time left, 40 minutes). By default you
command the German platoon attacking from the west; `?side=red` gives you the Russians, `?attacker=red` makes
the Russians attack, `?map=farmland` (or woodland, industrial) another map, `?seed=` another battle. The other
side is commanded by the computer: in defence each man first walks to a fire position of his own within 40 m of
his squad's place (the spot that sees most of the ground the attack must cross, in cover, at least 3 m and if it can
5 m from the next man, the squads at an objective inside its ring), lies down facing what he sees and fires at will
out to 300 m, pulls
back a squad that has lost half its men once the enemy is close (a known enemy within 150 m, its objective
assaulted, or enemies on two sides; until then it holds) to a rally point of its own 80-150 m behind it, away from
the enemy it knows, in cover and seeing its objective, where each man takes a fire position facing the enemy's way
(a remnant of three or fewer goes back in one rush, all together, instead of by bounds; yours too), and
counterattacks a lost objective while it is strong enough (a squad holding its rally point counts toward that); in
attack (on foot) it swings its way in away from the second objective, whose defenders it blinds with smoke, moves
up to places about 330 m out from which its squads can actually fire on the objective (a squad that went to ground
on the way gets up and goes on after 15 s), calls mortar fire and a smoke screen to land as it arrives (called when two thirds of its squads are within the
mortars' delay of their places at a walk), then half
its squads fire on the defenders man by man while the others walk in under the smoke on a flank (running only
when fired on), get their breath back for up to a minute about 60 m out, and assault by
fire and movement with grenades; then the second objective; past its doctrine's loss limit (30 %) it breaks off
and withdraws. On foot it needs most of 15 minutes to get in (see "Does an attack work?").
**Winning:** points for the objectives you hold at the end (main 100, second 50), minus 5 for each of your men
down; a side that breaks or has nobody left loses at once. **Save** keeps the battle in the browser; **Load**
brings it back exactly. At the end the **after-action review** shows the result and why, both casualty lists
(who, where wounded), a timeline (men falling, objectives changing hands, units breaking) and, on the
battlefield, a **heat map** (dots where shots came from, crosses where men fell). The review has three tabs: the
battle, **Medical** and **Conduct**; the last two say "not recorded here yet" until the end of the medical work
(M10.8) fills them. Everything in the review comes from one **battle record**, folded from the battle's events as
they happen (`packages/sim/src/record.ts`); the batch report reads the same record, so the two cannot disagree.
`?scenario=demo` opens the old one-squad sandbox.

**Mortars and smoke (M6.5; ranging since the "fire-support" step).** The attacker has two platoons. Each side can
call mortar fire (the line under the top bar shows the rounds left; the attacker has more, and more smoke): pick
**Fire support** (under Fire), hold or tap the target and choose **HE** or **Smoke** in the little box that opens
there. The selected unit's leader calls it by radio. About a minute later (German 120 mm: 75 s, Russian 82 mm:
60 s) a single **ranging round** lands — not on the point, but off it by the mortars' aiming error (tens of metres).
If the caller or any man of his platoon can see where it fell (a hill, a house, thick woods or smoke in the way
and nobody can), the next rounds come much closer (the error drops to a third); 20 s later a second ranging round,
then the whole battery fires together (**fire for effect**: German 4 tubes, Russian 6 tubes; one volley lands
within about three seconds, the next a few seconds later), scattered about the corrected point. Ranging rounds no
one saw do not bring the aim closer, so fire called blind may land well off. The radio says each step ("ranging
round 70 m off, adjusting", "ranging round not observed", "fire for effect!"). The ranging rounds come from the
same stock, on top of the rounds asked for (if the stock runs short, ranging rounds are given up first). A point
the mortars have already ranged on is remembered: a new mission within 100 m of it fires for effect at once.
High explosive bursts
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
- **Fire**: tap the target — on an enemy marker to fire at that enemy (hold to see the sight lines first, see
  "Ordering by dragging"). **Grenade** / **All grenades**: tap.
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
when only the magazine in his weapon is left he reports "low on ammunition" and keeps that magazine for close
defence: he fires it, aimed, only at an enemy within 100 m or at one rushing at him within 200 m (see "The single
soldier" below). Now and then a weapon
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
at about half; an untreated chest wound that stops him breathing kills in some minutes (what his comrades do
about it is the chapter "Care of the wounded"). A wounded man carries on as well as he can: a leg wound slows
him or leaves him crawling, an arm wound or strong pain spoils his aim or stops him using his rifle.

The unconscious and the dead stay on the map (pale shape with a red cross; dark shape). A wounded man who
carries on has a white-and-red spot. If the leader falls the next man takes over, and someone reports "man
down" on the radio. The **casualty lab** (`npm run lab -- casualty`) fires at hundreds of men and prints what
happened to them.

## Care of the wounded (M10)

A wound starts a clock, and the medical system is everything the men do against it, the same rules for both sides
and only the data different (who carries what, who is trained for what, which vehicles come). In order: the clock
itself; first aid by the man himself and his comrades; who leaves the fight to help; triage and care under fire;
carrying; the Verwundetennest and the platoon medic; ambulances and combat vehicles that take the wounded back; what
happens to them after the battle; who is spared under the laws of war and what counts as a breach; and at the end
what the after-action review and the batch tool make of it all. `--no-medical` (batch and headless) switches care off
for comparison: men still bleed, nobody helps.

**The medical clock (M10.1).** Since the medical step every battle runs the "medical" body model. It keeps the
clock above and adds what makes casualties a problem with a clock: some chest wounds develop a **tension
pneumothorax** 5-30 minutes later, which kills about ten minutes after it starts unless a medic puts a needle in
(from M10.2); some men with a head wound walk and talk for a while and then pass out; about three in ten limb
wounds break a bone, so the man cannot walk on that leg or use his rifle with that arm; burns lose fluid slowly;
a man in shock gets cold — faster in rain and wind, far slower aboard a vehicle or wrapped in a rescue blanket —
and a cold man bleeds more and dies of less; a tourniquet's time on the limb is counted (no limb is lost within two
hours, more and more after). Untreated, the medical model kills the same share of men as the clock the owner
accepted on 2026-11-11 (the casualty lab compares both on the same wounds and adds "dead by 120 min"). Every man
carries his first-aid kit as counted items (a tourniquet, two field dressings, haemostatic gauze or powder, a
rescue blanket or a pain syringe); in each German Gruppe one man is an Einsatzersthelfer B with a first
responder bag, the Zug headquarters has a Sanitäter with a medic bag and a red cross armband, and the first
Russian squad has the platoon's rifleman-medic. The Russian rubber tourniquet and haemostatic powder are slower
and less reliable than the German ones (item data). All numbers are in `core/medical.json` with their sources;
nothing there is better than "medium".

**First aid: self-aid and buddy aid (M10.2).** Once a second every wounded man is looked at. If he is awake and can
use his arms he treats himself; if he cannot (unconscious, both arms useless) or cannot do what he needs (a
rescue blanket, a splint), the nearest comrade of his side within 3 m who is free — not firing, not on the move,
not busy, not panicked — does it. What comes next follows the MARCH order of tactical combat casualty care:
massive bleeding (a tourniquet on a limb, packing on the neck, a dressing elsewhere; only bleeds too large to stop
by themselves count), the airway, the chest (a seal; a needle for a tension pneumothorax, which only first
responders and medics may do), circulation (a line and fluids, also first responders and medics), keeping him
warm, then pain relief and a splint. The first thing he needs that the helper is trained for and has the items
for is done. Under fire (his own suppression, or his unit fired on in the last 5 s) only a tourniquet. A man who
stops his own massive bleeding stays where he is until the tourniquet is on; anything else waits until he halts.
A treatment takes the data's time for that training (a German soldier puts on his own CAT in 35 s, a comrade in
30 s, a first responder in 25 s; under fire 1.3 × as long), uses up the items — the casualty's own kit first, then
the helper's — and works with the data's chance (a comrade's tourniquet 75 %, his own 64 %, a first responder's
85 %, less under stress; the Russian rubber tourniquet 1.4 × as slow and 0.8 × as reliable). A failed attempt costs
the time and the item; each intervention is tried at most three times on a wound. It is broken off when the
helper is ordered to move, comes under fire (anything but a tourniquet), is hit, or the casualty dies. Every
attempt is written on the wound (who, what, which items, whether it worked) and sent as a `medical.treated` event.
In the debug view each man's line shows what he is treating and what care has worked on him. `npm run lab --
treatment` checks the odds and times against the data (300 trials each) and shows that self-applied tourniquets
cut the deaths from a limb bleed at 10 minutes from 23 % to about 1 %.

**Who helps: carers and first responders (M10.3a).** A casualty who needs care that nobody beside him gives gets a
carer, who leaves the fight and runs over to him. If he looks urgent — a bleed too large to stop by itself, a
blocked airway, a chest wound, shock — the first responder comes (his own squad's first, else the nearest one of
his side within 150 m: the German Einsatzersthelfer B of each Gruppe and the Sanitäter of the Zug HQ, the Russian
platoon's rifleman-medic), and with him the nearest willing comrade within 40 m; any other casualty gets a willing
comrade, or a free first responder if no comrade will go. Never more than the first responder plus one comrade
per casualty (the owner's rule for men leaving the fight in contact). Squad and platoon leaders stay with their
men. Whether a comrade is willing depends on his side's doctrine (`casualtyCarePriority`, the same 0.5 for every
side for now), how he is (steady or cautious: yes; shaken: half as ready; pinned: hardly; panicked: never), his
morale, how hard he is being shot at, whether the casualty is from his own squad (a man from another squad is
less ready) and whether the casualty lies under fire; a first responder is twice as ready (it is his job). A carer
does not fire, his unit's orders and drills pass him by (an order to him alone ends the errand), and he treats
with the same treat action as buddy aid once he is beside the casualty. A comrade goes back when the first
responder arrives; any carer goes back to where he stood when there is nothing more he can do, after 5 minutes, or
when the casualty dies. A downed man with a carer on the way or beside him does not give up. All the numbers are
game values in `core/medical.json` `carers` (low confidence). Debug view: "carer -> id" or "responder -> id".

**Triage, care under fire, "Medic!" (M10.3b).** When an urgent casualty needs care, his squad calls "Medic! Man
down!" on the radio (he himself if he can speak, else a comrade; once for him). The man who starts treating a
comrade tags him: **T1 immediate** (red: massive bleeding, airway or breathing trouble, deep shock, or barely
conscious), **T2 delayed** (yellow: cannot walk, or needs other care such as a splint) or **T3 minimal** (green:
walking wounded) — the NATO categories and the Bundeswehr's Sichtungskategorien I-III; the "expectant" category is
for mass casualties and is not used by a platoon. A tag can be wrong, one category off: a comrade errs one time in
four, a first responder about one in seven, a medic one in ten, each one in ten more often under fire (game values).
The first time a comrade tags him, his squad says "man down, treating" on the radio (each call at most once every
15 s per squad). A first responder or medic who comes to him tags him again (he looks better), and so does anyone
treating him once the tag is five minutes old. The tag shows on the map beside the man (a small coloured square, own
men only: enemy casualties show only what your men see) and on the card: in his row and in his box, with who tagged
him. **Under fire** a carer beside a casualty first puts a tourniquet on if one is needed (the only treatment allowed
under fire); then, if the casualty lies where the enemy can see him, he gets him into cover: the nearest spot within
15 m hidden from the enemy (by a way of at most 30 m), not toward the enemy. A casualty who can still walk goes there
himself (pinning does not hold him: he is told to go); one who cannot is **dragged** there by the carer, crouched, at
0.7 m/s (the drag in `core/medical.json` `carry`, from a published drag test; a carrying party since M10.4a, below),
the casualty at his heels, and a
comrade of the squad throws a smoke grenade to screen it if he has one. Lying in that cover, care goes on: from then
on only the carer's own suppression counts as "under fire" (his squad being shot at elsewhere no longer stops him),
so the dressing, the chest seal or the line can be done. The debug view adds "drag -> id (move)", the tag ("T1"), "(in
cover)", and why nobody comes to a casualty: "waits: nobody" (no one in reach), "waits: too exposed" (men in reach,
none willing to go under fire), "waits: unwilling", "waits: no kit". The batch report's "Triage, care under fire"
line counts life-threatening needs, deaths of wounds after one (preventable deaths), wrong tags by training and
drags.

**Men down, identity tags, crawling into cover, prisoners' care (owner requests 2026-11-15).** A man who goes down
is, to his comrades, **"down, state unknown"**: from where they lie they cannot tell a wounded man from a dead one.
So they come to him as to any urgent casualty (his first responder and a comrade, or the man beside him), and under
fire they first drag him into cover — even if he is in fact dead. Only a comrade beside him can **check** him (about
5 s: does he respond, does he breathe; `core/medical.json` `down`, game values): a living man is checked by the first
treatment a comrade gives him, a dead one by this check, and only then do his comrades know he is dead. Found dead,
his **identity tag** is taken: every soldier carries his side's tag as a counted item (the German Erkennungsmarke is
two halves, counted as two: one half is broken off and taken, the other stays with the body; the Russian personal tag
is one plate, taken whole; `factions/<id>/doctrine.json` `identityTag`, research from search extracts only). The man
who checked him takes it (8 s) when it is quiet enough — not suppressed, no rounds cracking past him for 20 s; if it
is too hot he goes back to his place, and later, when it is quiet, a willing comrade goes to fetch it. The body stays
where it lies. A carrying party that feels the man it carries die knows he is dead. **A wounded man who cannot walk
but can use his arms crawls into cover himself** while he is under fire: to the nearest spot within 10 m hidden from
the enemy (a way of at most 15 m), at the crawl pace (0.3 m/s) slowed by his wounds — unless a carer of his is
within 15 m, then he waits for him. **Prisoners are cared for like one's own** (Geneva Convention I art. 12: the
order of treatment by medical urgency alone): a surrendered or captured wounded man is treated by the men of the side
holding him — buddy aid, carers, first responders and medics — and carers are sent to the most urgent casualties
first, whichever side they belong to (then nearest first). The man box says "checking a comrade who is down",
"taking a fallen comrade's identity tag", "crawling into cover, wounded". The review's Medical tab gives per side
the men checked, how many were found dead, dead men dragged into cover before anyone knew, tags recovered, wounded who
crawled into cover, treatments of men held prisoner and surrendered men who crawled out of the fire; the batch
report has a "Men down" line with the same counts.

**Carrying (M10.4a).** Moving a casualty is a **carrying party**: one or more men and the man they carry, moving
together as one. Each way of carrying is a line in `core/medical.json` `carry`: **walking wounded** (he walks
himself, 0.9 m/s), **supported** (an arm over a comrade's shoulder, 0.6 m/s), the **drag** (one man, crouched,
0.7 m/s, from a published drag test), the **two-man drag** (1.0 m/s), the **fireman's carry** (one man, upright,
1.0 m/s), the **two-man carry** (1.0 m/s) and the **four-man litter** (1.0 m/s, 45 s to unfold it and get him on;
only with a litter: the German Sanitaeter carries a folding one). The party takes the fastest way the men at hand
can do — under fire only the low ones (the drags), and a man who can still walk walks — then the one that lasts
longest. The first carrier leads and walks the way (through doors and up stairs like anyone), and the others and
the casualty follow on his trail, so the casualty is never more than a step and a half from a carrier. The speed is
the data's speed for a casualty of about 105 kg (a soldier in kit), a little faster for a lighter load and slower
for a heavier one, and ground, slopes, stairs, tiredness and wounds slow a party as they slow any man. After a
stretch (40 m for a drag, 80 m for a fireman's carry, 300 m for a litter) the party rests (30-60 s). **Carriers
leave the fight:** they do not fire except in self-defence at an enemy within 30 m while the party is still, and
their squad's orders and drills pass them by (an order to one of them alone takes him out of the party; the others
carry on with a way for fewer men, or put the casualty down). **Fired on** (a carrier pinned or suppressed), the
party takes the casualty into the nearest cover within 15 m hidden from the enemy, lies down there, and goes on
after 10 s without fire. A party ends when it gets there, or when the casualty dies, is loaded or taken prisoner.
For now carrying is used by the drag to cover under fire (with two carers beside him it is the two-man drag, and on
the ground floor a casualty can be dragged into a house), by men taking a casualty to their vehicle (below) and by
bearers taking casualties back to the Verwundetennest (below). The debug view shows "drag -> id (move)" or
"two-man -> id (hold)" for a carrier and "carried" for the casualty; the man box says "carrying a wounded comrade".
On the map a casualty being carried is drawn limp on his back with a dressing, or lying on the litter between its
four bearers. The **carry lab** (`npm run lab -- carry`) measures every way on flat ground, a slope, through a house
and up stairs against the data; the batch report counts carrying parties by way, metres carried and how often they
took cover.

**Into and out of vehicles (M10.4b).** When a squad is ordered into its vehicle (by the player or the AI, for
example a squad pulling back to its carrier), its wounded who cannot walk come too: those within 150 m of the
vehicle (`core/medical.json` `vehicleLoading.fetchM`) are carried to the nearest door or ramp by a carrying party of
up to four of the men still outside, nearest first, one casualty after another; at the ramp two men lift each in
(the vehicle's `loadCasualtySeconds`, 15 s for a Puma or a BMP-2, 30-40 s for the ambulances). The squad waits for
them (up to five minutes) and only then reports "mounted". Aboard, a casualty **lies** if he is unconscious or in
shock, otherwise he **sits**. **Places:** in a carrier every passenger seat takes one man; a man lying takes
`lyingSeats` of them (1 in the data: he is laid across the floor in the room of his own seat, so a full squad still
takes its wounded). An ambulance uses its own layouts instead: the Boxer takes 3 lying, or 7 sitting, or 2 lying and
3 sitting; the BMM 4 lying inside and 2 on the hull, or 7 sitting and 2 on the hull (the two outside places only
while there are seats for them: 7 men in all). Casualties there is no place for are left where they lie. A
**dismount with the wounded** (the order's `wounded` flag; no player button for it yet: the Wounded tab of M10.5 has
none, D3) first lets every able man out, then two of them carry each casualty out of the nearest door and lay him down
close behind it. An ordinary dismount leaves the wounded aboard. The man box says "lifting a wounded comrade into
the vehicle" or "carrying a wounded comrade out of the vehicle"; the batch report counts casualties into and out of
vehicles per side. The **bench-medical** benchmark (a third of 270 men down from the start, carried to 30 vehicles)
must run at 8× real time or more.

**The Verwundetennest and the platoon medic (M10.5).** Each platoon gathers its wounded at a **Verwundetennest**
(the Bundeswehr's company point is the Verwundetensammelpunkt; the Russians' a casualty collection point), a rear
point of kind "medical" (supply points in M11 will be the same kind of thing). It is set up the first time one of
the platoon's men needs taking back: 150 m behind the centre of the platoon's men (`core/medical.json` `nest`),
away from the enemy they know (with nobody known, toward the nearest map edge), at the spot within 45 m that is
hidden from that enemy for a man lying down, outside buildings, on ground a wheeled vehicle can reach from that
edge (the ambulance drives there, below). The platoon leader says so on the radio. Every 10 s it is looked
at: a known enemy within 100 m moves it, and an empty one left more than 300 m behind follows the platoon — unless
the player put it there. **Who goes back:** a living wounded man who is out of the fight (unconscious, cannot walk
or cannot fight), once nobody is treating him and his urgent needs are seen to (or nobody can see to them), T1
first. He walks there himself if he can. Otherwise the platoon leader (or, with him down, the man's squad leader)
tasks **bearers**: two riflemen of the platoon who are free (not leaders, not medical men, not firing at the enemy,
not on the move with their squad, not in an assault or clearing, not in a house under fire), his own squad's first, never leaving a squad with fewer than two fit men; one
alone (a fireman's carry) when no second man is free; at most three parties at once. They are a carrying party
(above): under fire they take cover with him and go on when it eases; a trip cut short is tried again after 30 s.
On arrival he lies at the nest (his squad's orders no longer reach him) and the bearers walk back to their squad
leader. **The platoon medic** — the platoon's best-trained medical man (the German Sanitäter; the Russian rifleman-
medic) — goes to the nest when it is within 400 m and he is free, and sees to the men there one by one: he tags each
again (his training beats a comrade's tag, so most wrong tags are put right) and gives the care only he can
(decompression, drips). Men at the nest get no other carers. A man who is fit to fight again there (his pain eased)
goes back to his squad: **returned to duty**. The AI commander counts bearers, carers and men at the nest as
committed (not in a squad's strength) and never gives them orders of their own. **The player:** the nest is a red
cross on a white square on the map, with the number of men lying there; drag it to move it (`casualtyPoint`; it
then stays). The sidebar's **Wounded** tab (on the phone: the red-cross button with the count on the slim strip)
lists the player's own wounded, T1 first, with their tag and what is happening to them (wounded but still at his
post, being treated, waiting to be carried back, being carried, walking back, at the Verwundetennest, aboard), a
line saying what T1-T3 and "–" (not yet tagged) mean, his unit by its full callsign ("2/Trupp 1" where two platoons
have a Trupp 1), and the men already evacuated last under their own heading; a tap on a row selects him (on a phone
the list closes so the man box is not drawn over it), and **Back** sends him to the nest now (`evacuate`: first in
the queue, and even a man who could still fight goes). A squad's strength on its tile ("4/6") leaves out men at the
nest and men being taken there. On the phone the open list's top button reads "✕ Close". The batch report's "Verwundetennest" line counts nests set up and moved, men sent back with bearers or
walking, arrivals and returns to duty, the share of those to be taken back who reached the nest by the end, and the
wrong tags put right.

**Ambulances from the rear (M10.6a).** Each side's ambulances wait **off the map** (the Germans two Boxer
ambulances, the Russians two BMM, from each faction's data): they are in the battle from the start with their crews,
but stand far outside the map where nothing sees, hits or counts them, and their crews take no orders and are not
part of the side's strength. When men lie at a platoon's Verwundetennest and no ambulance is already coming to it,
the platoon calls one on the radio ("ambulance requested, about 13 min"); the player can call one any time with
**Call ambulance** in the Wounded tab (for the selected platoon; with nothing selected, for the platoon with men
lying at its nest; the button names the platoon; refused with a radio reason when one is already
coming or none is left). If, when it is due, nobody is waiting at the nest any more and nobody is on the way there
(the men went back to their squads, or died), the call is stood down and the ambulance waits for the next. After the
delay — drawn between 10 and 15 minutes (the owner's answer; `core/medical.json`
`evacuation`) — it comes onto the map at the edge behind the nest (away from the enemy the platoon knows), on ground
its wheels reach, drives there (slowly over the last 30 m) and stops about 15 m short of the men, or at the nearest
ground it can reach. Its crew takes the men aboard one by one, T1 first, lying or sitting as its layouts allow (the
Boxer 3 lying, or 7 sitting, or 2 lying and 3 sitting); each takes the hull's loading time, 20 s more, and the walk
to him and back with a litter. It leaves when full, or when nobody has come aboard for two minutes and nobody else is
on the way to the nest (at most ten minutes after it arrived): it backs away from the men, turns and drives back to
where it came on, and leaves the map (held up on the way back for ten minutes, it is taken to have found another way
off). The living wounded aboard are **evacuated**: they are out of the battle, their
condition stays as it was from then on, and the after-action roster says "evacuated". Each hull makes one run. A hull that loses its driver or its wheels on the map is stranded there and
is an ordinary vehicle from then on. The Wounded tab shows each run (on its way with the minutes left, driving to the
nest, there with so many aboard, gone back with so many); the batch report's "Ambulances" line counts calls,
arrivals, men taken aboard and evacuated, the time from a call to the arrival and from the first wound to leaving the
map. `npm run lab -- medevac` checks that an ambulance arrives after the delay plus the drive it would need alone.
Off-map assets are a general mechanism: supply runs (M11) will use the same.

**Combat vehicles take wounded back (M10.6b).** A combat vehicle (a Puma, a BMP) that has stood still for a minute,
was not hit in that time, whose crew knows no enemy within 200 m, with no fit men riding in it and whose squad is not
assaulting or clearing a house, goes back with wounded on its own when one man tagged T1 — or three men of any tag —
lie at its platoon's Verwundetennest and no ambulance is there or due within five minutes. Only one hull of a platoon
goes at a time, and the platoon always keeps one on the map. It drives to the nest, its crew lifts the men in (as an
ambulance's crew does, T1 first, lying or sitting as its seats allow), it waits half a minute for more, then drives to
the map edge behind the nest and leaves the map: the wounded are handed over (evacuated); the fit crew stays with the
hull. It is away about 15 minutes (to the company's casualty collection point and back), then comes onto the map
where it left and drives back to its squad's leader (or to where it set off). A man handed over at the aid post is
out of the battle: if he still sits in the hull it brings back, he takes no part, starts no new run and is not hurt
again. A hull carrying wounded aboard (its
squad got in and took the men lying at the nest along) that then stands idle goes back with them the same way. The
player can send any vehicle with **Take wounded back** on the order bar (a vehicle selected); it is refused with a
radio reason when nobody waits, or while its squad is assaulting. While the hull is away, orders to its crew are
refused ("at the rear with the wounded"); on the map, any other order to it ends the run. The AI commander leaves a
hull on a run alone. All numbers are game values in `core/medical.json` `rearRun` (low confidence). The Wounded tab
shows each run (driving to the nest, there with so many aboard, taking so many back, at the rear and back in about so
many minutes, coming back).

**What happens to the wounded after the battle (M10.6b).** When a wounded man is handed over (an ambulance or a
combat vehicle leaving the map), his outcome is settled at once: he reaches **Role 1** (the battalion's aid station)
15 minutes later. Whether he **dies of his wounds** there or later depends on the state he leaves in — shock, blood
lost, lack of oxygen, consciousness, his worst wound — and how late he reaches Role 1 after the first wound (past the
first hour, the "golden hour", the chance rises); a prisoner treated by his captors has a higher chance. If he dies,
the death comes between half an hour and three days after Role 1 (half within about six hours). Otherwise he is
given **recovery days** for the campaign: by his worst wound (a graze 3-10 days up to 120-300 for the worst), plus a
month or two for a broken bone, a fifth longer when a bleeding wound was never treated, a quarter longer when he
reached Role 1 late, plus half a year for a limb lost to a tourniquet left on too long. **At the end of the battle**
everyone still on the field is settled too (owner): a man who needs taking back is evacuated by his side if his side
holds the ground where he lies — more able men within 150 m, or else the nearest able man is his — and reaches an
ambulance 25 minutes later; on ground the enemy holds he is **captured** and treated by the enemy. Prisoners are
treated by their captors. Walking wounded who can still fight stay with their units and are seen to after the
battle. The roster records the outcome: "evacuated", "captured" or "wounded" with `recoveryDays`, or "killed" with
`diedOfWoundsTick` for a man who died of his wounds. A bruise under body armour (the vest stopped the round) is no
wound to settle. A record that comes into the next battle with recovery days keeps them, and its old wounds are not
settled again (only new ones are); an evacuated man is in the rear and must be left out of the next battle's input
(review fix 2026-11-15). The review's Medical tab gives per side the rear runs, the
end-of-battle settlement and the Role 1 outcomes (T1 within 60 minutes, died of wounds, the median recovery); the
batch report's "Rear runs and Role 1" line adds the time from wound to death in bands. All numbers:
`core/medical.json` `role1`, low confidence (no published figures could be opened here).

**Red cross, bearers and the Verwundetennest: who is spared (M10.7a).** Both sides try to keep the laws of war, but
they can only spare what they recognise. A medic wearing the red cross armband, a marked ambulance (the Boxer
ambulance, the BMM), men carrying a wounded comrade, and the men lying at a Verwundetennest are protected as long as
they do not fight (a man or hull that fired in the last two minutes is not). Bearers count as a carrying party only
once they have the casualty: men walking up to him empty-handed are soldiers like any (review fix 2026-11-15). Whether an enemy can tell depends on how
far away he is: an armband is made out to about 50 m by eye and 150 m through a rifle's optic, a carrying party to
150 m / 400 m, an ambulance's emblem or the flag at a Verwundetennest to 300 m / 800 m; at night these shrink to a
third, smoke on the line shrinks them by up to the same, and a frightened or suppressed man looks less closely (down
to half). Within that range a man who sees him marks him as protected in his own mind and does not fire at him, take
cover from him or throw a grenade at him; vehicle crews and missile teams spare an ambulance if any one of them has
recognised it; the AI commander gives no fire order at him and calls no high explosive on a place where all it knows
of is protected people. Beyond that range he takes the medic for a soldier and may fire — an honest mistake. What one
man recognised is not passed on by radio: a comrade who has not seen the armband himself may still fire. **Your
orders:** if you order men to fire at an enemy they have recognised as protected (or at a spot where they know only a
medic, bearers or the Verwundetennest), they refuse and say so on the radio ("negative, we will not fire on that",
in the warning colour), and a grenade or under-barrel grenade order or a call for fire on such a place is refused the
same way. A refused order changes nothing: a drill, an errand or a carrying party goes on, and nobody gets out of his
vehicle first. **On the map** an enemy one of your men recognises as protected carries a small red cross beside his
marker, and firing at him warns you at once that the order will be refused (review fix 2026-11-15). The AI commander
orders no fire at an enemy any of its men spares. The Russian platoon's rifleman-medic wears no armband
(he is a rifleman with medical training), so he is not protected; the German Sanitäter is, and so are the crews of
both sides' ambulances (each man wears the armband; the ambulance medic carries a medic bag and gives care on foot,
for example after his hull is stranded). Breaches come with the after-action review (M10.7b, M10.8). All numbers: `core/medical.json`
`protection`, low confidence (game values; none are published); `npm run lab -- protection` prints them and checks
them in the sim.

**Breaches, and a medic's own rifle (M10.7b).** When a man fires at an enemy who really is protected but whom he did
not recognise (too far, too dark, smoke in the way, too frightened to look), it is recorded as a *misidentified*
breach, with the range, the light, the smoke on the line, his stress and whether he was under orders. Rarely, a man
fires on purpose at an enemy he knows is protected or is giving up (a *deliberate* breach): at most once a minute he
"decides", with a chance of about 1 % for a calm, well-trained man, up to three times that when his platoon has lost a
quarter of its men, twice for poor discipline (low experience) and twice in panic (high stress) — all multiplied, so a
shaken, green platoon after heavy losses reaches about 12 %; once decided, he fires at that man for 30 seconds. The
rules are the same for both sides and come only from the men's training, stress and losses, never from the side. A
German Sanitäter with the armband fires on his own only at an enemy within 50 m (defending himself and the wounded
beside him), which does not cost his protection; drills and the AI commander's fire orders pass him by; only *your*
direct order makes him fire farther, and then he loses his protection for two minutes after his last shot (a
bearer or a wounded man at the nest who fires loses it with any shot). Hits on protected people — a medic, an
ambulance, bearers, men at the nest, wounded men lying out of action, men giving up and prisoners — are counted
separately, aimed at them (he could see the man he fired at) or incidental (a stray round, or fire at an old reported
spot of a man already down there). None of this is shown during the battle: no radio line, no marker; it all
goes into the battle record for the after-action review (M10.8). Prisoners are cared for by the side holding them
like its own men, in order of need (built 2026-11-15). `npm run lab -- protection` adds a misidentification table
(more at night and in smoke) and the deliberate-breach chances.

**After the battle: the Medical and Conduct tabs (M10.8).** The review's two tabs are filled from the battle record,
which is folded from the battle's events (nothing is read from inside the simulation), so the same battle always gives
the same numbers, and the batch tool's "Medical" block uses the very same function (`medicalSummary`). For each man
the record keeps his first and last wound, when he went down and when he died, and his Role 1 outcome. The
**Medical tab** shows, per side: how many were wounded and how many of them were killed within 30 seconds of a wound
(no care could reach them); the median time from the first wound to the first finished treatment, to the
Verwundetennest and to leaving the map; every death of wounds — in the battle or after it at Role 1 — with when he
was wounded and how long he lived; and the **potentially preventable deaths** with the first step of the chain that
was missing: no first aid; treated but never carried back to the nest; at the nest but not taken off the map; or
reached Role 1 later than an hour after the wound. A man who had every step in time and still died is listed with
"nothing missing". ("Potentially preventable" is the military-medicine term: care was missing or late. Whether that
particular wound could have been survived the record does not know.) Below that come the earlier lines: men down
checked, prisoners treated, rear runs, the end-of-battle settlement, Role 1. The **Conduct tab** shows, per side
that fired: breaches by cause (not recognised, deliberate, under orders), how many of your fire orders at recognised
protected people the men refused (owner Q-7), hits on protected people as two lists, aimed at them and incidental
(Q-8), then each breach with its time, who fired from which unit, at whom, at what range, the light, how much could
be seen through smoke, his stress, and whether it was ordered or from a vehicle (the first 30 per side; the counts
cover all). The balance report of the whole medical step (four scenarios, 40-minute battles, with and without care)
is in DECISIONS (2026-11-15, M10.8). In both tabs each side has its own coloured heading and the per-man lines are
indented; durations read "13 min 52 s" or "3 h 4 min" so they are not taken for clock times; the evacuation time
is "during the battle" and left out when nobody was; smoke is mentioned only when there was some on the line.

## Batteries and water (M11.6)

Radios, night-vision goggles and thermal sights run on batteries, and drones on their flight packs. Every battery
is a counted item (rule 9): a man carries the one in his device and his spares, and a used battery stays in his
load at the charge it has left.

- **The battery in a device** sits in a small slot on the man (like the magazine in his rifle). It does not tick
  down every frame: the slot remembers when it was switched on and how full it was, and the charge is worked out
  when someone asks. The tick it goes flat is known in advance, so "is it flat?" is one comparison.
- **When a device is on.** The radio always; the thermal sight always (it is used by day too); the goggles only
  while the light is below 0.5 (where they help). Batteries fitted at the start are part used (30-100 %, drawn
  from the battle's seed), spares are full.
- **Changing it.** A man swaps a flat battery himself, from his own spares, in 10-20 s. In a lull he also swaps
  one that is nearly empty (below 10 %) for a clearly fuller spare. Nobody hands batteries over yet: that is the
  resupply part of M11.
- **When it is flat.** A squad whose radios are all flat is off the net: orders sent to it do not arrive
  ("no comms"), it shares what it sees only by voice (40 m), it calls no ambulance and observes for nobody's
  fire mission, and its radio messages stop (except the few the after-action review needs). A squad riding in a
  hull with a working radio stays on the net. Flat goggles or a flat thermal sight leave the man with his eyes
  (and his weapon sight). A drone with too little charge cannot take off; in the air it comes home when its
  battery runs low.
- **Water** matters only in battles of two hours or more. Men lose water faster when they work hard or in heat;
  below about 85 % they drink 250 ml from the emptiest canteen when nobody is shooting at them. Short of water
  (more than about 2 % of body weight), they tire faster, recover more slowly and aim a little worse.
- **What the numbers are.** Radio packs 6 h (German) and 8 h (Russian), goggles 40-50 h on one AA cell, thermal
  sights 5-7 h on three AA cells, drone packs 75-77 Wh at 150 W (about half an hour), two litres of water a man:
  from public figures where they could be found (medium at most), game values otherwise (DECISIONS "M11.6").
- **Checking it.** `npm run lab -- batteries` runs both platoons on a three-hour night patrol and shows the
  changes, the flat batteries, the drone flights and the water drunk, and checks that every watt-hour and every
  millilitre is accounted for. The review and the batch report have a "Batteries and water" line.

## Ammunition: loose rounds, refilling, the long hold (M11.1)

Every round in the battle is counted. A man's rounds are in the magazine in his weapon, in his spare magazines or
belts, and now also in **loose rounds**: a German rifleman or leader carries one bandolier of 140 rounds on stripper
clips, a Russian one four paper packs of 30. Vehicles carry cans of loose rounds for their squads (two cans of
5.56 mm and two of 7.62 mm in a Puma or Boxer, a tin of 5.45 mm and one of 7.62 x 54R in a BMP-2 or BTR-82A). These
numbers are assumptions (low) until a source for what is really carried is found; the packaging itself (840 rounds
in a 5.56 mm can, 1,080 in a 5.45 mm tin, 440 in a 7.62 x 54R tin) comes from search extracts.

**Refilling magazines.** In a quiet moment — he has not fired for 20 s, nobody is firing at him, he stands still
and is not caring for or carrying anyone — a rifleman refills his emptiest spare magazine that is less than half
full from his loose rounds, one round at a time: 1.2 s a round by hand, 0.4 s from stripper clips. Anything that
needs him (a shot of his, fire on him, a move, an order to fire, an enemy he sees) stops him at once, and he keeps
the rounds he has already put in. A machine gunner never does this in battle: belts come linked.

**Nothing appears or vanishes.** A tool (the "ledger") counts every round of every kind wherever it is: on the men,
in vehicles and their guns' ready belts, in crates on the ground, in the mortar sections' stocks. A test runs every
scenario and checks that what the battle started with, minus what it ended with, is exactly what was fired, thrown
or launched (read from the battle's events only). It found no leak. Moving rounds from one item into another (a
bandolier into a magazine) goes through one function, `moveCharge`, that keeps the total exact; fuel (litres) and
batteries (watt-hours) will use the same one.

**The long hold (`hold-resupply`, in the app `?scenario=hold`).** A German platoon on foot holds the village centre
for an hour against three Russian platoons that come in waves from the east, after 10, 25 and 40 minutes (until
balance pass 3: at the start, after 15 and after 30) (the attacker has a third of the platoon battle's mortar rounds, all from the start: with more, the first wave shelled the defence apart). A wave is not on the map before its time (it does not exist in the
battle yet, so it costs nothing and nobody can see it); the side is not beaten while a wave is still to come. Each
wave has its own computer commander, who plans its attack from where it comes in. The defenders have a supply point
150 m behind the village: per squad one can of loose rounds for each kind of rifle and machine-gun round it fires. The defenders start with one
loaded magazine or belt per stack and (since balance pass 4) a quarter of their usual loose rounds, so without the
chain they can refill a little from their own pockets but not for long.
In this step nobody fetches from it yet (the next steps bring bearers, vehicle runs and deliveries); `--no-resupply`
(headless and batch) switches every resupply off for comparisons (until balance pass 3 it also switched off a man
refilling from his own loose rounds; that is `--no-refill` now). `hold-resupply-ru` swaps the
sides.

**Men fire a little more (where the sources support it).** Two changes, each measured on its own: (1) a unit firing
on an order or a drill slows to one shot every 10 s after 30 s without fire coming in — now only if none of its men
knows of an enemy (seen or told of) within the last 60 s; (2) a machine gun fires rapid bursts (one every 1.5 s, about
200 rounds a minute) for the first 30 s of a target, then the sustained rate (one burst of five every 3 s, about 100 a
minute), as the manuals' rapid and sustained rates (search extracts, medium). A third idea — defenders firing at the
known place of an enemy they cannot see — is built but switched off: in the measurements it wasted rounds without
hits and made the defence break sooner.

**Measuring it.** `npm run lab -- consumption` runs the platoon battles and the hold and reports, per side and weapon,
how much each man carried and fired, how many rounds a minute while in contact (he fired or was under fire in the
last 60 s), how much of the load was gone at 20 minutes and at the end, who ran out of loaded spares or dry and when,
and how many magazines were refilled. `--conservation` runs the conservation check over every scenario.

## Sharing ammunition out, and taking it from casualties (M11.2)

**Evening out in a quiet squad.** Once nobody has fired on a squad for a minute and it has stood still for 20
seconds (not on the march), its leader evens out the ammunition
of the men who can still fight. Belts come first: a machine gunner with fewer than two spare belts gets one from a man
who carries belts for him. Then magazines: a man with two or more spare magazines more than another gives him one,
until no two men of the same weapon differ by two or more. Then packages of loose rounds the same way. Each hand-over
is a man walking over and handing one item across (3 s); at most two hand-overs at a time per squad, and only between
men within 50 m of each other who are standing still. The man who walked over walks back to where he was (his
fighting position, his place in the formation) and faces the way he faced. A marksman's magazines fit nobody else's
rifle, so they stay with him. Fire on the squad stops it.

**Own casualties.** A man who is down for good (dead, unconscious, wounded so badly that he cannot fight, or lying at
the Verwundetennest) keeps his ammunition until his treatment is done — he has been treated and nothing urgent is
left — or, if he is dead, until his comrades know he is dead. Never before (the owner's rule), never while someone is
treating him, checking him, carrying him or on the way to him. Then the nearest man of his squad within 30 m who is
running low (fewer than three spare magazines, or a gunner short of belts) goes over and takes his magazines, belts,
loose rounds, grenades and rockets (8 s). If nobody near is low but the squad as a whole is, the man who treated him
takes them, and then goes back to his place. A wounded man who can still use his arms keeps one full magazine.

**No ammunition at the red cross.** The Verwundetennest holds none (owner): a treated casualty lying there hands his
to the nearest man of his platoon within 30 m who does not wear the red cross; if nobody is there, it is left in a
pile 30 m from the nest, towards the platoon (the next step makes such piles into caches the men can use).

**Taking enemy kit (only on the player's order).** "Take enemy kit" appears on the order bar (on a phone under "⋯")
when the selected squad or man knows of a dead or wounded enemy, or one who has given up, within 150 m. The nearest man
goes over and takes the ammunition that fits a weapon he carries. If none fits, a rifleman swaps his rifle for the
enemy's rifle with its magazines; his own rifle goes into his load (every rifle has an item of its own for that, so
nothing appears or vanishes), and he fires the enemy's rounds from then on. When nothing there fits, the squad says so
on the radio, as it does when nobody is near enough. The computer commander never gives this order. Taking weapons
from enemy wounded and prisoners is lawful (disarming them): it is not recorded as a breach.

**Measuring it.** `npm run lab -- redistribute` sets a squad's spare magazines to between none and six per man and
checks that after a minute of quiet no man is more than one magazine from his squad's average, that the gunner got
his belts first, and that not a round appeared or vanished. The consumption lab now also reports the rounds taken
from casualties per battle, and checks that none was ever taken from a living man before his treatment;
`--no-consolidate` runs the battles without this step for comparison.

## Supply points and caches (M11.3)

**A cache is a pile on the ground.** Crates, cans and tins lying somewhere are a cache: a thing with a place and a
content, belonging to a side. A platoon's **supply point** is one such cache that the platoon uses; any other pile
(crates left at a delivery, a casualty's ammunition left outside the Verwundetennest) is a plain cache. On the map a
cache is a small crate in its side's colour, at every zoom; the supply point flies a pennant and shows how full its
crates and cans are (a bar) and how many rounds are in it. An empty one is grey, a burnt-out one dark. The player sees
the enemy's caches only once one of his men has seen them (within 250 m, with a line of sight), and then only that
they are there, not how full.

**Apart from the red cross (owner).** The supply point is never at the Verwundetennest: it stays at least 50 m from its
platoon's nest, and the nest at least 50 m from the supply point (an order that would put one within 50 m of the other
is refused on the radio). Nothing with ammunition in it is ever put within 15 m of any nest. In the hold battle the
crates behind the village are the defending platoon's supply point from the start; otherwise a platoon gets one where
the player puts it ("Supply point" in the Move tray: tap the map; or drag the marker), and the deliveries of the next
steps will site one automatically like the nest (behind the platoon, out of the enemy's sight). An empty automatic one
moves when the enemy comes near or the platoon has moved on; one with supplies in it stays where it is.

**Resupply (player's order).** "Resupply" appears on the order bar (on a phone under "⋯") when an own cache with
something in it lies within 400 m of the selected squad. Its men go there, each takes what brings him back to his
standard load — every magazine and belt he carries full, his bandolier or packs of loose rounds full — and walks back to
where he stood. Filling magazines at the crate takes time (0.4 s a round with stripper clips and a loader; loose clips
into a bandolier much less), so an empty man spends a minute or so there. The squad refuses on the radio when no cache
is within reach, when nothing there fits its weapons, when it is already full, or while it is under fire. The computer
commander does not use this order yet (the squads' own requests come with the next steps).

**Caches are targets (owner).** A high-explosive burst near a crate damages it and may set it off: within 5 m times the
cube root of the filling in kilograms, more likely the nearer and the bigger the round (a 120 mm round bursting on a
crate sets it off about six times in ten, a 152 or 155 mm shell always; nothing at 20 m). A burning vehicle or a
burning cache within 8 m can set it off too. A cache that goes up burns for half a minute to two minutes: its contents
are lost step by step, the grenades and bombs in it go off one by one (blast and fragments, dangerous to anyone near),
rifle rounds only burn and pop; it smokes. Every round lost is counted (the conservation guard stays exact). The
computer commander shells an enemy cache its men have seen when its mortars have had nothing better to fire at for five
minutes and none of its own men is near it.

**Capture (owner).** A cache with none of its side's men within 50 m and an enemy man within 10 m for 10 seconds
becomes the enemy's, with everything in it (a supply point stops being one). At the end of the battle every cache is
listed in the result with its side and what is left in it; a captured one names the side it was taken from (its
contents count as captured), and the review tallies caches captured and set off and the rounds in them.

**Measuring it.** `npm run lab -- cache [trials]` sets one high-explosive round off at 0, 5, 10 and 20 m from a full
crate (tank guns, mortars, 152/155 mm) and compares the data's chance with real bursts, then lets crates burn out and
checks that the rounds lost match the ledger. `bench-caches` (the bench battle with 20 caches, one shelled) must run
within 5 % of the bench.

## Resupply on foot: squads ask, bearers carry (M11.4a)

**A squad asks.** Every two seconds each squad on foot looks at its ammunition: the rounds its able men hold for their
own weapons (in the weapon, in their magazines and belts, in their bandoliers and packs) against their standard load
(all of those full). Below 40 %, or with its machine gunner under one belt, it radios "running low on ammunition, request
resupply" (at most every two minutes). If an own crate lies within 60 m with something for it, it asks nobody: when it
has not been fired on for 15 seconds and stands still, its short men walk over, fill up and walk back to their places.

**The platoon sends bearers.** On a request the platoon sends at most two men from its supply point: first a man of the
headquarters (never the platoon leader), then the man of the asking squad nearest the supply point, else a man of a squad
that is not fighting. Never a machine gunner, a leader, a medic or a first responder (medical men doing other work would
lose their protection: a software decision from the law of war, for the owner to confirm), never a man of a squad in an
assault, a house clearing, a withdrawal, a rout or fired on in the last 30 seconds (a defended position is not stripped).
A man firing on his own may still be taken from the asking squad or the headquarters: one rifle less for a few minutes.
The same rule holds for the computer's side and the player's. The player's standing rule "Ammunition requests" (Rules
panel) is "send bearers" by default; set to "ask me", the request waits and the squad's card shows **Send bearers**.
**Fetch ammunition** (order bar; on a phone under "⋯") sends two of the selected squad's own men at any time.

**The trip.** The bearers walk to the supply point (where they are fired on they go down and wait until it is quiet),
take a crate of whole cans, tins and magazines of what the squad is short of (two men up to 40 kg, one man up to 25 kg;
half a minute to load) and carry it to the squad leader as a carrying party (the casualty carry of M10.4a with a crate:
about 1.15 m/s, a rest every 250 m, into cover with it when fired on). The crate in their hands is a cache on the map
(drawn just above them): a burst can set it off, nobody takes from it on the way. Beside the squad they put it down and
walk back to their places; the squad's men fill up from it when it is quiet (as with "Resupply"), and what is left stays
there for later. A bearer who loses his mate carries on alone if the crate is light enough, else leaves it where it is.

**Measuring it.** `npm run lab -- resupply [distances]`: a German and a Russian platoon on open ground with the supply
point 400 m behind, the first squad's spare magazines empty: request, bearers at the point, loaded, delivered, squad full,
against a hand calculation (walk there with their load, load, carry back with rests, the men's run to the crate and
taking). Both within 1 % (target 10 %).

## Resupply by vehicle and from off the map (M11.4b)

**The stock at the rear.** A side may have a stock behind the map (the scenario gives it; later the campaign): the only
place anything arriving during a battle comes from. Nothing is made out of nothing: every can, tin or mortar bomb that
comes forward leaves that stock and is counted as delivered, so the ammunition check (start minus end equals fired plus
destroyed minus delivered) stays exact.

**Deliveries.** Each side with a stock has a supply truck waiting off the map (Bundeswehr: an HX2 5-tonne truck;
Russia: a Ural-4320). When a platoon's supply point holds less than 30 % of what it held at first, or a squad of a
platoon without a supply point asked for ammunition lately (a point is sited then), the platoon calls it; the player can
also press **Order a delivery** (order bar; on a phone under "⋯"), which brings a full point's worth. It is loaded at the
call with whole cans and tins of what the platoon's men fire (up to its 5 t), comes onto the map 10-20 minutes later at
the edge behind the point, drives there, is unloaded (a minute plus 0.3 s a kilogram), drives back and is ready for the
next call 20 minutes after it left. One delivery per side at a time. The list of wounded and vehicles on runs shows it
("delivery on its way, about N min", "unloading at the supply point").

**Combat vehicles' rear runs.** A carrier or tank that goes off the map with wounded comes back with its stowage filled
from the stock up to what the data stows, and with up to 400 kg for its platoon's supply point, which it drives to and
unloads first. An idle hull whose stowed ammunition is below half goes back for it on its own (the same limits as the
casualty runs: one per platoon at a time, one hull stays); the player's **Restock** does it at once. A marked ambulance
never does this on its own.

**Mortar rounds.** A stock can top up the side's off-map mortar or artillery allotment: so many rounds every ten
minutes (the hold battle: six 120 mm bombs for the defender). The fire support panel shows the rounds as before.

**The ambulance and ammunition.** The computer never puts ammunition into an ambulance. If the player orders a delivery
with an ambulance (the order names it), it is carried out but recorded as a breach of the law of war, listed on the
review's Conduct tab, and the ambulance has no protection while it carries the ammunition: an enemy who sees it close
enough no longer spares it. Unloaded, it is protected again.

**Measuring it.** `npm run lab -- resupply` also times a delivery 400 m from the edge and a Puma's and a BMP-2's supply
run against a hand calculation (the wait, the drive at the run's pace, unloading): all within 1 % (target 10 %), the
ammunition check exact. Batches take `--no-deliveries` (resupply on foot only) besides `--no-resupply` (since balance
pass 3 the whole supply chain off, while each man still refills his magazines from his own loose rounds and the squad
still evens out its ammunition; `--no-refill` switches those two off as well).

## Re-arming and refuelling vehicles; rounds to mortars (M11.5)

**At a cache.** A hull that stands still within 15 m of one of its side's caches (a supply point, a pile, crates a
truck unloaded) or of its side's supply truck, with a crewman aboard, not hit in the last 20 s, not burning, under
repair, on tow or away, takes back what its stowage is short of: whole belts, rounds, missiles, smoke grenades and
reactive tiles of the kinds the data stows, up to what the data stows. Opening up takes a minute, then each item takes
1.2 s per kilogram (a 120 mm round of about 20 kg: about 25 s). Its ready racks and belts then refill from the stowage
as before. A marked ambulance takes no ammunition. A supply truck gives only what it carries as cargo, never its crew's
own kit.

**Fuel.** Fuel is litres in the tank item, as it always was; every litre burnt is now an event, so the ammunition check
also covers litres (start minus end equals burnt plus destroyed minus delivered, to a millionth of a litre). After the
rounds (or instead of them) the crew pours fuel cans (20 l steel cans, a minute each) into the tank, or takes litres
from a supply truck's own tank by its pump (100 l a minute, keeping 100 l to drive back: there is no tanker in the data
yet). Empty cans stay where they were.

**Asking.** An idle hull (the rear-run rules: still, not hit, no enemy near, no squad aboard) below half its stowed
ammunition or a quarter of its tank drives to the nearest own cache within 300 m that has something for it, works
there and drives back. With none near, it goes on a supply run when its side has a stock at the rear (M11.4b); such a
run now also fills the tank from the stock's fuel cans. A delivery truck also brings what the platoon's hulls are short
of (their stowage, then fuel cans). Any order to the crew stops the work (what was moved stays) and it does not start
again on its own for two minutes. The card shows "Fuel 640 / 900 l · re-arming", the unit list "re-arming".

**Mortars on the map.** A mortar team holding fewer than 10 rounds sends a man (not its gunner if it can) to an own
cache within 150 m of the tube that has its rounds; he takes up to 30 kg of them (3 s a round) and walks back; the tube
stays set up while he goes. A stock's top-up for a side with mortars on the map puts the rounds into a cache 8 m behind
the tubes.

**Measuring it.** `npm run lab -- rearm`: a Puma, a BMP-2, a Leopard 2A7V and a T-90M with empty stowage and 10 % fuel
beside a full cache, and beside a supply truck, against the hand calculation (target 10 %).

## The commander's logistics, the Logistics review and the results (M11.8)

**What the commander decides.** Most of supply runs in the simulation the same way for both sides and for the player:
squads ask, the platoon sends bearers, a low supply point calls a delivery, idle hulls re-arm, mortar men fetch rounds,
and the commander shells enemy caches it has seen. The computer's commander adds two things. When an enemy its men know
of comes within 100 m of a supply point that still holds ammunition, it moves the point 100 m back, away from that
enemy (the crates already there stay as a plain cache that squads close by still use; the next delivery and the bearers
go to the new point), and up to four of its men near the old crates who are short fill up there before they are lost.
And when a squad is below 40 % of its ammunition, quiet for 30 s, halted, with no enemy known within 200 m, no bearers
on their way and no crate beside it, its shortest men, at most half of the squad, go to the nearest own cache within
400 m (a captured enemy cache too) and come back; the other half stays, so a held position is never stripped. A squad
is sent at most every two minutes.

**The Logistics tab.** The after-action review has a fourth tab. Per side: rounds fired by weapon type (rifles,
machine guns, grenades, missiles, cannons, mortar rounds...), with each hull's guns, the rockets and the fire support
listed under it; how many armed men had no round left for their weapon at the end; rounds delivered by bearers, by
vehicle runs and from off the map, and the mortar rounds topped up; rounds taken from own casualties, from enemy men
and at caches; enemy caches captured, own caches set off or lost to the enemy; requests for ammunition, how many were
answered and the median wait (from the first request to the bearers' crate or the squad's first taking at a cache);
litres burnt, refuelled and delivered; re-arming; and the field repair, recovery, battery and water rows that used to
stand in the Battle tab.

**Results.** `BattleResult.logistics` lists per side what was consumed (rounds by ammunition id), delivered from off the
map, captured (enemy caches and kit) and destroyed, with litres by fuel kind, from the events alone; together with the
loads in `forcesOut` this is what a campaign carries on. The batch report has a logistics table with the same columns.

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
riflemen with GP-25 launchers). Since M10.1 the German rifleman is the squad's first responder
(Einsatzersthelfer B) and the first Russian squad's second GP-25 man is the platoon's rifleman-medic. Who is in a squad, with which weapon and which load, is a data file. Every man
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

**Hidden men stay hidden (sight realism step 3, 2026-11-15).** A few metres of crops, tall grass or scrub between
the two now hide most of a man lying behind them (about four times as much as before; cover seeking and routes still
judge vegetation as before). A man who holds still among plants blends into them — the plants behind him make a
busy background — and each man blends in a little better or worse than the next (some lie well, some do not); that
is decided once where he settles, the same for every enemy, and decided again when he moves on or changes posture.
A man standing still in the open is not helped by this. A man lying still is also hidden by the grass, furrows and
small folds of open ground the farther off the watcher is (hardly at 100 m, mostly at 400 m; not from a drone, and
not to a thermal sight). Once seen, an enemy stays easy to keep in view only while he
is doing something: once he lies still and quiet, the watcher must find him again within seconds or lose him
(behind scrub at 300 m he is usually lost within 20 s; in the open at 100 m he is kept). A man crawling shows far
less than one walking. By day the flash and dust of firing are hard to see far off: firing gives a man away about as
before close by, much less at 400 m (at night the flash shows as before). A man who heard shots from a direction
looks three times as hard at an enemy there. A man in a house is in a dark room by day: he shows a quarter of
himself at the window, half that again if he stays back more than a metre from it, and his shots show less. A
weapon's magnifying sight helps only within 10 degrees of where he looks. Thermal sights see heat, not how well a
man blends in, and vegetation hides heat as before. In numbers (spotting lab, one rifleman with a G36, 20 seeds):
a man lying still behind 4 m of crops at 100 m is found in about a minute instead of 13 s; lying still in the open
at 300 m in about 90 s instead of 36; standing 2 m inside a
treeline at 100 m in 8 s instead of 2; standing still at a house window at 300 m in 33 s instead of 9; standing in
the open at 50-200 m exactly as before (1-5 s).

**Contacts.** Each man also remembers: where he last saw an enemy, the direction (and a rough distance) of shots
he heard, and what comrades told him. He tells the men of his unit what he sees and hears — by voice to those
nearby within a second, by radio to the others after a few seconds — and the unit calls new contacts out on
the radio log. Old contacts grow vaguer and are forgotten after two minutes. A fire order can name an enemy:
each man then fires where he believes that enemy is, and follows him as reports come in.

**Fog of war.** You see the enemy only as your men know him. An enemy man one of your men sees now (seen within
the last 2 s) is drawn as a real figure in the enemy's colour, like your own men: posture, facing, weapon, firing,
wounded, down — a dot when zoomed out, and still a solid diamond at the symbol zoom; no callsign and no morale rings
(his state of mind is not seen). His muzzle flashes and the hits on him show too, but only while he is in sight.
Everything else of the enemy stays a symbol: a hollow diamond where he was last seen or reported, with a ring for
how far off that may be, a dashed ring with a cross for shots heard, a "last seen" pin once lost. Old contacts fade
over two minutes. A man killed drops out of sight at once (the simulation's rule), so he becomes a hollow diamond,
then a pin. Tap an enemy marker in fire mode to fire at him. Debug shows the enemy as he really is. (Which men are
drawn: `enemyMenInSight` in `render/src/fog.ts`, the same "in sight now" test as the solid diamond and solid hull;
`npm run screenshot -- --scene sight` shows it.)
`npm run lab -- spotting` prints how long it takes in typical cases; with Debug on, a thin line joins each man
to every enemy he can see.

**Measuring sight (2026-11-15).** Three labs measure how well men see and react, so that every change to sight is
judged by the same yardsticks. `npm run lab -- spotting` also prints the "sight realism" rows: how long one or more
observers take to find a man lying in crops, grass or scrub, standing inside a treeline, crawling, firing, or
standing at a house window, at 100 to 600 m over 20 seeds, and how long a man who was seen stays seen once he lies
down still. `npm run lab -- engage` puts one rifleman in front of an enemy standing or lying in the open at 30-100 m
and times his first shot: halted under each fire rule, walking, or pinned. `npm run lab -- reacquire [seeds]` runs
whole battles (platoon, platoon-ru, village-occupy) and counts, once a second, men who know where an enemy is but
cannot see him and do nothing about it ("blind and idle"), whether a small peek or another window would have shown
him, squads that are blind as a whole, and men who have an enemy in clear view in front of them within 100 m and
have not fired for over 5 s, with the reason.

**Looking for an enemy he has lost (sight realism step 4, 2026-11-15).** A man who knows roughly where an enemy is
(seen or reported in the last minute, to within 20 m) but has not seen any enemy for 4 s no longer just lies there.
Once every 15 s, if he is halted, not pinned and not firing, and his squad is not lying in ambush, holding a sector,
under a cease-fire or "hold fire" rule, moving or in a drill, he looks for him: he turns toward him (out of a fight — his platoon not fired on in the last 30 s — only if that is within 90 degrees of the way he was told to face); if the ground,
a wall or the plants in between hide the enemy from where he lies, he rises to his knees if that would let him see;
else he stands up for 3 s (only if no fire is coming near him) and goes down again; else he moves a few metres to
the side — 2, 4 or 6 m across the line to the enemy, never closer to him, at a crawl if he was lying, on ground he
can walk on, clear of his comrades — to the spot from which he would see the enemy that is least exposed, and takes
his posture there. The side-steps are measured from where his first look started, so he does not wander off; his
squad's next order puts him where it wants him. When his own fire stops because he has lost sight of the man he was
shooting at, the look starts at once. Indoors, a man at a window who has seen no enemy for 6 s moves (at a run,
along the rooms and stairs) to another window of his house that looks onto the enemy and that no comrade holds or
is on his way to, the nearest by the way there, at most once every 20 s. A man still cannot see through crops: when
nothing near him shows the enemy (most of the time in an attack through fields), he waits, and finding the enemy
again is the squad's work (step 5). The labs: `npm run lab -- reacquire` counts the man-seconds spent standing up
or moving to look, and the men hit while doing it; its blind spells now run through a man's own looks and end only
when he sees an enemy again, forgets him, fires or his squad moves. (Code: `lookForLost` and `windowSwitch` in
`sim/src/systems/decisions.ts`, `forEachSidestep` in `systems/peek.ts`, shared with the drills' side-step,
`windowWithView` in `systems/occupy.ts`; values `behaviour.soldier.peek` and `windowSwitch`.)

**Squads shifting to see a lost enemy (sight realism step 5, 2026-11-16).** A man's own look reaches only a few
metres; when nothing near him shows the enemy, the computer commander now moves him. In defence, once its platoon
has taken its fire positions, it looks at each squad (and at the platoon leader's own men) every 10 s, one after
another. A man who has seen no enemy for 6 s, is not pinned, under fire or on his way somewhere, and whose squad
knows an enemy man within the range of fire (300 m by day, 200 m in the dark) to within 40 m, may be shifted: the
commander works out, as it did at the start, the best spot within 35 m of the place first chosen for him (inside
the objective's ring for a squad holding one; a window of a house nearby counts too) from which a kneeling man
would see where the enemy is known to be and the ground round it, judged by the enemy's own posture. An enemy known
to be coming nearer counts double. Only a man whose new spot shows the enemy while his place now does not is sent, at
most half the squad at one look, crawling if it is 8 m or less, walking otherwise, facing the enemy; the same man
is not sent again within 20 s. A squad that has seen nothing for 30 s may reach 50 m. **A bounded follow:** when the
enemy the squad knows best draws away by more than 30 m within 20 s and nobody of the squad sees him, a steady
squad (morale 0.45 or more, not pinned or broken) sends up to half its men to spots up to 50 m out that see where
he went, never more than 50 m beyond its objective's ring; they come back to their places after a minute, or at
once when fire comes near them. Men shifted go back to their places once nothing is known of the enemy for a
minute. **In attack**, a squad of the base of fire none of whose men has seen an enemy for a minute slides along
the support line (20, 40 or 60 m to either side, or 20 m forward) to the spot that sees most of the enemies known
near the objective (or its ring when none are known) instead of firing blind, at most every 30 s. Only the
computer commander does this: your own squads find a lost enemy only through their men's own looks (step 4) and
your orders. The lab `npm run lab -- reacquire` prints how many men each commander shifted, followed
and sent back, and how often the base of fire slid; a man shifted by his commander is on a look, and his blind
spell goes on until he sees the enemy again. (Code: `reacquire` and the base-of-fire slide in
`ai/src/commander.ts`, values `COMMANDER.reacquire`; `siteDefence` in `ai/src/siting.ts` with its new `anchors`
option.)

## Under fire

Every enemy round that cracks past a man within about 4 m — or strikes near him — **suppresses** him a little
(heavier rounds more); a grenade or shell bursting nearby a lot. Suppression fades within seconds when the fire
stops. A suppressed man aims worse and is slower to spot; heavily suppressed he is **pinned**: he drops flat,
stops moving and fires only now and then until it lets up (a yellow ring). In practice a machine gun pins the men
it fires at within a couple of seconds at 200 m and within about 8 s at 600 m; a fire team within about 6 s; a
single aimed rifle seldom pins anyone. `npm run lab -- suppression` prints the table. Debug labels show
suppression / shock per man.

### Morale (reworked 2026-11-15)

The owner found morale "almost always at 100, even when wounded, saw buddies die". It is now a real number from 0 to
100 % for every man, and the **Morale** bar in his box shows exactly the number the simulation uses. It is made of
three parts multiplied together:

- **Resolve** — how steady a fresh man of his unit is: conscripts start at about 85 %, regulars 93 %, veterans 100 %.
  Each man also has his own **nerve** (a few are brittle, a few rock-steady, the same spread on both sides).
  Exhaustion and heavy losses in his squad lower it.
- **Shock** — the fast fear. Rounds cracking past him (at once, not only after half a minute), a comrade hit (much
  worse at 5 m than at 50 m, worse for his own squad than for another; several losses in a minute worse still), his
  leader falling, his own wound, a wound nobody has treated, a comrade left lying with nobody going to him, shells
  bursting near him, an enemy tank he knows of (less if his squad has a rocket launcher), being outflanked, an enemy
  close by, being alone. It fades again over a minute or two once it is quiet, more slowly under light fire, not at
  all while the fire is heavy.
- **Strain** — the slow wear of losses, his leader and his wounds. It fades over tens of minutes, and never below a
  floor set by how many of his squad have been lost (half the squad gone: morale stays below about two thirds).

Each blow is softened or sharpened by the man himself and his situation: experience, his **leader near him** (the
leader's leadership skill counts; a corporal who has just taken over usually leads less well), mates around him, his
squad's **cohesion** (higher for better troops; it drops when the leader falls or wounded men are left lying, and rises
when a casualty is carried out), good cover, own armour close by; at night a little sharper. The same things speed
his recovery. Good news helps too: an enemy his squad knew of falling, an enemy unit breaking, own mortar or artillery
fire landing near an enemy his squad knows, a medic working on a comrade nearby.

From it follow his **states**, each with a margin so that nobody flickers between two:

- **shaken** below 60 % (steady again at 70 %): fires at 0.7 the rate and aims worse;
- **pinned** when suppression reaches his quality's level (conscripts sooner, veterans later, sooner when shaken), or
  below 40 % while under fire: flat, does not move, fires a third as often;
- **panicked** below 25 % (a little earlier or later by his nerve; at least 20 s, until he is back at 40 %): he does
  not fire. Under heavy fire or with an enemy close he cowers where he is; otherwise he **runs back** 50-150 m from the
  enemy he knows and lies down there.

His **leader rallies** him: an able squad leader whose own morale holds, not pinned himself, spends 4 s crouching (and
exposed) with the worst-off man within 30 m — panicked, pinned with low morale, or badly shaken — easing his shock by
up to half (more for a good leader, less under fire); a runner stops. Each man at most once in 30 s. Without a leader a
man recovers on his own, more slowly.

Every second each **unit** gets a morale value (the mean of its men) and a state: shaken, pinned, or **broken** when
half its able men have panicked or its morale stays below 22 % for 20 s — but never in its first two minutes under fire
(counted from the first time its own men are fired on) unless it has lost half its men, and never within two minutes
of rallying. Each man counts once as a loss however often he is hit (down, then dead, or down, then a prisoner); a man
who comes round counts no more. Squads can break on their own (they run back about 150 m and rally once nothing has
been fired at their own men for 30 s, or sooner when the platoon leader comes over once they have stopped running:
8 s); the platoon breaks — and loses the battle — when half its men panic or half its squads have broken, and only
after losing 30 % of its men (40 % for a defending platoon). Men of a squad that has already broken do not count again
as panic toward the platoon's half. A unit is outflanked when enemy it or its platoon knows of are spread over more than
100° around it, or one within 150 m is more than 90° off the main direction. A broken unit of the defence that the
enemy has outflanked gives up together once an enemy is within 50 m (attackers never: they run). The AI commander no
longer sends a pinned, broken or badly shaken squad (below 45 %) into an assault.

On screen: the man's box shows the Morale bar coloured by his state with the state word, then **Why:** the two biggest
reasons ("comrades hit, leader lost") and **Helping:** what is lifting him (his leader near, just rallied); suppression
and fatigue keep their own bars. In the Men list a small second badge beside the status picture shows a man shaken,
pinned, panicked or fleeing, so a wounded man who has also panicked shows both. The unit list shows each squad's
morale ("morale 72 % shaken"). The radio carries "we're getting shaken here", "rallying the men", "falling back!" and
"rallied". `npm run lab -- morale` runs the set pieces (losses under light fire, a machine gun's heavy fire by
quality, recovery with and without a leader). All values are game values in `core/behaviour.json` (`morale`) and
`core/qualities.json`; nationality plays no part.

**Men inside a vehicle** (owner's choice, 2026-11-13: "only own vehicle") see nothing outside, so they are shaken
only by what happens to their own vehicle: a comrade falling *inside it*, its armour being penetrated (a big
blow) or struck by a cannon round, a heavy bullet or a burst that does not get through (a small one). Comrades
falling outside, a neighbouring carrier burning or a leader falling in another vehicle do not reach them; once
they are out they feel everything as before. (Before, a cook-off could panic the men in the carriers 20 m away
and break a mounted platoon within seconds.)

## Thinking for themselves

Between orders each man decides a few things for himself, once a second. **Fire rules** (per unit, set with
the `rules` order): *free* — fire at any enemy you see; *return* (the default) — at any range once your unit has
been fired on in the last 30 s, and before that only at an enemy he sees within 100 m (self-defence: an enemy close
in front of him is shot at, not watched); *hold* — never without an order. A cease-fire order holds until the unit
is fired on again. He engages an enemy he sees within the range his weapon is used at (rifle 400 m, a 4x-or-more sight
600 m, machine gun 800 m), choosing the one who matters most: close, firing (a machine gun most of all),
standing. He stops when he has lost sight of him. An order always wins over his own choice. **Under fire** and
visible to the enemy he knows of, he runs to the nearest spot within 15 m where that enemy cannot see him lying
down — preferably one he can fire from on his knees (a bank, a low wall). **Out of spare magazines or belts**,
he gets one from the nearest comrade within 30 m who has more than two (or carries belts for the gun): the
comrade runs up behind him and hands it over in 3 s. **An enemy close by** (added with the sight realism work,
2026-11-15): a man who sees an enemy within 40 m in front of him fires at him whatever else he is doing — on his way
to fetch ammunition, caring for a wounded comrade (the care waits until he has not seen such an enemy for 10 s), or
firing on an order or a drill at a point more than twice as far away. A pinned man (not a panicked one) fires back,
lying where he is and at his pinned rate, at an enemy he sees within 50 m. A man running, in an assault or on a
push fires as he goes at an enemy he sees within 75 m (badly aimed, as assault fire). Carriers of a wounded man fire
in self-defence within 40 m (30 m before), also while the party lies in cover. Hold, a cease-fire, an ambush not yet
sprung, a range limit and a defend arc still hold for all of these. With Debug on, a line shows each man's own decision
(orange: the enemy he engages, blue: the cover he runs to, green: the man he brings ammunition to).

## The single soldier (owner's packages, 2026-11-13)

An audit of single men in battle found them shooting high at men lying down, sitting on their last magazine while
the enemy closed in, lying in the open where they dropped, bunching on one spot, staying under mortar fire, never
getting up again, never throwing a grenade and never firing on the move. The owner chose all four packages of
fixes; they came in four steps.

**Shoot straight (A).** A man aims at the middle of what he sees of the enemy: low (0.2 m) at a man lying down,
0.6 m at one kneeling, 1 m at one standing — what he remembers is the posture he last *saw* the man in (a man only
heard, never seen, is aimed at as before, 0.9 m). Before this, every shot at a man lying down passed over him: on
the firing range a regular lying down hit a prone man 0 % of the time at 30–100 m aiming at 0.9 m, 46–91 % aiming
at 0.2 m. Vehicle machine guns aim the same way. A man who sees an enemy go down (lying hit, or falling while he
watches) knows he is down and tells his comrades; nobody fires at, takes cover from or plans against a man known
to be down. His last magazine is a close-defence reserve (above). A rifleman firing on his own beyond 200 m fires
at half the rate (ordered fire, a base of fire keeping the enemy down, keeps its rate). And he keeps his target:
he changes to another man only when his own is down or has been out of his sight for 5 s, or when the other
matters clearly more (less than 0.7 times his score: nearer, firing, standing).

**Use the ground (B).** A man pinned or panicked where the enemy he knows can see him no longer just lies there:
he low-crawls (0.3 m/s) to the nearest spot within 8 m, never toward the enemy, where that enemy cannot see him
lying down; once he is no longer pinned he fires back from there. A man pinned or panicked out **in the open** (no
wall, hedge, building or wood within about 4 m, not in a house) crawls to cover too, even when he cannot tell who is
shooting at him: he hears where the bullets cracking past him come from, and hides from that side (else from the
enemy he knows, else from the enemy his comrades know). He takes the nearest spot within 8 m where he would be out
of sight from there lying down — behind a wall, a hedge, a house, in a wood or a dip in the ground — else looks out
to 15 m, and if nothing hides him from that side he crawls to the nearest wall, hedge, house or wood anyway. He
never crawls toward the fire, keeps clear of his comrades' places, and tries again at most every 10 s. A man who is
already lying by a wall or hedge, or in a dip that hides him from the fire, stays where he is. Men going to cover, to the end of a move, to the objective of an assault or to a rally point keep
about 5 m from the places their comrades have taken or are going to, instead of piling onto the one best spot (two
squads' last men rallying on the same point used to lie on top of each other). And men remember where enemy
mortar rounds are falling: a man within 60 m of a burst remembers the mission for 90 s; halted out in the open (no
wall, hedge, building or wood within about 4 m) within 35 m of where it is falling, he goes into a house within
30 m if there is one, else 40 m out of the area, not back across it and not toward the enemy, and takes cover
there; when the fire has lifted (no burst for 90 s) he goes back to the place he left. A man next to a wall or a
hedge stays down where he is, and so does a squad still on its way somewhere or just given an order.

**Stay in the fight (C).** Each man remembers the posture of his fire position — where his last move, Occupy or
posture order left him: kneeling or standing at a window, lying in the open. When he dived (pinned, a grenade) he
used to stay down for good (in a village defence both sides lay below the sills for 23 minutes and fired 35
rounds); now, once he is no longer pinned and the fire near him has died down (suppression below 0.05, a few
seconds), he takes that posture again and his fire goes on from there. A man lying where he cannot see the enemy
he knows (a bank, a low wall in the way) rises to his knees to look, checked every 4 s, and goes down again when
fired on. Idle men outdoors turn to face the enemy they know when he is behind their shoulders (a sector they were
given within 90 degrees of him is kept); in a fight the last idle man of a team of three or more watches the
rear. A squad on its way into a house (Occupy, or a move that ends indoors) no longer stops in the street when it
comes under fire: it finishes going in. A man with an anti-tank launcher who knows of an enemy vehicle he cannot
see — heard, reported, or out of his line — moves up to 30 m to a spot from which he could see it, at least 40 m
from it, preferring its flank or rear, at most every 20 s.

**Close combat (D).** A man carrying hand grenades now throws one on his own at an enemy he knows (seen or
reported in the last 30 s) within his throwing range who is behind cover from him or in a house — but only if he
can find a way to get it there from where he is (not into a wall, a ceiling or a lintel), no man of his own side is
within 10 m of that enemy, and nobody else of his team is already throwing; at most every 20 s. Throwing range still
depends on posture (about 15 m lying, 20 m kneeling, 30 m standing for a regular), but a man lying down comes up on
a knee or to his feet for a longer throw, then goes down again. That was the reason the AI's grenade orders at
enemies 15–35 m away never produced a thrown grenade (only launched ones): the assaulting men were lying down; also
a man running (an assault's next rush) had his throw broken off at once, and many throws ended "no way to throw it
there". Now the men picked for a grenade order stop to throw, the drill waits for them, and only men who have a way
to get it there are picked. In the last 50 m of an assault the men on the move fire as they go — at the enemy they
know near the objective — with three times their aiming error: fire to keep heads down while they close, not
to hit.

**Fire discipline (2026-11-14).** A man no longer shoots a comrade lying at his elbow: a man of his side right beside
the muzzle (from a little behind his shoulder; a man lying down is long, so from further back) counts as in his line,
and he holds his fire. A man firing bursts — a machine gun, or a rifleman on automatic up close — also holds his fire
for a comrade in his safety cone up to 60 m past the point he fires at (the rounds that miss go on; one gun hit its
own men 30–45 m beyond its target). Two halted men of a side outdoors who end up within 1 m of each other on the same
floor (two squads sent to the same fold, a crawl ending where another man lies) no longer stay there: the one with
the higher number steps 2–3 m aside, sideways to the enemy rather than toward him (checked once a second; men handing
over ammunition, men indoors and at windows are left alone), and the end points of move orders keep clear of places
men of other squads of the side have taken. A man who rose above his fire position's posture to fire (to his knees
to clear a bank, say) goes back down to it between shots when the next one is at least 3 s off and the way down and
up again fits in, when he changes magazine, when no posture gives him a line of fire, and while a comrade is in his
line; he rises again just in time for the next shot, so his rate of fire is the same. He keeps each posture at least
1 s for this. Machine gunners firing bursts and men at windows are left as they are.

## Squad drills

**Contact.** A unit on the move that comes under fire after a quiet spell stops, its men go down and seek cover
and fire back under their fire rule; the radio says "contact! Taking cover." The same happens when one of its men
sees an enemy close by — within 150 m by day, 75 m in the dark — who had not been in sight for 10 s (an enemy
already in sight when the move was ordered does not stop it). Only the unit whose own men are fired on (or see the
enemy) does this, and any unit of the same platoon on the move within 25 m of it; a squad further off with its own move
goes on (a move given to the whole platoon still stops it all). **Moving under fire.** A man on a walk or sneak leg
who comes under fire (suppressed at least 0.1) runs the rest of his way, and walks again only after
10 s without fire: nobody walks on into fire. This is his own reaction, so it applies to your orders too. **Assault** (order, with a point):
the unit splits into two halves (its two teams, else every other man). One half runs 30 m toward the point and
goes down while the other covers it with fire; then they swap, until the last 25 m, which they rush together,
spreading round the point and facing on ("on the objective"). **Covering fire:** each covering man takes an enemy
he knows within 60 m of the point that he can hit from lying, kneeling or standing with no comrade in his line
(the men share the enemies out); if none, one whose cover (a hedge, wall or house within 15 m of him) he can fire
into, else the point itself. Rounds into cover are fired at the sustained rate (one every 4 s), as is fire at the
point when no enemy is known; they still crack past men lying there. A covering man with no shot looks again
every 2 s and may dash 2-6 m aside, once a turn, to a spot that gives him one. The runners go only once a
covering man has fired in the last 5 s, or after waiting 10 s ("no move without fire"; they keep firing
meanwhile), and each ends his rush a little aside, out of the covering men's lines of fire. A fire order you give
may likewise go into the cover just short of the point. The turn passes as soon as the runners are down, or
when the last one is still running 10 s after the others: he finishes his rush and fires from where it ends while
the other half goes. If the runners are pinned the turn passes after
40 s; a runner who is pinned on the way stays down and the others go on without waiting for him; when every man
is pinned the squad waits. **Withdraw**
(order, with a rally point): the same backwards, the halt firing toward the enemy it knows;
the last 30 m together ("back at the rally point"); a unit of three able men or fewer goes back in one rush, all
together (with only two men, bounding left one lying alone to cover the other and took minutes). **Breaking.** When half a unit's able men have panicked, the
unit breaks ("falling back!"): every man runs about 150 m away from the enemy they know, does not fire and does
not take orders ("unable"). Once they are there and nothing has been fired at them for 30 s they rally
("rallied"), still shaken (their shock cut to 60 %). Since the morale rework (2026-11-15) this holds for squads too,
not only for the whole platoon (see "Morale" above).

## Surrender

A man who is wounded and can no longer fight gives himself up when an enemy he knows of is within about 50 m
and no fit comrade is within about 30 m. A panicked or fleeing man gives up when an enemy he knows of is within
about 30 m, comrades or not. Attackers are tougher: a man of the attacking side, or of a squad in the middle of an assault, does not give up when he panics (he runs back instead), and a wounded attacker gives up only when an enemy is within about 25 m. From then on he is out of the fight: he takes no orders, does not fire and does
not use the radio; a white flag shows over him. The enemy stops shooting at him once they have SEEN him give
up (until then he can still be hit, and shells and grenades aimed at the area can still hit him). A man who can
still walk then walks over to give himself up: upright, hands up, slowly (never running), to the nearest enemy
within about 80 m whom he knew of or who can see him (preferring one who has seen him give up), and stops about
2.5 m short of him. If that man moves away, falls or gets into a vehicle, he turns to another; when fire passes
close he lies down and waits until it has passed; after about 90 seconds he stops and waits where he is. An enemy
who comes within a few metres takes him prisoner (a white square) and, if he has nothing else to do, turns to
cover him. A man who cannot walk (or has stopped walking) stays where he is: when it is quiet, one enemy nearby
who saw it walks over to take him and then goes back. **Under fire** (owner request 2026-11-15) a surrendered man who
can use his arms goes down and crawls out of the line of fire: to the nearest spot within about 15 m hidden from where
the rounds come from (else from the nearest enemy he knows), by a way of at most about 25 m; once the fire has passed he
goes on with his walk over, or waits there to be fetched. A wounded prisoner is treated by the enemy's men like their
own (above, under care). **Fog of war:** a surrendered or captured enemy is shown like any enemy man — as a figure only
while your men see him now, otherwise as his contact marker with a white flag at the place he was last seen (the
flag fades with the marker). A surrendered or captured man costs his side the same as a man
down. Your fire tap on an enemy your men know has surrendered gives no order.

## Prisoners (M11.9a-c)

What happens to a man once he has been taken prisoner (the Third Geneva Convention as the owner listed it: humane
treatment, out of the combat zone as soon as possible, not exposed to fire, the wounded treated like one's own,
officers, NCOs and men kept apart, searched for weapons and documents, personal effects kept). The same rules for
both sides; the numbers are in `core/prisoners.json` (game values; the research came from search extracts only).

- **The collection point.** When a platoon takes its first prisoner it sets up a prisoner collection point (a pale
  disc with a small fenced square, "PW" and the number held there under it): about 150 m behind the platoon, away
  from the enemy it knows and hidden from it, where a wheeled vehicle can drive in, never within 50 m of its
  Verwundetennest or its supply point (and they keep 50 m from it), and never within 250 m of a known enemy. When
  a known enemy comes within 250 m it is moved back and the prisoners and their guard walk to the new spot. **Fire
  moves it too (M11.9c):** when rounds land within 30 m of it (a burst there, or rounds cracking past a man held or
  guarding there) it is moved at once to a spot at least 60 m from where they landed ("fire on the prisoner
  collection point, moving the prisoners back"); the guard walks there at his pace and the prisoners at theirs, and a
  prisoner pinned down crawls out of the line of fire first. You can put it somewhere else with **Prisoner point** in
  the Move tray (refused next to the nest or the supply point); a point you placed stays where you put it, under fire
  or not: keeping prisoners there is then your decision (see "exposed" below).
- **Groups.** Officers (NATO rank codes OF-), NCOs (OR-5 and up) and men each have their own spot at the point, 10 m
  apart; a man whose rank has no NATO code counts as a man. One escort never walks two groups.
- **Escorts.** Once the squad that took them has not been fired on for 30 seconds and is not in an assault, it
  sends one man per four prisoners of a group (the capturing squad's own men first, then another squad of the
  platoon that is not fighting). Never the leader, a machine gunner, a medic or first responder, a man carrying or
  busy, and no squad is left with fewer than two other men. While men are still giving up close by, the escort waits
  so that they go together. **Escort prisoners** on the card's bar sends escorts at once, even under fire. The
  Rules panel's row **Prisoners: escort automatically / ask me** (M11.9c) lets a unit's prisoners wait for that
  order instead (guards for the point are still found on their own).
- **The search.** The escort searches each of his prisoners where they stand, 30 seconds a man (standing; fire
  interrupts it and he goes on where he stopped). He takes the weapon (with the magazine in it), every magazine,
  belt, round, grenade, rocket and launcher, the radio, goggles, thermal sight, drone and batteries, and the
  **documents** every leader carries (team leader and up: map, orders, notebook). The prisoner keeps his helmet,
  vest, load-carrying kit, water, rations, first-aid kit and medical items, identity tag, armband and rescue blanket.
  Everything moves as counted items: nothing appears or vanishes. Whatever the escort took beyond 15 kg he puts
  into a captured cache at the collection point when he gets there (your men can take from it).
- **The walk back.** The searched prisoners walk ahead at the slow hands-up pace, the escort 3-5 m behind them at
  the same pace. Under fire everyone goes down and the prisoners crawl out of the line of fire, then they go on.
- **Guards.** At the point one man per six prisoners stays as a guard; the other escorts go back to their squad
  leaders. A man escorting or guarding is out of the fight: he fires only in self-defence within 50 m, orders to his
  squad pass him by (it fights one man short), and only **Release guard** sends him back (refused for the last guard
  while an enemy is known within 250 m of the point, unless confirmed). The card shows "Prisoners 5 (1 officer,
  1 NCO) · guard 1"; a man's box says "escorting 3 prisoners" or "guard (5 prisoners)".
- **Wounded prisoners.** The captors' medics treat them by urgency like their own men; one who cannot walk is
  searched where he lies, then carried by the platoon's bearers to **its** Verwundetennest and taken back with its
  own wounded, by urgency alone. He stays "captured" in the roster.
- **The military police (M11.9b).** Each side has one military police team waiting off the map (German: a
  Feldjägertrupp of three in a protected Dingo with 5 places for prisoners; Russian: a military police section of
  three in a KamAZ "Patrul" with 7). The platoon radios for it as soon as its collection point holds its first
  prisoner who can walk ("military police requested, about 26 min"); **Call MP** on the card's bar (on a phone under
  "⋯") calls it yourself (refused when there are no prisoners, when it is already on its way, or when none is left).
  It comes 15 to 30 minutes after the call, at the map edge behind the point, turns short of the point and backs up
  to it. While the point is under fire (an enemy known within 250 m, or men there pinned down) it waits 300 m short.
  At the point its men get out and **take over the guard** (your guards walk back to their squads at once), and the
  prisoners who can walk board at its rear door, 20 seconds a man: officers first, then NCOs, then men. It never
  takes more than it has places. Then its men get back in and it drives off; off the map the prisoners are
  **evacuated** (the card says "3 taken away"). It is back 30 minutes later and comes again if prisoners are still
  waiting. If it is knocked out on the map it is an ordinary vehicle: its prisoners get out and wait at the point,
  and your platoon guards them again. It carries no red cross and may be fired on, but the prisoners aboard are
  protected: a hit on it while they are aboard counts as a hit on prisoners in the review. The Wounded and units tab
  lists its run ("military police on its way, about 12 min").
- **After the battle.** A prisoner stays "captured" in the roster, with the side holding him and, if the military
  police took him, when. A man who gave up but was never taken goes to the side holding the ground around him at the
  end: its prisoner, or back to his own side if that is his. The battle result lists every prisoner each side holds
  (his group, wounded or not, how he left: military police, medical, or still held, documents taken from him) and
  counts per side the prisoners taken and evacuated.
- **Escapes (M11.9c; rare).** A prisoner who can walk and whom no fit man of the holding side within 25 m can see
  (smoke counts) may try to get away: once a minute a chance of 2 %, doubled in the dark, doubled in smoke, doubled
  when a prisoner of another group stands beside him (leaders organise), halved once he has been searched. A guard in
  sight means no attempt at all. An escaping man runs to the nearest fit man of his side. For 10 seconds the enemy
  still sees a man who gave up; after that anyone but a guard may fire at him (the Geneva Convention allows weapons
  against escaping prisoners only as the last resort; **guards never fire at him**, and a hit on him is not recorded
  as a hit on a prisoner). Within 30 m of a fit man of his side he is **free** and back in the fight, unarmed if he
  had been searched (he can pick kit up as anyone can). A fit man of the holding side who gets within 5 m of him
  recaptures him (he gives up again and is taken); hurt so that he cannot walk he gives up where he lies. A man still
  running at the end goes to the side holding the ground around him. The radio says nothing; the review lists it.
- **Exposed prisoners (M11.9c).** Prisoners kept more than 60 seconds at a point within 250 m of a known enemy, or
  pinned down by fire there, without being moved, are a breach of the law of war ("kept exposed", review only, no
  radio line). The automatic point moves away and never causes it; a point you placed and kept there can.
- **The review's Prisoners block (M11.9c).** The Conduct tab has a block per side for the prisoners it held: taken by
  group (and taken at the end), searched and what was taken (weapons, rounds, documents), escorts sent and the mean
  walk to the point, minutes of guard and escort duty (men out of the fight), wounded prisoners treated, carried to
  the nest and evacuated, handed to the military police and taken away, escape attempts, escapes and recaptures,
  still held at the end, seconds the point was under fire, exposures and hits on prisoners. The batch report has the
  same as its "Prisoners" line.
- **The computer's side** does all of this on its own as well; it never counts guards and escorts as fighting men
  and never sends a guard away (it gives no orders to men on prisoner duty).

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

**Assault with the vehicles (balance pass 5, owner 2026-11-20).** Give **Assault** to a squad or platoon that is
riding, or to a hull, and the vehicles do the drive in. Each carrier goes to its own **dismount point** short of the
objective: the side's doctrine distance (Germans 300 m, Russians 400 m, from the research on each army's drills),
on the way in, 60 m apart across it, and if a spot up to 100 m farther back is out of sight of the objective's near
edge and of the enemy its men know, that one. The map shows each point as a small square at the end of a dashed
line. The squads get out there, or earlier if their carrier (or one within 300 m) is hit, if the crew knows enemy
men within 400 m or sees an enemy hull within 600 m, or after five minutes; then they assault on foot as any squad
does: rushes by halves, the last stretch together. The empty carrier **falls back a little** to a support-by-fire
post (a diamond on the map): a spot about 20-140 m behind where it let them out from which its sight sees at least a
quarter of the objective, preferably one where only its turret shows, not within 300 m of enemy men it knows (rocket reach) and
never within 200 m of the objective. From there it fires every 20 s at the enemy its side knows on the objective (only
those its gun has a line to, never near its own men); when its squads get within 200 m it shifts its fire to the far
half, within 100 m it lifts it altogether, and says so on the radio. Russian carriers then follow their squads about
150 m behind, post to post; German ones stay on their post (each side's doctrine). When the squads are done: if one
of them stands on the objective, the vehicles close up to 60 m short of it; if not, they go to their squads to pick
them up. A hull with nobody aboard (a tank, an empty carrier) **assaults by fire**: it goes to a post about 250 m out
and fires on the objective, but never drives onto it without infantry. At night the post must lie within the
hull's night sight of the objective (a thermal sight reaches as far as the gun; the BMP-2's image intensifier about
850 m), so a hull without a good night sight moves closer, never inside 200 m. The card shows the hull's part
("driving to the dismount point", "squads getting out", "supporting by fire"). Any new move, halt or assault order to
a unit takes it out of the drill. The AI commander's attack uses the same dismount points and support posts (its
carriers stop and back to a post as soon as their squad is out, instead of driving on empty). Lab: `npm run lab --
mounted-assault`. A built-up objective (a building, or a village: 8 houses or 4 % of the ground covered within 120 m)
gets a shorter dismount distance from the faction's doctrine (DE 150 m, RU 200 m, against 300 / 400 m in the open):
the houses hide the last stretch, so the carriers drive to the last covered spot at their edge. Their support posts
may then stand closer (100 m from the objective) and must see into the streets round it. Enemy men known close to a
riding carrier get its squads out early only when they are nearer than the dismount distance plus 50 m; a hit on the
carrier or one within 300 m still gets them out at once. A carrier jammed among the others is sent on again twice
before its squads get out where it stands.

**Area fire and air burst (balance pass 5, the owner's request).** A vehicle crew that has lost sight of enemy men
does not go quiet at once: under the fire rule "free" it keeps firing at the places its men last knew them. Each
such place is a circle round where the men were last seen or reported (their spread plus how far they may have
moved since), with a weight that halves every 45 s (twice for a man who was firing) and is dropped after two minutes
or once its weight falls below 0.4 (one man unseen for about a minute). A cannon fires a short burst at a random point of the circle every 20 s divided by the
weight (at least every 6 s); a tank's main gun fires only at a heavy place (a group, or a firing machine gun), one
round every 45 s; otherwise the machine gun beside it. Half of each ready belt is kept for enemies it can see
(ammunition rule "max": none kept; "conserve": no area fire at all), and nothing is fired at a place within 60 m (or
the round's danger radius) of own men, with own men in the line, or under the rules "return" or "hold". A support
post of the mounted assault with no enemy known on the objective fires at the objective itself the same way. Where
the real round has a programmable fuze, the crew sets it to **burst in the air**: the Puma's 30 mm KETF round
bursts about 15 m short of the laser range and throws its 162 tungsten pellets forward in a narrow cone; the
Leopard's DM11 bursts 3 m over the point and throws its fragments all round. A seen man in the open gets the air
burst too; one in a building gets the impact setting. The BMP-2, the T-72B3M, the T-90M and the wheeled carriers fire
impact-fused high explosive (no source for an air-burst fuze on their rounds yet). The player can pick "Gun: HE air
burst" in the Fire tray of a hull that has it. Lab: `npm run lab -- areafire`.

**How the two sides compare (balance pass 5).** In the mounted platoon battle by day the German attack in Pumas wins
about three times in four and the Russian attack in BMP-2s with two T-72B3M about half the time. The differences are
the real vehicles': the Puma's 30 mm armour-piercing round goes through a BMP-2 from any side, its air-burst round and
fire control hit men out to a kilometre, and its thermal sight finds men the BMP-2's gunner cannot see; the BMP-2's
Konkurs missile and the Russian tanks are what kill Pumas. In the campaign this shows more strongly than in one
battle: the Germans win their operations and the Russians, as the player, lose theirs, because even the smallest German
force the campaign sends (one Puma platoon with its company headquarters) beats a motor rifle company.

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
its own men (since balance pass 4: no own man within the round's danger radius and spread of the point, on any side,
and none in the gun's line unless it passes well over his head; a target it could not fire at is passed over, and the
crew says why it holds). A cannon shell that strikes a man bursts on him. You can order a vehicle to fire at a point or an
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

**Field repair (M11.7a).** A crew fixes light damage itself, with time and the parts its hull carries: a **broken
track** (two spare track links of the eight-odd stowed on a tank or IFV, back to 80 %: the hull drives again), a
**holed wheel side** of an 8x8 (no part: run-flat inserts and tyre pressure; back to 50 %, the hull limps), the
**coaxial machine gun** (a spare barrel; it works six times in ten) and the **radio** (no part; five times in ten:
often the set itself is beyond them). Everything else — engine, gearbox, gun, turret drive, stabiliser, sights,
ammunition, fuel — needs a recovery vehicle or the workshop; a failed repair leaves that part "beyond the crew" for
the battle, and a track is not worth fixing while the engine is dead. The crew starts on its own when it is quiet:
the hull halted and not burning, not hit for a minute, its men not under fire for 20 seconds and, for work
outside, no enemy known within 300 m. The driver (the mechanic) and the loader or gunner get out to the damaged
side and kneel there: they are men in the open, seen, shot at and hurt like anyone on foot; the commander stays at
his post. Inside work (coax, radio) keeps a man under armour but away from his gun. A track takes two men about
45 minutes (a seasoned crew 38, a green one 50), a wheel side 20 minutes with two men or 36 with a GTK's driver
alone, the coax about 11 and the radio about 17. A hit on the hull, fire on the men outside, a fire, bailing out or
driving off stops the work; what is done stays done, the parts stay aboard until the end, and the crew goes back
to it after another quiet minute. The **Repair** button (behind "⋯" on a phone) starts it at once without the
quiet minute (not within 10 seconds of a hit); a move order ends it. The vehicle's card shows the repair ("repairing
the track: 40 %, about 25 min"), the spares aboard and what is beyond the crew; the radio reports start, stop, end
and failure. `--no-repair` (headless, batch) and `?repair=0` switch it off; `npm run lab -- repair` measures every
hull and task.

**Recovery (M11.7b).** What the crew cannot fix can be towed away. Each side that has vehicles in a generated battle
has one **recovery vehicle** waiting behind the map: the German **Bergepanzer 3 Büffel** (a Leopard 2 hull with crane
and winch; it tows anything up to 70 t, the Leopard 2A7V too) and the Russian **BREM-1** (a T-72 hull; up to 50 t:
T-90M, T-72B3M, BMP-2, BTR-82A — a Leopard 2 is too heavy for it). They are unarmed in the game and, like the
ambulances, not part of the side's strength. Select a crew whose hull is **immobilised or abandoned** (or the crew
that bailed out of it) and press **Recover** (a tow hook; behind "⋯" on a phone; the tooltip says how many are
left): the recovery vehicle comes onto the map after 10 to 20 minutes, at the edge behind the hull, drives to it and
reverses the last 25 m up to it. It does not drive into a fight: while the hull has been hit in the last two minutes
or an enemy is known within 300 m of it, it waits about 300 m short until it has been quiet for a minute, and after
ten minutes of waiting in all it goes back. At the hull the passengers get out (the crew stays aboard: the driver
steers the towed hull; the wounded stay aboard and are evacuated with it), and one man of the Büffel's crew (two of
the BREM-1's) goes out behind his vehicle to hook up the tow bar — two minutes for the Büffel, four for the BREM-1 —
exposed like any man on foot; a hit on the recovery vehicle or fire on its men stops him until it is quiet again.
Then it tows the hull back to where it came on at no more than 8 km/h (the hull follows on the bar, its guns silent)
and both leave the map: the hull is **towed away** — out of this battle, but saved for the next (its crew with it).
Orders to a hull on the bar or towed away are refused. If the recovery vehicle itself is knocked out or loses its
driver, the tow drops where it is. One call per hull; a hull that drives again (repaired meanwhile) or is destroyed
before it comes stands the call down. The AI commander calls one for its own hulls that are abandoned or immobilised
with nothing the crew can fix, when it is quiet there and there is time left — never for a stranded tank whose gun
still works while the enemy is within a kilometre (it fights on as a pillbox). The vehicle's card shows "recovery
vehicle on its way, about 12 min", "waiting, the hull is under fire", "hooking up: 40 %", "under tow"; the tile says
"under tow". **At the end of the battle** every damaged, immobilised or abandoned hull still on the map is settled
like the wounded: the side holding the ground there (more able men within 150 m, else the nearest) recovers it, or
the enemy **captures** it; a hull that still drives with its crew is never captured; a destroyed one is lost. The
roster record (`VehicleRecord.recovery`) carries towed / recovered / captured / lost and the workshop days its damage
will take (campaign). `--no-recovery` (headless, batch) and `?recovery=0` leave the recovery vehicles out;
`npm run lab -- repair` (part B) measures delay, drive, hook-up and tow for every hull.

**Crews that back off.** A crew whose vehicle can still drive decides once a second whether to fight on or to
**reverse out**. Since the owner's change of 13 November ("make armour not back out of every fight") it backs off
only when it has really been hurt or really cannot defend itself: when it has been penetrated, when its weapons are
out of action, when its commander panics (being merely shaken is not enough), or when an enemy soldier on foot is
right next to it — within about 50 m — and none of its guns can fire at him (too close for the gun to point down
at him, behind a wall, or no working gun left). A rocket that bounces off the armour, or ordinary rifle and machine
gun fire, no longer sends it back. When it does back off, it fires its smoke screen toward the danger and backs
away about 60 m — in reverse if the danger is in front, so its front armour and gun still face it — and waits there
about 15 seconds. If it backed off because of enemies close by or a panicking commander (not because it was hit),
it then drives back to where it stood and rejoins the fight, unless something new drives it off again. A vehicle
you have given a move or halt order to holds that order against enemies close by and a panicking commander: only a
penetration or lost weapons make it back off. This holds only for orders you give: the computer opponent's vehicles still back off from a panicking commander and close enemy men, in the game exactly as in test runs (fixed 14 November: the game had marked the computer's orders as yours). The radio says "under anti-tank fire, reversing out!". A crew that has bailed out is a small squad on foot from then on: you can
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
knows near the objective, never close to its own men. Since balance pass 3 (owner 2026-11-18) a vehicle in overwatch
that has fired nothing for 75 s bounds forward: the AI picks a hull-down spot up to 150 m ahead (the same search as
the tanks' posts), at least 40 m farther forward, always 100 m or more behind the side's foremost man on foot and
200 m from houses or woods the enemy may still hold and from enemy men it knows; if there is none it tries again 30 s
later. The new spot is never farther from the objective, at most about 225 m away, never nearer a known enemy
vehicle that could reach it with its guns or missiles, and one the vehicle can drive to (a spot it was sent to and
could not reach is not picked again from where it stands). A vehicle that is busy with an enemy vehicle, out of
main-gun rounds, hit and reversing, re-arming or refuelling, or still carrying men stays where it is (game values in `core/behaviour.json` `mounting.overwatchBound`; without them the vehicles stay).

**Wheeled carriers (M7.6c).** Each army also has a wheeled platoon: the German **Jägerzug** in four **GTK Boxer**
(eight-wheeled; a crew of two, the commander working the remote weapon station on the roof — a 12.7 mm heavy
machine gun with a thermal sight and laser rangefinder — and eight men in the back: a Jägergruppe of eight with an
MG5 team, a Panzerfaust, a marksman and an Einsatzersthelfer; the Zugtrupp rides in the fourth) and the Russian
**BTR platoon** in three **BTR-82A** (crew of three, a 30 mm 2A72 and a machine gun in a small turret, seven men in
the back who get out through cramped side doors; the platoon commander rides in the first). Which platoon a battle
uses is chosen by the class of its carriers, never by vehicle name: `&vehicles=wheeled` (or `tracked`, the
default, or one each, `&vehicles=wheeled,tracked`). A wheeled carrier is faster on roads, turns in a circle rather
than on the spot, and keeps to ground wheels can cross (no woods). The Boxer's hull stops heavy machine-gun fire;
the BTR's front stops 12.7 mm but its sides do not; every cannon round and rocket goes through both.

## The screen: order bar, unit list, labels (M7.5a)
The battle opens with **nothing selected**. The **order bar** is always there; until you pick a unit its buttons
are greyed out. Pick a unit by tapping one of your men or vehicles on the map, or its tile in the **unit list**.
The bar then offers only what that unit can do right now: a squad gets Anti-tank only while someone still has a
Panzerfaust (or RPG) with a round for it, the grenade orders only while it has grenades, Fire support only
while your mortars have rounds left; a vehicle gets move, fire (the gun choice cycles through the rounds its
guns really have), the smoke screen while its dischargers are loaded, and Dismount while men ride in it; a unit
with just one man left can move, fire, throw, change posture, halt and cease fire. (Since the "bar-card" step the
bar itself is short: see "The order bar, the unit card and the men" below.)

**Moving the bar.** Hold the grip (⠿) at its start and drag: a highlighted strip shows which edge it will go to;
let go and it docks there — a full-width strip at the top or bottom, or a full-height column at the left or
right. Your phone remembers the choice. Until you move it, it sits at the bottom with the phone upright and at
the right with the phone on its side. If the bar ever does not fit, Mount, Dismount and Halt wait behind **⋯**.

**The unit list** is a slim strip of tiles down the side (the right side when the bar is docked left): each tile
shows the unit's symbol, callsign and how many of its men are fit (5/6), and a coloured edge for its state —
green ready, light blue moving, orange firing, grey riding, yellow pinned (or a damaged vehicle), red broken,
dimmed out of action. The ☰ at its head opens the full list with the details; on a wide screen it is always open.

**Collapsing a platoon (owner 2026-11-20).** A platoon (any unit with sub-units) has a small fold button with an arrow:
under its tile on the slim strip, at its right in the open list. Tap it to hide everything under that platoon (its
HQ, drone, squads and vehicles); tap it again to show them. Tapping the fold button never selects the platoon; tapping
the tile still does (and holding it still follows). A folded platoon's button shows how many units it hides ("+7"),
its tile still counts all its men (33/33), and a coloured dot in its corner shows the worst state among the hidden
units (red broken, yellow pinned or a damaged vehicle, orange firing, grey out of action; the open list also says
"below: pinned"), so folding never hides trouble. Everything starts unfolded. When you pick a hidden unit some other
way (on the map, even tapping the unit already selected, with Tab, from the Wounded tab), its platoon unfolds so its
tile shows; Tab still goes through every unit, folded or not. On a keyboard, Enter or Space on a focused fold button
folds it. The folds last until the page reloads (loading a saved battle starts unfolded).

**The platoon, its HQ and its drone (owner 2026-11-15).** Each platoon has three tiles at the top of its block:
- **Zug 1** (the platoon, "whole platoon" in the open list): an order given here goes to everybody — the squads, the
  HQ and the vehicles. This is the only way to move the whole platoon at once.
- **HQ Zug 1** (a small light **HQ** badge; on the slim strip just "HQ"): the platoon's own men — the platoon leader,
  his radio operator, the medic. Tapping one of these men on the map, or the Puma they ride in (tap again to go
  through its riders), selects this HQ, not the platoon. Its orders reach only these men: Move, Fire, grenades,
  posture, rules, and **Mount / Dismount** exactly like a squad (on a phone Mount and Dismount wait behind ⋯ on the
  order bar). The unit card shows the same badge: "Zug 1 HQ 3/3". The Puma that carries the HQ says "HQ aboard".
- **Drone**, right under the HQ: the platoon's reconnaissance quadcopter, always listed while the platoon still has
  it — on the ground with the radio operator, while he rides ("aboard … gets out to launch"), or in the air (its
  battery). It disappears only when the drone is lost.

**How to launch the drone.** Tap the **Drone** tile, then tap the map where it should fly. The radio operator
launches it by hand from the ground: if he is riding, he first gets out of his vehicle by himself (the rest of the
HQ and the squads stay in), then it takes about a minute to set up and launch, and the radio says "drone up". While
it flies, tap the map again to send it somewhere else; **Halt** brings it home to land with him. He stands still
while he flies it.

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

## Ordering by dragging (the "controls" step, owner choices 2026-11-13)
Ideas taken from Firefight's way of giving orders (only the ideas: the look and the words are our own). They
work the same with a finger and with a mouse; each gesture ends in one of the ordinary orders, so nothing about
the battle itself changed.
- **Drag from the unit to move it.** Press on the selected unit (one of its men, or its vehicle), drag, and a ghost
  of the formation follows the finger with a dashed line from the unit; let go and the move is sent at once, at
  the pace last chosen. Drag back onto the unit before letting go (a red cross shows) and nothing is sent. In the
  Assault or Withdraw mode the same drag sends an assault or a withdrawal. For a route with several points, tap
  the map as before and press Go.
- **The move's marker.** While a unit carries out a move you gave it, its destination shows as a white ring with
  a dot. Drag it somewhere else and the unit goes there instead (same pace, formation and width, straight from
  where it is now). Drag it onto the unit itself (the red cross) and let go: the unit halts. The Halt button
  still does the same.
- **Turning on the spot.** A selected unit that stands still has a round green handle ahead of it, with an arrow
  for the way it faces. Drag the handle round: a ghost shows where the men will stand; let go and they turn that
  way where they are (it is the usual move order, sent to the place where the unit stands, with that facing; the
  point is shifted so that the middle of the group stays put). A vehicle turns on its tracks. Indoors there is no
  handle: Occupy faces the men to the windows.
- **Seeing before firing.** In Fire (or Anti-tank) mode, hold the finger or mouse down on the map: a line runs
  from each of the unit's men (a vehicle's sights) to the point — solid where the view is clear, broken (with a
  small cross) from where a hill, a wall, a roof or thick woods stop it. The check uses only the ground, the
  buildings, the woods and the vehicles your side knows about, so it never gives away a hidden enemy. Slide the
  point about while holding; let go to fire there. Slide back onto the unit (red cross) and let go to call it off.
  A quick tap fires at once, as before. While Fire is chosen, a one-finger drag on the map does not pan it (use
  two fingers, or the mouse wheel and another mode).
- **Back to Move after one order.** After a one-tap order — fire, anti-tank, grenade, all grenades, fire support,
  occupy, or an assault or withdrawal sent by dragging — the bar goes back to Move, so the next tap does not fire
  again by mistake. To give several such orders in a row, double-tap the button: it locks on (a bold yellow frame
  and a small LOCK mark) and stays on after each order; double-tap it again, or pick another order, to unlock.

## The order bar, the unit card and the men (the "bar-card" step, owner choices 2026-11-13)
Ideas taken from Firefight (only the ideas: the drawings, words and colours are our own).
- **A short bar.** The order bar has only the main orders, each a small drawing with a short name: **Move**,
  **Fire**, **Halt**, and **Mount** or **Dismount** when they apply. The little arrow beside Move opens the other
  ways to move: Assault, Withdraw, Occupy, Clear (a house, room by room; added 2026-11-14), and Stand up / Kneel / Lie down. The arrow beside Fire opens the
  weapons: Anti-tank, Grenade, All grenades, Fire support (a vehicle: its gun choice and its smoke screen) and
  Cease fire. Pick one and the Fire (or Move) button shows it, lit, until the order is given; the next tap on the
  button gives that order again. The same rules as before decide what is offered (no grenades left, no Grenade).
- **Occupy where you drag.** Drag a squad onto a house and let go: it goes into the house as before, and an
  **Occupy** button pops up beside the spot for a few seconds. Press it and the squad occupies the house instead
  (men at the windows facing the enemy).
- **The unit card.** With a unit selected, a card at the bottom left shows its name, how many men are fit and its
  state, and two rows of buttons always in view. **Pace:** Run, Walk, Sneak, Crawl (a vehicle: Fast, Drive, Slow,
  Reverse) — the pace of the next move; pressed while the unit is on a move you gave it, it goes on at that pace
  along the rest of its route. **Fire:** At will (fire at any enemy they see), Return (only once fired upon), Hold
  (only when ordered), **Ambush** (hold fire until an enemy is within 100 m, then fire at will). The lit button is the
  one in force; the Rules button on the card opens the full rules (range, on contact, ammunition, anti-tank).
- **The men.** The card's **Men** button lists every man: a little picture of a soldier for how he is, his rank
  insignia, his job, his weapon and a small ammunition bar with one cell per magazine or belt (see "Rank insignia and
  status pictures" below). Tap a man's row, or tap him on the map, and a box opens: his insignia drawn larger, his
  status in words, his rank and name, his
  weapon and rounds, what he is doing right now (moving at a walk, firing at an enemy he sees, pinned down, bringing
  ammunition ...), his pulse, his morale bar with its reasons, bars for how hard he is under fire and fatigue, and his wounds. A
  yellow ring marks him on the map. Tap him again or the × to close it. The card remembers whether you like it short
  or with the men. On a phone the card keeps to a small part of the screen: the radio shows its two newest lines
  while it is open.
- Nothing about the battle changed: every button sends one of the orders that already existed.

## Rank insignia and status pictures (owner 2026-11-14)
- **Rank insignia.** Each man's row and his box show his rank as it is worn on the field uniform, drawn by the game
  itself (no copied pictures) at the real proportions. The German side wears the olive **rank slide**
  (Aufschiebeschlaufe, 90 mm long, 52 mm wide at the collar end and 60 mm at the shoulder end) on the camouflage
  shoulder strap, whose buttoned point shows above it; below the slide, at the shoulder seam, a 4 mm **green loop
  (Litze)** in the Panzergrenadiers' arm-of-service colour. The devices are woven in black: no slide at all for a
  Schütze (only the strap and its green loop), one to four diagonal stripes for Gefreiter to Stabsgefreiter, a braid
  open at the bottom for an Unteroffizier and closed all round for a Stabsunteroffizier, the closed braid with one or
  two chevrons point up for Feldwebel and Oberfeldwebel and a "headed" chevron (legs crossing under a small diamond)
  for a Hauptfeldwebel, one or two four-pointed stars for Leutnant and Oberleutnant. The Russian side wears the
  **field sleeve** (a plain rectangle of the jacket's cloth, 50 x 120 mm, no button, no coloured stripe or piping)
  with stripes and stars in a dark protective colour: one, two or three narrow (10 mm) cross stripes 2 mm apart from
  25 mm above the shoulder end for efreytor, mladshiy serzhant and serzhant, one wide (30 mm) one for starshiy
  serzhant, a wide stripe along the whole sleeve for starshina; 13 mm five-pointed stars, the first 25 mm from the
  shoulder end and the next rows 25 mm apart: two or three in a line for the praporshchiki, two side by side for a
  leytenant and a third above them for a starshiy leytenant. The test faction has a made-up grey tab.
- **Where it comes from.** Each faction's `appearance.json` describes its insignia as data, in millimetres on the real
  board: the board's trapezoid and colours, the strap that shows under it (with its button), the arm-of-service loop
  (its colour and width) and per rank a list of devices with their positions and sizes. One drawing routine
  (`ui/src/insignia.ts`) turns that into a picture for any faction. On the small row picture it only helps what
  would vanish: neighbouring stripes keep about a pixel's gap, stars stay at least about 5 pixels across, the loop at
  least a pixel thick. The descriptions come from public regulations and rank tables found by web search (the pages
  themselves could not be opened here): the kind and number of devices, the Russian sizes and the German slide size
  and loop width are "medium"; the German device sizes and positions, the headed chevron's exact shape and the
  colours' exact shades are inferred ("low"). Like the uniform colours they are outside the battle data: changing
  them never changes a battle or a replay. Tests check that every rank a faction has (and so every rank in its unit
  templates) has an insignia, that every device lies on its board, and the researched counts and sizes.
- **Status pictures.** The little soldier at the start of a row shows how the man is, by posture and colour, with a
  badge where it helps: standing green (ready), standing yellow with tremble marks (shaken), lying under incoming
  fire, orange (pinned down), in a vehicle hatch, blue (mounted), standing with a red cross badge (lightly wounded),
  on one knee with a blood drop (seriously wounded: a wound of a quarter severity or worse, or one still bleeding
  hard), lying with a red cross (out of the fight), lying grey with a cross (killed), hands up with a white flag
  (surrendered), behind bars (prisoner), and a dashed outline with a question mark (missing). Hover or long-press
  shows the words; screen readers read them too. Only your own men are listed, so nothing about the enemy shows.
  The picture leaves a corner free for the medics' triage tag, which comes later.

## Reading the map, following units, the keyboard (the "map-feel" step, owner choices 2026-11-13)
Ideas taken from Firefight (only the ideas: the drawings, words and colours are our own). Nothing about the battle
changed: the lines and pins are drawn from what your side already knows, and the keys send the same orders as the
buttons.
- **Where everyone is going.** Every one of your units on the move has one thin, faint line from the middle of its
  men (a vehicle: from the hull) to where it is going, with a small dot at the end — one line per unit, never one per
  man. The selected unit's line is bright and follows its route. A mortar mission has a broken amber line from the
  man who called it to a ring on the target, from the moment it is called until the last round has fallen. Zoomed
  right out to the unit symbols, the faint lines are left out when more than six units are moving (the selected
  unit's line and the mortar lines stay).
- **"Last seen" pins.** An enemy your men lose sight of does not just fade away any more: about 6 seconds after the
  last sighting his mark turns into a hollow pin standing on the spot where he was last seen, with how long ago
  ("seen 45 s ago", "seen 3 min ago"). The pin stays — even after the men have forgotten him — until he is seen again
  (the pin goes, he is a live mark again) or your men have had a clear look at the spot for 5 seconds and he is not
  there: a man within 200 m (600 m for a vehicle's spot) sees the ground there clearly, low enough that he would see
  a man lying in it. An enemy seen falling or getting into a vehicle leaves no pin; a sound alone never makes one.
  A lost vehicle keeps its hollow outline under its pin.
- **Following a unit.** Tap a unit's tile in the unit list: it is selected and the map centres on it (tap it again
  while the map is on it to unselect it). Hold the tile for about half a second: the camera follows the unit,
  gliding after it, and a small green "Following …" badge shows at the top; zooming keeps following, panning the map
  (or tapping the badge) stops it.
- **Contour lines.** Height lines still come by themselves when zoomed out. The **Contours** button in the top bar
  (on a phone behind "⋯"; the C key) shows them at every zoom: close up they are fine pink lines, every 2.5 m of
  height, stronger every 10 m — for finding a reverse slope or a hull-down spot. The choice is remembered on the
  device.
- **Keyboard and mouse (desktop).** Space pauses and goes on; 1, 2, 3, 4 are the speed buttons in order (pause, 1×,
  2×, 4×); W A S D or the arrows move the map; Tab and Shift+Tab pick the next or previous unit and centre on it; F
  follows the selected unit; M, T, H, B, G are Move, Fire, Halt, Get in/out and Grenade (T twice quickly locks Fire
  on); Enter sends a planned route and Backspace takes back its last point; C toggles the contours. **Esc** closes
  or cancels the innermost thing — a menu or this card, a drag, a planned route, a chosen order (back to Move), the
  man's box, following, then the selection — and never leaves the battle. The **right mouse button** moves the
  selected unit from anywhere: right-click a spot and it goes there, or right-drag and a ghost of the formation shows
  where it will stand. **?** (or F1, or the ? button in the top bar) shows a card with every key and every mouse and
  touch gesture. Touch is unchanged.


## Calling mortar fire: hold a point, pick HE or smoke (the "fire-support" step, owner choice 2026-11-13)
An idea taken from Firefight (only the idea: the drawings, words and colours are our own).
- **One button.** Under Fire's little arrow there is one **Fire support** button (it is offered while your mortars
  have rounds left). Pick it, then press and hold on the map where the rounds should fall: an amber ring with a
  broken line from the unit's leader marks the point; slide your finger (or the mouse) to adjust it, and let go. A
  quick tap or click works too. A small box opens beside the point with **HE** and **Smoke** and how many rounds of
  each are left. Pick one and the call goes out (4 high explosive or 2 smoke, plus the ranging rounds); the × , Esc
  or waiting eight seconds closes the box without calling anything. Like the other one-tap orders, the bar then
  goes back to Move (double-tap Fire support to keep it on).
- **Watching it walk in.** The mission's broken amber line runs from the caller to a ring on the point. Each ranging
  round leaves a cross where it fell (amber if someone saw it fall, pale if no one did), joined by a short dotted
  trail to the point, so you can see the rounds walking in. When the battery fires for effect a second, wider ring
  appears round the point. The line and the crosses go when the last round has fallen.
- This is the one part of the Firefight list that changed the battle itself (see "Mortars and smoke" at the top):
  the order is the same `callFire` order as before; ranging, volleys and the remembered points are in the
  simulation, with new values in the factions' data (game values, low confidence).
## Fixes after the review of the Firefight-style screen (2026-11-13)
- **Sharp screens.** On phones and Retina screens the map's idea of the screen size was half the real one, so
  "centre on this unit" and the follow camera aimed at the wrong place. Now a tapped tile puts the unit in the
  middle of the map area that is left free — above the unit card and the radio log — and the follow camera keeps it
  there.
- **No peeking.** The sight-line preview (hold in Fire) looks through every enemy vehicle your side has not seen,
  however many stand in the line, and a vehicle you only heard counts as unseen. A mortar round nobody saw fall
  leaves no cross on the map. A "last seen" pin goes after five seconds of your men watching the empty spot,
  counted from when the enemy was lost.
- **Mortar memory.** The battery only remembers a point as "ranged" if someone saw at least one ranging round land.
  A blind call is ranged again next time instead of firing for effect with the full error.
- **Touch.** In Fire or Fire support mode a quick swipe moves the map; press and hold still (a fifth of a second) to
  get the sight lines. Moving the map with two fingers, or holding an arrow key, stops the follow camera.
- **Small things.** Pressing T twice no longer locks Fire on (only a double tap or click does). Undoing the last
  route point closes the route. Dragging the facing handle keeps the squad's shape (a column turns as a column) and
  the handle stays where you let go until the squad starts to turn. The start hint is one short line that goes as
  soon as you pick a unit. The top line starts with the time and the mortar rounds ("mortar HE 24 · smoke 12").
  When both platoons have a "Puma 2", the map and the card say "1/Puma 2" and "2/Puma 2". On a phone with the bar at
  the side, the pace and fire buttons keep their words. Sight lines and the selected men's rings have a dark edge so
  they show on pale fields; close-up contour lines are dark brown like the zoomed-out ones; the help card shows
  either the touch or the mouse rows; long lists fade at the bottom to show they scroll.

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

A wounded man who crawls to cover is drawn crawling. Men carrying a casualty are drawn by the way they carry him:
dragged on his back behind one man or between two who walk side by side; sitting on the joined hands of two
bearers; across one man's shoulders (one figure: the bearer with the man over his shoulders); on a litter with two
bearers side by side at each end; a lightly wounded man helped along walks beside his helper. (Only the picture
moves the bearers side by side: the battle keeps them where the simulation has them.) Turned figures keep their
rifles, hands and dressings, and the side outline and the photo look's dark rim follow the figure's edge.

**Roofs.** A roof is drawn over each building until one of your own men (on foot, able) is inside it or within
8 m of its walls, or until you zoom in close: then it fades away and shows the floor, the walls, the doors and the
windows. Enemy men never lift a roof.

## The photo map (plan "photo", 2026-11-14)
The map is drawn like a soft, low-resolution aerial photograph of countryside (the owner's wish: the feel of
Firefight's battlefields, but every pixel our own, generated in code from the map; no reference images). It is the
default look; `?look=flat` (or `pixel`) gives the M7.5b flat pixel map and `?look=classic` the look before it. The
choice is remembered in the browser (`tcs.ui.look`); a URL parameter wins. Only the picture changes: the battle,
the map data and the replays are exactly the same in every look.

**How it is painted.** Pure painters in `render/src/photo/` (no Pixi, no browser, no randomness, no clock) turn the
map into pixels. `prep` runs once per map: the fields (connected areas of the same ground, each with its own tint and
furrow direction), the distance to each field's edge, a 2 m grid of warps, tones and hillshade. Then for any rectangle
at any resolution: the ground (soft warped field edges, tone patches, clumps, furrows, crop rows and tramlines,
meadow tufts, garden rows, dry patches), the roads and tracks (soft wobbly edges, dusty verges, ruts), water (mud
banks, deeper in the middle, sheen), bridges, walls and fences, the shadows of trees, walls and buildings (one
buffer, the darkest wins, so nothing is darkened twice), the tree crowns (woods, tree lines, hedges, orchards, scrub:
domes and leaf clumps lit from one side), then a light blur, a quiet colour grade and grain. Every pattern is keyed
to world metres, so any tile joins its neighbours byte for byte, and fine patterns fade out when they would be
finer than about three pixels (no shimmer when zoomed out).

**One sun.** Light comes from the west-north-west, about 40 degrees up (`photo/light.ts`): every lit roof face,
crown, hillside, and every shadow (trees, walls, buildings, hulls, men) falls the same way, toward the
east-south-east.

**Resolution by zoom.** The whole map at about 1 pixel per metre is always there; over it, tiles at 2, 4 and (on
strong devices) 8 pixels per metre, chosen by how many screen pixels a metre takes. Tiles paint in a worker (one on
small devices, two otherwise) off the main thread, nearest the middle of the screen first; at most two are uploaded
per frame and a new tile fades in. While the photo map is still painting, the flat map shows, so the screen is never
blank. Phones stop at 4 px/m and keep a smaller tile cache. Roofs are painted once per map into a roof atlas (hipped,
gabled or flat, lit by the sun) and still fade when your men are near or you zoom in close.

**Keeping the game readable.** The ground is kept quiet: colour saturation capped, patches at most about 5 %
brighter or darker (larger swings read like camouflage), cover classes in a fixed order of brightness (water, woods,
hedges, scrub and orchards, plough, grass, crops, tracks, walls), minimum widths on screen for roads, streams,
hedges and walls. Bright blue, red, yellow, white and cyan are left for units and overlays. On this busier picture
the units get a little help (photo look only, so the flat and classic looks stay exactly as they were):
- each man at the figure and close zooms has a soft contact shadow under him and a dark rim outside his side's
  outline; at the dots zoom a dot has a dark rim and a lighter core;
- each hull casts a soft shadow down-sun; a wreck and a shell crater leave a ragged scorch mark on the ground;
- labels have a thicker dark edge; route, move, fire and objective lines are drawn over a dark line 2 px wider;
- zoomed far out (symbols) a light veil sits over the map so the symbols stand out;
- contour lines are fainter, with a faint light edge on their north-west side; close up (from 12 px/m) a fine
  neutral grain fades in so the ground does not look smeared.

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

## The AI in houses (M7.5e)
Both sides now use houses on purpose (owner, 2026-11-14).
- **Holding a house:** when the AI defends, it places each man where he sees most of the way the enemy will come.
  Windows of the houses near his post are among those places, looked at from the window's own height (a window
  upstairs sees over hedges and walls). It never puts the whole squad inside: at most about 6 men in 10 go in, at
  least 2 stay out, at most 2 share a room and 4 a house, the men outside keep 8 m from the walls of a house in use
  (one shell must not catch them all) and one of them watches the house's back. A window upstairs is taken only if
  it sees clearly more than the ground floor. The order the AI gives is the player's Occupy, for one man at one
  window.
- **Leaving a house:** a house can become a trap. Men leave it on their own (every side, the player's squads too)
  when two grenades or bombs have burst in or on it within half a minute (a mortar bomb counts twice), when an
  enemy has been seen inside (a man who has that enemy in his own room fights him instead), or when the enemy is
  on two sides of it. The whole squad in that house runs out, by the side away from the enemy, to cover 25–50 m off,
  says so on the radio and does not go back into that house for two minutes.
- **Clearing a house:** the AI attacker clears the houses on its way in and the ones in the objective's ring while
  they are defended. The squad bounds up to the door as in any assault, its covering half firing at the windows
  facing it; the men stack against the wall beside the door (never in front of it); one posts a grenade into the
  room behind it (aimed at the far corner); after the burst three men go in, then the next room the same way, from
  the doorway, ground floor first, then up the stairs (no grenade up a stairwell). A squad that took a house in the
  objective's ring stays in it and holds it as a defender would.
- **Clearing on the way (owner, 2026-11-14):** the AI attacker does not only clear houses in the assault. A squad
  advancing to its fire position, or closing in on the objective, first clears a house on its way when an enemy
  its men have placed (seen, or reported close) is in it and that enemy overlooks the squad or the place it is
  going to — at most one such clearing at a time, up to 150 m out, only a squad of at least four. While it closes in
  on the objective, a house at the near edge of the objective counts too (it no longer walks past it to 60 m first).
  In the usual platoon battles this is rare: the defenders hold the objectives, so few enemies sit in a house on the
  way in (4 of 20 village battles changed, clearings a little earlier).
- **Clear button (owner, 2026-11-14):** the player has the same drill. Open the Move tray (the arrow beside Move)
  and press **Clear**, then tap a house — or drag the squad onto it — and the squad clears it room by room as
  above. A house with no way in is refused with a note in the radio log. Single men cannot clear.
- **Measuring:** `npm run batch` prints a "buildings" block (time indoors and upstairs, wounds inside and outside,
  grenades into houses, bombs on houses); `npm run lab -- house defend|leave|clear`; the scenario `house-clear`
  (one squad holding a house, two attacking it, both under the AI); `npm run screenshot -- --scene buildings`
  (`--seed 3` to see men upstairs).
- **What it changed:** in the village the defenders spend about a third of their time indoors (before: almost
  none) and are wounded about a third as often there as outside; the attack on the village wins less often (5 → 3
  in 20 battles; the owner accepted a harder village). The attacker's clearings start late (the assault comes 10–15
  minutes in), so few houses are actually cleared in a battle.

## Balance pass 4 (owner decisions 2026-11-19)

**The defence's hulls start on their posts.** In the mounted battles the defender's tanks and carriers used to start
behind the position and drive to their hull-down posts in the first seconds, across the attacking vehicles' view.
Now the scenario asks the defending computer commander, before the battle, where it would put them (it runs the
defence alone for a few simulated seconds, off screen), and they start there, already hull-down. At its first siting
the commander leaves a hull that starts on its post where it is unless that spot has become exposed. Building the
battle takes about half a second longer for this.

**Danger close for bursting rounds.** A vehicle's gunner sits more than a metre above the ground, and the check for
own men in his line took that for another floor: gunners never saw their own men on foot and their 30 mm shells hit
them. Now he does. Before each burst of high explosive (cannon shells, the grenade launcher's grenades) no own man may
be within the round's danger radius of the point aimed at, on any side, plus the round's spread there; the danger
radius comes from the round's fragments (about 8 m for a 30 mm shell, 15-18 m for a 40 mm or 30 mm grenade, 30-40 m
for a tank's shell). Own men past the point are also counted, out to 60 m or that radius: rounds that miss go on. A
gun fires over own men when the line from its muzzle passes well over their heads (1 m plus 3 mm per metre of
distance; never over men within 20 m of the muzzle or past the point). A crew passes over a target it could not fire
at and picks another, or holds and says so ("own men in the line", "danger close"); a fire order you give is held the
same way, and the card tells you why once. Without a laser rangefinder (the BMP-2) the spread is large at range
(about 70-100 m round a point 500-700 m off), so its high explosive stops once its own men are that close to the enemy.
In the mounted battles gunners now hit almost none of their own men (before: 11 and 22 men in ten battles).

**Returning fire.** A man who is fired on but sees nobody used to fire only at an enemy he could see, so a defence
whose attackers lay in smoke or far off could be shot to pieces without firing back. Now a halted man (not pinned,
not panicking, not down to his last magazine) at whom rounds cracked past in the last 10 s fires at the known place of
the nearest enemy who has fired in the last 10 s, if it lies within 30 degrees of where the rounds came from, is known
to within 30 m and is within his weapon's reach: one shot every 3 s, a machine-gun burst every 4 s. He stops 10 s after
the last round passes him, when the place is older than 20 s, or as soon as he sees an enemy (then he aims). It works
at night too (the muzzle flashes give the shooter away). Every side does this. Two men given the same spot no longer
hold each other's fire.

## The campaign: a battalion through linked battles (M12)

Open the game with `?campaign=1`. You command a **battalion** (Germany: a Panzergrenadier or Jäger battalion of about
340 men in 42 vehicles; Russia: a motor rifle battalion of about 300 men in 33; the test faction xf has a small one).
Its three companies, their platoons and squads, the mortar section, the grenade-launcher and missile teams and an
attached tank section are the same units the single battles use, built from the factions' data. Every man has a name,
a rank, skills, experience and a service history; every vehicle has its damage and its load.

**Operations.** A campaign is a row of operations. An operation is a line of three connected sectors (a village, a farm,
a wood, an industrial estate: each a generated map, the same map whenever that sector is fought again). Each sector
has a planned battle: attack, defend (the enemy attacks and you have a counter-attack reserve), meeting, ambush,
withdraw or pursue. The battle's result picks the next one from a table in `core/campaign.json`: a win moves on to the
next sector, a loss turns into the enemy's counter-attack or a withdrawal one sector back, a draw fights the same
sector again. Winning past the last sector is a success; two losses in a row (from the third battle on), or the
battalion falling below half its men able, is a failure; after five battles the operation ends anyway. Sometimes a
second company fights a flank battle beside the main one; that one is always resolved by the computer.
In **endless mode** battles keep coming, a new sector every two battles and a replenishment every three.

**Before a battle** the briefing shows the sector, who attacks, a rough estimate of the enemy and the units you may
commit: up to a company's worth (three platoons, the company headquarters and the support), which is what a phone can
run. The fittest company is proposed. You can play the battle yourself or let the computer fight it out ("auto-resolve");
both run the same simulation, so a played battle and an auto-resolved one count the same.

**The enemy** has its own battalion that remembers its losses. For each battle it commits platoons by the battle
type's ratio of your committed men (0.5 for an attack or a pursuit you make, 0.7 for an ambush, 1.0 for its own
attacks, meetings and your withdrawals), weighed by how good a man of each side is in a fight
(`factions/<id>/campaign.json` `fightingValue`: Germany 3, Russia and xf 1), but never more than a company's worth,
which is what a phone can run (a node with one and a half companies and a flank battle took 18 minutes to auto-resolve
on the phone proxy). That weight is a game value, measured from batches of operations played by the
computer on both sides. With the same faction on both sides an operation succeeds a bit more than half the time
(58 %). Between Germany and Russia it does not work yet: Germany won every operation and Russia none, even when
Germany sent only one Puma platoon, because in the battles themselves a Puma platoon beats a BMP-2 company; that needs
a balance pass on the mounted battle (DECISIONS M12.4 has the numbers). Germany's value of 3 is a placeholder until
that pass: it hides a gap inside the battles rather than measuring one, and it is not a statement about real armies.

**After a battle** the men come home as the battle left them: the dead are gone for good (their history is kept), the
evacuated wounded go to a recovery pool for the days the medical settlement gave them and come back to their old
squad when those are up (or wait unassigned if the squad has been filled), prisoners are held by the side that took
them. A vehicle that was towed away goes to the workshop for its days; a destroyed or captured one is lost. Fatigue,
shock and strain recover by the hour (12 hours between battles, 7 days between operations). Experience grows a little
with every battle (0.015) and more for every minute under effective fire (0.04 a minute; men are under it about half a
minute a battle; at most 0.05 a battle, never above 0.9), so a man who comes through a whole operation under fire ends
roughly 0.1-0.17 better. Wounded men's recovery days are the medical model's (usually two to six months), so an
evacuated man rarely comes back within the same operation; replacements fill his place meanwhile. When a leader falls, the next man by
role, rank and experience takes over automatically; you can appoint someone else on the man's card.

**Inside an operation nothing is refilled**: a magazine left with three rounds still has three in the next battle, a
carrier with 17 litres of fuel still has 17, and nobody new arrives. **Between operations** (in endless mode at each
replenishment) green replacements fill the empty places, everything is brought back to the standard load, and lost
vehicles are replaced. The books of every round and litre balance exactly: start plus deliveries minus what the
battles used minus what was lost with men and vehicles equals what the battalion holds.

**Saving** is free between battles: named slots, an automatic slot after every step, export to a file and import from
one. A save remembers the data it was made with and warns when that has changed; broken ids are repaired on loading.

**The map remembers.** Craters, holes blown in walls, wrecks and dug positions stay on a sector's map; when it is
fought again they are there (craters carried in are rough ground, wrecks block the way).

How we check it: `npm run campaign -- batch` plays whole operations with the computer on both sides and checks every
step (no battle with an empty side, the table followed, the enemy's roster as it was left, replenishments only where
they belong, nobody counted twice); `npm run e2e:campaign` drives the phone screens in a browser; `npm run phoneperf --
--campaign 2` times an auto-resolved battle on the phone proxy.

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
   (`packages/app/src/controls.ts`, which sends it through `orders.ts`) creates the order
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
