#include "../include/fe_abi.h"

namespace {

/* Dedicated 12 MB scratch arena inside C++ linear memory for JS <-> C++ mesh/frame marshaling */
constexpr uint32_t kScratchArenaSize = 12u * 1024u * 1024u;
alignas(16) static uint8_t g_scratch_arena[kScratchArenaSize];
static uint32_t g_arena_offset = 0;

} // namespace

#if defined(__wasm__)
extern "C" {

void __wasm_call_ctors(void);

__attribute__((noinline))
void* memcpy(void* __restrict dst, const void* __restrict src, size_t n) {
  uint8_t* d = static_cast<uint8_t*>(dst);
  const uint8_t* s = static_cast<const uint8_t*>(src);
  for (size_t i = 0; i < n; ++i) {
    asm volatile("" ::: "memory");
    d[i] = s[i];
  }
  return dst;
}

__attribute__((noinline))
void* memmove(void* dst, const void* src, size_t n) {
  uint8_t* d = static_cast<uint8_t*>(dst);
  const uint8_t* s = static_cast<const uint8_t*>(src);
  if (d < s || d >= s + n) {
    for (size_t i = 0; i < n; ++i) {
      asm volatile("" ::: "memory");
      d[i] = s[i];
    }
  } else if (d > s) {
    for (size_t i = n; i > 0; --i) {
      asm volatile("" ::: "memory");
      d[i - 1] = s[i - 1];
    }
  }
  return dst;
}

__attribute__((noinline))
void* memset(void* dst, int c, size_t n) {
  uint8_t* d = static_cast<uint8_t*>(dst);
  const uint8_t v = static_cast<uint8_t>(c);
  for (size_t i = 0; i < n; ++i) {
    asm volatile("" ::: "memory");
    d[i] = v;
  }
  return dst;
}

} // extern "C"

static bool g_wasm_ctors_initialized = false;
static inline void ensure_wasm_runtime_initialized() {
  if (!g_wasm_ctors_initialized) {
    g_wasm_ctors_initialized = true;
    __wasm_call_ctors();
  }
}
#else
static inline void ensure_wasm_runtime_initialized() {}
#endif

extern "C" {

FE_EXPORT uint32_t fe_core_abi_version(void) {
  ensure_wasm_runtime_initialized();
  return FE_CORE_ABI_VERSION;
}

FE_EXPORT uint32_t fe_malloc(uint32_t byte_size) {
  ensure_wasm_runtime_initialized();
  if (byte_size == 0) byte_size = 16;
  const uint32_t aligned = (byte_size + 15u) & ~15u;
  if (g_arena_offset + aligned > kScratchArenaSize) {
    /* Wrap scratch arena if exhausted during transient calls */
    if (aligned > kScratchArenaSize) return 0;
    g_arena_offset = 0;
  }
  uint8_t* ptr = &g_scratch_arena[g_arena_offset];
  g_arena_offset += aligned;
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ptr));
}

FE_EXPORT void fe_free(uint32_t /*ptr*/) {
  /* Managed by fe_arena_reset() per marshaling batch for zero fragmentation */
}

FE_EXPORT void fe_arena_reset(void) {
  ensure_wasm_runtime_initialized();
  g_arena_offset = 0;
}

FE_EXPORT uint32_t fe_heap_used_bytes(void) {
  return g_arena_offset;
}

} // extern "C"
