import { build as esbuildBundle, transform } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStandaloneAppHtml, createStandaloneTerrainHtml } from "./standalone-html.mjs";
import "./build-cpp-wasm.mjs";

if (existsSync("src/modifier-entry.mjs")) {
  await esbuildBundle({
    entryPoints: ["src/modifier-entry.mjs"],
    bundle: true,
    format: "iife",
    minify: true,
    alias: { three: "./src/three-global-shim.mjs" },
    outfile: "modifier-engine.js",
  });
}

rmSync("build", { recursive: true, force: true });
mkdirSync("build/client", { recursive: true });

const hasPublicDir = existsSync("public/index.html");
const srcPath = (name) => (hasPublicDir ? `public/${name}` : name);

if (hasPublicDir) {
  cpSync("public", "build/client", { recursive: true });
} else {
  const staticAssets = [
    "index.html",
    "fe-icons.js",
    "fe-taa.js",
    "Terrain_system_.html",
    "celestial-math.js",
    "scatter-spacing.js",
    "tessendorf-ocean.js",
    "open-world-generator.js",
    "open-world.js",
    "modifier-engine.js",
    "volume-atlas.js",
    "volume-library.js",
    "volume-library.bin",
    "simulationCore.js",
    "simulation_solver.wasm",
    "fe-cpp-engine.js",
    "landscape-realism.js",
    "landscape-flora.js",
    "fe_core_engine.wasm",
    "manifest.webmanifest",
    "sw.js",
    "assets"
  ];
  for (let i = 1; i <= 9; i++) {
    staticAssets.push(`terrain-main-${String(i).padStart(2, "0")}.js`);
  }
  for (const item of staticAssets) {
    const p = resolve(item);
    if (existsSync(p)) {
      cpSync(p, resolve("build/client", item), { recursive: true });
    }
  }
}

const terrainMainFiles=Array.from({length:9},(_,i)=>`terrain-main-${String(i+1).padStart(2,"0")}.js`);
const minifiableJs = [
  "celestial-math.js",
  "fe-icons.js",
  "fe-taa.js",
  "scatter-spacing.js",
  "tessendorf-ocean.js",
  "open-world-generator.js",
  ...terrainMainFiles,
  "open-world.js",
  "modifier-engine.js",
  "volume-atlas.js",
  "volume-library.js",
  "simulationCore.js",
  "fe-cpp-engine.js",
  "landscape-realism.js",
  "landscape-flora.js",
];

async function minifyInlineScripts(html, label) {
  const scriptPattern = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let result = "", lastIndex = 0, scriptIndex = 0;
  for (const match of html.matchAll(scriptPattern)) {
    const [full, attrs, code] = match;
    result += html.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;
    if (!code.trim()) { result += full; continue; }
    const { code: minified } = await transform(code, { loader: "js", target: "es2020", minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: "none", sourcefile: `${label}-inline-${++scriptIndex}.js` });
    result += `<script${attrs}>\n${minified.trim()}\n</script>`;
  }
  return result + html.slice(lastIndex);
}

for (const file of minifiableJs) {
  const inputPath = srcPath(file);
  if (!existsSync(inputPath)) continue;
  const source = readFileSync(inputPath, "utf8");
  const { code } = await transform(source, {
    loader: "js",
    target: "es2020",
    minify: true,
    legalComments: "none",
    sourcefile: file,
  });
  writeFileSync(`build/client/${file}`, code);
}

const optimizedIndexHtml = await minifyInlineScripts(readFileSync(srcPath("index.html"), "utf8"), "index.html");
const optimizedTerrainHtml = await minifyInlineScripts(readFileSync(srcPath("Terrain_system_.html"), "utf8"), "Terrain_system_.html");
writeFileSync("build/client/index.html", optimizedIndexHtml);
writeFileSync("build/client/Terrain_system_.html", optimizedTerrainHtml);

const cppWasmBase64 = readFileSync("build/client/fe_core_engine.wasm").toString("base64");
const simWasmBase64 = existsSync("build/client/simulation_solver.wasm")
  ? readFileSync("build/client/simulation_solver.wasm").toString("base64")
  : "";

const terrainBootstrap = `<script>window.__FE_CPP_WASM_BASE64__=${JSON.stringify(cppWasmBase64)};</script>`;
if (!optimizedTerrainHtml.includes('__FE_CPP_WASM_BASE64__')) {
  writeFileSync("build/client/Terrain_system_.html", optimizedTerrainHtml.replace('<head>', `<head>\n${terrainBootstrap}`));
}

const standaloneTerrainHtml = createStandaloneTerrainHtml(optimizedTerrainHtml, {
  feIcons: readFileSync("build/client/fe-icons.js", "utf8"),
  celestialMath: readFileSync("build/client/celestial-math.js", "utf8"),
  scatterSpacing: readFileSync("build/client/scatter-spacing.js", "utf8"),
  tessendorf: readFileSync("build/client/tessendorf-ocean.js", "utf8"),
  openWorld: readFileSync("build/client/open-world-generator.js", "utf8"),
  landscapeRealism: readFileSync("build/client/landscape-realism.js", "utf8"),
  landscapeFlora: readFileSync("build/client/landscape-flora.js", "utf8"),
  terrainMainParts: terrainMainFiles.map(file => [file, readFileSync(`build/client/${file}`, "utf8")]),
  openWorldAddon: readFileSync("build/client/open-world.js", "utf8"),
  cppWasmBase64,
});
writeFileSync("build/client/Terrain-System-Standalone.html", standaloneTerrainHtml);

const standaloneAppHtml = createStandaloneAppHtml(
  readFileSync(srcPath("index.html"), "utf8"),
  {
    volumeAtlas: readFileSync(srcPath("volume-atlas.js"), "utf8"),
    feIcons: readFileSync(srcPath("fe-icons.js"), "utf8"),
    feTaa: readFileSync(srcPath("fe-taa.js"), "utf8"),
    volumeLibrary: readFileSync(srcPath("volume-library.js"), "utf8"),
    simulationCore: readFileSync(srcPath("simulationCore.js"), "utf8"),
    modifierEngine: readFileSync(srcPath("modifier-engine.js"), "utf8"),
    feCppEngine: readFileSync(srcPath("fe-cpp-engine.js"), "utf8"),
    cppWasmBase64,
    simWasmBase64,
    volumeLibraryBase64: readFileSync(srcPath("volume-library.bin")).toString("base64"),
    terrainStandaloneHtml: standaloneTerrainHtml,
  }
);
writeFileSync("build/client/Final-Effect-3D-Standalone.html", standaloneAppHtml);
writeFileSync("Final-Effect-3D-Standalone.html", standaloneAppHtml);
