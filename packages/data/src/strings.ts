/**
 * String tables (SPEC 4.3 rule 12). All player-facing text, including radio messages, is looked up by key.
 * Lookup order: faction table (language) -> core table (language) -> core English -> visible marker.
 */
import type { DataSet } from "./loader";

export type Params = Record<string, string | number>;

export class Strings {
  constructor(
    private readonly data: DataSet,
    public lang = "en",
  ) {}

  has(key: string, faction?: string): boolean {
    return this.lookup(key, faction) !== undefined;
  }

  private lookup(key: string, faction?: string): string | undefined {
    const fp = faction ? this.data.factions[faction] : undefined;
    return (
      fp?.strings[this.lang]?.[key] ??
      this.data.strings[this.lang]?.[key] ??
      fp?.strings["en"]?.[key] ??
      this.data.strings["en"]?.[key]
    );
  }

  /** Format a string, replacing `{name}` with params. Missing keys render as `[[key]]` so they are visible. */
  t(key: string, params: Params = {}, faction?: string): string {
    const raw = this.lookup(key, faction);
    if (raw === undefined) return `[[${key}]]`;
    return raw.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] !== undefined ? String(params[name]) : m));
  }
}
