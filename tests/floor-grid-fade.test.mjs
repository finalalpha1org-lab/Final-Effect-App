import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* The viewport floor is a line grid, not a plane, so nothing can be "behind"
   it in the depth buffer - and yet an object moved below it vanished. The
   cause is the grid itself: seen from just above the plane, its far half
   compresses into a band of lines a few pixels deep that is drawn over every
   pixel below y = 0. The fix is a distance fade in the grid's own shader,
   driven by two uniforms the viewport loop keeps in step with the camera.

   A shader patch is only as good as its anchors, so this test runs the real
   block from index.html against the vendored three.js and inspects the shader
   it produces: if an upgrade moves `project_vertex` or `dithering_fragment`,
   the patch must skip itself rather than emit a shader that does not compile
   (a grid with no fade is still a grid; a grid with a broken shader is not). */

const html = readFileSync('index.html', 'utf8');

function loadThree() {
  const source = readFileSync('vendor/three/three.min.js', 'utf8');
  const sandbox = { console };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'three.min.js' });
  return sandbox.THREE;
}

function gridBlock() {
  const start = html.indexOf('const gridFade = { start:');
  assert.ok(start > 0, 'the grid fade block is missing from index.html');
  const end = html.indexOf('leave the plain grid in place', start);
  assert.ok(end > start, 'the grid fade block has no closing guard');
  return html.slice(start, html.indexOf('}\n', end) + 2);
}

function runBlock(THREE) {
  const grid = new THREE.GridHelper(50, 50, 0x818cf8, 0x2a2e3d);
  const context = vm.createContext({ THREE, grid, console });
  vm.runInContext(gridBlock(), context, { filename: 'grid-fade.js' });
  return grid;
}

test('the grid fade patch compiles against the vendored three.js', () => {
  const THREE = loadThree();
  assert.equal(THREE.REVISION, '128', 'the anchor check below is written for the vendored r128 shaders');
  const grid = runBlock(THREE);

  assert.equal(typeof grid.material.onBeforeCompile, 'function',
    'the fade has to reach the grid material, or the floor keeps its old look');
  /* The fade is alpha, so the material has to be transparent and must still
     keep out of the depth buffer - the grid is a floor you see through. */
  assert.ok(html.includes('grid.material.transparent = true;'), 'the grid is not transparent, so the fade cannot show');
  assert.ok(html.includes('grid.material.depthWrite = false;'), 'the grid writes depth, which is what hides the floor');
  assert.ok(grid.material.userData.feGridFade, 'the loop needs the uniforms hanging off the material');

  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader
  };
  grid.material.onBeforeCompile(shader);

  assert.equal(shader.uniforms.feGridFadeStart, grid.material.userData.feGridFade.start,
    'the vertex/fragment alpha must read the uniform the loop updates');
  assert.equal(shader.uniforms.feGridFadeEnd, grid.material.userData.feGridFade.end);

  /* The varying has to be declared in both stages and written where the
     model-view position exists, otherwise the shader fails to link. */
  assert.match(shader.vertexShader, /^varying float vFeGridDepth;/);
  assert.ok(shader.vertexShader.includes('#include <project_vertex>'));
  assert.ok(shader.vertexShader.includes('vFeGridDepth = - mvPosition.z;'),
    'the depth written has to come from the transformed vertex');
  assert.match(shader.fragmentShader, /^uniform float feGridFadeStart;/);
  assert.ok(shader.fragmentShader.includes('varying float vFeGridDepth;'));
  assert.ok(shader.fragmentShader.includes('gl_FragColor.a *= 1.0 - smoothstep( feGridFadeStart, feGridFadeEnd, vFeGridDepth );'),
    'the line alpha is what has to fade, not the colour');

  /* Order matters: the multiply has to land after the final colour and alpha
     are assembled, or it is overwritten by the next chunk. */
  const fadeAt = shader.fragmentShader.indexOf('gl_FragColor.a *= 1.0 - smoothstep');
  assert.ok(fadeAt > shader.fragmentShader.indexOf('gl_FragColor = vec4( outgoingLight'),
    'the fade runs before the colour is written - it would do nothing');
  assert.ok(!shader.fragmentShader.includes('uniform float feGridFadeStart;', fadeAt),
    'the declaration must stay at the top of the shader');
});

test('the fade never reaches the floor under the camera', () => {
  const THREE = loadThree();
  const grid = runBlock(THREE);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
  grid.material.onBeforeCompile(shader);

  /* A wall of lines is made by the far field. The fade window therefore has to
     start well outside the camera's own distance to the grid centre, and open
     it up (fadeEnd > fadeStart) over a span of several metres so the floor
     dissolves gradually instead of ending in a hard ring. */
  const start = shader.uniforms.feGridFadeStart.value;
  const end = shader.uniforms.feGridFadeEnd.value;
  assert.ok(start >= 18, `fade starts too close to the model: ${start}`);
  assert.ok(end - start >= 10, `fade window is a hard edge, not a fade: ${start}..${end}`);
  assert.ok(end <= 60, `fade window runs past the grid itself: ${end}`);

  /* The loop is the only writer of those uniforms at runtime - a fade stuck on
     its initial values would cut the floor at a fixed distance forever. */
  const loop = html.slice(html.indexOf('const activeCam = isCameraView'), html.indexOf('const renderStart=performance.now()', html.indexOf('const activeCam = isCameraView')));
  assert.ok(loop.includes('const gridFade = this.grid?.material?.userData?.feGridFade;'), 'the loop must find the uniforms through eng.grid');
  assert.ok(loop.includes('Math.hypot(activeCam.position.x, activeCam.position.y, activeCam.position.z)'), 'the fade is measured from the camera');
  assert.ok(loop.includes('gridFade.start.value = fadeStart;') && loop.includes('gridFade.end.value = fadeStart + 16;'),
    'both uniforms follow the camera');
  assert.ok(html.includes('this.grid = grid;'), 'eng.grid is what the loop reads, so the grid has to be on the engine');
});
