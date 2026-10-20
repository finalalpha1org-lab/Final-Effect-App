export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/download/Terrain-System-Standalone.html") {
      const assetUrl = new URL("/Terrain-System-Standalone.html", url);
      const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method, headers: request.headers }));
      if (assetResponse.status === 404) return assetResponse;
      const headers = new Headers(assetResponse.headers);
      headers.set("Content-Disposition", 'attachment; filename="Terrain-System-Standalone.html"');
      return new Response(request.method === "HEAD" ? null : assetResponse.body, { status: assetResponse.status, headers });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) return assetResponse;

    const method = request.method.toUpperCase();
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if ((method === "GET" || method === "HEAD") && acceptsHtml) {
      return env.ASSETS.fetch(new URL("/index.html", request.url));
    }

    return assetResponse;
  },
};
