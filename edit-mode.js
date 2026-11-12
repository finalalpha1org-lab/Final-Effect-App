/* ===========================================================================
 * edit-mode.js — Edit Mode: the app's own tools, driving the C++ kernel.
 * ---------------------------------------------------------------------------
 * Every topology change happens in `fe_edit_*` (cpp/src/fe_editmesh*.cpp).
 * This file is the bridge and the UI, nothing else:
 *
 *   upload    the active object's triangles once, when the mode is entered
 *   gesture   pointer events -> pick / box / circle / move / rotate / scale
 *   display   kernel render mesh -> the THREE geometry the viewport draws
 *   overlay   vertex dots, wireframe and selected faces, drawn from the kernel
 *   sheet     a left-to-right category bar; each category opens its sub-toolbar
 *
 * There is no Blender panel here. The order of operations is the same because
 * sculpting vertices needs the same primitives everywhere, but the UI is this
 * app's bottom-sheet language, and no command exists unless the kernel has it.
 * ========================================================================= */
(function (global) {
  'use strict';

  const MODES = {
    vertex: { id: 'vertex', kind: 0, label: 'Vertices' },
    edge: { id: 'edge', kind: 1, label: 'Edges' },
    face: { id: 'face', kind: 2, label: 'Faces' }
  };

  /* Left-to-right bar. Each entry opens its own sub-toolbar in the sheet. */
  const CATEGORIES = [
    { id: 'select', label: 'Select', icon: 'select-box' },
    { id: 'transform', label: 'Transform', icon: 'move' },
    { id: 'mesh', label: 'Mesh', icon: 'extrude' },
    { id: 'normals', label: 'Shading', icon: 'normal' }
  ];

  /* Every tool maps to a kernel entry point. `amount` describes the slider the
     sheet shows; `gesture` marks tools that own the one-finger drag. */
  const TOOLS = [
    { id: 'pick', cat: 'select', label: 'Select', icon: 'select-box', hint: 'Tap a vertex, edge or face' },
    { id: 'box', cat: 'select', label: 'Box', icon: 'select-box', gesture: true, hint: 'Drag a rectangle' },
    { id: 'circle', cat: 'select', label: 'Circle', icon: 'select-circle', gesture: true, hint: 'Drag to paint a selection', amount: { key: 'radius', label: 'Radius', min: 2, max: 40, step: 1, value: 12, unit: '%' } },
    { id: 'all', cat: 'select', label: 'All', icon: 'check' },
    { id: 'none', cat: 'select', label: 'None', icon: 'close' },
    { id: 'invert', cat: 'select', label: 'Invert', icon: 'refresh' },
    { id: 'linked', cat: 'select', label: 'Linked', icon: 'link', needsSelection: true },
    { id: 'more', cat: 'select', label: 'Expand', icon: 'plus', needsSelection: true },
    { id: 'less', cat: 'select', label: 'Shrink', icon: 'minus', needsSelection: true },
    { id: 'similar', cat: 'select', label: 'Similar', icon: 'shape', needsSelection: true },
    { id: 'random', cat: 'select', label: 'Random', icon: 'dice', amount: { key: 'percent', label: 'Percent', min: 1, max: 100, step: 1, value: 25, unit: '%' } },
    { id: 'loop', cat: 'select', label: 'Edge Loop', icon: 'loop', needsSelection: true, hint: 'Select an edge first' },

    { id: 'move', cat: 'transform', label: 'Move', icon: 'move', gesture: true, needsSelection: true, hint: 'Drag to move along the locked axes' },
    { id: 'rotate', cat: 'transform', label: 'Rotate', icon: 'rotate', gesture: true, needsSelection: true, hint: 'Drag sideways to turn' },
    { id: 'scale', cat: 'transform', label: 'Scale', icon: 'scale', gesture: true, needsSelection: true, hint: 'Drag sideways to scale' },
    { id: 'shrink', cat: 'transform', label: 'Shrink / Fatten', icon: 'expand', needsSelection: true, amount: { key: 'amount', label: 'Amount', min: -0.5, max: 0.5, step: 0.01, value: 0.05 } },
    { id: 'slide', cat: 'transform', label: 'Slide', icon: 'slide', needsSelection: true, amount: { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.05, value: 0.25 } },
    { id: 'shear', cat: 'transform', label: 'Shear', icon: 'shear', needsSelection: true, amount: { key: 'amount', label: 'Amount', min: -1, max: 1, step: 0.05, value: 0.2 } },
    { id: 'sphere', cat: 'transform', label: 'To Sphere', icon: 'sphere', needsSelection: true, amount: { key: 'factor', label: 'Factor', min: 0, max: 1, step: 0.05, value: 0.5 } },
    { id: 'bend', cat: 'transform', label: 'Bend', icon: 'bend', needsSelection: true, amount: { key: 'angle', label: 'Angle', min: -90, max: 90, step: 1, value: 25, unit: '°' } },
    { id: 'randomize', cat: 'transform', label: 'Randomize', icon: 'dice', needsSelection: true, amount: { key: 'amount', label: 'Amount', min: 0, max: 0.5, step: 0.005, value: 0.02 } },
    { id: 'align', cat: 'transform', label: 'Align', icon: 'align', needsSelection: true },
    { id: 'mirror', cat: 'transform', label: 'Mirror', icon: 'flip', amount: { key: 'axis', label: 'Axis', min: 0, max: 2, step: 1, value: 0, axis: true } },
    { id: 'exact', cat: 'transform', label: 'Exact…', icon: 'hash', needsSelection: true, hint: 'Type a value' },

    { id: 'extrude', cat: 'mesh', label: 'Extrude', icon: 'extrude', needsSelection: true, amount: { key: 'distance', label: 'Distance', min: -1, max: 1, step: 0.01, value: 0.2 } },
    { id: 'inset', cat: 'mesh', label: 'Inset', icon: 'inset', needsSelection: true, amount: { key: 'thickness', label: 'Thickness', min: 0.01, max: 0.5, step: 0.01, value: 0.1 } },
    { id: 'subdivide', cat: 'mesh', label: 'Subdivide', icon: 'grid', needsSelection: true },
    { id: 'bevel', cat: 'mesh', label: 'Bevel', icon: 'bevel', needsSelection: true, amount: { key: 'width', label: 'Width', min: 0.01, max: 0.3, step: 0.01, value: 0.05 } },
    { id: 'poke', cat: 'mesh', label: 'Poke', icon: 'poke', needsSelection: true },
    { id: 'duplicate', cat: 'mesh', label: 'Duplicate', icon: 'copy', needsSelection: true },
    { id: 'split', cat: 'mesh', label: 'Split', icon: 'split', needsSelection: true },
    { id: 'fill', cat: 'mesh', label: 'Fill', icon: 'fill', needsSelection: true },
    { id: 'bridge', cat: 'mesh', label: 'Bridge', icon: 'bridge', needsSelection: true },
    { id: 'merge', cat: 'mesh', label: 'Merge', icon: 'merge', needsSelection: true },
    { id: 'weld', cat: 'mesh', label: 'Weld', icon: 'weld', needsSelection: true, amount: { key: 'distance', label: 'Distance', min: 0.001, max: 0.2, step: 0.001, value: 0.01 } },
    { id: 'collapse', cat: 'mesh', label: 'Collapse', icon: 'collapse', needsSelection: true },
    { id: 'bisect', cat: 'mesh', label: 'Bisect', icon: 'bisect', amount: { key: 'axis', label: 'Axis', min: 0, max: 2, step: 1, value: 0, axis: true } },
    { id: 'symmetrize', cat: 'mesh', label: 'Symmetrize', icon: 'mirror', amount: { key: 'axis', label: 'Axis', min: 0, max: 2, step: 1, value: 0, axis: true } },
    { id: 'delete', cat: 'mesh', label: 'Delete', icon: 'trash', needsSelection: true },

    { id: 'recalc', cat: 'normals', label: 'Recalc Outside', icon: 'normal' },
    { id: 'flip', cat: 'normals', label: 'Flip Faces', icon: 'flip', needsSelection: true },
    /* The shading is a flag per face, not a switch for the object: with faces
       taken in Face mode these two apply to those faces and leave the rest of
       the model alone, which is how a cylinder gets round sides and flat caps. */
    { id: 'smooth', cat: 'normals', label: 'Shade Smooth', icon: 'smooth', hint: 'Smooth the chosen faces, or the whole mesh' },
    { id: 'flat', cat: 'normals', label: 'Shade Flat', icon: 'flat', hint: 'Hold the chosen faces flat, or the whole mesh' },
    { id: 'sharp', cat: 'normals', label: 'Mark Sharp', icon: 'sharp', needsSelection: true },
    { id: 'seam', cat: 'normals', label: 'Mark Seam', icon: 'seam', needsSelection: true }
  ];

  const BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

  const state = {
    active: false,
    /* The wireframe's line list, kept between frames (see refreshOverlay). */
    ringSegments: null,
    ringStamp: '',
    mode: 'vertex',
    tool: 'pick',
    category: 'select',
    xray: true,
    snap: false,
    propEnabled: false,
    propFalloff: 2,
    propRadius: 1,
    axis: 0,
    amount: {},
    target: null,
    overlay: null,
    view: null,
    drag: null,
    pointerId: null
  };
  for (const tool of TOOLS) {
    if (tool.amount) state.amount[tool.id] = tool.amount.value;
  }

  /* ---- small utilities -------------------------------------------------- */

  /* The studio markup ships as a <template> that is cloned once per studio, so
     `document.getElementById('edit-sheet')` can return a hidden copy belonging
     to another studio. Every lookup goes through the active screen first, the
     same way the rest of the app's panels do. */
  function byId(id) {
    if (typeof document === 'undefined') return null;
    const studio = global.FE?.current;
    const screen = studio ? document.getElementById('studio-' + studio) : null;
    return screen?.querySelector('#' + id) || document.getElementById(id);
  }

  function activeToolbar() {
    if (typeof document === 'undefined') return null;
    const studio = global.FE?.current || 'core';
    return document.getElementById('toolbar-' + studio) || null;
  }
  /* The point / edge / face switch. It is its own row above the tools of the
     Select category, because it is the one control that decides what *every*
     tap, box and circle in this mode can touch; the buttons are the shipped
     markup in index.html, so there is exactly one set of them. */
  function modeRow() { return byId('edit-mode-row'); }
  function modeButtons() {
    const row = modeRow();
    if (row) return Array.from(row.querySelectorAll('[data-edit-mode]'));
    const bar = byId('edit-category-bar');
    return bar ? Array.from(bar.querySelectorAll('[data-edit-mode]')) : [];
  }

  /* Something has to hold the object-mode helpers down for the length of the
     session: the engine attaches its TransformControls whenever a Move / Rotate
     / Scale panel opens or the selection changes, and three.js shows the gizmo
     inside `attach()`. That gizmo is a whole-object transform control with long
     axis lines running through the model, and those lines drawn across a face
     are easily mistaken for a triangle that will not go away. The cage's own
     gizmo is a different object (`EditGizmo`), so this one is not needed while
     the mode runs. */
  let helperGuardRAF = 0;
  let helperGuardFrames = 0;

  function startHelperGuard() {
    stopHelperGuard();
    if (typeof global.requestAnimationFrame !== 'function') return;
    const tick = () => {
      if (!state.active) { helperGuardRAF = 0; return; }
      const eng = core();
      const controls = eng?.transformControls;
      if (controls && controls.visible) controls.visible = false;
      if ((++helperGuardFrames % 20) === 0) removeSelectionOutlines(state.target);
      helperGuardRAF = global.requestAnimationFrame(tick);
    };
    helperGuardRAF = global.requestAnimationFrame(tick);
  }

  function stopHelperGuard() {
    if (helperGuardRAF && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(helperGuardRAF);
    helperGuardRAF = 0;
    helperGuardFrames = 0;
  }

  function engine() { return global.FECppEngine; }

  /* Take every selection outline off the object being edited. The app attaches
     one from `applyMeshSelectionOutline`, and it is an EdgesGeometry snapshot:
     it describes the shape the object had when it was selected, while the cage
     under the finger moves with every drag - which is what "the wireframe came
     away from the object" looks like. The mode draws its own wireframe from the
     cage, so the outline is taken out for the session (removed rather than
     hidden: the app re-applies it from its own paths) and exit rebuilds it from
     the cage that was committed. */
  function removeSelectionOutlines(object) {
    const host = object || state.target;
    if (!host) return;
    const doomed = [];
    host.traverse?.((child) => { if (child && child.name === 'SelectionOutlineHelper') doomed.push(child); });
    for (const helper of doomed) {
      helper.parent?.remove?.(helper);
      helper.geometry?.dispose?.();
      helper.material?.dispose?.();
    }
    const eng = core();
    if (eng && eng.selectionBox && doomed.includes(eng.selectionBox)) eng.selectionBox = null;
  }
  function core() { return global.FE?.engines?.core || null; }
  function T() { return global.THREE; }
  function toast(message) { global.FE?.toast?.(message); }
  function fmt(value, digits = 2) { return Number(value).toFixed(digits); }

  function exportsOf() {
    const eng = engine();
    if (!eng || !eng.ready || !eng.exports) return null;
    return eng.exports;
  }

  function memory() { return engine().memory.buffer; }
  function f32(ptr, length) { return new Float32Array(memory(), ptr, length); }
  function u32(ptr, length) { return new Uint32Array(memory(), ptr, length); }
  function u8(ptr, length) { return new Uint8Array(memory(), ptr, length); }

  /* The kernel has no allocator of its own: it borrows the wasm scratch arena
     for the duration of a call. Every helper below resets the arena first, so a
     long session cannot creep the offset up one upload at a time. */
  function withArena(names, build) {
    const exp = exportsOf();
    if (!exp) return null;
    exp.fe_arena_reset();
    try { return build(exp); } finally { exp.fe_arena_reset(); }
  }

  function copyIn(exp, array, Ctor) {
    const bytes = array.byteLength;
    const ptr = exp.fe_malloc(bytes);
    if (!ptr) return 0;
    new Ctor(memory(), ptr, array.length).set(array);
    return ptr;
  }

  /* ---- the object being edited ------------------------------------------ */

  function activeObject() {
    const object = global.getActiveObjectMesh ? global.getActiveObjectMesh() : null;
    if (!object || !object.isMesh || !object.geometry?.attributes?.position) return null;
    if (!object.parent) return null;
    return object;
  }

  function upload(object) {
    const exp = exportsOf();
    if (!exp || !object) return false;
    /* A modifier stack replaces `object.geometry` with its *evaluated* output,
       so editing that mesh and committing it would feed the deformity back
       into itself - a Cast or Lattice would be applied twice - and the stack
       would go on rebuilding from a cage that no longer matches what was
       edited. Edit the cage the stack is built from, as Blender does; `enter`
       puts that cage on screen for the duration so the overlay lines up with
       the surface under the finger.

       `feEditCage` is the same idea for objects with no stack: it is the
       unsplit mesh the editor last committed, kept beside the object because
       `object.geometry` holds the *display* mesh whenever the shading had to
       be baked into split normals (any flat or mixed mesh). That display mesh
       has been renumbered and split, so the face rings stashed on it would
       name the wrong triangles - and without rings the kernel has to re-guess
       the faces from a shape the user has since deformed, which is how a quad
       comes back as two triangles with a diagonal across it. */
    const cage = (object.userData?.feEditCage && object.userData.feEditCage.attributes?.position)
      ? object.userData.feEditCage
      : object.userData?.baseGeometry;
    const geometry = (cage && cage.attributes?.position) ? cage : object.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const vertCount = position.count;
    const triCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    const limit = exp.fe_edit_max_verts();

    if (vertCount > limit) {
      toast(`${vertCount.toLocaleString()} vertices is above the ${limit.toLocaleString()} this editor handles. Split the mesh to edit it.`);
      return false;
    }
    if (triCount < 1) { toast('This object has no faces to edit.'); return false; }

    const positions = new Float32Array(vertCount * 3);
    positions.set(position.array.subarray(0, vertCount * 3));
    const triangles = new Uint32Array(triCount * 3);
    if (index) {
      triangles.set(index.array.subarray(0, triCount * 3));
    } else {
      for (let i = 0; i < triangles.length; i++) triangles[i] = i;
    }
    const colour = geometry.attributes.color;
    const colours = colour ? new Float32Array(vertCount * 3) : null;
    if (colours) colours.set(colour.array.subarray(0, vertCount * 3));

    /* The viewport hands over three.js geometry, where a cube arrives as 24
       split corners. The kernel welds them back into 8 shared vertices, so the
       editor sees the surface the modeller meant: 8 points, 12 edges, 6 quads.
       Normals travel too, only so the kernel can tell a hard surface from a
       smooth one before the split is gone. */
    const normal = geometry.attributes.normal;
    const normals = normal ? new Float32Array(normal.array.subarray(0, vertCount * 3)) : null;

    /* The shading this mesh already carries, if it was written down. A cage has
       shared vertices and averaged normals, so nothing can be read back off it;
       the flags are kept beside the geometry instead, one byte per triangle. */
    const stored = geometry.userData?.feFaceShading;
    const flags = (stored && stored.length === triCount) ? stored : null;

    return withArena(null, (exp2) => {
      const posPtr = copyIn(exp2, positions, Float32Array);
      const triPtr = copyIn(exp2, triangles, Uint32Array);
      const colPtr = colours ? copyIn(exp2, colours, Float32Array) : 0;
      const flagPtr = flags ? copyIn(exp2, new Uint8Array(flags), Uint8Array) : 0;
      /* Normals go in with the mesh so the kernel can tell a hard surface from
         a smooth one in the same pass that welds the shared vertices - it is
         the only moment the split corners still exist. */
      const nrmPtr = normals ? copyIn(exp2, normals, Float32Array) : 0;
      if (!posPtr || !triPtr) { toast('The engine could not reserve memory for this mesh.'); return false; }
      if (exp2.fe_edit_upload(vertCount, posPtr, triCount, triPtr, colPtr, nrmPtr) !== 1) return false;
      /* Written flags beat the guess: a genuinely flat face and a smooth face
         that happens to lie flat in a coarse mesh look identical from normals
         alone, but only one of them should merge with its neighbours. */
      if (flagPtr && typeof exp2.fe_edit_upload_face_shade === 'function') {
        exp2.fe_edit_upload_face_shade(flagPtr, triCount);
      }
      /* The faces the mesh arrived with - a cylinder cap is one thirty-two-gon
         face in Blender and a fan of triangles in the buffer - in the
         geometry's own vertex numbering. The kernel welds the mesh and maps
         the rings through the weld. */
      declareFaces(exp2, geometry, vertCount);
      return true;
    }) === true;
  }

  /* ---- kernel -> viewport ----------------------------------------------- */

  /* The kernel writes one render mesh with split normals. The viewport draws
     that, because it is the only version whose shading matches the exported
     file. On exit the canonical mesh (shared vertices) goes back into the
     object so physics, export and the scene registry all see the edit. */
  const view = {
    capacity: 0,
    position: null, normal: null, colour: null, index: null,
    geometry: null
  };

  function growView(vertexCount, indexCount) {
    const THREE = T();
    if (!THREE) return false;
    if (view.capacity >= vertexCount && view.index && view.index.length >= indexCount) return true;
    const previous = view.geometry;
    const capacity = Math.max(vertexCount, view.capacity * 2, 256);
    const indices = Math.max(indexCount, view.index ? view.index.length : 0, 256);
    view.capacity = capacity;
    view.position = new Float32Array(capacity * 3);
    view.normal = new Float32Array(capacity * 3);
    view.colour = new Float32Array(capacity * 3);
    view.index = new Uint32Array(indices);
    const geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(view.position, 3).setUsage(THREE.DynamicDrawUsage);
    const normalAttr = new THREE.BufferAttribute(view.normal, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('normal', normalAttr);
    geometry.setIndex(new THREE.BufferAttribute(view.index, 1).setUsage(THREE.DynamicDrawUsage));
    view.geometry = geometry;
    if (state.target) state.target.geometry = geometry;
    /* The display geometry is disposable: the canonical mesh lives in the
       kernel, so dropping the old buffers cannot lose an edit. */
    if (previous && previous !== geometry) previous.dispose?.();
    return true;
  }

  /* Repair render normals the kernel handed over that cannot be used: not a
     number, not a direction (zero length), not unit length, or pointing the
     opposite way from every face at that vertex. Each one is replaced by the
     average of the faces it actually belongs to. Returns how many were rebuilt,
     which is what tells a dark patch caused by a bad normal from a dark patch
     caused by something else. */
  function sanitizeRenderNormals(target, vertexCount, indexCount) {
    const geometry = target.geometry;
    const indexAttr = geometry && geometry.index;
    const normalAttr = geometry && geometry.attributes && geometry.attributes.normal;
    const positionAttr = geometry && geometry.attributes && geometry.attributes.position;
    if (!indexAttr || !normalAttr || !positionAttr) return 0;
    const position = positionAttr.array;
    const normal = normalAttr.array;
    const indices = indexAttr.array;
    /* The attribute counts are only updated after this runs, so the live counts
       come from the kernel: scanning the stale tail would flag leftovers that
       are never drawn. */
    vertexCount = Math.min(vertexCount, Math.floor(position.length / 3), Math.floor(normal.length / 3));
    const triangleCount = Math.min(Math.floor(indexCount / 3), Math.floor(indices.length / 3));
    if (!vertexCount || !triangleCount) return 0;

    const flagged = [];
    const isBad = new Uint8Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
      const x = normal[v * 3], y = normal[v * 3 + 1], z = normal[v * 3 + 2];
      const length = Math.hypot(x, y, z);
      if (!Number.isFinite(length) || length < 1e-6 || length > 4) {
        isBad[v] = 1;
        flagged.push(v);
      }
    }
    if (!flagged.length) return 0;

    const summed = new Map();
    for (let t = 0; t < triangleCount; t++) {
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      if (!isBad[a] && !isBad[b] && !isBad[c]) continue;
      const ax = position[a * 3], ay = position[a * 3 + 1], az = position[a * 3 + 2];
      const ux = position[b * 3] - ax, uy = position[b * 3 + 1] - ay, uz = position[b * 3 + 2] - az;
      const vx = position[c * 3] - ax, vy = position[c * 3 + 1] - ay, vz = position[c * 3 + 2] - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (!(length > 1e-12)) continue;
      nx /= length; ny /= length; nz /= length;
      for (const v of [a, b, c]) {
        if (!isBad[v]) continue;
        const record = summed.get(v) || [0, 0, 0];
        record[0] += nx; record[1] += ny; record[2] += nz;
        summed.set(v, record);
      }
    }

    let repaired = 0;
    for (const v of flagged) {
      const record = summed.get(v);
      let x = record ? record[0] : 0;
      let y = record ? record[1] : 0;
      let z = record ? record[2] : 0;
      let length = Math.hypot(x, y, z);
      if (!(length > 1e-6)) {
        x = normal[v * 3]; y = normal[v * 3 + 1]; z = normal[v * 3 + 2];
        length = Math.hypot(x, y, z);
      }
      if (!(length > 1e-6)) { x = 0; y = 1; z = 0; length = 1; }
      normal[v * 3] = x / length;
      normal[v * 3 + 1] = y / length;
      normal[v * 3 + 2] = z / length;
      repaired++;
    }
    normalAttr.needsUpdate = true;
    return repaired;
  }

  function syncViewport() {    const exp = exportsOf();
    const target = state.target;
    if (!exp || !target) return;
    const vertexCount = exp.fe_edit_render_vert_count();
    const indexCount = exp.fe_edit_render_idx_count();
    if (!vertexCount || !indexCount) return;

    growView(vertexCount, indexCount);
    const geometry = view.geometry;
    if (target.geometry !== geometry) target.geometry = geometry;

    view.position.set(f32(exp.fe_edit_render_pos_ptr(), vertexCount * 3));
    view.normal.set(f32(exp.fe_edit_render_nrm_ptr(), vertexCount * 3));
    /* Shade Smooth asks the kernel for smoothed vertex normals, and a smoothed
       normal is an average: if even one of the faces at a vertex has no direction
       of its own - a zero-area triangle from a Boolean cut or a collapsed edge,
       which every model picks up sooner or later - averaging it in poisons that
       vertex and everything sharing it, and the surface goes black. Flat shading
       never reads these normals, so the mesh only misbehaves after Shade Smooth.
       Anything not finite, not unit length, or pointing away from the faces it
       belongs to is rebuilt here from those faces, in render space, so no mapping
       back to the edit mesh is needed. */
    state.normalsRepaired = sanitizeRenderNormals(view, vertexCount, indexCount);
    /* Say it out loud once: a mesh whose smoothed normals had to be rebuilt is a
       mesh with degenerate faces (a Boolean cut, a collapsed edge), and knowing
       the count is what separates "Shade Smooth broke my object" from "the
       object was already like that". */
    if (state.normalsRepaired > 0 && state.normalsRepaired !== state.lastRepairNotice) {
      state.lastRepairNotice = state.normalsRepaired;
      toast('Shade Smooth: rebuilt ' + state.normalsRepaired + ' broken normal' + (state.normalsRepaired === 1 ? '' : 's'));
    } else if (state.normalsRepaired === 0) {
      state.lastRepairNotice = 0;
    }
    view.index.set(u32(exp.fe_edit_render_idx_ptr(), indexCount));

    geometry.attributes.position.count = vertexCount;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.count = vertexCount;
    geometry.attributes.normal.needsUpdate = true;
    geometry.index.count = indexCount;
    geometry.index.needsUpdate = true;
    geometry.setDrawRange(0, indexCount);

    if (exp.fe_edit_has_color()) {
      view.colour.set(f32(exp.fe_edit_render_col_ptr(), vertexCount * 3));
      if (!geometry.attributes.color) {
        geometry.setAttribute('color', new THREE.BufferAttribute(view.colour, 3).setUsage(THREE.DynamicDrawUsage));
      } else {
        geometry.attributes.color.count = vertexCount;
        geometry.attributes.color.needsUpdate = true;
      }
    }

    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  }

  /* The kernel's quad pairing, written onto the committed geometry as vertex
     index pairs. The mesh the kernel hands back uses the kernel's own vertex
     indices, which is exactly the numbering a later upload of it will use
     again, so a pairing recorded here stays true - and it has to be recorded,
     because it cannot be recovered from a shape that has since been bent: the
     shell's Wireframe shading reads this in Object Mode (see
     feBuildQuadWireGeometry) and without it a quad that the editor bent grew a
     triangle back down the middle of the face. Plain array on purpose: three's
     clone() round-trips userData through JSON. */
  /* The faces a mesh was built with, handed to the kernel. The rings are in the
     geometry's own vertex slots and the kernel maps them through its weld, so a
     ring may name any of the three copies three.js gives a shared point. A mesh
     that declares nothing leaves the kernel to its own reading of the shape. */
  function declareFaces(exp, geometry, vertCount) {
    if (typeof exp.fe_edit_set_faces !== 'function') return;
    const rings = geometry && geometry.userData && geometry.userData.feFaces;
    if (!Array.isArray(rings) || !rings.length) return;
    if (geometry.userData.feFaceVerts !== vertCount) return;
    let total = 0;
    for (const ring of rings) if (Array.isArray(ring)) total += ring.length;
    if (total < 3) return;
    const starts = new Uint32Array(rings.length + 1);
    const corners = new Uint32Array(total);
    let at = 0;
    for (let f = 0; f < rings.length; f++) {
      starts[f] = at;
      const ring = rings[f];
      if (!Array.isArray(ring)) continue;
      for (const slot of ring) if (at < corners.length) corners[at++] = slot;
    }
    starts[rings.length] = at;
    try {
      const startsPtr = copyIn(exp, starts, Uint32Array);
      const cornersPtr = copyIn(exp, corners, Uint32Array);
      if (startsPtr && cornersPtr) exp.fe_edit_set_faces(rings.length, startsPtr, cornersPtr);
    } catch (_) { /* no declared faces is a fallback, not a failure */ }
  }

  function stashQuadDiagonals(geometry) {
    const exp = exportsOf();
    const position = geometry?.attributes?.position;
    if (!geometry || !position || !exp || typeof exp.fe_edit_quad_pairs_ptr !== 'function') return;
    const data = geometry.userData || (geometry.userData = {});
    try {
      const pointer = exp.fe_edit_quad_pairs_ptr();
      const count = exp.fe_edit_quad_pair_count();
      if (!count) {
        delete data.feQuadDiagonals;
        delete data.feQuadDiagonalVerts;
        return;
      }
      data.feQuadDiagonals = Array.from(u32(pointer, count * 2));
      data.feQuadDiagonalVerts = position.count;
    } catch (_) { /* a missing pairing only costs a nicer wireframe */ }
  }

  /* The faces themselves, written onto the committed geometry the same way and
     for the same reason: the wireframe draws one line per face boundary, an
     n-gon cap has no spokes, and a re-entry into Edit Mode hands the mesh back
     with the faces it was drawn with instead of re-deriving them from a shape
     that may since have been bent. */
  function stashFaces(geometry) {
    const exp = exportsOf();
    const position = geometry?.attributes?.position;
    if (!geometry || !position || !exp) return;
    if (typeof exp.fe_edit_face_count !== 'function' || typeof exp.fe_edit_face_start_ptr !== 'function') return;
    const data = geometry.userData || (geometry.userData = {});
    try {
      const count = exp.fe_edit_face_count();
      if (!count) {
        delete data.feFaces;
        delete data.feFaceVerts;
        return;
      }
      const starts = u32(exp.fe_edit_face_start_ptr(), count + 1);
      const ringCount = exp.fe_edit_face_ring_count();
      const ring = u32(exp.fe_edit_face_ring_ptr(), ringCount);
      const faces = [];
      for (let f = 0; f < count; f++) {
        const from = starts[f], to = starts[f + 1];
        if (to - from < 3 || to > ringCount) continue;
        faces.push(Array.from(ring.subarray(from, to)));
      }
      if (faces.length) {
        data.feFaces = faces;
        data.feFaceVerts = position.count;
      } else {
        delete data.feFaces;
        delete data.feFaceVerts;
      }
    } catch (_) { /* the shell redraws from the shape if the table is missing */ }
  }

  /* The rings, moved from the cage onto the split mesh the viewport draws.
     Both describe the same points - the split pass copies a corner's position
     once per smoothing group and never moves anything - so a ring translates
     through a position lookup, and any copy of a point draws the same line.
     Without this the Object Mode wireframe had no faces to draw for a flat or
     mixed mesh (its rings lived on a cage the object no longer held), fell back
     to inferring quads from the shape, and a face the user had dragged into a
     bent quad grew its diagonal back in Wireframe shading. */
  function transferFacesToDisplay(display, cage) {
    const rings = cage?.userData?.feFaces;
    const source = cage?.attributes?.position;
    const target = display?.attributes?.position;
    if (!Array.isArray(rings) || !rings.length || !source || !target) return;
    if (cage.userData.feFaceVerts !== source.count) return;
    const at = new Map();
    for (let i = 0; i < target.count; i++) {
      const key = `${target.array[i * 3]},${target.array[i * 3 + 1]},${target.array[i * 3 + 2]}`;
      if (!at.has(key)) at.set(key, i);
    }
    const moved = [];
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const out = [];
      let ok = true;
      for (const slot of ring) {
        if (!(slot >= 0 && slot < source.count)) { ok = false; break; }
        const key = `${source.array[slot * 3]},${source.array[slot * 3 + 1]},${source.array[slot * 3 + 2]}`;
        const hit = at.get(key);
        if (hit === undefined) { ok = false; break; }
        out.push(hit);
      }
      if (ok && out.length >= 3) moved.push(out);
    }
    if (!moved.length) return;
    display.userData.feFaces = moved;
    display.userData.feFaceVerts = target.count;
  }

  function commitToObject() {
    const exp = exportsOf();
    const target = state.target;
    const THREE = T();
    if (!exp || !target || !THREE) return;
    const vertexCount = exp.fe_edit_vert_count();
    const triCount = exp.fe_edit_tri_count();
    if (!vertexCount) return;
    const geometry = new THREE.BufferGeometry();
    const position = new Float32Array(f32(exp.fe_edit_pos_interleaved_ptr(), vertexCount * 3));
    const index = new Uint32Array(u32(exp.fe_edit_idx_ptr(), triCount * 3));
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    if (exp.fe_edit_has_color()) {
      const colours = new Float32Array(f32(exp.fe_edit_color_interleaved_ptr(), vertexCount * 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    /* The per-face flags, one byte per triangle. They are the only record of
       the shading that survives this function: the cage below has shared
       vertices, and a shared vertex cannot hold two normals at once, so there
       is nowhere on it for a flat face to be written down. */
    const shade = typeof exp.fe_edit_shade_state === 'function' ? exp.fe_edit_shade_state() : (exp.fe_edit_get_shade() === 0 ? 0 : 1);
    let flags = null;
    if (typeof exp.fe_edit_face_shade_ptr === 'function') {
      const count = exp.fe_edit_face_shade_count ? exp.fe_edit_face_shade_count() : triCount;
      if (count) flags = new Uint8Array(u8(exp.fe_edit_face_shade_ptr(), count));
    }
    if (flags) geometry.userData.feFaceShading = flags;

    /* The rings and the pairing are written onto the cage first: the display
       mesh below takes a translated copy of them, and the next session uploads
       this cage instead of re-deriving faces from the shape it finds. */
    const previousCage = target.userData.feEditCage;
    if (previousCage && previousCage !== geometry && previousCage !== target.geometry &&
        previousCage !== target.userData.baseGeometry) {
      previousCage.dispose?.();
    }
    target.userData.feEditCage = geometry;
    stashQuadDiagonals(geometry);
    stashFaces(geometry);

    /* Flat or mixed shading has to leave here as real geometry: everything
       downstream - the viewport's own material, the glTF exporter, whatever
       opens the file next - only understands normals, so a face marked flat is
       only flat if its corners are no longer shared. Ask the kernel for the
       render mesh with its all-flat shortcut switched off and hand *that* to
       the object, while the shared-vertex cage stays the mesh Edit Mode, the
       modifier stack and the quad rings work on. */
    let display = null;
    if (shade !== 1 && typeof exp.fe_edit_build_render_split === 'function') {
      const built = exp.fe_edit_build_render_split();
      const renderCount = built ? exp.fe_edit_render_vert_count() : 0;
      const renderIndexCount = built ? exp.fe_edit_render_idx_count() : 0;
      /* Not `renderCount > vertexCount`: a bent quad needs one normal for the
         whole face, which is a *different* normal on the same four vertices -
         the count never grows, and the shading is still there in the buffer.
         What the buffers hold is what the object gets. */
      if (renderCount && renderIndexCount) {
        display = new THREE.BufferGeometry();
        display.setAttribute('position', new THREE.BufferAttribute(new Float32Array(f32(exp.fe_edit_render_pos_ptr(), renderCount * 3)), 3));
        display.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(f32(exp.fe_edit_render_nrm_ptr(), renderCount * 3)), 3));
        display.setIndex(new THREE.BufferAttribute(new Uint32Array(u32(exp.fe_edit_render_idx_ptr(), renderIndexCount)), 1));
        if (exp.fe_edit_has_color()) {
          display.setAttribute('color', new THREE.BufferAttribute(new Float32Array(f32(exp.fe_edit_render_col_ptr(), renderCount * 3)), 3));
        }
        display.computeBoundingSphere();
        display.computeBoundingBox();
        if (flags) display.userData.feFaceShading = flags;
        /* The same faces, in the display mesh's own numbering: the viewport's
           Object Mode wireframe reads them from whatever geometry it is given. */
        transferFacesToDisplay(display, geometry);
      }
    }
    /* The edited mesh becomes the cage the modifier stack is built from. Only
       writing `target.geometry` used to lose the edit on the next stack
       update, which rebuilds from `baseGeometry` (see updateModifiersOnScene):
       that is the reported "mesh bugs out while editing". The cage and the
       object's own geometry stay separate objects, as the stack expects. */
    const wantsCage = !!target.userData.baseGeometry || (target.userData.modStack || []).some((mod) => mod.enabled);
    const oldBase = target.userData.baseGeometry;
    if (wantsCage) {
      if (oldBase && oldBase !== target.geometry) oldBase.dispose?.();
      target.userData.baseGeometry = geometry;
      target.geometry?.dispose?.();
      /* A stack rebuilds the object's own geometry from the cage, and that
         rebuild runs the same normal-split pass, so the clone is only a
         placeholder for the frame in between. */
      target.geometry = display || geometry.clone();
    } else {
      target.geometry?.dispose?.();
      target.geometry = display || geometry;
    }

    /* One mechanism in charge at a time, here as in the viewport: baked split
       normals mean no material flattening, and a mesh that outgrew the split
       budget keeps its look through the material instead. */
    const baked = !!display;
    const materials = Array.isArray(target.material) ? target.material : [target.material];
    for (const material of materials) {
      if (!material) continue;
      const flat = !baked && shade === 0;
      if (material.flatShading === flat) continue;
      material.flatShading = flat;
      material.needsUpdate = true;
    }
    delete target.userData.modifierError;
    target.userData.forceModUpdate = true;
    target.userData.feEdited = true;
    /* Keep the pairing with the shape it describes: anyone drawing this mesh's
       wireframe in Object Mode - or re-entering Edit Mode on it - gets the same
       quads the editor just worked with. Only a mesh whose vertices are still
       the cage's own. The rings are
       written in cage slots, and a split display mesh has its vertices
       renumbered, so copying them onto it would pair a face with the wrong
       corners; leaving them off lets the shell infer the rings from the
       positions instead - the split corners sit exactly where the cage's did. */
    /* The cage, kept beside the object even when no stack is listening: the
       rings and the pairing are written on it, and it is the mesh the next
       session uploads. Without this a flat mesh - the one case that commits a
       split display mesh instead of the cage - lost both on the way out, and
       coming back in re-derived its faces from the deformed shape underneath.
       A quad that has been dragged far enough stops looking like a quad to any
       shape test, so it came back as two triangles and the cage drew them. */

    if (typeof global.scheduleCoreHistory === 'function') global.scheduleCoreHistory({ target: target, type: 'change' });
  }

  /* ---- overlay ----------------------------------------------------------- */

  /* One rule for every wireframe colour: the editor draws the *opposite* of
     the surface it is editing. A pale model gets near-black lines and dots, a
     dark model gets pale ones, and both stay readable whichever way the
     material is set, instead of a fixed grey that disappears on a white cube
     and again on a black one. The selection is always orange. */
  const OVERLAY_DARK = 0x0b1220;
  const OVERLAY_LIGHT = 0xdbe4f0;
  const OVERLAY_SELECTED = [1.0, 0.62, 0.16];

  /* Wireframe shading turns the object's own surface off and leaves only the
     lines, so the tone the overlay has to contrast with is the viewport, not a
     material that is no longer drawn. Near-black lines on a near-black
     background - the pale wireframe the user had been looking at gone - would
     read as "the wireframe disappeared". */
  function surfaceIsDrawn() {
    const eng = core();
    const mode = typeof eng?.getShadingMode === 'function' ? eng.getShadingMode() : 'solid';
    return mode !== 'wireframe';
  }

  function overlayTone() {
    if (!surfaceIsDrawn()) {
      return { wire: OVERLAY_LIGHT, point: [0.86, 0.9, 0.96] };
    }
    const target = state.target;
    const materials = target ? (Array.isArray(target.material) ? target.material : [target.material]) : [];
    let sum = 0;
    let n = 0;
    for (const material of materials) {
      if (!material?.color || typeof material.color.r !== 'number') continue;
      sum += 0.2126 * material.color.r + 0.7152 * material.color.g + 0.0722 * material.color.b;
      n++;
    }
    /* No colour to speak of: assume a light surface, which is what every
       primitive in this app is. */
    const luminance = n ? sum / n : 0.8;
    return {
      wire: luminance > 0.35 ? OVERLAY_DARK : OVERLAY_LIGHT,
      point: luminance > 0.35 ? [0.045, 0.07, 0.125] : [0.86, 0.9, 0.96]
    };
  }

  /* One tiny round sprite, generated once. A texture-less Points draws a
     square, and a cube's eight corners then read as eight blocks. */
  let dotTexture = null;
  function dotSprite() {
    const THREE = T();
    if (dotTexture || !THREE) return dotTexture;
    if (typeof document === 'undefined' || !document.createElement) return null;
    const canvas = document.createElement('canvas');
    if (!canvas || !canvas.getContext) return null;
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.beginPath();
    context.arc(16, 16, 14, 0, Math.PI * 2);
    context.fillStyle = '#ffffff';
    context.fill();
    dotTexture = new THREE.CanvasTexture ? new THREE.CanvasTexture(canvas) : null;
    return dotTexture;
  }

  function ensureOverlay() {
    const THREE = T();
    const target = state.target;
    if (!THREE || !target) return null;
    if (state.overlay && state.overlay.parent === target) return state.overlay;

    /* A fresh overlay gets fresh CPU buffers: the cached ones belong to the
       buffers that were just thrown away, and a geometry attribute whose array
       is replaced behind its back is a driver bug waiting to happen. */
    state.dotBuffer = null;
    state.dotColour = null;
    state.faceBuffer = null;

    const group = new THREE.Group();
    group.name = 'EditModeOverlay';
    group.userData.isEditorHelper = true;

    /* Wireframe and selection are two objects with one flat colour each. A
       line is one pixel wide and does not need a colour channel per vertex,
       and a single unmistakable colour reads better on a pale surface than a
       per-vertex tint ever did. */
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
    const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({
      color: OVERLAY_DARK, transparent: true, opacity: 0.95, depthWrite: false
    }));
    edges.name = 'EditEdges';
    edges.frustumCulled = false;
    edges.userData.isEditorHelper = true;
    edges.renderOrder = 5;

    const selectedGeometry = new THREE.BufferGeometry();
    selectedGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
    const selectedEdges = new THREE.LineSegments(selectedGeometry, new THREE.LineBasicMaterial({
      color: 0xffa02c, transparent: true, opacity: 1, depthWrite: false
    }));
    selectedEdges.name = 'EditEdgesSelected';
    selectedEdges.frustumCulled = false;
    selectedEdges.userData.isEditorHelper = true;
    selectedEdges.renderOrder = 6;

    const dotGeometry = new THREE.BufferGeometry();
    dotGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage));
    dotGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3), 3).setUsage(THREE.DynamicDrawUsage));
    /* A square sprite on every corner turns a small model into a blob. The
       dots are round, a few pixels across, and drawn on the surface like the
       points they stand for. */
    const dots = new THREE.Points(dotGeometry, new THREE.PointsMaterial({
      vertexColors: true, size: 5, sizeAttenuation: false, transparent: true,
      depthWrite: false, alphaTest: 0.45, map: dotSprite()
    }));
    dots.name = 'EditVertexDots';
    dots.frustumCulled = false;
    dots.userData.isEditorHelper = true;
    dots.renderOrder = 6;

    const faceGeometry = new THREE.BufferGeometry();
    faceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3).setUsage(THREE.DynamicDrawUsage));
    const faces = new THREE.Mesh(faceGeometry, new THREE.MeshBasicMaterial({
      color: 0xffa02c, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false
    }));
    faces.name = 'EditFaceHighlight';
    faces.frustumCulled = false;
    faces.userData.isEditorHelper = true;
    faces.renderOrder = 4;

    group.add(edges, selectedEdges, dots, faces);
    target.add(group);
    state.overlay = group;
    return group;
  }

  /* Overlay buffers live for the whole session and grow by replacement: a
     BufferAttribute whose array is swapped behind its back is not something
     every driver uploads correctly, so the attribute itself is replaced. */
  /* The wireframe of the model's faces, as line segments.

     The edge table is built from triangles, so on a triangulated mesh it
     contains the diagonal across every quad and the spokes a fan draws from the
     middle of a cap. `fe_edit_edge_display` hides them by rule - an edge whose
     two triangles are nearly coplanar is not drawn - and that rule is a guess
     about the shape: a bent quad is no longer coplanar with itself, so its
     diagonal came back the moment the face was deformed, which is the line the
     user keeps finding in the middle of a face.

     Faces are not a guess. The kernel knows exactly which triangles make up
     which face (the declared rings first, the quad pairing after), so drawing
     each face's corner ring draws every edge the model has and no edge it does
     not - a quad's boundary is four lines whatever shape it has been bent into.
     The same table Edit Mode paints the selection from, one source. */
  function faceRingSegments(exp) {
    if (typeof exp.fe_edit_face_count !== 'function' || typeof exp.fe_edit_face_start_ptr !== 'function') return null;
    const faceCount = exp.fe_edit_face_count();
    const ringCount = typeof exp.fe_edit_face_ring_count === 'function' ? exp.fe_edit_face_ring_count() : 0;
    if (!faceCount || !ringCount) return null;
    const starts = u32(exp.fe_edit_face_start_ptr(), faceCount + 1);
    const ring = u32(exp.fe_edit_face_ring_ptr(), ringCount);
    const out = [];
    const seen = new Set();
    for (let f = 0; f < faceCount; f++) {
      const from = starts[f], to = starts[f + 1];
      const n = to - from;
      if (n < 3 || to > ringCount) continue;
      for (let i = 0; i < n; i++) {
        const a = ring[from + i], b = ring[from + (i + 1) % n];
        if (a === b) continue;
        const key = a < b ? a * 2097152 + b : b * 2097152 + a;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a, b);
      }
    }
    return out.length ? out : null;
  }

  function ensureEdgeBuffer(object, needed) {
    const attribute = object.geometry.attributes.position;
    if (attribute && attribute.array.length >= needed) return attribute.array;
    const THREE = T();
    const capacity = Math.max(needed, attribute ? attribute.array.length * 2 : 96);
    const array = new Float32Array(capacity);
    object.geometry.setAttribute('position', new THREE.BufferAttribute(array, 3).setUsage(THREE.DynamicDrawUsage));
    return array;
  }

  /* `vertices` is how many line ends to draw, which is twice the edge count.
     The wireframe follows the see-through switch: through the model it is a
     pale line, on the surface it is a dark one, and the material has to be
     told which it is because the two are drawn differently. */
  function drawEdges(object, vertices, selected) {
    const attribute = object.geometry.attributes.position;
    attribute.count = Math.max(vertices, 2);
    attribute.needsUpdate = true;
    object.geometry.setDrawRange(0, Math.max(vertices, 2));
    object.visible = vertices > 0;
    const through = !!state.xray;
    object.material.depthTest = !through;
    if (!selected) {
      const colour = overlayTone().wire;
      if (object.material.color.getHex() !== colour) object.material.color.setHex(colour);
      if (object.material.transparent !== through) {
        object.material.transparent = through;
        object.material.needsUpdate = true;
      }
      object.material.opacity = through ? 0.85 : 1;
    }
  }

  function refreshOverlay() {
    const exp = exportsOf();
    const THREE = T();
    if (!exp || !THREE || !state.target) return;
    const group = ensureOverlay();
    if (!group) return;
    /* The app can re-apply its selection outline at any time (a selection event,
       a modifier rebuild); while this mode runs it would describe the shape the
       object had before the edit. */
    removeSelectionOutlines(state.target);

    const vertexCount = exp.fe_edit_vert_count();
    const edgeCount = exp.fe_edit_edge_count();
    const triCount = exp.fe_edit_tri_count();
    const positions = f32(exp.fe_edit_pos_interleaved_ptr(), vertexCount * 3);
    const vertSel = u8(exp.fe_edit_vert_sel_ptr(), vertexCount);
    const edgeA = u32(exp.fe_edit_edge_ptr(), edgeCount);
    const edgeB = u32(exp.fe_edit_edge_b_ptr(), edgeCount);
    const edgeSel = u8(exp.fe_edit_edge_sel_ptr(), edgeCount);
    /* The kernel decides which edges a modeller should see. Two triangles that
       share an edge and face the same way are one quad, and the diagonal
       between them is not an edge of the model, so it is not drawn. */
    const edgeShow = u8(exp.fe_edit_edge_display_ptr(), edgeCount);
    /* ...and where the faces themselves are known, they answer it exactly: the
       ring of a face is its boundary, so nothing inside a face can be drawn. */
    /* Cached: this runs on every frame of a drag, and the faces only change when
       the topology does - which the counts below pin exactly. */
    const ringStamp = `${exp.fe_edit_face_count()}:${exp.fe_edit_face_ring_count()}:${triCount}:${vertexCount}`;
    if (state.ringSegments && state.ringStamp === ringStamp) {
      // reuse
    } else {
      state.ringSegments = faceRingSegments(exp);
      state.ringStamp = ringStamp;
    }
    const ringSegments = state.ringSegments;
    /* Edge selection lives on the edge table; a ring segment looks its own flag
       up here so the two views of the same line agree. */
    const edgeSelected = new Map();
    if (state.mode === 'edge' && ringSegments) {
      for (let e = 0; e < edgeCount; e++) {
        if (!edgeSel[e]) continue;
        const a = edgeA[e], b = edgeB[e];
        edgeSelected.set(a < b ? a * 2097152 + b : b * 2097152 + a, 1);
      }
    }
    const faceSel = u8(exp.fe_edit_face_sel_ptr(), triCount);
    const tris = u32(exp.fe_edit_idx_ptr(), triCount * 3);

    const edges = group.getObjectByName('EditEdges');
    const selectedEdges = group.getObjectByName('EditEdgesSelected');
    const dots = group.getObjectByName('EditVertexDots');
    const faces = group.getObjectByName('EditFaceHighlight');

    /* Two passes over the same edge table: the wireframe of the surface, and
       the edges the user is working with. The mask decides what the surface
       has; the selection only decides the colour, except in edge mode where a
       diagonal the user picked is drawn so the tool has something to show. */
    /* One list of segments either way: the face rings when the kernel has them,
       the edge display mask when it does not. */
    const segments = [];
    if (ringSegments) {
      for (let i = 0; i < ringSegments.length; i += 2) {
        const a = ringSegments[i], b = ringSegments[i + 1];
        const on = state.mode === 'edge' ? edgeSelected.has(a < b ? a * 2097152 + b : b * 2097152 + a) : (vertSel[a] && vertSel[b]);
        segments.push(a, b, on ? 1 : 0);
      }
    } else {
      for (let e = 0; e < edgeCount; e++) {
        const a = edgeA[e];
        const b = edgeB[e];
        const on = state.mode === 'edge' ? edgeSel[e] : (vertSel[a] && vertSel[b]);
        if (!edgeShow[e] && !(state.mode === 'edge' && edgeSel[e])) continue;
        segments.push(a, b, on ? 1 : 0);
      }
    }

    let baseCount = 0;
    let selectedCount = 0;
    for (let i = 2; i < segments.length; i += 3) {
      if (segments[i]) selectedCount++; else baseCount++;
    }
    const base = ensureEdgeBuffer(edges, baseCount * 6);
    const chosen = ensureEdgeBuffer(selectedEdges, selectedCount * 6);
    let baseAt = 0;
    let chosenAt = 0;
    for (let i = 0; i < segments.length; i += 3) {
      const a = segments[i], b = segments[i + 1];
      const target = segments[i + 2] ? chosen : base;
      let at = segments[i + 2] ? chosenAt : baseAt;
      target[at] = positions[a * 3]; target[at + 1] = positions[a * 3 + 1]; target[at + 2] = positions[a * 3 + 2];
      target[at + 3] = positions[b * 3]; target[at + 4] = positions[b * 3 + 1]; target[at + 5] = positions[b * 3 + 2];
      at += 6;
      if (segments[i + 2]) chosenAt = at; else baseAt = at;
    }
    drawEdges(edges, baseCount * 2, false);
    drawEdges(selectedEdges, selectedCount * 2, true);

    /* vertex dots */
    if (!state.dotBuffer || state.dotBuffer.length < vertexCount * 3) {
      state.dotBuffer = new Float32Array(Math.max(vertexCount * 3, 96));
      state.dotColour = new Float32Array(Math.max(vertexCount * 3, 96));
      dots.geometry.setAttribute('position', new THREE.BufferAttribute(state.dotBuffer, 3).setUsage(THREE.DynamicDrawUsage));
      dots.geometry.setAttribute('color', new THREE.BufferAttribute(state.dotColour, 3).setUsage(THREE.DynamicDrawUsage));
    }
    const db = state.dotBuffer;
    const dc = state.dotColour;
    const tone = overlayTone();
    for (let v = 0; v < vertexCount; v++) {
      db[v * 3] = positions[v * 3]; db[v * 3 + 1] = positions[v * 3 + 1]; db[v * 3 + 2] = positions[v * 3 + 2];
      const c = vertSel[v] ? OVERLAY_SELECTED : tone.point;
      dc[v * 3] = c[0]; dc[v * 3 + 1] = c[1]; dc[v * 3 + 2] = c[2];
    }
    const dotGeometry = dots.geometry;
    dotGeometry.attributes.position.count = Math.max(vertexCount, 1);
    dotGeometry.attributes.position.needsUpdate = true;
    dotGeometry.attributes.color.count = Math.max(vertexCount, 1);
    dotGeometry.attributes.color.needsUpdate = true;
    dotGeometry.setDrawRange(0, vertexCount);
    dots.visible = state.mode === 'vertex' && vertexCount > 0;
    /* In point mode the dots are the selection, so they stay on top; the
       wireframe is depth-tested so the shape reads as a solid. */
    dots.material.depthTest = state.mode === 'vertex' ? !state.xray : true;
    /* Dots are the only thing to aim at in point mode, so they get a couple of
       pixels more on a phone-sized viewport. */
    /* The module is loaded in a vm without a window (the tests), in the single
       file build and in the browser; ask whichever one exists. */
    const view = typeof window !== 'undefined' ? window : global;
    const fingerSized = Math.min(view.innerWidth || 1024, view.innerHeight || 768) < 900;
    dots.material.size = vertexCount > 2000 ? (fingerSized ? 6 : 4) : vertexCount > 400 ? (fingerSized ? 7 : 5) : (fingerSized ? 9 : 6);

    /* Selected faces are only painted in face mode. In point mode every
       vertex of a face can be selected without the face being selected, and
       flooding the model orange hides the very wireframe being edited. */
    let selectedFaces = 0;
    if (state.mode === 'face') {
      for (let t = 0; t < triCount; t++) if (faceSel[t]) selectedFaces++;
    }
    const faceGeometry = faces.geometry;
    if (selectedFaces > 0) {
      if (!state.faceBuffer || state.faceBuffer.length < selectedFaces * 9) {
        state.faceBuffer = new Float32Array(selectedFaces * 9);
        faceGeometry.setAttribute('position', new THREE.BufferAttribute(state.faceBuffer, 3).setUsage(THREE.DynamicDrawUsage));
      }
      const fb = state.faceBuffer;
      let cursor = 0;
      for (let t = 0; t < triCount; t++) {
        if (!faceSel[t]) continue;
        for (let k = 0; k < 3; k++) {
          const v = tris[t * 3 + k];
          fb[cursor++] = positions[v * 3];
          fb[cursor++] = positions[v * 3 + 1];
          fb[cursor++] = positions[v * 3 + 2];
        }
      }
      faceGeometry.attributes.position.count = selectedFaces * 3;
      faceGeometry.attributes.position.needsUpdate = true;
      faceGeometry.setDrawRange(0, selectedFaces * 3);
      faces.visible = true;
    } else {
      faces.visible = false;
      faceGeometry.setDrawRange(0, 0);
    }
  }

  /* ---- the on-canvas gizmo ----------------------------------------------- */

  /* Three arrows, three rings, three bars, drawn at the selection in the
     object's own space. The kernel owns the geometry of the handles — where
     they sit, how big they are, which one a finger landed on, and what a drag
     of that handle does — so the same numbers decide the drawing and the
     editing. Nothing here touches a vertex. */
  const GIZMO_COLOURS = [0xef4444, 0x22c55e, 0x3b82f6];
  const gizmo = { group: null, mode: 0, drag: null };

  function gizmoSpace() {
    /* 0 = move, 1 = rotate, 2 = scale: the same three spaces the kernel picks
       handles in, and the tool the user is holding decides which one shows. */
    if (state.tool === 'rotate') return 1;
    if (state.tool === 'scale') return 2;
    return 0;
  }

  function handleMaterial(colour, opacity) {
    const THREE = T();
    return new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: opacity ?? 0.95,
      depthTest: false, depthWrite: false, toneMapped: false
    });
  }

  function buildGizmo(mode) {
    const THREE = T();
    const group = new THREE.Group();
    const pickables = [];
    /* Every handle is authored along +Y in a unit-long space and then turned
       onto its axis, so one arrow shape serves X, Y and Z. */
    const along = (object, axis) => {
      if (axis === 0) object.rotation.z = -Math.PI / 2;
      else if (axis === 2) object.rotation.x = Math.PI / 2;
      return object;
    };

    for (let axis = 0; axis < 3; axis++) {
      const material = handleMaterial(GIZMO_COLOURS[axis]);
      const part = new THREE.Group();
      if (mode === 1) {
        /* A torus is born in the XY plane, turning about Z. To ring the X axis
           it must lie in YZ, to ring Y in XZ, and to ring Z it needs nothing.
           The arrow alignment below is *not* applied on top of that: two
           rotations about different axes would leave two rings on one plane. */
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.016, 6, 56), material);
        if (axis === 0) ring.rotation.y = Math.PI / 2;
        else if (axis === 1) ring.rotation.x = Math.PI / 2;
        part.add(ring);
        part.userData.handle = axis;
        pickables.push(part);
        group.add(part);
        continue;
      } else if (mode === 2) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 6), material);
        bar.position.y = 0.45;
        const grip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), material);
        grip.position.y = 0.96;
        part.add(bar, grip);
      } else {
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.78, 6), material);
        shaft.position.y = 0.39;
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 12), material);
        head.position.y = 0.87;
        part.add(shaft, head);
      }
      along(part, axis);
      part.userData.handle = axis;
      pickables.push(part);
      group.add(part);
    }

    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), handleMaterial(0xf8fafc));
    group.add(hub);

    group.name = 'EditGizmo';
    group.userData.isEditorHelper = true;
    group.traverse((object) => {
      object.userData.isEditorHelper = true;
      object.renderOrder = 9;
      object.frustumCulled = false;
    });
    return group;
  }

  function disposeGizmo() {
    const group = gizmo.group;
    if (!group) return;
    group.parent?.remove(group);
    group.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((m) => m?.dispose?.());
      else object.material?.dispose?.();
    });
    gizmo.group = null;
    gizmo.mode = -1;
  }

  function ensureGizmo() {
    const target = state.target;
    const THREE = T();
    if (!THREE || !target) return null;
    const mode = gizmoSpace();
    if (gizmo.group && gizmo.group.parent === target && gizmo.mode === mode) return gizmo.group;
    disposeGizmo();
    gizmo.group = buildGizmo(mode);
    gizmo.mode = mode;
    target.add(gizmo.group);
    return gizmo.group;
  }

  /* Pivot and on-screen size, both from the kernel, both read inside one arena
     because the two calls share the projection matrix. */
  function gizmoFrame() {
    const exp = exportsOf();
    if (!exp) return null;
    const matrix = clipMatrix();
    if (!matrix) return null;
    return withArena(null, (e) => {
      const clipPtr = e.fe_malloc(64);
      const pivotPtr = e.fe_malloc(12);
      if (!clipPtr || !pivotPtr) return null;
      new Float32Array(memory(), clipPtr, 16).set(matrix.elements);
      e.fe_edit_gizmo_pivot(pivotPtr);
      return {
        matrix,
        pivot: Float32Array.from(new Float32Array(memory(), pivotPtr, 3)),
        size: e.fe_edit_gizmo_size(clipPtr)
      };
    });
  }

  function gizmoAspect() {
    const canvas = canvasElement();
    return canvas && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 1;
  }

  function updateGizmo() {
    const exp = exportsOf();
    const target = state.target;
    if (!exp || !target) return;
    const group = ensureGizmo();
    if (!group) return;
    /* No selection, no handles: a grab handle with nothing to grab is a dead
       affordance, and a tap through it must still reach the mesh. */
    if (stats.selected === 0) { group.visible = false; return; }
    const frame = gizmoFrame();
    if (!frame || !(frame.size > 0)) { group.visible = false; return; }
    group.visible = true;
    group.position.set(frame.pivot[0], frame.pivot[1], frame.pivot[2]);
    group.scale.setScalar(frame.size);
  }

  function gizmoPick(point) {
    return withClip((e, ptr) => e.fe_edit_gizmo_pick(ptr, point.x, point.y, gizmoAspect(), 0.07, gizmoSpace()));
  }

  function beginGizmoDrag(point, handle) {
    const exp = exportsOf();
    if (!exp || handle < 0) return false;
    const begun = withClip((e, ptr) => e.fe_edit_gizmo_begin(ptr, point.x, point.y, gizmoAspect(), 0.07, gizmoSpace()));
    if (begun < 0) return false;
    /* One snapshot for the whole drag. The kernel applies the movement in
       increments, so an interrupted drag leaves the mesh where the finger
       stopped, not where the gesture started. */
    exp.fe_edit_undo_push();
    gizmo.drag = { handle: begun, applied: 0, moved: 0, start: point };
    captureOrbit(false);
    return true;
  }

  function dragGizmo(point) {
    const exp = exportsOf();
    const drag = gizmo.drag;
    if (!exp || !drag) return;
    const result = withClip((e, ptr) => {
      const outPtr = e.fe_malloc(12);
      if (!outPtr) return null;
      const handle = e.fe_edit_gizmo_drag(ptr, point.x, point.y, gizmoAspect(), outPtr);
      if (handle < 0) return null;
      return { handle, amount: new Float32Array(memory(), outPtr, 1)[0] };
    });
    if (!result) return;
    drag.applied = result.amount;
    drag.moved = Math.max(drag.moved, Math.hypot(point.x - drag.start.x, point.y - drag.start.y));
    refresh();
  }

  function endGizmoDrag(cancelled) {
    const exp = exportsOf();
    const drag = gizmo.drag;
    gizmo.drag = null;
    captureOrbit(true);
    if (!exp) return;
    exp.fe_edit_gizmo_end();
    /* A tap on a handle only: drop the snapshot rather than leave an empty
       step in the history. */
    if (!cancelled && drag && drag.moved < 0.004) exp.fe_edit_undo();
    refresh();
  }

  /* ---- stats ------------------------------------------------------------- */

  const stats = { verts: 0, edges: 0, faces: 0, selected: 0, undo: 0, redo: 0 };

  function readStats() {
    const exp = exportsOf();
    if (!exp) return stats;
    const raw = u32(exp.fe_edit_stats_ptr(), 6);
    stats.verts = raw[0];
    stats.edges = raw[1];
    stats.faces = raw[2];
    stats.selected = exp.fe_edit_sel_count();
    stats.undo = exp.fe_edit_undo_depth();
    stats.redo = exp.fe_edit_redo_depth();
    return stats;
  }

  /* ---- the whole refresh path -------------------------------------------- */

  function refresh() {
    const exp = exportsOf();
    if (!exp || !state.active) return;
    exp.fe_edit_build_render();
    syncViewport();
    applyShading();
    refreshOverlay();
    readStats();
    updateGizmo();
    syncSheet();
  }

  /* Two mechanisms, and exactly one of them is ever in charge. When every face
     is flat the kernel hands back the indexed mesh - a dense flat mesh would
     not fit the render budget any other way - and the material's derivative
     normals do the shading. As soon as one face is smooth the kernel splits its
     corners instead and writes real per-face normals, so the material has to go
     back to smooth or the GPU would flatten the smooth faces as well. That is
     what lets a single face stay flat while the rest of the model rounds off. */
  function applyShading() {
    const exp = exportsOf();
    const target = state.target;
    if (!exp || !target) return;
    const shade = typeof exp.fe_edit_shade_state === 'function'
      ? exp.fe_edit_shade_state()
      : (exp.fe_edit_get_shade() === 0 ? 0 : 1);
    /* Only when the kernel kept the indexed mesh *and* every flat face is
       planar. A face bent out of plane is still one face - its two halves carry
       the face's single normal so no line appears down the diagonal - and the
       shader deriving a normal per triangle would draw exactly that line. */
    const planar = typeof exp.fe_edit_flat_planar === 'function' ? exp.fe_edit_flat_planar() === 1 : true;
    const flat = shade === 0 && planar;
    const materials = Array.isArray(target.material) ? target.material : [target.material];
    for (const material of materials) {
      if (!material || material.flatShading === flat) continue;
      material.flatShading = flat;
      material.needsUpdate = true;
    }
  }

  /* ---- selection --------------------------------------------------------- */

  function clipMatrix() {
    const THREE = T();
    const eng = core();
    const target = state.target;
    if (!THREE || !eng || !target) return null;
    const camera = eng.getActiveCamera ? eng.getActiveCamera() : eng.viewportCamera;
    if (!camera) return null;
    camera.updateMatrixWorld(true);
    target.updateMatrixWorld(true);
    const matrix = new THREE.Matrix4();
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    matrix.multiply(target.matrixWorld);
    return matrix;
  }

  function withClip(fn) {
    const matrix = clipMatrix();
    if (!matrix) return null;
    return withArena(null, (exp) => {
      const ptr = exp.fe_malloc(16 * 4);
      if (!ptr) return null;
      new Float32Array(memory(), ptr, 16).set(matrix.elements);
      return fn(exp, ptr, matrix);
    });
  }

  /* Tap radius in CSS pixels. A fingertip lands nowhere near a two-pixel
     vertex, so the kernel is told how much slack to allow in NDC units
     (2 units span the viewport height) instead of using its own guess. The
     radius also doubles as the "is this even on the mesh" limit: nothing
     outside it is picked, which is what stopped empty taps from grabbing the
     nearest vertex on that side of the screen. */
  const PICK_RADIUS_TOUCH = 22;
  const PICK_RADIUS_MOUSE = 11;

  function pickRadiusPixels() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      if (window.matchMedia('(pointer: coarse)').matches) return PICK_RADIUS_TOUCH;
    }
    return PICK_RADIUS_MOUSE;
  }

  function pickAt(point) {
    const height = point && point.pixelsY ? point.pixelsY : 0;
    const tolerance = height > 0 ? (2 * pickRadiusPixels()) / height : 0.045;
    return withClip((exp, ptr) => {
      if (typeof exp.fe_edit_set_pick_tolerance === 'function') exp.fe_edit_set_pick_tolerance(tolerance);
      return exp.fe_edit_pick(ptr, point.x, point.y);
    });
  }

  function selectIndex(kind, index, additive) {
    const exp = exportsOf();
    if (!exp || index < 0) return;
    const op = additive ? 3 : 0;
    const faceSel = kind === 2 ? u8(exp.fe_edit_face_sel_ptr(), exp.fe_edit_tri_count()) : null;
    const already = kind === 1
      ? u8(exp.fe_edit_edge_sel_ptr(), exp.fe_edit_edge_count())[index]
      : kind === 2 ? faceSel[index] : 0;
    /* A face is the polygon, not the triangle the ray happened to land on: the
       edit mesh stores triangles, FEPoly knows which of them are one face, so a
       tap selects all of them and the highlight covers the whole quad. */
    const group = kind === 2 ? faceTrianglesForKernelFace(exp, index) : null;
    const indices = group && group.length > 1 ? group : [index];
    const wasSelected = group && group.length > 1 && faceSel
      ? indices.some((t) => faceSel[t])
      : already;
    withArena(null, (exp2) => {
      const ptr = exp2.fe_malloc(4 * indices.length);
      if (!ptr) return;
      const view = new Uint32Array(memory(), ptr, indices.length);
      for (let i = 0; i < indices.length; i++) view[i] = indices[i];
      if (!additive) exp2.fe_edit_select_none();
      /* Toggle: an already selected edge or face is deselected on the second tap. */
      exp2.fe_edit_select_by_index(kind, indices.length, ptr, additive && wasSelected ? 2 : op);
    });
  }

  /* Which kernel triangles make up the face a kernel triangle belongs to. The
     two are matched by centroid, because the upload is free to reorder the
     triangles; if most of them cannot be matched, the mesh on screen is not the
     mesh FEPoly measured and a tap stays a triangle rather than grouping the
     wrong thing. */
  let polyFaceMap = null;
  let polyFaceMapStamp = '';

  function faceTrianglesForKernelFace(exp, kernelTri) {
    const target = state.target;
    const geometry = target && target.geometry;
    const api = (typeof window !== 'undefined' ? window : globalThis).FEPoly;
    if (!api || !geometry || !geometry.attributes || !geometry.attributes.position) return null;
    const triCount = exp.fe_edit_tri_count();
    const vertCount = exp.fe_edit_vert_count();
    const stamp = triCount + ':' + vertCount + ':' + (geometry.attributes.position.version || 0) + ':' + geometry.attributes.position.count;
    if (!polyFaceMap || polyFaceMapStamp !== stamp) {
      polyFaceMap = buildPolyFaceMap(exp, geometry, api, triCount, vertCount);
      polyFaceMapStamp = stamp;
    }
    if (!polyFaceMap) return null;
    const face = polyFaceMap.triToFace[kernelTri];
    if (face === undefined || face < 0) return null;
    return polyFaceMap.faceTris[face] || null;
  }

  function buildPolyFaceMap(exp, geometry, api, triCount, vertCount) {
    try {
      const poly = api.faceList(geometry);
      if (!poly || !poly.faceTris) return null;
      const positions = geometry.attributes.position.array;
      const index = geometry.index;
      const gTriCount = index ? Math.floor(index.count / 3) : Math.floor(geometry.attributes.position.count / 3);
      if (gTriCount !== triCount) return null;
      const slotOf = (t, k) => (index ? index.array[t * 3 + k] : t * 3 + k);
      const key = (x, y, z) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
      const cage = f32(exp.fe_edit_pos_interleaved_ptr(), vertCount * 3);
      const tris = u32(exp.fe_edit_idx_ptr(), triCount * 3);
      const kernelByCentroid = new Map();
      for (let t = 0; t < triCount; t++) {
        const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
        const cx = (cage[a * 3] + cage[b * 3] + cage[c * 3]) / 3;
        const cy = (cage[a * 3 + 1] + cage[b * 3 + 1] + cage[c * 3 + 1]) / 3;
        const cz = (cage[a * 3 + 2] + cage[b * 3 + 2] + cage[c * 3 + 2]) / 3;
        kernelByCentroid.set(key(cx, cy, cz), t);
      }
      const triToFace = new Int32Array(triCount).fill(-1);
      const faceTris = [];
      let matched = 0;
      for (let f = 0; f < poly.faceTris.length; f++) {
        const list = [];
        for (const geometryTri of poly.faceTris[f]) {
          const a = slotOf(geometryTri, 0), b = slotOf(geometryTri, 1), c = slotOf(geometryTri, 2);
          const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
          const cy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
          const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
          const kernelTri = kernelByCentroid.get(key(cx, cy, cz));
          if (kernelTri === undefined || triToFace[kernelTri] >= 0) continue;
          triToFace[kernelTri] = f;
          list.push(kernelTri);
          matched++;
        }
        faceTris.push(list);
      }
      if (matched < triCount * 0.9) return null;
      return { triToFace, faceTris };
    } catch (_) {
      return null;
    }
  }

  function boxSelect(from, to, additive) {
    return withClip((exp, ptr) => exp.fe_edit_select_box(ptr, from.x, from.y, to.x, to.y, additive ? 1 : 0, state.xray ? 1 : 0));
  }

  function circleSelect(point, additive) {
    const radius = (state.amount.circle || 12) / 100;
    const canvas = core()?.r?.domElement;
    const aspect = canvas && canvas.clientHeight ? canvas.clientWidth / canvas.clientHeight : 1;
    return withClip((exp, ptr) => exp.fe_edit_select_circle(ptr, point.x, point.y, radius, additive ? 1 : 0, state.xray ? 1 : 0, aspect));
  }

  /* ---- gestures ---------------------------------------------------------- */

  function canvasElement() { return core()?.r?.domElement || null; }

  function normalise(event) {
    const canvas = canvasElement();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      pixelsX: rect.width,
      pixelsY: rect.height
    };
  }

  function pivotLocal() {
    const exp = exportsOf();
    const THREE = T();
    if (!exp || !THREE) return new THREE.Vector3();
    const bounds = f32(exp.fe_edit_bounds_ptr(), 12);
    return new THREE.Vector3(bounds[6], bounds[7], bounds[8]);
  }

  /* World units per screen pixel at the selection's depth. This is what makes
     a 200 px drag travel the same distance as the finger, on any lens. */
  function worldPerPixel() {
    const THREE = T();
    const eng = core();
    const target = state.target;
    if (!THREE || !eng || !target) return 0.01;
    const camera = eng.getActiveCamera ? eng.getActiveCamera() : eng.viewportCamera;
    const canvas = canvasElement();
    if (!camera || !canvas) return 0.01;
    const pivot = target.localToWorld(pivotLocal());
    const distance = Math.max(0.001, camera.position.distanceTo(pivot));
    const fov = camera.isPerspectiveCamera ? camera.fov : 50;
    const height = 2 * Math.tan((fov * Math.PI) / 360) * distance;
    return height / Math.max(1, canvas.clientHeight);
  }

  function captureOrbit(on) {
    const eng = core();
    if (!eng?.oc) return;
    eng.oc.enableRotate = on;
    eng.oc.enablePan = on;
    eng.oc.enableZoom = true;
  }

  /* Only these five tools take the one-finger drag. The default Select tool
     does not: it *observes* a tap and lets the gesture through, so orbiting
     the viewport stays possible in the mode a user spends most time in. */
  const DRAG_TOOLS = new Set(['box', 'circle', 'move', 'rotate', 'scale']);

  function beginGesture(point, event) {
    const exp = exportsOf();
    const THREE = T();
    const eng = core();
    const target = state.target;
    if (!exp || !THREE || !eng || !target) return false;

    const tool = state.tool;
    if (tool === 'move' || tool === 'rotate' || tool === 'scale') {
      if (exp.fe_edit_sel_count() === 0) { toast(`Select something to ${tool} first.`); return false; }
      exp.fe_edit_undo_push();
    }
    state.drag = {
      tool,
      start: point,
      last: point,
      moved: 0,
      additive: !!(event.shiftKey || event.ctrlKey || event.metaKey),
      worldPerPixel: worldPerPixel(),
      applied: { x: 0, y: 0, z: 0 },
      angle: 0,
      factor: 1,
      pivotWorld: target.localToWorld(pivotLocal())
    };
    captureOrbit(false);
    return true;
  }

  function screenToWorldDelta(point, drag) {
    const eng = core();
    const camera = eng.getActiveCamera ? eng.getActiveCamera() : eng.viewportCamera;
    const THREE = T();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const dx = (point.x - drag.start.x) * drag.start.pixelsX * drag.worldPerPixel;
    const dy = (point.y - drag.start.y) * drag.start.pixelsY * drag.worldPerPixel;
    return new THREE.Vector3().addScaledVector(right, dx).addScaledVector(up, -dy);
  }

  function updateGesture(point) {
    const exp = exportsOf();
    const drag = state.drag;
    const THREE = T();
    const target = state.target;
    if (!exp || !drag || !THREE || !target) return;
    drag.last = point;
    drag.moved = Math.max(drag.moved, Math.hypot(point.x - drag.start.x, point.y - drag.start.y));

    if (drag.tool === 'move') {
      const worldDelta = screenToWorldDelta(point, drag);
      const origin = target.worldToLocal(drag.pivotWorld.clone());
      const moved = target.worldToLocal(drag.pivotWorld.clone().add(worldDelta));
      const local = moved.sub(origin);
      if (state.snap) {
        const step = 0.25;
        local.x = Math.round(local.x / step) * step;
        local.y = Math.round(local.y / step) * step;
        local.z = Math.round(local.z / step) * step;
      }
      /* Deltas from the gesture start, so releasing mid-drag is exact. */
      exp.fe_edit_move(local.x - drag.applied.x, local.y - drag.applied.y, local.z - drag.applied.z, state.axis);
      drag.applied = local;
      refresh();
    } else if (drag.tool === 'rotate') {
      const pixels = (point.x - drag.start.x) * drag.start.pixelsX;
      const angle = pixels * 0.6;
      /* Kernel axes: 1 = around X, 2 = around Y, 0/3 = around Z. */
      const axisCode = state.axis === 1 ? 1 : state.axis === 2 ? 2 : state.axis === 3 ? 0 : 2;
      exp.fe_edit_rotate(angle - drag.angle, axisCode);
      drag.angle = angle;
      refresh();
    } else if (drag.tool === 'scale') {
      const pixels = (point.x - drag.start.x) * drag.start.pixelsX;
      const factor = Math.max(0.05, 1 + pixels / 220);
      const step = factor / drag.factor;
      exp.fe_edit_scale(step, step, step, state.axis);
      drag.factor = factor;
      refresh();
    }
  }

  function endGesture(point, cancelled) {
    const drag = state.drag;
    const exp = exportsOf();
    state.drag = null;
    clearMarquee();
    captureOrbit(true);
    if (!drag || !exp) return;
    if (cancelled) { refresh(); return; }
    if (drag.tool === 'box') boxSelect(drag.start, point, drag.additive);
    else if (drag.tool === 'circle') circleSelect(drag.last, drag.additive);
    refresh();
  }

  /* The marquee is a DOM box: it must sit above the WebGL surface and cost no
     draw call, and it is the only part of Edit Mode that is not a kernel mesh. */
  function drawMarquee(point) {
    const box = byId('edit-marquee');
    const drag = state.drag;
    if (!box || !drag) return;
    const rect = canvasElement()?.getBoundingClientRect();
    if (!rect) return;
    if (drag.tool === 'circle') {
      const radius = ((state.amount.circle || 12) / 100) * rect.width;
      box.hidden = false;
      box.style.borderRadius = '50%';
      box.style.width = box.style.height = `${radius * 2}px`;
      box.style.left = `${rect.left + point.x * rect.width - radius}px`;
      box.style.top = `${rect.top + point.y * rect.height - radius}px`;
      return;
    }
    const x0 = Math.min(drag.start.x, point.x) * rect.width;
    const y0 = Math.min(drag.start.y, point.y) * rect.height;
    const x1 = Math.max(drag.start.x, point.x) * rect.width;
    const y1 = Math.max(drag.start.y, point.y) * rect.height;
    box.hidden = false;
    box.style.borderRadius = '6px';
    box.style.left = `${rect.left + x0}px`;
    box.style.top = `${rect.top + y0}px`;
    box.style.width = `${Math.max(2, x1 - x0)}px`;
    box.style.height = `${Math.max(2, y1 - y0)}px`;
  }

  function clearMarquee() {
    const box = byId('edit-marquee');
    if (box) box.hidden = true;
  }

  /* A tap is a finger that stayed put. The allowance is in pixels, because a
     finger on a phone drifts a millimetre or two and the same 1 % of the
     canvas is 9 px across and 4 px down when the viewport is a wide one. */
  const TAP_SLOP = 12;

  /* A tap on the canvas in Select mode picks the vertex / edge / face under the
     finger. It is measured, not intercepted: no preventDefault, no pointer
     capture, so a drag still belongs to OrbitControls. */
  function handleTap(tap) {
    const exp = exportsOf();
    if (!exp) return;
    if (tap.moved > TAP_SLOP) return;
    const kind = MODES[state.mode].kind;
    const index = pickAt(tap.last);
    if (index >= 0) selectIndex(kind, index, tap.additive);
    else if (!tap.additive) exp.fe_edit_select_none();
    refresh();
  }

  const pointer = { canvas: null, down: null, move: null, up: null, tap: null };

  function tapDistance(tap, point) {
    return Math.hypot(
      (point.x - tap.startX) * tap.pixelsX,
      (point.y - tap.startY) * tap.pixelsY
    );
  }

  function attachPointer() {
    if (pointer.canvas) return;
    const canvas = canvasElement();
    if (!canvas) return;

    pointer.down = (event) => {
      if (!state.active || event.button === 2) return;
      const point = normalise(event);
      if (!point) return;

      /* Two fingers mean a pinch or a two-finger orbit. The pick that was in
         flight belongs to the first finger alone, so it is dropped. */
      if (event.isPrimary === false) { pointer.tap = null; return; }

      if (state.drag || gizmo.drag) return;

      /* The handles come first, in every tool: they are drawn on top, they are
         the easy thing to hit, and a tap that misses them falls through to the
         mesh or to OrbitControls exactly as before. */
      const handle = stats.selected > 0 ? gizmoPick(point) : -1;
      if (handle >= 0 && beginGizmoDrag(point, handle)) {
        event.stopPropagation();
        event.preventDefault();
        state.pointerId = event.pointerId;
        canvas.setPointerCapture?.(event.pointerId);
        return;
      }

      const tool = BY_ID.get(state.tool);
      if (!tool) return;
      if (!DRAG_TOOLS.has(tool.id)) {
        if (tool.id === 'pick') {
          pointer.tap = {
            startX: point.x, startY: point.y,
            pixelsX: point.pixelsX, pixelsY: point.pixelsY,
            last: point,
            moved: 0,
            additive: !!(event.shiftKey || event.ctrlKey || event.metaKey)
          };
        }
        return;
      }
      if (!beginGesture(point, event)) return;
      /* Only now is the gesture ours; a refused drag falls through to orbit. */
      event.stopPropagation();
      event.preventDefault();
      state.pointerId = event.pointerId;
      canvas.setPointerCapture?.(event.pointerId);
    };

    pointer.move = (event) => {
      if (!state.active) return;
      if (gizmo.drag) {
        if (event.pointerId !== state.pointerId) return;
        const point = normalise(event);
        if (!point) return;
        event.stopPropagation();
        dragGizmo(point);
        return;
      }
      if (state.drag) {
        if (event.pointerId !== state.pointerId) return;
        const point = normalise(event);
        if (!point) return;
        event.stopPropagation();
        updateGesture(point);
        if (state.drag.tool === 'box' || state.drag.tool === 'circle') drawMarquee(point);
        return;
      }
      const tap = pointer.tap;
      if (!tap) return;
      const point = normalise(event);
      if (!point) return;
      tap.last = point;
      tap.moved = Math.max(tap.moved, tapDistance(tap, point));
    };

    pointer.up = (event) => {
      if (!state.active) return;
      if (gizmo.drag) {
        if (event.pointerId !== state.pointerId) return;
        event.stopPropagation();
        try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
        state.pointerId = null;
        endGizmoDrag(event.type === 'pointercancel');
        return;
      }
      if (state.drag) {
        if (event.pointerId !== state.pointerId) return;
        const point = normalise(event) || state.drag.last;
        event.stopPropagation();
        try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
        state.pointerId = null;
        endGesture(point, event.type === 'pointercancel');
        return;
      }
      const tap = pointer.tap;
      if (!tap) return;
      pointer.tap = null;
      if (event.type === 'pointercancel') return;
      tap.last = normalise(event) || tap.last;
      handleTap(tap);
    };

    canvas.addEventListener('pointerdown', pointer.down, { capture: true });
    canvas.addEventListener('pointermove', pointer.move, { capture: true });
    canvas.addEventListener('pointerup', pointer.up, { capture: true });
    canvas.addEventListener('pointercancel', pointer.up, { capture: true });
    pointer.canvas = canvas;
  }

  function detachPointer() {
    const canvas = pointer.canvas;
    pointer.tap = null;
    gizmo.drag = null;
    if (!canvas) return;
    canvas.removeEventListener('pointerdown', pointer.down, { capture: true });
    canvas.removeEventListener('pointermove', pointer.move, { capture: true });
    canvas.removeEventListener('pointerup', pointer.up, { capture: true });
    canvas.removeEventListener('pointercancel', pointer.up, { capture: true });
    pointer.canvas = null;
  }

  /* ---- commands ----------------------------------------------------------- */

  function amountOf(id) {
    const tool = BY_ID.get(id);
    return state.amount[id] !== undefined ? state.amount[id] : tool?.amount?.value ?? 0;
  }

  const COMMANDS = {
    all: (exp) => exp.fe_edit_select_all(),
    none: (exp) => exp.fe_edit_select_none(),
    invert: (exp) => exp.fe_edit_select_invert(),
    linked: (exp) => exp.fe_edit_select_linked(0),
    more: (exp) => exp.fe_edit_select_more(),
    less: (exp) => exp.fe_edit_select_less(),
    similar: (exp) => exp.fe_edit_select_similar(MODES[state.mode].kind, 0.25),
    random: (exp) => exp.fe_edit_select_random(amountOf('random'), 0x5EED),
    loop: (exp) => {
      const count = exp.fe_edit_edge_count();
      const selected = u8(exp.fe_edit_edge_sel_ptr(), count);
      for (let e = 0; e < count; e++) if (selected[e]) return exp.fe_edit_select_loop(e);
      toast('Select an edge to grow a loop from.');
      return 0;
    },

    shrink: (exp) => exp.fe_edit_shrink_fatten(amountOf('shrink')),
    slide: (exp) => exp.fe_edit_slide(amountOf('slide')),
    shear: (exp) => exp.fe_edit_shear(amountOf('shear'), state.axis === 1 ? 1 : state.axis === 2 ? 2 : 3, 1),
    sphere: (exp) => exp.fe_edit_to_sphere(amountOf('sphere')),
    bend: (exp) => exp.fe_edit_bend(amountOf('bend'), state.axis === 1 ? 1 : state.axis === 2 ? 2 : 3),
    randomize: (exp) => exp.fe_edit_randomize(amountOf('randomize'), 0x1234),
    align: (exp) => exp.fe_edit_align(state.axis || 1),
    mirror: (exp) => exp.fe_edit_mirror(amountOf('mirror'), 1),
    exact: (exp) => {
      const x = Number(byId('edit-exact-x')?.value) || 0;
      const y = Number(byId('edit-exact-y')?.value) || 0;
      const z = Number(byId('edit-exact-z')?.value) || 0;
      if (!x && !y && !z) { toast('Type an offset first.'); return 0; }
      return exp.fe_edit_move(x, y, z, 0);
    },

    extrude: (exp) => exp.fe_edit_extrude(amountOf('extrude'), state.mode === 'face' ? 0 : 1),
    inset: (exp) => exp.fe_edit_inset(amountOf('inset'), state.mode === 'face' ? 0 : 1),
    subdivide: (exp) => exp.fe_edit_subdivide(state.mode === 'edge' ? 3 : 0, 0),
    bevel: (exp) => exp.fe_edit_bevel(amountOf('bevel'), state.mode === 'vertex' ? 1 : 0),
    poke: (exp) => exp.fe_edit_poke(),
    duplicate: (exp) => exp.fe_edit_duplicate(),
    split: (exp) => exp.fe_edit_split(),
    fill: (exp) => exp.fe_edit_fill(),
    bridge: (exp) => exp.fe_edit_bridge(),
    merge: (exp) => exp.fe_edit_merge_center(),
    weld: (exp) => exp.fe_edit_merge_distance(amountOf('weld')),
    collapse: (exp) => exp.fe_edit_collapse(),
    bisect: (exp) => {
      const axis = amountOf('bisect');
      const normal = [0, 0, 0];
      normal[axis] = 1;
      return exp.fe_edit_bisect(0, 0, 0, normal[0], normal[1], normal[2], 1, 1, 1);
    },
    symmetrize: (exp) => exp.fe_edit_symmetrize(amountOf('symmetrize')),
    delete: (exp) => exp.fe_edit_delete(MODES[state.mode].kind),

    recalc: (exp) => exp.fe_edit_recalc_normals(1),
    flip: (exp) => exp.fe_edit_flip_normals(),
    smooth: (exp) => { exp.fe_edit_set_shade(1); return exp.fe_edit_tri_count(); },
    flat: (exp) => { exp.fe_edit_set_shade(0); return exp.fe_edit_tri_count(); },
    sharp: (exp) => exp.fe_edit_mark_sharp(1),
    seam: (exp) => exp.fe_edit_mark_seam(1)
  };

  /* Tools that change the mesh push their own snapshot; selecting does not, and
     a tool that changed nothing must not leave an empty undo step behind. */
  const MUTATING = new Set([
    'move', 'rotate', 'scale', 'shrink', 'slide', 'shear', 'sphere', 'bend', 'randomize', 'align', 'mirror',
    'extrude', 'inset', 'subdivide', 'bevel', 'poke', 'duplicate', 'split', 'fill', 'bridge', 'merge',
    'weld', 'collapse', 'bisect', 'symmetrize', 'delete', 'recalc', 'flip', 'sharp', 'seam'
  ]);

  function runTool(id) {
    const exp = exportsOf();
    if (!exp) { toast('The engine is still loading.'); return 0; }
    const tool = BY_ID.get(id);
    if (!tool) return 0;
    state.tool = id;
    if (tool.cat !== state.category) {
      state.category = tool.cat;
      renderSheet();
      setBarState();
    }
    syncSheet();

    const handler = COMMANDS[id];
    if (!handler) { refresh(); return 0; }  /* gesture tools have no immediate action */

    const before = exp.fe_edit_undo_depth();
    let result = 0;
    try {
      result = handler(exp);
    } catch (error) {
      console.error('[FEEditMode] tool failed', id, error);
      toast('That tool could not run on this selection.');
      result = 0;
    }
    refresh();
    if (MUTATING.has(id) && exp.fe_edit_undo_depth() > before && !result) {
      exp.fe_edit_undo();
      refresh();
      toast('Nothing changed for that tool on this selection.');
      return 0;
    }
    if (id === 'smooth' || id === 'flat') {
      /* Say what was shaded. "Shade Flat" with a face under the finger is one
         face going flat next to a smooth neighbour, which looks like nothing
         happened unless the message counts them. */
      const faces = state.mode === 'face' ? exp.fe_edit_sel_count() : 0;
      toast(faces ? `${tool.label} · ${faces} face${faces === 1 ? '' : 's'}` : tool.label);
    }
    return result;
  }

  /* What the current mode will and will not pick, in one line. This is the
     promise the mode makes: a box dragged over a whole cube selects its eight
     points and nothing else, so the line says so rather than leaving the user
     to find out by tapping. */
  function modeText() {
    if (state.mode === 'edge') return 'Edges only';
    if (state.mode === 'face') return 'Faces only';
    return 'Vertices only';
  }

  /* ---- sheet UI ----------------------------------------------------------- */

  /* The only thing this feature adds to the main toolbar: one button, made
     here, that opens the panel of edit tools. Nothing that was already in the
     toolbar is touched, moved or hidden, and the button goes away with the
     mode. The toolbar is rewritten by the app when the object tools open, so a
     small observer puts the button back if that happens while editing. */
  let barBound = false;
  let toolsObserver = null;
  let toolsButton = null;

  function editToolsButton() {
    return toolsButton && toolsButton.parentNode ? toolsButton : null;
  }

  function makeEditToolsButton() {
    const bar = activeToolbar();
    if (!bar) return null;
    if (toolsButton && toolsButton.parentNode === bar) return toolsButton;
    const button = document.createElement('button');
    button.className = 'tool';
    button.id = 'edit-tools-btn';
    button.type = 'button';
    button.dataset.editTools = '1';
    button.innerHTML = '<i class="ico" data-ico="extrude"></i><span>Edit tools</span>';
    button.onclick = (event) => {
      event?.stopPropagation?.();
      const sheet = byId('edit-sheet');
      if (sheet && sheet.classList.contains('open')) closeSheet();
      else { renderSheet(); openSheet(); }
      setBarState();
    };
    /* First in the row: the toolbar scrolls, and a button appended past the
       fold is a button nobody finds. Nothing that was already here is
       rewritten, moved away or hidden; this one merely sits in front. */
    if (bar.firstChild) bar.insertBefore(button, bar.firstChild);
    else bar.appendChild(button);
    toolsButton = button;
    global.FEIcons?.hydrate?.(button);
    return button;
  }

  function removeEditToolsButton() {
    if (toolsButton?.parentNode) toolsButton.parentNode.removeChild(toolsButton);
    toolsButton = null;
    toolsObserver?.disconnect?.();
    toolsObserver = null;
  }

  function bindCategoryBar() {
    const bar = byId('edit-category-bar');
    /* Bound on every pass, not once: the row is the shipped markup, and a
       sheet that is rebuilt or re-opened must never come back with three
       buttons that look live and are not. Three assignments are free. */
    modeButtons().forEach((button) => {
      button.onclick = () => setMode(button.dataset.editMode);
    });
    if (!bar) { setBarState(); return; }
    if (!barBound) {
      /* Categories and the point / edge / face switch are the panel's own
         header: tapping the open category folds the tools away, tapping
         another one switches to it. */
      bar.querySelectorAll('[data-edit-category]').forEach((button) => {
        button.onclick = () => {
          const id = button.dataset.editCategory;
          const sheet = byId('edit-sheet');
          const open = !!(sheet && !sheet.hidden && sheet.classList.contains('open'));
          if (open && id === state.category) {
            closeSheet();
            setBarState();
            return;
          }
          state.category = id;
          renderSheet();
          openSheet();
          setBarState();
        };
      });
      /* Undo and redo are not repeated here. They live in the top bar, they
         already work on this mesh, and a second pair would be two buttons that
         do the same thing in the same app. */
      const xray = byId('edit-xray');
      if (xray) xray.onclick = () => { state.xray = !state.xray; setBarState(); refresh(); };
      const snap = byId('edit-snap');
      if (snap) snap.onclick = () => { state.snap = !state.snap; applySnap(); setBarState(); syncSheet(); };
      const done = byId('edit-done');
      if (done) done.onclick = () => exit();
      const close = byId('edit-sheet-close');
      if (close) close.onclick = () => { closeSheet(); setBarState(); };
      barBound = true;
    }
    global.FEIcons?.hydrate?.(bar);
    makeEditToolsButton();
    setBarState();
  }

  function setBarState() {
    const toggle = editToolsButton();
    if (toggle) {
      const sheet = byId('edit-sheet');
      const open = !!(sheet && sheet.classList.contains('open'));
      toggle.setAttribute('aria-pressed', String(open));
      toggle.classList.toggle('active', open);
    }
    modeButtons().forEach((button) => {
      const on = button.dataset.editMode === state.mode;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    });
    const modeHint = byId('edit-mode-hint');
    if (modeHint) modeHint.textContent = modeText();
    const bar = byId('edit-category-bar');
    if (!bar) return;
    bar.querySelectorAll('[data-edit-category]').forEach((button) => {
      const on = button.dataset.editCategory === state.category;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    });
    const xray = byId('edit-xray');
    if (xray) { xray.classList.toggle('active', state.xray); xray.setAttribute('aria-pressed', String(state.xray)); }
    const snap = byId('edit-snap');
    if (snap) { snap.classList.toggle('active', state.snap); snap.setAttribute('aria-pressed', String(state.snap)); }
  }

  function renderSheet() {
    const body = byId('edit-sheet-tools');
    const title = byId('edit-sheet-title');
    if (!body) return;
    const category = CATEGORIES.find((cat) => cat.id === state.category) || CATEGORIES[0];
    if (title) title.textContent = category.label;
    const tools = TOOLS.filter((tool) => tool.cat === category.id);
    body.innerHTML = tools.map((tool) => `
      <button class="edit-tool${tool.id === state.tool ? ' on' : ''}" type="button" data-edit-command="${tool.id}" title="${tool.hint || tool.label}">
        <i class="ico" data-ico="${tool.icon}"></i><span>${tool.label}</span>
      </button>`).join('');
    body.querySelectorAll('[data-edit-command]').forEach((button) => {
      button.onclick = () => runTool(button.dataset.editCommand);
    });
    global.FEIcons?.hydrate?.(body);
    const row = modeRow();
    if (row) row.hidden = false;
    syncSheet();
    setBarState();
  }

  function syncSheet() {
    const body = byId('edit-sheet-tools');
    if (body) {
      body.querySelectorAll('[data-edit-command]').forEach((button) => {
        button.classList.toggle('on', button.dataset.editCommand === state.tool);
      });
    }
    const tool = BY_ID.get(state.tool);
    const amountRow = byId('edit-amount-row');
    const amountInput = byId('edit-amount');
    const amountLabel = byId('edit-amount-label');
    const amountOut = byId('edit-amount-out');
    if (amountRow && amountInput && tool?.amount) {
      const spec = tool.amount;
      const value = amountOf(tool.id);
      amountRow.hidden = false;
      if (amountLabel) amountLabel.textContent = spec.label;
      if (spec.axis) {
        amountInput.type = 'range';
        amountInput.min = '0'; amountInput.max = '2'; amountInput.step = '1';
        amountInput.value = String(value);
        if (amountOut) amountOut.textContent = ['X', 'Y', 'Z'][Math.round(Number(value))] || 'X';
      } else {
        amountInput.type = 'range';
        amountInput.min = String(spec.min);
        amountInput.max = String(spec.max);
        amountInput.step = String(spec.step);
        amountInput.value = String(value);
        if (amountOut) amountOut.textContent = `${fmt(value, spec.step < 0.01 ? 3 : 2)}${spec.unit || ''}`;
      }
      amountInput.oninput = () => {
        state.amount[tool.id] = Number(amountInput.value);
        if (amountOut) {
          amountOut.textContent = spec.axis
            ? (['X', 'Y', 'Z'][Math.round(Number(amountInput.value))] || 'X')
            : `${fmt(Number(amountInput.value), spec.step < 0.01 ? 3 : 2)}${spec.unit || ''}`;
        }
      };
    } else if (amountRow) {
      amountRow.hidden = true;
    }

    const exactRow = byId('edit-exact-row');
    if (exactRow) exactRow.hidden = state.tool !== 'exact';

    const hint = byId('edit-hint');
    if (hint) hint.textContent = tool?.hint || hintText(tool);

    const status = byId('edit-status-line');
    if (status) {
      const label = state.mode === 'vertex' ? 'verts' : state.mode === 'edge' ? 'edges' : 'faces';
      status.textContent = `${stats.verts.toLocaleString()} verts · ${stats.edges.toLocaleString()} edges · ${stats.faces.toLocaleString()} faces · ${stats.selected.toLocaleString()} ${label} selected`;
    }
    const prop = byId('edit-prop');
    if (prop) { prop.classList.toggle('on', state.propEnabled); prop.setAttribute('aria-pressed', String(state.propEnabled)); }
    const propRow = byId('edit-prop-row');
    if (propRow) propRow.hidden = !state.propEnabled;
    const propRadius = byId('edit-prop-radius');
    if (propRadius) {
      propRadius.value = String(state.propRadius);
      const out = byId('edit-prop-radius-out');
      if (out) out.textContent = fmt(state.propRadius, 2);
    }
    const axis = byId('edit-axis');
    if (axis) axis.value = String(state.axis);
  }

  function hintText(tool) {
    if (!tool) return '';
    const element = state.mode === 'edge' ? 'edge' : state.mode === 'face' ? 'face' : 'point';
    /* Under the Select category the line describes the rule the switched-on
       mode follows, because the rule really is different: a box takes a point
       when the point is inside it, an edge only when both of its ends are, and
       a face only when all three of its corners are. */
    if (tool.cat === 'select') {
      if (state.mode === 'edge') return 'Taps and boxes take whole edges. Drag one finger elsewhere to orbit.';
      if (state.mode === 'face') return 'Taps and boxes take a whole face. Drag one finger elsewhere to orbit.';
      return 'Taps and boxes take points. Drag one finger elsewhere to orbit.';
    }
    if (stats.selected === 0) return `Tap a ${element} to select it, then use this tool. Drag one finger elsewhere to orbit.`;
    if (tool.id === 'move' || tool.id === 'pick') return 'Drag an arrow to move the selection. Drag the mesh elsewhere to orbit.';
    if (tool.id === 'rotate') return 'Drag a ring to turn the selection.';
    if (tool.id === 'scale') return 'Drag a bar to scale the selection.';
    if (tool.id === 'extrude') return state.mode === 'face' ? 'Extrude the selected faces along their normals.' : 'Extrude each selected face on its own.';
    return '';
  }

  function openSheet() {
    const sheet = byId('edit-sheet');
    if (!sheet) return;
    sheet.hidden = false;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeSheet() {
    const sheet = byId('edit-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    sheet.hidden = true;
    sheet.setAttribute('aria-hidden', 'true');
  }

  /* ---- undo / redo / modes ------------------------------------------------- */

  function undoAction() {
    const exp = exportsOf();
    if (!exp) return;
    if (exp.fe_edit_undo_depth() === 0) { toast('Nothing to undo.'); return; }
    exp.fe_edit_undo();
    refresh();
  }

  function redoAction() {
    const exp = exportsOf();
    if (!exp) return;
    if (exp.fe_edit_redo_depth() === 0) { toast('Nothing to redo.'); return; }
    exp.fe_edit_redo();
    refresh();
  }

  function applySnap() {
    const exp = exportsOf();
    if (!exp) return;
    exp.fe_edit_set_snap(state.snap ? 1 : 0, 0.25);
  }

  function applyProportional() {
    const exp = exportsOf();
    if (!exp) return;
    exp.fe_edit_set_proportional(state.propEnabled ? 1 : 0, state.propFalloff, state.propRadius, 1);
  }

  function setMode(mode) {
    if (!MODES[mode]) return;
    state.mode = mode;
    exportsOf()?.fe_edit_set_mode(MODES[mode].kind);
    setBarState();
    refresh();
  }

  /* ---- keyboard ------------------------------------------------------------ */

  function onKeyDown(event) {
    if (!state.active) return;
    const tag = (event.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      event.shiftKey ? redoAction() : undoAction();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redoAction(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const gesture = (id) => { state.tool = id; syncSheet(); toast(BY_ID.get(id)?.label || id); };
    switch (key) {
      case '1': setMode('vertex'); return;
      case '2': setMode('edge'); return;
      case '3': setMode('face'); return;
      case 'a': exportsOf()?.fe_edit_select_all(); refresh(); return;
      case 'b': gesture('box'); return;
      case 'c': gesture('circle'); return;
      case 'g': gesture('move'); return;
      case 'r': gesture('rotate'); return;
      case 's': gesture('scale'); return;
      case 'e': runTool('extrude'); return;
      case 'i': runTool('inset'); return;
      case 'delete':
      case 'backspace': event.preventDefault(); runTool('delete'); return;
      case 'escape':
        if (state.drag) { state.drag = null; clearMarquee(); captureOrbit(true); }
        closeSheet();
        return;
      default: break;
    }
  }

  /* ---- enter / exit -------------------------------------------------------- */

  function enter() {
    const eng = engine();
    if (!eng) { toast('The engine is still loading.'); return false; }
    if (!eng.ready) {
      toast('Preparing the engine…');
      eng.init?.().then(() => enter(), () => toast('The engine could not start.'));
      return false;
    }
    /* A cached shell can outlive the artifact it was built against. Say so
       instead of throwing on the first missing entry point. */
    if (typeof eng.exports?.fe_edit_upload !== 'function') {
      toast('This build does not include the mesh editor. Reload the app to update it.');
      return false;
    }
    const object = activeObject();
    if (!object) { toast('Select a mesh in the scene first.'); return false; }
    if (exportsOf().fe_edit_vert_count() && state.target === object && state.active) return true;
    if (!upload(object)) return false;

    /* The overlay draws the kernel mesh, so a deformed output left on screen
       would leave the wireframe floating away from the shape under the finger.
       The parked output is released on exit, after the stack is rebuilt. */
    const cageToShow = object.userData?.baseGeometry ||
      (object.userData?.feEditCage && object.userData.feEditCage.attributes?.position ? object.userData.feEditCage : null);
    if (cageToShow?.attributes?.position && object.geometry !== cageToShow) {
      state.parkedGeometry = object.geometry;
      object.geometry = cageToShow;
      object.userData.forceModUpdate = true;
    }

    state.active = true;
    state.target = object;
    state.mode = 'vertex';
    state.tool = 'pick';
    state.category = 'select';
    state.overlay = null;
    disposeGizmo();
    stats.selected = 0;
    view.capacity = 0; view.index = null; view.geometry = null;
    state.ringSegments = null;
    state.ringStamp = '';

    const exp = exportsOf();
    exp.fe_edit_undo_clear();
    exp.fe_edit_set_mode(0);
    applySnap();
    applyProportional();
    exp.fe_edit_build_render();

    /* The object gizmo and the orange selection outline both describe the
       shape as it was before it was edited: an attach handle for whole-object
       transforms that are not what this mode does, and an outline that would
       sit at the old silhouette while the wireframe moves. Both step aside
       for the duration and come back on exit. */
    const eng2 = core();
    /* Remember which object the object-mode gizmo was attached to, so leaving
       Edit Mode can hand it back. Forcing `visible = true` on a detached
       TransformControls (which is what used to happen here) parks its handles
       wherever the object last was, with nothing to move. */
    state.gizmoRestore = eng2?.transformControls
      ? { object: eng2.transformControls.object || null, mode: eng2.transformControls.getMode?.() || 'translate' }
      : null;
    eng2?.transformControls?.detach?.();
    if (eng2?.transformControls) eng2.transformControls.visible = false;
    removeSelectionOutlines(object);
    state.hiddenOutline = null;
    startHelperGuard();
    document.body?.classList.add('edit-mode');

    bindCategoryBar();
    renderSheet();
    openSheet();
    attachPointer();
    /* The app rewrites the object toolbar when its own tools open. While this
       mode is live, the one edit button is part of that toolbar and has to
       survive the rewrite. */
    const bar = activeToolbar();
    if (bar && typeof global.MutationObserver === 'function') {
      toolsObserver?.disconnect?.();
      toolsObserver = new global.MutationObserver(() => {
        if (state.active && (!toolsButton || !toolsButton.parentNode)) makeEditToolsButton();
      });
      toolsObserver.observe(bar, { childList: true });
    }
    refresh();
    global.dispatchEvent(new CustomEvent('fe:editmode', { detail: { active: true } }));
    toast('Edit Mode — tap a point to select it, then drag the arrows');
    return true;
  }

  function exit() {
    if (!state.active) return;
    state.active = false;
    stopHelperGuard();
    state.drag = null;
    detachPointer();
    clearMarquee();
    if (state.overlay?.parent) state.overlay.parent.remove(state.overlay);
    state.overlay = null;
    disposeGizmo();
    commitToObject();
    const committed = state.target;
    state.target = null;
    state.view = null;
    closeSheet();
    document.body?.classList.remove('edit-mode');
    removeEditToolsButton();
    const eng = core();
    if (eng?.oc) { eng.oc.enableRotate = true; eng.oc.enablePan = true; eng.oc.enabled = true; }
    /* `detach()` owns `visible`, and the app only shows the handles while one
       of the Move / Rotate / Scale / Transform panels is open, so re-sync
       through the app's own selection path and detach when there is nothing
       for the gizmo to hold. */
    const gizmoRestore = state.gizmoRestore;
    state.gizmoRestore = null;
    if (eng?.transformControls) {
      /* Only a visible transform panel shows the handles, so ask the panels
         rather than assuming: `activeObject` lives in the workspace script's
         own scope and is not readable from here. */
      const panelWantsGizmo = ['move', 'rotate', 'scale', 'transform'].some((name) => {
        const panel = byId('panel-' + name);
        return !!panel && !panel.hidden && panel.style.display !== 'none';
      });
      const held = gizmoRestore?.object;
      if (panelWantsGizmo && held && held.parent && !held.userData?.isLocked) {
        held.frustumCulled = false;
        held.updateMatrix();
        held.updateMatrixWorld(true);
        eng.transformControls.attach(held);
        if (gizmoRestore?.mode) eng.transformControls.setMode(gizmoRestore.mode);
      } else {
        eng.transformControls.detach();
      }
      eng.transformControls.updateMatrixWorld(true);
    }
    /* The outline is a copy of the geometry's edges, so the old one has to go:
       the shape it was drawn around no longer exists. */
    const outline = state.hiddenOutline;
    state.hiddenOutline = null;
    if (outline) {
      outline.parent?.remove(outline);
      outline.geometry?.dispose?.();
      outline.material?.dispose?.();
    }
    if (typeof global.applyMeshSelectionOutline === 'function') {
      const activeId = global.FE?.getActiveObjectId?.();
      try { global.applyMeshSelectionOutline(activeId || undefined); } catch { /* no selection to outline */ }
    }
    if (committed) {
      /* Rebuild the stack from the cage that was just edited, so a deform is
         applied once, to the mesh the user changed. */
      if ((committed.userData?.modStack || []).some((mod) => mod.enabled) && typeof global.updateModifiersOnScene === 'function') {
        try {
          committed.userData.forceModUpdate = true;
          global.updateModifiersOnScene(committed);
        } catch (error) {
          console.warn('[FEEditMode] Could not rebuild the modifier stack:', error);
        }
      }
      const parked = state.parkedGeometry;
      state.parkedGeometry = null;
      if (parked && parked !== committed.geometry && parked !== committed.userData?.baseGeometry) {
        parked.dispose?.();
      }
    }

    /* Keep the mode dropdown honest: Edit Mode can be left from the bar, from
       the dropdown, or by leaving the studio. */
    const modeSelect = byId('core-mode');
    if (modeSelect && modeSelect.value === 'edit') modeSelect.value = 'object';
    global.dispatchEvent(new CustomEvent('fe:editmode', { detail: { active: false } }));
    toast('Left Edit Mode');
  }

  /* `fe:mode` is dispatched on document (and does not bubble), so it has to be
     listened for there, not on window. */
  const events = typeof document !== 'undefined' ? document : global;
  if (events.addEventListener) events.addEventListener('keydown', onKeyDown);
  events.addEventListener?.('fe:mode', (event) => {
    if (event.detail?.studio !== 'core') return;
    if (event.detail.mode === 'edit') enter();
    else if (state.active) exit();
  });
  events.addEventListener?.('fe:screen', (event) => {
    /* Leaving the 3D Workspace leaves its mode: the kernel still holds the
       mesh, but nothing on screen can edit it any more. */
    if (state.active && event.detail?.to && event.detail.to !== 'core') exit();
  });

  /* ---- public API ---------------------------------------------------------- */

  global.FEEditMode = {
    TOOLS: TOOLS.map((tool) => ({ ...tool })),
    CATEGORIES,
    /* Introspection for the test suite: which tools have an immediate kernel
       call, and which ones own the drag instead. */
    implemented: () => Object.keys(COMMANDS),
    gestures: () => [...DRAG_TOOLS],
    taps: () => ['pick'],
    enter,
    exit,
    isActive: () => state.active,
    state,
    refresh,
    runTool,
    setMode,
    undo: undoAction,
    redo: redoAction,
    openSheet,
    closeSheet,
    stats: () => ({ ...stats }),
    /* Which object the kernel currently holds, so the app can tell whether a
       selection it is about to read belongs to the mesh it is weighting. */
    target: () => state.target || null,
    /* One byte per vertex of the cage mesh, in the same order the object's
       base geometry uses. null when Edit Mode is not running or the kernel has
       nothing loaded - the caller has to say so rather than weight nothing. */
    selectedVertices() {
      const exp = exportsOf();
      if (!state.active || !exp || typeof exp.fe_edit_vert_sel_ptr !== 'function') return null;
      const count = exp.fe_edit_vert_count();
      if (!count) return null;
      return new Uint8Array(memory(), exp.fe_edit_vert_sel_ptr(), count).slice();
    },
    setProportional(enabled) {
      state.propEnabled = !!enabled;
      applyProportional();
      syncSheet();
    },
    setFalloff(value) {
      state.propFalloff = Math.max(0, Math.min(5, Number(value) || 0));
      applyProportional();
      syncSheet();
    },
    setRadius(value) {
      state.propRadius = Math.max(0.05, Number(value) || 1);
      applyProportional();
      syncSheet();
    },
    setAxis(value) {
      state.axis = Math.max(0, Math.min(6, Number(value) || 0));
      syncSheet();
    }
  };

  /* The sheet's own controls are bound here so index.html carries markup only. */
  if (typeof document !== 'undefined') {
    const bind = () => {
      const prop = byId('edit-prop');
      if (prop) prop.onclick = () => global.FEEditMode.setProportional(!state.propEnabled);
      const falloff = byId('edit-prop-falloff');
      if (falloff) falloff.onchange = () => global.FEEditMode.setFalloff(falloff.value);
      const radius = byId('edit-prop-radius');
      if (radius) radius.oninput = () => global.FEEditMode.setRadius(radius.value);
      const axis = byId('edit-axis');
      if (axis) axis.onchange = () => global.FEEditMode.setAxis(axis.value);
      const close = byId('edit-sheet-close');
      if (close) close.onclick = closeSheet;
      const apply = byId('edit-exact-apply');
      if (apply) apply.onclick = () => runTool('exact');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
    else bind();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
