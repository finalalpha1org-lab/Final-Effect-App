#ifndef FE_HEAP_HPP
#define FE_HEAP_HPP

/* A lazily grown heap for the buffers that a studio only needs once it is
 * actually used.
 *
 * Every kernel in this module used to keep its working set in BSS, which meant
 * that instantiating the artifact reserved 169 MB before a single triangle was
 * drawn — and the kernel worker reserved a second copy of all of it to bake a
 * 64x128 impostor atlas. WebAssembly memory is zero filled, so an untouched
 * page costs little on a desktop; on a phone it is a hard reservation against a
 * per-tab ceiling, and the reservation was the larger half of the problem.
 *
 * The heap starts at __heap_base (above the static data and the shadow stack,
 * which wasm-ld places below it) and grows a page at a time with
 * memory.grow. That makes the artifact's boot cost proportional to what the
 * studio actually initialises, and it lets a subsystem that nobody opened cost
 * nothing at all.
 *
 * This is a bump allocator: blocks are never returned. Every caller allocates
 * once per process and keeps the pointer, which is why there is no free — the
 * two alternatives are a real allocator with its own fragmentation and failure
 * modes, or this. A replacement that releases memory can be fitted behind the
 * same three functions without touching a caller.
 *
 * Pointers are offsets into linear memory and stay valid across a grow; it is
 * the JavaScript side's typed-array views that are detached by one, so a view
 * is always re-created from memory.buffer after the subsystem initialises. */

#include <stdint.h>

namespace fe {
namespace heap {

/* Returns a zeroed block of at least `bytes`, aligned to `alignment`
 * (a power of two, at most 16). Returns nullptr when the device refuses to grow
 * the memory, which callers must treat the way they treat any other allocation
 * failure: refuse the operation rather than write through a null pointer.
 *
 * The block is a real pointer, not a wasm offset: the same code is compiled
 * natively for the C++ unit tests, where a pointer is 64 bits wide and
 * truncating one to 32 would be a crash rather than a smaller address. */
void* alloc(uint32_t bytes, uint32_t alignment = 16);

/* Bytes handed out so far, and the size of linear memory. The difference
 * between the two is what a grow would have to happen for. */
uint32_t used(void);
uint32_t capacity(void);

}  // namespace heap
}  // namespace fe

#endif  // FE_HEAP_HPP
