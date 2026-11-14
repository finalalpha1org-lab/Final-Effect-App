# The liquid solver

`cpp/src/fe_flip.cpp` is the liquid. It is a FLIP solver: particles carry the
detail, a MAC grid carries the pressure, and the two are tied together every
frame in ten passes. Nothing in the pipeline is a random number or a
timing-dependent branch, so a bake reproduces frame for frame.

## The step

| # | pass | what it decides |
|---|------|-----------------|
| 1 | particles → grid | velocity and weight spread with hat kernels; six hats per particle, four faces |
| 2 | classify | a cell is liquid if it holds a particle **or** the kernels give it half a particle's worth of fill; then a hole fill pass |
| 3 | solid walls | the domain faces are zeroed, so nothing presses through the wall |
| 4 | gravity | applied per **face**, weighted by the liquid on each side - per cell would double-count every interior face |
| 5 | vorticity | curl at cell centres, `f = e·h·(N × ω)`, before the projection so the solve can make it incompressible |
| 6 | surface tension | curvature of the fill field, `f = σκ∇fill` |
| 7 | viscosity | implicit, damped Jacobi, sweep count follows the diffusion number |
| 8 | projection | `zeroBoundaryFaces()` again, then PCG with air `p = 0`, a warm start and a 1e-6 relative tolerance |
| 9 | grid → particles | FLIP/PIC blend, `flip_ratio` from the Liquid Preset |
| 10 | advect | RK2, substepped when the CFL number asks for it; then whitewater; then the walls |

## The numbers that matter

Measured on the 16 335-particle / 28³ probe, 300 frames at 1/60, node:

| | before | after |
|---|---|---|
| ms per frame | 33.1 | **10.8** |
| divergence after the solve | 2.2 (inverted) | **0.003** |
| a pool at rest | sank through its own holes | **holds its surface** |

The default workspace domain - a 1 m cube, 13 325 particles, a 16³ grid, four
particles per cell - runs at **4.6 ms per frame** for the solver and about 17 ms
for the 36³ surface mesh.

## The three rules this solver will not break

1. **Four particles per cell, minimum.** At one particle per cell a third of a
   lattice's interior classifies as air, the solve lets the column sink through
   the gaps, and the pool drains. The fill-based classification above rescues
   most of it; the budget is what actually fixes it.
2. **A hydrostatic column is the smooth part of the solution.** A loose PCG
   tolerance throws the smooth part away first, and a pool then leaks a fraction
   of a millimetre per frame. 1e-6, warm started.
3. **Gravity is a face quantity.** Per cell it is applied twice on every interior
   face and a body falls at 2g.

## What it costs and how to trade it

`FLIP_MAX_PARTICLES` (16 384 in `simulationCore.js`) sets the lattice, the cell
target follows the spacing, and the grid resolution follows that - so the solver
is always fed the cell size its particles imply. `Resolution` in the fluid panel
scales the lattice; `Surface Resolution` scales the mesh and is capped at 36³
inside the kernel.

## Tests

`tests/flip-liquid.test.mjs` pins the contract against the shipped artifact: a
pool at rest holds its surface within 5 cm over two seconds, a dam break leaves
under 2 % of the divergence it carried in, no particle leaves the box, gravity
moves a free body at g rather than 2g, and two identical runs produce identical
floats.
