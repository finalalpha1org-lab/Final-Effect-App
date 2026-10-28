import { build as esbuildBundle, transform } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
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
    "render-capture.js",
    "render-preview.js",
    "render-export.js",
    "workspace-export.js",
    "edit-mode.js",
    "Terrain_system_.html",
    "celestial-math.js",
    "scatter-spacing.js",
    "tessendorf-ocean.js",
    "open-world-generator.js",
    "landscape-export-pack.js",
    "open-world.js",
    "modifier-engine.js",
    "volume-atlas.js",
    "volume-library.js",
    "volume-library.bin",
    "simulationCore.js",
    "simulation_solver.wasm",
    "fe-cpp-engine.js",
    "kernel-worker.js",
    "landscape-realism.js",
    "landscape-flora.js",
    "landscape-weather.js",
    "fe_core_engine.wasm",
    "manifest.webmanifest",
    "sw.js",
    "vendor",
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
  "render-capture.js",
  "render-preview.js",
  "render-export.js",
  "workspace-export.js",
  "edit-mode.js",
  "scatter-spacing.js",
  "tessendorf-ocean.js",
  "open-world-generator.js",
  "landscape-export-pack.js",
  ...terrainMainFiles,
  "open-world.js",
  "modifier-engine.js",
  "volume-atlas.js",
  "volume-library.js",
  "simulationCore.js",
  "fe-cpp-engine.js",
  "kernel-worker.js",
  "landscape-realism.js",
  "landscape-flora.js",
  "landscape-weather.js",
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
/* ---- request count -------------------------------------------------------
 * Each of these files is one HTTP request on the way to the first frame, and a
 * phone pays for every one of them in DNS, TLS-less connect and header
 * round-trips even when they arrive in parallel. They are plain classic scripts
 * that share the global scope and must run in this order, so concatenating them
 * is semantics-preserving — the browser then parses one stream instead of
 * twenty. The sources stay split for editing and for the tests that slice them.
 *
 * three.js is deliberately *not* in these bundles: it never changes, so it
 * should stay in the browser cache across deploys while the app bundle does
 * not. */
const STUDIO_SCRIPTS = [
  "tessendorf-ocean.js",
  "open-world-generator.js",
  "landscape-export-pack.js",
  "terrain-main-01.js",
  "kernel-worker.js",
  "landscape-flora.js",
  ...terrainMainFiles.slice(1),
  "landscape-realism.js",
  "landscape-weather.js",
  "open-world.js",
];

const WORKSPACE_SCRIPTS = [
  "fe-icons.js",
  "edit-mode.js",
  "render-capture.js",
  "render-preview.js",
  "render-export.js",
  "workspace-export.js",
  "fe-taa.js",
  "volume-atlas.js",
  "volume-library.js",
  "simulationCore.js",
  "modifier-engine.js",
  "fe-cpp-engine.js",
];

async function bundleScripts(files, outName, html) {
  /* Find every `<script src>` in the document, keep the ones that are not in
     this group, and emit one bundle tag where the group's first member was.
     A line-based scan rather than a lookbehind: the group is contiguous in both
     shells, but this does not depend on that. */
  const norm = (value) => String(value).replace(/^\.\//, "");
  const wanted = new Set(files.map(norm));
  const tag = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>\s*/g;
  const parts = [];
  let lastIndex = 0;
  let emitted = false;
  let included = 0;
  for (const match of html.matchAll(tag)) {
    if (!wanted.has(norm(match[1]))) continue;
    parts.push(html.slice(lastIndex, match.index));
    if (!emitted) {
      parts.push(`<script src="./${outName}"></script>\n`);
      emitted = true;
    }
    lastIndex = match.index + match[0].length;
    included++;
  }
  parts.push(html.slice(lastIndex));
  if (!emitted || included < 2) return html;
  const codes = [];
  for (const file of files) {
    const inputPath = srcPath(file);
    if (!existsSync(inputPath)) continue;
    const { code } = await transform(readFileSync(inputPath, "utf8"), {
      loader: "js",
      target: "es2020",
      minify: true,
      legalComments: "none",
      sourcefile: file,
    });
    codes.push(`/* ${file} */\n${code}`);
  }
  writeFileSync(`build/client/${outName}`, codes.join("\n"));
  return parts.join("");
}

let bundlableTerrainHtml = optimizedTerrainHtml;
let bundlableIndexHtml = optimizedIndexHtml;
try {
  bundlableTerrainHtml = await bundleScripts(STUDIO_SCRIPTS, "landscape-app.js", optimizedTerrainHtml);
  bundlableIndexHtml = await bundleScripts(WORKSPACE_SCRIPTS, "workspace-app.js", optimizedIndexHtml);
} catch (error) {
  console.warn("Script bundling skipped:", error && error.message);
}

/* ---- build identity ------------------------------------------------------
   The ⚙ sheet shows the build a device is running, and the only trustworthy
   source for that is the page the browser actually loaded. Stamping it here
   means a cached shell reports the old date instead of looking identical to a
   fresh one, which is the difference between "the fix did nothing" and "the
   phone is running last week's app". */
function buildStamp() {
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  let sha = "";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch (error) {
    sha = "";
  }
  return (sha ? `${sha} · ` : "") + date + " UTC";
}
function stampBuild(html) {
  const meta = `<meta name="fe-build" content="${buildStamp()}">`;
  if (/<meta name="fe-build"[^>]*>/.test(html)) return html.replace(/<meta name="fe-build"[^>]*>/, meta);
  return html.replace("<head>", `<head>\n${meta}`);
}

writeFileSync("build/client/index.html", stampBuild(bundlableIndexHtml));
writeFileSync("build/client/Terrain_system_.html", bundlableTerrainHtml);

const cppWasmBase64 = readFileSync("build/client/fe_core_engine.wasm").toString("base64");
const simWasmBase64 = existsSync("build/client/simulation_solver.wasm")
  ? readFileSync("build/client/simulation_solver.wasm").toString("base64")
  : "";

/* The wasm is *not* inlined into the studio page any more. Base64 turns 1.83 MB
   into 2.44 MB of HTML that must be downloaded, parsed and decoded before the
   module can even start compiling, and it makes the shell uncacheable
   independently of the binary. The studio streams the real artifact instead
   (WebAssembly.instantiateStreaming, see terrain-main-01.js); only the
   single-file artifact, which is a download and not the app, still embeds it. */
bundlableTerrainHtml = stampBuild(bundlableTerrainHtml);

if (!bundlableTerrainHtml.includes('__FE_CPP_WASM_BASE64__')) {
  const preload = '<link rel="preload" href="./fe_core_engine.wasm" as="fetch" crossorigin="anonymous">';
  writeFileSync(
    "build/client/Terrain_system_.html",
    bundlableTerrainHtml.replace('<head>', `<head>\n${preload}`),
  );
}

const standaloneTerrainHtml = createStandaloneTerrainHtml(optimizedTerrainHtml, {
  feIcons: readFileSync("build/client/fe-icons.js", "utf8"),
  celestialMath: readFileSync("build/client/celestial-math.js", "utf8"),
  scatterSpacing: readFileSync("build/client/scatter-spacing.js", "utf8"),
  tessendorf: readFileSync("build/client/tessendorf-ocean.js", "utf8"),
  openWorld: readFileSync("build/client/open-world-generator.js", "utf8"),
  landscapeExportPack: readFileSync("build/client/landscape-export-pack.js", "utf8"),
  landscapeRealism: readFileSync("build/client/landscape-realism.js", "utf8"),
  landscapeFlora: readFileSync("build/client/landscape-flora.js", "utf8"),
  landscapeWeather: readFileSync("build/client/landscape-weather.js", "utf8"),
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
    renderCapture: readFileSync(srcPath("render-capture.js"), "utf8"),
    renderPreview: readFileSync(srcPath("render-preview.js"), "utf8"),
    renderExport: readFileSync(srcPath("render-export.js"), "utf8"),
    workspaceExport: readFileSync(srcPath("workspace-export.js"), "utf8"),
    editMode: readFileSync(srcPath("edit-mode.js"), "utf8"),
    cppWasmBase64,
    simWasmBase64,
    volumeLibraryBase64: readFileSync(srcPath("volume-library.bin")).toString("base64"),
    terrainStandaloneHtml: standaloneTerrainHtml,
  }
);
writeFileSync("build/client/Final-Effect-3D-Standalone.html", stampBuild(standaloneAppHtml));
writeFileSync("Final-Effect-3D-Standalone.html", standaloneAppHtml);
