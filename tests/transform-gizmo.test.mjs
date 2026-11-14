import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* The other half of "some axes cannot move the object": the gizmo itself.
 *
 * The shell hides axes with `transformControls.showX/Y/Z` and, separately,
 * doubles every pick volume so a finger can catch a thin arrow
 * (`feWidenGizmoTargets`). Either of those can quietly cost an axis - a needle
 * that cannot be grabbed reads exactly like an axis that does not work.
 *
 * This loads the vendored three.js and TransformControls and drives them the
 * way a finger does: aim at the arrow that is drawn, hover, press, drag,
 * release. The camera is real, so the screen points are the points the user
 * would touch. */

const threeSource = readFileSync('vendor/three/three.min.js', 'utf8');
const controlsSource = readFileSync('vendor/three/TransformControls.js', 'utf8');

function loadThree() {
  const sandbox = { console };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(threeSource, sandbox, { filename: 'three.min.js' });
  vm.runInContext(controlsSource, sandbox, { filename: 'TransformControls.js' });
  return sandbox.THREE;
}

function rig() {
  const THREE = loadThree();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  camera.position.set(7, 6, 9);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  scene.add(mesh, camera);

  const dom = {
    style: {}, addEventListener() {}, removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
    getRootNode() { return { addEventListener() {}, removeEventListener() {} }; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  };
  const controls = new THREE.TransformControls(camera, dom);
  scene.add(controls);
  controls.attach(mesh);
  controls.setMode('translate');

  const refresh = () => {
    mesh.updateMatrixWorld(true);
    controls.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
  };
  /* Where an arrow is drawn. Each handle's offset is baked into its geometry,
     so the centre of its bounding sphere is a point on the artwork. */
  const screenPointOf = (handle) => {
    handle.geometry.computeBoundingSphere();
    const p = handle.geometry.boundingSphere.center.clone().applyMatrix4(handle.matrixWorld);
    return p.project(camera);
  };

  refresh();
  const handles = {};
  for (const child of controls._gizmo.picker.translate.children) handles[child.name] = child;
  return { THREE, camera, mesh, controls, refresh, screenPointOf, handles };
}

test('each arrow of the move gizmo moves the object along its own axis', () => {
  const { THREE, mesh, controls, refresh, screenPointOf, handles } = rig();
  for (const axis of ['X', 'Y', 'Z']) {
    mesh.position.set(0, 0, 0);
    refresh();

    const start = screenPointOf(handles[axis]);
    controls.pointerHover(new THREE.Vector2(start.x, start.y));
    assert.equal(controls.axis, axis, `aiming at the ${axis} arrow selected ${controls.axis}`);

    controls.pointerDown({ x: start.x, y: start.y, button: 0 });
    assert.equal(controls.dragging, true, `pressing the ${axis} arrow did not start a drag`);
    controls.pointerMove({ x: start.x + 0.12, y: start.y - 0.08, button: -1 });
    controls.pointerUp({ button: 0 });
    refresh();

    const d = mesh.position;
    assert.ok(d.length() > 0.05, `dragging ${axis} left the object where it was`);
    for (const other of ['x', 'y', 'z'].filter((k) => k !== axis.toLowerCase())) {
      assert.ok(Math.abs(d[other]) < 1e-6,
        `dragging ${axis} also moved ${other.toUpperCase()} by ${d[other]}`);
    }
  }
});

test('an axis hidden by the shell cannot be grabbed by accident', () => {
  /* The Move panel restricts the gizmo with showX/showY/showZ. A hidden handle
     that still answers the raycast is worse than a dead axis: the object moves
     along an axis the user was told was locked. */
  const { THREE, mesh, controls, refresh, screenPointOf, handles } = rig();
  for (const axis of ['X', 'Y', 'Z']) {
    mesh.position.set(0, 0, 0);
    controls.showX = axis !== 'X';
    controls.showY = axis !== 'Y';
    controls.showZ = axis !== 'Z';
    refresh();
    const hidden = screenPointOf(handles[axis]);
    controls.pointerHover(new THREE.Vector2(hidden.x, hidden.y));
    assert.notEqual(controls.axis, axis, `the hidden ${axis} handle is still pickable`);
  }
  controls.showX = controls.showY = controls.showZ = true;
});
