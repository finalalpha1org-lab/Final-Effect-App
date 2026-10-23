/* FE_TAA - a real temporal anti-aliasing pass (history buffer + reprojection)
   for the 3D workspace.

   Pipeline per frame:
     1. jitter the projection matrix by a Halton(2,3) sub-pixel offset
     2. render the scene into an RGBA + depth target
     3. reproject the previous frame through the *previous* view-projection
        (world position reconstructed from the depth texture)
     4. clip the history to the 3x3 neighbourhood of the current frame
     5. blend and copy to the screen, then ping-pong the history target

   Everything is guarded: no WebGL2, no depth texture, a throw inside the pass
   or an explicit setEnabled(false) all fall back to a plain renderer.render().
   The math (halton / jitter / projectToUv) is pure and covered by tests without
   a GPU.
*/
(function (global) {
  'use strict';

  const HALTON_CACHE = new Map();

  function halton(index, base) {
    let i = Math.max(0, Math.floor(index));
    let f = 1, result = 0;
    while (i > 0) {
      f /= base;
      result += f * (i % base);
      i = Math.floor(i / base);
    }
    return result;
  }

  const cachedHalton = (index, base) => {
    const key = `${base}:${index}`;
    let value = HALTON_CACHE.get(key);
    if (value === undefined) {
      value = halton(index, base);
      if (HALTON_CACHE.size > 4096) HALTON_CACHE.clear();
      HALTON_CACHE.set(key, value);
    }
    return value;
  };

  /* Sub-pixel offset in clip-space units. The 1-based Halton index keeps the
     first frame off-centre; the amplitude is one pixel. */
  function jitter(frame, width, height) {
    const w = Math.max(1, width), h = Math.max(1, height);
    const index = (Math.max(0, Math.floor(frame)) % 64) + 1;
    return {
      x: (cachedHalton(index, 2) - 0.5) * 2 / w,
      y: (cachedHalton(index, 3) - 0.5) * 2 / h
    };
  }

  /* Pure reprojection used by the shader and by the tests. */
  function projectToUv(prevViewProjection, world, out) {
    const e = prevViewProjection.elements || prevViewProjection;
    const x = world.x, y = world.y, z = world.z;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    const target = out || { x: 0, y: 0, valid: false };
    if (!(cw > 1e-6)) { target.valid = false; return target; }
    target.x = (cx / cw) * 0.5 + 0.5;
    target.y = (cy / cw) * 0.5 + 0.5;
    target.valid = target.x > 0 && target.x < 1 && target.y > 0 && target.y < 1;
    return target;
  }

  const COMPOSITE_FRAGMENT = `
precision highp float;
uniform sampler2D tCurrent, tHistory, tDepth;
uniform mat4 uInvProjection, uCameraWorld, uPrevViewProj;
uniform vec2 uTexel;
uniform float uAlpha, uSrgb, uHistoryReady;
varying vec2 vUv;

vec3 neighbourhoodMin(vec2 uv){
  vec3 m = texture2D(tCurrent, uv).rgb;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      m = min(m, texture2D(tCurrent, uv + vec2(float(x), float(y)) * uTexel).rgb);
    }
  }
  return m;
}
vec3 neighbourhoodMax(vec2 uv){
  vec3 m = texture2D(tCurrent, uv).rgb;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      m = max(m, texture2D(tCurrent, uv + vec2(float(x), float(y)) * uTexel).rgb);
    }
  }
  return m;
}

void main(){
  vec3 current = texture2D(tCurrent, vUv).rgb;
  float depth = texture2D(tDepth, vUv).x;
  /* Rebuild the world position from the depth buffer with the *unjittered*
     inverse projection, then look it up in the previous frame. */
  vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjection * clip;
  view.xyz /= view.w;
  vec3 world = (uCameraWorld * vec4(view.xyz, 1.0)).xyz;
  vec4 prevClip = uPrevViewProj * vec4(world, 1.0);
  vec2 prevUv = prevClip.xy / max(prevClip.w, 1e-5) * 0.5 + 0.5;
  bool inside = uHistoryReady > 0.5 && prevClip.w > 0.0
    && prevUv.x > 0.0 && prevUv.x < 1.0 && prevUv.y > 0.0 && prevUv.y < 1.0;

  vec3 history = inside ? texture2D(tHistory, prevUv).rgb : current;
  /* Variance clipping: a stale sample outside the current neighbourhood is
     pulled back, which is what stops ghosting on fast motion. */
  vec3 lo = neighbourhoodMin(vUv);
  vec3 hi = neighbourhoodMax(vUv);
  history = clamp(history, lo, hi);

  float alpha = inside ? uAlpha : 1.0;
  vec3 col = mix(history, current, clamp(alpha, 0.02, 1.0));
  if (uSrgb > 0.5) col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}`;

  const VERTEX = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

  function create(renderer, options) {
    const THREE = global.THREE;
    if (!THREE || !renderer || typeof renderer.setRenderTarget !== 'function') return null;
    const caps = renderer.capabilities || {};
    /* Depth textures are the only hard requirement; without them there is no
       honest reprojection, so the pass simply stays off. */
    if (!caps.isWebGL2) return null;

    const opts = Object.assign({ blend: 0.12, srgb: null }, options || {});
    const state = {
      ok: true, enabled: opts.enabled !== false,
      frame: 0, width: 0, height: 0, historyReady: false
    };
    let sceneTarget = null, history = null, write = null;
    let composite = null, copy = null, quad = null, quadScene = null, quadCamera = null;

    const srgb = opts.srgb != null ? !!opts.srgb
      : (THREE.sRGBEncoding !== undefined && renderer.outputEncoding === THREE.sRGBEncoding);

    const makeTarget = (withDepth) => {
      const target = new THREE.WebGLRenderTarget(Math.max(1, state.width), Math.max(1, state.height), {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false
      });
      if (withDepth) {
        const depth = new THREE.DepthTexture(Math.max(1, state.width), Math.max(1, state.height));
        depth.type = THREE.UnsignedIntType;
        depth.minFilter = THREE.NearestFilter;
        depth.magFilter = THREE.NearestFilter;
        target.depthTexture = depth;
      }
      return target;
    };

    const setSize = (width, height) => {
      const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
      if (w === state.width && h === state.height) return;
      state.width = w; state.height = h;
      [sceneTarget, history, write].forEach(target => target && target.dispose && target.dispose());
      sceneTarget = makeTarget(true);
      history = makeTarget(false);
      write = makeTarget(false);
      state.historyReady = false;
      if (!quad) buildQuad();
      /* Re-bind the freshly created attachments. */
      composite.uniforms.tCurrent.value = sceneTarget.texture;
      composite.uniforms.tDepth.value = sceneTarget.depthTexture;
      composite.uniforms.tHistory.value = history.texture;
      composite.uniforms.uTexel.value.set(1 / w, 1 / h);
      composite.uniforms.uHistoryReady.value = 0;
      copy.uniforms.tCurrent.value = history.texture;
    };

    const buildQuad = () => {
      composite = new THREE.ShaderMaterial({
        uniforms: {
          tCurrent: { value: sceneTarget.texture },
          tHistory: { value: history.texture },
          tDepth: { value: sceneTarget.depthTexture },
          uInvProjection: { value: new THREE.Matrix4() },
          uCameraWorld: { value: new THREE.Matrix4() },
          uPrevViewProj: { value: new THREE.Matrix4() },
          uTexel: { value: new THREE.Vector2(1 / state.width, 1 / state.height) },
          uAlpha: { value: opts.blend },
          uSrgb: { value: srgb ? 1 : 0 },
          uHistoryReady: { value: 0 }
        },
        vertexShader: VERTEX,
        fragmentShader: COMPOSITE_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      copy = new THREE.ShaderMaterial({
        uniforms: { tCurrent: { value: write.texture }, uSrgb: { value: srgb ? 1 : 0 } },
        vertexShader: VERTEX,
        fragmentShader: `
precision highp float;
uniform sampler2D tCurrent;
uniform float uSrgb;
varying vec2 vUv;
void main(){
  vec3 col = texture2D(tCurrent, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
}`,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), composite);
      quad.frustumCulled = false;
      quadScene = new THREE.Scene();
      quadScene.add(quad);
      quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    };

    setSize(
      (renderer.getDrawingBufferSize && renderer.getDrawingBufferSize(new THREE.Vector2()).x) || renderer.domElement?.width || 1,
      (renderer.getDrawingBufferSize && renderer.getDrawingBufferSize(new THREE.Vector2()).y) || renderer.domElement?.height || 1
    );

    const prevViewProjection = new THREE.Matrix4();
    const savedProjection = new THREE.Matrix4();
    const scratch = new THREE.Vector2();

    const reset = () => { state.historyReady = false; };

    const render = (scene, camera) => {
      if (!state.ok || !state.enabled) return renderer.render(scene, camera);
      try {
        if (renderer.getDrawingBufferSize) {
          renderer.getDrawingBufferSize(scratch);
          if (scratch.x && (scratch.x !== state.width || scratch.y !== state.height)) setSize(scratch.x, scratch.y);
        }
        const offset = jitter(state.frame, state.width, state.height);
        savedProjection.copy(camera.projectionMatrix);
        camera.projectionMatrix.elements[8] += offset.x;
        camera.projectionMatrix.elements[9] += offset.y;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        camera.updateMatrixWorld();
        renderer.setRenderTarget(sceneTarget);
        renderer.render(scene, camera);
        camera.projectionMatrix.copy(savedProjection);
        camera.projectionMatrixInverse.copy(savedProjection).invert();
        camera.updateMatrixWorld();

        const u = composite.uniforms;
        u.tHistory.value = history.texture;
        u.tDepth.value = sceneTarget.depthTexture;
        u.uInvProjection.value.copy(savedProjection).invert();
        u.uCameraWorld.value.copy(camera.matrixWorld);
        u.uPrevViewProj.value.copy(prevViewProjection);
        u.uHistoryReady.value = state.historyReady ? 1 : 0;
        u.uAlpha.value = Math.max(0.02, Math.min(1, opts.blend));

        quad.material = composite;
        renderer.setRenderTarget(write);
        renderer.render(quadScene, quadCamera);

        quad.material = copy;
        renderer.setRenderTarget(null);
        renderer.render(quadScene, quadCamera);

        /* The freshly written frame becomes the history for the next one. */
        const oldHistory = history;
        history = write;
        write = oldHistory;
        u.tHistory.value = history.texture;
        copy.uniforms.tCurrent.value = history.texture;
        prevViewProjection.multiplyMatrices(savedProjection, camera.matrixWorldInverse);
        state.historyReady = true;
        state.frame++;
      } catch (error) {
        state.ok = false;
        try { renderer.setRenderTarget(null); } catch (_) {}
        renderer.render(scene, camera);
      }
    };

    return {
      get enabled() { return state.enabled; },
      get ok() { return state.ok; },
      get frame() { return state.frame; },
      get targets() { return { sceneTarget, history, write }; },
      setEnabled(value) { state.enabled = !!value; },
      setBlend(value) { opts.blend = Math.max(0.02, Math.min(1, Number(value) || 0.12)); },
      reset, setSize, render,
      dispose() {
        [sceneTarget, history, write].forEach(target => target && target.dispose && target.dispose());
        if (composite) composite.dispose();
        if (copy) copy.dispose();
        if (quad && quad.geometry) quad.geometry.dispose();
        state.ok = false;
      }
    };
  }

  global.FE_TAA = { create, halton, jitter, projectToUv, shader: COMPOSITE_FRAGMENT };
})(typeof window !== 'undefined' ? window : globalThis);
