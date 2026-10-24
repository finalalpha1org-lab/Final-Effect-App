/* SPDX-License-Identifier: GPL-3.0-or-later */

/* Render capture: what a rendered frame is allowed to contain.

   A viewport is an editor; a render is a photograph of the scene. Blender never
   renders its floor grid, 3D cursor, camera rig, light gizmo or transform
   widget, and an engine that does is simply broken — the grid is not part of
   the artwork, so there is no setting in the render dialog that could remove it
   afterwards. This module owns that rule in one place, so the EEVEE-style
   raster capture and the C++ path tracer agree on it, and so it can be tested
   without a GPU.

   It also owns the camera side of a capture. The viewport may crop the camera
   with `setViewOffset` (the "camera frame" box drawn over the viewport), and a
   render must clear that crop instead of inheriting it. A render that inherits
   the viewport crop comes out framed through the wrong lens — which is exactly
   what "the camera rig view renders wrong" looks like. */
(function (global) {
  'use strict';

  /* Names that mark an object as editor-only. Kept as data so a test asserts
     the rule rather than the implementation. */
  const HELPER_NAMES = ['ShadowFloor', 'StudioFloor', 'Cursor3D', 'SelectionOutlineHelper'];

  function isRenderHelper(object) {
    if (!object) return false;
    if (object.isGridHelper) return true;
    if (object.userData && object.userData.isEditorHelper) return true;
    return HELPER_NAMES.indexOf(object.name) !== -1;
  }

  /* The engine hands these over by reference. Some are groups whose visible
     children are the lines themselves (the camera rig, the light rig), so the
     parent is what gets hidden. */
  function helperRoots(engine) {
    if (!engine) return [];
    return [
      engine.grid, engine.cursor3d, engine.shadowFloor, engine.studioFloor,
      engine.blenderCam, engine.blenderCamLines, engine.blenderLight,
      engine.transformControls, engine.selectionBox
    ];
  }

  /* Hides every editor helper and returns exactly the objects it touched, so
     restore puts back the previous state and not "everything visible".

     `keep` exempts objects that are doing real work in this capture — the
     shadow catcher plane is a helper in the viewport but a *rendered* element
     when the render dialog asks for one. */
  function hideEditorHelpers(scene, engine, keep) {
    const hidden = [];
    /* Duck-typed on purpose: the engine and the tests may hand over a Set from
       another realm, where `instanceof Set` is false. */
    const skip = keep && typeof keep.has === 'function' ? keep : (Array.isArray(keep) ? new Set(keep) : null);
    const hide = (object) => {
      if (!object || object.visible === false) return;
      if (skip && skip.has(object)) return;
      object.visible = false;
      hidden.push(object);
    };
    helperRoots(engine).forEach(hide);
    if (scene && typeof scene.traverse === 'function') {
      scene.traverse((object) => { if (isRenderHelper(object)) hide(object); });
    }
    return hidden;
  }

  function restoreEditorHelpers(hidden) {
    if (!hidden) return 0;
    for (const object of hidden) object.visible = true;
    return hidden.length;
  }

  function withEditorHelpersHidden(scene, engine, run, keep) {
    const hidden = hideEditorHelpers(scene, engine, keep);
    try {
      return run();
    } finally {
      restoreEditorHelpers(hidden);
    }
  }

  /* "Scene Camera 1 Rig" means the authored camera. "Active Viewport View"
     means the camera the viewport is actually drawing with — which is the orbit
     camera normally, and the rig itself while camera view is active. Passing the
     active camera in keeps that promise; the two only differ outside camera
     view, where the distinction is the whole point of the menu. */
  function resolveRenderCamera(engine, source, activeCamera) {
    if (!engine) return null;
    const rig = engine.sceneCamera || null;
    const view = engine.viewportCamera || null;
    if (source === 'scene') return rig || view || activeCamera || null;
    return activeCamera || view || rig;
  }

  /* A render owns the camera for the length of the capture: the output aspect
     replaces the viewport aspect, and the viewport's view-offset crop is
     disabled. Everything it changed is returned so it can be handed back. */
  function prepareRenderCamera(camera, aspect) {
    if (!camera) return null;
    const saved = {
      aspect: camera.aspect,
      view: camera.view || null,
      viewEnabled: !!(camera.view && camera.view.enabled)
    };
    if (camera.view) camera.view.enabled = false;
    if (camera.isPerspectiveCamera && aspect > 0) camera.aspect = aspect;
    if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld(true);
    return saved;
  }

  function restoreRenderCamera(camera, saved) {
    if (!camera || !saved) return false;
    if (camera.isPerspectiveCamera && saved.aspect > 0) camera.aspect = saved.aspect;
    if (saved.view) saved.view.enabled = saved.viewEnabled;
    if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld(true);
    return true;
  }

  const api = {
    HELPER_NAMES,
    isRenderHelper,
    hideEditorHelpers,
    restoreEditorHelpers,
    withEditorHelpersHidden,
    resolveRenderCamera,
    prepareRenderCamera,
    restoreRenderCamera
  };

  global.FERenderCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
