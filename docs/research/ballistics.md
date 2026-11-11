# Research: rifle ballistics, penetration and ricochet (public sources)

_Collected 2026-11-11 for M2.1. Values marked "used" are in the game data (`packages/data`)._

**Reliability:** the research session could not open the pages themselves (the network blocked them); every
value comes from web-search extracts of the cited page. Game data built on them is marked `confidence: "medium"`
at best, and the tables should be re-checked against the pages when possible.

## A. Rifles and cartridges

**G36 (480 mm barrel) with 5.56 x 45 mm DM11**
- Rifle 3.63 kg empty (https://en.wikipedia.org/wiki/Heckler_%26_Koch_G36); Bundeswehr: 3.6 kg, 750 rds/min
  (https://www.bundeswehr.de/de/ausruestung-technik-bundeswehr/ausruestung-bewaffnung/gewehr-g36). *Used.*
- Muzzle velocity 920 m/s (Wikipedia, above); DM11 A1: bullet 4.0 g, cartridge ~12.3 g, V10 925 ± 15 m/s
  (https://men-defencetec.de/de/produkt/5-56-mm-x-45-nato-ball-doppelkern-dm11-a1/). *Used.*
- Magazine 127 g empty (https://hausarchive.com/g36). *Used.*
- Accuracy (secondary sources only): requirement 4 of 5 shots in 10 cm at 100 m; about 15–17 cm at 100 m with
  service ammunition (https://de-academic.com/dic.nsf/dewiki/486998). *Used as ~0.4 mrad standard deviation.*

**AK-74M with 5.45 x 39 mm 7N6 / 7N10**
- Rifle 3.4 kg empty (https://www.army-technology.com/projects/ak-74m-assault-rifle-russian-army-military/);
  magazine 230 g empty; cartridge ~10.7 g (https://en.wikipedia.org/wiki/5.45%C3%9739mm). *Used.*
- Muzzle velocity 900 m/s
  (https://structure.mil.ru/structure/forces/ground/weapons/arma/more.htm?id=10344196@morfMilitaryModel). *Used.*
- Cyclic rate 600–650 rds/min. *Used: 650.* Bullets: 7N6 3.43 g, 7N10 3.62 g (Wikipedia 5.45x39, above). *Used.*
- Accuracy: about 4 cm dispersion at 100 m, first shot
  (https://nationalinterest.org/blog/the-buzz/we-now-know-why-russias-ak-47-so-deadly-26072). *Used as ~0.5 mrad.*

**Downrange velocities (used to fit the drag model)**
- 5.56 SS109-type, 508 mm barrel: 914 m/s at the muzzle, then 818 / 719 / 626 / 538 / 451 m/s at 100–500 m
  (https://www.rws-technology.com/en/armed-forces-law-enforcement/product/556x45-nato-ball-ss109-62gr-2422469).
- 5.45 7N6 (AK-74 manual): 900 m/s, then 801 / 709 / 623 / 543 m/s at 100–400 m
  (http://nastavleniya.ru/AK74/ak74_10.html).

**Tracer**
- DM21A1: 4.1 g, trace visible from 13–140 m to at least 600 m
  (https://rws-technology.com/en/armed-forces-law-enforcement/product/556mmx45-dm21a1-weichkern-leuchtspur-63gr-2318982).
- 7T3: 3.23 g, burns out at 800 m (Wikipedia 5.45x39).
- US belts: 4 ball to 1 tracer
  (https://www.marines.mil/Portals/1/Publications/FM%203-21.8%20%20The%20Infantry%20Rifle%20Platoon%20and%20Squad_7.pdf).

## B. Penetration

**Steel (used to set each bullet's penetration)**
- SS109: 3.5 mm mild steel at 570–640 m (NATO requirement, as quoted at
  https://forum.cartridgecollectors.org/t/223-5-56-id-reason-for-green-tip/37004); 3/8 in (9.5 mm) mild steel
  door: one round at 25–100 m (US Army FM 3-06.11 table 7-2,
  https://www.globalsecurity.org/military/library/policy/army/fm/3-06-11/ch7.htm).
- 7N6: 5 mm at 350 m, 3 mm at 670 m, 2 mm at 950 m (50 %) (https://www.armoury-online.ru/articles/ar/ru/ak-74/).
- 7N10: 16 mm St3 plate at 100 m (Wikipedia 5.45x39).

**Walls and cover (used to set material resistances)**
- 5.56 mm at under 50 m is stopped by: one thickness of packed sandbags, a 2 in (5 cm) unreinforced concrete
  wall, a sand-filled cinder block, brick veneer; 16 in (41 cm) tree trunk or log wall takes 1–3 rounds; 9 in
  double brick takes ~70 rounds to make a first hole; 8 in reinforced concrete ~35 rounds (FM 3-06.11, above).
- 7.62 mm ball: pine boards 13 in at 25 m, 18 in at 100 m, 41 in at 200 m; dry loose sand 4.5–7 in; concrete 2 in
  (FM 3-06.11 table 7-3, https://www.inetres.com/gp/military/infantry/rifle/762mm_ammo.html).
- 5.45 7N6: brick 10–12 cm at 100 m; 20 x 20 cm dry pine beams 50 % at 650 m (armoury-online, above).
- 18 in (45 cm) sandbag walls stop small arms
  (https://www.globalsecurity.org/military/library/policy/army/accp/en0065/le1.htm).
- Cars: rifle rounds pass doors; the engine block stops them (informal tests).

**How the game uses these (after review):** each bullet's steel penetration is anchored at the speed it has at
the published range (5.56 mm: 3.5 mm at 640 m; 7N10: 16 mm at 100 m) and scales with speed^1.5. Soft-core bullets
have a break-up speed above which their penetration of masonry, concrete, soil and wood no longer rises. The
lab test `packages/tools/test/lab-cover.test.ts` checks every figure above at its stated range.

## C. Ricochet — largest angle from the surface at which bullets still ricochet (used per material)
- Concrete 10.8°, cement 13.2° (7.62x39;
  https://www.researchgate.net/publication/352237057_Ricochet_of_AK_bullets_762_39_mm_on_concrete_and_cement_surfaces_a_forensic-based_study).
- Wood 9.9–13.3° (https://kar.kent.ac.uk/81477). Sheet metal 1 mm: about 20°
  (https://kar.kent.ac.uk/103084/1/C.%20Shepherd%20-%20effects%20of%20a%20range%20of%20projectiles%20on%20bullet%20ricochet%20-%20AAM.pdf).
- Water 6.5° (9 mm; https://www.ojp.gov/ncjrs/virtual-library/abstracts/ricochet-dynamics-nine-millimetre-parabellum-bullet).
- Soil about 8° (.50 cal; https://apps.dtic.mil/sti/tr/pdf/AD0479824.pdf).
- Speed loss up to about 35 % per ricochet (https://en.wikipedia.org/wiki/Ricochet).

## D. Vegetation
- No military data found on hedges or brush stopping bullets; hunting tests show small deflection close behind
  brush (https://www.themeateater.com/hunt/firearm-hunting/should-you-shoot-an-animal-through-the-brush).
  Vegetation stopping chances in the game are game-design values.

## Not found
Bullet diameters (5.70 mm and 5.60 mm are from memory), official dispersion tables, a 7N10 velocity table,
time-of-flight and drop tables, rifle-specific ricochet angles for soil and steel plate, German machine-gun belt
tracer ratio.
