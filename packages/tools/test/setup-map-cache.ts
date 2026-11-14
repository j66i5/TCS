/** Vitest setup (tools, render, ui): share generated maps between tests (see `src/map-cache.ts`). */
import { setMapCache } from "@tcs/scenario";
import { diskMapCache } from "../src/map-cache";

if (process.env.TCS_MAP_CACHE !== "0") setMapCache(diskMapCache());
