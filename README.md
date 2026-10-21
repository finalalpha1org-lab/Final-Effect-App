# final-effect-3d

A dependency-light HTML, CSS, and JavaScript project scaffolded by camelAI.

## Structure

- Edit the browser experience in `public/index.html`, `public/styles.css`, and `public/main.js`.
- `worker.js` serves static assets and falls back to `index.html` for browser routes. It is also the upgrade seam for small server endpoints.
- `bun run build` copies deployable assets into `build/client` and writes the Worker manifest to `build/server`.

This starter is best for client-only experiences. If the product needs durable records, accounts, a shared leaderboard, or multiplayer state, the `crud` template is usually the better foundation.
