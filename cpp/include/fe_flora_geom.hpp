/* Herbarium geometry accessors.
 * =========================================================================
 * fe_impostor.cpp rasterises the plant the kernel just grew, so it has to read
 * the mesh the flora kernel left in its buffers. Those buffers are private to
 * fe_flora.cpp; this header is the internal (non-exported) door between the two
 * translation units. Nothing here is part of the WebAssembly ABI — the symbols
 * are hidden so --export-dynamic does not publish them to JavaScript.
 * ========================================================================= */
#ifndef FE_FLORA_GEOM_HPP
#define FE_FLORA_GEOM_HPP

#include <stdint.h>

namespace fe_flora_geom {

/* The mesh left behind by the most recent fe_flora_tree() call. */
const float* pos();
const float* nrm();
const float* col();
const uint32_t* idx();
int32_t verts();
int32_t indices();

/* The leaf cards that call grew alongside the wood. A broadleaf's canopy is
 * entirely in this buffer, so anything that draws the plant has to read both. */
const float* card_pos();
const float* card_nrm();
const float* card_col();
const uint32_t* card_idx();
int32_t card_verts();
int32_t card_indices();

}  // namespace fe_flora_geom

#endif  // FE_FLORA_GEOM_HPP
