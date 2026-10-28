import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* A leaf card is a leaf-shaped patch of opaque pixels on a transparent square,
   drawn with an alpha test. Ordinary mip generation averages alpha, and the
   average of "leaf, leaf, clear, clear" is not a leaf — it is 0.5, then 0.25,
   then below the material's `cut`, and the card stops drawing. A crown loses
   its leaves from the outside in as it recedes: the shredded-cutout look.

   These tests hold the replacement chain to three promises: coverage above the
   alpha test survives every mip, colour does not pick up a dark fringe from the
   transparent pixels around it, and the first level is untouched. */

const models = readFileSync('terrain-main-02.js', 'utf8');
const render = readFileSync('terrain-main-01.js', 'utf8');

function loadCoverage() {
  const start = models.indexOf('const COVER_KEEP=');
  const end = models.indexOf('const isPot=');
  assert.ok(start > 0 && end > start, 'the coverage chain is present as its own pure function');
  const factory = new Function(`${models.slice(start, end)}; return { coverageMips, COVER_KEEP };`);
  return factory();
}

/* A leaflet: a thin diagonal strip, about 7% of the square — the shape a real
   leaf card has, and the one that a mean alpha destroys first. */
function leafletPixels(n = 64, rgb = [220, 30, 24]) {
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const mid = 0.5 * n + 0.32 * (y - 0.5 * n);
      const d = Math.abs(x - mid);
      if (d > 2.7) continue;
      const i = (y * n + x) * 4;
      /* A soft one-texel edge, the way a painted leaf actually ends. */
      const a = d <= 1.7 ? 1 : 1 - (d - 1.7);
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  return px;
}

function coverage(level, threshold = 0.38 * 255) {
  let n = 0;
  for (let i = 3; i < level.data.length; i += 4) if (level.data[i] >= threshold) n++;
  return n / (level.width * level.height);
}

/* The chain a GPU would have built: plain box-averaged alpha. */
function naiveMips(rgba, w, h) {
  const chain = [{ data: rgba, width: w, height: h }];
  let src = rgba, sw = w, sh = h;
  while (sw > 1 || sh > 1) {
    const dw = Math.max(1, sw >> 1), dh = Math.max(1, sh >> 1), out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const o = (y * dw + x) * 4;
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((Math.min(sh - 1, y * 2 + dy)) * sw + Math.min(sw - 1, x * 2 + dx)) * 4;
            r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; count++;
          }
        }
        out[o] = Math.round(r / count);
        out[o + 1] = Math.round(g / count);
        out[o + 2] = Math.round(b / count);
        out[o + 3] = Math.round(a / count);
      }
    }
    chain.push({ data: out, width: dw, height: dh });
    src = out; sw = dw; sh = dh;
  }
  return chain;
}

test('the chain halves to a single texel and leaves level 0 alone', () => {
  const { coverageMips } = loadCoverage();
  const px = leafletPixels();
  const copy = Uint8Array.from(px);
  const chain = coverageMips(px, 64, 64);
  assert.equal(chain.length, 7, '64 -> 32 -> 16 -> 8 -> 4 -> 2 -> 1');
  assert.equal(chain[0].data, px, 'the base level is the texture itself, not a copy');
  assert.deepEqual(Array.from(px), Array.from(copy), 'the source is never written to');
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i].width, Math.max(1, chain[i - 1].width >> 1));
    assert.equal(chain[i].height, Math.max(1, chain[i - 1].height >> 1));
    assert.equal(chain[i].data.length, chain[i].width * chain[i].height * 4);
  }
});

test('coverage survives the mips that would otherwise erode the leaf away', () => {
  const { coverageMips, COVER_KEEP } = loadCoverage();
  assert.ok(COVER_KEEP > 0.5 && COVER_KEEP <= 1, 'alpha leans towards the strongest child, and says so');
  const px = leafletPixels();
  const ours = coverageMips(px, 64, 64);
  const naive = naiveMips(px, 64, 64);
  const base = coverage(ours[0]);
  assert.ok(base > 0.03 && base < 0.2, `a leaflet covers a small part of the card (${(base * 100).toFixed(1)}%)`);

  /* Coarse levels read as the strip smearing across neighbouring texels, which
     is why the erosion is measured where it actually bites: the fine end. The
     average falls under the alpha test at 4x4 and is gone; the coverage chain
     is still drawing the leaf at 1x1. */
  const dead = (chain) => chain.findIndex((level) => coverage(level) === 0);
  const naiveDead = dead(naive);
  const oursDead = dead(ours);
  assert.ok(naiveDead >= 1, 'the average does hold on for a level or two');
  assert.ok(naiveDead <= 4, `the average dies at ${naive[naiveDead].width}x${naive[naiveDead].height}`);
  assert.equal(oursDead, -1, 'the coverage chain never loses the leaf');

  /* At 8x8 — a crown a few pixels tall on screen — both still draw, but the
     average has already thinned to its last visible level. */
  assert.ok(coverage(ours[3]) >= base * 0.6, `8x8 keeps ${(coverage(ours[3]) / base * 100).toFixed(0)}% of the coverage`);

  /* The single-texel card decides whether a distant twig keeps its leaves. */
  const cut = Math.round(0.38 * 255);
  assert.ok(ours[6].data[3] >= cut, `ours still passes the cut (${ours[6].data[3]})`);
  assert.ok(naive[6].data[3] < cut, `the average would have failed it (${naive[6].data[3]})`);
});

test('the card keeps its shape: transparent corners stay transparent', () => {
  const { coverageMips } = loadCoverage();
  const chain = coverageMips(leafletPixels(), 64, 64);
  const level = chain[2]; // 16x16
  const at = (x, y) => level.data[(y * level.width + x) * 4 + 3];
  assert.equal(at(0, 0), 0, 'a corner of the card is still empty');
  assert.equal(at(level.width - 1, level.height - 1), 0);
  assert.ok(at(8, 8) > 0, 'and the leaf through the middle is not');
});

test('colour is averaged weighted by alpha, so leaves do not get a dark fringe', () => {
  const { coverageMips } = loadCoverage();
  const chain = coverageMips(leafletPixels(64, [220, 30, 24]), 64, 64);
  for (const level of chain.slice(1)) {
    for (let i = 0; i < level.data.length; i += 4) {
      if (level.data[i + 3] < 128) continue;
      /* Red leaf, transparent black around it: an unweighted average would drag
         the edge towards black and every leaf would be outlined in soot. */
      assert.ok(level.data[i] >= 200, `red survives (${level.data[i]} at ${level.width}x${level.height})`);
      assert.ok(level.data[i + 1] <= 45 && level.data[i + 2] <= 45, 'and the hue is unchanged');
    }
  }
});

test('every leaf-shaped texture is built through the coverage chain', () => {
  const built = models.match(/return mkCardTex\(c\)\}/g) || [];
  assert.equal(built.length, 6, 'leaf, species leaf, needle, petal, frond and leaflet cards');
  for (const name of ['leafTex', 'leafTexSpecies', 'needleTex', 'petalTex', 'frondTex', 'leafletTex']) {
    const start = models.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is still there`);
    const body = models.slice(start, models.indexOf('\nfunction ', start + 1));
    assert.match(body, /return mkCardTex\(c\)\}/, `${name} hands its canvas to the coverage path`);
  }
  /* The texture has to be a data texture with explicit mips, or the driver
     would generate the averaged chain again and undo the whole thing. */
  const start = models.indexOf('function mkCardTex(');
  const body = models.slice(start, models.indexOf('\nconst hsl=', start));
  assert.match(body, /t\.mipmaps=chain/);
  assert.match(body, /t\.generateMipmaps=false/);
  assert.match(body, /minFilter=THREE\.LinearMipmapLinearFilter/);
  assert.match(body, /if\(!c\|\|!c\.getContext\|\|!isPot\(c\.width\)\|\|!isPot\(c\.height\)\)return mkTex\(c,color\)/,
    'a non-power-of-two canvas falls back to the plain texture instead of uploading a broken chain');
  assert.match(body, /t\.image=c/, 'the canvas stays available for the normal and roughness maps');
});

test('the cards are still alpha-tested, and the edge is smoothed where MSAA exists', () => {
  /* Coverage-preserving mips are not a reason to stop testing: the transparent
     part of a card must still be discarded, or it would write depth over the
     sky and z-fight with the leaves behind it. */
  assert.match(render, /if\(o\.cut\)\{P\.alphaTest=o\.cut;if\(MSAA\)P\.alphaToCoverage=true\}/);
  assert.match(render, /const MSAA=\(\(\)=>\{try\{const a=ren\.getContext\(\)\.getContextAttributes\(\)/,
    'MSAA is read from the context, not assumed');
  assert.match(models, /map:OAKL,cut:\.38/, 'the oak cards keep their own threshold');
  assert.match(models, /map:NDT,cut:\.35/, 'so do the needles');
});

/* The function body is also run, not just read: a texture built the wrong way
   round (mipmaps on a CanvasTexture, filters left at the DataTexture default of
   nearest, the canvas dropped) would only show up on a device. */
function loadCardTex(THREE, mkTex) {
  const start = models.indexOf('const COVER_KEEP=');
  const end = models.indexOf('const hsl=');
  const factory = new Function('THREE', 'TEXA', 'mkTex', `${models.slice(start, end)}; return { mkCardTex, isPot };`);
  return factory(THREE, 4, mkTex);
}

function threeStub() {
  const textures = [];
  class DataTexture {
    constructor(data, width, height, format) {
      /* r128's Texture has `encoding`, not `colorSpace`, and that is the branch
         the studio actually takes. */
      Object.assign(this, { isDataTexture: true, image: { data, width, height }, format, mipmaps: [], generateMipmaps: true, needsUpdate: false, encoding: 3000 });
      textures.push(this);
    }
  }
  return {
    textures,
    THREE: {
      DataTexture,
      RGBAFormat: 1023,
      LinearMipmapLinearFilter: 1008,
      LinearFilter: 1006,
      NearestFilter: 1003,
      RepeatWrapping: 1000,
      sRGBEncoding: 3001,
      LinearEncoding: 3000
    }
  };
}

test('a card texture is uploaded with the chain, never regenerated by the driver', () => {
  const { THREE, textures } = threeStub();
  const { mkCardTex } = loadCardTex(THREE, (c) => ({ isCanvasTexture: true, image: c }));
  const px = leafletPixels(64);
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({ getImageData: () => ({ data: Uint8ClampedArray.from(px) }) })
  };
  const texture = mkCardTex(canvas);
  assert.equal(textures.length, 1);
  assert.equal(texture.isDataTexture, true, 'it is a data texture, so the mip array is used at all');
  assert.equal(texture.mipmaps.length, 7, 'all seven levels are uploaded');
  assert.equal(texture.mipmaps[0].width, 64);
  assert.equal(texture.mipmaps[6].width, 1);
  assert.equal(texture.generateMipmaps, false, 'the driver must not average the alpha back');
  assert.equal(texture.minFilter, THREE.LinearMipmapLinearFilter);
  assert.equal(texture.magFilter, THREE.LinearFilter);
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
  assert.equal(texture.anisotropy, 4);
  assert.equal(texture.encoding, 3001, 'albedo is a colour, so it is sRGB-decoded');
  assert.equal(texture.image, canvas, 'the canvas is still reachable for the normal/roughness derivations');
  assert.equal(texture.needsUpdate, true);
});

test('the last mip row order is the canvas, not flipped twice', () => {
  /* Rows go in bottom-first because a typed array is never flipped by the
     driver. If that reversal were dropped, every leaf texture would render
     upside down and nothing in the shader would say why. */
  const { THREE } = threeStub();
  const { mkCardTex } = loadCardTex(THREE, (c) => ({ isCanvasTexture: true, image: c }));
  const n = 4;
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      px[i] = y * 40; // a red ramp down the canvas
      px[i + 3] = 255;
    }
  }
  const canvas = { width: n, height: n, getContext: () => ({ getImageData: () => ({ data: Uint8ClampedArray.from(px) }) }) };
  const texture = mkCardTex(canvas);
  const base = texture.mipmaps[0].data;
  assert.equal(base[0], 3 * 40, 'the first uploaded row is the canvas last row');
  assert.equal(base[(n - 1) * n * 4], 0, 'and the last uploaded row is the canvas first row');
});

test('a canvas that is not a power of two falls back instead of uploading a broken chain', () => {
  const { THREE } = threeStub();
  let fell = 0;
  const { mkCardTex, isPot } = loadCardTex(THREE, () => { fell++; return { isCanvasTexture: true }; });
  assert.equal(isPot(64), true);
  assert.equal(isPot(96), false);
  const canvas = { width: 96, height: 64, getContext: () => ({}) };
  const texture = mkCardTex(canvas);
  assert.equal(fell, 1, 'the plain texture path was used');
  assert.equal(texture.isCanvasTexture, true);
});
