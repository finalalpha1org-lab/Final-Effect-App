/* Quadtree level-of-detail for the instanced flora.
 * =========================================================================
 * The flat LoD kernel decides per instance whether a plant is inside the
 * frustum and which tier it belongs to. That is fine for a few thousand shrubs
 * and hopeless for 100 000 blades of grass: the work is O(instances) whether
 * they are on screen or a kilometre behind the camera.
 *
 * This file builds a real quadtree over each species' instances and culls it:
 *
 *   1. Build. The points are split into quadrants by counting sort (four stable
 *      buckets, O(n) per level) until a leaf holds at most QT_LEAF instances.
 *      The tree lives in flat arrays and a leaf is just a range of the shared
 *      permutation, so nothing is allocated per instance.
 *   2. Cache. Trees are kept in a pool keyed by species slot, instance count
 *      and a generation number the studio bumps when it edits the plant list.
 *      A settled camera therefore re-uses the tree; only the walk is repeated.
 *      The pools turn over as a whole when they fill up, which is what keeps
 *      the memory bounded without a general-purpose allocator.
 *   3. Cull. A depth-first walk rejects a node when its bounding sphere is
 *      outside any of the six frustum planes or when even its nearest point is
 *      past the draw radius — one test for all the instances underneath it.
 *   4. Tier. Surviving leaves emit their instances with a level: 0 full
 *      geometry, 1 the low-detail twin, 2 the billboard impostor. The hash band
 *      on each threshold stops an instance flickering between tiers as the
 *      camera drifts.
 *
 * The node tests are conservative supersets of the per-instance tests, so the
 * emitted set is exactly the set the flat kernel would emit; the tree only
 * makes reaching it cheaper. tests/landscape-quadtree-lod.test.mjs checks that
 * against a brute-force reference instead of trusting the claim.
 * ========================================================================= */

#include "../include/fe_abi.h"
#include "../include/fe_math.hpp"

namespace {

using namespace fe;

constexpr int32_t QT_SLOTS = 26;         /* one per flora species */
constexpr uint32_t QT_MAX_INST = 140000; /* most instances a single species may have */
constexpr uint32_t QT_MAX_NODES = 20000; /* node pool, shared by every cached tree */
constexpr uint32_t QT_ORDER_POOL = 240000;
constexpr uint32_t QT_LEAF = 96;
constexpr uint32_t QT_MAX_DEPTH = 15;

/* Node arrays. A node is addressed as base + local index. */
float qtCx[QT_MAX_NODES], qtCz[QT_MAX_NODES];
float qtCy[QT_MAX_NODES], qtRadius[QT_MAX_NODES];
uint32_t qtFirst[QT_MAX_NODES], qtCount[QT_MAX_NODES];
int32_t qtChild[QT_MAX_NODES * 4];
uint8_t qtLeaf[QT_MAX_NODES];
uint32_t qtNodeUsed = 0;

/* Permutation pool: each cached tree owns a slice, and a leaf range indexes it. */
uint32_t qtOrder[QT_ORDER_POOL];
uint32_t qtOrderUsed = 0;
uint32_t qtTemp[QT_MAX_INST];

uint32_t qtIndex[QT_MAX_INST];
uint8_t qtTier[QT_MAX_INST];

struct Slot {
  uint32_t base;     /* first node of this tree                        */
  uint32_t nodes;    /* node count                                     */
  uint32_t orderAt;  /* offset of this tree's permutation              */
  uint32_t count;    /* instances indexed                              */
  uint32_t generation;
  uint32_t valid;
  int32_t stats[5];  /* nodes, visited, culled, emitted, instances scanned */
};
Slot qtSlots[QT_SLOTS];

int32_t qtOverflow = 0;

/* A deterministic hash in [0,1) from the instance position.
 *
 * This used to be fract(sin(dot(p, ...)) * 43758.5453), which is cheap to write
 * and impossible to verify: the freestanding kernel's sinf is not the host's, so
 * the same plant landed on a different side of the threshold in the tests than
 * in the browser. Hashing the raw float bits instead is exact on both sides —
 * the same integer reads a value that JS reproduces with Math.imul — and it
 * removes one transcendental from the per-instance path.
 *
 * The thresholds it drives are soft by design: the band stops a plant flipping
 * tier as the camera drifts, so what matters is that the decision is stable,
 * not which side of the hash a plant falls on. */
inline uint32_t qbits(float x) { return __builtin_bit_cast(uint32_t, x); }

inline float qhash(float x, float z) {
  const uint32_t bx = qbits(x), bz = qbits(z);
  uint32_t h = bx ^ (bz + 0x9e3779b9u + (bx << 6) + (bx >> 2));
  h ^= h >> 16;
  h *= 0x7feb352du;
  h ^= h >> 15;
  h *= 0x846ca68bu;
  h ^= h >> 16;
  return float(h >> 8) * (1.0f / 16777216.0f);
}

inline float qdist(float ax, float ay, float az, float bx, float by, float bz) {
  const float dx = ax - bx, dy = ay - by, dz = az - bz;
  return sqrtf(dx * dx + dy * dy + dz * dz);
}

void qtResetPools() {
  qtNodeUsed = 0;
  qtOrderUsed = 0;
  for (int32_t s = 0; s < QT_SLOTS; s++) qtSlots[s].valid = 0;
}

/* Returns the node's *local* index (caller adds the tree base). */
int32_t buildNode(const float* xyz, uint32_t* order, uint32_t first, uint32_t count,
                  float cx, float cz, float half, uint32_t depth) {
  if (qtNodeUsed >= QT_MAX_NODES) { qtOverflow = 1; return -1; }
  const int32_t node = int32_t(qtNodeUsed++);
  qtFirst[node] = first;
  qtCount[node] = count;
  qtCx[node] = cx;
  qtCz[node] = cz;
  for (int32_t c = 0; c < 4; c++) qtChild[node * 4 + c] = -1;
  qtLeaf[node] = 1;

  /* One scan gives both the quadrant histogram and the vertical extent, so a
     node costs two passes over its range instead of four. */
  const float h2 = half * 0.5f;
  uint32_t cnt[4] = {0, 0, 0, 0};
  float lo = 3.0e30f, hi = -3.0e30f;
  for (uint32_t i = 0; i < count; i++) {
    const uint32_t o = order[first + i];
    const float x = xyz[o * 3], y = xyz[o * 3 + 1], z = xyz[o * 3 + 2];
    if (isfinitef(y)) { lo = minf(lo, y); hi = maxf(hi, y); }
    cnt[(x >= cx ? 1u : 0u) | (z >= cz ? 2u : 0u)]++;
  }
  if (lo > hi) { lo = 0.0f; hi = 0.0f; }
  qtCy[node] = (lo + hi) * 0.5f;
  qtRadius[node] = sqrtf(2.0f * half * half + (hi - lo) * (hi - lo) * 0.25f);

  if (count <= QT_LEAF || depth >= QT_MAX_DEPTH || half < 1.0e-3f) return node;

  /* Every point in one quadrant means the centre sits on a cluster and
     subdividing would never separate them: the range stays a leaf. */
  for (int32_t c = 0; c < 4; c++) {
    if (cnt[c] == count) return node;
  }
  const uint32_t base[4] = {0, cnt[0], cnt[0] + cnt[1], cnt[0] + cnt[1] + cnt[2]};
  uint32_t at[4] = {base[0], base[1], base[2], base[3]};
  for (uint32_t i = 0; i < count; i++) {
    const uint32_t o = order[first + i];
    const float x = xyz[o * 3], z = xyz[o * 3 + 2];
    const uint32_t q = (x >= cx ? 1u : 0u) | (z >= cz ? 2u : 0u);
    qtTemp[at[q]++] = o;
  }
  {
    /* Copy back into the pool slice. The permutation is shared, so the subtree
       ranges stay contiguous. */
    uint32_t* dst = order + first;
    for (uint32_t i = 0; i < count; i++) dst[i] = qtTemp[i];
  }

  qtLeaf[node] = 0;
  uint32_t f = first;
  for (uint32_t q = 0; q < 4; q++) {
    if (!cnt[q]) continue;
    const float ccx = cx + ((q & 1u) ? h2 : -h2);
    const float ccz = cz + ((q & 2u) ? h2 : -h2);
    const int32_t child = buildNode(xyz, order, f, cnt[q], ccx, ccz, h2, depth + 1);
    if (child < 0) {
      /* Out of nodes. The range is untouched, so this node simply stays a leaf;
         any half-built children are unreachable and reused on the next reset. */
      for (int32_t c = 0; c < 4; c++) qtChild[node * 4 + c] = -1;
      qtLeaf[node] = 1;
      return node;
    }
    qtChild[node * 4 + q] = child;
    f += cnt[q];
  }
  return node;
}

inline void planeFrom(const float* m, int32_t row, float sign, float* out) {
  const float a = m[0 * 4 + 3] + sign * m[0 * 4 + row];
  const float b = m[1 * 4 + 3] + sign * m[1 * 4 + row];
  const float c = m[2 * 4 + 3] + sign * m[2 * 4 + row];
  const float d = m[3 * 4 + 3] + sign * m[3 * 4 + row];
  const float n = sqrtf(a * a + b * b + c * c);
  const float inv = n > 1.0e-8f ? 1.0f / n : 0.0f;
  out[0] = a * inv; out[1] = b * inv; out[2] = c * inv; out[3] = d * inv;
}

inline bool outside(const float* p, float x, float y, float z, float r) {
  return p[0] * x + p[1] * y + p[2] * z + p[3] < -r;
}

}  // namespace

extern "C" {

/* Index one species. `slot` is the species index, `generation` an arbitrary
   counter the studio bumps when it edits the plant list. Returns the node count
   when the tree was built, 0 when the cached tree was already current, -1 when
   the input cannot be indexed. */
FE_EXPORT int32_t fe_lod_tree_build(int32_t slot, uint32_t count, const float* xyz,
                                    uint32_t generation) {
  if (slot < 0 || slot >= QT_SLOTS || !xyz || count < 1 || count > QT_MAX_INST) return -1;
  Slot& s = qtSlots[slot];
  if (s.valid && s.count == count && s.generation == generation) return 0;

  if (qtNodeUsed + 64 > QT_MAX_NODES || qtOrderUsed + count > QT_ORDER_POOL) qtResetPools();
  s.valid = 0;
  const uint32_t nodeBase = qtNodeUsed;
  const uint32_t orderAt = qtOrderUsed;
  qtOrderUsed += count;

  /* Bounds first, so the root is the tight square around the species. */
  float minX = 3.0e30f, maxX = -3.0e30f, minZ = 3.0e30f, maxZ = -3.0e30f;
  uint32_t* order = qtOrder + orderAt;
  for (uint32_t i = 0; i < count; i++) {
    order[i] = i;
    const float x = xyz[i * 3], z = xyz[i * 3 + 2];
    if (!isfinitef(x) || !isfinitef(z)) continue;
    minX = minf(minX, x); maxX = maxf(maxX, x);
    minZ = minf(minZ, z); maxZ = maxf(maxZ, z);
  }
  if (minX > maxX || minZ > maxZ) { minX = maxX = minZ = maxZ = 0.0f; }
  const float half = 0.5f * maxf(maxX - minX, maxZ - minZ) * 1.001f + 1.0e-3f;
  const float cx = (minX + maxX) * 0.5f, cz = (minZ + maxZ) * 0.5f;

  qtOverflow = 0;
  const int32_t root = buildNode(xyz, order, 0, count, cx, cz, half, 0);
  if (root < 0) return -1;

  s.base = nodeBase;
  s.nodes = qtNodeUsed - nodeBase;
  s.orderAt = orderAt;
  s.count = count;
  s.generation = generation;
  s.valid = 1;
  s.stats[0] = int32_t(s.nodes);
  for (int32_t i = 1; i < 5; i++) s.stats[i] = 0;
  return int32_t(s.nodes);
}

/* Cull one species for one view. `mid_distance` ends the full-detail tier,
   `far_distance` ends the low-detail tier, and everything beyond it up to
   `cull_radius` is drawn as an impostor. */
FE_EXPORT int32_t fe_lod_tree_cull(int32_t slot, const float* xyz, const float* vp,
                                   float cam_x, float cam_y, float cam_z,
                                   float mid_distance, float far_distance,
                                   float cull_radius, float margin, uint32_t options) {
  if (slot < 0 || slot >= QT_SLOTS) return -1;
  Slot& s = qtSlots[slot];
  if (!s.valid || !xyz) return -1;
  if (!vp || !isfinitef(cam_x) || !isfinitef(cam_y) || !isfinitef(cam_z)) return -1;
  if (!isfinitef(mid_distance) || mid_distance < 1.0f || mid_distance > 20000.0f) return -1;
  if (!isfinitef(far_distance) || far_distance < mid_distance || far_distance > 40000.0f) return -1;
  if (!isfinitef(cull_radius) || cull_radius < 10.0f || cull_radius > 40000.0f) return -1;
  if (!isfinitef(margin) || margin < 0.0f || margin > 200.0f) return -1;

  const bool ground = (options & 1u) != 0u;
  const bool skip_frustum = (options & 2u) != 0u;
  float planes[6][4];
  if (!skip_frustum) {
    planeFrom(vp, 0, 1.0f, planes[0]);
    planeFrom(vp, 0, -1.0f, planes[1]);
    planeFrom(vp, 1, 1.0f, planes[2]);
    planeFrom(vp, 1, -1.0f, planes[3]);
    planeFrom(vp, 2, 1.0f, planes[4]);
    planeFrom(vp, 2, -1.0f, planes[5]);
  }
  const float band = maxf(120.0f, mid_distance * 2.0f);
  const float keepFrom = cull_radius * 0.55f;
  const float radiusLimit = cull_radius + margin;

  const uint32_t nodeBase = s.base;
  const uint32_t* order = qtOrder + s.orderAt;

  uint32_t stack[QT_MAX_DEPTH * 4 + 8];
  uint32_t top = 0;
  stack[top++] = nodeBase;
  uint32_t visited = 0, culled = 0, out = 0, scanned = 0;

  /* The stack carries a flag in the top bit meaning "this node is entirely
     inside the frustum", so its instances need no per-plane test at all. That
     is the common case for a camera standing in the middle of a field, and it
     is most of the cost of the walk. */
  constexpr uint32_t kInside = 0x80000000u;
  while (top) {
    const uint32_t entry = stack[--top];
    const uint32_t node = entry & ~kInside;
    bool inside = (entry & kInside) != 0u;
    ++visited;
    const float nx = qtCx[node], ny = qtCy[node], nz = qtCz[node];
    const float nr = qtRadius[node];
    /* Distance first: one dot product rejects most nodes, and a node that is
       past the draw radius does not care where the frustum is. */
    if (qdist(nx, ny, nz, cam_x, cam_y, cam_z) - nr > radiusLimit) { ++culled; continue; }
    if (!inside && !skip_frustum) {
      const float r = nr + margin;
      bool cut = false;
      for (int32_t p = 0; p < 6; ++p) {
        if (outside(planes[p], nx, ny, nz, r)) { cut = true; break; }
      }
      if (cut) { ++culled; continue; }
      inside = true;
      for (int32_t p = 0; p < 6; ++p) {
        if (outside(planes[p], nx, ny, nz, -r)) { inside = false; break; }
      }
    }

    if (!qtLeaf[node]) {
      bool pushed = false;
      for (int32_t c = 0; c < 4; ++c) {
        const int32_t child = qtChild[node * 4 + c];
        if (child < 0) continue;
        if (top >= QT_MAX_DEPTH * 4 + 4) { pushed = false; break; }
        /* Children are stored as absolute pool indices, not offsets into this
           tree: the pool is shared by every cached species. */
        stack[top++] = uint32_t(child) | (inside ? kInside : 0u);
        pushed = true;
      }
      if (pushed) continue;
      /* Only reachable if the stack ever overflowed (it cannot at depth 15):
         emitting the node's own range is better than dropping the plants. */
    }

    const uint32_t first = qtFirst[node], count = qtCount[node];
    /* A malformed range would otherwise walk gigabytes: a node range that is
       out of bounds is skipped rather than trusted. */
    if (first > s.count || count > s.count - first) continue;
    scanned += count;
    for (uint32_t i = 0; i < count; i++) {
      const uint32_t src = order[first + i];
      const float x = xyz[src * 3], y = xyz[src * 3 + 1], z = xyz[src * 3 + 2];
      if (!isfinitef(x) || !isfinitef(y) || !isfinitef(z)) continue;
      const float d = qdist(x, y, z, cam_x, cam_y, cam_z);
      if (d > radiusLimit) continue;
      bool cutHere = false;
      if (!skip_frustum && !inside) {
        for (int32_t p = 0; p < 6; ++p) {
          if (outside(planes[p], x, y, z, margin)) { cutHere = true; break; }
        }
        if (cutHere) continue;
      }
      const float h = qhash(x, z);
      if (ground && d > keepFrom) {
        const float t = (d - keepFrom) / maxf(1.0f, cull_radius - keepFrom);
        const float keep = 1.0f - t * t * (3.0f - 2.0f * t);
        if (h > keep) continue;
      }
      if (out >= QT_MAX_INST) break;
      qtIndex[out] = src;
      qtTier[out] = d <= mid_distance + h * band ? 0 : (d <= far_distance + h * band ? 1 : 2);
      ++out;
    }
  }
  s.stats[1] = int32_t(visited);
  s.stats[2] = int32_t(culled);
  s.stats[3] = int32_t(out);
  s.stats[4] = int32_t(scanned);
  return int32_t(out);
}

FE_EXPORT uint32_t* fe_lod_tree_index_ptr(void) { return qtIndex; }
FE_EXPORT uint8_t* fe_lod_tree_tier_ptr(void) { return qtTier; }
FE_EXPORT int32_t* fe_lod_tree_stats_ptr(int32_t slot) {
  if (slot < 0 || slot >= QT_SLOTS) return qtSlots[0].stats;
  return qtSlots[slot].stats;
}
FE_EXPORT int32_t fe_lod_tree_node_count(int32_t slot) {
  if (slot < 0 || slot >= QT_SLOTS || !qtSlots[slot].valid) return 0;
  return int32_t(qtSlots[slot].nodes);
}
FE_EXPORT int32_t fe_lod_tree_leaf_capacity(void) { return int32_t(QT_LEAF); }
FE_EXPORT int32_t fe_lod_tree_max_instances(void) { return int32_t(QT_MAX_INST); }
FE_EXPORT int32_t fe_lod_tree_slot_count(void) { return QT_SLOTS; }

/* Pool occupancy: [nodes used, node capacity, permutation used]. The studio's
   performance sheet reports it and a test asserts it never runs away. */
static int32_t qtPool[3];
FE_EXPORT int32_t* fe_lod_tree_pool_ptr(void) {
  qtPool[0] = int32_t(qtNodeUsed);
  qtPool[1] = int32_t(QT_MAX_NODES);
  qtPool[2] = int32_t(qtOrderUsed);
  return qtPool;
}

}  // extern "C"
