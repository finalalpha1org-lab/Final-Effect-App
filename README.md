# Final Effect 3D — C++20 Core Engine + Cross-Platform Mobile & Desktop Creation Suite

**Final Effect 3D** is an all-in-one 3D, Animation, Sculpting, Landscape, Simulation, and Rendering suite designed for **mobile editors first** (Android & iOS touch workflows, 9:16 Reels/Shorts & 16:9 Cinema) while scaling cleanly to **Desktop & Web**.

## Architecture: C++20 Core Engine + Thin HTML/JS UI

All heavy numerical, animation, rendering, sculpting, and performance systems live in a **zero-dependency, freestanding C++20 Core Engine (`cpp/`)**, compiled to standalone WebAssembly (`wasm/fe_core_engine.wasm`, 0 imports, 363 C ABI exports) for Web/PWA/Capacitor and buildable natively via **CMake (`CMakeLists.txt`)** for Android NDK, iOS, Windows, macOS, and Linux:

- **C++20 Keyframe Animation & Curve Engine (`cpp/src/fe_animation.cpp`)**:
  - 9-channel TRS tracks (`Loc X/Y/Z`, `Rot X/Y/Z`, `Scale X/Y/Z`) per scene object.
  - 6 interpolation modes (`Bezier Smooth`, `Linear`, `Step`, `Ease-In`, `Ease-Out`, `Bounce`) + `Hold`, `Loop Cycle`, and `Ping-Pong` extrapolation.
  - Procedural C++ motion clip generator (`Turntable 360°`, `Float Hover`, `Squash & Bounce`, `Pendulum`, `Cinema Orbit`, `Pulse Scale`) + compact binary float serialization inside `.final3d` project files.
- **C++20 Progressive BVH Path Tracer & Post-FX Engine (`cpp/src/fe_renderer.cpp`)**:
  - **FE Cycles (C++ BVH Path Tracer)**: SAH-style bounding volume hierarchy builder, Cook-Torrance GGX microfacet PBR BSDF, multi-bounce global illumination, soft sun shadow rays, studio shadow-catcher ground plane, and 5 procedural HDRI sky domes.
  - **FE Eevee + C++ Post-FX**: Real-time WebGL capture piped through C++ ACES Filmic / AgX / Uncharted 2 / Reinhard tone-mapping, C++ HDR bloom, chromatic aberration, vignette, color temperature, and film grain.
  - **Mobile & Cinema Aspect Ratios**: `9:16 Vertical (Reels/Shorts/TikTok)`, `16:9 Widescreen`, `1:1 Square`, and `21:9 Anamorphic`, with Still PNG & Timeline Video (`WebM` / `MP4`) sequence export.
- **C++20 Sculpt, Vertex Paint & Mobile Touch Governor (`cpp/src/fe_sculpt_touch.cpp`)**:
  - 6 real-time 3D sculpt brushes (`Draw/Clay`, `Smooth`, `Inflate`, `Pinch`, `Flatten`, `Grab`) with Mirror-X symmetry, vertex painting, and C++ area-weighted smooth normal recomputation.
  - C++ multi-touch gesture filter + adaptive frame-time governor (`Auto`, `Low`, `Medium`, `High` GPU tiers) that dynamically adjusts pixel ratio and shadow map budgets on mobile GPUs.
- **C++20 Edit Mode Kernel (`cpp/src/fe_editmesh.cpp`, `cpp/src/fe_editmesh_tools.cpp`)**: real vertex / edge / face editing — extrude, inset, subdivide, bevel, poke, duplicate, split, fill, bridge, merge, weld, collapse, bisect, symmetrize, loop select, proportional editing, snap, and a 48-step undo pool, all in C++ with a triangle-soup topology core. See `docs/EDIT-MODE.md`.
- **Thin HTML/JS Presentation Layer (`index.html`, `fe-cpp-engine.js`, `edit-mode.js`, `Terrain_system_.html`)**:
  - Responsive Portrait & Landscape touch UI, installable offline-capable **PWA (`manifest.webmanifest`, `sw.js`)**, and **Capacitor (`capacitor.config.json`)** configuration for native Android/iOS packaging.

## Build & Test Commands

```bash
# Compile/validate C++20 WASM + run all 505 automated tests + build production bundle
npm run build

# Run C++20 WASM + JS/Three.js test suite
npm test

# Rebuild wasm/fe_core_engine.wasm directly (uses Clang / Zig C++20 toolchain when installed)
npm run build:cpp

# Start local preview server on 0.0.0.0:3000
npm run preview
```

## Native CMake Build (Desktop / Android NDK / iOS)

```bash
cmake -B build-native -DFE_BUILD_TESTS=ON
cmake --build build-native --config Release
ctest --test-dir build-native --output-on-failure
```

## Licence

**GPL-3.0-or-later.** Final Effect 3D is free software: you can redistribute it
and/or modify it under the terms of the GNU General Public License as published
by the Free Software Foundation, either version 3 of the License, or (at your
option) any later version. See `LICENSE` for the full text and `NOTICE` for the
third-party components that ship with it.

The project was CC0-1.0 until 2026-10-24. It changed because the components
worth reusing from Blender — the render engines, the shader node system — are
GPL, and a permissive-licence project cannot take them. Releases published
before that date remain CC0-1.0; nothing can withdraw a licence already given.
`docs/LICENSING.md` records the component-by-component rules, including what the
change unlocks and what it still cannot.
