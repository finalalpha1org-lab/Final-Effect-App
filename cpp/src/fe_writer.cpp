#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"
#include "../include/fe_math.hpp"

/* Text writers for the workspace exporters: Wavefront OBJ and MTL.

   These used to build a JavaScript array of lines and join it. A mesh with a
   hundred thousand vertices is a hundred thousand `v x y z` lines, and every
   one of them went through template literals, a number-to-string conversion and
   an array push before the join copied the whole lot again.

   The writer appends into one contiguous byte buffer in engine memory and the
   bridge decodes it once. Numbers are formatted here too: the OBJ format has
   six decimals and the JavaScript rounded to exactly that
   (`Math.round(value * 1e6) / 1e6`), so the formatter reproduces the same
   decimal digits by working in integers instead of asking a float printer to
   guess. A value beyond +/-9e9 cannot be expressed in that fixed-point form and
   is written as 0, which is what the size limits of the format imply anyway.

   Everything is append-only: the caller reserves a buffer, emits what it wants
   and reads the bytes back. If a line would overflow the buffer the call
   returns -2 and the JavaScript side falls back to its own writer - a truncated
   OBJ is worse than a slow one. */

namespace {
using namespace fe;

uint8_t* g_text = nullptr;
uint32_t g_capacity = 0;
uint32_t g_length = 0;

/* Reserve the append buffer. The heap is a bump allocator, so the block is kept
 * for the life of the session and only replaced when a bigger one is asked for. */
int32_t reserve_text(uint32_t bytes) {
  if (bytes == 0) return -3;
  if (g_text && bytes <= g_capacity) return 0;
  void* block = fe::heap::alloc(bytes, 16);
  if (!block) return -1;
  g_text = static_cast<uint8_t*>(block);
  g_capacity = bytes;
  return 0;
}

bool append(const void* data, uint32_t length) {
  if (g_length + length > g_capacity) return false;
  __builtin_memcpy(g_text + g_length, data, length);
  g_length += length;
  return true;
}

bool append_char(char c) {
  if (g_length + 1 > g_capacity) return false;
  g_text[g_length++] = static_cast<uint8_t>(c);
  return true;
}

bool append_text(const char* text) {
  uint32_t n = 0;
  while (text[n] != '\0') ++n;
  return append(text, n);
}

bool append_string(const uint8_t* text, uint32_t length) {
  if (!length) return true;
  if (!text) return false;
  return append(text, length);
}

bool append_u64(uint64_t value) {
  char buffer[24];
  uint32_t n = 0;
  if (value == 0) buffer[n++] = '0';
  while (value) {
    buffer[n++] = static_cast<char>('0' + (value % 10));
    value /= 10;
  }
  for (uint32_t i = 0; i < n / 2; ++i) {
    const char swap = buffer[i];
    buffer[i] = buffer[n - 1 - i];
    buffer[n - 1 - i] = swap;
  }
  return append(buffer, n);
}

/* The OBJ decimal form: `Math.round(value * 1e6) / 1e6`, printed the way
 * JavaScript prints that number. Rounding is done with floor(x + 0.5), which is
 * what Math.round does for the negative halves too. */
bool append_float(double value) {
  if (!__builtin_isfinite(value)) return append_char('0');
  const double scaled = value * 1e6;
  /* Outside this range the fixed-point form stops being exact; such a
     coordinate is not a mesh, so it is emitted as 0 rather than as a wrong
     number. */
  if (!(scaled > -9.0e15) || !(scaled < 9.0e15)) return append_char('0');
  const int64_t units = static_cast<int64_t>(__builtin_floor(scaled + 0.5));
  if (units == 0) return append_char('0');

  const bool negative = units < 0;
  const uint64_t magnitude = static_cast<uint64_t>(negative ? -units : units);
  const uint64_t whole = magnitude / 1000000u;
  uint64_t fraction = magnitude % 1000000u;
  if (negative) {
    if (!append_char('-')) return false;
  }
  if (!append_u64(whole)) return false;
  if (fraction == 0) return true;

  /* Six decimal places, trailing zeros dropped: String(0.5) is "0.5", and
     String(0.000001) is "0.000001". */
  char digits[6];
  for (int i = 5; i >= 0; --i) {
    digits[i] = static_cast<char>('0' + (fraction % 10));
    fraction /= 10;
  }
  int last = 6;
  while (last > 0 && digits[last - 1] == '0') --last;
  if (!append_char('.')) return false;
  return append(digits, static_cast<uint32_t>(last));
}

bool append_line_end() { return append_char('\n'); }

}  // namespace

extern "C" {

/* Reserve the append buffer and clear it. `bytes` is the whole document budget;
 * the caller sizes it from the mesh counts. */
FE_EXPORT int32_t fe_writer_begin(uint32_t bytes) {
  const int32_t rc = reserve_text(bytes);
  if (rc != 0) return rc;
  g_length = 0;
  return 0;
}

/* Keep the buffer, drop the text: one buffer serves OBJ and MTL in a row. */
FE_EXPORT int32_t fe_writer_reset(void) {
  if (!g_text) return -1;
  g_length = 0;
  return 0;
}

FE_EXPORT uint8_t* fe_writer_text_ptr(void) { return g_text; }
FE_EXPORT uint32_t fe_writer_text_length(void) { return g_length; }

/* `# Final Effect 3D Workspace` / `# N meshes, M triangles` / optional mtllib. */
FE_EXPORT int32_t fe_writer_obj_header(uint32_t mesh_count, uint32_t triangle_count,
                                       const uint8_t* mtl_name, uint32_t mtl_length) {
  if (!g_text) return -1;
  if (!append_text("# Final Effect 3D Workspace") || !append_line_end()) return -2;
  if (!append_text("# ") || !append_u64(mesh_count) || !append_text(" meshes, ") ||
      !append_u64(triangle_count) || !append_text(" triangles") || !append_line_end()) return -2;
  if (mtl_length) {
    if (!append_text("mtllib ") || !append_string(mtl_name, mtl_length) || !append_line_end()) return -2;
  }
  return 0;
}

/* One object: its vertices, uvs, normals and faces, offset by `base` (the first
 * index of this object's vertex block, 1-based as OBJ requires). The three
 * buffers carry their own component counts, because a mesh may have fewer uv or
 * normal entries than vertices - and the JavaScript writer emitted one line per
 * entry it actually had. */
FE_EXPORT int32_t fe_writer_obj_mesh(const uint8_t* name, uint32_t name_length,
                                     const uint8_t* material, uint32_t material_length,
                                     const float* positions, uint32_t position_length,
                                     const float* normals, uint32_t normal_length,
                                     const float* uvs, uint32_t uv_length,
                                     const uint32_t* indices, uint32_t index_count,
                                     uint32_t base) {
  if (!g_text || !positions || (index_count && !indices)) return -3;
  /* The blank line between objects. */
  if (!append_line_end()) return -2;
  if (!append_text("o ") || !append_string(name, name_length) || !append_line_end()) return -2;
  if (material_length) {
    if (!append_text("usemtl ") || !append_string(material, material_length) || !append_line_end()) return -2;
  }
  for (uint32_t i = 0; i + 2 < position_length; i += 3) {
    if (!append_text("v ") || !append_float(positions[i]) || !append_char(' ') ||
        !append_float(positions[i + 1]) || !append_char(' ') ||
        !append_float(positions[i + 2]) || !append_line_end()) return -2;
  }
  if (uvs && uv_length) {
    for (uint32_t i = 0; i + 1 < uv_length; i += 2) {
      if (!append_text("vt ") || !append_float(uvs[i]) || !append_char(' ') ||
          !append_float(uvs[i + 1]) || !append_line_end()) return -2;
    }
  }
  if (normals && normal_length) {
    for (uint32_t i = 0; i + 2 < normal_length; i += 3) {
      if (!append_text("vn ") || !append_float(normals[i]) || !append_char(' ') ||
          !append_float(normals[i + 1]) || !append_char(' ') ||
          !append_float(normals[i + 2]) || !append_line_end()) return -2;
    }
  }
  const uint32_t has_uv = (uvs && uv_length) ? 1u : 0u;
  const uint32_t has_normal = (normals && normal_length) ? 1u : 0u;
  for (uint32_t i = 0; i + 2 < index_count; i += 3) {
    const uint64_t a = static_cast<uint64_t>(base) + indices[i];
    const uint64_t b = static_cast<uint64_t>(base) + indices[i + 1];
    const uint64_t c = static_cast<uint64_t>(base) + indices[i + 2];
    if (!append_text("f ")) return -2;
    /* v/vt/vn, v//vn, v/vt or plain v - whichever the mesh actually has. */
    for (int corner = 0; corner < 3; ++corner) {
      const uint64_t n = corner == 0 ? a : (corner == 1 ? b : c);
      if (corner) {
        if (!append_char(' ')) return -2;
      }
      if (!append_u64(n)) return -2;
      if (has_uv && has_normal) {
        if (!append_char('/') || !append_u64(n) || !append_char('/') || !append_u64(n)) return -2;
      } else if (has_normal) {
        if (!append_text("//") || !append_u64(n)) return -2;
      } else if (has_uv) {
        if (!append_char('/') || !append_u64(n)) return -2;
      }
    }
    if (!append_line_end()) return -2;
  }
  return 0;
}

/* `# Final Effect 3D Workspace material library` */
FE_EXPORT int32_t fe_writer_mtl_header(void) {
  if (!g_text) return -1;
  if (!append_text("# Final Effect 3D Workspace material library") || !append_line_end()) return -2;
  return 0;
}

/* One material block. `emissive` is null unless the material actually emits, so
 * a black emissive never writes a `Ke` line. */
FE_EXPORT int32_t fe_writer_mtl_material(const uint8_t* name, uint32_t name_length,
                                         double r, double g, double b, double a,
                                         double roughness, double metallic,
                                         const double* emissive, uint32_t has_emissive) {
  if (!g_text) return -1;
  const double specular = (1.0 - roughness) * 0.5;
  const double shininess = (1.0 - roughness) * 900.0;
  /* Math.max(1, x), except that a NaN stays NaN and reaches the formatter as
     the "0" the JavaScript writer produced for it. */
  const double ns = (shininess == shininess && shininess < 1.0) ? 1.0 : shininess;
  if (!append_line_end()) return -2;
  if (!append_text("newmtl ") || !append_string(name, name_length) || !append_line_end()) return -2;
  if (!append_text("Ka 0.0 0.0 0.0") || !append_line_end()) return -2;
  if (!append_text("Kd ") || !append_float(r) || !append_char(' ') || !append_float(g) ||
      !append_char(' ') || !append_float(b) || !append_line_end()) return -2;
  if (!append_text("Ks ") || !append_float(specular) || !append_char(' ') ||
      !append_float(specular) || !append_char(' ') || !append_float(specular) ||
      !append_line_end()) return -2;
  if (!append_text("Ns ") || !append_float(ns) || !append_line_end()) return -2;
  if (!append_text("d ") || !append_float(a) || !append_line_end()) return -2;
  if (!append_text("illum 2") || !append_line_end()) return -2;
  if (!append_text("Pr ") || !append_float(roughness) || !append_line_end()) return -2;
  if (!append_text("Pm ") || !append_float(metallic) || !append_line_end()) return -2;
  if (has_emissive && emissive) {
    if (!append_text("Ke ") || !append_float(emissive[0]) || !append_char(' ') ||
        !append_float(emissive[1]) || !append_char(' ') || !append_float(emissive[2]) ||
        !append_line_end()) return -2;
  }
  return 0;
}

}  // extern "C"
