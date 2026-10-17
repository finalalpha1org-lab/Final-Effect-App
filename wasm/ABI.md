# Simulation solver WASM ABI v2

This no-dependency Rust module supplies numerical kernels; rendering remains in Three.js. The caller allocates all arrays in exported linear memory and passes 32-bit byte offsets. Arrays must be aligned, in bounds, and non-overlapping. Coordinates/lengths use scene units, `dt` seconds, and positive gravity magnitude acts toward negative Y.

## Exports

- `sim_solver_abi_version() -> u32`: `2`.
- `sim_solver_deformable_step(positions, previous, rest, pinned, edges, restLengths, edgeWeights, nodeCount, edgeCount, dt, gravity, damping, stiffness, goalStrength, stretchResistance, compressionResistance, plasticity, collisionMargin, iterations, bounds, restitution, friction) -> i32`
  - Position/rest/previous arrays are interleaved `f32[nodeCount*3]`; `pinned` is `u8[nodeCount]`.
  - `edges` is `u32[edgeCount*2]`, with parallel `f32` rest-length and edge-weight arrays.
  - `bounds` is `[minX,minY,minZ,maxX,maxY,maxZ]`.
  - Uses Verlet integration and iterative distance constraints. Weighted structural/shear/bend constraints, separate stretch/compression stiffness, soft-body plasticity, damping and collision margin are solver inputs.
- `sim_solver_sph_step(positions, velocities, densities, pressures, forces, active, particleCount, dt, mass, restDensity, smoothingLength, pressureK, viscosity, surfaceTension, gravityX, gravityY, gravityZ, bounds, restitution, damping, outflow) -> i32`
  - Interleaved position/velocity/force arrays are `f32[particleCount*3]`; density/pressure arrays are `f32[particleCount]`; `active` is `u8[particleCount]`.
  - Computes 3D SPH density, pressure, viscosity, cohesion/surface-tension force, gravity, closed-box collisions, and optional open-boundary outflow. The v2 neighbor pass is O(n²); the app caps interactive domains at 512 particles.
- `sim_solver_buoyant_tracer_step(positions, velocities, temperatures, ages, particleCount, dt, gravity, buoyancy, drag, heatDecay, maxAge, bounds, restitution) -> i32`
  - A Lagrangian hot/smoke tracer model with buoyancy, drag, temperature loss, lifetime, and box collisions. It is not a full reacting-flow/Navier–Stokes solver.

Return values: `1` stepped, `0` zero/invalid `dt`, negative values indicate invalid array/count inputs. The browser wrapper reports errors and does not substitute sine-wave or static-cone motion. These are numerical approximations; PBR/volumetric appearance is a separate renderer concern and cannot guarantee photorealism or zero defects.
