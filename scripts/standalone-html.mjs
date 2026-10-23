export function createStandaloneTerrainHtml(html,{celestialMath,scatterSpacing,tessendorf}={}){
  if(typeof html!=='string')throw new TypeError('Terrain source must be text');
  const helpers=[['celestial-math.js',celestialMath],['scatter-spacing.js',scatterSpacing],['tessendorf-ocean.js',tessendorf]];
  let out=html;
  for(const [name,source] of helpers){
    if(typeof source!=='string'||!source)throw new Error(`Missing standalone helper: ${name}`);
    if(source.toLowerCase().includes('</script'))throw new Error(`Unsafe closing script marker in ${name}`);
    const tag=`<script src="./${name}"></script>`;
    const count=out.split(tag).length-1;
    if(count!==1)throw new Error(`Expected exactly one ${name} reference, found ${count}`);
    out=out.replace(tag,`<script>\n${source}\n</script>`);
  }
  return out;
}

export function createStandaloneAppHtml(html, {
  simulationCore,
  modifierEngine,
  feCppEngine,
  cppWasmBase64,
  simWasmBase64,
  terrainStandaloneHtml = ''
} = {}) {
  if (typeof html !== 'string') throw new TypeError('App HTML source must be text');

  const safeJson = str => JSON.stringify(str).replace(/<\/script/gi, '<\\/script');

  const bootstrapScript = `<script>
(function(){
  try { window.localStorage.getItem('__fe_probe'); } catch (_) {
    var _mem = new Map();
    try {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
          getItem: function(k){ return _mem.has(k) ? _mem.get(k) : null; },
          setItem: function(k, v){ _mem.set(k, String(v)); },
          removeItem: function(k){ _mem.delete(k); },
          clear: function(){ _mem.clear(); }
        }
      });
    } catch (__) {}
  }
  window.__FE_STANDALONE__ = true;
  window.__FE_CPP_WASM_BASE64__ = ${safeJson(cppWasmBase64 || '')};
  window.__FE_SIM_WASM_BASE64__ = ${safeJson(simWasmBase64 || '')};
  window.__FE_TERRAIN_STANDALONE_HTML__ = ${safeJson(terrainStandaloneHtml || '')};

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  var origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  window.fetch = function(input, init) {
    var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    if (urlStr.indexOf('fe_core_engine.wasm') !== -1 && window.__FE_CPP_WASM_BASE64__) {
      var bytesA = b64ToBytes(window.__FE_CPP_WASM_BASE64__);
      return Promise.resolve(new Response(bytesA.buffer, { status: 200, headers: { 'Content-Type': 'application/wasm' } }));
    }
    if (urlStr.indexOf('simulation_solver.wasm') !== -1 && window.__FE_SIM_WASM_BASE64__) {
      var bytesB = b64ToBytes(window.__FE_SIM_WASM_BASE64__);
      return Promise.resolve(new Response(bytesB.buffer, { status: 200, headers: { 'Content-Type': 'application/wasm' } }));
    }
    return origFetch ? origFetch(input, init) : Promise.reject(new Error('Fetch unavailable'));
  };
})();
</script>`;

  let out = html.replace('<link rel="manifest" href="./manifest.webmanifest">', '');
  const helpers = [
    ['simulationCore.js', simulationCore],
    ['modifier-engine.js', modifierEngine],
    ['fe-cpp-engine.js', feCppEngine]
  ];
  let injectedBootstrap = false;
  for (const [name, source] of helpers) {
    if (typeof source !== 'string' || !source) throw new Error(`Missing standalone app helper: ${name}`);
    if (source.toLowerCase().includes('</script')) throw new Error(`Unsafe closing script marker in ${name}`);
    const tag = `<script src="${name}"></script>`;
    const count = out.split(tag).length - 1;
    if (count !== 1) throw new Error(`Expected exactly one ${name} reference, found ${count}`);
    const prefix = !injectedBootstrap ? (bootstrapScript + '\n') : '';
    injectedBootstrap = true;
    out = out.replace(tag, `${prefix}<script>\n${source}\n</script>`);
  }
  return out;
}
