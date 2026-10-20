import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { createStandaloneTerrainHtml } from "./standalone-html.mjs";

const testFiles = readdirSync("tests").filter((name) => name.endsWith(".test.mjs")).map((name) => `tests/${name}`);
if (testFiles.length) execFileSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });

rmSync("build", { recursive: true, force: true });
mkdirSync("build/client", { recursive: true });
mkdirSync("build/server", { recursive: true });
cpSync("public", "build/client", { recursive: true });
cpSync("worker.js", "build/server/worker.js");
await build({
  entryPoints: ["src/modifier-entry.mjs"],
  outfile: "build/client/modifier-engine.js",
  bundle: true,
  minify: true,
  legalComments: "none",
  format: "iife",
  target: "es2018",
  plugins: [{
    name: "use-app-three-global",
    setup(api) { api.onResolve({ filter: /^three$/ }, () => ({ path: resolve("src/three-global-shim.mjs") })); }
  }]
});
console.log("Bundled modifier geometry/CSG engine against the app's global Three.js runtime.");
await build({ entryPoints: ["src/tessendorf-ocean.mjs"], outfile: "build/client/tessendorf-ocean.js", bundle: true, minify: true, legalComments: "none", format: "iife", globalName: "TessendorfOceanBundle", target: "es2018" });
console.log("Bundled the CPU inverse-FFT Tessendorf ocean solver.");
const standaloneHtml = createStandaloneTerrainHtml(readFileSync("public/Terrain_system_.html", "utf8"), {
  celestialMath: readFileSync("public/celestial-math.js", "utf8"),
  scatterSpacing: readFileSync("public/scatter-spacing.js", "utf8"),
  tessendorf: readFileSync("build/client/tessendorf-ocean.js", "utf8"),
});
writeFileSync("build/client/Terrain-System-Standalone.html", standaloneHtml);
console.log(`Built Terrain-System-Standalone.html (${Buffer.byteLength(standaloneHtml)} bytes).`);

const solverPartsDir = "wasm/artifact-parts";
const solverParts = readdirSync(solverPartsDir)
  .filter((name) => /^simulation_solver\.wasm\.b64\.part-\d+\.txt$/.test(name))
  .sort();
if (solverParts.length === 0) throw new Error("Rust WASM solver chunks are missing; refusing to deploy the placeholder simulation engine.");
const solverBase64 = solverParts.map((name) => readFileSync(`${solverPartsDir}/${name}`, "utf8").trim()).join("");
const solverWasm = Buffer.from(solverBase64, "base64");
if (solverWasm.length < 8 || solverWasm.subarray(0, 4).toString("hex") !== "0061736d") {
  throw new Error("Simulation solver WASM artifact failed its magic-header check.");
}
const solverModule = new WebAssembly.Module(solverWasm);
const solverExports = WebAssembly.Module.exports(solverModule).map((entry) => entry.name);
const requiredSolverExports = ["memory", "__heap_base", "sim_solver_abi_version", "sim_solver_deformable_step", "sim_solver_sph_step", "sim_solver_buoyant_tracer_step"];
for (const name of requiredSolverExports) if (!solverExports.includes(name)) throw new Error(`Simulation solver WASM is missing export: ${name}`);
const solverInstance = new WebAssembly.Instance(solverModule, {});
const solverAbi = solverInstance.exports.sim_solver_abi_version();
if (![1, 2].includes(solverAbi)) throw new Error(`Unsupported simulation solver ABI version ${solverAbi}.`);
writeFileSync("build/client/simulation_solver.wasm", solverWasm);
console.log(`Built simulation_solver.wasm (${solverWasm.length} bytes, ABI v${solverAbi}).`);

const rawConfig = readFileSync("wrangler.jsonc", "utf8");
const config = JSON.parse(rawConfig.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1"));
const manifest = {
  main: "worker.js",
  no_bundle: true,
  rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags ?? [],
  assets: { directory: "../client", binding: "ASSETS" },
  ...(config.vars ? { vars: config.vars } : {}),
  ...(config.durable_objects ? { durable_objects: config.durable_objects } : {}),
  ...(config.migrations ? { migrations: config.migrations } : {}),
  ...(config.kv_namespaces ? { kv_namespaces: config.kv_namespaces } : {}),
  ...(config.r2_buckets ? { r2_buckets: config.r2_buckets } : {}),
  ...(config.bindings ? { bindings: config.bindings } : {}),
};
writeFileSync("build/server/wrangler.json", JSON.stringify(manifest, null, 2) + "\n");
