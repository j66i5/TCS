/**
 * @tcs/campaign - persistent roster and operational layer (SPEC 9.3; M12).
 *
 * Deterministic like the simulation (the sim's lint rules apply: seeded RNG, sim/math, no clock); never imports the
 * AI: battles run through an injected `BattleRunner`.
 */
export * from "./runner";
export * from "./carry";
export * from "./chain";
export * from "./rules";
export * from "./record";
export * from "./holdings";
export * from "./commit";
export * from "./leaders";
export * from "./between";
export * from "./campaign-chain";
