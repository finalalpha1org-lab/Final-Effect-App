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
#include "../include/fe_flora_geom.hpp"
#include "../include/fe_math.hpp"

namespace {

using namespace fe;

/* ---------------------------------------------------------------- */
/* Buffers (static, no allocator in a freestanding build)            */
/* ---------------------------------------------------------------- */
constexpr int32_t MAX_VERT = 24000;
constexpr int32_t MAX_IDX = 72000;
constexpr int32_t MAX_LEAF = 3200;
/* A joint budget, not a vertex budget: every ring costs `sides` vertices, and
   the near tier needs enough joints to bend a limb instead of drawing a stick
   between two of them. 1 400 joints is a large oak; nothing here is per frame. */
constexpr int32_t MAX_NODES = 1400;
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
/* Which material group a vertex belongs to: 0 = wood/stem, 1 = foliage, 2 =
   bloom, 3 = the dark centre of a head (a composite's disc florets, a tulip's
   stamens, a lavender bud). The bridge splits one grown mesh into the same
   material slots the studio already renders (bark, leaf, petal, disc), so a
   plant keeps its PBR layers while its shape comes from here. */
float gPart[MAX_VERT];
float gPenPart = 0.0f;
float gPenSway = 0.0f;
float gPenPh = 0.0f;
uint32_t gIdx[MAX_IDX];
/* x, y, z, dir.x, dir.y, dir.z, size, colourT, sway, phase */
constexpr int32_t LEAF_STRIDE = 10;
float gLeaf[MAX_LEAF * LEAF_STRIDE];
/* Albedo for a blade, frond and frondlet, in linear light. Every one of
   these emitters used to write (shade, shade, shade) -- a grey vertex
   colour -- and relied on a texture that lawns and ferns do not have, so
   grass rendered as white spikes. The default is a mid leaf green
   (sRGB 0.32, 0.48, 0.24) and each species overrides it. */
float gLeafCol[3] = { 0.084f, 0.190f, 0.047f };

/* Leaf cards are grown here too. The anchor buffer above says where a leaf sits
   and which way its twig points; this second buffer is the quad the renderer
   actually draws — four vertices, two triangles, the same roll, taper and
   crown-facing normal the studio used to compute in JavaScript. A card is 17
   floats, so 3200 anchors is well under a megabyte. */
/* A leaf card used to be one flat quad, which is why a crown read as a heap of
   cardboard shards: every card was a single plane with a single normal, so it
   either caught the sun as a whole or not at all. Six vertices now form a
   two-by-three strip that arches along the midrib and folds across it, so one
   leaf has a range of normals and the canopy breaks up into light and shadow
   the way real foliage does. The JS side reads the stride from the kernel. */
constexpr int32_t CARD_V = 6;
constexpr int32_t CARD_I = 12;
float gCardPos[MAX_LEAF * CARD_V * 3];
float gCardNrm[MAX_LEAF * CARD_V * 3];
float gCardCol[MAX_LEAF * CARD_V * 3];
float gCardUv[MAX_LEAF * CARD_V * 2];
float gCardRnd[MAX_LEAF * CARD_V];
float gCardCen[MAX_LEAF * CARD_V * 3];
float gCardSway[MAX_LEAF * CARD_V];
float gCardPh[MAX_LEAF * CARD_V];
float gCardPart[MAX_LEAF * CARD_V];
uint32_t gCardIdx[MAX_LEAF * CARD_I];
int32_t gCardV = 0;
int32_t gCardI = 0;
int32_t gCardN = 0;

int32_t gVert = 0;
int32_t gIdxN = 0;
int32_t gLeafN = 0;

/* ---------------------------------------------------------------- */
/* Deterministic RNG (xorshift32, same sequence as the other kernels) */
/* ---------------------------------------------------------------- */
struct Rng {
  uint32_t s;
  explicit Rng(uint32_t seed) {
    /* Avalanche the seed first. Xorshift's first outputs from 11, 22 and 33 are
       nearly the same number, so every "unique" tree was drawing the same
       opening values and only diverged deeper in. */
    uint32_t v = seed + 0x9e3779b9u;
    v ^= v >> 16; v *= 0x7feb352du;
    v ^= v >> 15; v *= 0x846ca68bu;
    v ^= v >> 16;
    s = v ? v : 0x9e3779b9u;
  }
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
  gCardV = 0;
  gCardI = 0;
  gCardN = 0;
  gPenSway = 0.0f;
  gPenPh = 0.0f;
  gPenPart = 0.0f;
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
  gPart[i] = gPenPart;
  return i;
}

void pushTri(int32_t a, int32_t b, int32_t c) {
  if (a < 0 || b < 0 || c < 0 || gIdxN + 3 > MAX_IDX) return;
  /* Wound so the face points the way its vertices' normals do. Every emitter
     in this file orders its corners walking the surface one way round, so the
     order is reversed once, here, instead of at two dozen call sites — but the
     order alone is not enough: a ring stitched to a ring on a twisted frame
     comes out mirrored, and those few dozen faces were culled, showing the
     hollow inside of a trunk through its own bark. Testing the face against the
     smoothed normal catches every emitter, including the ones that do not
     exist yet. */
  const float e1x = gPos[b * 3] - gPos[a * 3];
  const float e1y = gPos[b * 3 + 1] - gPos[a * 3 + 1];
  const float e1z = gPos[b * 3 + 2] - gPos[a * 3 + 2];
  const float e2x = gPos[c * 3] - gPos[a * 3];
  const float e2y = gPos[c * 3 + 1] - gPos[a * 3 + 1];
  const float e2z = gPos[c * 3 + 2] - gPos[a * 3 + 2];
  const float nx = e1y * e2z - e1z * e2y;
  const float ny = e1z * e2x - e1x * e2z;
  const float nz = e1x * e2y - e1y * e2x;
  const float vx = gNrm[a * 3] + gNrm[b * 3] + gNrm[c * 3];
  const float vy = gNrm[a * 3 + 1] + gNrm[b * 3 + 1] + gNrm[c * 3 + 1];
  const float vz = gNrm[a * 3 + 2] + gNrm[b * 3 + 2] + gNrm[c * 3 + 2];
  const bool flip = nx * vx + ny * vy + nz * vz < 0.0f;
  gIdx[gIdxN++] = uint32_t(a);
  gIdx[gIdxN++] = uint32_t(flip ? c : b);
  gIdx[gIdxN++] = uint32_t(flip ? b : c);
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
  /* Bark is scaled by circumference, not by facet index. `j / sides` stretched a
     whole tile around a 2 cm twig and around a 1.2 m trunk alike, so the crown's
     bark was smeared sideways by an order of magnitude -- part of why the limbs
     read as painted planks. One tile per 1/uvScale metres of bark, both around
     and along, keeps the grain the same size on every limb. */
  const float uSpan = maxf(0.12f, kTwoPi * ((r0 + r1) * 0.5f) * uvScale);

  for (int32_t ring = 0; ring < 2; ++ring) {
    const V3 c = ring ? b : a;
    const float r = ring ? r1 : r0;
    gPenSway = ring ? sway1 : sway0;
    gPenPh = ph;
    for (int32_t j = 0; j <= sides; ++j) {
      const float th = (float(j) / float(sides)) * kTwoPi;
      const float cs = cosf(th), sn = sinf(th);
      const V3 n = v3(u.x * cs + w.x * sn, u.y * cs + w.y * sn, u.z * cs + w.z * sn);
      pushVert(add(c, mul(n, r)), n, (float(j) / float(sides)) * uSpan, v0 + (ring ? length : 0.0f) * uvScale,
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
  /* Ground cover, succulents and palms. These are grown by their own builders
     below — a tuft is not a small tree and a saguaro is not a bush — but they
     share the mesh buffers, the wind channels and the species table so the
     bridge talks to one kernel for every plant in the studio. */
  SP_GRASS,
  SP_TALLGRASS,
  SP_DAISY,
  SP_TULIP,
  SP_LAVENDER,
  SP_SAGUARO,
  SP_BARREL,
  SP_AGAVE,
  SP_PALM,
  SP_PEBBLE,
  /* Conifers and desert scrub. A pine is a monopodial leader with whorls of
     plagiotropic branches; a prickly pear is a chain of flattened cladodes; a
     Joshua tree is a fibre trunk that forks into leaf rosettes. Each of those
     is a different growth habit, so each gets its own builder rather than a
     reused one with different numbers. */
  SP_PINE,
  SP_SPRUCE,
  SP_KRUMM,
  SP_JUNIPER,
  SP_PRICKLY,
  SP_JOSHUA,
  SP_SAGE,
  /* The studio's generic wildflower: one tuft carrying three composite heads
     on separate stems, which is what the biome tables scatter as "flower". */
  SP_FLOWER,
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
  /* treefern*/ { 1.60f, 0.10f, 1.95f, 1.10f, 0.55f, 0.008f, 6, 0, 0.060f, 1, 5, 0.22f, 2, 1 },
  /* grass   */ { 0.00f, 0.005f, 0.16f, 0.15f, 0.15f, 0.002f, 1, 0, 0.050f, 1, 3, 0.00f, 0, 0 },
  /* tallgrass*/{ 0.00f, 0.010f, 0.78f, 0.42f, 0.78f, 0.003f, 1, 0, 0.050f, 1, 3, 0.00f, 0, 0 },
  /* daisy   */ { 0.01f, 0.002f, 0.12f, 0.05f, 0.12f, 0.001f, 1, 0, 0.050f, 1, 3, 0.00f, 0, 0 },
  /* tulip   */ { 0.02f, 0.004f, 0.36f, 0.08f, 0.36f, 0.001f, 1, 0, 0.050f, 1, 4, 0.00f, 0, 0 },
  /* lavender*/ { 0.02f, 0.003f, 0.48f, 0.12f, 0.48f, 0.001f, 1, 0, 0.050f, 1, 4, 0.00f, 0, 0 },
  /* saguaro */ { 5.20f, 0.30f, 4.00f, 0.90f, 1.60f, 0.010f, 10, 0, 0.050f, 1, 8, 0.00f, 0, 0 },
  /* barrel  */ { 0.80f, 0.32f, 0.55f, 0.40f, 0.40f, 0.005f, 3, 0, 0.050f, 1, 6, 0.00f, 0, 0 },
  /* agave   */ { 0.10f, 0.04f, 0.60f, 1.05f, 0.55f, 0.004f, 1, 0, 0.050f, 1, 4, 0.00f, 0, 0 },
  /* palm    */ { 8.00f, 0.19f, 8.40f, 3.20f, 1.80f, 0.010f, 12, 0, 0.050f, 1, 8, 0.00f, 0, 0 },
  /* pebble  */ { 0.00f, 0.085f, 0.05f, 0.10f, 0.06f, 0.002f, 1, 0, 0.050f, 1, 3, 0.00f, 0, 0 },
  /* pine    */ { 6.00f, 0.28f, 9.00f, 3.20f, 4.20f, 0.010f, 16, 0, 0.050f, 1, 7, 0.00f, 0, 1 },
  /* spruce  */ { 0.30f, 0.24f, 7.00f, 2.90f, 9.00f, 0.008f, 18, 0, 0.050f, 1, 7, 0.00f, 0, 1 },
  /* krumm   */ { 0.10f, 0.11f, 0.80f, 1.50f, 0.80f, 0.006f, 7, 0, 0.050f, 1, 5, 0.00f, 0, 1 },
  /* juniper */ { 0.20f, 0.09f, 1.30f, 1.10f, 1.30f, 0.005f, 9, 0, 0.050f, 1, 5, 0.00f, 0, 1 },
  /* prickly */ { 0.20f, 0.05f, 0.90f, 0.70f, 0.90f, 0.004f, 4, 0, 0.050f, 1, 4, 0.00f, 0, 1 },
  /* joshua  */ { 2.20f, 0.30f, 5.20f, 1.60f, 3.00f, 0.010f, 10, 0, 0.050f, 1, 7, 0.00f, 0, 1 },
  /* sage    */ { 0.25f, 0.045f, 0.75f, 0.55f, 0.55f, 0.004f, 6, 0, 0.050f, 1, 4, 0.00f, 0, 1 },
  /* flower  */ { 0.40f, 0.060f, 0.40f, 0.16f, 0.16f, 0.003f, 3, 0, 0.050f, 1, 4, 0.40f, 0, 1 }
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
  uint8_t isRoot;  /* a buttress root: tapers outward at the collar */
  uint8_t level;   /* 0 = trunk and roots, 1..n = branching orders   */
  uint8_t spare;
};

Node gNodes[MAX_NODES];
int32_t gNodeN = 0;

/* A tree is one surface, not a pile of tubes. Every joint owns exactly one ring
   of vertices, and both the segment arriving at it and every segment leaving it
   are bridged to that same ring, so the mesh is connected by construction: no
   crack at a fork, and — because the wind values are read from the joint rather
   than from the segment — no piece of the tree can blow away from the piece it
   grows out of. */
struct Ring {
  int32_t start;
  int32_t sides;
  float radius;
};
Ring gRing[MAX_NODES];
V3 gTan[MAX_NODES];   /* tangent at the joint                             */
V3 gUf[MAX_NODES];    /* ring frame, parallel-transported from the root    */
V3 gVf[MAX_NODES];
float gNSway[MAX_NODES];
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
  gNodes[i].isRoot = 0;
  gNodes[i].level = 0;
  gNodes[i].spare = 0;
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

inline float swayOf(float len, float radius, const SpeciesSpec& s);

/* The trunk, as a skeleton only: nodes from the buried collar up to the point
   where the crown takes over. Meshing happens once, after the whole tree
   exists, so the trunk is the same surface as the limbs it carries. */
int32_t buildTrunk(const SpeciesSpec& s, Rng& rng, V3& outFrame) {
  const float lean = rng.range(-0.12f, 0.12f);
  const float leanZ = rng.range(-0.12f, 0.12f);
  const float wobble = rng.range(0.0f, 1.0f) * 0.35f;
  /* The foot of a tree is wider than the stem and buried a little, so the trunk
     grows out of the ground instead of being stood on it. */
  const float footDepth = 0.06f + s.trunkRadius * 0.22f;
  int32_t prev = addNode(v3(0.0f, -footDepth, 0.0f), -1, 0.0f);
  if (prev < 0) return -1;
  gNodePh[prev] = rng.range(0.0f, kTwoPi);
  V3 frame = v3(1.0f, 0.0f, 0.0f);
  for (int32_t i = 1; i <= s.segments; ++i) {
    const float t = float(i) / float(s.segments);
    const float y = s.trunkTop * t;
    const float sway = sinf(t * 3.1f + wobble * 3.0f) * 0.06f * s.trunkTop;
    const V3 p = v3(lean * y * y * 0.12f + sway, y, leanZ * y * y * 0.12f + sway * 0.6f);
    const int32_t idx = addNode(p, prev, s.trunkTop * t);
    if (idx < 0) return prev;
    prev = idx;
  }
  outFrame = frame;
  return prev;
}

/* Buttress roots: real ones, grown from the collar rather than drawn on it.
   Each is a chain of nodes that leaves the trunk above ground, crosses the
   soil line and runs under it, so the flare reads from every angle and the
   roots are part of the same surface as the trunk. */
void buildRoots(const SpeciesSpec& s, Rng& rng, int32_t trunkTip) {
  if (s.trunkRadius < 0.03f) return;
  const int32_t count = s.trunkRadius > 0.35f ? 6 : s.trunkRadius > 0.14f ? 5 : 4;
  const int32_t collar = gNodes[trunkTip].parent >= 0 ? trunkTip : 0;
  const float baseY = gNodes[trunkTip].p.y * 0.5f;
  for (int32_t r = 0; r < count; ++r) {
    const float a = float(r) * kTwoPi / float(count) + rng.range(-0.35f, 0.35f);
    const float reach = s.trunkRadius * rng.range(1.7f, 3.1f);
    int32_t parent = collar;
    for (int32_t k = 0; k < 3; ++k) {
      const float t = float(k + 1) / 3.0f;
      const float spread = reach * t * t;
      const float y = baseY * (1.0f - t) - s.trunkRadius * 0.30f * t - 0.02f;
      const float wander = rng.range(-0.16f, 0.16f) * reach * 0.25f;
      const V3 p = v3(cosf(a + wander) * spread, y, sinf(a + wander) * spread);
      const int32_t idx = addNode(p, parent, gNodes[parent].len + len(sub(p, gNodes[parent].p)));
      if (idx < 0) return;
      gNodes[idx].isRoot = 1;
      gNodePh[idx] = gNodePh[parent] + 0.25f;
      parent = idx;
    }
  }
}

/* Radii. The trunk keeps its own profile — a collar flare thinning to the crown
   base — instead of the da Vinci rule, which is a *branching* law and would
   thin a trunk to the wrong diameter. Everything above the collar keeps da
   Vinci, so a fork splits its girth between its children as a real one does. */
void assignRadii(const SpeciesSpec& s, int32_t trunkTip) {
  for (int32_t i = 0; i <= trunkTip && i < gNodeN; ++i) {
    const float t = clampf(gNodes[i].len / maxf(0.01f, s.trunkTop), 0.0f, 1.0f);
    const float flareT = clampf(1.0f - t / 0.16f, 0.0f, 1.0f);
    const float flare = 1.0f + 0.34f * flareT * flareT * flareT;
    gNodes[i].radius = s.trunkRadius * (1.0f - 0.74f * t) * flare;
  }
  float rootReach = 0.0f;
  for (int32_t i = 0; i < gNodeN; ++i) {
    if (gNodes[i].isRoot) rootReach = maxf(rootReach, len(gNodes[i].p));
  }
  for (int32_t i = 0; i < gNodeN; ++i) {
    const int32_t p = gNodes[i].parent;
    if (p >= 0 && p < i && !gNodes[i].isRoot && gNodes[p].radius > 0.0f) {
      const float cap = gNodes[p].radius * 0.86f;
      if (gNodes[i].radius > cap) gNodes[i].radius = cap;
    }
  }
  for (int32_t i = 0; i < gNodeN; ++i) {
    if (!gNodes[i].isRoot) continue;
    const float t = rootReach > 0.0f ? clampf(len(gNodes[i].p) / rootReach, 0.0f, 1.0f) : 1.0f;
    gNodes[i].radius = maxf(0.012f, s.trunkRadius * (0.46f * (1.0f - t) + 0.10f));
  }
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
    /* Facet count follows the branch radius in metres. It used to be
       `3 + r0*7`, which gave every branch thinner than about 4 cm exactly three
       sides -- a triangular prism. A crown is almost entirely made of those, so
       the tree read as a pile of flat planks instead of round limbs. Four is the
       floor for anything woody, and 120 facets per metre puts an 8 cm limb at
       the species' maximum while a 2 cm twig still gets six. */
    const float floorSides = s.tubes <= 4 ? 3.0f : 4.0f;
    const int32_t sides = int32_t(clampf(4.0f + r0 * 120.0f, floorSides, float(s.tubes)));
    const float gnarl = fbm(mul(b, 0.55f), 0x51ed270bu, 2) * 0.05f * r0;
    const V3 offset = norm(cross(sub(b, a), v3(0.0f, 1.0f, 0.0f)));
    /* A branch is not a pipe pushed against a trunk: it is a cone that grows
       out of the parent's wood. The old code started the child ring exactly on
       the parent's axis with a radius 5% wider than the parent, so a disc of
       the parent's own girth stuck out sideways at every fork -- the "joints
       are not connected" complaint. Now the branch is rooted *inside* the
       parent, sunk back along its own direction by most of the parent's radius,
       and flares as it leaves so the union reads as one piece of timber. */
    const V3 dir = norm(sub(b, a));
    /* Does this child continue the parent's line, or leave from its side? A
       leader continues (no sink, radius matched to the parent tip so the bark
       flows over the collar); a lateral limb is rooted inside the parent and
       flares out of it. Without this split a fat trunk would neck down to half
       its girth at the first branch point. */
    const int32_t grand = gNodes[parent].parent;
    const V3 pdir = grand >= 0 ? norm(sub(a, gNodes[grand].p)) : v3(0.0f, 1.0f, 0.0f);
    const bool leader = dot(dir, pdir) > 0.75f;
    const float sink = leader ? 0.0f : r0 * 0.85f;
    const V3 start = add(a, mul(dir, -sink));
    const float rootR = leader ? r0 * 0.98f : maxf(r0 * 0.50f, r1 * 1.20f);
    const V3 end = add(b, mul(offset, -gnarl * 0.6f));
    const float shade = 0.70f + 0.30f * clampf(b.y / (s.crownY + s.crownRY), 0.0f, 1.0f);
    const float rnd = 0.15f + rng.f() * 0.85f;
    const float ph = gNodePh[parent] + len(sub(b, a)) * 1.6f;
    gNodePh[i] = ph;
    frames[i] = tubeSegment(start, end, rootR, r1, sides, gNodes[parent].len * 0.35f, 0.35f,
                            shade, rnd, frames[parent], gNodes[i].terminal != 0,
                            swayOf(gNodes[parent].len, rootR, s), swayOf(gNodes[i].len, r1, s), ph);
  }
}

/* A limb is a curve, but the colony only ever puts a joint where it stepped.
   Splitting the long segments keeps a limb from being a straight stick between
   two widely spaced joints, and it is where the extra rings of a near-tier tree
   come from — geometry that rounds a silhouette instead of merely adding
   facets to it. New joints are appended, so no existing index moves. */
void refineSkeleton(float maxSeg) {
  if (maxSeg <= 0.0f) return;
  const int32_t n0 = gNodeN;
  for (int32_t i = 0; i < n0; ++i) {
    const int32_t child = i;
    const int32_t parent = gNodes[child].parent;
    if (parent < 0) continue;
    const V3 a = gNodes[parent].p, b = gNodes[child].p;
    const float L = len(sub(b, a));
    if (L <= maxSeg) continue;
    const int32_t pieces = int32_t(ceilf(L / maxSeg));
    if (pieces < 2 || pieces > 6) continue;
    int32_t prev = parent;
    for (int32_t k = 1; k < pieces; ++k) {
      const float t = float(k) / float(pieces);
      const V3 pm = add(a, mul(sub(b, a), t));
      const int32_t idx = addNode(pm, prev, gNodes[parent].len + L * t);
      if (idx < 0) return;
      gNodes[idx].radius = lerpf(gNodes[parent].radius, gNodes[child].radius, t);
      gNodes[idx].isRoot = gNodes[child].isRoot;
      gNodes[idx].level = gNodes[child].level;
      gNodePh[idx] = gNodePh[parent] + L * t * 1.6f;
      prev = idx;
    }
    gNodes[child].parent = prev;
    gNodes[child].len = gNodes[parent].len + L;
  }
}

/* Refinement inserts a joint *between* a node and its parent, which leaves the
   parent sitting later in the array than the child. Every pass below walks the
   array in order and reads its parent's frame, phase and radius, so a child
   would inherit whatever the last plant happened to leave behind — the same
   seed growing a different tree. Re-laying the skeleton out parent-first, once,
   removes the whole class of problem instead of guarding each pass. */
void orderNodes(void) {
  if (gNodeN < 2) return;
  Node tmp[MAX_NODES];
  int32_t order[MAX_NODES];
  int32_t stack[MAX_NODES];
  bool seen[MAX_NODES] = {};
  int32_t sp = 0, count = 0;
  /* The foot node is the only root; the rest hang off it. */
  stack[sp++] = 0;
  order[0] = 0;
  while (sp > 0) {
    const int32_t i = stack[--sp];
    order[count++] = i;
    for (int32_t c = gNodeN - 1; c >= 1; --c) {
      if (seen[c] || c == i) continue;
      if (gNodes[c].parent == i) { seen[c] = true; stack[sp++] = c; }
    }
    if (sp > MAX_NODES) return;
  }
  /* Anything orphaned by a clamped colony keeps its geometry-free state out of
     the mesh: it is simply dropped. */
  if (count < 2) return;
  int32_t newIndex[MAX_NODES];
  for (int32_t k = 0; k < count; ++k) newIndex[order[k]] = k;
  for (int32_t k = 0; k < count; ++k) tmp[k] = gNodes[order[k]];
  for (int32_t k = 0; k < count; ++k) {
    const int32_t oldParent = tmp[k].parent;
    tmp[k].parent = (oldParent >= 0 && newIndex[oldParent] < count) ? newIndex[oldParent] : -1;
    gNodePh[k] = gNodePh[order[k]];
    gNodes[k] = tmp[k];
  }
  gNodeN = count;
}

/* ---- the connected mesher -------------------------------------------------
   One ring per joint. The trunk, every limb, every twig and every buttress
   root are bridged to those rings, so the whole plant is a single connected
   surface and every wind value it carries belongs to the joint it grew from. */

V3 rotAxis(V3 v, V3 axis, float a);   /* defined below, used to transport frames */

inline int32_t sidesForRadius(float r, int32_t maxSides, int32_t minSides) {
  /* Round wood, even on the twigs: a 2 cm branch at five sides reads as a
     plank when its silhouette crosses the sky. The far tier is allowed to
     square off, the near tier is not. */
  const int32_t n = int32_t(float(minSides) + r * 46.0f);
  return n < minSides ? minSides : (n > maxSides ? maxSides : n);
}

/* Frames. The tangent at a joint is the mean of the directions it connects,
   and the frame is the parent's frame turned by the smallest rotation that
   takes the parent tangent onto this one. That is parallel transport: the bark
   does not wind round the limb between two joints, which is what a per-segment
   frame does and why the old bark texture spiralled like a corkscrew. */
void buildFrames(void) {
  /* One adjacency pass, not a scan of every node per node: at 1 400 joints the
     quadratic form cost more to grow one tree than the whole studio spends
     placing a stand of them. */
  int32_t childHead[MAX_NODES];
  int32_t childNext[MAX_NODES];
  for (int32_t i = 0; i < gNodeN; ++i) childHead[i] = -1;
  for (int32_t i = 1; i < gNodeN; ++i) {
    const int32_t p = gNodes[i].parent;
    if (p < 0 || p >= i) continue;
    childNext[i] = childHead[p];
    childHead[p] = i;
  }
  for (int32_t i = 0; i < gNodeN; ++i) {
    V3 sum = v3(0.0f, 0.0f, 0.0f);
    if (gNodes[i].parent >= 0) sum = add(sum, norm(sub(gNodes[i].p, gNodes[gNodes[i].parent].p)));
    for (int32_t c = childHead[i]; c >= 0; c = childNext[c]) {
      sum = add(sum, norm(sub(gNodes[c].p, gNodes[i].p)));
    }
    if (len(sum) < 1e-5f) sum = v3(0.0f, 1.0f, 0.0f);
    gTan[i] = norm(sum);
    if (gNodes[i].parent >= 0) {
      const V3 incoming = norm(sub(gNodes[i].p, gNodes[gNodes[i].parent].p));
      if (dot(gTan[i], incoming) < 0.05f) gTan[i] = incoming;
    }
  }
  for (int32_t i = 0; i < gNodeN; ++i) {
    const int32_t parent = gNodes[i].parent;
    if (parent < 0) {
      const V3 t = gTan[i];
      const V3 ref = absf(t.y) > 0.9f ? v3(1.0f, 0.0f, 0.0f) : v3(0.0f, 1.0f, 0.0f);
      gUf[i] = norm(sub(ref, mul(t, dot(ref, t))));
      gVf[i] = cross(t, gUf[i]);
      continue;
    }
    const V3 tp = gTan[parent], ti = gTan[i];
    const V3 axis = cross(tp, ti);
    const float sn = len(axis);
    const float cs = clampf(dot(tp, ti), -1.0f, 1.0f);
    if (sn < 1e-6f) {
      gUf[i] = gUf[parent];
      gVf[i] = gVf[parent];
      continue;
    }
    const V3 a = mul(axis, 1.0f / sn);
    gUf[i] = norm(rotAxis(gUf[parent], a, atan2f(sn, cs)));
    gVf[i] = cross(ti, gUf[i]);
  }
}

/* Wind at a joint, and the phase that makes neighbouring limbs swing out of
   step. Both are properties of the joint, never of the segment: two vertices
   standing on the same joint always receive the same displacement, so a fork
   cannot open up however hard the wind blows. */
void computeNodeWind(const SpeciesSpec& s) {
  for (int32_t i = 0; i < gNodeN; ++i) {
    gNSway[i] = (gNodes[i].isRoot || gNodes[i].parent < 0)
      ? 0.0f : swayOf(gNodes[i].len, gNodes[i].radius, s);
    if (gNodes[i].parent >= 0 && !gNodes[i].isRoot) {
      const int32_t p = gNodes[i].parent;
      gNodePh[i] = gNodePh[p] + len(sub(gNodes[i].p, gNodes[p].p)) * 1.6f;
    }
  }
}

/* One ring of vertices at a joint. Buttress lobes on the lowest rings of the
   trunk are what make the flare read as roots rather than as a cone. */
void emitRing(int32_t i, int32_t sides) {
  const V3 c = gNodes[i].p;
  const float r = maxf(0.004f, gNodes[i].radius);
  const float bark = clampf(0.34f + gNodes[i].p.y * 0.03f, 0.34f, 0.95f);
  gPenSway = gNSway[i];
  gPenPh = gNodePh[i];
  gPenPart = 0.0f;
  gRing[i].start = gVert;
  gRing[i].sides = sides;
  gRing[i].radius = r;
  const float tile = maxf(0.22f, 6.2831853f * r * 0.55f);
  /* A per-vertex random for the bark shader. It must not be periodic: taking it
     from the joint index modulo anything lays a visible stripe up every limb,
     which is the "obviously procedural" tell this whole pass exists to remove. */
  const float hash = (sinf(float(i) * 12.9898f + gNodePh[i]) * 43758.5453f - floorf(sinf(float(i) * 12.9898f + gNodePh[i]) * 43758.5453f));
  const V3 cen = gNodes[i].p;
  const float lobePhase = gNodePh[i] * 0.7f;
  const float lobeAmt = gNodes[i].level == 0 && !gNodes[i].isRoot
    ? clampf(1.0f - gNodes[i].p.y / maxf(0.15f, 0.5f), 0.0f, 1.0f) * 0.22f : 0.0f;
  for (int32_t j = 0; j < sides; ++j) {
    const float th = float(j) / float(sides) * kTwoPi;
    const float cs = cosf(th), sn = sinf(th);
    V3 n = v3(gUf[i].x * cs + gVf[i].x * sn, gUf[i].y * cs + gVf[i].y * sn,
              gUf[i].z * cs + gVf[i].z * sn);
    float rr = r;
    if (lobeAmt > 0.0f) {
      const float lobe = cosf(th * 5.0f + lobePhase);
      if (lobe > 0.0f) rr *= 1.0f + lobeAmt * lobe * lobe * lobe;
    }
    pushVert(add(c, mul(n, rr)), n, float(j) / float(sides) * tile,
             gNodes[i].len * 0.55f, bark, 0.35f + 0.62f * hash, cen);
  }
}

/* Bridge two rings of different counts. The angular step is the finer of the
   two and each end of a quad repeats whichever ring is coarser, so no hole can
   survive between a 4-sided twig and a 12-sided trunk. */
void stitchRings(int32_t parent, int32_t child) {
  const Ring& A = gRing[parent];
  const Ring& B = gRing[child];
  if (A.sides < 3 || B.sides < 3) return;
  const int32_t steps = A.sides > B.sides ? A.sides : B.sides;
  for (int32_t k = 0; k < steps; ++k) {
    const float t0 = float(k) / float(steps), t1 = float(k + 1) / float(steps);
    const int32_t a0 = int32_t(floorf(t0 * float(A.sides) + 0.5f)) % A.sides;
    const int32_t a1 = int32_t(floorf(t1 * float(A.sides) + 0.5f)) % A.sides;
    const int32_t b0 = int32_t(floorf(t0 * float(B.sides) + 0.5f)) % B.sides;
    const int32_t b1 = int32_t(floorf(t1 * float(B.sides) + 0.5f)) % B.sides;
    if (a0 == a1 && b0 == b1) continue;
    const int32_t va0 = A.start + a0, va1 = A.start + a1;
    const int32_t vb0 = B.start + b0, vb1 = B.start + b1;
    if (a0 == a1) { pushTri(va0, vb0, vb1); continue; }
    if (b0 == b1) { pushTri(va0, vb0, va1); continue; }
    pushTri(va0, vb0, va1);
    pushTri(va1, vb0, vb1);
  }
}

/* A tip closes with a fan, so no hollow tube end shows at the end of a twig or
   a root. */
void capRing(int32_t i) {
  const Ring& R = gRing[i];
  if (R.sides < 3) return;
  const V3 dir = gTan[i];
  gPenSway = gNSway[i];
  gPenPh = gNodePh[i];
  gPenPart = 0.0f;
  const V3 c = add(gNodes[i].p, mul(dir, R.radius * 0.85f));
  const int32_t tip = pushVert(c, dir, 0.5f, gNodes[i].len * 0.55f, 0.5f, 0.2f, gNodes[i].p);
  if (tip < 0) return;
  for (int32_t j = 0; j < R.sides; ++j) {
    pushTri(R.start + j, tip, R.start + (j + 1) % R.sides);
  }
}

/* The whole plant, in one pass: rings first, then every bridge. */
void meshSkeleton(const SpeciesSpec& s, int32_t maxSides, int32_t minSides) {
  (void)s;
  buildFrames();
  computeNodeWind(s);
  for (int32_t i = 0; i < gNodeN; ++i) {
    emitRing(i, sidesForRadius(gNodes[i].radius, maxSides, minSides));
  }
  for (int32_t i = 0; i < gNodeN; ++i) {
    const int32_t parent = gNodes[i].parent;
    if (parent >= 0) stitchRings(parent, i);
  }
  /* The buried foot is closed so the trunk is solid from any angle. */
  if (gNodeN > 0) {
    const Ring& R = gRing[0];
    gPenSway = gNSway[0];
    gPenPh = gNodePh[0];
    const V3 down = mul(gTan[0], -1.0f);
    const int32_t centre = pushVert(gNodes[0].p, down, 0.5f, 0.0f, 0.28f, 0.2f, gNodes[0].p);
    if (centre >= 0) {
      for (int32_t j = 0; j < R.sides; ++j) pushTri(R.start + j, R.start + (j + 1) % R.sides, centre);
    }
  }
  for (int32_t i = 0; i < gNodeN; ++i) {
    if (gNodes[i].terminal) capRing(i);
  }
}

/* Phyllotaxis: the golden angle keeps successive leaves from shading each
 * other, so the canopy fills evenly instead of in visible rings.
 *
 * A leaf grows on a twig, not on a fingertip. Only the finest wood carries
 * foliage — anything thinner than three times the species' terminal radius —
 * and the anchors are spread along that wood by distance, so the inside of the
 * crown is as leafy as its shell. Anchoring them only on the terminal joints,
 * as this did, left a hollow crown with every leaf piled into a shell of flat
 * sheets at the very tips. */
void emitLeafAnchors(const SpeciesSpec& s, Rng& rng, int32_t firstBranch, int32_t detail) {
  if (!s.leaves) return;
  const float golden = 2.39996323f; /* 137.5 degrees */
  float phase = rng.range(0.0f, kTwoPi);
  /* "Fine enough to carry a leaf" is relative to the plant in hand: the da
     Vinci radii of a birch bottom out above any absolute threshold copied from
     an oak, which is how a birch ended up with no leaves at all. */
  float rMin = 1e9f, rMax = 0.0f;
  for (int32_t i = firstBranch; i < gNodeN; ++i) {
    if (gNodes[i].isRoot || gNodes[i].parent < 0) continue;
    rMin = minf(rMin, gNodes[i].radius);
    rMax = maxf(rMax, gNodes[i].radius);
  }
  if (rMin > rMax) return;
  const float fine = rMin + (rMax - rMin) * 0.42f;
  float twigLength = 0.0f;
  for (int32_t i = firstBranch; i < gNodeN; ++i) {
    const int32_t p = gNodes[i].parent;
    if (p < 0 || gNodes[i].isRoot || gNodes[i].radius > fine) continue;
    twigLength += len(sub(gNodes[i].p, gNodes[p].p));
  }
  if (twigLength < 1e-4f) return;
  /* A budget, not a rule. One card is a whole shoot, so a mature oak needs a
     few hundred of them, not thousands: `s.cards` sets the species' density and
     the tier trims it for distance. */
  const float tier = detail <= 0 ? 0.42f : detail == 1 ? 0.72f : 1.0f;
  const float budget = clampf(float(s.cards) * 190.0f * tier, 90.0f,
                              float(MAX_LEAF) * 0.55f);
  const float spacing = twigLength / budget;
  float carry = rng.range(0.0f, spacing);
  for (int32_t i = firstBranch; i < gNodeN; ++i) {
    const int32_t p = gNodes[i].parent;
    if (p < 0 || gNodes[i].isRoot || gNodes[i].radius > fine) continue;
    const V3 a = gNodes[p].p;
    const V3 b = gNodes[i].p;
    const float seg = len(sub(b, a));
    carry += seg;
    while (carry >= spacing) {
      carry -= spacing;
      if (gLeafN >= MAX_LEAF) return;
      const float along = seg > 1e-5f ? clampf(1.0f - carry / seg, 0.0f, 1.0f) : 1.0f;
      const V3 base = add(a, mul(sub(b, a), along));
      const V3 outward = norm(sub(base, v3(0.0f, s.crownY, 0.0f)));
      const float t = clampf((base.y - (s.crownY - s.crownRY)) / (2.0f * s.crownRY), 0.0f, 1.0f);
      phase += golden;
      const float ring = 0.45f + 0.55f * rng.f();
      const V3 d = norm(v3(outward.x * ring + cosf(phase) * 0.75f,
                           -0.35f + rng.range(-0.3f, 0.5f),
                           outward.z * ring + sinf(phase) * 0.75f));
      float* leaf = &gLeaf[gLeafN * LEAF_STRIDE];
      leaf[0] = base.x + d.x * 0.02f;
      leaf[1] = base.y + d.y * 0.02f;
      leaf[2] = base.z + d.z * 0.02f;
      leaf[3] = d.x; leaf[4] = d.y; leaf[5] = d.z;
      leaf[6] = s.leafSize * (0.72f + 0.5f * rng.f());
      leaf[7] = 0.2f + 0.8f * t;
      /* The card inherits the joint's own compliance and phase — the same
         numbers its twig's ring vertices carry — so a leaf rides the limb and
         can never drift off the end of it. The two ends of a twig have nearly
         the same sway, so a leaf between them never tears away. */
      leaf[8] = gNSway[p] * (1.0f - along) + gNSway[i] * along;
      leaf[9] = gNodePh[p] * (1.0f - along) + gNodePh[i] * along;
      ++gLeafN;
    }
  }
}

/* Leaf cards                                                       */
/* ---------------------------------------------------------------- */
/* Per-species card colouring. `petal` > 0 also grows bloom cards: the pale
 * blossom that sits inside an oak or a shrub crown in spring. These are the
 * numbers the studio's materials were tuned against, moved into the kernel with
 * everything else. */
struct LeafStyle {
  float c0[3];
  float c1[3];
  float petal[3];
  uint8_t bloom;   /* 0 = foliage only, 1 = every other card also blooms */
};

const LeafStyle kLeafStyle[SP_COUNT] = {
  /* oak     */ { { 0.66f, 0.72f, 0.60f }, { 1.15f, 1.15f, 1.00f }, { 1.00f, 0.80f, 0.88f }, 1 },
  /* birch   */ { { 0.60f, 0.70f, 0.50f }, { 1.30f, 1.25f, 0.90f }, { 0.96f, 0.97f, 0.82f }, 1 },
  /* acacia  */ { { 0.70f, 0.75f, 0.50f }, { 1.20f, 1.20f, 0.85f }, { 1.00f, 1.00f, 1.00f }, 0 },
  /* shrub   */ { { 0.66f, 0.72f, 0.60f }, { 1.15f, 1.15f, 1.00f }, { 1.00f, 0.90f, 0.60f }, 1 },
  /* ashbush */ { { 0.40f, 0.44f, 0.36f }, { 0.75f, 0.78f, 0.62f }, { 1.00f, 1.00f, 1.00f }, 0 },
  /* deadtree*/ { { 0.50f, 0.42f, 0.36f }, { 0.80f, 0.72f, 0.62f }, { 1.00f, 1.00f, 1.00f }, 0 },
  /* fern    */ { { 0.44f, 0.64f, 0.30f }, { 0.92f, 1.02f, 0.55f }, { 1.00f, 1.00f, 1.00f }, 0 },
  /* treefern*/ { { 0.38f, 0.60f, 0.26f }, { 0.86f, 1.00f, 0.50f }, { 1.00f, 1.00f, 1.00f }, 0 },
  /* the rest carry their colour on the mesh itself */ { { 1.0f, 1.0f, 1.0f }, { 1.0f, 1.0f, 1.0f }, { 1.0f, 1.0f, 1.0f }, 0 }
};

/* Append one quad. `b` is the card's base, `dir` runs to its tip, `size` is the
 * full card length, `part` is 1 for foliage or 2 for a bloom. */
void pushCard(V3 b, V3 dir, float size, float roll, float c0r, float c0g, float c0b,
              float c1r, float c1g, float c1b, float shade, float rnd, float sway,
              float phase, float part, V3 ctr) {
  if (gCardN >= MAX_LEAF) return;
  const V3 v = norm(dir);
  V3 u = v3(v.z, 0.0f, -v.x);
  if (len(u) < 0.2f) u = v3(1.0f, 0.0f, 0.0f);
  u = norm(u);
  const V3 w = cross(v, u);
  const float cr = cosf(roll), sr = sinf(roll);
  const V3 axis = norm(add(mul(u, cr), mul(w, sr)));
  V3 n = norm(cross(v, axis));
  /* The card faces out of the crown, never into it. */
  const V3 outward = norm(sub(b, ctr));
  if (dot(n, outward) < 0.0f) n = mul(n, -1.0f);
  n = norm(add(mul(n, 0.4f), mul(outward, 0.6f)));
  const float h = size * 0.42f;
  const V3 tip = add(b, mul(v, size));
  const float t = clampf(shade, 0.0f, 1.0f);
  const float shadow = 0.85f + 0.30f * rnd;
  const float col[3] = { lerpf(c0r, c1r, t) * shadow, lerpf(c0g, c1g, t) * shadow,
                         lerpf(c0b, c1b, t) * shadow };
  const V3 centroid = mul(add(b, tip), 0.5f);
  const int32_t base = gCardV;
  /* 3 rows x 2 columns. The midrib droops, the two halves fold towards each
     other, and the normal turns with the fold, so a single card shades across
     its own width instead of flipping as one flat plane. */
  const float droop = size * 0.10f;
  for (int32_t r0 = 0; r0 < 3; ++r0) {
    const float fr = float(r0) * 0.5f;
    const V3 along = add(b, mul(sub(tip, b), fr));
    const float width = h * (1.0f - 0.28f * fr);
    for (int32_t c0 = 0; c0 < 2; ++c0) {
      const float side = c0 ? 1.0f : -1.0f;
      const int32_t i = gCardV++;
      const V3 p = add(sub(along, mul(n, droop * fr * fr)), mul(axis, side * width));
      const V3 vn = norm(add(add(n, mul(axis, side * 0.42f)), mul(v, (fr - 0.5f) * 0.22f)));
      gCardPos[i * 3] = p.x; gCardPos[i * 3 + 1] = p.y; gCardPos[i * 3 + 2] = p.z;
      gCardNrm[i * 3] = vn.x; gCardNrm[i * 3 + 1] = vn.y; gCardNrm[i * 3 + 2] = vn.z;
      gCardCol[i * 3] = col[0]; gCardCol[i * 3 + 1] = col[1]; gCardCol[i * 3 + 2] = col[2];
      gCardUv[i * 2] = c0 ? 1.0f : 0.0f; gCardUv[i * 2 + 1] = fr;
      gCardRnd[i] = rnd;
      gCardCen[i * 3] = centroid.x; gCardCen[i * 3 + 1] = centroid.y; gCardCen[i * 3 + 2] = centroid.z;
      gCardSway[i] = sway;
      gCardPh[i] = phase;
      gCardPart[i] = part;
    }
  }
  /* Two quads. The card normal was flipped towards the outside of the crown a
     moment ago, so the winding has to follow it: emitted blind, half the cards
     ended up front-facing away from their own normal and were culled, which is
     exactly the shard-of-cardboard look the crowns had. */
  const V3 face = cross(axis, v);
  const bool flip = dot(face, n) > 0.0f;
  for (int32_t r0 = 0; r0 < 2; ++r0) {
    const int32_t a = base + r0 * 2, bq = a + 1, c1 = a + 2, d = a + 3;
    if (!flip) {
      gCardIdx[gCardI++] = uint32_t(a);
      gCardIdx[gCardI++] = uint32_t(c1);
      gCardIdx[gCardI++] = uint32_t(bq);
      gCardIdx[gCardI++] = uint32_t(bq);
      gCardIdx[gCardI++] = uint32_t(c1);
      gCardIdx[gCardI++] = uint32_t(d);
    } else {
      gCardIdx[gCardI++] = uint32_t(a);
      gCardIdx[gCardI++] = uint32_t(bq);
      gCardIdx[gCardI++] = uint32_t(c1);
      gCardIdx[gCardI++] = uint32_t(bq);
      gCardIdx[gCardI++] = uint32_t(d);
      gCardIdx[gCardI++] = uint32_t(c1);
    }
  }
  ++gCardN;
}

/* Turn every anchor into a card, then add the blossom cards. Called by
 * fe_flora_tree right after the wood is grown, so one call still produces the
 * whole plant. */
void emitLeafCards(int32_t kind, Rng& rng) {
  if (kind < 0 || kind >= SP_COUNT) return;
  const LeafStyle& st = kLeafStyle[kind];
  const SpeciesSpec& sp = kSpecies[kind];
  const V3 ctr = v3(0.0f, sp.crownY, 0.0f);
  for (int32_t i = 0; i < gLeafN; ++i) {
    const float* a = &gLeaf[i * LEAF_STRIDE];
    const V3 b = v3(a[0], a[1], a[2]);
    const V3 d = v3(a[3], a[4], a[5]);
    const float size = a[6];
    pushCard(b, d, size, rng.range(0.0f, kPi), st.c0[0], st.c0[1], st.c0[2],
             st.c1[0], st.c1[1], st.c1[2], a[7], rng.f(), a[8], a[9], 1.0f, ctr);
    /* Blossom: a small quad turned across the leaf, twice as large on every
       other card so the crown is speckled rather than uniform. */
    if (st.bloom && (i & 1) == 0) {
      const V3 p = add(b, v3(rng.range(-0.12f, 0.12f), rng.range(-0.12f, 0.12f),
                             rng.range(-0.12f, 0.12f)));
      const float a1 = rng.range(0.0f, kTwoPi), tilt = rng.range(0.0f, 1.1f);
      const V3 pd = norm(v3(cosf(a1) * sinf(tilt), cosf(tilt), sinf(a1) * sinf(tilt)));
      pushCard(p, pd, size * 0.34f, 0.0f, st.petal[0], st.petal[1], st.petal[2],
               st.petal[0] * 1.15f, st.petal[1] * 1.15f, st.petal[2] * 1.15f,
               0.75f, rng.f(), a[8], a[9], 2.0f, ctr);
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
  float tile;      /* metres per texture repeat: the stone's real grain   */
};

const RockSpec kRock[ROCK_COUNT] = {
  /* granite   */ { 6, { 1.00f, 1.00f, 1.00f }, 1.00f, 0.07f, 0.55f },
  /* sandstone */ { 6, { 1.40f, 0.98f, 0.68f }, 0.25f, 0.17f, 0.75f },
  /* basalt    */ { 9, { 0.34f, 0.33f, 0.34f }, 0.00f, 0.07f, 0.42f }
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
  /* Texture scale, in metres. A boulder and a hand specimen are made of the
     same granite, so the grain has to be the same size on both: the UVs below
     are arc lengths divided by this, not 0..1 across whatever shape came out.
     The repeat count around the stone is rounded to a whole number so the
     meridian seam closes instead of cutting the grain. */

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

  /* Mean radius of the body that was actually grown, so one texture repeat is
     `tile` metres of stone and not `tile` metres of whatever bounding box the
     seed happened to produce. Sampled on the same grid the mesh uses. */
  float radiusSum = 0.0f;
  int32_t radiusN = 0;
  for (int32_t j = 0; j <= 12; ++j) {
    const float th = float(j) / 12.0f * kPi;
    const float st = sinf(th), ct = cosf(th);
    for (int32_t i = 0; i < 16; ++i) {
      const float f = float(i) / 16.0f * kTwoPi;
      radiusSum += radiusAt(v3(st * cosf(f), ct, st * sinf(f)));
      ++radiusN;
    }
  }
  const float meanR = radiusN > 0 ? radiusSum / float(radiusN) : 1.0f;
  const float uvTile = maxf(0.08f, rs.tile);
  const float rMean = meanR * (sx + sz) * 0.5f;
  int32_t uRepeat = int32_t(floorf(kTwoPi * rMean / uvTile + 0.5f));
  if (uRepeat < 2) uRepeat = 2;
  const float vScale = meanR * sy / uvTile;

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
      const float uu = float(i) / float(nu) * float(uRepeat);
      const float vv = th * vScale;
      pushVert(p, n, uu, vv, rr, gg, bb,
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
  /* Density has to shorten the colony's stride, not only add attraction
     points: a denser crown that steps as far as a sparse one converges to a
     thinner skeleton, which is how the slider could add "branches" and return
     fewer vertices. */
  s.step *= 1.0f / (0.55f + 0.45f * d);
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

/* ==================================================================== */
/* Ground cover — grass, flowers, succulents, palms and pebbles          */
/* ==================================================================== */
/* Everything below grows a plant from its own botanical numbers instead of
 * scaling a primitive. The units are metres, the root sits on y = 0 and every
 * mesh is closed where it meets the ground, so the studio can place a tuft on a
 * slope and not see the inside of the geometry.
 *
 * The measurements are the published ranges for each species:
 *   tall fescue tuft      0.25-0.35 m, 20-30 blades, blade 3-6 mm wide
 *   Miscanthus sinensis   1.2-2.0 m, 12-20 blades, blade 10-18 mm wide
 *   Bellis perennis       0.08-0.15 m, head 20-30 mm, 11-15 ray florets
 *   Tulipa gesneriana     0.30-0.50 m, 6 tepals in two whorls
 *   Lavandula ang.        0.40-0.70 m, spike of 6-10 verticillasters
 *   Carnegiea gigantea    5-12 m, 12-24 ribs, arms from 2 m up
 *   Ferocactus wislizeni  0.6-1.0 m, 13-25 ribs
 *   Agave americana       1.0-1.8 m rosette, 20-30 leaves, 3-5 cm spine
 *   Cocos nucifera        8-12 m clear trunk, 12-16 fronds, 60-90 leaflets
 *   river pebble          20-200 mm, rounded by transport, flat underside
 */

/* A folded leaf blade: `cols` = 3 gives the V-shaped midrib crease that makes a
 * blade catch light on one half and shade the other. The spine is integrated
 * step by step, so a blade that leans past vertical genuinely droops. */
void blade(V3 root, V3 bendAxis, float length, float width, float lean,
           float droop, int32_t rows, float shade0, float shade1, float rnd,
           float sway0, float sway1, float phase, int32_t cols = 3) {
  if (rows < 2) rows = 2;
  /* cols = 3 gives the folded midrib; cols = 2 is a single flat card. A lawn of
     a hundred thousand tufts is drawn with cards, a plant you walk up to with
     the fold — same blade, two fidelities. */
  if (cols < 2) cols = 2;
  if (cols > 3) cols = 3;
  bendAxis = norm(v3(bendAxis.x, 0.0f, bendAxis.z));
  if (len(bendAxis) < 0.5f) bendAxis = v3(1.0f, 0.0f, 0.0f);
  const V3 widthAxis = norm(cross(v3(0.0f, 1.0f, 0.0f), bendAxis));
  const int32_t first = gVert;
  const float ds = length / float(rows - 1);
  V3 p = root;
  const V3 cen = add(root, mul(v3(0.0f, 1.0f, 0.0f), length * 0.5f));
  for (int32_t r = 0; r < rows; ++r) {
    const float t = float(r) / float(rows - 1);
    const float theta = lean + droop * t;
    const V3 tangent = norm(add(v3(0.0f, cosf(theta), 0.0f), mul(bendAxis, sinf(theta))));
    V3 n = norm(cross(tangent, widthAxis));
    /* Taper to a sub-millimetre tip, never to a point: a collapsed row would
       emit zero-area triangles that no renderer can shade. */
    float w = width * (1.0f - t) * (1.0f - t * 0.35f);
    if (w < width * 0.05f) w = width * 0.05f;
    const float fold = w * 0.38f;
    gPenSway = lerpf(sway0, sway1, t);
    gPenPh = phase;
    for (int32_t c = 0; c < cols; ++c) {
      const float off = (cols == 2) ? (c == 0 ? -w : w) : ((c == 0) ? -w : (c == 2 ? w : 0.0f));
      const float rise = (cols == 3 && c == 1) ? fold : 0.0f;
      const V3 v = add(add(p, mul(widthAxis, off)), mul(n, rise));
      const V3 nrm = (cols == 2)
                        ? norm(add(n, mul(widthAxis, c == 0 ? -0.28f : 0.28f)))
                        : norm(add(n, mul(widthAxis, (c == 0) ? -0.55f : (c == 2 ? 0.55f : 0.0f))));
      const float bs = lerpf(shade0, shade1, t);
      pushVert(v, nrm, float(c) * 0.5f, t, bs * gLeafCol[0], bs * gLeafCol[1],
               bs * gLeafCol[2], rnd, cen);
    }
    if (r + 1 < rows) p = add(p, mul(tangent, ds));
  }
  for (int32_t r = 0; r + 1 < rows; ++r) {
    for (int32_t c = 0; c + 1 < cols; ++c) {
      const int32_t a = first + r * cols + c;
      const int32_t b = a + 1;
      const int32_t cc = a + cols;
      const int32_t d = cc + 1;
      pushTri(a, b, cc);
      pushTri(b, d, cc);
    }
  }
}

/* A ribbed column — the cross-section radius is modulated by cos(ribs*theta),
 * which is the shape a saguaro stem or a barrel cactus actually has. Rings are
 * capped at both ends so the shell is closed. */
void ribbedColumn(const V3* path, const float* radii, int32_t rings, int32_t sides,
                  int32_t ribs, float amp, float shade0, float shade1, float rnd,
                  float sway0, float sway1, float phase) {
  if (rings < 2 || sides < 3) return;
  const V3 up = v3(0.0f, 1.0f, 0.0f);
  const int32_t first = gVert;
  V3 prevFrame = v3(1.0f, 0.0f, 0.0f);
  for (int32_t i = 0; i < rings; ++i) {
    const V3 a = path[i < 1 ? 0 : i - 1];
    const V3 b = path[i + 1 < rings ? i + 1 : rings - 1];
    V3 t = norm(sub(b, a));
    if (len(t) < 0.5f) t = up;
    V3 u = sub(prevFrame, mul(t, dot(prevFrame, t)));
    if (len(u) < 1e-4f) {
      const V3 ref = absf(t.y) > 0.95f ? v3(1.0f, 0.0f, 0.0f) : up;
      u = sub(ref, mul(t, dot(ref, t)));
    }
    u = norm(u);
    prevFrame = u;
    const V3 w = cross(t, u);
    const float vParam = float(i) / float(rings - 1);
    const V3 cen = path[rings / 2];
    gPenSway = lerpf(sway0, sway1, vParam);
    gPenPh = phase;
    for (int32_t j = 0; j <= sides; ++j) {
      const float th = (float(j) / float(sides)) * kTwoPi;
      const float rib = 1.0f + amp * cosf(th * float(ribs));
      /* The full round normal. Dropping the w.y term here left the arm normals
         12% short of unit length, which shades the bend of every arm wrong. */
      const float ct = cosf(th), st = sinf(th);
      const V3 nrm = v3(u.x * ct + w.x * st, u.y * ct + w.y * st, u.z * ct + w.z * st);
      const float rr = radii[i] * rib;
      pushVert(add(path[i], mul(nrm, rr)), nrm, float(j) / float(sides), vParam,
               lerpf(shade0, shade1, vParam), rnd, cen);
    }
  }
  const int32_t stride = sides + 1;
  for (int32_t i = 0; i + 1 < rings; ++i) {
    for (int32_t j = 0; j < sides; ++j) {
      const int32_t a = first + i * stride + j;
      const int32_t b = a + 1;
      const int32_t c = a + stride;
      const int32_t d = c + 1;
      pushTri(a, c, b);
      pushTri(b, c, d);
    }
  }
  /* Caps: a fan to a centre vertex, so the shell has no hole. */
  for (int32_t end = 0; end < 2; ++end) {
    const int32_t ring = end ? rings - 1 : 0;
    const V3 centre = path[ring];
    gPenSway = lerpf(sway0, sway1, float(ring) / float(rings - 1));
    const int32_t ci = pushVert(centre, v3(0.0f, end ? 1.0f : -1.0f, 0.0f), 0.5f, 0.5f,
                                lerpf(shade0, shade1, float(ring) / float(rings - 1)), rnd, centre);
    const int32_t base = first + ring * stride;
    for (int32_t j = 0; j < sides; ++j) {
      if (end) pushTri(base + j, ci, base + j + 1);
      else pushTri(base + j + 1, ci, base + j);
    }
  }
}

/* One grass tuft: blades on the golden angle, each with its own lean, length and
 * droop, so no two blades trace the same arc. */
int32_t generateGrass(int32_t kind, uint32_t seed, int32_t detail) {
  const bool tall = (kind == SP_TALLGRASS);
  Rng rng(seed ^ 0x2545f491u);
  const float H = (tall ? 1.85f : 0.36f) * gShapeH;
  const float width = tall ? 0.0135f : 0.0048f;
  const int32_t base = tall ? 16 : 24;
  int32_t count = int32_t(float(base) * gShapeD * (0.85f + 0.3f * rng.f()));
  if (detail <= 0) count = count / 2;
  if (count < 6) count = 6;
  if (count > 48) count = 48;
  const int32_t rows = detail >= 2 ? (tall ? 6 : 5) : 4;
  /* A lawn blade is a card; a blade in your hand is folded. */
  const int32_t cols = detail >= 2 ? 3 : 2;
  for (int32_t i = 0; i < count; ++i) {
    /* Golden angle placement, jittered: successive blades never line up. */
    const float yaw = float(i) * 2.39996323f + rng.range(-0.35f, 0.35f);
    const float r = sqrtf(rng.f()) * width * 3.2f;
    const V3 root = v3(cosf(yaw) * r, 0.0f, sinf(yaw) * r);
    const V3 axis = v3(cosf(yaw), 0.0f, sinf(yaw));
    /* Outer blades are shorter and lean further out — the tuft opens up. */
    const float out = r / (width * 3.2f + 1e-5f);
    const float h = H * (1.0f - 0.30f * out) * rng.range(0.72f, 1.06f);
    const float lean = lerpf(tall ? 0.10f : 0.14f, tall ? 0.52f : 0.62f, out) + rng.range(-0.06f, 0.06f);
    const float droop = tall ? rng.range(0.50f, 0.95f) : rng.range(0.60f, 1.05f);
    gPenPart = 1.0f;
    blade(root, axis, h, width * rng.range(0.85f, 1.15f), lean, droop, rows,
          0.52f, 1.06f, rng.f(), 0.02f, 0.95f, yaw * 0.7f, cols);
  }
  return gVert;
}

/* Bellis / Tulipa / Lavandula. One stem builder, three heads: a flat composite
 * flower, a tepal cup and a spike of whorls. */
int32_t generateFlower(int32_t kind, uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x68e31da4u);
  const bool daisy = (kind == SP_DAISY);
  const bool tulip = (kind == SP_TULIP);
  /* The wildflower is a daisy head on a taller, multi-headed plant: three
   * stems from one crown, which is what a meadow tuft actually looks like. */
  const bool flower = (kind == SP_FLOWER);
  const bool composite = daisy || flower;
  const float H = (daisy ? 0.115f : tulip ? 0.40f : flower ? 0.42f : 0.55f) * gShapeH;
  const int32_t stems = (daisy || tulip) ? 1 : 3;
  const int32_t sides = detail >= 2 ? 5 : 4;
  for (int32_t s = 0; s < stems; ++s) {
    const float yaw = float(s) * 2.39996323f + rng.range(-0.2f, 0.2f);
    const float height = H * rng.range(0.88f, 1.08f);
    gPenPart = 0.0f;
    const V3 base = v3(cosf(yaw) * 0.012f, 0.0f, sinf(yaw) * 0.012f);
    const V3 lean = v3(cosf(yaw) * 0.035f, 0.0f, sinf(yaw) * 0.035f);
    /* Stem: three short tubes, so the stalk arcs instead of standing straight. */
    const int32_t rings = 3;
    V3 prev = v3(base.x, -0.01f, base.z);
    V3 frame = v3(1.0f, 0.0f, 0.0f);
    const float r0 = daisy ? 0.0016f : tulip ? 0.0042f : flower ? 0.0030f : 0.0026f;
    for (int32_t i = 1; i <= rings; ++i) {
      const float t = float(i) / float(rings);
      const V3 p = v3(base.x + lean.x * t * t, height * t, base.z + lean.z * t * t);
      frame = tubeSegment(prev, p, r0 * (1.0f - 0.25f * (float(i - 1) / float(rings))),
                          r0 * (1.0f - 0.25f * t), sides, height * t, 0.5f,
                          lerpf(0.55f, 0.95f, t), rng.f(), frame, i == rings,
                          0.02f, 0.45f, yaw);
      prev = p;
    }

    /* Leaves: two per stem for the composites, a fan of three for the spike. */
    const int32_t leaves = daisy ? 3 : (tulip ? 2 : flower ? 5 : 4);
    for (int32_t l = 0; l < leaves; ++l) {
      const float ly = height * (0.12f + 0.16f * float(l));
      const float lyaw = yaw + float(l) * 2.39996323f;
      const float len = (daisy ? 0.035f : tulip ? 0.10f : flower ? 0.075f : 0.085f) * rng.range(0.85f, 1.15f) * gShapeH;
      gPenPart = 1.0f;
      blade(v3(base.x, ly, base.z), v3(cosf(lyaw), 0.0f, sinf(lyaw)), len,
            len * 0.22f, 0.95f, 0.55f, detail >= 2 ? 4 : 3, 0.55f, 0.92f,
            rng.f(), 0.10f, 0.55f, lyaw);
    }

    if (composite) {
      /* Head: 13 ray florets on the golden angle around a domed disc. */
      gPenPart = 2.0f;
      const V3 head = v3(prev.x, height, prev.z);
      const int32_t petals = detail >= 2 ? (flower ? 14 : 13) : (flower ? 9 : 9);
      const float R = (flower ? 0.019f : 0.014f) * (0.9f + 0.2f * rng.f());
      for (int32_t i = 0; i < petals; ++i) {
        const float a = float(i) * 2.39996323f;
        const float a2 = rng.range(-0.06f, 0.06f);
        const V3 dirv = v3(cosf(a + a2), 0.0f, sinf(a + a2));
        blade(v3(head.x + dirv.x * 0.002f, head.y, head.z + dirv.z * 0.002f),
              v3(-dirv.z, 0.0f, dirv.x), R * rng.range(0.85f, 1.1f), 0.0032f,
              1.30f, -0.22f, 3, 0.72f, 1.12f, rng.f(), 0.35f, 0.55f, a);
      }
      /* Domed disc in the middle, tilted up like a real composite. It is its
         own material — a composite's disc florets are not ray florets — so it
         gets its own part id. */
      gPenPart = 3.0f;
      const int32_t seg = 10;
      const int32_t first = gVert;
      const V3 domeC = head;
      gPenSway = 0.4f;
      const float discR = flower ? 0.0068f : 0.0048f;
      const int32_t ci = pushVert(add(domeC, v3(0.0f, 0.0035f, 0.0f)), v3(0.0f, 1.0f, 0.0f),
                                  0.5f, 0.5f, 1.25f, rng.f(), domeC);
      for (int32_t j = 0; j <= seg; ++j) {
        const float a = (float(j) / float(seg)) * kTwoPi;
        pushVert(add(domeC, v3(cosf(a) * discR, 0.0012f, sinf(a) * discR)),
                 norm(v3(cosf(a) * 0.45f, 1.0f, sinf(a) * 0.45f)), 0.5f, 0.0f, 0.95f, rng.f(), domeC);
      }
      for (int32_t j = 0; j < seg; ++j) pushTri(ci, first + 1 + j, first + 2 + j);
    } else if (tulip) {
      /* Six tepals in two whorls form the cup. */
      gPenPart = 2.0f;
      const V3 cup = v3(prev.x, height * 0.88f, prev.z);
      for (int32_t i = 0; i < 6; ++i) {
        const float a = float(i) * 1.04719755f + (i >= 3 ? 0.30f : 0.0f);
        const float inward = (i >= 3) ? 0.16f : 0.26f;
        blade(v3(cup.x + cosf(a) * 0.008f, cup.y, cup.z + sinf(a) * 0.008f),
              v3(cosf(a), 0.0f, sinf(a)), 0.072f * gShapeH * rng.range(0.94f, 1.06f),
              0.024f, -inward, -0.55f, 4, 0.80f, 1.15f, rng.f(), 0.30f, 0.70f, a);
      }
      /* Three stamens standing inside the cup — the flower's own centre. */
      gPenPart = 3.0f;
      for (int32_t i = 0; i < 3; ++i) {
        const float a = float(i) * 2.09439510f + 0.4f;
        const V3 a0 = v3(cup.x, cup.y + 0.004f, cup.z);
        const V3 a1 = v3(cup.x + cosf(a) * 0.006f, cup.y + 0.030f, cup.z + sinf(a) * 0.006f);
        tubeSegment(a0, a1, 0.0012f, 0.0010f, 3, 0.0f, 1.0f, 0.95f, rng.f(),
                    v3(1.0f, 0.0f, 0.0f), true, 0.45f, 0.55f, a);
      }
    } else {
      /* Lavender: verticillasters up the top third of the stem. */
      gPenPart = 2.0f;
      const int32_t whorls = detail >= 2 ? 8 : 5;
      const float top = height * 0.62f;
      for (int32_t wI = 0; wI < whorls; ++wI) {
        const float t = float(wI) / float(whorls - 1);
        const float wy = lerpf(top, height, t);
        const int32_t per = 6;
        for (int32_t k = 0; k < per; ++k) {
          const float a = float(k) * 1.04719755f + float(wI) * 0.9f;
          const float rr = 0.006f * (1.0f - t * 0.35f);
          /* Two of the six florets in each whorl are still closed: a darker
             bud, which is what gives a lavender spike its shadow. */
          gPenPart = (k % 3 == 2) ? 3.0f : 2.0f;
          blade(v3(prev.x + cosf(a) * rr * 0.4f, wy, prev.z + sinf(a) * rr * 0.4f),
                v3(cosf(a), 0.0f, sinf(a)), 0.009f * rng.range(0.8f, 1.2f), 0.0026f,
                1.05f, 0.45f, 2, 0.86f, 1.18f, rng.f(), 0.45f, 0.75f, a);
        }
      }
    }
  }
  return gVert;
}

/* Cacti and agave: ribbed columns, arms, and a rosette of thick leaves. */
int32_t generateSucculent(int32_t kind, uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x1b56c4e9u);
  if (kind == SP_AGAVE) {
    /* Agave: 24 leaves in a rosette, thick at the base, spine at the tip, on
       the short woody caudex an A. americana actually stands on. */
    gPenPart = 0.0f;
    const int32_t caudexSides = detail >= 2 ? 8 : 5;
    tubeSegment(v3(0.0f, -0.10f, 0.0f), v3(0.0f, 0.10f, 0.0f), 0.075f * (0.7f + 0.3f * gShapeH),
                0.062f * (0.7f + 0.3f * gShapeH), caudexSides, 0.0f, 1.0f, 0.62f,
                rng.f(), v3(1.0f, 0.0f, 0.0f), true, 0.0f, 0.02f, 0.0f);
    gPenPart = 1.0f;
    int32_t leaves = detail >= 2 ? 24 : 14;
    const float H = 1.15f * gShapeH;
    for (int32_t i = 0; i < leaves; ++i) {
      const float a = float(i) * 2.39996323f;
      const float ring = float(i) / float(leaves);
      const float lean = lerpf(0.55f, 1.35f, ring);
      const float len = H * lerpf(1.0f, 0.42f, ring) * rng.range(0.92f, 1.08f);
      blade(v3(0.0f, 0.01f, 0.0f), v3(cosf(a), 0.0f, sinf(a)), len,
            len * 0.115f, lean, 0.35f, detail >= 2 ? 5 : 4, 0.72f, 1.02f,
            rng.f(), 0.03f, 0.42f, a);
    }
    return gVert;
  }
  const bool barrel = (kind == SP_BARREL);
  const int32_t ribs = barrel ? 21 : 20;
  const int32_t sides = detail >= 2 ? ribs * 2 : ribs;
  if (barrel) {
    /* Barrel cactus: a ribbed spheroid, widest at 45% of its height. */
    constexpr int32_t RINGS = 11;
    V3 path[RINGS];
    float rad[RINGS];
    /* Individuals differ: a barrel cactus grown from another seed is a little
       fatter or taller and leans off vertical by a degree or two. */
    const float H = 0.85f * gShapeH * rng.range(0.90f, 1.08f);
    const float R = 0.32f * (0.6f + 0.4f * gShapeH) * rng.range(0.88f, 1.12f);
    const float leanA = rng.range(0.0f, kTwoPi), leanK = rng.range(0.005f, 0.03f);
    for (int32_t i = 0; i < RINGS; ++i) {
      const float t = float(i) / float(RINGS - 1);
      path[i] = v3(cosf(leanA) * leanK * t * t, H * t, sinf(leanA) * leanK * t * t);
      const float bulge = sinf(kPi * clampf(t * 1.06f, 0.0f, 1.0f));
      rad[i] = R * (0.22f + 0.78f * powf(bulge, 0.62f));
    }
    ribbedColumn(path, rad, RINGS, sides, ribs, 0.085f, 0.62f, 0.96f, rng.f(),
                 0.0f, 0.10f, 0.0f);
    /* The crown of small yellow flowers a barrel cactus carries at the top. */
    gPenPart = 2.0f;
    for (int32_t i = 0; i < 6; ++i) {
      const float a = float(i) * 1.04719755f;
      const float rr = R * 0.30f;
      blade(v3(cosf(a) * rr, H * 0.985f, sinf(a) * rr), v3(cosf(a), 0.0f, sinf(a)),
            0.028f, 0.010f, 0.55f, -0.20f, 3, 1.05f, 1.25f, rng.f(), 0.0f, 0.10f, a);
    }
    return gVert;
  }
  /* Saguaro: a fluted stem with arms that leave the trunk two metres up and
     turn vertical, exactly how Carnegiea branches. */
  constexpr int32_t RINGS = 12;
  const float H = 5.6f * gShapeH;
  const float R = 0.30f * (0.7f + 0.3f * gShapeH);
  V3 path[RINGS];
  float rad[RINGS];
  for (int32_t i = 0; i < RINGS; ++i) {
    const float t = float(i) / float(RINGS - 1);
    path[i] = v3(sinf(t * 1.1f) * 0.05f, H * t, cosf(t * 0.9f) * 0.04f);
    rad[i] = R * (1.0f - 0.16f * t) * (1.0f + 0.10f * (1.0f - smoothstepf(0.0f, 0.12f, t)));
  }
  ribbedColumn(path, rad, RINGS, sides, ribs, 0.075f, 0.58f, 0.92f, rng.f(),
               0.0f, 0.30f, 0.0f);
  const int32_t arms = detail >= 2 ? 3 : 2;
  for (int32_t arm = 0; arm < arms; ++arm) {
    const float a = float(arm) * 2.09439510f + rng.range(-0.3f, 0.3f);
    const float y0 = H * rng.range(0.34f, 0.52f);
    const float out = R * 2.6f;
    const float rise = H * rng.range(0.22f, 0.34f);
    constexpr int32_t AR = 6;
    V3 ap[AR];
    float ar[AR];
    for (int32_t i = 0; i < AR; ++i) {
      const float t = float(i) / float(AR - 1);
      /* Elbow: sideways first, then up. */
      const float side = sinf(t * kHalfPi);
      const float up = 1.0f - cosf(t * kHalfPi);
      ap[i] = v3(cosf(a) * (R + out * side), y0 + rise * up,
                 sinf(a) * (R + out * side));
      ar[i] = R * 0.62f * (1.0f - 0.10f * t);
    }
    ribbedColumn(ap, ar, AR, sides > 16 ? 16 : sides, ribs, 0.075f, 0.58f, 0.90f,
                 rng.f(), 0.10f, 0.34f, a);
  }
  return gVert;
}

/* Coconut palm: a leaning trunk with ring scars, and a crown of pinnate fronds
 * whose leaflets alternate either side of the rachis. */
int32_t generatePalm(uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x7f4a7c15u);
  const float H = 8.4f * gShapeH;
  const int32_t sides = detail >= 2 ? 10 : 7;
  const int32_t rings = detail >= 2 ? 14 : 9;
  V3 prev = v3(0.0f, -0.05f, 0.0f);
  V3 frame = v3(1.0f, 0.0f, 0.0f);
  const float leanA = rng.range(0.6f, 2.4f);
  const float leanAmt = rng.range(0.6f, 1.3f);
  V3 top = prev;
  for (int32_t i = 1; i <= rings; ++i) {
    const float t = float(i) / float(rings);
    const V3 p = v3(cosf(leanA) * leanAmt * t * t, H * t, sinf(leanA) * leanAmt * t * t);
    const float r0 = 0.19f * (1.0f - 0.28f * (float(i - 1) / float(rings))) * (0.75f + 0.25f * gShapeH);
    const float r1 = 0.19f * (1.0f - 0.28f * t) * (0.75f + 0.25f * gShapeH);
    /* Ring scars: the shade dips every ring, which is what a palm trunk reads as. */
    frame = tubeSegment(prev, p, r0, r1, sides, H * t * 0.35f, 0.35f,
                        0.72f + 0.16f * (i % 2), rng.f(), frame, i == rings,
                        0.0f, 0.30f * t, 0.0f);
    prev = p;
    top = p;
  }
  const int32_t fronds = detail >= 2 ? 14 : 9;
  for (int32_t f = 0; f < fronds; ++f) {
    const float a = float(f) * 2.39996323f;
    const float droop = rng.range(0.55f, 1.25f);
    const float len = rng.range(2.2f, 3.4f) * (0.7f + 0.3f * gShapeH);
    const V3 axis = v3(cosf(a), 0.0f, sinf(a));
    const int32_t segs = detail >= 2 ? 5 : 4;
    V3 p = top;
    V3 dir = norm(add(v3(0.0f, 1.0f, 0.0f), mul(axis, 1.35f)));
    for (int32_t s = 0; s < segs; ++s) {
      const float t = float(s + 1) / float(segs);
      dir = norm(add(dir, v3(0.0f, -droop * 0.30f, 0.0f)));
      const V3 q = add(p, mul(dir, len / float(segs)));
      tubeSegment(p, q, lerpf(0.028f, 0.010f, t), lerpf(0.026f, 0.008f, t),
                  detail >= 2 ? 4 : 3, t, 1.0f, 0.80f, rng.f(),
                  v3(1.0f, 0.0f, 0.0f), false, 0.30f + 0.4f * t, 0.30f + 0.5f * t, a);
      /* Leaflets alternate left and right of the rachis. */
      const V3 side = norm(cross(dir, v3(0.0f, 1.0f, 0.0f)));
      const int32_t per = detail >= 2 ? 5 : 3;
      gPenPart = 1.0f;
      for (int32_t k = 0; k < per; ++k) {
        for (int32_t sgn = 0; sgn < 2; ++sgn) {
          const float lt = float(k) / float(per);
          const V3 at = add(p, mul(sub(q, p), lt));
          const float ll = 0.42f * (1.0f - 0.55f * lt) * rng.range(0.85f, 1.1f);
          const V3 out = mul(side, sgn ? 1.0f : -1.0f);
          blade(at, norm(add(out, mul(dir, 0.45f))), ll, 0.020f,
                lerpf(0.95f, 1.35f, lt), 0.65f, 3, 0.80f, 1.10f, rng.f(),
                0.32f + 0.4f * t, 0.35f + 0.45f * t, a + float(k));
        }
      }
      p = q;
    }
  }
  return gVert;
}

/* A river pebble: a rounded, water-worn solid with a flattened underside.
 * The rows stop short of the poles and the two poles are single vertices with
 * their own fans — a lat/long sphere whose pole rows collapse emits a ring of
 * zero-area triangles that no shader can light. */
int32_t generatePebble(uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x3c6ef372u);
  const int32_t rows = detail >= 2 ? 9 : 6;
  const int32_t sides = detail >= 2 ? 14 : 9;
  const float R = 0.085f * (0.7f + 0.5f * rng.f()) * gShapeH;
  const float squash = rng.range(0.55f, 0.85f);
  const uint32_t ns = seed | 1u;
  gPenSway = 0.0f;
  gPenPh = 0.0f;
  const V3 pivot = v3(0.0f, R * 0.5f, 0.0f);
  const int32_t first = gVert;
  for (int32_t i = 0; i < rows; ++i) {
    const float th = kPi * (float(i) + 0.5f) / float(rows);
    for (int32_t j = 0; j <= sides; ++j) {
      const float ph = (float(j) / float(sides)) * kTwoPi;
      const V3 n = v3(sinf(th) * cosf(ph), cosf(th), sinf(th) * sinf(ph));
      const float bumps = fbm(v3(n.x * 3.1f, n.y * 3.1f, n.z * 3.1f), ns, 3);
      const float rr = R * (1.0f + 0.22f * bumps);
      V3 p = v3(n.x * rr * 1.18f, n.y * rr * squash + R * 0.55f, n.z * rr);
      if (p.y < 0.0f) p.y *= 0.18f; /* flat underside, bedded in the ground */
      pushVert(p, norm(n), float(j) / float(sides), float(i) / float(rows),
               0.78f + 0.22f * (0.5f + 0.5f * n.y), rng.f(), pivot);
    }
  }
  const int32_t stride = sides + 1;
  for (int32_t i = 0; i + 1 < rows; ++i) {
    for (int32_t j = 0; j < sides; ++j) {
      const int32_t a = first + i * stride + j;
      const int32_t b = a + 1;
      const int32_t c = a + stride;
      const int32_t d = c + 1;
      pushTri(a, c, b);
      pushTri(b, c, d);
    }
  }
  for (int32_t end = 0; end < 2; ++end) {
    const float ny = end ? 1.0f : -1.0f;
    float py = ny * R * squash + R * 0.55f;
    if (py < 0.0f) py *= 0.18f;
    const int32_t pole = pushVert(v3(0.0f, py, 0.0f), v3(0.0f, ny, 0.0f), 0.5f,
                                  end ? 1.0f : 0.0f, end ? 1.0f : 0.62f, rng.f(), pivot);
    const int32_t ring = first + (end ? rows - 1 : 0) * stride;
    for (int32_t j = 0; j < sides; ++j) {
      if (end) pushTri(ring + j, pole, ring + j + 1);
      else pushTri(ring + j + 1, pole, ring + j);
    }
  }
  return gVert;
}

/* ==================================================================== */
/* Conifers, desert scrub and the card emitter                          */
/* ==================================================================== */

/* One conifer whorl table. The numbers follow the published habit of each
 * species: a Scots pine keeps its lower trunk clear and crowns from two thirds
 * up; a spruce keeps branches to the ground in a near-perfect cone; krummholz
 * is the same spruce flattened by wind at the treeline; juniper is a many-stem
 * shrub with soft, drooping sprays. */
struct ConiferSpec {
  float height;    /* metres to the leader tip                       */
  float trunkR;    /* radius at the root collar                      */
  float bare;      /* fraction of height before the first live whorl  */
  int32_t whorls;  /* branch levels up the trunk                     */
  int32_t perWhorl;
  float crownR;    /* longest branch, at the base of the crown        */
  float droop;     /* radians a branch falls below horizontal        */
  float needle;    /* needle length, metres                          */
  int32_t sprays;  /* needle rows along one branch                   */
  float profile;   /* 0.5 = cone, 1.2 = umbrella (pine)              */
  bool multi;      /* several stems from one root (juniper, krumm)    */
  float shade0;
  float shade1;
};

const ConiferSpec kConifer[4] = {
  /* pine    */ { 15.0f, 0.30f, 0.42f, 7, 4, 3.40f, 0.22f, 0.135f, 2, 0.62f, false, 0.55f, 0.95f },
  /* spruce  */ { 16.5f, 0.26f, 0.05f, 9, 5, 3.10f, 0.46f, 0.110f, 2, 0.85f, false, 0.50f, 0.90f },
  /* krumm   */ { 1.55f, 0.11f, 0.03f, 4, 4, 1.55f, 0.60f, 0.065f, 1, 1.15f, true, 0.52f, 0.94f },
  /* juniper */ { 2.70f, 0.10f, 0.02f, 5, 3, 1.15f, 0.85f, 0.048f, 1, 1.30f, true, 0.58f, 1.00f }
};

/* A needle spray: two rows of needles either side of a twig, which is what a
 * conifer twig actually looks like from a metre away. */
void needleSpray(V3 from, V3 dir, float length, float needle, int32_t count,
                 float shade, float rnd, float sway, float phase) {
  /* A conifer in full detail is thousands of small blades; stop before the
     shared vertex buffer runs out instead of emitting a truncated branch. */
  if (gVert > MAX_VERT - 96) return;
  const V3 side = norm(cross(dir, v3(0.0f, 1.0f, 0.0f)));
  const V3 up = norm(cross(side, dir));
  for (int32_t i = 0; i < count; ++i) {
    const float t = (float(i) + 0.5f) / float(count);
    const V3 at = add(from, mul(dir, length * t));
    const float len = needle * (1.0f - 0.35f * t) * (0.85f + 0.3f * rnd);
    for (int32_t s = 0; s < 2; ++s) {
      const float sgn = s ? 1.0f : -1.0f;
      const V3 out = norm(add(mul(side, sgn), mul(up, 0.35f)));
      gPenPart = 1.0f;
      blade(at, out, len, needle * 0.16f, 1.15f, 0.55f, 2,
            shade * 0.85f, shade, rnd, sway, sway * 1.05f, phase);
    }
  }
}

/* A branch: three drooping segments with a needle spray on each, plus one
 * fork, so the silhouette is ragged instead of a clean spoke. */
void coniferBranch(V3 base, V3 dir, float length, float droop, const ConiferSpec& sp,
                   int32_t detail, float rnd, float phase) {
  if (gVert > MAX_VERT - 400) return;
  const int32_t segs = detail >= 2 ? 3 : 2;
  const int32_t sides = detail >= 2 ? 5 : 4;
  V3 p = base;
  float r = sp.trunkR * 0.16f;
  V3 frame = v3(0.0f, 0.0f, 1.0f);
  for (int32_t s = 0; s < segs; ++s) {
    const float t = float(s + 1) / float(segs);
    /* The branch tip falls as it reaches out: droop accumulates with `t`. */
    const V3 d = norm(add(dir, v3(0.0f, -droop * t, 0.0f)));
    const V3 q = add(p, mul(d, length / float(segs)));
    gPenPart = 0.0f;
    frame = tubeSegment(p, q, r, r * 0.70f, sides, t * length, 0.8f,
                        sp.shade0 + (sp.shade1 - sp.shade0) * t, rnd, frame,
                        false, 0.05f + 0.35f * t, 0.10f + 0.45f * t, phase);
    /* A branch that carries needles all the way along it. */
    if (sp.sprays > 0) {
      const int32_t n = detail >= 2 ? sp.sprays + 1 : 1;
      needleSpray(p, d, length / float(segs) * 1.05f, sp.needle, n,
                  sp.shade0 + (sp.shade1 - sp.shade0) * t + 0.05f, rnd,
                  0.15f + 0.45f * t, phase);
    }
    /* One fork at the halfway point, angled up out of the needle plane. */
    if (detail >= 2 && s == segs / 2) {
      const V3 side = norm(cross(d, v3(0.0f, 1.0f, 0.0f)));
      const V3 fq = norm(add(mul(d, 0.75f), mul(side, 0.55f)));
      coniferBranch(p, fq, length * 0.42f, droop, sp, detail - 1, rnd, phase + 0.7f);
    }
    p = q;
    r *= 0.72f;
  }
}

int32_t generateConifer(int32_t kind, uint32_t seed, int32_t detail) {
  const ConiferSpec& sp = kConifer[kind - SP_PINE];
  Rng rng(seed ^ 0x4f1bbcdcu);
  const float H = sp.height * gShapeH;
  const float trunkR = sp.trunkR * (0.7f + 0.3f * gShapeH);
  const int32_t stems = sp.multi ? 2 : 1;
  for (int32_t stem = 0; stem < stems; ++stem) {
    const float sa = float(stem) * kTwoPi / float(stems) + rng.range(-0.4f, 0.4f);
    const float sd = sp.multi ? trunkR * rng.range(0.8f, 2.2f) : 0.0f;
    const V3 root = v3(cosf(sa) * sd, -0.12f * trunkR * 8.0f, sinf(sa) * sd);
    const float stemH = H * (sp.multi ? rng.range(0.60f, 0.95f) : rng.range(0.94f, 1.06f));
    const float leanA = rng.range(0.0f, kTwoPi);
    const float leanK = sp.multi ? rng.range(0.10f, 0.35f) : rng.range(0.0f, 0.06f);
    const int32_t rings = detail >= 2 ? 12 : 8;
    const int32_t sides = detail >= 2 ? 8 : 5;
    V3 prev = root;
    V3 frame = v3(1.0f, 0.0f, 0.0f);
    V3 top = root;
    for (int32_t i = 1; i <= rings; ++i) {
      const float t = float(i) / float(rings);
      const V3 p = v3(root.x + cosf(leanA) * leanK * t * t * stemH * 0.25f, root.y + stemH * t,
                      root.z + sinf(leanA) * leanK * t * t * stemH * 0.25f);
      const float r0 = trunkR * (1.0f - 0.86f * (float(i - 1) / float(rings)));
      const float r1 = trunkR * (1.0f - 0.86f * t);
      /* The root collar flares where it meets the soil. */
      const float flare = (i == 1) ? 1.55f : 1.0f;
      gPenPart = 0.0f;
      frame = tubeSegment(prev, p, (r0 < 0.006f ? 0.006f : r0) * flare, (r1 < 0.005f ? 0.005f : r1),
                          sides, stemH * t * 0.5f, 0.7f,
                          sp.shade0 + (sp.shade1 - sp.shade0) * 0.35f, rng.f(), frame,
                          i == rings, 0.0f, 0.02f * t, float(stem) * 0.9f);
      prev = p;
      top = p;
    }
    /* Whorls. Branch reach follows the crown profile: longest at the bottom of
     * the live crown, vanishing at the leader, which is what makes a cone. */
    const int32_t whorls = detail >= 2 ? sp.whorls : (sp.whorls * 2 + 2) / 3;
    for (int32_t w = 0; w < whorls; ++w) {
      const float t = float(w) / float(whorls - 1);
      const float y = root.y + stemH * (sp.bare + (1.0f - sp.bare) * t * 0.96f);
      const float taper = powf(1.0f - t, sp.profile);
      const float reach = sp.crownR * taper * (0.82f + 0.36f * rng.f()) *
                          (0.6f + 0.4f * gShapeH) * (stem ? 1.0f - 0.18f * float(stem) : 1.0f);
      if (reach < sp.needle * 2.0f) continue;
      /* The whorl turns by a fraction of the golden angle so the branches of
         successive whorls do not stack into visible columns. */
      const float rot = float(w) * 2.39996323f * 0.618f + float(stem) * 1.1f;
      const int32_t n = detail >= 2 ? sp.perWhorl : (sp.perWhorl + 1) / 2;
      for (int32_t b = 0; b < n; ++b) {
        const float a = rot + kTwoPi * float(b) / float(n) + rng.range(-0.18f, 0.18f);
        const V3 dir = v3(cosf(a), 0.0f, sinf(a));
        const V3 base = v3(root.x + cosf(leanA) * leanK * (t * t) * stemH * 0.25f +
                               dir.x * trunkR * 0.5f,
                           y, root.z + sinf(leanA) * leanK * (t * t) * stemH * 0.25f +
                               dir.z * trunkR * 0.5f);
        coniferBranch(base, dir, reach, sp.droop * (0.8f + 0.4f * rng.f()), sp, detail,
                      rng.f(), float(b) * 1.7f);
      }
    }
    /* Leader: a tuft of upward needles on the tip so the tree has a point. */
    for (int32_t i = 0; i < (detail >= 2 ? 6 : 3); ++i) {
      const float a = float(i) * 2.39996323f;
      gPenPart = 1.0f;
      blade(add(top, v3(0.0f, -sp.needle * 0.6f, 0.0f)),
            v3(cosf(a) * 0.35f, 1.0f, sinf(a) * 0.35f), sp.needle * 2.4f, sp.needle * 0.22f,
            0.30f, 0.25f, 2, sp.shade1 * 0.95f, sp.shade1, rng.f(), 0.35f, 0.55f, a);
    }
  }
  return gVert;
}

/* -------------------------------------------------------------------- */
/* Prickly pear (Opuntia): a chain of flattened cladodes                  */
/* -------------------------------------------------------------------- */
/* A pad is a flattened ellipsoid 22 cm long, 15 cm wide and 2.2 cm thick —
 * the published range for O. ficus-indica — built ring by ring so the rim is
 * a real rim and not a decal. */
void pad(V3 base, V3 up, V3 side, float length, float width, float thick,
         float shade, float rnd, int32_t detail) {
  const int32_t rings = detail >= 2 ? 6 : 4;
  const int32_t around = detail >= 2 ? 10 : 7;
  const V3 axis = norm(up);
  const V3 flat = norm(side);
  const V3 front = norm(cross(axis, flat));
  const V3 mid = add(base, mul(axis, length * 0.5f));
  const int32_t first = gVert;
  gPenPart = 0.0f;
  for (int32_t i = 0; i < rings; ++i) {
    const float t = (float(i) + 0.5f) / float(rings);
    const float bulge = sinf(kPi * t);
    const float w = width * 0.5f * powf(bulge, 0.55f);
    const float th = thick * 0.5f * powf(bulge, 0.45f);
    const V3 centre = add(base, mul(axis, length * t));
    for (int32_t j = 0; j <= around; ++j) {
      const float a = (float(j) / float(around)) * kTwoPi;
      const float ca = cosf(a), sn = sinf(a);
      /* Areoles: the pad dimples where the spines sit, on a 5/8 lattice. */
      const float dimple = 1.0f - 0.06f * maxf(0.0f, cosf(a * 5.0f + t * 8.0f));
      const V3 p = add(centre, add(mul(flat, ca * w * dimple), mul(front, sn * th * dimple)));
      const V3 n = norm(add(mul(flat, ca), mul(front, sn * 2.2f)));
      pushVert(p, n, float(j) / float(around), t, shade + 0.10f * (1.0f - t), rnd, mid);
    }
  }
  const int32_t stride = around + 1;
  for (int32_t i = 0; i + 1 < rings; ++i) {
    for (int32_t j = 0; j < around; ++j) {
      const int32_t a = first + i * stride + j;
      const int32_t b = a + 1;
      const int32_t c = a + stride;
      const int32_t d = c + 1;
      pushTri(a, c, b);
      pushTri(b, c, d);
    }
  }
  /* Close both ends so a pad seen edge-on is not a hole. */
  for (int32_t end = 0; end < 2; ++end) {
    const V3 poleP = add(base, mul(axis, end ? length : 0.0f));
    const int32_t pole = pushVert(poleP, mul(axis, end ? 1.0f : -1.0f), 0.5f,
                                  end ? 1.0f : 0.0f, shade * 0.92f, rnd, mid);
    const int32_t ring = first + (end ? rings - 1 : 0) * stride;
    for (int32_t j = 0; j < around; ++j) {
      if (end) pushTri(ring + j, pole, ring + j + 1);
      else pushTri(ring + j + 1, pole, ring + j);
    }
  }
}

void pricklyBranch(V3 base, V3 dir, float length, int32_t depth, int32_t detail,
                   Rng& rng, float sway) {
  const V3 up = norm(add(dir, v3(0.0f, 0.55f, 0.0f)));
  const V3 side = norm(cross(up, v3(rng.range(-1.0f, 1.0f), 0.0f, rng.range(-1.0f, 1.0f))));
  pad(base, up, side, length, length * 0.68f, length * 0.13f, 0.62f, rng.f(), detail);
  if (depth <= 0) {
    /* A pad that ends a branch flowers at its upper edge: two blooms in the
       magenta-to-yellow range prickly pears actually open in spring. */
    const int32_t blooms = detail >= 2 ? 2 : 1;
    for (int32_t b = 0; b < blooms; ++b) {
      const V3 at = add(add(base, mul(up, length * (0.80f + 0.14f * float(b)))), mul(side, rng.range(-0.03f, 0.03f)));
      for (int32_t i = 0; i < 5; ++i) {
        const float a = float(i) * 1.2566f;
        gPenPart = 2.0f;
        blade(at, norm(v3(cosf(a), 0.55f, sinf(a))), 0.032f, 0.014f, 1.05f, -0.2f, 2,
              1.05f, 1.25f, rng.f(), sway * 1.1f, sway * 1.1f, a);
      }
    }
    return;
  }
  const int32_t kids = detail >= 2 ? 2 : 1;
  for (int32_t k = 0; k < kids; ++k) {
    const float a = float(k) * 2.1f + rng.range(-0.5f, 0.5f) + (k ? 3.1f : 0.0f);
    const V3 cdir = norm(add(mul(up, 0.65f), v3(cosf(a) * 0.9f, 0.0f, sinf(a) * 0.9f)));
    const V3 cbase = add(base, mul(up, length * (0.88f + 0.06f * float(k))));
    pricklyBranch(cbase, cdir, length * rng.range(0.62f, 0.82f), depth - 1, detail, rng, sway);
  }
}

int32_t generatePrickly(uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x2c1b3c6du);
  const int32_t stems = 2;
  for (int32_t s = 0; s < stems; ++s) {
    const float a = float(s) * 2.39996323f;
    const V3 base = v3(cosf(a) * 0.07f, -0.01f, sinf(a) * 0.07f);
    const V3 dir = norm(v3(cosf(a) * 0.55f, 1.0f, sinf(a) * 0.55f));
    pricklyBranch(base, dir, 0.32f * (0.9f + 0.25f * gShapeH), detail >= 2 ? 3 : 2,
                  detail, rng, 0.15f);
  }
  return gVert;
}

/* -------------------------------------------------------------------- */
/* Joshua tree (Yucca brevifolia)                                        */
/* -------------------------------------------------------------------- */
/* A fibre trunk that forks, each branch ending in a dense rosette of stiff
 * 20-30 cm leaves. Grows 5-15 m in the Mojave and almost nothing else looks
 * like it, so it gets its own shape. */
int32_t generateJoshua(uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x1a2b3c4du);
  const float H = 7.4f * gShapeH;
  const float baseR = 0.34f * (0.75f + 0.25f * gShapeH);
  /* Three forks, each spawning two more: the candelabra habit. */
  struct Arm { V3 base; V3 dir; float len; float r; int32_t depth; };
  Arm stack[12];
  int32_t n = 0;
  stack[n].base = v3(0.0f, -0.2f, 0.0f);
  stack[n].dir = v3(rng.range(-0.05f, 0.05f), 1.0f, rng.range(-0.05f, 0.05f));
  stack[n].len = H * 0.42f;
  stack[n].r = baseR;
  stack[n].depth = 0;
  ++n;
  int32_t vertsBefore = 0;
  (void)vertsBefore;
  while (n > 0) {
    const Arm arm = stack[--n];
    const int32_t segs = detail >= 2 ? 4 : 3;
    const int32_t sides = detail >= 2 ? 8 : 5;
    V3 p = arm.base;
    V3 d = norm(arm.dir);
    V3 frame = v3(1.0f, 0.0f, 0.0f);
    float r = arm.r;
    for (int32_t i = 0; i < segs; ++i) {
      const float t = float(i + 1) / float(segs);
      d = norm(add(d, v3(rng.range(-0.12f, 0.12f), 0.02f, rng.range(-0.12f, 0.12f))));
      const V3 q = add(p, mul(d, arm.len / float(segs)));
      gPenPart = 0.0f;
      frame = tubeSegment(p, q, r, r * 0.86f, sides, t * arm.len, 0.85f, 0.66f + 0.12f * rng.f(),
                          rng.f(), frame, false, 0.05f * t, 0.12f * t, float(arm.depth));
      p = q;
      r *= 0.93f;
    }
    if (arm.depth < 2) {
      for (int32_t k = 0; k < 2; ++k) {
        const float a = rng.range(0.0f, kTwoPi);
        stack[n].base = p;
        stack[n].dir = norm(add(mul(d, 0.55f), v3(cosf(a) * 0.8f, 0.25f, sinf(a) * 0.8f)));
        stack[n].len = arm.len * rng.range(0.55f, 0.8f);
        stack[n].r = r * 0.9f;
        stack[n].depth = arm.depth + 1;
        ++n;
        if (n >= 11) break;
      }
    } else {
      /* Rosette: 30 leaves radiating from the tip, each one stiff and spined. */
      const int32_t leaves = detail >= 2 ? 34 : 18;
      for (int32_t i = 0; i < leaves; ++i) {
        const float a = float(i) * 2.39996323f;
        const float tilt = lerpf(0.30f, 1.40f, float(i) / float(leaves));
        const V3 out = norm(v3(cosf(a) * sinf(tilt), cosf(tilt), sinf(a) * sinf(tilt)));
        gPenPart = 1.0f;
        blade(p, out, 0.26f * (0.8f + 0.3f * rng.f()), 0.020f, 1.15f, 0.35f,
              detail >= 2 ? 3 : 2, 0.72f, 0.98f, rng.f(), 0.45f, 0.62f, a);
      }
      /* A second, shorter whorl inside the first: the rosette a Joshua tree
         carries is dense enough to hide the branch tip from below. */
      if (detail >= 2) {
        for (int32_t i = 0; i < 12; ++i) {
          const float a = float(i) * 2.39996323f + 0.9f;
          const V3 out = norm(v3(cosf(a) * 0.55f, 1.0f, sinf(a) * 0.55f));
          gPenPart = 1.0f;
          blade(add(p, v3(0.0f, 0.02f, 0.0f)), out, 0.20f, 0.017f, 0.55f, 0.2f, 2,
                0.68f, 0.95f, rng.f(), 0.40f, 0.58f, a + 0.5f);
        }
      }
    }
  }
  return gVert;
}

/* -------------------------------------------------------------------- */
/* Sagebrush (Artemisia tridentata)                                      */
/* -------------------------------------------------------------------- */
/* A woody base with many short, leafy stems. The leaves are the plant's whole
 * silhouette, so they are grown, not drawn as a sphere. */
int32_t generateSage(uint32_t seed, int32_t detail) {
  Rng rng(seed ^ 0x77d1c3e5u);
  const float H = 0.95f * gShapeH;
  const int32_t stems = detail >= 2 ? 14 : 8;
  for (int32_t s = 0; s < stems; ++s) {
    const float a = float(s) * 2.39996323f + rng.range(-0.25f, 0.25f);
    /* A stem that reaches further out leans further, so the clump opens into
       the loose, rounded dome a sagebrush has instead of a bundle of spikes. */
    const float reach = rng.range(0.10f, 0.30f) * (0.7f + 0.3f * gShapeH);
    const float top = H * rng.range(0.55f, 1.0f);
    const float lean = 0.35f + reach * 2.2f + rng.range(0.0f, 0.25f);
    const V3 base = v3(cosf(a) * 0.03f, 0.0f, sinf(a) * 0.03f);
    /* Stem: a thin woody tube that leans out as it rises. */
    const int32_t segs = detail >= 2 ? 3 : 2;
    V3 p = base;
    V3 frame = v3(1.0f, 0.0f, 0.0f);
    V3 dir = norm(v3(cosf(a) * lean, 1.0f, sinf(a) * lean));
    for (int32_t i = 0; i < segs; ++i) {
      const float t = float(i + 1) / float(segs);
      const V3 q = add(p, mul(dir, (top / float(segs)) * (1.0f + 0.1f * float(i))));
      gPenPart = 0.0f;
      frame = tubeSegment(p, q, 0.010f * (1.0f - 0.5f * t), 0.008f * (1.0f - 0.5f * t),
                          4, t, 1.0f, 0.58f, rng.f(), frame, false,
                          0.05f + 0.2f * t, 0.15f + 0.4f * t, a);
      /* Leaves grow all along the stem, not just at the tip. */
      const int32_t leaves = detail >= 2 ? 5 : 3;
      for (int32_t k = 0; k < leaves; ++k) {
        const float lt = float(k) / float(leaves);
        const V3 at = add(p, mul(sub(q, p), lt));
        const float la = a + float(k) * 2.0f + rng.range(-0.4f, 0.4f);
        const V3 ldir = norm(v3(cosf(la), 0.35f + rng.range(0.0f, 0.4f), sinf(la)));
        gPenPart = 1.0f;
        blade(at, ldir, 0.030f * (0.8f + 0.4f * rng.f()), 0.0075f, 1.1f, 0.4f, 2,
              0.70f, 1.00f, rng.f(), 0.30f + 0.35f * t, 0.35f + 0.4f * t, la);
      }
      p = q;
      dir = norm(add(dir, v3(0.0f, 0.06f, 0.0f)));
    }
  }
  return gVert;
}

/* ---------------------------------------------------------------- */
/* Tree entry point                                                 */
/* ---------------------------------------------------------------- */
/* Linear albedo per kind. Foliage is never one green: a fern is darker and
   bluer than a lawn, a sagebrush is grey-silver, a succulent is dusty
   green and a palm frond is deep and slightly yellow. */
void setLeafAlbedo(int32_t kind) {
  float r = 0.084f, g = 0.190f, b = 0.047f;
  switch (kind) {
    case SP_TALLGRASS: case SP_FLOWER: r = 0.105f; g = 0.205f; b = 0.055f; break;
    case SP_FERN: case SP_TREEFERN: r = 0.045f; g = 0.120f; b = 0.038f; break;
    case SP_DAISY: case SP_TULIP: case SP_LAVENDER: r = 0.070f; g = 0.165f; b = 0.048f; break;
    case SP_SAGUARO: case SP_BARREL: case SP_AGAVE: r = 0.095f; g = 0.150f; b = 0.085f; break;
    case SP_SAGE: case SP_JUNIPER: r = 0.125f; g = 0.145f; b = 0.105f; break;
    case SP_JOSHUA: r = 0.110f; g = 0.115f; b = 0.060f; break;
    case SP_PALM: r = 0.050f; g = 0.125f; b = 0.036f; break;
    case SP_PEBBLE: r = 0.320f; g = 0.310f; b = 0.290f; break;
    default: break;
  }
  gLeafCol[0] = r; gLeafCol[1] = g; gLeafCol[2] = b;
}

int32_t generateTree(int32_t kind, uint32_t seed, int32_t detail) {
  if (kind < 0 || kind >= SP_COUNT) return 0;
  setLeafAlbedo(kind);
  gNodeN = 0;
  gAttN = 0;
  /* Habit-locked species first: a pine, a prickly pear and a sagebrush are
     grown by their own builders, not by the colonisation routine. */
  if (kind >= SP_PINE) {
    switch (kind) {
      case SP_PINE:
      case SP_SPRUCE:
      case SP_KRUMM:
      case SP_JUNIPER: return generateConifer(kind, seed, detail);
      case SP_PRICKLY: return generatePrickly(seed, detail);
      case SP_JOSHUA: return generateJoshua(seed, detail);
      case SP_SAGE: return generateSage(seed, detail);
      case SP_FLOWER: return generateFlower(kind, seed, detail);
      default: return 0;
    }
  }
  if (kind >= SP_GRASS) {
    switch (kind) {
      case SP_GRASS:
      case SP_TALLGRASS: return generateGrass(kind, seed, detail);
      case SP_DAISY:
      case SP_TULIP:
      case SP_LAVENDER: return generateFlower(kind, seed, detail);
      case SP_SAGUARO:
      case SP_BARREL:
      case SP_AGAVE: return generateSucculent(kind, seed, detail);
      case SP_PALM: return generatePalm(seed, detail);
      case SP_PEBBLE: return generatePebble(seed, detail);
      default: return 0;
    }
  }
  if (kind >= SP_FERN) return generateFern(kind, seed, detail);
  SpeciesSpec s = kSpecies[kind];
  applyShape(s);
  Rng rng(seed ^ 0x51ed270bu);

  /* Vigour. Two oaks of one species are never the same size — one grew in the
     open, one under a taller neighbour — so the species table is a mean and
     each seed gets its own stature and spread around it. Without this every
     seed reached the same height to the millimetre, which is what made a stand
     of trees read as a repeated asset. */
  const float habit = rng.range(0.90f, 1.10f);
  const float spread = rng.range(0.88f, 1.12f);
  s.trunkTop *= habit;
  s.crownY *= habit;
  s.crownRY *= habit;
  s.crownRX *= spread;

  V3 frame = v3(1.0f, 0.0f, 0.0f);
  const int32_t trunkTip = buildTrunk(s, rng, frame);
  if (trunkTip < 0) return 0;
  const int32_t firstBranch = trunkTip + 1;
  (void)frame;

  /* Roots are grafted on before the crown, so the collar ring is already the
     joint they share with the trunk. */
  buildRoots(s, rng, trunkTip);
  /* Detail is what the same skeleton is grown with: a fatter, coarser far tier
     and a finer near one, not a different plant. */
  if (detail <= 0) {
    if (s.attractors > 200) s.attractors = s.attractors * 6 / 10;
    s.step *= 1.22f;
  } else if (detail >= 2) {
    s.attractors += s.attractors * 3 / 10;
    if (s.attractors > MAX_ATTRACTORS) s.attractors = MAX_ATTRACTORS;
    s.step *= 0.88f;
  }
  colonise(s, rng, trunkTip);
  assignRadii(s, trunkTip);
  refineSkeleton(detail >= 2 ? 0.20f : 0.0f);
  orderNodes();

  const int32_t maxSides = detail >= 2 ? 16 : detail == 1 ? 10 : 6;
  const int32_t minSides = detail >= 2 ? 6 : 5;
  meshSkeleton(s, maxSides, minSides);
  emitLeafAnchors(s, rng, firstBranch, detail);
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

/* ---------------------------------------------------------------- */
/* Buildings                                                         */
/* ---------------------------------------------------------------- */
/* The studio's last JavaScript-authored meshes were the four shells it places
 * along a street: a pitched-roof house, a four-storey block, an eight-storey
 * mid-rise and a sixteen-storey tower. They were literal boxes with a hand-
 * placed roof, so every copy on a street was the same building.
 *
 * These are grown from the same rules a real one is built to. A storey is 3.0 m
 * (3.5 for the ground floor of the house), a residential facade bay is 3.6 m,
 * a balcony is 1.3 m deep with a 1.0 m parapet, a parapet cap is 0.3 m, a
 * foundation stands 0.45 m proud of grade, and a pitched roof sits at 35
 * degrees with a 0.35 m eave overhang. Nothing is a magic number, and the seed
 * moves storey count, bay count, roof pitch, entrance bay and chimney side
 * within the range the type actually uses.
 *
 * Parts keep the studio's material slots: 0 wall (facade texture and lit
 * windows), 1 roof, 2 base (foundation, trims, balconies, canopy, parapet,
 * chimney, mast). UVs stay in metres divided by the facade tile, exactly as the
 * JavaScript shells did, so the existing textures land on the same bricks. */
enum { BUILD_HOUSE = 0, BUILD_BLOCK = 1, BUILD_MID = 2, BUILD_TOWER = 3, BUILD_COUNT = 4 };

/* Material tint. Buildings are textured by the studio's facade map, but a door
 * is still brown and a chimney is still brick, so the vertex colour carries the
 * albedo the way the JavaScript shells baked theirs. */
V3 gTint = v3(1.0f, 1.0f, 1.0f);

/* A quadrilateral with metre UVs projected on its dominant axis, wound so the
 * normal points away from `inward` (the centre of the solid). */
void facadeQuad(V3 a, V3 b, V3 c, V3 d, V3 inward, float tile, float shade,
                float rnd, V3 cen) {
  V3 n = norm(cross(sub(b, a), sub(c, a)));
  if (dot(n, sub(a, inward)) < 0.0f) n = mul(n, -1.0f);
  const V3 pts[4] = {a, b, c, d};
  V3 u = norm(sub(b, a)), v = norm(sub(d, a));
  const int32_t base = gVert;
  for (int32_t i = 0; i < 4; ++i) {
    const V3 p = pts[i];
    /* Horizontal coordinate follows the face's own u axis, vertical is world
     * Y, so a window course is level whatever the building is rotated to. */
    const float uu = dot(sub(p, a), u) / tile;
    const float vv = (absf(n.y) > 0.7f ? dot(sub(p, a), v) : p.y) / tile;
    pushVert(p, n, uu, vv, shade * gTint.x, shade * gTint.y, shade * gTint.z, rnd, cen);
  }
  pushTri(base, base + 1, base + 2);
  pushTri(base, base + 2, base + 3);
}

/* A triangle with the same UV projection, for gable ends and roof hips. */
void facadeTri(V3 a, V3 b, V3 c, V3 inward, float tile, float shade, float rnd, V3 cen) {
  V3 n = norm(cross(sub(b, a), sub(c, a)));
  if (dot(n, sub(a, inward)) < 0.0f) n = mul(n, -1.0f);
  const V3 pts[3] = {a, b, c};
  V3 u = norm(sub(b, a));
  const int32_t base = gVert;
  for (int32_t i = 0; i < 3; ++i) {
    const V3 p = pts[i];
    const float uu = dot(sub(p, a), u) / tile;
    const float vv = p.y / tile;
    pushVert(p, n, uu, vv, shade * gTint.x, shade * gTint.y, shade * gTint.z, rnd, cen);
  }
  pushTri(base, base + 1, base + 2);
}

/* Axis-aligned box. `tile` scales the facade UVs; `shade` is its brightness and
 * `gTint` its colour. */
void tinted(V3 t) { gTint = t; }
void facadeBox(V3 c, V3 half, float tile, float shade, float rnd) {
  const V3 lo = sub(c, half), hi = add(c, half);
  const V3 face[6][5] = {
    {v3(lo.x, lo.y, hi.z), v3(hi.x, lo.y, hi.z), v3(hi.x, hi.y, hi.z), v3(lo.x, hi.y, hi.z), v3(0, 0, -1)},
    {v3(hi.x, lo.y, lo.z), v3(lo.x, lo.y, lo.z), v3(lo.x, hi.y, lo.z), v3(hi.x, hi.y, lo.z), v3(0, 0, 1)},
    {v3(hi.x, lo.y, hi.z), v3(hi.x, lo.y, lo.z), v3(hi.x, hi.y, lo.z), v3(hi.x, hi.y, hi.z), v3(-1, 0, 0)},
    {v3(lo.x, lo.y, lo.z), v3(lo.x, lo.y, hi.z), v3(lo.x, hi.y, hi.z), v3(lo.x, hi.y, lo.z), v3(1, 0, 0)},
    {v3(lo.x, hi.y, hi.z), v3(hi.x, hi.y, hi.z), v3(hi.x, hi.y, lo.z), v3(lo.x, hi.y, lo.z), v3(0, -1, 0)},
    {v3(lo.x, lo.y, lo.z), v3(hi.x, lo.y, lo.z), v3(hi.x, lo.y, hi.z), v3(lo.x, lo.y, hi.z), v3(0, 1, 0)},
  };
  for (int32_t f = 0; f < 6; ++f) {
    facadeQuad(face[f][0], face[f][1], face[f][2], face[f][3], face[f][4], tile, shade, rnd, c);
  }
}

/* One storey band: a slightly proud line of concrete, which is what actually
 * catches light on a rendered facade. */
void storeyBand(float w, float d, float y, float proud, float thick, float shade) {
  gPenPart = 2.0f;
  gPenSway = 0.0f;
  gPenPh = 0.0f;
  facadeBox(v3(0.0f, y, 0.0f), v3(w * 0.5f + proud, thick * 0.5f, d * 0.5f + proud), 2.0f, shade, 0.5f);
}

/* A balcony: floor slab, parapet on three sides, two side walls. */
void balcony(float x, float y, float zFront, float w, float depth, float shade) {
  gPenPart = 2.0f;
  const float rail = 1.0f;
  facadeBox(v3(x, y, zFront + depth * 0.5f), v3(w * 0.5f, 0.08f, depth * 0.5f), 1.6f, shade, 0.4f);
  facadeBox(v3(x, y + rail * 0.5f, zFront + depth), v3(w * 0.5f, rail * 0.5f, 0.05f), 1.6f, shade * 1.15f, 0.4f);
  facadeBox(v3(x - w * 0.5f + 0.05f, y + rail * 0.5f, zFront + depth * 0.5f), v3(0.05f, rail * 0.5f, depth * 0.5f), 1.6f, shade * 1.1f, 0.4f);
  facadeBox(v3(x + w * 0.5f - 0.05f, y + rail * 0.5f, zFront + depth * 0.5f), v3(0.05f, rail * 0.5f, depth * 0.5f), 1.6f, shade * 1.1f, 0.4f);
}

/* Canopy over the entrance, held on two posts — every walk-up has one. */
void entrance(float zFront, float w, float y, float tile) {
  gPenPart = 2.0f;
  facadeBox(v3(0.0f, y, zFront + 0.8f), v3(w * 0.5f + 0.3f, 0.10f, 0.8f), tile, 0.62f, 0.6f);
  facadeBox(v3(-w * 0.5f + 0.1f, y * 0.5f, zFront + 1.45f), v3(0.06f, y * 0.5f, 0.06f), tile, 0.58f, 0.6f);
  facadeBox(v3(w * 0.5f - 0.1f, y * 0.5f, zFront + 1.45f), v3(0.06f, y * 0.5f, 0.06f), tile, 0.58f, 0.6f);
}

/* Flat-roof trim: parapet ring, roof plant, mast. */
void flatRoof(float w, float d, float y, Rng& rng, float tile, float shade) {
  gPenPart = 2.0f;
  const float capH = 0.32f, pr = 0.18f;
  facadeBox(v3(0.0f, y + capH * 0.5f, d * 0.5f), v3(w * 0.5f + pr, capH * 0.5f, pr), tile, shade, 0.5f);
  facadeBox(v3(0.0f, y + capH * 0.5f, -d * 0.5f), v3(w * 0.5f + pr, capH * 0.5f, pr), tile, shade, 0.5f);
  facadeBox(v3(w * 0.5f, y + capH * 0.5f, 0.0f), v3(pr, capH * 0.5f, d * 0.5f), tile, shade, 0.5f);
  facadeBox(v3(-w * 0.5f, y + capH * 0.5f, 0.0f), v3(pr, capH * 0.5f, d * 0.5f), tile, shade, 0.5f);
  /* Lift overrun and a stair head, both dark, both off-centre because they
   * have to clear the stair core. */
  const float ox = rng.range(-0.22f, 0.22f) * w, oz = rng.range(-0.22f, 0.22f) * d;
  facadeBox(v3(ox, y + 1.1f, oz), v3(w * 0.16f, 1.1f, d * 0.14f), 2.4f, 0.30f, 0.5f);
  facadeBox(v3(-ox * 0.8f, y + 0.7f, -oz * 0.8f), v3(w * 0.09f, 0.7f, d * 0.09f), 2.4f, 0.30f, 0.5f);
  /* No mast here: the tower grows its own on the crown, and a building with
   * two aerials is a building nobody built. */
}

void generateBuilding(int32_t kind, uint32_t seed, int32_t detail) {
  Rng rng((seed ^ 0x6d2b79f5u) * 2654435761u + uint32_t(kind) * 2246822519u);
  gTint = v3(1.0f, 1.0f, 1.0f);
  const float tile = 9.0f;          /* facade texture tile in metres */
  const float storey = 3.0f;        /* one residential storey */
  const float proud = detail >= 2 ? 0.10f : 0.0f;

  if (kind == BUILD_HOUSE) {
    /* Detached two-storey house: 6.4 m square footprint, 3.5 m ground floor,
     * 2.5 m upper floor, 35 degree pitch, 0.35 m eave. */
    const float w = rng.range(6.0f, 7.2f), d = rng.range(6.0f, 7.2f);
    const float gh = 3.5f, uh = 2.5f, wallTop = gh + uh;
    const float pitch = rng.range(0.60f, 0.72f);   /* tan(31-36 deg) */
    const float ridge = wallTop + d * 0.5f * pitch;
    const float eave = 0.35f;

    /* Foundation stands proud of grade by 0.45 m. */
    gPenPart = 2.0f;
    tinted(v3(0.46f, 0.46f, 0.48f));
    facadeBox(v3(0.0f, -0.22f, 0.0f), v3(w * 0.5f + 0.18f, 0.23f, d * 0.5f + 0.18f), 3.0f, 0.92f, 0.5f);
    /* The walls: one mass, textured. */
    gPenPart = 0.0f;
    facadeBox(v3(0.0f, wallTop * 0.5f, 0.0f), v3(w * 0.5f, wallTop * 0.5f, d * 0.5f), tile, 0.94f, 0.5f);

    /* Pitched roof: two planes and two gable ends, ridge along Z. */
    gPenPart = 1.0f;
    const float ew = w * 0.5f + eave, ed = d * 0.5f + eave;
    const V3 rA = v3(0.0f, ridge, -ed), rB = v3(0.0f, ridge, ed);
    facadeQuad(v3(-ew, wallTop, -ed), v3(-ew, wallTop, ed), rB, rA, v3(0.0f, ridge * 0.5f, 0.0f),
               tile, 0.88f, 0.5f, v3(0, wallTop, 0));
    facadeQuad(v3(ew, wallTop, ed), v3(ew, wallTop, -ed), rA, rB, v3(0.0f, ridge * 0.5f, 0.0f),
               tile, 0.88f, 0.5f, v3(0, wallTop, 0));
    /* Gable ends, closed with the wall material so the texture continues. */
    gPenPart = 0.0f;
    facadeTri(v3(-w * 0.5f, wallTop, d * 0.5f), v3(w * 0.5f, wallTop, d * 0.5f), v3(0.0f, ridge, d * 0.5f),
              v3(0.0f, wallTop, 0.0f), tile, 0.90f, 0.5f, v3(0, wallTop, 0));
    facadeTri(v3(w * 0.5f, wallTop, -d * 0.5f), v3(-w * 0.5f, wallTop, -d * 0.5f), v3(0.0f, ridge, -d * 0.5f),
              v3(0.0f, wallTop, 0.0f), tile, 0.90f, 0.5f, v3(0, wallTop, 0));

    /* Trims: fascia at the eave line, rake boards, chimney, door, porch,
     * step and a window sill course — everything a real facade has. */
    gPenPart = 2.0f;
    const float trim = 0.14f;
    tinted(v3(0.97f, 0.96f, 0.93f));      /* painted fascia */
    facadeBox(v3(0.0f, wallTop + 0.01f, ed), v3(ew, trim * 0.5f, 0.06f), 1.5f, 0.90f, 0.5f);
    facadeBox(v3(0.0f, wallTop + 0.01f, -ed), v3(ew, trim * 0.5f, 0.06f), 1.5f, 0.90f, 0.5f);
    facadeBox(v3(ew, wallTop + 0.01f, 0.0f), v3(0.06f, trim * 0.5f, ed), 1.5f, 0.90f, 0.5f);
    facadeBox(v3(-ew, wallTop + 0.01f, 0.0f), v3(0.06f, trim * 0.5f, ed), 1.5f, 0.90f, 0.5f);
    /* Soffit under the eaves: the roof has a thickness you can see from below. */
    gPenPart = 1.0f;
    tinted(v3(0.80f, 0.78f, 0.75f));
    facadeQuad(v3(-ew, wallTop - 0.02f, -d * 0.5f), v3(ew, wallTop - 0.02f, -d * 0.5f),
               v3(ew, wallTop - 0.02f, -ed), v3(-ew, wallTop - 0.02f, -ed), v3(0, wallTop + 1, 0),
               4.0f, 0.9f, 0.5f, v3(0, wallTop, 0));
    facadeQuad(v3(-ew, wallTop - 0.02f, d * 0.5f), v3(-ew, wallTop - 0.02f, ed),
               v3(ew, wallTop - 0.02f, ed), v3(ew, wallTop - 0.02f, d * 0.5f), v3(0, wallTop + 1, 0),
               4.0f, 0.9f, 0.5f, v3(0, wallTop, 0));
    /* Ridge cap. */
    gPenPart = 2.0f;
    tinted(v3(0.30f, 0.31f, 0.33f));
    facadeBox(v3(0.0f, ridge + 0.04f, 0.0f), v3(0.14f, 0.05f, ed), 1.5f, 0.9f, 0.5f);
    tinted(v3(1.0f, 1.0f, 1.0f));
    const float cx = rng.range(-0.28f, 0.28f) * w;
    const float cz = rng.range(-0.18f, 0.18f) * d;
    /* A chimney clears the ridge by half a metre, which is what the code
     * actually asks for so it draws on its own draught. */
    const float chimTop = ridge + 0.55f;
    tinted(v3(0.62f, 0.40f, 0.34f));      /* brick */
    facadeBox(v3(cx, (wallTop + chimTop) * 0.5f, cz), v3(0.42f, (chimTop - wallTop) * 0.5f + 0.2f, 0.42f),
              1.2f, 0.92f, 0.5f);
    tinted(v3(0.55f, 0.55f, 0.56f));      /* pot */
    facadeBox(v3(cx, chimTop + 0.09f, cz), v3(0.52f, 0.09f, 0.52f), 1.2f, 0.9f, 0.5f);
    tinted(v3(1.0f, 1.0f, 1.0f));
    /* Door and porch on +Z. */
    const float doorW = 1.0f, doorH = 2.1f;
    tinted(v3(0.94f, 0.93f, 0.90f));
    facadeBox(v3(0.0f, doorH * 0.5f + 0.45f, d * 0.5f + 0.04f), v3(doorW * 0.5f + 0.08f, doorH * 0.5f + 0.08f, 0.04f), 1.2f, 0.90f, 0.5f);
    tinted(v3(0.36f, 0.22f, 0.12f));      /* stained timber door */
    facadeBox(v3(0.0f, doorH * 0.5f + 0.45f, d * 0.5f + 0.07f), v3(doorW * 0.5f, doorH * 0.5f, 0.05f), 1.2f, 0.95f, 0.5f);
    tinted(v3(0.58f, 0.56f, 0.54f));      /* flags */
    facadeBox(v3(0.0f, 0.52f, d * 0.5f + 0.9f), v3(1.15f, 0.08f, 0.85f), 1.4f, 0.95f, 0.5f);
    tinted(v3(0.96f, 0.96f, 0.94f));      /* porch posts */
    facadeBox(v3(-0.95f, 1.9f, d * 0.5f + 1.62f), v3(0.05f, 1.42f, 0.05f), 1.4f, 0.94f, 0.5f);
    facadeBox(v3(0.95f, 1.9f, d * 0.5f + 1.62f), v3(0.05f, 1.42f, 0.05f), 1.4f, 0.94f, 0.5f);
    tinted(v3(0.34f, 0.33f, 0.32f));      /* porch roof */
    facadeBox(v3(0.0f, 3.34f, d * 0.5f + 0.95f), v3(1.15f, 0.09f, 0.72f), 1.4f, 0.95f, 0.5f);
    tinted(v3(1.0f, 1.0f, 1.0f));
    return;
  }

  /* Walk-up block, mid-rise and tower share one rule set: a rectangular plan,
   * a storey grid, a bay grid, balconies along +Z, pilasters on the corners. */
  float w, d, h;
  int32_t storeys, bays;
  if (kind == BUILD_BLOCK) {
    w = rng.range(8.0f, 9.2f); d = rng.range(11.0f, 12.6f);
    storeys = rng.irange(4, 5); bays = rng.irange(3, 4);
  } else if (kind == BUILD_MID) {
    w = rng.range(9.0f, 10.4f); d = rng.range(9.0f, 10.4f);
    storeys = rng.irange(7, 9); bays = rng.irange(3, 4);
  } else {
    w = rng.range(6.0f, 6.8f); d = rng.range(6.0f, 6.8f);
    storeys = rng.irange(13, 16); bays = rng.irange(2, 3);
  }
  h = float(storeys) * storey;

  /* Foundation and walls. */
  gPenPart = 2.0f;
  facadeBox(v3(0.0f, -0.22f, 0.0f), v3(w * 0.5f + 0.22f, 0.23f, d * 0.5f + 0.22f), 3.0f, 0.40f, 0.5f);
  gPenPart = 0.0f;
  facadeBox(v3(0.0f, h * 0.5f, 0.0f), v3(w * 0.5f, h * 0.5f, d * 0.5f), tile, 0.93f, 0.5f);

  /* A plinth in darker render up to 1.1 m, then a band at every storey. */
  gPenPart = 2.0f;
  tinted(v3(0.36f, 0.35f, 0.34f));        /* darker plinth render */
  facadeBox(v3(0.0f, 0.55f, 0.0f), v3(w * 0.5f + 0.02f, 0.55f, d * 0.5f + 0.02f), 2.2f, 0.95f, 0.5f);
  tinted(v3(0.86f, 0.85f, 0.83f));        /* pale concrete for the trims */

  if (detail >= 1) {
    for (int32_t f = 1; f < storeys; ++f) {
      storeyBand(w, d, float(f) * storey, 0.03f, 0.16f, 0.60f);
      if (proud > 0.0f) storeyBand(w, d, float(f) * storey - 0.35f, 0.0f, 0.05f, 0.74f);
    }
  }

  /* Balconies: one per bay per storey above the ground floor, on +Z. */
  if (detail >= 1) {
    const float bayW = w / float(bays);
    for (int32_t f = 1; f < storeys; ++f) {
      for (int32_t b = 0; b < bays; ++b) {
        if (rng.f() < 0.18f) continue;   /* a bay without one, as on a real run */
        const float x = -w * 0.5f + bayW * (float(b) + 0.5f);
        balcony(x, float(f) * storey, d * 0.5f, bayW * 0.72f, 1.3f, 0.58f);
      }
    }
  }

  /* Corner pilasters on the mid-rise and tower, which is what gives them a
   * vertical emphasis rather than a stack of slabs. */
  if (detail >= 2 && kind != BUILD_BLOCK) {
    gPenPart = 2.0f;
    const float pw = kind == BUILD_TOWER ? 0.30f : 0.5f;
    for (int32_t sx = -1; sx <= 1; sx += 2) {
      for (int32_t sz = -1; sz <= 1; sz += 2) {
        facadeBox(v3(float(sx) * w * 0.5f, h * 0.5f, float(sz) * d * 0.5f),
                  v3(pw * 0.5f, h * 0.5f, pw * 0.5f), 1.4f, 0.62f, 0.5f);
      }
    }
  }

  entrance(d * 0.5f, 3.0f, storey * 0.92f, 1.6f);
  flatRoof(w, d, h, rng, 1.8f, 0.58f);

  /* The tower gets a stepped crown: a 2 m setback with its own glazing, then
   * the plant deck. That silhouette is what a 50 m building looks like. */
  if (kind == BUILD_TOWER) {
    gPenPart = 0.0f;
    facadeBox(v3(0.0f, h + 3.0f, 0.0f), v3(w * 0.5f - 1.0f, 3.0f, d * 0.5f - 1.0f), tile, 0.90f, 0.5f);
    gPenPart = 2.0f;
    facadeBox(v3(0.0f, h + 6.2f, 0.0f), v3(w * 0.5f - 0.8f, 0.2f, d * 0.5f - 0.8f), 1.8f, 0.56f, 0.5f);
    /* A 4 m aerial on the plant deck, which is what a roof of this height
     * actually carries. It is steel, not concrete trim: painted as part 2 it
     * also added two phantom storeys to the building's own storey count. */
    gPenPart = 0.0f;
    tinted(v3(0.42f, 0.44f, 0.46f));
    facadeBox(v3(0.0f, h + 8.3f, 0.0f), v3(0.12f, 1.9f, 0.12f), 1.0f, 0.62f, 0.5f);
    facadeBox(v3(0.0f, h + 9.6f, 0.0f), v3(0.05f, 0.5f, 0.05f), 1.0f, 0.66f, 0.5f);
    tinted(v3(1.0f, 1.0f, 1.0f));
  }
}

FE_EXPORT int32_t fe_flora_rock_kind_count(void) { return ROCK_COUNT; }

/* Buildings: the four shell types the studio places along a street. Same
 * buffers, same part channel, so the bridge treats them exactly like a plant. */
FE_EXPORT int32_t fe_build_kind_count(void) { return BUILD_COUNT; }

FE_EXPORT int32_t fe_build(int32_t kind, uint32_t seed, int32_t detail) {
  resetMesh();
  if (kind < 0 || kind >= BUILD_COUNT) return 0;
  generateBuilding(kind, seed, detail);
  return gVert;
}

FE_EXPORT int32_t fe_flora_tree(int32_t kind, uint32_t seed, int32_t detail) {
  resetMesh();
  generateTree(kind, seed, detail);
  /* Wood first, then the leaf cards grown from the anchors that wood produced.
     One call, one plant, no second round trip from the UI. */
  if (gVert > 0 && kind >= 0 && kind < SP_GRASS) {
    Rng cardRng((seed ^ 0x51ed270bu) * 2654435761u + uint32_t(kind) * 40503u);
    emitLeafCards(kind, cardRng);
  }
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
/* Material group per vertex: 0 wood, 1 foliage, 2 bloom. */
FE_EXPORT float* fe_flora_part_ptr(void) { return gPart; }

/* Leaf cards grown with the tree: quads, not anchors. `fe_flora_leaf_count`
 * above still reports the anchors, which the card placer used to need. */
FE_EXPORT int32_t fe_flora_card_count(void) { return gCardN; }
FE_EXPORT int32_t fe_flora_card_vert_count(void) { return gCardV; }
FE_EXPORT int32_t fe_flora_card_index_count(void) { return gCardI; }
FE_EXPORT float* fe_flora_card_pos_ptr(void) { return gCardPos; }
FE_EXPORT float* fe_flora_card_nrm_ptr(void) { return gCardNrm; }
FE_EXPORT float* fe_flora_card_col_ptr(void) { return gCardCol; }
FE_EXPORT float* fe_flora_card_uv_ptr(void) { return gCardUv; }
FE_EXPORT float* fe_flora_card_rnd_ptr(void) { return gCardRnd; }
FE_EXPORT float* fe_flora_card_cen_ptr(void) { return gCardCen; }
FE_EXPORT float* fe_flora_card_sway_ptr(void) { return gCardSway; }
FE_EXPORT float* fe_flora_card_phase_ptr(void) { return gCardPh; }
FE_EXPORT float* fe_flora_card_part_ptr(void) { return gCardPart; }
FE_EXPORT uint32_t* fe_flora_card_idx_ptr(void) { return gCardIdx; }
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

/* Internal door for the impostor baker. The buffers above are private to this
 * translation unit; these accessors are hidden so the linker keeps them out of
 * the WebAssembly export list. The mesh is only valid until the next
 * fe_flora_tree() call, which is exactly how the impostor baker uses it. */
namespace fe_flora_geom {
__attribute__((visibility("hidden"))) const float* pos() { return gPos; }
__attribute__((visibility("hidden"))) const float* nrm() { return gNrm; }
__attribute__((visibility("hidden"))) const float* col() { return gCol; }
__attribute__((visibility("hidden"))) const uint32_t* idx() { return gIdx; }
__attribute__((visibility("hidden"))) int32_t verts() { return gVert; }
__attribute__((visibility("hidden"))) int32_t indices() { return gIdxN; }
__attribute__((visibility("hidden"))) const float* card_pos() { return gCardPos; }
__attribute__((visibility("hidden"))) const float* card_nrm() { return gCardNrm; }
__attribute__((visibility("hidden"))) const float* card_col() { return gCardCol; }
__attribute__((visibility("hidden"))) const uint32_t* card_idx() { return gCardIdx; }
__attribute__((visibility("hidden"))) int32_t card_verts() { return gCardV; }
__attribute__((visibility("hidden"))) int32_t card_indices() { return gCardI; }
}  // namespace fe_flora_geom
