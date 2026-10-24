cmake_minimum_required(VERSION 3.16)
project(FinalEffectCoreEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(FE_CORE_SOURCES
  cpp/src/fe_wasm_exports.cpp
  cpp/src/fe_heap.cpp
  cpp/src/fe_animation.cpp
  cpp/src/fe_renderer.cpp
  cpp/src/fe_sculpt_touch.cpp
  cpp/src/fe_simulation.cpp
  cpp/src/fe_landscape.cpp
  cpp/src/fe_openworld.cpp
  cpp/src/fe_ocean.cpp
  cpp/src/fe_volumetrics.cpp
  cpp/src/fe_modifiers.cpp
  cpp/src/fe_surface.cpp
  cpp/src/fe_flora.cpp
  cpp/src/fe_climate.cpp
  cpp/src/fe_lod.cpp
  cpp/src/fe_impostor.cpp
  # Edit Mode. Keep this list identical to CPP_SOURCES in
  # scripts/build-cpp-wasm.mjs; a source that only exists in one of the two
  # builds is a kernel that ships in the browser but never gets a native test.
  cpp/src/fe_editmesh.cpp
  cpp/src/fe_editmesh_tools.cpp
)

if(EMSCRIPTEN)
  add_executable(fe_core_engine ${FE_CORE_SOURCES})
  target_include_directories(fe_core_engine PRIVATE cpp/include)
  set_target_properties(fe_core_engine PROPERTIES SUFFIX ".wasm")
  target_link_options(fe_core_engine PRIVATE
    "-sSTANDALONE_WASM=1"
    "--no-entry"
    "-Wl,--export-dynamic"
    "-Wl,--export-memory"
  )
else()
  add_library(fe_core_engine STATIC ${FE_CORE_SOURCES})
  target_include_directories(fe_core_engine PUBLIC cpp/include)

  enable_testing()
  add_executable(fe_core_tests cpp/tests/fe_core_tests.cpp)
  target_link_libraries(fe_core_tests PRIVATE fe_core_engine)
  add_test(NAME fe_core_tests COMMAND fe_core_tests)

  add_executable(fe_editmesh_tests cpp/tests/fe_editmesh_tests.cpp)
  target_link_libraries(fe_editmesh_tests PRIVATE fe_core_engine)
  add_test(NAME fe_editmesh_tests COMMAND fe_editmesh_tests)
endif()
