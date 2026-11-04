import { build as esbuildBundle, transform } from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createStandaloneAppHtml } from "./standalone-html.mjs";
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
    "modifier-engine.js",
    "volume-atlas.js",
    "volume-library.js",
    "volume-library.bin",
    "fe-poly.js",
    "fe-project.js",
    "simulationCore.js",
    "simulation_solver.wasm",
    "fe-cpp-engine.js",
    "fe_core_engine.wasm",
    "manifest.webmanifest",
    "sw.js",
    "vendor",
    "assets"
  ];
  for (const item of staticAssets) {
    const p = resolve(item);
    if (existsSync(p)) {
      cpSync(p, resolve("build/client", item), { recursive: true });
    }
  }
}

/* ---- local deployment adaptations -------------------------------------
   Upstream builds from the repository root, where the engine, the solver and
   the vendored three.js all sit beside the HTML. This project keeps the
   browser assets under public/, so those artifacts are staged into the client
   directory here instead. */
copyFileSync("wasm/fe_core_engine.wasm", "build/client/fe_core_engine.wasm");
if (existsSync("wasm/simulation_solver.wasm")) {
  copyFileSync("wasm/simulation_solver.wasm", "build/client/simulation_solver.wasm");
} else if (existsSync(srcPath("simulation_solver.wasm"))) {
  copyFileSync(srcPath("simulation_solver.wasm"), "build/client/simulation_solver.wasm");
} else {
  throw new Error("Rust solver artifact is missing (expected wasm/simulation_solver.wasm).");
}
const solverBytes = readFileSync("build/client/simulation_solver.wasm");
if (solverBytes.length < 8 || solverBytes.subarray(0, 4).toString("hex") !== "0061736d") {
  throw new Error("Rust solver artifact failed its WebAssembly magic check.");
}

/* three.js arrives through npm, so the vendored copies the HTML asks for are
   taken from the checked-in vendor/three when they exist there and from the
   installed package otherwise (three.min.js is only in the package). */
const THREE_VENDOR = [
  ["three.min.js", "node_modules/three/build/three.min.js"],
  ["OrbitControls.js", "node_modules/three/examples/js/controls/OrbitControls.js"],
  ["TransformControls.js", "node_modules/three/examples/js/controls/TransformControls.js"],
  ["GLTFLoader.js", "node_modules/three/examples/js/loaders/GLTFLoader.js"],
  ["OBJLoader.js", "node_modules/three/examples/js/loaders/OBJLoader.js"],
  ["RGBELoader.js", "node_modules/three/examples/js/loaders/RGBELoader.js"],
  ["LICENSE", "node_modules/three/LICENSE"],
];
function threeSource(name, from) {
  const vendored = `vendor/three/${name}`;
  return existsSync(vendored) ? vendored : from;
}
mkdirSync("build/client/vendor/three", { recursive: true });
for (const [name, from] of THREE_VENDOR) {
  const source = threeSource(name, from);
  if (!existsSync(source)) throw new Error(`Vendored three.js source is missing: ${source}`);
  copyFileSync(source, `build/client/vendor/three/${name}`);
}
const threeVendorSources = new Map(
  THREE_VENDOR.filter(([name]) => name.endsWith(".js")).map(([name, from]) => [name, readFileSync(threeSource(name, from), "utf8")])
);

const minifiableJs = [
  "fe-icons.js",
  "fe-taa.js",
  "render-capture.js",
  "render-preview.js",
  "render-export.js",
  "workspace-export.js",
  "edit-mode.js",
  "modifier-engine.js",
  "volume-atlas.js",
  "volume-library.js",
  "fe-poly.js",
  "fe-project.js",
  "simulationCore.js",
  "fe-cpp-engine.js",
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
  "fe-poly.js",
  "fe-project.js",
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

let bundlableIndexHtml = optimizedIndexHtml;
try {
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

const cppWasmBase64 = readFileSync("build/client/fe_core_engine.wasm").toString("base64");
const simWasmBase64 = existsSync("build/client/simulation_solver.wasm")
  ? readFileSync("build/client/simulation_solver.wasm").toString("base64")
  : "";

const standaloneAppHtml = createStandaloneAppHtml(
  readFileSync(srcPath("index.html"), "utf8"),
  {
    volumeAtlas: readFileSync(srcPath("volume-atlas.js"), "utf8"),
    feIcons: readFileSync(srcPath("fe-icons.js"), "utf8"),
    feTaa: readFileSync(srcPath("fe-taa.js"), "utf8"),
    volumeLibrary: readFileSync(srcPath("volume-library.js"), "utf8"),
    fePoly: readFileSync(srcPath("fe-poly.js"), "utf8"),
    feProject: readFileSync(srcPath("fe-project.js"), "utf8"),
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
  }
);
/* A single-file download has no sibling files, so the vendored three.js is
   inlined there even though the served app keeps it as a cacheable request. */
function inlineVendoredThree(html) {
  let out = html;
  for (const [name, source] of threeVendorSources) {
    const escaped = name.replace(".", "\\.");
    const tag = new RegExp(`<script[^>]*src=["']\\.?/?vendor/three/${escaped}["'][^>]*>\\s*</script>`);
    if (!tag.test(out)) continue;
    out = out.replace(tag, () => `<script>\n${source}\n</script>`);
  }
  return out;
}
writeFileSync("build/client/Final-Effect-3D-Standalone.html", inlineVendoredThree(stampBuild(standaloneAppHtml)));
writeFileSync("Final-Effect-3D-Standalone.html", inlineVendoredThree(standaloneAppHtml));

/* Keep the worker/asset manifest contract used by the camelAI deploy path. */
mkdirSync("build/server", { recursive: true });
cpSync("worker.js", "build/server/worker.js");
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
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
