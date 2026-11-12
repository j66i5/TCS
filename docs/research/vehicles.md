# Research notes: vehicles and shoulder-fired anti-tank weapons (M7)

Collected 2026-11-12 from web search extracts only (pages cannot be opened from the build container), so every
value is `confidence: "medium"` at most; where sources disagree or only game wikis give a number, `"low"`.
The owner's scope for M7 (DECISIONS.md, 2026-11-12): the **Puma** and the **BMP-2** only; guided missiles wait
for M9.

## Schützenpanzer Puma (Germany)

| Item | Value | Source | Note |
|---|---|---|---|
| Crew + dismounts | 3 + 6 | bundeswehr.de (Puma page), en.wikipedia Puma | commander, gunner, driver in the hull; unmanned turret |
| Mass | 31.45 t (protection level A), 43 t (level C) | military-history.fandom, army-technology | level C (add-on armour) is the combat configuration |
| Engine | MTU V10 892 diesel, 800 kW (1,088 PS) | bundeswehr.de, en.wikipedia | 18.6 kW/t at 43 t |
| Road speed | 70 km/h | en.wikipedia | reverse speed not found |
| Size | 7.6 m long, 4.0 m wide (level C), 3.6 m high | bundeswehr.de | wikipedia: 7.4 m |
| Main gun | MK30-2/ABM, 30 x 173 mm, 200 rounds ready + 200 stowed | en.wikipedia | dual feed (KE and ABM) |
| Rate of fire | 200 rounds/min as fitted | PSM brochure "SPz PUMA Firepower" | the gun family is quoted at up to 700/min elsewhere |
| Coaxial MG | MG4A1, 5.56 x 45 mm (MG5 7.62 mm from the S1 standard) | en.wikipedia | rounds carried: about 1,000 ready (not confirmed) |
| Protection | modular AMAP composite; the often-quoted "30 mm frontal, 14.5 mm all round" for level C was **not** confirmed by any extract | — | game value needed, confidence low |

30 x 173 mm ammunition:
- APFSDS-T (PMC287): 235 g penetrator, about 1,405 m/s, **53 mm at 60° (NATO) at 1,000 m** (Rheinmetall data
  sheet). Other makers quote "over 100 mm RHA at 1,000 m" for comparable rounds (Nammo, STV, Northrop Grumman) —
  a different test basis (line-of-sight thickness: 53 mm at 60° is 106 mm along the path), so the figures agree.
- KETF / ABM air-burst: 135 tungsten cylinders ejected ahead of the target (en.wikipedia); mass and velocity of
  the round not found (about 1,050 m/s is the usual figure for the full-calibre rounds — to verify).

## BMP-2 (Russia)

| Item | Value | Source | Note |
|---|---|---|---|
| Crew + passengers | 3 + 7 | FAS (DoD-derived) | commander and gunner in the turret, driver in the hull |
| Mass | 14.0–14.3 t | Janes (via issuu), redstar.gr | |
| Engine | UTD-20/3 diesel, 300 hp (225 kW) | several | 21 hp/t |
| Road speed | 65 km/h | Janes | swims (7 km/h) — not modelled |
| Main gun | 2A42, 30 x 165 mm, 500 rounds in two boxes | several | usual split 160 AP + 340 HE (not confirmed by an extract) |
| Rate of fire | 550/min cyclic, 200–300/min practical | weaponsystems.net / wiki mirrors | |
| Coaxial MG | PKT 7.62 x 54R, 2,000 rounds | several | |
| Turret | 360° in 10.28 s; elevation −5° to +74° through 74° in 12.33 s; two-plane stabiliser 2E36-1 | wikiwand, FAS, armsnet | |
| Armour | welded steel; front resists 23 mm AP from 500 m, sides 7.62 mm AP from 75 m (Army Recognition); "33 mm max" (wikipedia infobox); plate figures 15–20 mm come only from a game wiki; Janes: classified | | plate thicknesses are game values, confidence low |

30 x 165 mm ammunition:
- 3UBR8 APDS-T: 1,120 m/s; advertised penetration **25 mm at 1,500 m with the plate "at 30°"** (Rosoboronexport
  figure, quoted in a forum post). Whether the 30° is measured from the plate or from its normal is not clear
  from the extract; it is usually read as 60° from the normal (about 50 mm along the path).
- AP-T (3UBR6 type): 970 m/s (generic 30 x 165 AP-T sheet); penetration not found (commonly given as about 20 mm
  at 60° at 700 m — to verify).
- HE-I (3UOF8 type): about 960 m/s (3UOF6 sheet); filling not found (about 49 g is the usual figure — to verify).

## Panzerfaust 3 (Germany)

- Ready to fire 15.2 kg; 110 mm warhead 3.9 kg (wiki mirrors).
- Muzzle velocity 160–165 m/s (army-technology: 165 m/s; a wiki mirror 160; another 115 — taken as the launch
  speed before the sustainer); the rocket accelerates to about 243 m/s (usual figure, not in the extracts).
- Effective range: 300 m moving target, 400 m stationary (optical sight); 600 m with the Dynarange sight.
- Penetration: DM12 HEAT 700 mm RHA; tandem 3-IT (DM22) 900 mm behind reactive armour.
- Minimum (arming) range about 15 m (one extract: "from 15 to 300 m").

## RPG-7V2 with PG-7VL (Russia)

- Round 2.6 kg, 93 mm single HEAT warhead, **over 500 mm RHA** (VMZ manufacturer page, others).
- Launch 112–115 m/s, then the motor takes it to about 300 m/s (the extract's "flight" speed).
- Sighting range 300 m, direct-fire range 250 m (VMZ); self-destruct at about 920 m.
- Launcher 6.3 kg (about 7 kg with the PGO-7 sight).

## What the game needs that no source gave (game values, confidence low)

- Plate thickness per facing for both vehicles (the model needs numbers; chosen so the published protection
  statements hold in the armour lab: Puma front stops 30 mm APFSDS at 1,000 m and its sides 14.5 mm; BMP-2 front
  stops 23 mm AP at 500 m, sides stop 7.62 mm AP at 75 m and not 12.7 mm).
- Reverse speeds, acceleration, turn rates; turret rates of the Puma.
- Internal layout (where engine, fuel, ammunition, crew sit) and component toughness.
- Behind-armour effect of shaped charges and 30 mm rounds.

Sources (as given by the search tool):
- https://www.bundeswehr.de/de/ausruestung-technik-bundeswehr/landsysteme-bundeswehr/schuetzenpanzer-puma
- https://en.wikipedia.org/wiki/Puma_(German_infantry_fighting_vehicle)
- https://www.army-technology.com/projects/puma_tracked/
- https://www.psm-spz.de/fileadmin/user_upload/broschueren/SPz_PUMA_Firepower_ENG.pdf
- https://www.rheinmetall.com/Rheinmetall%20Group/brochure-download/Weapon-Ammmunition/D129e0721-APFSDS-T-30x173-PMC287-RWMS.pdf
- https://www.nammo.com/products/ammunition/medium-caliber-ammunition/30-mm-series/30mm-x-173-apfsds-t/
- https://en.wikipedia.org/wiki/BMP-2
- https://man.fas.org/dod-101/sys/land/row/bmp-2.htm
- https://armyrecognition.com/military-products/army/infantry-fighting-vehicles/tracked-vehicles/bmp-2-russia-uk
- https://weaponsystems.net/system/329-CC04%20-%20BMP-2
- https://www.tanks-encyclopedia.com/coldwar/ussr/BMP-2.php
- https://en.wikipedia.org/wiki/Panzerfaust_3
- https://www.army-technology.com/projects/panzerfaust-3-anti-tank-weapon-germany/
- https://vmz.bg/en/production/ammunition-for-rpg-7v-portable-anti-tank-rocket-propelled-grenade-launcher/izstrel-pg-7vl-s-protivotankova-granata-pg-7l
- https://en.wikipedia.org/wiki/RPG-7
