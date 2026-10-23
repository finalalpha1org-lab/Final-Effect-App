import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = process.cwd();
const BUILD_CLIENT = path.join(ROOT, "build", "client");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function resolveAsset(urlPath) {
  let clean = decodeURIComponent(urlPath.split("?")[0] || "/");
  let forceDownloadName = null;
  if (clean === "/download/Terrain-System-Standalone.html") {
    clean = "/Terrain-System-Standalone.html";
    forceDownloadName = "Terrain-System-Standalone.html";
  } else if (clean === "/download/Final-Effect-3D-Standalone.html") {
    clean = "/Final-Effect-3D-Standalone.html";
    forceDownloadName = "Final-Effect-3D-Standalone.html";
  }
  if (clean === "/") clean = "/index.html";
  const rel = clean.replace(/^\/+/, "");
  if (rel.includes("..")) return null;

  const candidates = [
    path.join(BUILD_CLIENT, rel),
    path.join(ROOT, rel),
    path.join(ROOT, "wasm", rel),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { filePath: candidate, forceDownloadName };
    }
  }
  if (!path.extname(rel)) {
    const fallback = existsSync(path.join(BUILD_CLIENT, "index.html"))
      ? path.join(BUILD_CLIENT, "index.html")
      : path.join(ROOT, "index.html");
    if (existsSync(fallback)) return { filePath: fallback, forceDownloadName: null };
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  const resolved = resolveAsset(req.url || "/");
  if (!resolved) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const { filePath, forceDownloadName } = resolved;
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const body = readFileSync(filePath);

  const headers = {
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };
  if (forceDownloadName) {
    headers["Content-Disposition"] = `attachment; filename="${forceDownloadName}"`;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`Final Effect 3D Studio Preview listening on http://${HOST}:${PORT}`);
});
