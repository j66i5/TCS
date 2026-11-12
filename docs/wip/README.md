# Work in progress, saved 2026-11-12

**Surrender (M6.6)** — owner request; decisions in DECISIONS.md (three "Owner: surrender" entries).
- `surrender-spec.md`: the full implementation plan (files, functions, tests). Amendments decided AFTER it was
  written: (A1) "downed" = wounded and cannot FIGHT (whether or not he can walk); (A2) when quiet, one fit enemy
  within ~50 m who has seen the surrender walks over, takes the man prisoner and returns (data keys
  fetchWithinM 50, fetchQuietSeconds 10, fetchTimeoutSeconds 120; implemented in systems/surrender.ts; orders
  cancel it); (A3) a comrade giving up adds no stress.
- `surrender-wip.patch`: the UNFINISHED start of the implementation (about a third of the simulation part;
  it does not compile or pass tests). Apply with `git apply docs/wip/surrender-wip.patch` or start afresh from
  the plan.
- `surrender-baseline/`: batch results on main before the change (platoon and platoon-ru: 10 runs, 900 s;
  demo: 50 runs, 120 s) for the "nothing changes when nobody surrenders" check in the plan.

**Next after surrender:** M7 Vehicles (owner answers in DECISIONS.md; research in docs/research/vehicles.md;
the architecture design was not finished), then M7.5 Look and interface (owner answers in DECISIONS.md).
Delete this folder when surrender is merged.
