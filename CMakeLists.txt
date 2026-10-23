cmake_minimum_required(VERSION 3.16)
project(FinalEffectCoreEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(FE_CORE_SOURCES
  cpp/src/fe_wasm_exports.cpp
  cpp/src/fe_animation.cpp
  cpp/src/fe_renderer.cpp
  cpp/src/fe_sculpt_touch.cpp
  cpp/src/fe_simulation.cpp
  cpp/src/fe_landscape.cpp
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
endif()
