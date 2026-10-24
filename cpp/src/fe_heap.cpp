#include "../include/fe_heap.hpp"

/* The allocator behind fe_heap.hpp. One translation unit, so that a native
 * build of the C++ tests links the same implementation the artifact uses
 * instead of a stub that would let a bad allocation pass unnoticed. */

#if defined(__wasm__)
extern "C" unsigned char __heap_base;
#endif

namespace {

#if defined(__wasm__)

/* decltype(sizeof(0)) is size_t without a libc header. */
using mem_size_t = decltype(sizeof(0));

inline uintptr_t heap_floor() { return reinterpret_cast<uintptr_t>(&__heap_base); }
inline uintptr_t heap_ceiling() { return static_cast<uintptr_t>(__builtin_wasm_memory_size(0)) * 65536u; }
inline bool heap_grow_above(uintptr_t end) {
  const uintptr_t have = heap_ceiling();
  if (end <= have) return true;
  const uintptr_t pages = (end - have + 65535u) / 65536u;
  if (pages > 4096u) return false; /* 256 MB in one request is a bug, not a frame */
  return __builtin_wasm_memory_grow(0, static_cast<mem_size_t>(pages)) != static_cast<mem_size_t>(-1);
}

#else

/* Native builds (the C++ unit tests) have no linear memory to grow, so the same
 * contract is met from a fixed block. 64 MB is above every kernel's working
 * set; a test that asks for more is a test that would fail on wasm too. */
constexpr uint32_t kHostHeapBytes = 64u * 1024u * 1024u;
alignas(16) static uint8_t g_host_heap[kHostHeapBytes];
inline uintptr_t heap_floor() { return reinterpret_cast<uintptr_t>(g_host_heap); }
inline uintptr_t heap_ceiling() { return heap_floor() + kHostHeapBytes; }
inline bool heap_grow_above(uintptr_t end) { return end <= heap_ceiling(); }

#endif

uintptr_t g_heap_cursor = 0;

inline uintptr_t heap_start() { return (heap_floor() + 15u) & ~static_cast<uintptr_t>(15u); }

} // namespace

void* fe::heap::alloc(uint32_t bytes, uint32_t alignment) {
  if (bytes == 0) return nullptr;
  if (alignment < 16u) alignment = 16u;
  uintptr_t p = (g_heap_cursor == 0) ? heap_start() : g_heap_cursor;
  p = (p + (alignment - 1u)) & ~static_cast<uintptr_t>(alignment - 1u);
  const uintptr_t end = p + bytes;
  if (!heap_grow_above(end)) return nullptr;
  if (end > heap_ceiling()) return nullptr;
  g_heap_cursor = end;
  return reinterpret_cast<void*>(p);
}

uint32_t fe::heap::used(void) {
  if (g_heap_cursor == 0) return 0;
  return static_cast<uint32_t>(g_heap_cursor - heap_start());
}

uint32_t fe::heap::capacity(void) {
  return static_cast<uint32_t>(heap_ceiling() - heap_floor());
}
