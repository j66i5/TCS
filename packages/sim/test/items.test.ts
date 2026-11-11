import { describe, expect, it } from "vitest";
import { addItems, containerMassKg, countItems, emptyContainer, removeItems, Store, transferItems, type Container } from "../src/index";
import { testCatalog } from "./helpers";

describe("items and containers", () => {
  it("computes mass including charge (rounds in magazines)", () => {
    const c = emptyContainer();
    addItems(c, "mag", 2, 30);
    addItems(c, "brick", 1);
    expect(containerMassKg(testCatalog, c)).toBeCloseTo(2 * (0.1 + 30 * 0.012) + 2, 9);
  });

  it("keeps partly used magazines as separate stacks and removes fullest first", () => {
    const c = emptyContainer();
    addItems(c, "mag", 1, 12);
    addItems(c, "mag", 3, 30);
    expect(c.stacks.map((s) => [s.count, s.charge])).toEqual([[1, 12], [3, 30]]);
    const r = removeItems(c, "mag", 2);
    expect(r).toEqual([{ type: "mag", count: 2, charge: 30 }]);
    expect(countItems(c, "mag")).toBe(2);
  });

  it("transfers between any two containers and conserves items", () => {
    const store = new Store<Container>();
    store.set(1, emptyContainer());
    store.set(2, emptyContainer());
    addItems(store.req(1), "mag", 5, 30);
    const r = transferItems(testCatalog, store, { from: 1, to: 2, type: "mag", count: 3 });
    expect(r).toEqual({ moved: 3 });
    expect(countItems(store.req(1), "mag") + countItems(store.req(2), "mag")).toBe(5);
    const r2 = transferItems(testCatalog, store, { from: 1, to: 2, type: "mag", count: 10 });
    expect(r2).toEqual({ moved: 2, shortfall: "not-enough-items" });
  });

  it("respects the destination mass limit", () => {
    const store = new Store<Container>();
    store.set(1, emptyContainer());
    store.set(2, emptyContainer(5)); // 5 kg crate
    addItems(store.req(1), "brick", 4);
    const r = transferItems(testCatalog, store, { from: 1, to: 2, type: "brick", count: 4 });
    expect(r).toEqual({ moved: 2, shortfall: "destination-full" });
    expect(countItems(store.req(1), "brick")).toBe(2);
  });
});
