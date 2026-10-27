export function createStandaloneTerrainHtml(html,{feIcons,celestialMath,scatterSpacing,tessendorf,openWorld,landscapeExportPack,landscapeRealism,landscapeFlora,landscapeWeather,terrainMainParts=[],openWorldAddon,cppWasmBase64=''}={}){
  if(typeof html!=='string')throw new TypeError('Terrain source must be text');
  const helpers=[['fe-icons.js',feIcons],['celestial-math.js',celestialMath],['scatter-spacing.js',scatterSpacing],['tessendorf-ocean.js',tessendorf],['open-world-generator.js',openWorld],['landscape-export-pack.js',landscapeExportPack],['landscape-realism.js',landscapeRealism],['landscape-flora.js',landscapeFlora],['landscape-weather.js',landscapeWeather],...terrainMainParts,['open-world.js',openWorldAddon]];
  let out=html;
  for(const [name,source] of helpers){
    const tag=`<script src="./${name}"></script>`;
    const count=out.split(tag).length-1;
    const provided=typeof source==='string'&&source.length>0;
    if(count===0){
      if(provided)throw new Error(`Expected exactly one ${name} reference, found ${count}`);
      continue; /* optional helper the page never asks for */
    }
    if(!provided)throw new Error(`Missing standalone helper: ${name}`);
    if(source.toLowerCase().includes('</script'))throw new Error(`Unsafe closing script marker in ${name}`);
    if(count!==1)throw new Error(`Expected exactly one ${name} reference, found ${count}`);
    /* A function replacement, not a string: minified sources can contain `$&`,
       `$'` or `` $` `` and String.replace would expand those as match patterns,
       splicing a script tag into the middle of the inlined code. */
    out=out.replace(tag,()=>`<script>\n${source}\n</script>`);
  }
  if(cppWasmBase64){
    if(String(cppWasmBase64).toLowerCase().includes('</script'))throw new Error('Unsafe closing script marker in embedded terrain WASM');
    const bootstrap=`<script>window.__FE_CPP_WASM_BASE64__=${JSON.stringify(String(cppWasmBase64).replace(/<\/script/gi,'<\\/script'))};</script>`;
    out=out.includes('<head>')?out.replace('<head>',()=>'<head>\n'+bootstrap):bootstrap+out;
  }
  return out;
}

export function createStandaloneAppHtml(html, {
  volumeAtlas,
  feIcons,
  renderCapture = '',
  renderPreview = '',
  renderExport = '',
  workspaceExport = '',
  editMode = '',
  feTaa,
  volumeLibrary,
  volumeLibraryBase64 = '',
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
  window.__FE_VOLUME_LIBRARY_B64__ = ${safeJson(volumeLibraryBase64 || '')};
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
    if (urlStr.indexOf('volume-library.bin') !== -1 && window.__FE_VOLUME_LIBRARY_B64__) {
      var bytesC = b64ToBytes(window.__FE_VOLUME_LIBRARY_B64__);
      return Promise.resolve(new Response(bytesC.buffer, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
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
    ['fe-icons.js', feIcons],
    ['render-capture.js', renderCapture],
    ['render-preview.js', renderPreview],
    ['render-export.js', renderExport],
    ['workspace-export.js', workspaceExport],
    ['edit-mode.js', editMode],
    ['fe-taa.js', feTaa],
    ['volume-atlas.js', volumeAtlas],
    ['volume-library.js', volumeLibrary],
    ['simulationCore.js', simulationCore],
    ['modifier-engine.js', modifierEngine],
    ['fe-cpp-engine.js', feCppEngine]
  ];
  let injectedBootstrap = false;
  for (const [name, source] of helpers) {
    const tag = `<script src="${name}"></script>`;
    const count = out.split(tag).length - 1;
    const provided = typeof source === 'string' && source.length > 0;
    if (count === 0) {
      if (provided) throw new Error(`Expected exactly one ${name} reference, found ${count}`);
      continue; /* optional helper the page does not use */
    }
    if (!provided) throw new Error(`Missing standalone app helper: ${name}`);
    if (source.toLowerCase().includes('</script')) throw new Error(`Unsafe closing script marker in ${name}`);
    if (count !== 1) throw new Error(`Expected exactly one ${name} reference, found ${count}`);
    const prefix = !injectedBootstrap ? (bootstrapScript + '\n') : '';
    injectedBootstrap = true;
    out = out.replace(tag, () => `${prefix}<script>\n${source}\n</script>`);
  }
  return out;
}
