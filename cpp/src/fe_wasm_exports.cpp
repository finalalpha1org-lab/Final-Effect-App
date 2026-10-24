#include "../include/fe_abi.h"
#include "../include/fe_heap.hpp"

namespace {

/* Dedicated 24 MB scratch arena inside C++ linear memory for JS <-> C++ mesh/frame marshaling */
constexpr uint32_t kScratchArenaSize = 24u * 1024u * 1024u;
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

/* What the lazily grown heap has handed out, and how big linear memory is. The
 * studio panel reports the pair instead of pretending the artifact has a fixed
 * footprint: the first number is the real working set of the kernels that have
 * been opened, the second the ceiling they have grown to since boot. */
FE_EXPORT uint32_t fe_heap_lazy_used(void) {
  ensure_wasm_runtime_initialized();
  return fe::heap::used();
}

FE_EXPORT uint32_t fe_heap_lazy_capacity(void) {
  ensure_wasm_runtime_initialized();
  return fe::heap::capacity();
}

/* The simulation core's JavaScript arena used to be a second bump allocator
 * that started at the end of linear memory and grew it itself, which meant two
 * pieces of code believed they owned the region above the static data. It asks
 * the kernel instead: one allocator, one owner, and an allocation that can
 * never land inside a kernel buffer. Returns 0 when the device refuses the
 * memory; the caller throws rather than writing through a null pointer. */
FE_EXPORT uint32_t fe_heap_alloc(uint32_t byte_size, uint32_t alignment) {
  ensure_wasm_runtime_initialized();
  return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(fe::heap::alloc(byte_size, alignment)));
}

} // extern "C"
