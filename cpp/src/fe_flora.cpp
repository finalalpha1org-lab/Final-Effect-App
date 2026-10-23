/* Landscape flora: procedural wood, canopies and rock meshes.
 * =========================================================================
 * The Landscaping Studio used to build every tree in JavaScript with a
 * hand-tuned recursive splitter (three children at 0.75 jitter, four levels),
 * which is why a row of oaks read as a row of copies: the *shape* was authored,
 * not grown. This file grows the skeleton instead, following the published
 * algorithms rather than any one implementation:
 *
 *   1. Space colonisation (Runions, Lane & Prusinkiewicz 2007) fills the crown
 *      with attraction points and grows branches toward them. It is what gives
 *      a tree its characteristic forking without anyone drawing it.
 *   2. da Vinci's rule (r_parent^2 = sum r_child^2) sizes every branch from the
 *      number of tips it ultimately feeds, so a limb that carries half the
 *      canopy is thick and a twig is a twig.
 *   3. Phyllotaxis (137.5 degrees, the golden angle) places leaves around each
 *      terminal, which is the botanical pattern behind a natural canopy.
 *   4. proctree-style parameters (taper, twist, gnarl) shape the trunk.
 *
 * Rocks follow the gl-rock recipe the studio already used in JS: clip a sphere
 * with random half-spaces, then displace it with gradient noise at several
 * octaves and rebuild the normals from the displaced surface by central
 * differences, so the silhouette and the shading agree.
 *
 * Everything is freestanding: fixed buffers, no allocation, no libm. The JS
 * side turns the buffers into BufferGeometry and places the leaf cards, which
 * keeps the GPU upload and the materials in the bridge where they belong.
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

namespace {

using namespace fe;

/* ---------------------------------------------------------------- */
/* Buffers (static, no allocator in a freestanding build)            */
/* ---------------------------------------------------------------- */
constexpr int32_t MAX_VERT = 24000;
constexpr int32_t MAX_IDX = 72000;
constexpr int32_t MAX_LEAF = 3200;
constexpr int32_t MAX_NODES = 420;
constexpr int32_t MAX_ATTRACTORS = 420;

float gPos[MAX_VERT * 3];
float gNrm[MAX_VERT * 3];
float gUv[MAX_VERT * 2];
float gCol[MAX_VERT * 3];
float gRnd[MAX_VERT];
float gCen[MAX_VERT * 3];
/* Skeletal wind: per-vertex compliance (0 at the root, 1 at a branch tip) and
   the phase that makes neighbouring limbs swing out of step. Baked from the
   skeleton, so the GPU can bend the real hierarchy instead of sliding the whole
   tree as one block. */
float gSway[MAX_VERT];
float gPhase[MAX_VERT];
float gPenSway = 0.0f;
float gPenPh = 0.0f;
uint32_t gIdx[MAX_IDX];
/* x, y, z, dir.x, dir.y, dir.z, size, colourT, sway, phase */
constexpr int32_t LEAF_STRIDE = 10;
float gLeaf[MAX_LEAF * LEAF_STRIDE];

int32_t gVert = 0;
int32_t gIdxN = 0;
int32_t gLeafN = 0;

/* ---------------------------------------------------------------- */
/* Deterministic RNG (xorshift32, same sequence as the other kernels) */
/* ---------------------------------------------------------------- */
struct Rng {
  uint32_t s;
  explicit Rng(uint32_t seed) : s(seed ? seed : 0x9e3779b9u) {}
  uint32_t next() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
  }
  float f() { return float(next() >> 8) * (1.0f / 16777216.0f); }
  float range(float a, float b) { return a + (b - a) * f(); }
  int irange(int a, int b) { return a + int(next() % uint32_t(b - a + 1)); }
};

/* ---------------------------------------------------------------- */
/* Tiny vector helpers                                               */
/* ---------------------------------------------------------------- */
struct V3 {
  float x, y, z;
};
inline V3 v3(float x, float y, float z) { V3 v; v.x = x; v.y = y; v.z = z; return v; }
inline V3 add(V3 a, V3 b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
inline V3 sub(V3 a, V3 b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
inline V3 mul(V3 a, float s) { return v3(a.x * s, a.y * s, a.z * s); }
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline float len(V3 a) { return sqrtf(dot(a, a)); }
inline V3 cross(V3 a, V3 b) {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
inline V3 norm(V3 a) {
  const float l = len(a);
  return l > 1e-6f ? mul(a, 1.0f / l) : v3(0.0f, 1.0f, 0.0f);
}

/* Natural log for the rock soft-clipping term. The freestanding build has no
 * libm, so reduce to [1,2) and use the atanh series (32-bit accurate to ~1e-6). */
inline float lnf(float x) {
  if (x <= 0.0f) return -20.0f;
  int32_t e = 0;
  while (x >= 2.0f) { x *= 0.5f; ++e; }
  while (x < 1.0f) { x *= 2.0f; --e; }
  const float z = (x - 1.0f) / (x + 1.0f);
  const float z2 = z * z;
  const float lnm = 2.0f * z * (1.0f + z2 * (0.3333333f + z2 * (0.2f +
                    z2 * (0.1428571f + z2 * (0.1111111f + z2 * 0.0909091f)))));
  return lnm + float(e) * 0.69314718f;
}

inline float dist2(V3 a, V3 b) {
  const float dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/* ---------------------------------------------------------------- */
/* Mesh emission                                                    */
/* ---------------------------------------------------------------- */
void resetMesh() {
  gVert = 0;
  gIdxN = 0;
  gLeafN = 0;
  gPenSway = 0.0f;
  gPenPh = 0.0f;
}

int32_t pushVert(V3 p, V3 n, float u, float v, float r, float g, float b, float rnd, V3 cen);

int32_t pushVert(V3 p, V3 n, float u, float v, float shade, float rnd, V3 cen) {
  return pushVert(p, n, u, v, shade, shade * 1.0f, shade * 1.0f, rnd, cen);
}

int32_t pushVert(V3 p, V3 n, float u, float v, float r, float g, float b, float rnd, V3 cen) {
  if (gVert >= MAX_VERT) return -1;
  const int32_t i = gVert++;
  gPos[i * 3 + 0] = p.x; gPos[i * 3 + 1] = p.y; gPos[i * 3 + 2] = p.z;
  gNrm[i * 3 + 0] = n.x; gNrm[i * 3 + 1] = n.y; gNrm[i * 3 + 2] = n.z;
  gUv[i * 2 + 0] = u;    gUv[i * 2 + 1] = v;
  gCol[i * 3 + 0] = r; gCol[i * 3 + 1] = g; gCol[i * 3 + 2] = b;
  gRnd[i] = rnd;
  gCen[i * 3 + 0] = cen.x; gCen[i * 3 + 1] = cen.y; gCen[i * 3 + 2] = cen.z;
  gSway[i] = gPenSway;
  gPhase[i] = gPenPh;
  return i;
}

void pushTri(int32_t a, int32_t b, int32_t c) {
  if (a < 0 || b < 0 || c < 0 || gIdxN + 3 > MAX_IDX) return;
  gIdx[gIdxN++] = uint32_t(a);
  gIdx[gIdxN++] = uint32_t(b);
  gIdx[gIdxN++] = uint32_t(c);
}

/* Cylinder between two points. `hint` carries the previous ring's frame so a
 * chain of segments does not visibly twist; returns the frame to pass on. */
V3 tubeSegment(V3 a, V3 b, float r0, float r1, int32_t sides, float v0,
               float uvScale, float shade, float rnd, V3 hint, bool capEnd,
               float sway0 = 0.0f, float sway1 = 0.0f, float ph = 0.0f) {
  const V3 d = norm(sub(b, a));
  V3 u = sub(hint, mul(d, dot(hint, d)));
  if (len(u) < 1e-4f) {
    const V3 ref = absf(d.y) > 0.95f ? v3(1.0f, 0.0f, 0.0f) : v3(0.0f, 1.0f, 0.0f);
    u = sub(ref, mul(d, dot(ref, d)));
  }
  u = norm(u);
  const V3 w = cross(d, u);
  const V3 cen = mul(add(a, b), 0.5f);
  const float length = len(sub(b, a));
  const int32_t start = gVert;

  for (int32_t ring = 0; ring < 2; ++ring) {
    const V3 c = ring ? b : a;
    const float r = ring ? r1 : r0;
    gPenSway = ring ? sway1 : sway0;
    gPenPh = ph;
    for (int32_t j = 0; j <= sides; ++j) {
      const float th = (float(j) / float(sides)) * kTwoPi;
      const float cs = cosf(th), sn = sinf(th);
      const V3 n = v3(u.x * cs + w.x * sn, u.y * cs + w.y * sn, u.z * cs + w.z * sn);
      pushVert(add(c, mul(n, r)), n, float(j) / float(sides), v0 + (ring ? length : 0.0f) * uvScale,
               shade, rnd, cen);
    }
  }
  const int32_t stride = sides + 1;
  for (int32_t j = 0; j < sides; ++j) {
    const int32_t a0 = start + j, a1 = start + j + 1;
    const int32_t b0 = start + stride + j, b1 = start + stride + j + 1;
    pushTri(a0, b0, a1);
    pushTri(a1, b0, b1);
  }
  if (capEnd && r1 > 1e-3f) {
    gPenSway = sway1;
    gPenPh = ph;
    const int32_t c = pushVert(b, d, 0.5f, v0 + length * uvScale, shade * 0.92f, rnd, cen);
    for (int32_t j = 0; j < sides; ++j) {
      const int32_t a0 = start + stride + j, a1 = start + stride + j + 1;
      pushTri(a0, c, a1);
    }
  }
  gPenSway = 0.0f;
  gPenPh = 0.0f;
  return u;
}

/* ---------------------------------------------------------------- */
/* Species table — real habit parameters, not decoration            */
/* ---------------------------------------------------------------- */
enum Species {
  SP_OAK = 0,
  SP_BIRCH,
  SP_ACACIA,
  SP_SHRUB,
  SP_ASHBUSH,
  SP_DEADTREE,
  /* Herbaceous species are grown by a strict L-system instead of colonisation:
     a fern is a frond grammar, not a search for light. */
  SP_FERN,
  SP_TREEFERN,
  SP_COUNT
};

struct SpeciesSpec {
  float trunkTop;     /* metres of clear trunk before the crown starts   */
  float trunkRadius;  /* radius at the root collar                       */
  float crownY;       /* crown centre height                             */
  float crownRX;      /* horizontal crown radius                         */
  float crownRY;      /* vertical crown radius                           */
  float tipRadius;    /* radius of the finest branch                     */
  int32_t segments;   /* trunk segments                                  */
  int32_t attractors; /* space-colonisation points                       */
  float step;         /* growth step as a fraction of crown radius       */
  int32_t maxDepth;   /* growth rings before the colony stops            */
  int32_t tubes;      /* ring sides at the thickest branch               */
  float leafSize;     /* anchor size multiplier for the card placer      */
  int32_t cards;      /* leaf cards per terminal (read by the JS bridge) */
  uint8_t leaves;     /* 0 for a dead snag                               */
};

/* Ordered to match FELandscapeFlora.KINDS in JS. */
const SpeciesSpec kSpecies[SP_COUNT] = {
  /* oak     */ { 4.4f, 0.62f, 6.2f, 3.9f, 2.7f, 0.022f, 12, 360, 0.085f, 7, 8, 1.05f, 4, 1 },
  /* birch   */ { 5.4f, 0.24f, 7.2f, 2.1f, 2.9f, 0.014f, 14, 300, 0.075f, 8, 6, 0.80f, 3, 1 },
  /* acacia  */ { 3.4f, 0.34f, 5.0f, 4.2f, 1.2f, 0.018f, 10, 320, 0.085f, 7, 7, 0.72f, 4, 1 },
  /* shrub   */ { 0.30f, 0.055f, 0.78f, 1.00f, 0.62f, 0.010f, 7, 220, 0.095f, 6, 5, 0.50f, 3, 1 },
  /* ashbush */ { 0.45f, 0.075f, 1.15f, 1.35f, 0.80f, 0.010f, 8, 260, 0.090f, 7, 5, 0.60f, 3, 1 },
  /* deadtree*/ { 3.0f, 0.34f, 5.4f, 2.6f, 2.4f, 0.016f, 11, 260, 0.090f, 6, 6, 0.00f, 0, 0 },
  /* fern    */ { 0.02f, 0.012f, 0.42f, 0.85f, 0.40f, 0.004f, 2, 0, 0.050f, 1, 4, 0.16f, 2, 1 },
  /* treefern*/ { 1.60f, 0.10f, 1.95f, 1.10f, 0.55f, 0.008f, 6, 0, 0.060f, 1, 5, 0.22f, 2, 1 }
};

/* ---------------------------------------------------------------- */
/* Skeleton                                                         */
/* ---------------------------------------------------------------- */
struct Node {
  V3 p;
  int32_t parent;
  int32_t tips;    /* terminal descendants, drives da Vinci radii */
  float radius;
  float len;       /* accumulated distance from the root          */
  uint8_t terminal;
};

Node gNodes[MAX_NODES];
int32_t gNodeN = 0;
/* Swing phase accumulated down each branch path. Two limbs of equal length
   still get different phases because the path that reached them differs. */
float gNodePh[MAX_NODES];

struct Att {
  V3 p;
  uint8_t alive;
};

Att gAtts[MAX_ATTRACTORS];
int32_t gAttN = 0;

/* Small gradient-noise value in [-1, 1] for gnarl and rock displacement. */
inline float hash3(int32_t x, int32_t y, int32_t z, uint32_t seed) {
  uint32_t h = uint32_t(x) * 0x8da6b343u ^ uint32_t(y) * 0xd8163841u ^
               uint32_t(z) * 0xcb1ab31fu ^ seed;
  h ^= h >> 15;
  h *= 0x2c1b3c6du;
  h ^= h >> 12;
  h *= 0x297a2d39u;
  h ^= h >> 15;
  return float(h & 0xffffffu) * (1.0f / 8388607.5f) - 1.0f;
}

float valueNoise(V3 p, uint32_t seed) {
  const float fx = floorf(p.x), fy = floorf(p.y), fz = floorf(p.z);
  const int32_t ix = int32_t(fx), iy = int32_t(fy), iz = int32_t(fz);
  const float tx = p.x - fx, ty = p.y - fy, tz = p.z - fz;
  const float sx = tx * tx * (3.0f - 2.0f * tx);
  const float sy = ty * ty * (3.0f - 2.0f * ty);
  const float sz = tz * tz * (3.0f - 2.0f * tz);
  float c[8];
  for (int32_t k = 0; k < 8; ++k) {
    c[k] = hash3(ix + (k & 1), iy + ((k >> 1) & 1), iz + ((k >> 2) & 1), seed);
  }
  const float c00 = lerpf(c[0], c[1], sx);
  const float c10 = lerpf(c[2], c[3], sx);
  const float c01 = lerpf(c[4], c[5], sx);
  const float c11 = lerpf(c[6], c[7], sx);
  return lerpf(lerpf(c00, c10, sy), lerpf(c01, c11, sy), sz);
}

float fbm(V3 p, uint32_t seed, int32_t octaves) {
  float sum = 0.0f, amp = 0.5f, freq = 1.0f;
  for (int32_t i = 0; i < octaves; ++i) {
    sum += valueNoise(mul(p, freq), seed + uint32_t(i) * 1013u) * amp;
    amp *= 0.5f;
    freq *= 2.03f;
  }
  return sum;
}

int32_t addNode(V3 p, int32_t parent, float lenAcc) {
  if (gNodeN >= MAX_NODES) return -1;
  const int32_t i = gNodeN++;
  gNodes[i].p = p;
  gNodes[i].parent = parent;
  gNodes[i].tips = 1;
  gNodes[i].radius = 0.0f;
  gNodes[i].len = lenAcc;
  gNodes[i].terminal = 0;
  return i;
}

/* Trunk: a leaning, slightly S-curved column with a flared collar, the shape
 * proctree exposes as taper/twist/gnarl. */
/* Cantilever compliance along the skeleton: the root collar does not move, the
   crown sways, a terminal twig swings most. Using the accumulated branch length
   (not the height) is what makes a side limb bend even when its tip sits low. */
inline float swayOf(float len, float radius, const SpeciesSpec& s) {
  const float treeH = maxf(0.6f, s.crownY + s.crownRY);
  const float path = clampf((len - s.trunkTop * 0.5f) / (treeH * 0.55f), 0.0f, 1.0f);
  /* Thickness proxy. A limb as thick as the trunk keeps only 55% of its path
     compliance; a twig a third of that is fully compliant. This is the part a
     vertex-height law cannot express and the reason the shader also scales the
     bend frequency by aSway: a whip moves further *and* faster than a limb. */
  const float thin = clampf(1.0f - radius / maxf(0.02f, s.trunkRadius * 0.60f), 0.0f, 1.0f);
  return clampf(path * (0.55f + 0.45f * thin), 0.0f, 1.0f);
}

int32_t buildTrunk(const SpeciesSpec& s, Rng& rng, V3& outFrame) {
  const float lean = rng.range(-0.12f, 0.12f);
  const float leanZ = rng.range(-0.12f, 0.12f);
  const float wobble = rng.range(0.0f, 1.0f) * 0.35f;
  int32_t prev = addNode(v3(0.0f, 0.0f, 0.0f), -1, 0.0f);
  if (prev < 0) return -1;
  gNodePh[prev] = 0.0f;
  V3 frame = v3(1.0f, 0.0f, 0.0f);
  for (int32_t i = 1; i <= s.segments; ++i) {
    const float t = float(i) / float(s.segments);
    const float y = s.trunkTop * t;
    const float sway = sinf(t * 3.1f + wobble * 3.0f) * 0.06f * s.trunkTop;
    const V3 p = v3(lean * y * y * 0.12f + sway, y, leanZ * y * y * 0.12f + sway * 0.6f);
    const int32_t idx = addNode(p, prev, s.trunkTop * t);
    if (idx < 0) return prev;
    const float r0 = s.trunkRadius * (1.0f - 0.72f * float(i - 1) / float(s.segments));
    const float r1 = s.trunkRadius * (1.0f - 0.72f * t);
    const float shade = 0.70f + 0.30f * clampf(p.y / (s.trunkTop + 1.0f), 0.0f, 1.0f);
    const float segLen = len(sub(p, gNodes[prev].p));
    const float ph = gNodePh[prev] + segLen * 1.6f;
    frame = tubeSegment(gNodes[prev].p, p, r0, r1, s.tubes, s.trunkTop * t * 0.35f, 0.35f,
                        shade, 0.35f + 0.3f * t, frame, false,
                        swayOf(gNodes[prev].len, r0, s), swayOf(gNodes[idx].len, r1, s), ph);
    gNodePh[idx] = ph;
    prev = idx;
  }
  outFrame = frame;
  return prev;
}

/* Space colonisation (Runions et al. 2007). Attraction points fill the crown;
 * each growth step pulls the nearest node toward the points that can see it. */
void colonise(const SpeciesSpec& s, Rng& rng, int32_t from) {
  const V3 centre = v3(gNodes[from].p.x, s.crownY, gNodes[from].p.z);
  gAttN = 0;
  const int32_t wanted = s.attractors;
  const float minY = s.crownY - s.crownRY * 0.92f;
  int32_t guard = 0;
  while (gAttN < wanted && guard++ < wanted * 6) {
    const float u = rng.range(-1.0f, 1.0f);
    const float a = rng.range(0.0f, kTwoPi);
    const float r = powf(rng.f(), 0.34f); /* bias outward so the shell fills */
    const float hx = cosf(a) * r, hz = sinf(a) * r;
    const V3 p = v3(centre.x + hx * s.crownRX,
                    s.crownY + u * s.crownRY,
                    centre.z + hz * s.crownRX);
    /* Keep the crown an ellipsoid, not a cube, and never inside the wood. */
    const float nx = (p.x - centre.x) / s.crownRX;
    const float ny = (p.y - s.crownY) / s.crownRY;
    const float nz = (p.z - centre.z) / s.crownRX;
    if (nx * nx + ny * ny + nz * nz > 1.0f) continue;
    if (p.y < minY) continue;
    V3 nearest = gNodes[from].p;
    float best = dist2(p, nearest);
    for (int32_t i = 0; i < gNodeN; ++i) {
      const float d = dist2(p, gNodes[i].p);
      if (d < best) { best = d; nearest = gNodes[i].p; }
    }
    if (best < (s.tipRadius * 6.0f) * (s.tipRadius * 6.0f)) continue;
    gAtts[gAttN].p = p;
    gAtts[gAttN].alive = 1;
    ++gAttN;
  }
  if (!gAttN) return;

  const float influence = s.crownRX * 0.46f + s.crownRY * 0.18f;
  const float influence2 = influence * influence;
  const float kill = s.crownRX * 0.17f;
  const float kill2 = kill * kill;
  const float stepLen = s.step * (s.crownRX + s.crownRY) * 0.5f;

  V3 sum[MAX_NODES];
  int32_t count[MAX_NODES];

  for (int32_t iter = 0; iter < 48; ++iter) {
    if (gNodeN >= MAX_NODES - 2) break;
    bool anyAlive = false;
    for (int32_t i = 0; i < gNodeN; ++i) { sum[i] = v3(0.0f, 0.0f, 0.0f); count[i] = 0; }

    for (int32_t a = 0; a < gAttN; ++a) {
      if (!gAtts[a].alive) continue;
      anyAlive = true;
      int32_t bestNode = -1;
      float best = influence2;
      for (int32_t i = 0; i < gNodeN; ++i) {
        const float d = dist2(gAtts[a].p, gNodes[i].p);
        if (d < best) { best = d; bestNode = i; }
      }
      if (bestNode < 0) continue;
      const V3 dir = norm(sub(gAtts[a].p, gNodes[bestNode].p));
      sum[bestNode] = add(sum[bestNode], dir);
      count[bestNode] += 1;
    }
    if (!anyAlive) break;

    bool grew = false;
    const int32_t before = gNodeN;
    for (int32_t i = 0; i < before; ++i) {
      if (count[i] == 0) continue;
      V3 dir = norm(sum[i]);
      /* Positive phototropism: real branches bend toward the light. */
      dir = norm(v3(dir.x, dir.y + 0.22f * (1.0f - clampf(gNodes[i].p.y / (s.crownY + s.crownRY), 0.0f, 1.0f)), dir.z));
      const V3 p = add(gNodes[i].p, mul(dir, stepLen));
      if (p.y < 0.05f) continue;
      if (addNode(p, i, gNodes[i].len + stepLen) < 0) break;
      grew = true;
    }
    if (!grew) break;

    for (int32_t a = 0; a < gAttN; ++a) {
      if (!gAtts[a].alive) continue;
      for (int32_t i = before; i < gNodeN; ++i) {
        if (dist2(gAtts[a].p, gNodes[i].p) < kill2) { gAtts[a].alive = 0; break; }
      }
    }
  }

  /* Terminal nodes and da Vinci radii. */
  for (int32_t i = 0; i < gNodeN; ++i) gNodes[i].terminal = 1;
  for (int32_t i = gNodeN - 1; i >= 0; --i) {
    int32_t parent = gNodes[i].parent;
    if (parent >= 0) {
      gNodes[parent].terminal = 0;
      gNodes[parent].tips += gNodes[i].tips;
    }
  }
  int32_t totalTips = 0;
  for (int32_t i = 0; i < gNodeN; ++i) {
    if (gNodes[i].terminal) totalTips += 1;
  }
  if (totalTips < 1) totalTips = 1;
  const float trunkTopR = s.trunkRadius * 0.28f;
  for (int32_t i = 0; i < gNodeN; ++i) {
    const float share = float(gNodes[i].tips) / float(totalTips);
    /* r ~ sqrt(share): the da Vinci exponent over the number of tips fed. */
    float r = trunkTopR * sqrtf(clampf(share, 0.0f, 1.0f));
    gNodes[i].radius = maxf(r, s.tipRadius);
  }
}

/* Meshes every colonisation edge as a chain of tapered tubes. */
void meshBranches(const SpeciesSpec& s, Rng& rng, int32_t firstBranch, V3 hint) {
  V3 frames[MAX_NODES];
  for (int32_t i = 0; i < gNodeN; ++i) frames[i] = hint;
  for (int32_t i = firstBranch; i < gNodeN; ++i) {
    const int32_t parent = gNodes[i].parent;
    if (parent < 0) continue;
    const V3 a = gNodes[parent].p;
    const V3 b = gNodes[i].p;
    const float r0 = gNodes[parent].radius * 1.05f;
    const float r1 = gNodes[i].radius;
    const int32_t sides = int32_t(clampf(3.0f + r0 * 7.0f, 3.0f, float(s.tubes)));
    const float gnarl = fbm(mul(b, 0.55f), 0x51ed270bu, 2) * 0.05f * r0;
    const V3 offset = norm(cross(sub(b, a), v3(0.0f, 1.0f, 0.0f)));
    const V3 start = add(a, mul(offset, gnarl));
    const V3 end = add(b, mul(offset, -gnarl * 0.6f));
    const float shade = 0.70f + 0.30f * clampf(b.y / (s.crownY + s.crownRY), 0.0f, 1.0f);
    const float rnd = 0.15f + rng.f() * 0.85f;
    const float ph = gNodePh[parent] + len(sub(b, a)) * 1.6f;
    gNodePh[i] = ph;
    frames[i] = tubeSegment(start, end, r0, r1, sides, gNodes[parent].len * 0.35f, 0.35f,
                            shade, rnd, frames[parent], gNodes[i].terminal != 0,
                            swayOf(gNodes[parent].len, r0, s), swayOf(gNodes[i].len, r1, s), ph);
  }
}

/* Phyllotaxis: the golden angle keeps successive leaves from shading each
 * other, so the canopy fills evenly instead of in visible rings. */
void emitLeafAnchors(const SpeciesSpec& s, Rng& rng, int32_t firstBranch) {
  if (!s.leaves) return;
  const float golden = 2.39996323f; /* 137.5 degrees */
  float phase = rng.range(0.0f, kTwoPi);
  for (int32_t i = firstBranch; i < gNodeN; ++i) {
    if (!gNodes[i].terminal) continue;
    const V3 p = gNodes[i].p;
    const V3 outward = norm(sub(p, v3(0.0f, s.crownY, 0.0f)));
    const float t = clampf((p.y - (s.crownY - s.crownRY)) / (2.0f * s.crownRY), 0.0f, 1.0f);
    for (int32_t c = 0; c < s.cards; ++c) {
      if (gLeafN >= MAX_LEAF) return;
      phase += golden;
      const float ring = 0.55f + 0.45f * rng.f();
      const V3 d = norm(v3(outward.x * ring + cosf(phase) * 0.55f,
                           -0.15f + rng.range(-0.25f, 0.55f),
                           outward.z * ring + sinf(phase) * 0.55f));
      float* leaf = &gLeaf[gLeafN * LEAF_STRIDE];
      leaf[0] = p.x + d.x * 0.03f;
      leaf[1] = p.y + d.y * 0.03f;
      leaf[2] = p.z + d.z * 0.03f;
      leaf[3] = d.x; leaf[4] = d.y; leaf[5] = d.z;
      leaf[6] = s.leafSize * (0.78f + 0.42f * rng.f());
      leaf[7] = 0.2f + 0.8f * t;
      /* The card inherits its branch tip's compliance and phase, so leaves ride
         the limb instead of fluttering in place. */
      leaf[8] = swayOf(gNodes[i].len, gNodes[i].radius, s);
      leaf[9] = gNodePh[i];
      ++gLeafN;
    }
  }
}

/* ---------------------------------------------------------------- */
/* Rocks                                                            */
/* ---------------------------------------------------------------- */
/* A faithful port of the studio's own gl-rock recipe: clip a sphere with
 * random half-spaces, displace it with a product-of-sines "trig noise", rebuild
 * the normals from the displaced surface, then paint it from slope, banding and
 * large-scale mottling, with lichen creeping onto upward faces. Ported rather
 * than re-invented so the silhouettes stay the ones the scene was tuned
 * against while the maths moves into the engine. */
enum RockKind { ROCK_GRANITE = 0, ROCK_SANDSTONE, ROCK_BASALT, ROCK_COUNT };

struct RockSpec {
  int32_t planes;
  float tint[3];
  float moss;      /* lichen mask strength: 0 = too young/bare for a crust */
  float banding;   /* sedimentary banding weight                          */
};

const RockSpec kRock[ROCK_COUNT] = {
  /* granite   */ { 6, { 1.00f, 1.00f, 1.00f }, 1.00f, 0.07f },
  /* sandstone */ { 6, { 1.40f, 0.98f, 0.68f }, 0.25f, 0.17f },
  /* basalt    */ { 9, { 0.34f, 0.33f, 0.34f }, 0.00f, 0.07f }
};

struct Plane {
  V3 n;
  float d;
};

Plane gPlanes[14];
float gRockPhase = 0.0f;

inline float trigNoise(float x, float y, float z, float ph) {
  return sinf(x * 2.3f + 1.3f + ph) * sinf(y * 2.9f + 2.1f + ph * 0.7f) *
         sinf(z * 2.1f + 3.3f - ph * 0.5f);
}

int32_t generateRock(int32_t kind, uint32_t seed, int32_t detail) {
  const int32_t id = (kind < 0 || kind >= ROCK_COUNT) ? 0 : kind;
  const RockSpec& rs = kRock[id];
  Rng rng(seed ^ 0x9e3779b9u);
  const float ph = rng.range(0.0f, 10.0f);
  const int32_t planeCount = rs.planes + rng.irange(0, 2);
  for (int32_t i = 0; i < planeCount && i < 14; ++i) {
    const float a = rng.range(0.0f, kTwoPi);
    const float b = rng.range(-1.0f, 1.0f);
    const float c = sqrtf(maxf(0.0f, 1.0f - b * b));
    gPlanes[i].n = v3(cosf(a) * c, b, sinf(a) * c);
    gPlanes[i].d = rng.range(0.5f, 0.9f);
  }
  const float sx = rng.range(0.95f, 1.35f);
  const float sy = rng.range(0.55f, 0.90f);
  const float sz = rng.range(0.80f, 1.20f);

  auto radiusAt = [&](V3 dir) -> float {
    float sum = 0.0f;
    for (int32_t i = 0; i < planeCount; ++i) {
      const float d = dot(gPlanes[i].n, dir);
      if (d > 0.05f) sum += expf(-10.0f * (gPlanes[i].d / d));
    }
    const float base = sum > 0.0f ? minf(1.15f, -lnf(sum) * 0.1f) : 1.1f;
    return base * (1.0f + 0.10f * trigNoise(dir.x * 2.2f, dir.y * 2.2f, dir.z * 2.2f, ph) +
                   0.050f * trigNoise(dir.x * 5.0f, dir.y * 5.0f, dir.z * 5.0f, ph) +
                   0.020f * trigNoise(dir.x * 11.0f, dir.y * 11.0f, dir.z * 11.0f, ph) +
                   0.012f * trigNoise(dir.x * 23.0f, dir.y * 23.0f, dir.z * 23.0f, ph) +
                   0.015f * sinf(dir.y * 18.0f + trigNoise(dir.x, dir.y, dir.z, ph) * 4.0f));
  };

  auto pointAt = [&](V3 d) -> V3 {
    const float l = len(d) > 1e-6f ? len(d) : 1.0f;
    const float r = radiusAt(norm(d));
    return v3(d.x / l * r * sx, d.y / l * r * sy + 0.45f, d.z / l * r * sz);
  };

  const int32_t nu = detail >= 2 ? 40 : 32;
  const int32_t nv = detail >= 2 ? 26 : 20;
  const float eps = 0.012f;
  int32_t prevRow = -1;

  for (int32_t j = 0; j <= nv; ++j) {
    const float th = float(j) / float(nv) * kPi;
    const float st = sinf(th), ct = cosf(th);
    const int32_t rowStart = gVert;
    for (int32_t i = 0; i <= nu; ++i) {
      const float f = float(i) / float(nu) * kTwoPi;
      const float sf = sinf(f), cf = cosf(f);
      const V3 d = v3(st * cf, ct, st * sf);
      const V3 e1 = v3(ct * cf, -st, ct * sf);
      const V3 e2 = v3(-sf, 0.0f, cf);
      const V3 pa = pointAt(add(d, mul(e1, eps)));
      const V3 pb = pointAt(sub(d, mul(e1, eps)));
      const V3 pc = pointAt(add(d, mul(e2, eps)));
      const V3 pd = pointAt(sub(d, mul(e2, eps)));
      const V3 p = pointAt(d);
      V3 n = norm(cross(sub(pa, pb), sub(pc, pd)));
      if (dot(n, sub(p, v3(0.0f, 0.45f, 0.0f))) < 0.0f) n = mul(n, -1.0f);

      const float nn = 0.5f + 0.5f * trigNoise(p.x * 3.0f, p.y * 3.0f, p.z * 3.0f, ph);
      const float bd = 0.5f + 0.5f * sinf(p.y * 16.0f +
                       trigNoise(p.x * 2.0f, p.y * 2.0f, p.z * 2.0f, ph) * 3.0f);
      const float lc = 0.5f + 0.5f * trigNoise(p.x * 10.0f, p.y * 10.0f, p.z * 10.0f, ph);
      const float moss = maxf(0.0f, n.y - 0.55f) * 2.2f * (0.5f + 0.5f * nn) *
                         (0.5f + 0.5f * lc) * rs.moss;
      const float q = 0.44f + 0.12f * nn + rs.banding * bd +
                      0.05f * clampf((p.y + 0.4f) / 1.6f, 0.0f, 1.0f);
      const float rr = ((q + 0.025f) * (1.0f - moss) + 0.17f * moss) * rs.tint[0];
      const float gg = ((q + 0.008f) * (1.0f - moss) + 0.27f * moss) * rs.tint[1];
      const float bb = ((q - 0.020f) * (1.0f - moss) + 0.09f * moss) * rs.tint[2];
      pushVert(p, n, float(i) / float(nu), float(j) / float(nv), rr, gg, bb,
               nn, v3(0.0f, 0.45f, 0.0f));
      if (prevRow >= 0 && i > 0) {
        const int32_t a0 = prevRow + i - 1, a1 = prevRow + i;
        const int32_t b0 = rowStart + i - 1, b1 = rowStart + i;
        if (j > 1) pushTri(a0, b0, a1);
        if (j < nv) pushTri(a1, b0, b1);
      }
    }
    prevRow = rowStart;
  }
  return gVert;
}


/* ---------------------------------------------------------------- */
/* Strict L-system (formal grammar)                                  */
/* ---------------------------------------------------------------- */
/* A real string-rewriting system, not a recursive splitter: an axiom is
 * rewritten by production rules for N iterations, then a 3D turtle walks the
 * resulting word. Symbols follow Prusinkiewicz & Lindenmayer:
 *
 *   F  draw a segment        X  state symbol (no geometry)
 *   +  yaw left   -  yaw right
 *   &  pitch down ^  pitch up
 *   /  roll left  \  roll right
 *   [  push state ]  pop state
 *
 * The rules are stochastic (a seeded choice between alternatives), so one
 * grammar produces a different frond for every world seed while a given seed
 * always replays the same plant.
 */
constexpr int32_t LS_MAX = 6144;
char gLsA[LS_MAX];
char gLsB[LS_MAX];
char gLsWord[LS_MAX];
int32_t gLsWordN = 0;

struct LsProd {
  char pre;
  uint8_t n;
  const char* alt[2];
};

/* Textbook fern frond: X -> F[+X]F[-X]+X with F -> FF (The Algorithmic Beauty
 * of Plants, ch. 1). The second alternative mirrors the pinnae, so the frond
 * does not come out as a symmetric fishbone. */
const LsProd kFernRules[2] = {
  { 'X', 2, { "F[+X]F[-X]+X", "F[-X]F[+X]-X" } },
  { 'F', 1, { "FF", nullptr } }
};

/* A rule set supplied at runtime. The studio does not ship a rule editor yet,
 * but the kernel already accepts one: an axiom plus up to eight productions,
 * each with two alternatives, packed as bytes by the bridge. */
constexpr int32_t LS_RULES = 8;
constexpr int32_t LS_ALT = 96;
struct UserRule {
  char pre;
  int32_t n;
  char alt[2][LS_ALT];
};
UserRule gUserRule[LS_RULES];
LsProd gUserProd[LS_RULES];
int32_t gUserRuleN = 0;
char gUserAxiom[LS_ALT];

/* Runtime shape controls (the studio's Tree height / Branch density sliders).
   They scale a *copy* of the species table, so the table stays the botanical
   reference and the sliders never destroy it. */
float gShapeH = 1.0f;
float gShapeD = 1.0f;

void applyShape(SpeciesSpec& s) {
  if (gShapeH == 1.0f && gShapeD == 1.0f) return;
  const float h = gShapeH, d = gShapeD;
  s.trunkTop *= h;
  s.crownY *= h;
  s.crownRY *= h;
  /* A taller tree carries a slightly thicker stem (elastic similarity). */
  s.trunkRadius *= 0.55f + 0.45f * h;
  s.crownRX *= (0.72f + 0.28f * h) * (0.85f + 0.15f * d);
  const int32_t a = int32_t(float(s.attractors) * d + 0.5f);
  s.attractors = a < 16 ? 16 : (a > 380 ? 380 : a);
  const int32_t seg = int32_t(float(s.segments) * (0.85f + 0.15f * d) + 0.5f);
  s.segments = seg < 3 ? 3 : (seg > 26 ? 26 : seg);
}

int32_t lsExpand(const LsProd* rules, int32_t ruleN, const char* axiom,
                 int32_t iterations, Rng& rng) {
  int32_t n = 0;
  while (axiom[n] && n < LS_MAX - 1) { gLsA[n] = axiom[n]; ++n; }
  gLsA[n] = 0;
  for (int32_t it = 0; it < iterations; ++it) {
    int32_t out = 0;
    for (int32_t i = 0; i < n; ++i) {
      const char c = gLsA[i];
      const LsProd* hit = nullptr;
      for (int32_t r = 0; r < ruleN; ++r) {
        if (rules[r].pre == c) { hit = &rules[r]; break; }
      }
      if (!hit) {
        if (out >= LS_MAX - 1) { out = LS_MAX - 1; break; }
        gLsB[out++] = c;
        continue;
      }
      const char* rep = hit->n > 1 ? hit->alt[rng.f() < 0.5f ? 0 : 1] : hit->alt[0];
      for (int32_t k = 0; rep && rep[k]; ++k) {
        if (out >= LS_MAX - 1) break;
        gLsB[out++] = rep[k];
      }
      if (out >= LS_MAX - 1) break;
    }
    gLsB[out] = 0;
    for (int32_t i = 0; i <= out; ++i) gLsA[i] = gLsB[i];
    n = out;
  }
  return n;
}

inline V3 rotAxis(V3 v, V3 axis, float a) {
  const float c = cosf(a), s = sinf(a);
  const V3 k = norm(axis);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1.0f - c)));
}

struct LsTurtle {
  V3 p, dir, up;
  float w;      /* segment radius */
  float ph;     /* swing phase */
  float len;    /* distance travelled since the base of this frond */
  float step;   /* segment length */
  float droop;  /* radians of gravity per segment */
  float maxLen; /* nominal frond length of the current axis */
  float swayBase; /* compliance where this axis was attached */
  float swayPrev; /* compliance at the end of the previous segment */
};

constexpr int32_t LS_STACK = 40;

/* Parameters the turtle needs from whoever owns the grammar. Keeping them in
 * one struct is what lets the built-in frond and a rule set typed in at
 * runtime share a single interpreter. */
struct LsStyle {
  int32_t leaves;    /* emit pinnae along the rachis? */
  int32_t sides;     /* radial segments per tube */
  float leafSize;
  float yaw;         /* radians per + / - */
  float pitch;       /* radians per & / ^ */
  float scale;       /* parametric thinning per branch order */
};

/* Walks the word once. The vertex budget is checked every segment so a runaway
 * grammar cannot eat the whole pool on a phone. */
void lsInterpret(int32_t n, LsTurtle t, const LsStyle& st, Rng& rng) {
  LsTurtle stack[LS_STACK];
  int32_t sp = 0;
  float vBase = 0.0f;
  for (int32_t i = 0; i < n; ++i) {
    const char c = gLsA[i];
    if (c == 'F') {
      if (gVert > MAX_VERT - 12) return;
      V3 dir = t.dir;
      /* Gravity: a frond arches over instead of standing up like a wire. */
      dir = norm(add(dir, mul(t.up, -t.droop)));
      const V3 to = add(t.p, mul(dir, t.step));
      const float tLen = clampf((t.len + t.step) / maxf(0.05f, t.maxLen), 0.0f, 1.0f);
      /* Compliance accumulates from the socket this axis grew out of, so a
         pinna on a compliant rachis is more compliant still. */
      const float swayEnd = clampf(t.swayBase + (1.0f - t.swayBase) * tLen * tLen * 0.85f,
                                   0.0f, 1.0f);
      tubeSegment(t.p, to, t.w, t.w * 0.92f, st.sides, vBase, 1.4f,
                  0.74f + 0.22f * tLen, 0.2f + rng.f() * 0.8f,
                  v3(1.0f, 0.0f, 0.0f), false,
                  t.swayPrev, swayEnd, t.ph + t.len * 2.4f);
      t.swayPrev = swayEnd;
      vBase += t.step * 1.4f;
      t.p = to;
      t.dir = dir;
      t.len += t.step;
      /* Every rachis cell carries a pinna on each side, angled up and out. */
      if (st.leaves && gLeafN < MAX_LEAF - 2) {
        const V3 side = norm(cross(dir, t.up));
        for (int32_t k = 0; k < 2 && gLeafN < MAX_LEAF; ++k) {
          const float sgn = k ? -1.0f : 1.0f;
          const V3 ld = norm(add(add(mul(side, sgn), mul(dir, 0.25f)),
                               mul(t.up, k ? -0.22f : 0.22f)));
          float* leaf = &gLeaf[gLeafN * LEAF_STRIDE];
          leaf[0] = t.p.x; leaf[1] = t.p.y; leaf[2] = t.p.z;
          leaf[3] = ld.x; leaf[4] = ld.y; leaf[5] = ld.z;
          leaf[6] = st.leafSize * (0.62f + 0.5f * rng.f());
          leaf[7] = 0.25f + 0.7f * tLen;
          leaf[8] = swayEnd;
          leaf[9] = t.ph + t.len * 2.4f;
          ++gLeafN;
        }
      }
    } else if (c == '+') {
      t.dir = rotAxis(t.dir, t.up, st.yaw);
    } else if (c == '-') {
      t.dir = rotAxis(t.dir, t.up, -st.yaw);
    } else if (c == '&') {
      const V3 side = norm(cross(t.dir, t.up));
      t.dir = rotAxis(t.dir, side, st.pitch);
    } else if (c == '^') {
      const V3 side = norm(cross(t.dir, t.up));
      t.dir = rotAxis(t.dir, side, -st.pitch);
    } else if (c == '/') {
      t.up = rotAxis(t.up, t.dir, 0.5f);
    } else if (c == '\\') {
      t.up = rotAxis(t.up, t.dir, -0.5f);
    } else if (c == '[') {
      /* Parametric step: a lateral axis is thinner and shorter than its parent
         (0.62 is the classic bracken pinna ratio), which is what turns a
         self-similar word into a tapering frond instead of a wire frame. */
      if (sp < LS_STACK) stack[sp++] = t;
      t.swayBase = clampf(t.swayPrev + (1.0f - t.swayPrev) * 0.38f, 0.0f, 1.0f);
      t.swayPrev = t.swayBase;
      t.step *= st.scale;
      t.w *= st.scale;
      t.maxLen *= st.scale;
      t.len = 0.0f;
    } else if (c == ']') {
      if (sp > 0) t = stack[--sp];
    }
  }
}

/* One rosette of fronds grown from the word sitting in gLsA. */
void growFronds(int32_t n, int32_t fronds, float step, float tilt, float droop,
                float swayBase, float socket, float baseY, int32_t iters,
                const LsStyle& st, Rng& rng) {
  for (int32_t f = 0; f < fronds; ++f) {
    const float a = float(f) * kTwoPi / float(fronds) + rng.range(-0.16f, 0.16f);
    LsTurtle t;
    t.up = v3(0.0f, 1.0f, 0.0f);
    t.p = v3(cosf(a) * socket, baseY, sinf(a) * socket);
    const float tl = tilt + rng.range(-0.10f, 0.10f);
    t.dir = norm(v3(cosf(a) * sinf(tl), cosf(tl), sinf(a) * sinf(tl)));
    t.ph = rng.range(0.0f, kTwoPi);
    t.len = 0.0f;
    /* Longest frond first, so the rosette reads as one plant. */
    const float shrink = 1.0f - 0.10f * float(f) / float(fronds);
    t.step = step * shrink;
    t.w = t.step * 0.058f * (0.85f + 0.3f * rng.f());
    t.droop = droop * (1.0f + float(f) / float(fronds));
    /* The rachis carries 2 segments per rewrite, so after `iters` passes it is
       2*(2^iters-1) steps long; colour and compliance ramp run along it. */
    t.maxLen = t.step * 2.0f * float((1 << iters) - 1);
    t.swayBase = swayBase;
    t.swayPrev = swayBase;
    lsInterpret(n, t, st, rng);
  }
}

/* ---------------------------------------------------------------- */
/* Herbaceous entry points (grammar-grown)                           */
/* ---------------------------------------------------------------- */
int32_t generateFern(int32_t kind, uint32_t seed, int32_t detail) {
  SpeciesSpec s = kSpecies[kind];
  applyShape(s);
  Rng rng(seed ^ 0x9e3779b9u);
  const bool tree = (kind == SP_TREEFERN);
  float baseY = 0.0f;
  if (tree) {
    const int32_t sides = detail >= 2 ? 8 : 5;
    V3 prev = v3(0.0f, -0.05f, 0.0f);
    const int32_t rings = 5;
    for (int32_t i = 1; i <= rings; ++i) {
      const float t = float(i) / float(rings);
      const V3 p = v3(sinf(t * 2.2f) * 0.02f, s.trunkTop * t, cosf(t * 1.7f) * 0.015f);
      const float r0 = s.trunkRadius * (1.0f - 0.55f * (float(i - 1) / float(rings)));
      const float r1 = s.trunkRadius * (1.0f - 0.55f * t);
      tubeSegment(prev, p, r0, r1, sides, s.trunkTop * t * 0.6f, 0.6f, 0.7f,
                  0.35f + 0.4f * t, v3(1.0f, 0.0f, 0.0f), i == rings,
                  0.0f, 0.05f * t, 0.0f);
      prev = p;
    }
    baseY = s.trunkTop;
  }
  /* A rule set uploaded at runtime takes over the frond grammar: that is what
     the studio's rule editor edits, and it is expanded here, not in JS. */
  const LsProd* rules = gUserRuleN > 0 ? gUserProd : kFernRules;
  const int32_t ruleN = gUserRuleN > 0 ? gUserRuleN : 2;
  const char* axiom = (gUserRuleN > 0 && gUserAxiom[0]) ? gUserAxiom : "X";
  const int32_t baseFronds = tree ? 8 : 10;
  const int32_t f0 = int32_t(float(baseFronds) * gShapeD + 0.5f);
  const int32_t fronds = f0 < 4 ? 4 : (f0 > 24 ? 24 : f0);
  const int32_t iters = tree ? 4 : 3;
  const int32_t n = lsExpand(rules, ruleN, axiom, iters, rng);
  LsStyle st;
  st.leaves = s.leaves;
  st.sides = detail >= 2 ? 4 : 3;
  st.leafSize = s.leafSize;
  st.yaw = 0.62f;
  st.pitch = 0.36f;
  st.scale = 0.62f;
  growFronds(n, fronds, (tree ? 0.052f : 0.048f) * gShapeH, tree ? 0.55f : 0.62f,
             tree ? 0.010f : 0.030f, tree ? 0.18f : 0.10f,
             tree ? 0.045f : 0.02f, baseY, iters, st, rng);
  return gVert;
}

/* ---------------------------------------------------------------- */
/* Tree entry point                                                 */
/* ---------------------------------------------------------------- */
int32_t generateTree(int32_t kind, uint32_t seed, int32_t detail) {
  if (kind < 0 || kind >= SP_COUNT) return 0;
  gNodeN = 0;
  gAttN = 0;
  if (kind >= SP_FERN) return generateFern(kind, seed, detail);
  SpeciesSpec s = kSpecies[kind];
  applyShape(s);
  Rng rng(seed ^ 0x51ed270bu);

  V3 frame = v3(1.0f, 0.0f, 0.0f);
  const int32_t trunkTip = buildTrunk(s, rng, frame);
  if (trunkTip < 0) return 0;
  const int32_t firstBranch = trunkTip + 1;

  colonise(s, rng, trunkTip);
  meshBranches(s, rng, firstBranch, frame);
  emitLeafAnchors(s, rng, firstBranch);

  /* Root flare: three short buttresses so the trunk does not look inserted. */
  for (int32_t i = 0; i < 3; ++i) {
    const float a = float(i) * kTwoPi / 3.0f + rng.range(-0.4f, 0.4f);
    const float d = s.trunkRadius * rng.range(1.6f, 2.4f);
    const V3 from = v3(0.0f, -s.trunkRadius * 0.15f, 0.0f);
    const V3 to = v3(cosf(a) * d, -s.trunkRadius * 0.55f, sinf(a) * d);
    tubeSegment(from, to, s.trunkRadius * 0.34f, s.trunkRadius * 0.08f,
                detail >= 2 ? 6 : 4, 0.0f, 0.35f, 0.66f, 0.4f, v3(1.0f, 0.0f, 0.0f), true);
  }
  return gVert;
}

/* Parses the packed rule set the bridge writes into wasm memory:
 *   u8 ruleCount, u8 axiomLen, axiom bytes,
 *   per rule: u8 predecessor, u8 altCount, per alt: u8 len, bytes.
 * Returns the number of rules accepted, or -1 when the buffer is malformed. */
int32_t loadUserRules(const uint8_t* buf, int32_t bytes) {
  if (!buf || bytes < 2) return -1;
  int32_t at = 0;
  const int32_t count = buf[at++];
  if (count < 0 || count > LS_RULES) return -1;
  const int32_t alen = buf[at++];
  if (at + alen > bytes || alen >= LS_ALT) return -1;
  for (int32_t i = 0; i < alen; ++i) gUserAxiom[i] = char(buf[at + i]);
  gUserAxiom[alen] = 0;
  at += alen;
  int32_t accepted = 0;
  for (int32_t r = 0; r < count; ++r) {
    if (at + 2 > bytes) return -1;
    const char pre = char(buf[at++]);
    const int32_t alts = buf[at++];
    if (alts < 1 || alts > 2) return -1;
    UserRule& u = gUserRule[r];
    u.pre = pre;
    u.n = alts;
    for (int32_t k = 0; k < alts; ++k) {
      if (at + 1 > bytes) return -1;
      const int32_t len = buf[at++];
      if (len >= LS_ALT || at + len > bytes) return -1;
      for (int32_t i = 0; i < len; ++i) u.alt[k][i] = char(buf[at + i]);
      u.alt[k][len] = 0;
      at += len;
      if (k == 1) { /* second alternative is optional in the packed form */ }
    }
    if (alts == 1) u.alt[1][0] = 0;
    gUserProd[r].pre = u.pre;
    gUserProd[r].n = uint8_t(u.n);
    gUserProd[r].alt[0] = u.alt[0];
    gUserProd[r].alt[1] = u.alt[1];
    ++accepted;
  }
  gUserRuleN = accepted;
  return accepted;
}

}  // namespace

/* ====================================================================== */
/* C ABI                                                                  */
/* ====================================================================== */

extern "C" {

FE_EXPORT int32_t fe_flora_species_count(void) { return SP_COUNT; }

/* Runtime shape controls, clamped so a slider can never blow a buffer. */
FE_EXPORT int32_t fe_flora_set_shape(float height, float density) {
  gShapeH = clampf(height, 0.30f, 2.50f);
  gShapeD = clampf(density, 0.30f, 2.00f);
  return int32_t(gShapeH * 100.0f + 0.5f);
}

/* Back to the built-in frond grammar. */
FE_EXPORT int32_t fe_flora_lsystem_reset(void) {
  gUserRuleN = 0;
  gUserAxiom[0] = 0;
  return 0;
}
FE_EXPORT int32_t fe_flora_rock_kind_count(void) { return ROCK_COUNT; }

FE_EXPORT int32_t fe_flora_tree(int32_t kind, uint32_t seed, int32_t detail) {
  resetMesh();
  generateTree(kind, seed, detail);
  return gVert > 0 ? gVert : 0;
}

FE_EXPORT int32_t fe_flora_rock(int32_t kind, uint32_t seed, int32_t detail) {
  resetMesh();
  return generateRock(kind, seed, detail);
}

FE_EXPORT int32_t fe_flora_vert_count(void) { return gVert; }
FE_EXPORT int32_t fe_flora_index_count(void) { return gIdxN; }
FE_EXPORT int32_t fe_flora_leaf_count(void) { return gLeafN; }

FE_EXPORT float* fe_flora_pos_ptr(void) { return gPos; }
FE_EXPORT float* fe_flora_nrm_ptr(void) { return gNrm; }
FE_EXPORT float* fe_flora_uv_ptr(void) { return gUv; }
FE_EXPORT float* fe_flora_col_ptr(void) { return gCol; }
FE_EXPORT float* fe_flora_rnd_ptr(void) { return gRnd; }
FE_EXPORT float* fe_flora_cen_ptr(void) { return gCen; }
FE_EXPORT uint32_t* fe_flora_idx_ptr(void) { return gIdx; }
FE_EXPORT float* fe_flora_leaf_ptr(void) { return gLeaf; }

/* Skeletal wind attributes, one float per vertex: compliance in [0,1] and the
 * branch phase in radians. */
FE_EXPORT float* fe_flora_sway_ptr(void) { return gSway; }
FE_EXPORT float* fe_flora_phase_ptr(void) { return gPhase; }
FE_EXPORT int32_t fe_flora_leaf_stride(void) { return LEAF_STRIDE; }

/* Runs the fern grammar and nothing else: no turtle, no geometry. Returns the
 * number of symbols produced, and `fe_flora_lsystem_word()` exposes the string.
 * This is what the JS side asserts on when it claims an L-system runs here —
 * the production rules are expanded in the kernel, not faked in JS. */
FE_EXPORT int32_t fe_flora_lsystem(int32_t iterations, uint32_t seed) {
  gLsWordN = 0;
  const int32_t it = iterations < 0 ? 0 : (iterations > 8 ? 8 : iterations);
  Rng rng(seed ^ 0x9e3779b9u);
  gLsWordN = lsExpand(kFernRules, 2, "X", it, rng);
  for (int32_t i = 0; i < gLsWordN; ++i) gLsWord[i] = gLsA[i];
  gLsWord[gLsWordN] = 0;
  return gLsWordN;
}

FE_EXPORT int32_t fe_flora_lsystem_len(void) { return gLsWordN; }
FE_EXPORT const char* fe_flora_lsystem_word(void) { return gLsWord; }
FE_EXPORT int32_t fe_flora_lsystem_rules(void) { return 2; }

/* Upload a rule set (see loadUserRules for the byte layout). Returns the number
 * of productions accepted, or -1 for a malformed buffer. */
FE_EXPORT int32_t fe_flora_lsystem_load(const uint8_t* buf, int32_t bytes) {
  return loadUserRules(buf, bytes);
}

/* Expand the uploaded rule set instead of the built-in frond grammar. */
FE_EXPORT int32_t fe_flora_lsystem_run(int32_t iterations, uint32_t seed) {
  if (gUserRuleN <= 0) return -1;
  gLsWordN = 0;
  const int32_t it = iterations < 0 ? 0 : (iterations > 8 ? 8 : iterations);
  Rng rng(seed ^ 0x9e3779b9u);
  gLsWordN = lsExpand(gUserProd, gUserRuleN, gUserAxiom, it, rng);
  for (int32_t i = 0; i < gLsWordN; ++i) gLsWord[i] = gLsA[i];
  gLsWord[gLsWordN] = 0;
  return gLsWordN;
}

/* Grow a rosette from the currently loaded word — the built-in frond grammar,
 * or the uploaded rule set once fe_flora_lsystem_run has expanded it. */
FE_EXPORT int32_t fe_flora_lsystem_plant(int32_t fronds, float step, float tilt,
                                         float droop, float leafSize,
                                         int32_t iterations, uint32_t seed,
                                         int32_t detail) {
  resetMesh();
  /* A grammar that never rewrites contains no F, so it would grow nothing;
     one pass is the floor for a plant. */
  const int32_t it = iterations < 1 ? 1 : (iterations > 5 ? 5 : iterations);
  Rng rng(seed ^ 0x51ed270bu);
  int32_t n;
  if (gUserRuleN > 0) {
    n = lsExpand(gUserProd, gUserRuleN, gUserAxiom, it, rng);
  } else {
    n = lsExpand(kFernRules, 2, "X", it, rng);
  }
  LsStyle st;
  st.leaves = leafSize > 0.0f ? 1 : 0;
  st.sides = detail >= 2 ? 4 : 3;
  st.leafSize = leafSize;
  st.yaw = 0.62f;
  st.pitch = 0.36f;
  st.scale = 0.62f;
  const int32_t f = fronds < 1 ? 1 : (fronds > 24 ? 24 : fronds);
  growFronds(n, f, step, tilt, droop, 0.10f, 0.02f, 0.0f, it, st, rng);
  return gVert;
}

/* Species parameters the JS bridge needs to match the card placer and the
 * material: out = [trunkTop, trunkRadius, crownY, crownRX, crownRY, leafSize,
 * cards, leaves]. */
FE_EXPORT int32_t fe_flora_species_info(int32_t kind, float* out) {
  if (!out || kind < 0 || kind >= SP_COUNT) return 0;
  const SpeciesSpec& s = kSpecies[kind];
  out[0] = s.trunkTop;
  out[1] = s.trunkRadius;
  out[2] = s.crownY;
  out[3] = s.crownRX;
  out[4] = s.crownRY;
  out[5] = s.leafSize;
  out[6] = float(s.cards);
  out[7] = s.leaves ? 1.0f : 0.0f;
  return 1;
}

}  // extern "C"
