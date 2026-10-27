import { build } from 'esbuild';
import { resolve } from 'node:path';

const globalThree = {
  name: 'use-app-three-global',
  setup(api) {
    api.onResolve({ filter: /^three$/ }, () => ({ path: resolve('src/three-global-shim.mjs') }));
  },
};

await build({
  entryPoints: ['src/modifier-entry.mjs'],
  outfile: 'modifier-engine.js',
  bundle: true,
  minify: true,
  legalComments: 'none',
  format: 'iife',
  target: 'es2018',
  plugins: [globalThree],
});
await build({
  entryPoints: ['src/tessendorf-ocean.mjs'],
  outfile: 'tessendorf-ocean.js',
  bundle: true,
  minify: true,
  legalComments: 'none',
  format: 'iife',
  globalName: 'TessendorfOceanBundle',
  target: 'es2018',
});

console.log('Generated the modifier/ocean runtime bundles.');
