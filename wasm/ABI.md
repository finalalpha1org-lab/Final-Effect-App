# Simulation solver WASM ABI v1

This module is a numerical-kernel library, not a renderer. The caller owns all arrays in WebAssembly linear memory and passes 32-bit byte offsets. Every array must be correctly aligned, in bounds, and non-overlapping for the duration of a call. Coordinates and lengths use the scene's world units; `dt` is seconds; gravity is positive magnitude and acts along negative Y.

## Exports

- `sim_solver_abi_version() -> u32`: currently `1`.
- `sim_solver_deformable_step(positions, previous, rest, pinned, edges, restLengths, nodeCount, edgeCount, dt, gravity, damping, stiffness, goalStrength, iterations, bounds, restitution, friction) -> i32`
  - `positions`, `previous`, `rest`: `f32[nodeCount * 3]` (XYZ interleaved).
  - `pinned`: `u8[nodeCount]`, nonzero pins a node at its rest position.
  - `edges`: `u32[edgeCount * 2]`; `restLengths`: `f32[edgeCount]`.
  - `bounds`: `f32[6] = [minX,minY,minZ,maxX,maxY,maxZ]`.
  - Uses Verlet integration and iterative distance constraints; `goalStrength=0` is cloth-like, positive goal strength adds a soft-body return force.
- `sim_solver_sph_step(positions, velocities, densities, pressures, particleCount, dt, mass, restDensity, smoothingLength, pressureK, viscosity, gravityX, gravityY, gravityZ, bounds, restitution, damping) -> i32`
  - `positions`, `velocities`, `forces`: `f32[particleCount * 3]`; `densities`, `pressures`: `f32[particleCount]` scratch/output arrays. Force calculation is staged before integration so particles use a consistent frame snapshot.
  - Computes 3D SPH density, pressure, viscosity, gravity, and box collisions. This v1 kernel uses an O(n²) neighborhood pass and caps `particleCount` at 4096; production UI should keep counts much lower on mobile or replace the neighbor search with a spatial grid.
- `sim_solver_buoyant_tracer_step(positions, velocities, temperatures, ages, particleCount, dt, gravity, buoyancy, drag, heatDecay, maxAge, bounds, restitution) -> i32`
  - Uses Lagrangian tracer integration with buoyancy, drag, heat decay, lifetime, and box collisions. It is a particle transport approximation for smoke/fire, not a full reacting-flow or Navier–Stokes solver.

Return values: `1` stepped, `0` zero/invalid dt (no change), negative values indicate invalid lengths/counts/pointers. The browser wrapper must show failures rather than silently falling back to animated placeholder geometry.

## Build

`build-simulation-wasm.yml` runs host-side unit tests, compiles this no-dependency Rust source to `wasm32-unknown-unknown`, validates the WASM magic header, and commits both the binary and base64 transport copy. Build the browser artifact from source; do not hand-edit the generated `.wasm` or `.b64` files.

These are real numerical kernels, but they are still discretized approximations. Material/shader quality is a separate renderer concern; this ABI alone cannot guarantee photorealism or bug-free behavior.
