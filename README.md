# Final Effect 3D — C++20 Core Engine + Cross-Platform Mobile & Desktop Creation Suite

**Final Effect 3D** is an all-in-one 3D, Animation, Sculpting, Landscape, Simulation, and Rendering suite designed for **mobile editors first** (Android & iOS touch workflows, 9:16 Reels/Shorts & 16:9 Cinema) while scaling cleanly to **Desktop & Web**.

## Architecture: C++20 Core Engine + Thin HTML/JS UI

All heavy numerical, animation, rendering, sculpting, and performance systems live in a **zero-dependency, freestanding C++20 Core Engine (`cpp/`)**, compiled to standalone WebAssembly (`wasm/fe_core_engine.wasm`, 0 imports, 48 C ABI exports) for Web/PWA/Capacitor and buildable natively via **CMake (`CMakeLists.txt`)** for Android NDK, iOS, Windows, macOS, and Linux:

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
- **Thin HTML/JS Presentation Layer (`index.html`, `fe-cpp-engine.js`, `Terrain_system_.html`)**:
  - Responsive Portrait & Landscape touch UI, installable offline-capable **PWA (`manifest.webmanifest`, `sw.js`)**, and **Capacitor (`capacitor.config.json`)** configuration for native Android/iOS packaging.

## Build & Test Commands

```bash
# Compile/validate C++20 WASM + run all 107 automated tests + build production bundle
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
