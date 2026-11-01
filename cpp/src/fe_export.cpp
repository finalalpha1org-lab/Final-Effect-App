#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

/* World-space geometry baking and the CRC the ZIP writer needs.

   The exporters used to do this in JavaScript: a per-vertex loop that
   multiplied a 4x4 world matrix into every position, ran an inverse-transpose
   for the normals and then repeated the whole thing once per instanced copy.
   A 40 000-tree scene is 40 000 x 96 vertices of that loop, in the tab that is
   already drawing the frame, and the numbers it produces are the ones both
   file writers consume unchanged.

   So the maths lives here now, as a session:

     fe_export_begin(capacities)   reserve the source and output blocks
     fe_export_set_counts(...)     how many vertices / indices this mesh has
     fe_export_bake(m)             one object, its world matrix
     fe_export_bake_instanced(...)  N copies of one mesh, base x instance

   The JavaScript side only copies its typed arrays in and the baked arrays
   out; it never touches a vertex. Matrices are column-major, the same layout
   as THREE.Matrix4.elements, so the caller passes `matrixWorld.elements`
   straight through. World matrices arrive as float64 and the instance matrix
   array as float32, which is the precision THREE itself holds them in. Normals go through the inverse transpose of the
   upper-left 3x3 and are renormalised, which is what keeps a non-uniformly
   scaled mesh from shading as if it were sheared.

   The same file owns the CRC-32 the PNG-sequence ZIP is built from: it runs
   over every frame of a rendered sequence, which is megabytes per export. */

namespace {
using namespace fe;

/* Four million vertices is 48 MB of output at one instance; the cap exists so
 * a bad count is refused instead of asking the heap for 2 GB. */
constexpr uint32_t kMaxVertices = 4u * 1024u * 1024u;
constexpr uint32_t kMaxIndices = 12u * 1024u * 1024u;
constexpr uint32_t kMaxInstances = 65536u;

/* One buffer of the session. The capacity lives with the pointer: a single
 * shared capacity would let a small buffer answer a large request. */
template <typename T>
struct Buffer {
  T* ptr = nullptr;
  uint32_t capacity = 0;
};

/* Source mesh: what the caller uploads. */
Buffer<float> g_src_pos, g_src_nrm, g_src_uv;
Buffer<uint32_t> g_src_idx;

/* Baked output: source x instances. */
Buffer<float> g_out_pos, g_out_nrm, g_out_uv;
Buffer<uint32_t> g_out_idx;

uint32_t g_vertex_count = 0;
uint32_t g_index_count = 0;
uint32_t g_has_normals = 0;
uint32_t g_has_uv = 0;

uint32_t g_out_vertices = 0;
uint32_t g_out_indices = 0;
uint32_t g_out_instances = 0;

/* The heap is a bump allocator that never returns a block, so a buffer is only
 * re-reserved when the caller asks for more room than it already has. */
template <typename T>
T* reserve(Buffer<T>& buffer, uint32_t wanted) {
  if (buffer.ptr && wanted <= buffer.capacity) return buffer.ptr;
  void* block = fe::heap::alloc(wanted * static_cast<uint32_t>(sizeof(T)), 16);
  if (!block) return nullptr;
  buffer.ptr = static_cast<T*>(block);
  buffer.capacity = wanted;
  return buffer.ptr;
}

void identity(double* m) {
  for (uint32_t i = 0; i < 16; ++i) m[i] = 0.0;
  m[0] = 1.0;
  m[5] = 1.0;
  m[10] = 1.0;
  m[15] = 1.0;
}

/* Inverse transpose of the upper-left 3x3, row-major, exactly the matrix the
 * JavaScript exporter computed: a singular or non-finite matrix falls back to
 * identity instead of writing NaNs into the normal buffer. */
void normal_matrix(const double* m, double* n) {
  const double a = m[0], b = m[1], c = m[2];
  const double d = m[4], e = m[5], f = m[6];
  const double g = m[8], h = m[9], i = m[10];
  const double A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  if (det == 0.0 || !isfinitef(det)) {
    n[0] = 1.0; n[1] = 0.0; n[2] = 0.0;
    n[3] = 0.0; n[4] = 1.0; n[5] = 0.0;
    n[6] = 0.0; n[7] = 0.0; n[8] = 1.0;
    return;
  }
  const double s = 1.0 / det;
  n[0] = A * s;
  n[1] = B * s;
  n[2] = C * s;
  n[3] = (c * h - b * i) * s;
  n[4] = (a * i - c * g) * s;
  n[5] = (b * g - a * h) * s;
  n[6] = (b * f - c * e) * s;
  n[7] = (c * d - a * f) * s;
  n[8] = (a * e - b * d) * s;
}

/* Column-major a x b. The index order matches the JavaScript helper this
 * replaces (`workspace-export.js: multiply`), so an instanced export produced
 * before this kernel existed and one produced after it are the same bytes:
 *   out[col * 4 + row] = sum_k a[k * 4 + row] * b[col * 4 + k] */
void multiply4(const double* a, const double* b, double* out) {
  for (uint32_t col = 0; col < 4; ++col) {
    for (uint32_t row = 0; row < 4; ++row) {
      out[col * 4 + row] = a[row] * b[col * 4] +
                           a[4 + row] * b[col * 4 + 1] +
                           a[8 + row] * b[col * 4 + 2] +
                           a[12 + row] * b[col * 4 + 3];
    }
  }
}

/* Bake the source mesh with `m` into the output at `vertex_base`, reading the
 * uploaded float32 mesh but doing every operation in double, the precision a
 * JavaScript number has. The result is rounded to float32 only at the store,
 * which is exactly what writing into a Float32Array did, so a scene baked by
 * this kernel and one baked by the loop it replaced are the same bits. */
void bake_block(const double* m, const double* nm, uint32_t vertex_base) {
  const uint32_t count = g_vertex_count;
  for (uint32_t i = 0; i < count; ++i) {
    const double px = g_src_pos.ptr[i * 3 + 0];
    const double py = g_src_pos.ptr[i * 3 + 1];
    const double pz = g_src_pos.ptr[i * 3 + 2];
    float* dst = g_out_pos.ptr + static_cast<size_t>(vertex_base + i) * 3;
    dst[0] = static_cast<float>(m[0] * px + m[4] * py + m[8] * pz + m[12]);
    dst[1] = static_cast<float>(m[1] * px + m[5] * py + m[9] * pz + m[13]);
    dst[2] = static_cast<float>(m[2] * px + m[6] * py + m[10] * pz + m[14]);

    if (g_has_normals) {
      const double nx = g_src_nrm.ptr[i * 3 + 0];
      const double ny = g_src_nrm.ptr[i * 3 + 1];
      const double nz = g_src_nrm.ptr[i * 3 + 2];
      const double ox = nm[0] * nx + nm[1] * ny + nm[2] * nz;
      const double oy = nm[3] * nx + nm[4] * ny + nm[5] * nz;
      const double oz = nm[6] * nx + nm[7] * ny + nm[8] * nz;
      /* Math.hypot(...) || 1: a zero-length normal stays zero, it is not
       * divided by a zero length. */
      double len = __builtin_sqrt(ox * ox + oy * oy + oz * oz);
      if (!(len > 0.0) || !isfinitef(len)) len = 1.0;
      float* ndst = g_out_nrm.ptr + static_cast<size_t>(vertex_base + i) * 3;
      ndst[0] = static_cast<float>(ox / len);
      ndst[1] = static_cast<float>(oy / len);
      ndst[2] = static_cast<float>(oz / len);
    }
    if (g_has_uv) {
      g_out_uv.ptr[(vertex_base + i) * 2 + 0] = g_src_uv.ptr[i * 2 + 0];
      g_out_uv.ptr[(vertex_base + i) * 2 + 1] = g_src_uv.ptr[i * 2 + 1];
    }
  }
}

/* Copy the source indices into the output, offset by the block's first vertex
 * so the copies share one index buffer instead of one buffer per copy. */
void bake_indices(uint32_t vertex_base, uint32_t index_base) {
  for (uint32_t i = 0; i < g_index_count; ++i) {
    g_out_idx.ptr[index_base + i] = g_src_idx.ptr[i] + vertex_base;
  }
}

int32_t bake_instanced(const double* base_matrix, const float* instances, uint32_t count) {
  if (!g_src_pos.ptr || !base_matrix || !instances) return -3;
  if (!g_vertex_count) return 0;
  if (count == 0 || count > kMaxInstances) return -3;

  const uint64_t want_vertices = static_cast<uint64_t>(g_vertex_count) * count;
  const uint64_t want_indices = static_cast<uint64_t>(g_index_count) * count;
  if (want_vertices > g_out_pos.capacity / 3u || want_indices > g_out_idx.capacity) return -2;

  double m[16];
  for (uint32_t k = 0; k < count; ++k) {
    double inst[16];
    for (uint32_t j = 0; j < 16; ++j) inst[j] = instances[static_cast<size_t>(k) * 16 + j];
    double nm[9];
    multiply4(base_matrix, inst, m);
    normal_matrix(m, nm);
    const uint32_t vertex_base = k * g_vertex_count;
    bake_block(m, nm, vertex_base);
    bake_indices(vertex_base, k * g_index_count);
  }
  g_out_vertices = g_vertex_count * count;
  g_out_indices = g_index_count * count;
  g_out_instances = count;
  return static_cast<int32_t>(count);
}

}  // namespace

extern "C" {

/* Reserve the session. `instance_capacity` is how many copies one mesh may be
 * baked into, so the output block is sized for mesh x copies up front. */
FE_EXPORT int32_t fe_export_begin(uint32_t vertex_capacity, uint32_t index_capacity,
                                  uint32_t instance_capacity) {
  if (vertex_capacity == 0 || vertex_capacity > kMaxVertices) return -3;
  if (index_capacity > kMaxIndices) return -3;
  uint32_t cap = instance_capacity == 0 ? 1u : instance_capacity;
  if (cap > kMaxInstances) cap = kMaxInstances;

  /* Capacities are counted in vertices and indices; each buffer is sized for
   * the components it holds (xyz, xyz, uv). */
  const uint32_t index_cap = index_capacity ? index_capacity : 1u;
  if (!reserve(g_src_pos, vertex_capacity * 3u)) return -1;
  if (!reserve(g_src_nrm, vertex_capacity * 3u)) return -1;
  if (!reserve(g_src_uv, vertex_capacity * 2u)) return -1;
  if (!reserve(g_src_idx, index_cap)) return -1;

  const uint64_t out_vertices = static_cast<uint64_t>(vertex_capacity) * cap;
  const uint64_t out_indices = static_cast<uint64_t>(index_cap) * cap;
  if (out_vertices > kMaxVertices) return -3;
  if (!reserve(g_out_pos, static_cast<uint32_t>(out_vertices * 3ull))) return -1;
  if (!reserve(g_out_nrm, static_cast<uint32_t>(out_vertices * 3ull))) return -1;
  if (!reserve(g_out_uv, static_cast<uint32_t>(out_vertices * 2ull))) return -1;
  if (out_indices > 0xFFFFFFFFull) return -3;
  if (!reserve(g_out_idx, static_cast<uint32_t>(out_indices))) return -1;

  g_vertex_count = 0;
  g_index_count = 0;
  g_has_normals = 0;
  g_has_uv = 0;
  g_out_vertices = 0;
  g_out_indices = 0;
  g_out_instances = 0;
  return 0;
}

FE_EXPORT int32_t fe_export_set_counts(uint32_t vertex_count, uint32_t index_count,
                                       uint32_t has_normals, uint32_t has_uv) {
  if (!g_src_pos.ptr) return -1;
  if (vertex_count > g_src_pos.capacity || index_count > g_src_idx.capacity) return -2;
  g_vertex_count = vertex_count;
  g_index_count = index_count;
  g_has_normals = has_normals ? 1u : 0u;
  g_has_uv = has_uv ? 1u : 0u;
  return 0;
}

FE_EXPORT float* fe_export_src_pos_ptr(void) { return g_src_pos.ptr; }
FE_EXPORT float* fe_export_src_nrm_ptr(void) { return g_src_nrm.ptr; }
FE_EXPORT float* fe_export_src_uv_ptr(void) { return g_src_uv.ptr; }
FE_EXPORT uint32_t* fe_export_src_idx_ptr(void) { return g_src_idx.ptr; }

FE_EXPORT float* fe_export_out_pos_ptr(void) { return g_out_pos.ptr; }
FE_EXPORT float* fe_export_out_nrm_ptr(void) { return g_out_nrm.ptr; }
FE_EXPORT float* fe_export_out_uv_ptr(void) { return g_out_uv.ptr; }
FE_EXPORT uint32_t* fe_export_out_idx_ptr(void) { return g_out_idx.ptr; }

FE_EXPORT uint32_t fe_export_out_vertex_count(void) { return g_out_vertices; }
FE_EXPORT uint32_t fe_export_out_index_count(void) { return g_out_indices; }
FE_EXPORT uint32_t fe_export_instance_count(void) { return g_out_instances; }

/* One object: its world matrix in, baked buffers out. A null matrix means the
 * identity, which is what a mesh already in world space wants. */
FE_EXPORT int32_t fe_export_bake(const double* matrix16) {
  if (!g_src_pos.ptr) return -1;
  double identity_matrix[16];
  identity(identity_matrix);
  static const float unit_instance[16] = {1.f, 0.f, 0.f, 0.f,
                                          0.f, 1.f, 0.f, 0.f,
                                          0.f, 0.f, 1.f, 0.f,
                                          0.f, 0.f, 0.f, 1.f};
  const int32_t rc = bake_instanced(matrix16 ? matrix16 : identity_matrix, unit_instance, 1);
  return rc < 0 ? rc : 0;
}

/* N copies of one mesh: `base16` is the object's world matrix (the same matrix
 * every instance inherits), `instances16` is the instanceMatrix array. */
FE_EXPORT int32_t fe_export_bake_instanced(const double* base16, const float* instances16,
                                           uint32_t count) {
  return bake_instanced(base16, instances16, count);
}

/* Standard IEEE CRC-32 (polynomial 0xEDB88320, reflected), seeded with the
 * running value of the previous chunk so a file can be hashed in slices.
 * `seed` is the finalised CRC of the bytes already hashed — 0 for the first. */
FE_EXPORT int32_t fe_zip_crc32(uint32_t seed, const uint8_t* data, uint32_t length,
                               uint32_t* out_crc) {
  if (!out_crc) return -3;
  if (length && !data) return -3;
  uint32_t c = ~seed;
  for (uint32_t i = 0; i < length; ++i) {
    c ^= data[i];
    for (uint32_t k = 0; k < 8; ++k) {
      const uint32_t mask = static_cast<uint32_t>(0u - (c & 1u));
      c = (c >> 1) ^ (0xEDB88320u & mask);
    }
  }
  *out_crc = ~c;
  return 0;
}

}  // extern "C"
