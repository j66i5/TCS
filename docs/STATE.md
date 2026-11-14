# State — handover note

_Last updated: 2026-11-14 (M7.5e review fixes: save/load house bursts, own clearing grenades, upstairs throws, vague houses, taken houses, leave rule; M7.5e AI uses buildings built — attacker targets partly met, for the owner to accept: steps defend, leave, clear and polish; before: photo map look, plan "photo": ground, vegetation, built, polish; before: Firefight-inspired UI review fixes: DPR-2 camera bug, LOS preview leaks, last-seen pins, unobserved ranging no longer registered, phone touch fixes; before: fire-support step: one Fire support button with an HE / smoke pop-up, ranging rounds before the battery's salvo; before: map-feel step: unit lines, last-seen pins, tile centre/follow, keyboard and help card, contour toggle; before: bar-card step: slim order bar, unit card, men and the man's box; before: controls step: drag to move, LOS preview, facing handle, mode lock; before: individual soldier AI, owner packages A–D; before: BMP-2 missile, dead-ground start, stress aboard; infantry attack balance pass; armour no longer backs out of every fight)._


**Wheeled ambulance hulls (2026-11-14, roadmap-detail slice 12 "M10.6-data", parallel session; DECISIONS "M10.6-data").**
Boxer ambulance (`de-boxer-san`, crew `boxer-san-besatzung`) and BMM (`ru-bmm`, crew `bmm-ekipazh`): the first
German and Russian wheeled vehicles, unarmed, with patient layouts (`ambulance` block) and a red cross
(appearance `markings`); xf `xf-litter-cart`. Component kind `wheels`. Drive lab rows for both (bands in the test).
No ambulance behaviour yet (slice 13 on the medical line). Screens: `npm run screenshot -- --scene ambulances`.

**M7.5e review fixes (2026-11-14, DECISIONS "M7.5e review fixes").** Fixed: a house burst lost after a load;
clearing grenades aimed too close to the thrower or his comrades (own men down 8 -> 4 per 20 platoon battles); no
grenade ever into an upstairs room; the commander sending squads to empty houses placed by far sounds (up to 490 m);
houses wrongly kept as "taken"; mortars called on a house being cleared; a cleared radio call with nobody inside;
the leave rule switched off by any order; "outflanked" from one enemy. ROADMAP no longer marks M7.5e complete (the
attacker's battle targets are not met). Balance: attacker wins village 3 -> 4 / 20, farmland 10 -> 11 / 20, mounted
7 -> 4 / 15.

**AI uses buildings, step "polish" — M7.5e built (2026-11-14, plan `docs/plans/m7.5e-ai-buildings.md`, step 4 of
4).** No sim or data change. New scenario `house-clear` (one German squad holds a house sited by the AI, two Russian
squads attack it with mortars, both AI; two squads, not the plan's one: one squad always broke off before the door)
and golden `house-clear-s1`; `npm run screenshot -- --scene buildings [--seed 3]` (app hooks `reveal`, `clearAt`);
HOW_IT_WORKS "The AI in houses", ARCHITECTURE 16l3. Balance (20 seeds x 1200 s, plan baseline dbdb479 -> now):
attacker wins village 5 -> 3, farmland 13 -> 10, mounted village 8 -> 8, mounted farmland 1 -> 1; defenders indoors
34 / 15 / 22 / 8 %, wounded inside 3-4 times less often than outside; clearings 1.3 per village battle, houses
cleared 0.65. Six owner questions in DECISIONS.md (player squads leaving on their own, a Clear button, which houses,
clearing earlier, caps, balance). Open: `house-clear` and `--scene buildings` not yet in CLAUDE.md's command list.
Next: owner answers on M7.5e; then the next milestone in ROADMAP.

**AI uses buildings, step "clear" (2026-11-14, plan `docs/plans/m7.5e-ai-buildings.md`, step 3 of 4).** `assault`
takes an optional `building`: sim drill "clear" (`systems/clear.ts`): bounds onto a door (covering fire at the enemy
in the house, else its windows), stack beside the door, a posted grenade into each room (`grenades.postErrorM`; aimed
at the far corner; from inside the doorway, then a step aside; none up the stairs), 3 men in after the burst, room by
room breadth first; `radio.clearing` / `radio.houseCleared`. The AI attacker clears the houses on its way in and near
the objective, and holds a taken house in the main ring (`COMMANDER.clear`, `Memory.clearing/taken/held`). Lab
`npm run lab -- house clear`: empty house 12/12 cleared, 100 % of grenades burst in the room being cleared. Not met:
clear.mts taken 2 -> 2 / 12 (the 300 m approach decides it), attacker indoors 0.7 % (target 5), grenades into houses
1.2 per village battle (target 4). Attacker wins 5 -> 3 / 20 village, 12 -> 10 farmland, 6 -> 7 / 15 mounted (not
re-tuned).

**AI uses buildings, step "leave" (2026-11-14, plan `docs/plans/m7.5e-ai-buildings.md`, step 2 of 4).** Men leave a
house on their own (sim `systems/house.ts`, every side, player squads too; `soldier.houseLeave`): a trap (2 enemy
bursts in or on it within 30 s, a mortar bomb counting 2: `detonate` marks `houseDanger`), an enemy seen inside
(a man with him in his own room within 4 m fights), or cut off (an enemy within 150 m more than 120 deg off another
enemy the unit knows); only well-located contacts count. The unit runs out (pinning does not hold it) to covered
spots 25-50 m away on the side away from the threats, `Unit.leftHouse` keeps its own rules out for 120 s, radio
`radio.houseLeft*`; the AI defence re-sites such a squad outdoors. Lab `npm run lab -- house leave`: out in time
90 / 81 / 91 % (trap / enemy / cut off), trap casualties 2.25 -> 0.25. Batches: indoors 36 -> 34 % (village), 27 ->
19 % (mounted); attacker wins 4 -> 5 / 20, 4 -> 6 / 15, 12 -> 12 / 20 (not re-tuned). Next steps: clear, polish.

**AI uses buildings, step "defend" (2026-11-14, plan `docs/plans/m7.5e-ai-buildings.md`, step 1 of 4).** The AI
defender now holds houses with a mixed spread: its siting takes window places (upper floors where they see as much
as the ground floor) beside outdoor spots, at most 60 % of a squad inside, 2+ outside, 2 per room, 4 per house, men
outside 8 m clear of an occupied house's walls, one man watching its back (`ai/src/siting.ts`); a window is a
one-man `occupy {building, windowIndex, mode}` (new optional order fields). Defender man-seconds indoors 0.5 -> 36 %
(village), 1.6 -> 27 % (mounted), 0.3 -> 16 % (farmland); upstairs 9 / 6 / 4 %; wounds per 100 man-minutes inside
9 vs outside 20 (village). Attacker wins 5 -> 4 / 20 (village), 7 -> 4 / 15 (mounted), 13 -> 12 / 20 (farmland),
not re-tuned. Not met: max within 10 m <= 5 on every seed (worst 6-7). Batch "buildings" block, `npm run lab --
house defend`. Next steps: leave, clear, polish. See DECISIONS.md.

**Defence fall-back (2026-11-14, overnight AI pick "defence-fallback").** An AI defending squad below half strength falls back only under a close threat (known enemy within 150 m, its objective contested, or enemies on two sides), each to a rally point of its own 80-150 m behind it, away from the enemy its men know, in cover and seeing its objective (`COMMANDER.fallback`); there each man takes a fire position (siting, 20 m); a squad holding there counts toward the counter-attack. Sim: a withdrawal of 3 able men or fewer goes back in one leg (`drills.withdrawTogetherMen`, player orders too). Rally in cover 23 -> 95 %, on the bearing away from the enemy 27 -> 98 %; casualties per man withdrawn 0.56 -> 0.41 (platoon-ru; target 0.28 not met); outcomes within noise. See DECISIONS.md.

**Defence siting (2026-11-14, overnight AI pick "defence-siting").** At its first look the AI defender sends each man to a fire position of his own within 40 m of his group's place (inside the objective's ring): the spot that sees most of the approach from prone, in cover, 3 m (preferably 5 m) from the next man, facing what he sees (`ai/src/siting.ts`). Per-man approach share x1.90 village / x1.59 farmland, men in the open 5.2 -> 0.4 / 13.2 -> 3.4, comrade within 3 m 6 -> 2 %. Village attacker wins 14 -> 6 / 20 (the attack was not re-tuned: main owner question), farmland 12 -> 12. Whole-defence share 0.40 in the village (target 0.6 unreachable inside the rings). See DECISIONS.md.

**Covering fire (2026-11-14, overnight AI pick "covering-fire").** The covering half of a drill now fires: each man takes an enemy within 60 m of the objective he can hit with no comrade in his line (else fires into the cover within 15 m of one at one shot per 4 s: drill and ordered fire only, `FireTask.suppress`), looks again every 2 s and dashes 2-6 m aside once a bound for a shot; runners end their rush out of the covering lines and go only once a covering man has fired (or after 10 s, `drills.coverWaitS`, owner question). Covering men firing during bounds 8 / 18.5 % -> 28 / 40 % (village / farmland); attacker wins 8 -> 14 and 10 -> 12 of 20; defenders pinned during bounds still only 7.5 / 10 % (target 15) and a comrade in the line 9.5 / 12.7 % (mostly the other squad in front). See DECISIONS.md.

**Assault tempo (2026-11-14, overnight AI pick "assault-tempo").** The AI's assault element walks to its closing point (sneaking the last 50 m, running only under fire) and rests there up to 60 s until its mean fatigue is below 0.35 (smoke called again as it arrives); the preparatory fires are called when two thirds of the squads are within the mortars' delay + 15 s of their places at a walk; a bound ends when the runners are down or one has trailed the others by `drills.stragglerS` 10 s (he finishes his rush); an all-pinned drill waits instead of re-phasing every 0.5 s. Fatigue at drill start 0.35/0.31 -> 0.09/0.14, HE-to-recon median 502/258 -> 155/115 s, outcomes within noise; median bound still ~15 s (bound length is the open owner question). `boundDoneShare` 2/3 was tried and left at 1 (it cost the attack lab). See DECISIONS.md.

**Movement under fire (2026-11-14, overnight AI pick "movement-under-fire").** React to contact now halts only the unit whose own men are fired on (new optional `Unit.ownFireTick`/`ownContactTick`), its move group (sub-units with no move of their own) and moving units of the platoon within `drills.reactNeighbourM` 25 m; a man on a walk or sneak leg who is suppressed (>= 0.1) runs the rest of his way until 10 s quiet (`Mover.hurryUntilTick`; player orders too); the AI runs its advance and HQ walks under fire. Halts with a man under fire 24-38 % -> 82-86 %, walking-into-fire man-seconds -> 0, outcomes within noise; the whole-unit hurry trigger is in data but off (it cost the mounted German attack). See DECISIONS.md.

**Fire discipline (2026-11-14, overnight AI pick "soldier-fire-discipline").** Men no longer shoot a comrade at their elbow (`friendInLine` muzzle fix) or in a burst's beaten zone (60 m past the point); halted men of a side within 1 m step apart (`stepAside` in decisions.ts) and move-order end points avoid other squads' places; a man raised above his fire position ducks between shots, before reloads, with no line or a comrade in his line, and rises in time for the next shot. Friendly bullet hits 97 -> 9 in 50 batch runs, raised-with-no-shot -72 %; outcomes within noise; supported attack lab 4/20 -> 1/20 (defenders duck too). See DECISIONS.md.

**App AI orders fix (2026-11-14, overnight AI pick "app-ai-orders").** The app sent the AI commander's orders through the player's `issue()` (marking them `player: true`), so AI hulls held moves against panic and close enemy men in the app but not in headless runs. Now `issue()` (gestures, `__tcs` hooks, via `ui` `playerOrder()`) and `issueAi()` (unchanged orders) are split; no sim or golden change.

**Photo map look (owner goal 2026-11-14: "more like Firefight, a low resolution shot of the real world, not so
blocky"; plan `photo`, four steps; DECISIONS.md "Photo map, step ...").** The map is now painted like a soft
low-resolution aerial photo, all original procedural art (`render/src/photo/`, pure; ASSETS.md): soft warped field
edges, furrows, crop rows, tree crowns lit from the west-north-west with soft shadows, hedges as crown rows, worn
roads and tracks, water with banks, bridges, walls with shadows, sun-lit hipped/gabled/flat roofs from a roof atlas.
Tiles paint in a worker (2/4/8 px/m by zoom; phones, i.e. no fine pointer, choose levels by CSS px, one worker,
smaller budget); the opening view's tiles paint before the whole-map strips; the flat picture shows until the photo
lands and is then freed. The
"polish" step added (photo only): contact shadows and dark rims on men, rimmed dots, hull shadows, scorch decals for
wrecks and craters, thicker label strokes, dark under-strokes on overlay lines, a symbols-zoom veil, close-zoom
grain, fainter contours (vector lines with a light north-west line since the review fixes). Default look is photo; `?look=flat|pixel|classic`, remembered in
`tcs.ui.look`. Rendering only: no sim, golden or catalog change. Screenshots `npm run screenshot -- --scene photo
[--map woodland]` and `--scene look` (photo/flat/classic triples). Open: the throttled phone-pan budget (p95 within
flat +10 %, no frame > 50 ms) is not met in the container (SwiftShader: every frame > 50 ms for both looks; photo
p95 200 ms vs flat 133-150 ms): needs a real phone; roads keep slight stair steps at some angles; roof atlas paints on
the main thread (62 ms in Node for the largest village); the owner's poll on the default look is still to be asked.

**Firefight-inspired controls (owner choices 2026-11-13, step "controls": S1, S2, S9, S10, S12; DECISIONS.md
"Controls step").** Drag from the selected unit and let go: the move goes at once with the current pace (Assault /
Withdraw likewise in their modes); tapping the map still plans a route with Go. The active move's marker (a white
ring with a dot) can be dragged to re-target the move, onto the unit to Halt. A halted unit has a round green
facing handle ahead of it: drag it to turn in place (the existing move with a facing, to where it stands). In
Fire / Anti-tank, a held press shows sight lines from each man (solid clear, broken from where blocked; terrain,
walls, roofs, woods and known hulls only), letting go fires, back onto the unit cancels; a quick tap still fires.
After a one-tap order the bar returns to Move; a double-tap on a mode button locks it on (bold frame, LOCK mark).
UI only: orders unchanged, goldens untouched. Screenshots `npm run screenshot -- --scene controls`.
Not done in that step: S3–S8, S11, S13, S14.

**Firefight-inspired bar and card (owner choices 2026-11-13, step "bar-card": S3, S4, S6; DECISIONS.md "Bar-card
step").** The order bar is Move, Fire, Halt, Mount/Dismount as icon + short label; the arrows beside Move and Fire
open trays (Assault, Withdraw, Occupy, posture; Anti-tank, Grenade, All grenades, Mortar, Smoke, vehicle gun and
smoke screen, Cease fire); the group's button shows the variant that is on. A move dragged onto a house offers an
Occupy button there. The selected unit's card (bottom left): pace row (Run/Walk/Sneak/Crawl; a vehicle's paces;
pressed while moving re-sends the move at that pace) and fire row (At will/Return/Hold/Ambush = fire at will with the
existing 100 m "no fire beyond" rule); Rules button for the rest. "Men" switches to the detailed card, one row per man
(state mark, role, weapon, ammunition cells); his row or a tap on him on the map opens his box (rank, name, weapon,
rounds, activity, pulse, fatigue, suppression, stress, morale, wounds). UI only (`ui/src/card.ts`, `icons.ts`),
goldens untouched. Screenshots `npm run screenshot -- --scene card`.
Not done in that step: S5, S7, S8, S11, S13, S14 (all but S11 done in the map-feel step).

**Firefight-inspired map feel (owner choices 2026-11-13, step "map-feel": S5, S7, S8, S13, S14; DECISIONS.md
"Map-feel step").** One faint line per own unit on the move to its destination (the selected unit's bright along
its route; mortar missions amber from the caller to the target; thinned at the symbol zoom). Lost contacts become
hollow "last seen" pins with their age, kept until seen again or the spot is seen empty (UI only, `LastSeenBook`).
A tile tap selects and centres; a held tile follows the unit (badge; a pan stops it). Keyboard: Space, 1-4, WASD /
arrows, Esc (never quits), Tab, F, M/T/H/B/G, Enter, Backspace, C, ? (help card with every key and gesture); the
right mouse button moves the selected unit. A Contours top-bar button shows height lines at every zoom (fine pink
tiles close up). UI only: orders unchanged, goldens untouched. Screenshots `npm run screenshot -- --scene mapfeel`.
S11 (mortar ranging shots) followed in the fire-support step.

**Firefight-inspired fire support (owner choice S11 with ranging shots, 2026-11-13; DECISIONS.md "Fire-support
step").** Fire's tray has one **Fire support** button; hold (or tap) a point, a pop-up offers HE or Smoke with the
rounds left and sends the existing `callFire`. SIM CHANGE: a mission fires 2 ranging rounds first, off the point by
the battery's aiming error (DE 40 m, RU 50 m per axis), corrected to 30 % each time the caller or a man of his
platoon sees the fall; then the battery's volleys (DE 4, RU 6 tubes); ranging rounds come from the battery's
container on top of the rounds asked; a point already ranged on (100 m) skips ranging. New event
`support.ranging`, radio keys, data fields in `fireSupport` (low). The mission line shows the falls walking in and
a second ring for effect. Batches (10 × 900 s): attacker wins unchanged except RU on foot 3 → 4/10; the attackers'
mortars hurt about 25–35 % fewer men. Goldens regenerated (fingerprint; non-mortar goldens' states identical).
Screenshots `npm run screenshot -- --scene firesupport`. With this step all 14 Firefight choices are built.

**Firefight UI review fixes (DECISIONS.md "Review fixes for the Firefight-style UI").** The camera used half the
screen size on every high-DPI screen (Pixi 8's `renderer.width` is already CSS px): centring, the follow camera and
the zoom clamp were off on nearly every phone since M0 — fixed. The LOS preview no longer shows hulls the side has
not seen (any number of unknown hulls looked through; heard-only vehicles count as unknown); a last-seen pin is
watched 5 s from the loss, not from the first sighting; unseen ranging falls are not drawn; a point ranged on with
no round seen is no longer remembered (sim change, goldens regenerated). Touch: a quick swipe in Fire / Fire support
pans instead of firing; two fingers moving together (and held pan keys) stop the follow camera. Keys: T T no longer
locks Fire; Backspace past the last point closes the plan. Turning in place keeps the squad's shape and the handle
stays at the new facing while the order is on its way. Screen: the start hint is one line everywhere and goes when
a unit is picked; time and mortar rounds ("HE 24 · smoke 12") lead the score line; duplicate callsigns read
"1/Puma 2" / "2/Puma 2"; the centring keeps the unit clear of the card; narrow cards keep their chip labels; dark
close-up contours; darker-edged sight lines and selection rings; umlauts in German role names; help card shows only
touch or mouse rows and fades where it scrolls; the unit list fades where it scrolls. Not done (left open): vehicle
gun/ammo on the card, the pixel look's casualty readability, the drag-ghost pile-up, a release-time "no line of
fire" warning, the phone's expanded list overlapping the card. Screenshots `npm run screenshot -- --scene review`
(device pixel ratio 2).

**Individual soldier AI (owner 2026-11-13, all four packages chosen; DECISIONS.md "Individual soldier AI").**
**A "Shoot straight" ✅:** men aim at the middle of what they see (posture on the contact; prone 0.2 m), know who
is down, keep the last magazine for close defence, slow their own long-range rifle fire, keep their target.
Open for the owner: the Russian attack on foot at 2400 s wins 3/10 instead of 6/10 (casualties unchanged).
**B "Use the ground" ✅:** pinned/panicked men in the enemy's sight crawl to cover within 8 m, men keep about 5 m
apart (cover, halt drill, last rush, rally), men out in the open move out of a mortar mission's beaten zone (or
into a house). Owner 2026-11-13: a man pinned or panicked **in the open** also crawls (within 8 m, else 15 m) to
cover from where the rounds cracking past him come from, even from a shooter he does not know (crawls 78 → 108 in
six battles; modest: open fields offer nothing within 15 m).
**C "Stay in the fight" ✅:** men go back to their fire position's posture after a scare (window places again),
rise to their knees to look when blind lying down, face the enemy (one per team watches the rear in a fight), a
squad entering a house finishes going in under fire, anti-tank men move for a shot at a vehicle they only heard.
**D "Close combat" ✅:** men throw hand grenades on their own at enemies behind cover or in a room (rising for the
throw); the AI's grenade orders now produce thrown grenades (bug: prone throwers, throws broken off by the next
rush); assault fire on the move in the last 50 m with a heavy aiming penalty.
**Decisions for the owner (soldier AI):** see the list at the end of DECISIONS.md "Individual soldier AI".

## Current milestone
**M7.5 Look and interface** (plan `docs/plans/m7.5-look.md`), built unattended at the owner's request; the plan's
§7 design questions and the slice's own choices were decided with the recommended options **for the owner's
morning review** (DECISIONS.md "M7.5 design questions decided without the owner" and "M7.5a UI shell").
**M7.5a UI shell ✅:** the battle opens with nothing selected and the order bar greyed; the bar offers only what the
selected unit can do now (`unitCapabilities` → `ordersFor`); it docks to any edge by dragging its grip (remembered
per device), one row on a phone with rare buttons behind "⋯"; a unit sidebar of tiles (symbol, callsign, men fit,
state colour) selects units and opens into a detailed list (always open ≥ 1000 px); labels are placed without
overlaps (`render/src/labels.ts`), a squad beside its vehicle shares its label; zoomed out, vehicles are symbols
(stacked when close) and infantry symbols show only men on foot; appearance data (`appearance.json`, outside the
catalog) gives vehicle paint now and uniforms/palette for M7.5b. Presentation only: goldens untouched.
Screenshots: `npm run screenshot -- --scene ui`.
**M7.5b Look ✅:** zoom levels (`render/src/lod.ts`: symbols < 1.2 px/m, dots, pixel figures from 8 (5 before the owner's review), close from
16 with every roof lifted; 10 % hysteresis); the battle opens at 8 px/m on the lead squad; the camera never zooms
out past the whole map; ORIGINAL 16 × 16 pixel soldiers (11 frames, weapon variants, firing flash, launcher on the
back, wounded, down, dead, surrendered, captive; 16 pre-rotated facings; faction palette swap; blue/red outline);
the flat pixel map (flat palette, wobbled cell edges, seams, pixel tree crowns, rasterised roads/water/hedges,
contours only zoomed out, close detail tiles); buildings as floors under the men and roofs above them that fade
near own men or close up; one-row top bar with "⋯" and a compact status line (parent review). Old look behind
`?look=classic`. Presentation only: goldens untouched. Screenshots `npm run screenshot -- --scene look`.
Decisions for the morning review: DECISIONS.md "M7.5b Look".
**M7.5c Interiors ✅:** map format 2 — every building has rooms, inner walls with open doorways, stairs and upper
windows on every floor (`scenario/src/mapgen/interiors.ts`, generated last on stream `mapgen/interiors`; a map
without interiors is format 1 exactly as before, `stripInteriors`); inner walls and the floors between storeys
block sight, stop or slow bullets, shield blasts and can be breached; the outdoor nav grid is unchanged and a small
graph per building joins it at the doors (`sim/src/interior-nav.ts`, `routeBetween` for every man's route): a move
tapped inside a house takes the squad in by the doors to places by the windows of that room (and the next), out
again to its formation; indoors men do not run out to seek cover; backblast by room. Floors drawn with inner
walls, doorways and stairs when the roof fades; Debug draws the interior graphs. **Equivalence proof:** the pre-c
goldens are kept in `packages/tools/golden/no-interiors/` and replay bit for bit with interiors off; goldens
regenerated once (DECISIONS.md "M7.5c Interiors", with the on/off batch comparison). Screenshots
`npm run screenshot -- --scene interiors`.
**M7.5d Upper floors ✅ (M7.5 complete):** men climb the stairs (`Waypoint.z`, `t.z` = height above the ground;
stairs at half pace) to any floor; `standZ` for every soldier height (eyes, muzzles, targets, launcher, grenades,
blast, surrender, cover; architecture test with `// ground: ok`); a squad ordered into a house spreads about one
man per 4.5 m² over the rooms, then the floors (fix from the M7.5c screenshots); the move goes to the floor on
screen; new order **Occupy** `{building, floor?, facing?}` with an Occupy button (tap a house): window places on
every floor facing the nearest known enemy first; men fire from upper windows. Floor switch G, 1, 2 … (follows the
selected unit), upper-floor plans drawn, men on other floors faint with a floor badge, men at true size close in.
New scenario/golden `village-occupy-s1`; existing goldens unchanged. Decisions: DECISIONS.md "M7.5d Upper floors".
Screenshots `npm run screenshot -- --scene floors`.
**Owner's morning review (2026-11-13) applied** (DECISIONS.md "Owner answers to the morning review"): everything
decided without him in M7.2–M7.4b and M7.5 confirmed except three changes — soldier figures are now **always at
true scale** (no minimum figure size; figures from 8 px/m, dots below), **more distinct uniform tones** (German
greener flecktarn, Russian more khaki-brown; outline unchanged), and men take ammunition **only from their own
side's** abandoned vehicles. Goldens unchanged. `?look=classic` is deleted after M8.
**Russian mounted attack investigated (2026-11-13), nothing changed** (`docs/research/ru-mounted-attack.md`): the
BMP-2s start ~800 m from the Pumas in their sight, cannot hurt their fronts and have no ATGM; two thirds of the hull
losses come in the first two minutes, one cook-off can break a mounted platoon (casualty stress reaches the men in
the next carriers), and ~90 % of Russian losses fall more than 300 m out. Eight AI/doctrine variants (smoke, cover to
cover, dispersal, tempo, flank RPG hunters, casualty tolerance) all stayed at 0/10 and most cost more men.
**Owner decisions applied (2026-11-13; DECISIONS.md "BMP-2 missile, dead-ground start, stress aboard"):** the
BMP-2 has its **9M113M Konkurs-M** (9P135M launcher, 1 + 3 counted missiles, wire-guided SACLOS model in
`sim/systems/missiles.ts`: lost when the gunner loses sight — terrain, woods, smoke — is hit or his hull struck;
reload 40 s halted; the crew prefers it at vehicles beyond 1000 m or when 30 mm cannot get through; "Anti-tank" on a
BMP-2; `npm run lab -- missile`); the mounted attacker **starts in dead ground** chosen from the defenders' sight
lines (`buildScenario`, `deadGroundStart`); men aboard feel **only their own vehicle** (casualties inside it, hits on
it). Batches: the Russian mounted attack still 0/10 (seeds 1–10 and 11–20), fewer early BMP-2 losses, Pumas now lost
0.4–0.5 per battle; the German mounted attack fell from 3–4/10 to 1/10; infantry battles unchanged. The pre-interiors
goldens are skipped while the data differ (owner: keep or delete). Screenshots: `npm run screenshot -- --scene missile`.
**Infantry attack on foot: balance pass (2026-11-13)** (`docs/research/inf-assault.md`, DECISIONS.md): the AI's
foot attack keeps its way in out of the second objective's fire (axis turned, that garrison blinded with smoke),
chooses support places with a field of fire 330 m out and moves on to them after going to ground, calls its fires to
land as it arrives, fires man by man at full rate (lifting near its own men), runs its assault element in under smoke
on a flank and uses its grenade launchers; drill runners pinned on the way no longer hold the next rush; no man fires
through any platoon of his own side. Attack wins: 900 s 1-3 in 20 (was 0), 2400 s DE 4/10, RU 6/10 (was 0 and 1).
Goldens unchanged. Owner decisions in the note (balance length, 15 m rushes, hand smoke grenades).
**Next:** owner decisions from both notes (balance length, 15 m rushes, hand smoke grenades, missile values, pre-interiors goldens); then M7.5e "AI uses buildings".

Before M7.5 (M7 summary):
**M7 Vehicles is done** (plan `docs/plans/m7-vehicles.md`; M7.1a–c, M7.2, M7.3, M7.4a, **M7.4b**) —
vehicles drive on routed paths (clearance grids, flattening fences and hedges, going round walls), yield to each
other, make their own men step aside and run over enemies (owner Q4), stop rounds and block sight; they are drawn
at true size and can be ordered (move, halt, reverse legs). **M7.2:** squads get in and out (Mount / Dismount
orders and buttons, one man per door at a time, the vehicle waiting; two men carry a wounded comrade in from near
the ramp; an order to a squad aboard is carried out after it gets out; men refill magazines from a stopped
vehicle; a crewman takes over a fallen driver's seat); the platoon battle can start mounted with **`&vehicles=1`**
(tools: `platoon-vehicles`, `platoon-ru-vehicles`): the attacker rides in from its edge and the AI gets its
squads out 300 m (German) / 400 m (Russian) short of the objectives, out of sight where it can, at once when a
vehicle is hit, and gets them back in when it withdraws. The default battle stays on foot until M7.4a (owner
Q26). **M7.3:** turrets lay and fire the 30 mm cannon (AP/HE) and the coaxial machine gun with counted ready
belts, refilled from stowage when halted (owner Q17: both vehicles, ~90 s); crews pick targets under their own
fire rules (a cease-fire to a squad does not silence its IFV); 30 mm HE bursts on a man it strikes (Q18); fire
orders with a choice of round, smoke dischargers; crews observe through seat sights, vehicles are spotted by
their visible area, heard by their engines (rain, wind), shown under fog as hull outlines with their type within
1.5 km (Q6); thermal sights see through ordinary smoke at half strength (Q7); after the dismount the AI's Pumas
overwatch and its BMP-2s follow 150 m behind, both supporting the assault by fire; AAR and batch count
ammunition by source; gunnery lab (`npm run lab -- gunnery`). **M7.4a:** armour plates per part and face
(Puma front stops 30 mm and — owner Q21 b — a single PG-7VL; BMP-2 stops rifle AP at the sides, nothing heavier),
penetration (kinetic by speed, shaped charges by jet, impact HE holes thin roofs and breaks tracks), damage inside
along the path plus a fragment cone (Q11: men wounded, engine/tracks/gun/ammunition/fuel damaged), immobilised /
disarmed / burning / destroyed (cook-off, burnt out) / abandoned; the crew fights on immobilised while hits bounce
off and bails out with its passengers when penetrated again or burning (Q14/Q15); wrecks known to both sides (Q8),
in the nav grids and the result; points 20 / 10 (Q9); Panzerfaust 3 and RPG-7 fired on order (the "Anti-tank"
button) or on their own per the unit's anti-tank rule (Q19, Rules panel; default "vehicles only"), not from a small
unbreached room, with a wall right behind or a comrade in the danger zone (Q20); rocket flight with motor and
self-destruct; armour and anti-tank labs (`npm run lab -- armour|antitank`). **The platoon battle now starts mounted
by default** (Q26; `&vehicles=0` for the battle on foot; tools `platoon`/`platoon-ru` stay infantry).
**M7.4b:** the full component table (transmission, turret drive, stabiliser, coax, sights, radio, dischargers,
extinguisher — each with its effect), extinguishers with counted charges, crews that reverse out behind smoke when
penetrated or struck by a rocket, crews that bailed out become foot units you can order, men take ammunition from
their own side's abandoned hulls (owner, 2026-11-13; never the enemy's), the AI gives anti-tank tasks (shots at known vehicles in range, a step aside out of
the danger zone, two hunters after halted vehicles), gets out at once on an anti-tank threat and reverses out on
withdrawal; active protection and add-on tiles on the fixture; wrecks and vehicle records round-trip.
M7 deferred items: DECISIONS.md (M7.1c part 3,
M7.2 parts 1–3, M7.3, M7.4a, M7.4b).

## What works
- **M0 foundations** (see ARCHITECTURE.md): deterministic 60 Hz simulation, seeded RNG streams, serialisable
  state + hash, orders through a comms model with delay, event stream, counted items and transfer,
  interruptible actions, wound/physiology interfaces, battle-as-a-function, save games with controller memory,
  data packs with validating loader and linter, fixture faction, headless/batch/golden/screenshot tools, CI.
- **M1.1 terrain**:
  - Terrain data in `packages/data/core/terrain/` (materials, surfaces, vegetation, obstacle kinds, building
    kinds) with movement costs per class (foot/wheeled/tracked), concealment, bullet stopping, colours.
  - Map model: heightfield, surface and vegetation grids (4 m cells), walls/hedges/fences/embankments,
    buildings (material, thickness, storeys, doors, windows), roads, streams, ponds. Map file format with exact
    round trip; map fingerprint checked when a save is loaded; terrain damage stored in battle state.
  - Generator for four kinds: **village** (street or clustered, chosen by seed), **woodland edge**,
    **farmland**, **industrial**; 2 × 2 km default; 50–150 ms per map; all generated maps pass validity checks.
  - Naturalistic renderer: blended ground colours, tree crowns, orchards, hill shading, contour lines, roads,
    hedges, walls, fences, buildings with roofs and shadows.
  - App: `?map=village|woodland|farmland|industrial|flat&seed=N`, a map button that cycles kinds, start view
    centred on your team.
- **M1.2 navigation**: 2 m navigation grid from the terrain; routes go round houses, through gates (or over
  walls when that is quicker), along roads, around ponds; slower in woods and ploughed fields; "no route"
  reported by radio; debug view shows the grid (red blocked, orange walls, yellow slow) and routes. Long route
  on a 2 km map ~30 ms; unreachable goals rejected at once; benchmark ~42–51× real time. Independent review found 6 navigation defects (one put followers inside houses); all fixed with tests.
- **M1.3 body**: postures (standing/crouching/prone) that take time to change, slower with load; speed from
  pace, posture, slope (Tobler), load, fatigue and ground; fatigue and heart rate rise with effort, load, uphill
  and heat and recover at rest; movement lab (`npm run lab -- movement`) with checked bands; posture and 4-pace
  buttons; debug labels show fatigue and heart rate. (Loads are itemised since M2.5.)
- **M1.4 formations**: wedge/file/line from data; ~10 m spacing; routes prefer cover (balanced); followers keep
  their slot; at the halt each man takes the best cover within 15 m, goes prone and faces outward; formation
  button; zoomed far out, units show as infantry symbols. Cover effect is modest on open farmland (see
  DECISIONS.md).
- **M2.1 projectile engine**: bullets as real objects (typed arrays) with drag fitted to published velocity
  tables, gravity, air density from temperature; hits on ground, walls, hedges, house walls (doors and windows
  open), chance of being stopped in vegetation; penetration and ricochet per material from published norms;
  impact events; tracers drawn clearly, other bullets very faintly, impact puffs. Cover lab
  (`npm run lab -- cover`) reproduces the public figures for 5.56 and 5.45 mm (7.62 mm has no measured anchor). G36 + DM11/DM21 and AK-74M + 7N10/7T3 in the data.
  20,000 live bullets + 304 soldiers: about 5.5× real time here since bodies and roofs are tested (floor 3×, target 8×; see DECISIONS.md).
- Research files: `docs/research/ballistics.md` (used) and `docs/research/squads.md` (for the owner's review).
- **M2.2 the shooter**: soldiers carry a rifle and magazines (G36 x5, AK-74 x6); `fire` and `ceaseFire` orders;
  rounds counted out of magazines, reloads and stoppages as timed actions, empties kept, last magazine held
  back, top-up in lulls; rate of fire by range; aiming error from skill, posture, fatigue, pulse, sight and
  rate of fire; the unit slows and ceases fire by itself when nothing comes back; muzzle flashes; "tap: fire"
  and "cease fire" buttons. Firing range lab (`npm run lab -- range`): regular, prone, 300 m: G36 60 %,
  AK-74M 49 %.
- **M2.3 body, armour and wounds**: bullets strike bodies (zones by posture: legs, pelvis, abdomen, chest, arms,
  neck, head); helmet and vest are items with coverage and protection; a plate hit knocks the man down and
  bruises him; other hits make wound records (severity, bleeding, breathing/airway); a simple physiology runs the
  bleeding clock; the wounded carry on impaired (slower, crawl only, worse aim, cannot use the rifle); the
  unconscious and the dead stay on the map with their own symbols; the next man takes over a fallen leader and
  "man down" is reported; friendly fire is real. Casualty lab (`npm run lab -- casualty`): at 100 m from the
  front, plates save about half the men struck; of the wounded about 1 in 7 dies at once, 4 in 10 within the
  hour without care.
- **M2.4 grenades and fragments**: hand grenades (DM51, RGD-5) thrown as a timed action, 40 mm rounds from
  under-barrel launchers (AG36, GP-25); time and impact fuses, arming distance, duds; bursts with blast by
  distance (wound close in, stun to about 10 m, walls shield), thousands of fragments as real projectiles,
  craters, holes blown in thin walls (bullets and routes then pass); roofs stop or are pierced; a "tap: grenade"
  button; fragmentation lab (`npm run lab -- fragmentation`).
- **M2.4b (owner requests)**: grenades bounce and roll; the thrower picks a flat, lobbed or high throw that is
  clear (works indoors and through openings); small folds in the ground stop low fragments, so lying down
  protects more; an order can ask for several grenades, thrown a moment apart ("tap: all grenades"); men near a
  landing grenade drop flat, or run from it if it is within 3 m.
- **M2.5 squads and kit**: the demo and the app start with a German Puma dismount squad (G36, MG5, G28,
  Panzerfaust 3 carried, AG36) and a Russian BMP motor-rifle squad (AK-74M, PKP, RPG-7 carried, two GP-25), six
  men each, with itemised loads of 24-44 kg; machine guns fire five-round bursts from belts with a tracer every
  fifth round; the marksman rifle has a telescopic sight.
- **Scripted shoot-out** (`npm run headless -- --scenario shootout`): the two squads 250 m apart fire at each
  other under a fixed script; it is a golden replay and a test (about 1,000 rounds, both grenades, casualties).
- **M2 completion**: aiming time (first shots hurried) and bracing on cover in the aiming error; bullets go
  through a body, slowed, and can hit the man behind; G95A1 and AK-12 as data (not issued by default); cover
  rows in the fragmentation lab.
- **M3.1 line of sight**: sight lines over hills, walls (openings let sight through), see-through fences and
  hedges, roofs and vegetation (`npm run lab -- sight`); men no longer fire into a bank in front of them —
  they kneel or stand to fire over it, or hold fire and report "no line of fire"; Debug shows what the
  selected unit's leader can see.
- **M3.2 detection**: every man scans for enemies once a second; the chance depends on range, posture,
  movement, firing, what is in the way, where he looks, his optic and skill (`npm run lab -- spotting`:
  standing still at 300 m spotted in a median 9 s; lying still in crops at 100 m never in 40 runs; crawling
  there 9 s; firing 1 s). Debug draws who sees whom.
- **M3.3 contacts**: each man remembers what he has seen, heard (direction and a rough distance of shots) or
  been told of each enemy; he passes it on by voice nearby and by radio with a delay; the unit calls contacts
  out on the radio log; a fire order can name an enemy, and each man aims where he believes him to be.
- **M3.4 fog of war**: you see the enemy only as your men know him — solid diamonds where he is in sight,
  hollow ones where he was last seen or reported, rings for the sound of shots; old contacts fade; Debug shows
  everything. Tapping an enemy marker in fire mode fires at that contact.
- **M4.1 suppression and morale**: enemy rounds cracking past or striking near a man suppress him (bursts a lot);
  pinned men drop flat, stop and fire less (yellow ring), stress from fire, fallen comrades, a fallen leader and
  wounds, damped by experience and a leader nearby; shaken men fire less, panicked men lie flat and do not fire
  (red ring); suppression lab (`npm run lab -- suppression`).
- **M4.2 soldier decisions**: fire rules per unit (free / return / hold; `rules` order), men open fire on their
  own at enemies they see, run to cover from the known threat when under fire, hand over magazines and belts;
  Debug shows each man's decision as a line.
- **M4.3 squad drills**: units halt and go down on contact; `assault` and `withdraw` orders bound by halves
  with covering fire; a unit breaks when half its men panic, runs back and rallies.
- **M4.4 doctrine and attack lab**: drill values from faction doctrine; `npm run lab -- attack` shows an
  unsupported squad attack across the open failing every time, a supported one succeeding about 40 %.
- **M5.1/M5.2 orders and interface**: drag the formation marker (shape, facing arrow, width handle), routes
  with pace per leg, order bar with assault / withdraw / fire / grenades / halt / cease fire / posture, rules
  panel (fire, range limit, on contact, ammunition) with the unit's state; pause with orders; phone layout.
- **M6 first playable**: objectives and victory (held at the end minus losses; early loss when a side breaks or
  is wiped out), platoon templates, scenario format and generator (`buildScenario`), AI commander for defence
  and attack, app battle with side/attacker choice, save/load, after-action review (casualties, timeline, heat
  map), AI-versus-AI batches (`npm run batch -- --scenario platoon` / `platoon-ru`): the defender wins 20 of 20
  each way.
- **M7.2 passengers**: mount/dismount orders with exit queues and the hull holding; orders to a squad aboard
  (out first, owner Q12); casualty loading within 5 m of the ramp (Q25); `radio.noSeats`; seat swap after 20 s;
  refill from the vehicle's stowage (`transferItems`); intercom; surrender gated aboard; platoon templates with
  crews and `carriage` (four Pumas with the HQ in the fourth, Q1; three BMP-2s with the commander in the first,
  Q2); mounted start behind `&vehicles=1`; AI ride, dismount (doctrine distances, Q22), re-mount on withdrawal
  within 100 m (Q24), dismount near an objective it holds; mount lab (`npm run lab -- mount`); "+n" aboard by
  each hull, a second tap on a hull selects the squad riding in it.
- **M7.3 guns and senses**: `systems/gunnery.ts` (turret lay, station fire, target choice with `why` keys,
  refill, smoke), crew seat sensors and vehicle targets in spotting, vehicle contacts and engine hearing,
  `fire`(+`nature`)/`discharge` orders and `not-applicable`, expenditure tally, vehicle debug overlay, Gun/Smoke
  buttons; scenario `bench-combined`; `sight()` and the path search made faster (identical results).
- **M7.4a armour and anti-tank**: `systems/armour.ts` (plates, penetration, inside, outcome, bail-out, wrecks),
  `systems/launcher.ts` (Panzerfaust/RPG, `atRule`, back-blast), `flight.ts` (shared rocket flight), vehicle points,
  AAR vehicle lines and anti-tank expenditure, Rules panel "Anti-tank weapons", "Anti-tank" order button; mounted
  platoon battle by default. Batch (10 × 900 s): Germany attacks mounted red 7/10 (BMP-2s lost 2.4 of 3), Russia
  attacks mounted blue 10/10; infantry battles unchanged.
- **M7.4b components and reactions**: `crewReactionSystem`, extinguisher (`tryExtinguish`), `compCondition`,
  `weaponOut`, radio comms rule, `Unit.exVehicle`, cross-loading, APS/tiles (fixture `xf-wagon`), AI anti-tank tasks,
  batch crew columns, vehicle panel parts, `--scene vehicles` anti-tank screenshots. Batch (10 × 900 s): Germany
  attacks mounted red 6/10, anti-tank rounds 1.5 / 1.7 per battle (was 0.2 / 0); Russia attacks blue 10/10, 0.9 / 2.1
  (was 0 / 0.9); infantry unchanged. Schema 17.
  Owner change 2026-11-13 ("make armour not back out of every fight"): reverse out only when penetrated, disarmed,
  commander panicked, or an enemy man within 50 m none of its guns can fire at; 15 s hold, then back to where it
  stood unless the reason was damage; a player's move/halt order (`Order.player`) holds against the non-damage
  triggers (DECISIONS.md "Armour no longer backs out of every fight").
- **M6.5 attack balance**: two platoons attack one; AI sneaks up, splits fire and assault, throws grenades,
  calls mortars; Mortar and Smoke orders for the player (rounds land after 75-90 s; smoke blocks sight).
- Tests: 559 (550 + 9 timing), all green (incl. 48 generated maps checked for validity and plausibility, map determinism, map
  file round trip, terrain damage save/load). 160 of 160 maps (40 seeds × 4 kinds) pass the strict validity
  check after the independent review's fixes. Benchmark (304 men moving, out of view) about 18× real time; 304 men in view of each other, all firing, about 14×.

## What is weak or missing (honest list)
- **Wound values are untested guesses** (all `confidence: "low"`) until the owner has reviewed the casualty lab
  table. No first aid: a bleeding man is never treated (M10). Target movement is not in the aiming error yet
  (needs targets: M3/M4).
  Nobody reacts to being shot at or to casualties (M4); the only reaction is to a grenade landing nearby.
- **Grenade data is unverified**: the search tool declined most look-ups, so DM51, RGD-5, VOG-25 and the
  launchers are from memory of published figures (`confidence: "low"`). **Speed with fragments is at the
  limit**: nine grenades bursting in the same instant cost a stutter of about two frames (see DECISIONS.md). The AI never throws; grenades are not thrown back; a man running from a grenade runs in a straight line.
- Soldiers only fire where ordered; the enemy team never shoots (choosing targets is M4).
- The phone top bar wraps onto three rows (interface work is M5).
- Research values come from search extracts, not from reading the pages; confidence medium at best.
- The 8× speed target with 20,000 projectiles is not demonstrated on this machine (about 5.5×).
- Soldiers route around houses, but **houses are solid** (no entering through doors yet). Stress does not yet raise heart rate (M4).
- Anti-tank fire is still modest (about 1–2 rockets per side per 15-minute battle): the BMP-2s die early to the
  Pumas' cannon, and RPGs mostly meet the Puma's front, which stops them (owner Q21 b). Belts carried by other men
  cannot be handed over (M4);
  kit masses (water, webbing, ...) are typical values, not sourced.
- Routes prefer roads only mildly (asphalt is 10 % quicker than grass) and cover only modestly (balanced
  preference; see DECISIONS.md, M1.4) — the owner may choose to strengthen it.
- **Industrial maps are the plainest**: sparse business-park lots with a few sheds and warehouses each.
- Wood edges and scrub still show a faint 4 m grid pattern when zoomed in close.
- The map kinds' recipes are code (they name terrain IDs); terrain *properties* are data. See DECISIONS.md.
- The two squads are research defaults awaiting the owner's corrections; ranks per position are guesses;
  doctrine values are still placeholders (low confidence).

## Live build
https://j66i5.github.io/TCS/ — deployed automatically from `main` after every merge (first successful deploy
2026-11-11, after the owner enabled GitHub Pages with source "GitHub Actions").

## Answered by the owner (2026-11-11)
- First squads: German **Panzergrenadier dismounts of a Puma**; Russian **motor-rifle squad on a BMP**.
- Callsigns: German **"Gruppe {n}"** (squad) and **"Trupp {n}"** (team); Russian "Gruppa {n}" kept for now.
- Map look **naturalistic**; villages **mixed street/clustered**; default map **2 × 2 km**.

- M1.3: posture change time **depends on load**; fatigue **winded after 2–3 min running**, ~5 min to recover;
  **load slows and tires men from now**.

- M2 planning: owner **dictates the squad tables**; **G36** and **AK-74M** default rifles; **helmet + plates**;
  **realistic bleeding clock**; **realistic lethality mix**; **tracers clear, other bullets very faint**;
  cover preference stays **balanced**.

- M2.3: **helmets stop fragments, not rifle rounds**; a round stopped by a plate **knocks down and bruises**; a
  wounded man who still can **carries on, impaired**.

- M2.3 review: lethality **about right**; wounded who keep fighting **fine for now**.
- M2.4: Russian default hand grenade **RGD-5**; throw **about 30 m standing**; a close burst that does not wound
  **stuns briefly** (blast injury within a few metres). Fragmentation lab reviewed: **about right**.
- M2.4b: fix all four weak points; a man near a landing grenade **drops flat, or runs if it is very close**.
- M2.5 squads: **research defaults** for both sides (see DECISIONS.md), to be corrected by the owner afterwards.

- Prone throw **15 m**, grenade safety distance **8 m**.

## Next
**Infantry assault pass** (owner question 4 of `docs/research/ru-mounted-attack.md`): every attack on foot loses,
and mounted attacks too after the 2026-11-13 decisions (Russian 0/10, German 1/10). Then **M7.5e** — the AI uses
buildings.

## Reminders for the owner
- (Answered at the M6 review, 2026-11-12: fog of war stays "what your men have reported"; medical after vehicles.)

## Open questions for the owner

- M10.6-data (low confidence, for review): Boxer ambulance and BMM armour, components, gear bands, reverse speeds,
  steering, ramp and loading times, extinguishers, signatures; the medic's rank and load.
- **New data (2026-11-13), for review:** the 9M113M Konkurs-M and 9P135M (`ru` ammunition/weapons/items/vehicles;
  medium from search extracts: range, speed, penetration 750 mm RHA, mass, four carried; low game values: launch
  speed, acceleration, turn rate, tracking error, reload 40 s, filling, fragments, self-destruct), `core/behaviour.json`
  `gunnery.missile*` (beyond 1000 m, halted below 0.3 m/s, sight check 0.1 s, seen floor 0.2, lose chance 0.5 when
  struck) and `stress.fromOwnVehiclePenetrated` 0.2 / `fromOwnVehicleStruck` 0.03 (low). Decided without the owner:
  Konkurs-M rather than Konkurs/Fagot (it gets through the Puma's front); the pre-interiors goldens are kept but
  skipped (keep or delete?).
- **Corrections to the two squads** (roles, ranks, weapons, ammunition) whenever the owner wishes.
- (Answered by choosing the research defaults:) squad tables wanted before M2.5: Panzergrenadier dismounts of a Puma and motor-rifle squad on a BMP — per
  man: role, rank, weapon; ammunition and grenades. Public-source research is in `docs/research/squads.md`
  (sources conflict on ranks, the German dismount weapon mix and whether the Russian squad has 8 or 9 men); the
  owner decides.
- Data to review when convenient: rank lists with NATO codes, name lists, female share in generated units.
- **New low-confidence data (M4):** `core/behaviour.json` (suppression, stress, decisions, drills — game values
  tuned with the suppression and attack labs) and the doctrine keys `boundM` / `finalAssaultM`, identical for
  Germany and Russia for lack of a public source on a difference.
- **New data (M7.4b), for review (game values):** the new component boxes of the Puma and BMP-2; extinguishers (Puma
  2 charges, 1 s, 70 %; BMP-2 2 charges, 2 s, 40 %); `core/behaviour.json` `crew` reaction values (1 s, recent hit
  3 s, reverse 60 m, hold 30 s, infantry threat 150 m); the AI's anti-tank values (COMMANDER in `ai/commander.ts`).
  Reviewed by the owner 2026-11-13: reversing out (also when a rocket bounces off) and the AI dismount (enemy men
  within 400 m, an enemy vehicle within 600 m) confirmed; ammunition from abandoned hulls changed to own side only.
- **New data (M7.4a), for review (game values unless marked):** armour plates of the Puma (owner Q21 b: front 150 /
  140 mm composite at 60°) and the BMP-2 (published thicknesses simplified, low); components (boxes, toughness,
  fire and cook-off chances); `core/ballistics.json` `armour` (LOS floor, graze fuse, jet decay 400 mm/m, spall
  damage, seat box); `core/behaviour.json` `antitank` (default rule, 6 s, range error 5 %, 2.5 mrad, room 60 m²,
  wall 2 m, hand-over 30 m) and `crew` (bail 2 s after fire, burn-out 120 s, cook-off 8 %/5 s, burns 0.7–1.0);
  PG-7VL and Panzerfaust 3 DM12 (penetration, speeds, masses medium from search extracts; motor, drag, dispersion
  low); PMC287/3UBR8 ricochet factors and spall. Decided without the owner: a crew also bails out when its vehicle
  can neither move nor fire, or when no crewman can act.
- **New data (M7.3), for review (all game values unless marked):** MK30-2 (200 rpm S), 2A42 (550 rpm S), coax
  MG5 / PKT; PMC287 (1405 m/s S; 106 mm RHA at 1000 m → 132.5 mild-steel mm), Puma impact HE (Q16), 3UBR8
  (1120 m/s S; 50 mm RHA at 1500 m → 62.5), 3UOF8 (960 m/s, 389 g S); belts (Puma 100 AP + 100 HE ready and as
  many stowed, coax 1000 + 1000; BMP-2 160 AP + 340 HE ready (S total 500), PKT 250 + 7 × 250 stowed (S 2000));
  smoke dischargers (Puma 4 × 4 of 76 mm, BMP-2 6 of 81 mm (S)); seat sights, arcs, sensor factors and smoke
  factors (`core/spotting.json`), vehicle signature (area from the boxes, ×4 moving, ×15 firing, type told
  within 1.5 km, engine 400/1200 m), `core/behaviour.json` `gunnery`, heavy-round wounding (≥ 12.5 mm,
  severity ≥ 0.85), doctrine `dismount.afterward` (DE overwatch, RU follow 150 m: research file, low). The
  driver does not search for the enemy (buttoned up, Q5).
- **New data (M7.2), for review:** `core/behaviour.json` `mounting` (reach, timings, 100 m re-mount and hold
  distances, refill of 3 magazines; game values, low); vehicle stowage (Puma 20 G36 magazines, 6 MG5 belts,
  4 G28 magazines; BMP-2 24 AK-74 magazines, 6 PKP belts; low); crews carry a rifle with 3 magazines, helmet and
  vest (low); `doctrine.json` `dismount.distanceM` Russia 400 m (medium), Germany 300 m (low, no published figure).
  Confirmed by the owner 2026-11-13: Q13 a crewman (not a passenger) takes over a fallen driver or gunner after
  about 20 s (the commander takes the gun at once); an order to a platoon with vehicles moves the vehicles.
- **New low-confidence data (M7.1b vehicles):** `factions/de/vehicles.json` (Puma) and `factions/ru/vehicles.json`
  (BMP-2): power, mass, top speed, crew/passenger counts and the BMP-2 turret rates are sourced (medium); hull
  boxes, gear bands, reverse speeds, braking, steering, fuel capacity and use, ramp times and station errors are
  game values (low), held in bands by `npm run lab -- drive`. Vehicle blocks of `core/terrain/surfaces.json`
  (rolling resistance, traction, rain factors) and `obstacles.json` (crossing per class, following the owner's
  answer: fences, hedges and wire flattened, brick and stone walls driven round). Crew templates
  `puma-besatzung` / `bmp2-ekipazh` and their roles and ranks. `rhaToMildSteel` 1.25 and materials
  `armour-steel`, `composite`.
