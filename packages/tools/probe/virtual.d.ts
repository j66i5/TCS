/** The data files, keyed as `readDataFiles` keys them; injected by the probe CLI's Vite plugin (src/cli/probe.ts). */
declare module "virtual:tcs-probe-data" {
  const files: Record<string, unknown>;
  export default files;
}
