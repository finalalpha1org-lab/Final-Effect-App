/* C++ terrain kernel bridge: JS owns UI, history and GPU buffers; C++ owns the
   heightfield maths. Inputs are re-uploaded before each command so undo,
   imports and the JS fallback always stay authoritative. */
(function(root){
 const core={ready:false,error:null,backend:'loading',commands:0,span:0};
 let ex=null,rect=0,palPtr=0,paintPtr=0,owMixPtr=0,owBioPtr=0,lodPtr=0,lodBytes=0,wasmBytes=null;
 const owState={key:''};
 function bind(instance){
  const x=instance.exports;
  const required=['fe_terrain_compute_normals','fe_terrain_brush_stroke','fe_terrain_erode_brush','fe_terrain_generate_layered','fe_terrain_compute_colors','fe_terrain_set_palette','fe_terrain_set_paint_colors','fe_terrain_erode_hydraulic','fe_terrain_erode_thermal'];
  const optional=['fe_terrain_apply_strata','fe_terrain_scatter_out_ptr','fe_terrain_scatter_batch','fe_terrain_scatter_natural','fe_ow_set_params','fe_ow_height_at','fe_ow_biome_weights_at','fe_ow_height_grid','fe_ow_surface_grid','fe_ow_plan_chunks','fe_ow_hydro_set_grid','fe_ow_hydro_trace','fe_lod_classify','fe_lod_out_ptr','fe_lod_visible','fe_lod_visible_index_ptr','fe_lod_visible_tier_ptr','fe_ow_visible_count','fe_ow_height_ptr','fe_ow_surface_ptr','fe_ow_plan_cells_ptr','fe_ow_plan_distance_ptr','fe_ow_river_meta_ptr','fe_ow_river_points_ptr','fe_ow_hydro_input_ptr','fe_ocean_field_ptr','fe_ocean_resolution','fe_ocean_configure','fe_ocean_update','fe_ocean_get_cascade_float4_ptr','fe_ocean_get_cascade_rgba8_ptr',
   /* Time-sliced erosion (fe_landscape.cpp) */
   'fe_erosion_begin','fe_erosion_set_region','fe_erosion_step','fe_erosion_dirty_ptr','fe_erosion_dirty_reset',
   'fe_erosion_remaining','fe_erosion_total','fe_erosion_active','fe_erosion_cancel','fe_terrain_compute_normals_region',
   /* Surface realism (fe_surface.cpp): measured PBR + tileable micro-structure */
   'fe_surface_pbr','fe_surface_count','fe_surface_detail','fe_surface_detail_ptr',
   'fe_surface_detail_size','fe_water_optical','fe_surface_wind_roughness','fe_surface_snow_albedo',
   /* Flora realism (fe_flora.cpp): grown trees and ported rock meshes */
   'fe_flora_tree','fe_flora_rock','fe_flora_vert_count','fe_flora_index_count','fe_flora_leaf_count',
   'fe_flora_pos_ptr','fe_flora_nrm_ptr','fe_flora_uv_ptr','fe_flora_col_ptr','fe_flora_rnd_ptr',
   'fe_flora_cen_ptr','fe_flora_idx_ptr','fe_flora_leaf_ptr','fe_flora_species_info',
   'fe_flora_species_count','fe_flora_rock_kind_count',
   /* Skeletal wind attributes + the fern grammar (fe_flora.cpp) */
   'fe_flora_sway_ptr','fe_flora_phase_ptr','fe_flora_leaf_stride',
   'fe_flora_lsystem','fe_flora_lsystem_len','fe_flora_lsystem_word','fe_flora_lsystem_rules',
   'fe_flora_lsystem_load','fe_flora_lsystem_run','fe_flora_lsystem_plant',
   /* Climate & weather (fe_climate.cpp): seeded temperature / moisture / fronts */
   'fe_climate_init','fe_climate_ready','fe_climate_set_clock','fe_climate_set_season',
   'fe_climate_step','fe_climate_clock','fe_climate_sea_level_temp','fe_climate_snow_line',
   'fe_climate_at','fe_climate_weather','fe_climate_biome','fe_climate_biome_count',
   'fe_climate_biome_on_slope','fe_climate_tornado','fe_climate_rankine','fe_climate_tsunami',
   'fe_climate_biome_grid'];
  const missing=required.filter(name=>typeof x[name]!=='function');
  if(missing.length)throw Error('Terrain C++ export missing: '+missing.join(', '));
  /* A partially stale/older artifact must not kill the whole landscape bridge:
     only the core terrain kernels are mandatory, every newer subsystem reports
     itself through core.missing and falls back to its JS implementation. */
  core.missing=optional.filter(name=>typeof x[name]!=='function');
  if(core.missing.length)console.warn('Landscape C++ partial build, JS fallback for:',core.missing.join(', '));
  core.has=name=>typeof x[name]==='function';
  ex=x;ex.__wasm_call_ctors?.();
  rect=ex.fe_malloc(16);palPtr=ex.fe_malloc(24*4);paintPtr=ex.fe_malloc(48);owMixPtr=ex.fe_malloc(16);owBioPtr=ex.fe_malloc(16);owState.key='';
  core.ready=true;core.backend='C++ WASM';core.span=0;
 }
 /* Streaming compile: the browser compiles the module while it is still
    downloading, so the studio does not sit idle waiting for 1.8 MB before the
    compile even starts. The response is cloned first, because a second
    instance (the kernel worker, the open-world add-on) still needs the bytes —
    the clone buffers the same array the old code buffered, so this costs no
    extra memory, only wall time. A host that serves the wrong MIME type falls
    back to the buffered path. */
 /* Single-file and file:// builds reach no server, so the artifact inlines the
    module as base64. That is a download convenience, not the way the served app
    boots: the 2.44 MB of base64 is only parsed when fetch actually fails. */
 function bootEmbedded(){
  try{
   const encoded=root.__FE_CPP_WASM_BASE64__;
   if(typeof encoded!=='string'||encoded.length<=64||typeof root.atob!=='function')return false;
   const binary=root.atob(encoded),bytes=new Uint8Array(binary.length);
   for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
   wasmBytes=bytes;
   bind(new WebAssembly.Instance(new WebAssembly.Module(bytes),{}));
   return true;
  }catch(error){
   core.error=String(error);
   if(typeof console!=='undefined')console.warn('Embedded terrain WASM unavailable:',error);
   return false;
  }
 }
 core.load=async function(){
  const url=new URL('./fe_core_engine.wasm',document.baseURI);
  try{
   const response=await fetch(url);
   if(!response.ok)throw Error('Terrain WASM HTTP '+response.status);
   /* clone() is only used to keep the raw bytes for the kernel worker and the
      open-world add-on. A host or a test stub that hands back a plain object
      with just arrayBuffer() still works: it simply takes the buffered path. */
   const cloneable=typeof response.clone==='function';
   const forBytes=cloneable?response.clone():response;
   if(cloneable&&typeof WebAssembly.instantiateStreaming==='function'){
    try{
     const {instance}=await WebAssembly.instantiateStreaming(response,{});
     wasmBytes=new Uint8Array(await forBytes.arrayBuffer());
     bind(instance);
     return;
    }catch(streamError){/* wrong MIME type: the clone still has every byte */}
   }
   const buffer=await forBytes.arrayBuffer();wasmBytes=new Uint8Array(buffer.slice(0));
   const {instance}=await WebAssembly.instantiate(buffer,{});
   bind(instance);
  }catch(error){
   if(bootEmbedded())return;
   core.error=String(error);core.backend='JS fallback';console.warn('Landscape C++ unavailable:',error)
  }
 };
 core.loading=core.ready?Promise.resolve():core.load();
 function ensure(n,size){
  if(!core.ready)return false;
  if(ex.fe_terrain_get_segments()!==n||core.span!==size){
   if(ex.fe_terrain_init(n,size)!==0)return false;
   core.span=size;
  }
  return true;
 }
 function setEnv(state){
  const pal=state.pal;
  if(!pal||!pal.length)return false;
  const count=Math.min(8,Math.ceil(pal.length/3));
  const view=new Float32Array(ex.memory.buffer,palPtr,count*3);
  for(let i=0;i<count*3;i++)view[i]=pal[i];
  if(ex.fe_terrain_set_palette(palPtr,count,state.seed||0,state.water||0,state.rock??1.3,state.snow??16,state.desert?1:0)!==0)return false;
  if(state.paint&&state.paint.length){
   const paintCount=Math.min(16,Math.ceil(state.paint.length/3));
   const paintView=new Uint8Array(ex.memory.buffer,paintPtr,paintCount*3);
   paintView.set(state.paint.subarray(0,paintCount*3));
   if(ex.fe_terrain_set_paint_colors(paintPtr,paintCount)!==0)return false;
  }
  return true;
 }
 function syncSurface(state){
  const n=state.n,w=n+1,[x0,x1,z0,z1]=state.rect,width=x1-x0+1;
  const heights=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),w*w);
  const A=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_surf_weights_a_ptr(),w*w*4);
  const B=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_surf_weights_b_ptr(),w*w*4);
  const Cc=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_surf_weights_c_ptr(),w*w*4);
  const mats=new Uint8Array(ex.memory.buffer,ex.fe_terrain_get_mat_index_ptr(),w*w);
  for(let j=z0;j<=z1;j++){
   heights.set(state.heights.subarray(j*w+x0,j*w+x1+1),j*w+x0);
   const off=(j*w+x0)*4,len=width*4;
   A.set(state.weightsA.subarray(off,off+len),off);
   B.set(state.weightsB.subarray(off,off+len),off);
   Cc.set(state.weightsC.subarray(off,off+len),off);
   const moff=j*w+x0;
   mats.set(state.materials.subarray(moff,moff+width),moff);
  }
 }
 core.generate=function(state){
  if(!ensure(state.n,state.size)||!setEnv(state))return false;
  if(ex.fe_terrain_generate_layered(state.seed,state.hs,state.continental?1:0,state.base||0,state.mountain||0)!==0)return false;
  state.heights.set(new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),(state.n+1)*(state.n+1)));
  core.commands++;return true;
 };
 core.colors=function(state){
  if(!ensure(state.n,state.size)||!setEnv(state))return false;
  syncSurface(state);
  const[x0,x1,z0,z1]=state.rect;
  if(ex.fe_terrain_compute_colors(x0,x1,z0,z1)<0)return false;
  const w=state.n+1,src=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_color_ptr(),w*w*3),out=state.output;
  for(let j=z0;j<=z1;j++){const off=(j*w+x0)*3;out.set(src.subarray(off,off+(x1-x0+1)*3),off)}
  core.commands++;return true;
 };
 core.brush=function(state){
  if(!ensure(state.n,state.size))return false;
  const tools={raise:0,lower:1,flat:2,smooth:3,terrace:4},id=tools[state.tool];
  if(id===undefined&&state.tool!=='erode')return false;
  const height=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),(state.n+1)*(state.n+1));
  height.set(state.heights);
  const result=state.tool==='erode'
   ?ex.fe_terrain_erode_brush(state.x,state.z,state.radius,state.strength,state.seed)
   :ex.fe_terrain_brush_stroke(id,state.x,state.z,state.x,state.z,state.radius,state.strength,state.dt*(id===3?1.4:1),state.target||0,0,0,state.seed,rect);
  if(result<0){core.error='C++ brush returned '+result;return false}
  state.heights.set(height);core.commands++;return true;
 };
 core.erode=function(state){
  if(!ensure(state.n,state.size))return false;
  const height=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),(state.n+1)*(state.n+1));
  height.set(state.heights);
  const result=state.mode==='thermal'
   ?ex.fe_terrain_erode_thermal(state.iterations,state.talus,state.slump)
   :ex.fe_terrain_erode_hydraulic(state.droplets,64,.05,.3,.3,.3,.01,4,2,(state.seed>>>0)||1);
  if(result<0){core.error='C++ erosion returned '+result;return false}
  state.heights.set(height);core.commands++;return true;
 };
 /* --- Live hydraulic erosion ------------------------------------------------
    The kernel owns the run: seed, droplet cursor and dirty rectangle all live in
    C++, so a frame only asks for the next slice and then reads back the rows that
    slice touched. No allocation here — the two typed-array views are rebuilt only
    when wasm memory grows, and the rectangle is written into a shared array. */
 let eroBuf=null,eroRectView=null,eroHeightView=null,eroGridW=0;
 function eroViews(){
  if(eroBuf===ex.memory.buffer)return true;
  if(typeof ex.fe_erosion_dirty_ptr!=='function')return false;
  eroBuf=ex.memory.buffer;
  eroRectView=new Uint16Array(eroBuf,ex.fe_erosion_dirty_ptr(),4);
  eroGridW=ex.fe_terrain_get_grid_width();
  eroHeightView=new Float32Array(eroBuf,ex.fe_terrain_get_height_ptr(),eroGridW*eroGridW);
  return true;
 }
 core.erosionRect=[0,0,0,0];
 core.erosionBegin=function(state){
  if(!state||!state.heights){core.error='erosionBegin needs the height field';return false;}
  if(!ensure(state.n,state.size)||typeof ex.fe_erosion_begin!=='function')return false;
  if(!eroViews())return false;
  /* The JS field is authoritative, exactly as it is for every other command:
     a run never starts from whatever the kernel happened to hold. */
  new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),state.heights.length).set(state.heights);
  const r=ex.fe_erosion_begin(state.droplets,state.lifetime||64,.05,.3,.3,.3,.01,4,2,(state.seed>>>0)||1);
  if(r<0){core.error='C++ live erosion returned '+r;return false}
  core.commands++;return true;
 };
 core.erosionRegion=function(x,z,radius){
  return typeof ex.fe_erosion_set_region==='function'&&ex.fe_erosion_set_region(x,z,radius)===0;
 };
 core.erosionStep=function(droplets){
  return typeof ex.fe_erosion_step==='function'?ex.fe_erosion_step(droplets):-1;
 };
 core.erosionRemaining=function(){
  return typeof ex.fe_erosion_remaining==='function'?ex.fe_erosion_remaining():0;
 };
 core.erosionActive=function(){
  return typeof ex.fe_erosion_active==='function'&&ex.fe_erosion_active()===1;
 };
 core.erosionCancel=function(){if(typeof ex.fe_erosion_cancel==='function')ex.fe_erosion_cancel()};
 /* Copies the cells the kernel touched into `out` and leaves the rectangle in
    core.erosionRect. Returns false when nothing changed since the last read. */
 core.erosionRead=function(out){
  if(!eroViews())return false;
  const r=eroRectView,x0=r[0],y0=r[1],x1=r[2],y1=r[3],w=eroGridW;
  if(x0>x1||y0>y1||x1>=w||y1>=w)return false;
  const dst=out,src=eroHeightView;
  for(let j=y0;j<=y1;j++)for(let i=x0;i<=x1;i++){const k=j*w+i;dst[k]=src[k]}
  core.erosionRect[0]=x0;core.erosionRect[1]=x1;core.erosionRect[2]=y0;core.erosionRect[3]=y1;
  ex.fe_erosion_dirty_reset();
  return true;
 };
 /* Normals for the uploaded rectangle only; identical formula to the full pass. */
 core.normalsRegion=function(state){
  if(typeof ex.fe_terrain_compute_normals_region!=='function'||!ensure(state.n,state.size))return false;
  const w=state.n+1,x0=state.rect[0],x1=state.rect[1],z0=state.rect[2],z1=state.rect[3];
  const src=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),w*w);
  for(let j=z0;j<=z1;j++)for(let i=x0;i<=x1;i++){const k=j*w+i;src[k]=state.heights[k]}
  if(ex.fe_terrain_compute_normals_region(x0,x1,z0,z1)<0)return false;
  const nrm=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_normal_ptr(),w*w*3),out=state.output;
  for(let j=z0;j<=z1;j++)for(let i=x0;i<=x1;i++){const k=(j*w+i)*3;out[k]=nrm[k];out[k+1]=nrm[k+1];out[k+2]=nrm[k+2]}
  return true;
 };
 core.strata=function(state){
  if(!ensure(state.n,state.size))return false;
  const height=new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),(state.n+1)*(state.n+1));
  height.set(state.heights);
  const result=ex.fe_terrain_apply_strata(state.height,state.strength,state.tiltX||0,state.tiltZ||0,state.warp||0);
  if(result<0){core.error='C++ strata returned '+result;return false}
  state.heights.set(height);core.commands++;return true;
 };
 core.scatterBegin=function(state){
  if(!ensure(state.n,state.size))return false;
  new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),state.heights.length).set(state.heights);
  return true;
 };
 core.scatterBatch=function(state){
  if(!core.ready||!ex)return 0;
  const count=ex.fe_terrain_scatter_batch(state.count,state.spread,state.seed>>>0);
  if(count<0){core.error='C++ scatter returned '+count;return 0}
  state.output.set(new Float32Array(ex.memory.buffer,ex.fe_terrain_scatter_out_ptr(),count*4));
  return count;
 };
 core.oceanConfigure=function(resolution,lengths,windSpeed,windDirection,seed){
  if(!core.ready||!ex||typeof ex.fe_ocean_configure!=='function')return false;
  const ok=ex.fe_ocean_configure(resolution|0,lengths[0],lengths[1],lengths[2],windSpeed,windDirection,seed>>>0)===0;
  core.oceanResolution=ok?ex.fe_ocean_resolution():0;
  return ok;
 };
 core.oceanUpdate=function(time,amplitude,choppiness,maxHeight,maxDisplace){
  if(!core.ready||!ex||!core.oceanResolution||typeof ex.fe_ocean_update!=='function')return false;
  if(ex.fe_ocean_update(time,amplitude,choppiness,maxHeight,maxDisplace)<0)return false;
  core.commands++;return true;
 };
 core.oceanCascade=function(index){
  if(!core.ready||!ex||!core.oceanResolution)return null;
  const ptr=ex.fe_ocean_get_cascade_float4_ptr(index|0);
  return ptr?new Float32Array(ex.memory.buffer,ptr,core.oceanResolution*core.oceanResolution*4):null;
 };
 core.oceanCascadeFoam=function(index){
  if(!core.ready||!ex||!core.oceanResolution||typeof ex.fe_ocean_get_cascade_foam_ptr!=='function')return null;
  const ptr=ex.fe_ocean_get_cascade_foam_ptr(index|0);
  return ptr?new Float32Array(ex.memory.buffer,ptr,core.oceanResolution*core.oceanResolution):null;
 };
 core.oceanCascadeRgba=function(index){
  if(!core.ready||!ex||!core.oceanResolution)return null;
  const ptr=ex.fe_ocean_get_cascade_rgba8_ptr(index|0);
  return ptr?new Uint8Array(ex.memory.buffer,ptr,core.oceanResolution*core.oceanResolution*4):null;
 };
 core.scatterNatural=function(state){
  if(!core.ready||!ex||typeof ex.fe_terrain_scatter_natural!=='function')return 0;
  const count=ex.fe_terrain_scatter_natural(state.count,state.spread,state.seed>>>0,state.water,state.maxSlope,state.clump,state.patch);
  if(count<0){core.error='C++ natural scatter returned '+count;return 0}
  if(count)state.output.set(new Float32Array(ex.memory.buffer,ex.fe_terrain_scatter_out_ptr(),count*4));
  return count;
 };
 /* Smooth normals for a streamed chunk grid (row x row heights, uniform step).
    The open-world tiles recompute theirs on every brush stroke, and three's
    computeVertexNormals allocates a fresh array and averages face normals;
    the kernel uses the same central difference as the root terrain, so a tile
    shades exactly like the world around it. */
 core.gridNormals=function(state){
  if(!core.ready||!core.has('fe_grid_normals')||!state||!state.heights||!state.output)return false;
  const row=state.row|0,count=row*row;
  if(row<2||row>129||state.heights.length<count||state.output.length<count*3)return false;
  const step=state.step>0?state.step:1;
  new Float32Array(ex.memory.buffer,ex.fe_grid_height_ptr(),count).set(state.heights.subarray(0,count));
  if(ex.fe_grid_normals(row,step)!==0)return false;
  state.output.set(new Float32Array(ex.memory.buffer,ex.fe_grid_normal_ptr(),count*3));
  return true;
 };
 core.normals=function(state){
  if(!ensure(state.n,state.size))return false;
  new Float32Array(ex.memory.buffer,ex.fe_terrain_get_height_ptr(),state.heights.length).set(state.heights);
  ex.fe_terrain_compute_normals();
  state.output.set(new Float32Array(ex.memory.buffer,ex.fe_terrain_get_normal_ptr(),state.output.length));
  return true;
 };
 /* --- Open World kernels: chunk sampling, scheduling plan and hydrology --- */
 core.owParams=function(config){
  if(!core.ready||!config)return false;
  const mix=config.biomeMix||{hills:1,alpine:1,desert:1,volc:1};
  const seed=Number(config.seed)||1,mountain=Number(config.mountainHeight)||0,water=Number(config.waterCoverage)||0;
  const half=Number(config.worldHalf)||6000,sea=Number(config.seaLevel||config.waterLevel)||0,blend=Number(config.blend)||0;
  const m=[Number(mix.hills??1)||1,Number(mix.alpine??1)||1,Number(mix.desert??1)||1,Number(mix.volc??1)||1];
  const key=[seed,mountain,water,half,sea,blend,...m].join('|');
  if(key===owState.key)return true;
  new Float32Array(ex.memory.buffer,owMixPtr,4).set(m);
  if(ex.fe_ow_set_params(seed,mountain,water,half,sea,blend,owMixPtr)!==0){core.error='Open World parameter upload failed';return false}
  owState.key=key;return true;
 };
 core.owHeightAt=function(config,x,z){
  if(!core.owParams(config))return null;
  const v=ex.fe_ow_height_at(x,z);
  return Number.isFinite(v)?v:null;
 };
 core.owBiomeWeights=function(config,x,z,h){
  if(!core.owParams(config))return null;
  if(ex.fe_ow_biome_weights_at(x,z,h,owBioPtr)!==0)return null;
  return new Float32Array(ex.memory.buffer,owBioPtr,4);
 };
 core.owHeightGrid=function(state){
  if(!core.owParams(state.config))return null;
  const count=ex.fe_ow_height_grid(state.segments,state.originX,state.originZ,state.chunkSize);
  if(count<0){core.error='Open World height grid returned '+count;return null}
  return new Float32Array(new Float32Array(ex.memory.buffer,ex.fe_ow_height_ptr(),count));
 };
 core.owSurfaceGrid=function(state){
  if(!core.ready)return null;
  const count=ex.fe_ow_surface_grid(state.segments,state.originX,state.originZ,state.chunkSize);
  if(count<0){core.error='Open World surface grid returned '+count;return null}
  return new Float32Array(new Float32Array(ex.memory.buffer,ex.fe_ow_surface_ptr(),count));
 };
 core.owPlan=function(state){
  if(!core.ready)return null;
  const count=ex.fe_ow_plan_chunks(state.cx,state.cz,state.radius,state.chunkSize,state.worldHalf);
  if(count<0){core.error='Open World chunk plan returned '+count;return null}
  const cells=new Int32Array(new Int32Array(ex.memory.buffer,ex.fe_ow_plan_cells_ptr(),count*3));
  const dist=new Float32Array(new Float32Array(ex.memory.buffer,ex.fe_ow_plan_distance_ptr(),count));
  return {count,cells,dist};
 };
 core.owHydroSet=function(state){
  if(!core.ready)return 0;
  const cells=state.n*state.n;
  if(cells>state.heights.length)return 0;
  new Float32Array(ex.memory.buffer,ex.fe_ow_hydro_input_ptr(),cells).set(state.heights.subarray(0,cells));
  const result=ex.fe_ow_hydro_set_grid(state.n,state.span,state.sea);
  if(result<0){core.error='Open World hydrology grid returned '+result;return 0}
  return result;
 };
 core.owHydroTrace=function(state){
  if(!core.ready)return null;
  const count=ex.fe_ow_hydro_trace(state.rivers,state.minLength,state.spacing,state.seed>>>0);
  if(count<0){core.error='Open World river trace returned '+count;return null}
  const meta=new Int32Array(new Int32Array(ex.memory.buffer,ex.fe_ow_river_meta_ptr(),count*6));
  let total=0;
  for(let i=0;i<count;i++)total=Math.max(total,meta[i*6+2]+meta[i*6+3]);
  const points=new Float32Array(new Float32Array(ex.memory.buffer,ex.fe_ow_river_points_ptr(),total*2));
  return {count,meta,points,total};
 };
 /* Compacted visible-instance list. Returns dense indices into the caller's
   array plus a tier per entry, and allocates nothing once its buffer is big
   enough. The frustum and the ground-cover density falloff are decided in the
   core, so the bridge never loops over instances it will not draw. */
 let visPtr=0,visBytes=0,visVpPtr=0;
 const EMPTY_U32=new Uint32Array(0),EMPTY_U8=new Uint8Array(0);
 core.lodVisible=function(state){
  if(!core.ready||!state||!state.xyz||!state.vp||!core.has('fe_lod_visible'))return null;
  const count=Math.min(state.xyz.length/3|0,state.count|0);
  if(count<=0)return{count:0,indices:EMPTY_U32,tiers:EMPTY_U8};
  const bytes=count*12;
  if(bytes>visBytes){visPtr=ex.fe_malloc(bytes);visBytes=visPtr?bytes:visBytes}
  if(!visPtr)return null;
  if(!visVpPtr){visVpPtr=ex.fe_malloc(64);if(!visVpPtr)return null}
  new Float32Array(ex.memory.buffer,visPtr,count*3).set(state.xyz.subarray(0,count*3));
  new Float32Array(ex.memory.buffer,visVpPtr,16).set(state.vp);
  const got=ex.fe_lod_visible(count,visPtr,visVpPtr,state.camX,state.camY,state.camZ,state.full,state.radius,state.margin,state.options|0);
  if(got<0){core.error='Visible list returned '+got;return null}
  return{count:got,
   indices:new Uint32Array(ex.memory.buffer,ex.fe_lod_visible_index_ptr(),got),
   tiers:new Uint8Array(ex.memory.buffer,ex.fe_lod_visible_tier_ptr(),got)};
 };
 /* Quadtree LoD: the same answer as lodVisible, reached through a spatial index
   the kernel built once per species. `generation` is a checksum of the instance
   positions, so the tree is rebuilt only when a plant actually moved; a settled
   camera re-walks the existing tree and pays for the tree, not the world. */
 core.lodTree=function(state){
  if(!core.ready||!state||!state.xyz||!state.vp||!core.has('fe_lod_tree_cull'))return null;
  const count=Math.min(state.xyz.length/3|0,state.count|0);
  if(count<=0)return{count:0,indices:EMPTY_U32,tiers:EMPTY_U8,nodes:0};
  const slot=state.slot|0;
  const bytes=count*12;
  if(bytes>visBytes){visPtr=ex.fe_malloc(bytes);visBytes=visPtr?bytes:visBytes}
  if(!visPtr)return null;
  if(!visVpPtr){visVpPtr=ex.fe_malloc(64);if(!visVpPtr)return null}
  new Float32Array(ex.memory.buffer,visPtr,count*3).set(state.xyz.subarray(0,count*3));
  new Float32Array(ex.memory.buffer,visVpPtr,16).set(state.vp);
  const built=ex.fe_lod_tree_build(slot,count,visPtr,state.generation>>>0);
  if(built<0){core.error='Quadtree build returned '+built;return null}
  const got=ex.fe_lod_tree_cull(slot,visPtr,visVpPtr,state.camX,state.camY,state.camZ,
   state.mid,state.far,state.radius,state.margin,state.options|0);
  if(got<0){core.error='Quadtree cull returned '+got;return null}
  const stats=new Int32Array(new Int32Array(ex.memory.buffer,ex.fe_lod_tree_stats_ptr(slot),5));
  return{count:got,nodes:stats[0],visited:stats[1],culled:stats[2],scanned:stats[4],rebuilt:built>0,
   indices:new Uint32Array(ex.memory.buffer,ex.fe_lod_tree_index_ptr(),got),
   tiers:new Uint8Array(ex.memory.buffer,ex.fe_lod_tree_tier_ptr(),got)};
 };
 /* Foliage impostor atlas for one species, baked in the kernel from the very
   mesh it just grew. Returns the pixels and the quad size the studio draws;
   null when the artifact predates the baker. */
 core.impostor=function(kind,seed,detail,views){
  if(!core.has('fe_impostor_build'))return null;
  const n=ex.fe_impostor_build(kind|0,(seed>>>0)||1,detail|0,views|0);
  if(n<1)return null;
  const w=ex.fe_impostor_width(),h=ex.fe_impostor_height();
  const bounds=new Float32Array(new Float32Array(ex.memory.buffer,ex.fe_impostor_bounds_ptr(),8));
  /* crop/offset describe which part of the tile holds the plant; the quad is
     sized to that rectangle so a wide tree is not drawn on a too-tall card. */
  return{views:n,width:w,height:h,
   pixels:new Uint8Array(new Uint8Array(ex.memory.buffer,ex.fe_impostor_pixels_ptr(),w*h*n*4)),
   quadW:bounds[0],quadH:bounds[1],coverage:bounds[2],baseY:bounds[3],
   cropU:bounds[4],cropV:bounds[5],offU:bounds[6]};
 };
 /* The atlas column a camera sees a plant from, computed by the kernel so the
   billboard shader and any CPU-side check agree on the convention. */
 core.impostorColumn=function(dx,dz){
  if(!core.has('fe_impostor_column'))return -1;
  return ex.fe_impostor_column(+dx||0,+dz||0)|0;
 };
 core.lodClassify=function(state){
  if(!core.ready||!state||!state.xyz)return null;
  const count=Math.min(state.xyz.length/3|0,state.count|0);
  if(count<=0)return new Int8Array(0);
  const bytes=count*12;
  if(bytes>lodBytes){lodPtr=ex.fe_malloc(bytes);lodBytes=bytes}
  new Float32Array(ex.memory.buffer,lodPtr,count*3).set(state.xyz.subarray(0,count*3));
  const got=ex.fe_lod_classify(count,lodPtr,state.camX,state.camY,state.camZ,state.full,state.ground?1:0);
  if(got<0){core.error='LOD classification returned '+got;return null}
  return new Int8Array(new Int8Array(ex.memory.buffer,ex.fe_lod_out_ptr(),count));
 };
 /* ---- Surface realism (optional kernels; JS keeps a mirror in
   landscape-realism.js so an older artifact still renders) ---- */
 core.surfaceCount=function(){return core.has('fe_surface_count')?ex.fe_surface_count():0};
 core.surfacePbr=function(surface,wet,age,lichen){
  if(!core.has('fe_surface_pbr'))return null;
  const n=8,ptr=ex.fe_malloc(n*4);
  if(!ptr)return null;
  if(ex.fe_surface_pbr(surface|0,+wet||0,+age||0,+lichen||0,ptr)!==1)return null;
  return Array.from(new Float32Array(ex.memory.buffer,ptr,n));
 };
 core.surfaceDetail=function(kind,w,h,seed,strength){
  if(!core.has('fe_surface_detail'))return null;
  if(ex.fe_surface_detail(kind|0,w|0,h|0,(seed>>>0)||1,+strength||1)!==1)return null;
  const count=ex.fe_surface_detail_size();
  if(!count)return null;
  /* Copy out of the static buffer: memory.buffer can be detached by growth. */
  return new Float32Array(new Float32Array(ex.memory.buffer,ex.fe_surface_detail_ptr(),count*4));
 };
 core.detailSize=function(){return core.has('fe_surface_detail_size')?ex.fe_surface_detail_size():0};
 core.waterOptical=function(type){
  if(!core.has('fe_water_optical'))return null;
  const n=6,ptr=ex.fe_malloc(n*4);
  if(!ptr)return null;
  if(ex.fe_water_optical(type|0,ptr)!==1)return null;
  return Array.from(new Float32Array(ex.memory.buffer,ptr,n));
 };
 core.windRoughness=function(mps){
  return core.has('fe_surface_wind_roughness')?ex.fe_surface_wind_roughness(+mps||0):null;
 };
 core.snowAlbedo=function(base,age,impurity){
  return core.has('fe_surface_snow_albedo')?ex.fe_surface_snow_albedo(+base||0,+age||0,+impurity||0):null;
 };
 /* ---- Flora (optional kernels; every caller falls back to the JS builder) --- */
 function floraCopy(Ex){
  const nv=Ex.fe_flora_vert_count(),ni=Ex.fe_flora_index_count(),nl=Ex.fe_flora_leaf_count();
  const mem=Ex.memory.buffer;
  const stride=typeof Ex.fe_flora_leaf_stride==='function'?Ex.fe_flora_leaf_stride()|0:8;
  const out={
   verts:nv,indices:ni,leaves:nl,leafStride:stride,
   pos:new Float32Array(new Float32Array(mem,Ex.fe_flora_pos_ptr(),nv*3)),
   nrm:new Float32Array(new Float32Array(mem,Ex.fe_flora_nrm_ptr(),nv*3)),
   uv:new Float32Array(new Float32Array(mem,Ex.fe_flora_uv_ptr(),nv*2)),
   col:new Float32Array(new Float32Array(mem,Ex.fe_flora_col_ptr(),nv*3)),
   rnd:new Float32Array(new Float32Array(mem,Ex.fe_flora_rnd_ptr(),nv)),
   cen:new Float32Array(new Float32Array(mem,Ex.fe_flora_cen_ptr(),nv*3)),
   idx:new Uint32Array(new Uint32Array(mem,Ex.fe_flora_idx_ptr(),ni)),
   leaf:new Float32Array(new Float32Array(mem,Ex.fe_flora_leaf_ptr(),nl*stride))
  };
  /* Skeletal wind: per-vertex compliance and branch phase. Older artifacts do
     not have them, in which case the material keeps its height-only bend. */
  if(typeof Ex.fe_flora_sway_ptr==='function')out.sway=new Float32Array(new Float32Array(mem,Ex.fe_flora_sway_ptr(),nv));
  if(typeof Ex.fe_flora_phase_ptr==='function')out.phase=new Float32Array(new Float32Array(mem,Ex.fe_flora_phase_ptr(),nv));
  /* Material group per vertex: 0 wood, 1 foliage, 2 bloom. */
  if(typeof Ex.fe_flora_part_ptr==='function')out.part=new Float32Array(new Float32Array(mem,Ex.fe_flora_part_ptr(),nv));
  return out;
 }
 /* Leaf cards grown by the kernel with the tree: four vertices and two
    triangles per card, already coloured and oriented. The studio no longer
    builds leaves in JavaScript. */
 core.floraCards=function(){
  if(!core.has('fe_flora_card_vert_count'))return null;
  const nv=ex.fe_flora_card_vert_count(),ni=ex.fe_flora_card_index_count(),nc=ex.fe_flora_card_count();
  if(nv<1||ni<1)return null;
  const mem=ex.memory.buffer,f32=(p,n)=>new Float32Array(new Float32Array(mem,p,n));
  return {
   cards:nc,
   verts:nv,
   indices:ni,
   pos:f32(ex.fe_flora_card_pos_ptr(),nv*3),
   nrm:f32(ex.fe_flora_card_nrm_ptr(),nv*3),
   col:f32(ex.fe_flora_card_col_ptr(),nv*3),
   uv:f32(ex.fe_flora_card_uv_ptr(),nv*2),
   rnd:f32(ex.fe_flora_card_rnd_ptr(),nv),
   cen:f32(ex.fe_flora_card_cen_ptr(),nv*3),
   sway:f32(ex.fe_flora_card_sway_ptr(),nv),
   phase:f32(ex.fe_flora_card_phase_ptr(),nv),
   part:f32(ex.fe_flora_card_part_ptr(),nv),
   idx:new Uint32Array(new Uint32Array(mem,ex.fe_flora_card_idx_ptr(),ni))
  };
 };
 core.floraTree=function(kind,seed,detail){
  if(!core.has('fe_flora_tree'))return null;
  if(ex.fe_flora_tree(kind|0,(seed>>>0)||1,detail|0)<1)return null;
  const out=floraCopy(ex);
  if(!out.verts)return null;
  const info=new Float32Array(8);
  if(core.has('fe_flora_species_info')){
   const ptr=ex.fe_malloc(32);
   if(ptr){if(ex.fe_flora_species_info(kind|0,ptr)===1)info.set(new Float32Array(ex.memory.buffer,ptr,8));out.info=info}
  }
  return out;
 };
 /* Runtime shape controls: height and branch density, clamped in the kernel. */
 core.floraSetShape=function(height,density){
  if(!core.has('fe_flora_set_shape'))return 0;
  return ex.fe_flora_set_shape(+height||1,+density||1);
 };
 /* Back to the built-in frond grammar. */
 core.lsystemReset=function(){
  if(!core.has('fe_flora_lsystem_reset'))return -1;
  return ex.fe_flora_lsystem_reset();
 };
 /* Buildings: the four shells the studio places along a street, grown in the
   kernel like everything else. Same buffers as a plant, so the same bridge
   reads them and the studio never authors a wall in JavaScript. */
 core.building=function(kind,seed,detail){
  if(!core.has('fe_build'))return null;
  if(ex.fe_build(kind|0,(seed>>>0)||1,detail|0)<1)return null;
  const out=floraCopy(ex);
  return out.verts?out:null;
 };
 core.floraRock=function(kind,seed,detail){
  if(!core.has('fe_flora_rock'))return null;
  if(ex.fe_flora_rock(kind|0,(seed>>>0)||1,detail|0)<1)return null;
  const out=floraCopy(ex);
  return out.verts?out:null;
 };
 /* Grammar symbols are ASCII, so the bridge never depends on TextEncoder /
   TextDecoder being present in the host. */
function lsBytes(str){const a=new Uint8Array(str.length);for(let i=0;i<str.length;i++)a[i]=str.charCodeAt(i)&255;return a}
function lsString(bytes){let s='';for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);return s}

/* The grammar itself: expand the production rules in the kernel and hand the
   resulting word back. Used by diagnostics and by the flora test suite. */
 core.lsystem=function(iterations,seed){
  if(!core.has('fe_flora_lsystem'))return null;
  const n=ex.fe_flora_lsystem(iterations|0,(seed>>>0)||1);
  let word='';
  if(core.has('fe_flora_lsystem_word')&&core.has('fe_flora_lsystem_len')){
   const len=ex.fe_flora_lsystem_len(),ptr=ex.fe_flora_lsystem_word();
   if(ptr&&len>0)word=lsString(new Uint8Array(ex.memory.buffer,ptr,len));
  }
  return {symbols:n,rules:core.has('fe_flora_lsystem_rules')?ex.fe_flora_lsystem_rules():0,word};
 };
 /* Editable grammar: pack {axiom, rules:[{pre,alts}]} into the kernel's byte
   layout, upload it, and expand it there. Nothing is rewritten in JS. */
 core.lsystemLoad=function(spec){
  if(!core.has('fe_flora_lsystem_load')||!spec)return -1;
  const axiom=String(spec.axiom==null?'X':spec.axiom).slice(0,95);
  const rules=(spec.rules||[]).slice(0,8);
  let size=2+axiom.length;
  const alts=[];
  for(const r of rules){
   const list=(r.alts||[]).slice(0,2).filter(a=>typeof a==='string');
   alts.push(list);
   size+=2;
   for(const a of list)size+=1+Math.min(95,a.length);
  }
  if(!size)return -1;
  const buf=new Uint8Array(size);let at=0;
  buf[at++]=rules.length;buf[at++]=axiom.length;
  buf.set(lsBytes(axiom),at);at+=axiom.length;
  rules.forEach((r,i)=>{
   buf[at++]=String(r.pre||'X').charCodeAt(0)&255;buf[at++]=alts[i].length;
   for(const a of alts[i]){const t=a.slice(0,95);buf[at++]=t.length;buf.set(lsBytes(t),at);at+=t.length}
  });
  const ptr=ex.fe_malloc(size);
  if(!ptr)return -1;
  new Uint8Array(ex.memory.buffer,ptr,size).set(buf);
  return ex.fe_flora_lsystem_load(ptr,size);
 };
 core.lsystemRun=function(iterations,seed){
  if(!core.has('fe_flora_lsystem_run'))return null;
  const n=ex.fe_flora_lsystem_run(iterations|0,(seed>>>0)||1);
  if(n<0)return null;
  const len=ex.fe_flora_lsystem_len(),ptr=ex.fe_flora_lsystem_word();
  return {symbols:n,word:lsString(new Uint8Array(ex.memory.buffer,ptr,len))};
 };
 /* Grow a rosette from the uploaded rules (or the built-in frond grammar). */
 core.lsystemPlant=function(o){
  if(!core.has('fe_flora_lsystem_plant'))return null;
  o=o||{};
  const verts=ex.fe_flora_lsystem_plant(
   (o.fronds===undefined?9:o.fronds)|0,
   +(o.step===undefined?0.05:o.step),
   +(o.tilt===undefined?0.6:o.tilt),
   +(o.droop===undefined?0.03:o.droop),
   +(o.leafSize===undefined?0.05:o.leafSize),
   (o.iterations===undefined?3:o.iterations)|0,
   (o.seed===undefined?1:o.seed)>>>0,
   (o.detail===undefined?2:o.detail)|0);
  if(verts<1)return null;
  const out=floraCopy(ex);
  return out.verts?out:null;
 };
 core.floraCounts=function(){
  return {species:core.has('fe_flora_species_count')?ex.fe_flora_species_count():0,
          rocks:core.has('fe_flora_rock_kind_count')?ex.fe_flora_rock_kind_count():0,
          buildings:core.has('fe_build_kind_count')?ex.fe_build_kind_count():0};
 };
 /* ---- Climate & weather (optional kernels; the JS weather runs unchanged) --- */
 let climatePtr=0;
 function climateOut(n){
  if(!climatePtr)climatePtr=ex.fe_malloc(64);
  if(!climatePtr)return null;
  return Array.from(new Float32Array(ex.memory.buffer,climatePtr,n));
 }
 core.climateInit=function(seed,lat,baseC,humidity,continentality,wind){
  return core.has('fe_climate_init')?ex.fe_climate_init(seed>>>0,lat,baseC,humidity,continentality,wind):0;
 };
 core.climateSetClock=function(hours){
  return core.has('fe_climate_set_clock')?ex.fe_climate_set_clock(+hours||0):0;
 };
 core.climateSetSeason=function(t){
  return core.has('fe_climate_set_season')?ex.fe_climate_set_season(+t||0):0;
 };
 core.climateStep=function(dtHours){
  return core.has('fe_climate_step')?ex.fe_climate_step(+dtHours||0):0;
 };
 core.climateClock=function(){
  return core.has('fe_climate_clock')?ex.fe_climate_clock():0;
 };
 core.climateSeaLevelTemp=function(hour){
  return core.has('fe_climate_sea_level_temp')?ex.fe_climate_sea_level_temp(+hour||0):0;
 };
 core.climateSnowLine=function(hour){
  return core.has('fe_climate_snow_line')?ex.fe_climate_snow_line(+hour||0):0;
 };
 core.climateWeather=function(){
  if(!core.has('fe_climate_weather'))return null;
  if(ex.fe_climate_weather(climatePtr||(climatePtr=ex.fe_malloc(64)))<1)return null;
  return climateOut(10);
 };
 core.climateAt=function(x,z,altitude,hour){
  if(!core.has('fe_climate_at'))return null;
  if(!climatePtr)climatePtr=ex.fe_malloc(64);
  if(!climatePtr)return null;
  if(ex.fe_climate_at(+x||0,+z||0,+altitude||0,+hour||0,climatePtr)<1)return null;
  return climateOut(10);
 };
 core.climateBiome=function(tempC,moisture){
  return core.has('fe_climate_biome')?ex.fe_climate_biome(+tempC||0,+moisture||0):-1;
 };
 core.climateBiomeOnSlope=function(tempC,moisture,slope){
  return core.has('fe_climate_biome_on_slope')?ex.fe_climate_biome_on_slope(+tempC||0,+moisture||0,+slope||0):-1;
 };
 /* Whole-map biome classification, computed in the kernel. The caller owns the
   heights; `n` is the vertex grid (n*n) and `size` the span in metres. The
   scratch buffers are reused so repeated presses never mint new allocations. */
 let biomeGrid={n:0,h:0,o:0};
 core.climateBiomeGrid=function(heights,n,size,originX,originZ,hour){
  if(!core.has('fe_climate_biome_grid')||!heights)return null;
  const cells=(n|0)*(n|0);if(cells<4||heights.length<cells)return null;
  if(biomeGrid.n!==cells){
   const h=ex.fe_malloc(cells*4),o=ex.fe_malloc(cells);
   if(!h||!o)return null;
   biomeGrid={n:cells,h,o};
  }
  new Float32Array(ex.memory.buffer,biomeGrid.h,cells).set(heights.subarray?heights.subarray(0,cells):heights);
  const got=ex.fe_climate_biome_grid(biomeGrid.h,n|0,+size||1,+originX||0,+originZ||0,+hour||0,biomeGrid.o);
  if(got!==cells)return null;
  return new Uint8Array(ex.memory.buffer,biomeGrid.o,cells);
 };
 core.climateBiomeCount=function(){
  return core.has('fe_climate_biome_count')?ex.fe_climate_biome_count():0;
 };
 core.climateTornado=function(ef){
  if(!core.has('fe_climate_tornado'))return null;
  if(!climatePtr)climatePtr=ex.fe_malloc(64);
  if(!climatePtr)return null;
  if(ex.fe_climate_tornado(+ef||0,climatePtr)<1)return null;
  return climateOut(4);
 };
 core.climateTsunami=function(amplitude,depth){
  if(!core.has('fe_climate_tsunami'))return null;
  if(!climatePtr)climatePtr=ex.fe_malloc(64);
  if(!climatePtr)return null;
  if(ex.fe_climate_tsunami(+amplitude||0,+depth||0,climatePtr)<1)return null;
  return climateOut(6);
 };
 core.climateRankine=function(r,coreRadius,vmax){
  return core.has('fe_climate_rankine')?ex.fe_climate_rankine(+r||0,+coreRadius||0,+vmax||0):0;
 };
 /* ---- Instanced transforms ------------------------------------------------
   Every visible plant's matrix used to be composed through a THREE.Object3D:
   shortest-arc quaternion to the ground normal, yaw about +Y, a YXZ tilt Euler,
   then updateMatrix(). That is five quaternion operations and four
   transcendental calls per instance through object property lookups — measured
   at 18.2 ms for 30 000 instances on a desktop CPU, three to five times that on
   a phone, and it runs every time a camera pan settles. The core does the same
   arithmetic in one flat pass and hands back a dense block that is blitted into
   the instance buffer with a single set(). tests/scatter-layout.test.mjs holds
   the kernel to the three.js result element by element. */
 core.instancingBegin=function(count){
  if(!core.has('fe_scatter_begin')||!(count>0))return null;
  const p=ex.fe_scatter_begin(count|0);
  if(!p)return null;
  const op=ex.fe_scatter_order_ptr(),ap=ex.fe_scatter_aux_ptr();
  if(!op||!ap)return null;
  /* Built after the call: growing the memory detaches any older view. The aux
     block is the studio's per-instance scratch — placing it here is what keeps
     a camera settle free of JavaScript allocations. */
  return {input:new Float32Array(ex.memory.buffer,p,count*11),
          order:new Uint32Array(ex.memory.buffer,op,count),orderPtr:op,
          aux:new Float32Array(ex.memory.buffer,ap,count*5)};
 };
 core.instancingMatrices=function(count,orderPtr,tilt,bend,mode,flags){
  if(!core.has('fe_scatter_matrices')||!(count>0))return null;
  const p=ex.fe_scatter_matrices(count|0,(orderPtr>>>0),+tilt||0,+bend||0,mode|0,flags|0);
  return p?new Float32Array(ex.memory.buffer,p,count*16):null;
 };
 /* The root sink samples the same heights the terrain mesh was built from, so
   the grid is handed over once per settle (1 MB for a 513^2 world) instead of
   the studio doing 24 lookups per tree in JavaScript. */
 core.instancingTerrain=function(heights,n,size){
  if(!core.has('fe_scatter_terrain')||!heights||!(n>1))return false;
  const p=ex.fe_scatter_terrain(n|0,+size||0);
  if(!p)return false;
  const cells=(n+1)*(n+1),view=new Float32Array(ex.memory.buffer,p,cells);
  view.set(heights.length>cells?heights.subarray(0,cells):heights);
  return true;
 };
 core.bytes=()=>wasmBytes;
 root.FELandscapeCore=core;
})(globalThis);
/* END LANDSCAPE CORE BRIDGE */

/* Two catch sites in the same frame used to print the same stack twice, which
   buried the viewport under a wall of identical red text. The same message is
   shown once per session; a different one still appends. */
const shownErrors=new Set();
function showErr(t){const text=String(t==null?'Unknown error':t);const key=text.slice(0,400);if(shownErrors.has(key))return;shownErrors.add(key);let b=document.getElementById('err');if(!b){b=document.createElement('div');b.id='err';b.style.cssText='position:fixed;left:8px;right:8px;top:calc(env(safe-area-inset-top,0px) + 56px);z-index:30;background:#7a1f1f;color:#fff;padding:8px 10px;border-radius:8px;font:12px/1.35 system-ui;white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto';b.onclick=()=>b.remove();document.body.appendChild(b)}b.textContent+=(b.textContent?'\n':'')+text}
const seenRuntimeErrors=new Set();addEventListener('error',e=>{const masked=!e.filename&&!e.lineno&&!e.error&&(e.message==='Script error.'||!e.message);if(masked){if(!seenRuntimeErrors.has('anonymous-cross-origin')){seenRuntimeErrors.add('anonymous-cross-origin');console.warn('Browser masked an external script error; no source details were provided')}return}const file=(e.filename||'inline').split('/').pop(),key=(e.message||'error')+'|'+file+'|'+(e.lineno||0);if(seenRuntimeErrors.has(key))return;seenRuntimeErrors.add(key);const detail=e.error?.stack||`${e.message||'Script error'} (${file}:${e.lineno||0}:${e.colno||0})`;showErr('Runtime: '+String(detail).slice(0,900))});addEventListener('unhandledrejection',e=>{const r=e.reason,detail=r?.stack||r?.message||String(r||'Unhandled promise rejection');showErr('Unhandled promise: '+String(detail).slice(0,900))});
const $=s=>document.querySelector(s),R=Math.random,cl=(v,a,b)=>Math.min(b,Math.max(a,v)),mx=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);function environmentFillLevel(on,day,cloud=0){return on?.6-.15*cl(day,0,1)+.1*cl(cloud,0,1):0}
const S=100,N=128,D=S/N,W=N+1,cv=$('#c');
/* Device defaults. A handset should not start on the preset a desktop uses:
   Standard detail is 96-segment streamed chunks with 22 000 plants instead
   of 128 and 26 000, and 1024 px shadows is a quarter of the texels a 2048
   map draws every time the focus moves. Both are chips in the sheet, so
   anyone can raise them, and a saved setting wins over this. */
const HANDSET=!!(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches)||(navigator.hardwareConcurrency||8)<=4;
const localClock=new Date();
let tab='terrain',mode='render',nav=false,place=null,sel=null,seed=1,wl=0,wlUserSet=false,tod=localClock.getHours()+localClock.getMinutes()/60+localClock.getSeconds()/3600,az=40,cov=.5,fogD=.0011,wspd=1.8,wp=0,fl=0,waveChop=.22,ampUser=1.05,waterWindSpeed=14,waterWindDir=35,waterWavePeriod=6,waterWaveScale=1,waterQuality=((navigator.hardwareConcurrency||8)<=4||(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches))?0:2;

const br={tool:'raise',r:6,str:.5,tex:0,kind:'grass',den:10,minGap:.25},objs=[];let OW=null,normalWorldMaterialBrush=false,normalWorldMaterial=0;let selectedFoliage=null,foliageSelectMode=false;
let scatterDensity=1,scatterClustering=.35,shallowBrushDepth=1.5;try{const savedCoastDepth=localStorage.getItem('final3d.coastalGrassDepth.v1');if(savedCoastDepth!==null&&Number.isFinite(Number(savedCoastDepth)))shallowBrushDepth=cl(Number(savedCoastDepth),.5,3)}catch{}
const VEGETATION_VIEW_FAR=16000;const scene=new THREE.Scene(),cam=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.5,VEGETATION_VIEW_FAR);cam.position.set(108,85,120);
const ren=new THREE.WebGLRenderer({canvas:cv,antialias:true,powerPreference:'high-performance'});
/* Is the default framebuffer actually multisampled? A leaf card is a hard
   alpha-tested shape, so its edge is a stair step; alpha-to-coverage turns the
   fragment's alpha into MSAA coverage and gives the crown a soft edge - but
   only where there are samples to give. Asking the context once beats setting
   the flag on a device that has none. */
const MSAA=(()=>{try{const a=ren.getContext().getContextAttributes();return !!(a&&a.antialias)}catch(e){return false}})();
ren.setPixelRatio(Math.min(devicePixelRatio,2));ren.setSize(innerWidth,innerHeight);
ren.shadowMap.enabled=true;ren.shadowMap.type=THREE.PCFSoftShadowMap;/* A shadow map is a second pass over every caster, and the sun barely moves:
   it only follows the camera target in 2 m steps at most five times a second.
   Refreshing it every frame bought nothing a 30 Hz cadence does not, so the
   loop drives needsUpdate and this stays off. */
ren.shadowMap.autoUpdate=false;ren.shadowMap.needsUpdate=true;ren.toneMapping=THREE.ACESFilmicToneMapping;ren.outputEncoding=THREE.sRGBEncoding;ren.toneMappingExposure=1;
const oc=new THREE.OrbitControls(cam,cv);oc.enableDamping=true;oc.maxPolarAngle=Math.PI;oc.maxDistance=260;oc.target.set(0,4,0);
const tc=new THREE.TransformControls(cam,cv);tc.userData.isEditorHelper=true;const TERRAIN_EDITOR_HELPERS=new Set([tc]);tc.addEventListener('dragging-changed',e=>{oc.enabled=exploreMode?false:!e.value;if(e.value)push()});scene.add(tc);
const hemi=new THREE.HemisphereLight(0xcfe3ff,0x6a5a48,.6),envFill=new THREE.HemisphereLight(0xb9d4ff,0x62584a,0),sun=new THREE.DirectionalLight(0xfff0d8,1.2),sc=sun.shadow.camera;envFill.name='Environment fill light';
sun.castShadow=true;sun.shadow.mapSize.set(HANDSET?1024:2048,HANDSET?1024:2048);sun.shadow.radius=.8;sc.left=sc.bottom=-60;sc.right=sc.top=60;sc.near=1;sc.far=360;sun.shadow.bias=-.0002;sun.shadow.normalBias=.018;sun.layers.enable(1);sc.layers.enable(1);sc.updateProjectionMatrix();
scene.add(hemi,envFill,sun,sun.target);scene.fog=new THREE.FogExp2(0xbcd0e6,.004);
const BG=new THREE.Color(0x3d3d3d),grid=new THREE.GridHelper(200,200,0x000000,0x555555);grid.userData.isEditorHelper=true;TERRAIN_EDITOR_HELPERS.add(grid);grid.position.y=.05;grid.material.transparent=true;grid.material.opacity=.5;grid.renderOrder=1;scene.add(grid);
const gridAxes=[];
[[0xff3352,[-100,0,0],[100,0,0]],[0x8bdc00,[0,0,-100],[0,0,100]]].forEach(([c,a,b])=>{const l=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a),new THREE.Vector3(...b)]),new THREE.LineBasicMaterial({color:c}));l.userData.isEditorHelper=true;TERRAIN_EDITOR_HELPERS.add(l);l.position.y=.06;scene.add(l);gridAxes.push(l)});
const sbx=new THREE.BoxHelper(undefined,0xffaa40);sbx.userData.isEditorHelper=true;TERRAIN_EDITOR_HELPERS.add(sbx);sbx.visible=false;scene.add(sbx);
/* sky + water shaders */

const U={clar:{value:1},hm2:{value:null},uTerrainOrigin:{value:new THREE.Vector2()},rain:{value:0},ov:{value:0},flash:{value:0},uTf:{value:-1e4},uTl:{value:18},uTa:{value:0},uTsF:{value:0},uTdx:{value:1},uTdz:{value:0},cov:{value:.5},hm:{value:null},wy:{value:0},ni:{value:0},t:{value:0},amp:{value:1.05},uChop:{value:waveChop},uWindDir:{value:new THREE.Vector2(Math.cos(waterWindDir*Math.PI/180),Math.sin(waterWindDir*Math.PI/180))},uWindSpeed:{value:waterWindSpeed},uWavePeriod:{value:waterWavePeriod},uWaveScale:{value:waterWaveScale},uRoughness:{value:.24},uReflect:{value:1},uRefraction:{value:.35},uTurbidity:{value:.08},uTransparency:{value:1},uTurbidColor:{value:new THREE.Color(.16,.28,.3)},uFoamAmt:{value:.5},uFoamThreshold:{value:.78},uShoreFoam:{value:1},uCubeReflection:{value:null},top:{value:new THREE.Color()},hor:{value:new THREE.Color()},sun:{value:new THREE.Color()},sd:{value:new THREE.Vector3(0,1,0)},fd:{value:.004},fc:{value:scene.fog.color},deep:{value:new THREE.Color()},shal:{value:new THREE.Color()},uFFT0:{value:null},uFFT1:{value:null},uFFT2:{value:null},uFFTFoam:{value:(()=>{const t=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1,THREE.RGBAFormat,THREE.UnsignedByteType);t.needsUpdate=true;return t})()},uFFTLen0:{value:256},uFFTLen1:{value:1024},uFFTLen2:{value:4096},uFFTSize:{value:128}};
const SKYU=`uniform vec4 uSA[4],uSB[4],uMA[3],uMB[3],uMC[3],uPA[6],uPB[6],uPC[6],uPD[6],uPE[6],uCA[4],uCB[4],uAu,uSt;uniform vec3 uAuC1,uAuC2;uniform int uNS,uNM,uNP,uNC;uniform mat3 uRot;uniform float uQ;
`;
const SKYF=`float hs(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float hs3(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float vn2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hs(i),hs(i+vec2(1.,0.)),f.x),mix(hs(i+vec2(0.,1.)),hs(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*vn2(p);p=p*2.07+vec2(1.7,9.2);a*=.5;}return s;}
float vn3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hs3(i),hs3(i+vec3(1.,0.,0.)),f.x),mix(hs3(i+vec3(0.,1.,0.)),hs3(i+vec3(1.,1.,0.)),f.x),f.y),mix(mix(hs3(i+vec3(0.,0.,1.)),hs3(i+vec3(1.,0.,1.)),f.x),mix(hs3(i+vec3(0.,1.,1.)),hs3(i+vec3(1.,1.,1.)),f.x),f.y),f.z);}
float fbm3(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*vn3(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}
float cloudDen(vec2 uv,float type,float cv){
if(type<.5){float n=fbm(uv);return smoothstep(1.02-cv*.62,1.3-cv*.62,n);}
if(type<1.5){float n=fbm(uv*.45+3.7);return smoothstep(.95-cv*.7,1.25-cv*.7,n*1.35);}
if(type<2.5){vec2 q=vec2(uv.x*.22,uv.y*2.2);float n=fbm(q+vec2(fbm(q*.7)*1.6,0.));return smoothstep(.5-cv*.1,.95-cv*.25,n)*.55;}
float n=fbm(uv*.6)+.28*fbm(uv*2.4);return smoothstep(.6-cv*.4,.95-cv*.35,n);}
vec3 cloudsCol(vec3 c,vec3 d){
for(int i=0;i<4;i++){if(i>=uNC)break;
#if SKQ<2
if(i>=2)break;
#endif
vec4 A=uCA[i],B=uCB[i];float dy=d.y;if(dy<.02)continue;
vec2 uv=(d.xz/(dy+.14)*.9*A.w+vec2(cos(B.y),sin(B.y))*t*.012*B.x+vec2(float(i)*7.3,float(i)*3.1));
float cv=clamp(A.x+ov*.6,0.,1.);float dn=cloudDen(uv,B.z,cv)*A.y;float shade=0.;
#if SKQ>1
if(uQ>.5){float dn2=cloudDen(uv+sd.xz*.08,B.z,cv)*A.y;shade=clamp((dn-dn2)*2.5,-.5,.5);}
#endif
float hz=smoothstep(.015,.2+.1*A.z,dy);float dark=B.z>2.5?.55:1.;
vec3 cc=mix(vec3(.5,.55,.65),vec3(1.),.62+shade)*(.35+.65*(1.-ni))*(1.-.45*ov)*dark*B.w+sun*.12;cc=mix(cc,hor*1.1,.2);
cc+=sun*pow(max(dot(d,sd),0.),8.)*(1.-clamp(dn,0.,1.))*.35*step(B.z,2.5);
c=mix(c,cc,clamp(dn,0.,1.)*hz*.92);}
return c;}
vec3 sunsCol(vec3 d){vec3 c=vec3(0.);for(int i=0;i<4;i++){if(i>=uNS)break;float cr=cos(uSA[i].w);float x=1.-dot(d,uSA[i].xyz),x0=max(1.-cr,1e-6);
float disk=1.-smoothstep(x0*.88,x0*1.06,x);float g1=exp(-x/min(x0*7.,.004))*.55,g2=exp(-x/min(x0*70.,.025))*.16,g3=exp(-x/min(x0*700.,.08))*.05;
c+=uSB[i].rgb*uSB[i].w*(disk*9.+g1+g2+g3);}return c;}
vec3 moonsCol(vec3 c,vec3 d){for(int i=0;i<3;i++){if(i>=uNM)break;vec3 m=uMA[i].xyz;float r=uMA[i].w;float cm=dot(d,m);float cr=cos(r);
float moonGlowX=1.-cm,moonGlowW=min(max(1.-cr,1e-6)*14.,.08);c+=uMB[i].rgb*uMB[i].w*exp(-moonGlowX/moonGlowW)*.06;
if(cm>cos(r*1.02)){vec3 up0=abs(m.y)>.99?vec3(1.,0.,0.):vec3(0.,1.,0.);vec3 e1=normalize(cross(m,up0));vec3 e2=cross(m,e1);vec2 uv=vec2(dot(d,e1),dot(d,e2))/sin(r);float q=dot(uv,uv);
if(q<1.04){float z=sqrt(max(1.-q,0.));vec3 n=uv.x*e1+uv.y*e2-z*m;float sdd=uMC[i].w;float lam=smoothstep(-.06,.32,dot(n,uMC[i].xyz));
float maria=smoothstep(.46,.62,fbm3(n*1.7+sdd));float crt=vn3(n*13.+sdd)*.18+vn3(n*34.)*.1;
vec3 cell=floor(n*5.+sdd);vec3 cc=cell+.5+(vec3(hs3(cell),hs3(cell+7.),hs3(cell+13.))-.5)*.6;float dd=length(n*5.+sdd-cc);
float cr2=step(.6,hs3(cell+3.))*(smoothstep(.3,.37,dd)*(1.-smoothstep(.37,.5,dd))*.22-(1.-smoothstep(.2,.3,dd))*.12);
float alb=.78-.32*maria+crt+cr2;vec3 mc=uMB[i].rgb*alb*(lam*1.15+.025)*uMB[i].w*1.05;c=mix(c,mc,1.-smoothstep(.93,1.,q));}}}
return c;}
#if SKQ>1
vec3 planetsCol(vec3 c,vec3 d){for(int i=0;i<6;i++){if(i>=uNP)break;vec3 m=uPA[i].xyz;float r=uPA[i].w;float hasR=uPD[i].x;float ext=hasR>.5?2.5:1.05;if(dot(d,m)<cos(min(r*ext,1.5)))continue;
vec3 up0=abs(m.y)>.99?vec3(1.,0.,0.):vec3(0.,1.,0.);vec3 e1=normalize(cross(m,up0));vec3 e2=cross(m,e1);vec2 uv=vec2(dot(d,e1),dot(d,e2))/sin(r);
float ct=cos(uPD[i].y),st=sin(uPD[i].y);vec2 uvr=vec2(uv.x*ct-uv.y*st,uv.x*st+uv.y*ct);float q=dot(uv,uv);vec3 col1=uPB[i].rgb,col2=uPC[i].rgb;float typ=uPB[i].w,bands=uPC[i].w,seed=uPD[i].w;
if(q<1.04){float z=sqrt(max(1.-q,0.));vec3 n=uv.x*e1+uv.y*e2-z*m;vec3 pp=sd-m*dot(sd,m);pp=length(pp)>.001?normalize(pp):e1;float ph=(1.-uPE[i].x)*3.14159;vec3 Lp=normalize(-m*cos(ph)+pp*sin(ph));float lam=smoothstep(-.12,.5,dot(n,Lp));float base;
if(typ>.5&&typ<1.5){base=sin((uvr.y+.08*fbm3(n*3.+seed))*bands*3.14159)*.5+.5;base=mix(base,fbm3(n*4.+seed),.25);}
else if(typ>1.5){base=fbm3(n*2.5+seed)*.9+.1*vn3(n*9.+seed);}
else{base=fbm3(n*3.+seed)*.7+.3*vn3(n*14.+seed);}
vec3 pcol=mix(col2,col1,base);
if(typ>2.5){float hh=fbm3(n*2.2+seed);float land=smoothstep(.5,.54,hh);float ice=smoothstep(.72,.9,abs(uvr.y));float cld=smoothstep(.55,.75,fbm3(n*3.+seed*2.+7.))*.85;vec3 landC=mix(col1*.75,col1*1.25,fbm3(n*7.+seed));pcol=mix(mix(col2,landC,land),vec3(.95),max(ice,cld));}
if(typ>.5&&typ<1.5){float spot=1.-smoothstep(.06,.16,length((uvr-vec2(.28,-.3))*vec2(1.,1.7)));pcol=mix(pcol,vec3(.78,.35,.22),spot*.7);}
float rim=pow(1.-z,3.)*uPD[i].z;vec3 pc=pcol*(lam*1.25+.03)+rim*mix(col1,vec3(.6,.8,1.),.5)*(.3+.7*lam);c=mix(c,pc,1.-smoothstep(.93,1.,q));}
if(hasR>.5){vec2 rp=vec2(uvr.x,uvr.y/.32);float rr=length(rp);float inring=smoothstep(1.28,1.36,rr)*(1.-smoothstep(2.15,2.3,rr));float gap=1.-.85*(1.-smoothstep(.015,.03,abs(rr-1.78)));
float rg=inring*gap*(.55+.45*vn2(vec2(rr*38.,seed)))*.85;float vis=(uvr.y<0.||q>=1.)?1.:0.;c=mix(c,mix(col2,col1,.6)*1.1,rg*vis);}}
return c;}
#endif
vec3 starsCol(vec3 d){if(ni<.02||d.y<0.)return vec3(0.);vec3 dr=normalize(uRot*d);vec2 uv=vec2(atan(dr.z,dr.x)*.15915494+.5,asin(clamp(dr.y,-1.,1.))*.31830989+.5);float lat=asin(clamp(dr.y,-1.,1.));vec2 cellUV=uv*vec2(520.,260.),cell=floor(cellUV),local=fract(cellUV)-.5;float h=hs(cell),starOn=step(1.-.0065*uSt.w,h),mag=pow(hs(cell+7.23),3.),tw=1.+.32*uSt.y*sin(t*(1.2+hs(cell+2.17)*7.)+hs(cell+9.31)*31.);float radius=mix(.025,.12,mag),dist=length(vec2(local.x*max(cos(lat),.2),local.y)),disc=1.-smoothstep(radius*.48,radius,dist),halo=exp(-dist*dist/max(radius*radius*7.,1e-5))*.11;float temp=hs(cell+1.73);vec3 color=mix(vec3(.52,.68,1.),vec3(1.,.67,.43),temp);color=mix(color,vec3(1.),step(.88,hs(cell+4.91))*.75);vec3 c=color*starOn*(.35+1.45*mag)*tw*(disc+halo);vec2 fineUV=uv*vec2(920.,460.),fineCell=floor(fineUV),fineLocal=fract(fineUV)-.5;float fineActive=step(1.-.0026*uSt.w,hs(fineCell+11.)),fineDist=length(vec2(fineLocal.x*max(cos(lat),.2),fineLocal.y)),fineDisc=1.-smoothstep(.018,.052,fineDist);vec3 fineColor=mix(vec3(.62,.76,1.),vec3(1.,.74,.55),hs(fineCell+19.));c+=fineColor*fineActive*fineDisc*.35;
#if SKQ>1
if(uQ>.5){vec3 gn=normalize(vec3(.35,.82,.45));float band=exp(-pow(dot(dr,gn),2.)*16.);float s2=fbm3(dr*3.2+4.1);float dust=1.-.65*smoothstep(.5,.78,fbm3(dr*8.+9.));float core=.7+.6*smoothstep(.2,1.,dot(dr,normalize(vec3(.7,.1,-.7))));c+=mix(vec3(.55,.62,.85),vec3(.95,.85,.7),clamp(core-.7,0.,1.))*band*(.25+.75*s2)*dust*core*.2*uSt.z;}
#endif
return c*ni*smoothstep(0.,.25,d.y)*uSt.x;}
#if SKQ>1
vec3 auroraCol(vec3 d){if(uAu.x<.01||ni<.3||d.y<.04||uQ<.5)return vec3(0.);vec3 acc=vec3(0.);
for(int i=0;i<6;i++){float fi=float(i);vec2 p=d.xz/(d.y+.12)*(.55+fi*.07);float wv=sin(p.x*3.+t*.12*uAu.z+fi)*.5+sin(p.x*7.1-t*.17*uAu.z+fi*2.)*.25+sin(p.x*13.-t*.2*uAu.z)*.1;float c0=(.2+fi*.08)*uAu.y;float u=p.y*.9+wv*.55-c0*1.6;float band=exp(-u*u*(10./max(uAu.w,.2)));float rays=.55+.45*vn2(vec2(p.x*24.+fi*3.,t*.35*uAu.z));acc+=mix(uAuC1,uAuC2,fi/5.)*band*rays;}
return acc*smoothstep(.05,.3,d.y)*(1.-smoothstep(.65,1.,d.y))*smoothstep(.3,.9,ni)*uAu.x*.22;}
#endif
vec3 skyColor(vec3 d){float y=clamp(d.y,0.,1.);vec3 c=mix(hor,top,pow(y,.5));c=mix(c,hor*1.08,exp(-y*9.)*.45);c+=starsCol(d);
#if SKQ>1
c+=auroraCol(d);c=planetsCol(c,d);
#endif
c=moonsCol(c,d);c+=sunsCol(d);c=cloudsCol(c,d);
c=mix(c,vec3(.42,.45,.5)*(1.-.6*ni),ov*.5*(1.-.4*y));c+=vec3(.75,.8,1.)*flash*(.35+.65*y);return c;}
`;

const RIPF='vec2 rainRip(vec2 p){vec2 g=floor(p*1.6),f=fract(p*1.6)-.5;float r=waveHash(g),ph=fract(t*.8+r*7.),rad=ph*.55,d=abs(length(f)-rad),k=(1.-smoothstep(0.,.07,d))*(1.-ph)*step(r,.75);return normalize(f+vec2(1e-4))*k;}';
const SKYFS=q=>'#define SKQ '+q+'\nuniform vec3 top,hor,sun,sd;uniform float t,cov,ni,ov,flash;varying vec3 p;'+SKYU+SKYF+'void main(){gl_FragColor=vec4(skyColor(normalize(p)),1.);}';
const sky=new THREE.Mesh(new THREE.SphereGeometry(600,32,16),new THREE.ShaderMaterial({uniforms:U,side:THREE.BackSide,depthWrite:false,fog:false,
vertexShader:'varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
fragmentShader:SKYFS(2)}));
sky.frustumCulled=false;scene.add(sky);


const WATER_QUALITY=[{inner:[320,160],far:[320,64],reflection:128,interval:90,transmission:.28},{inner:[448,192],far:[448,80],reflection:128,interval:45,transmission:.62},{inner:[640,256],far:[640,96],reflection:192,interval:30,transmission:1},{inner:[768,320],far:[768,128],reflection:192,interval:24,transmission:1}];
let WATER_OUTER_RADIUS=1400;
function makeWaterGeometry(q){const cfg=WATER_QUALITY[q],theta=cfg.inner[0],near=cfg.inner[1],far=cfg.far[1],joinRadius=190,outerRadius=Math.max(1400,WATER_OUTER_RADIUS),innerStep=(joinRadius-.001)/near;let growthLow=1,growthHigh=1.2;for(let n=0;n<24;n++){const g=(growthLow+growthHigh)*.5,span=innerStep*(Math.pow(g,far)-1)/(g-1);if(span<outerRadius-joinRadius)growthLow=g;else growthHigh=g}const growth=(growthLow+growthHigh)*.5,rows=near+far+1,cols=theta+1,positions=new Float32Array(rows*cols*3),normals=new Float32Array(rows*cols*3),uvs=new Float32Array(rows*cols*2),indices=new Uint32Array((rows-1)*theta*6);for(let j=0;j<rows;j++){const k=j-near,radius=j===rows-1?outerRadius:j<=near?.001+innerStep*j:joinRadius+innerStep*(Math.pow(growth,k)-1)/(growth-1);for(let i=0;i<cols;i++){ const k=j*cols+i,a=i/theta*Math.PI*2,p=k*3;positions[p]=radius*Math.cos(a);positions[p+1]=0;positions[p+2]=-radius*Math.sin(a);normals[p+1]=1;uvs[k*2]=i/theta;uvs[k*2+1]=j/(rows-1)}}let ix=0;for(let j=0;j<rows-1;j++)for(let i=0;i<theta;i++){const a=j*cols+i,b=a+cols,d=a+1,c=b+1;indices[ix++]=a;indices[ix++]=b;indices[ix++]=d;indices[ix++]=b;indices[ix++]=c;indices[ix++]=d}const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(positions,3));g.setAttribute('normal',new THREE.BufferAttribute(normals,3));g.setAttribute('uv',new THREE.BufferAttribute(uvs,2));g.setIndex(new THREE.BufferAttribute(indices,1));g.computeBoundingBox();g.computeBoundingSphere();return g}
function setOpenWorldWaterRadius(active){const radius=active?Math.max(1400,Math.ceil(OW.config.sizeKm*500*Math.SQRT2+250)):1400;if(radius===WATER_OUTER_RADIUS)return;WATER_OUTER_RADIUS=radius;water.geometry.dispose();water.geometry=makeWaterGeometry(waterQuality);waterReflectionReady=false}
const WH='uniform float t,amp,wy,uChop,uWindSpeed,uWavePeriod,uWaveScale,uTurbidity,uTransparency,uFoamAmt,uFoamThreshold,uShoreFoam,clar,rain;uniform vec2 uWindDir;uniform vec3 uTurbidColor,deep,shal,top,hor;uniform highp sampler2D hm,hm2,uFFT0,uFFT1,uFFT2,uFFTFoam;uniform vec2 uTerrainOrigin;uniform float uFFTLen0,uFFTLen1,uFFTLen2,uFFTSize;uniform float uTf,uTl,uTa,uTdx,uTdz,uTsF;float waveHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}vec2 waveGrad(vec2 p){float a=waveHash(p)*6.2831853;return vec2(cos(a),sin(a));}float waveNoise(vec2 p,out vec2 ng){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f),du=6.*f*(1.-f),g00=waveGrad(i),g10=waveGrad(i+vec2(1.,0.)),g01=waveGrad(i+vec2(0.,1.)),g11=waveGrad(i+vec2(1.,1.));float n00=dot(g00,f),n10=dot(g10,f-vec2(1.,0.)),n01=dot(g01,f-vec2(0.,1.)),n11=dot(g11,f-vec2(1.,1.)),x0=mix(n00,n10,u.x),x1=mix(n01,n11,u.x),dx0=mix(g00.x,g10.x,u.x)+(n10-n00)*du.x,dx1=mix(g01.x,g11.x,u.x)+(n11-n01)*du.x,dy0=mix(g00.y,g10.y,u.x),dy1=mix(g01.y,g11.y,u.x);ng=vec2(mix(dx0,dx1,u.y),mix(dy0,dy1,u.y)+(x1-x0)*du.y)*.72;return .5+mix(x0,x1,u.y)*.72;}float fftHeight(vec4 q){return(q.r*2.-1.)*3.;}vec2 fftDisplace(vec4 q){return(q.gb*2.-1.)*2.;}float wvh(vec2 p,int N,out vec2 g,out vec2 horizontal){float footprint=max(1.5,length(p)*.085);vec2 uv0=p/uFFTLen0+.5,uv1=p/uFFTLen1+.5,uv2=p/uFFTLen2+.5;vec2 e=vec2(1./uFFTSize,0.);vec4 a0=texture2D(uFFT0,uv0),a1=texture2D(uFFT1,uv1),a2=texture2D(uFFT2,uv2);float f0=1.-smoothstep(90.,420.,footprint),f1=1.-smoothstep(520.,1900.,footprint),f2=1.;float h0=fftHeight(a0),h1=fftHeight(a1),h2=fftHeight(a2);float dh0x=fftHeight(texture2D(uFFT0,uv0+e))-h0,dh0z=fftHeight(texture2D(uFFT0,uv0+e.yx))-h0;float dh1x=fftHeight(texture2D(uFFT1,uv1+e))-h1,dh1z=fftHeight(texture2D(uFFT1,uv1+e.yx))-h1;float dh2x=fftHeight(texture2D(uFFT2,uv2+e))-h2,dh2z=fftHeight(texture2D(uFFT2,uv2+e.yx))-h2;g=vec2(dh0x*f0/uFFTLen0+dh1x*f1/uFFTLen1+dh2x/uFFTLen2,dh0z*f0/uFFTLen0+dh1z*f1/uFFTLen1+dh2z/uFFTLen2)*uFFTSize;horizontal=fftDisplace(a0)*f0+fftDisplace(a1)*f1+fftDisplace(a2);vec2 ng;float micro=waveNoise(p*.018*uWaveScale+uWindDir*t*.07,ng);g+=ng*.0007*uWaveScale;return h0*f0+h1*f1+h2+(micro-.5)*.035;}float h(vec2 p){vec2 g,offset;return wvh(p,8,g,offset);}float hv(vec2 p){vec2 g,offset;return wvh(p,8,g,offset);}float th2(vec2 p){p-=uTerrainOrigin;vec2 g=clamp((p+420.)/840.*256.,0.,255.999);vec2 i=floor(g),f=fract(g);vec2 u=(i+.5)/257.,o=vec2(1./257.,0.);float a=texture2D(hm2,u).r,b=texture2D(hm2,u+o).r,c=texture2D(hm2,u+o.yx).r,d=texture2D(hm2,u+o.xx).r;return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}float th1(vec2 p){p-=uTerrainOrigin;vec2 g=clamp((p+50.)/100.*128.,0.,127.999);vec2 i=floor(g),f=fract(g);vec2 u=(i+.5)/129.,o=vec2(1./129.,0.);float a=texture2D(hm,u).r,b=texture2D(hm,u+o).r,c=texture2D(hm,u+o.yx).r,d=texture2D(hm,u+o.xx).r;return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}float th(vec2 p){float k=smoothstep(46.,54.,max(abs(p.x),abs(p.y)));return mix(th1(p),th2(p),k);}float tsH(vec2 p){float d=dot(p,vec2(uTdx,uTdz))-uTf;float ds=d>0.?d*2.4:d*.6;float e=exp(-abs(ds)/uTl);float s=2.*e/(1.+e*e);float q=(d-2.2*uTl)/(1.5*uTl);float e2=exp(-abs(q));float s2=2.*e2/(1.+e2*e2);float dd=max(wy-th(p),0.);float sh=clamp(pow(36./max(dd,5.),.25),.85,1.7);return uTa*(s*s*sh-(d>0.?.38*s2*s2:0.));}varying vec3 w;varying vec3 waterWorldNormal;';
const waterMat=new THREE.MeshPhysicalMaterial({color:0xffffff,metalness:0,roughness:U.uRoughness.value,clearcoat:.92,clearcoatRoughness:.06,transmission:Math.max(.001,U.uRefraction.value*U.uTransparency.value*WATER_QUALITY[waterQuality].transmission),transparent:false,opacity:1,depthWrite:true,side:THREE.DoubleSide});
const FFT_LENGTHS=[256,1024,4096],FFT_RESOLUTION=[64,64,128,256],FFT_MAX_HEIGHT=3,FFT_MAX_DISPLACE=2;let tessendorfOcean=new TessendorfOceanBundle.TessendorfOcean({resolution:FFT_RESOLUTION[waterQuality]||128,lengths:FFT_LENGTHS,windSpeed:waterWindSpeed,windDirection:waterWindDir,seed:seed+37}),fftTextures=[],fftUpdateAt=0,fftErrorShown=false;
function encodeTessendorfField(field){const src=field.data,out=new Uint8Array(src.length);for(let i=0;i<src.length;i+=4){out[i]=Math.round(cl(src[i]/(2*FFT_MAX_HEIGHT)+.5,0,1)*255);out[i+1]=Math.round(cl(src[i+1]/(2*FFT_MAX_DISPLACE)+.5,0,1)*255);out[i+2]=Math.round(cl(src[i+2]/(2*FFT_MAX_DISPLACE)+.5,0,1)*255);out[i+3]=255}return out}
function makeTessendorfTexture(field){const t=new THREE.DataTexture(encodeTessendorfField(field),field.resolution,field.resolution,THREE.RGBAFormat,THREE.UnsignedByteType);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;t.flipY=false;t.needsUpdate=true;return t}
function writeTessendorfTexture(tex,field){const dst=tex.image.data,src=field.data;for(let i=0;i<src.length;i+=4){dst[i]=Math.round(cl(src[i]/(2*FFT_MAX_HEIGHT)+.5,0,1)*255);dst[i+1]=Math.round(cl(src[i+1]/(2*FFT_MAX_DISPLACE)+.5,0,1)*255);dst[i+2]=Math.round(cl(src[i+2]/(2*FFT_MAX_DISPLACE)+.5,0,1)*255);dst[i+3]=255}tex.needsUpdate=true}
let fftFoamTexture=null,fftFoamZeroed=false;
function makeFoamTexture(size){const t=new THREE.DataTexture(new Uint8Array(size*size*4),size,size,THREE.RGBAFormat,THREE.UnsignedByteType);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;t.flipY=false;t.needsUpdate=true;return t}
function ensureFoamTexture(size){if(fftFoamTexture&&fftFoamTexture.image.width===size)return fftFoamTexture;if(fftFoamTexture)fftFoamTexture.dispose();fftFoamTexture=makeFoamTexture(size);U.uFFTFoam.value=fftFoamTexture;fftFoamZeroed=false;return fftFoamTexture}
function writeFoamTexture(tex,foam){const d=tex.image.data;for(let i=0,j=0;i<foam.length;i++,j+=4){const v=Math.max(0,Math.min(1,foam[i]))*255;d[j]=d[j+1]=d[j+2]=v;d[j+3]=255}tex.needsUpdate=true}
function clearFoamTexture(){if(fftFoamZeroed)return;const t=ensureFoamTexture(U.uFFTFoam.value&&U.uFFTFoam.value.image?U.uFFTFoam.value.image.width:1);t.image.data.fill(0);for(let i=3;i<t.image.data.length;i+=4)t.image.data[i]=255;t.needsUpdate=true;fftFoamZeroed=true}
function makeFFTTexture(size){const t=new THREE.DataTexture(new Uint8Array(size*size*4),size,size,THREE.RGBAFormat,THREE.UnsignedByteType);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;t.flipY=false;t.needsUpdate=true;return t}
function writeFFTTexture(tex,rgba){tex.image.data.set(rgba);tex.needsUpdate=true}
/* ---- sea state from wind speed ---------------------------------------
   The Gerstner and FFT spectra are both parameterised by wind speed, peak
   period and wavelength, so the same three relations drive the sliders and the
   climate wind. A fully developed sea:
     H_s ~ 0.0025 U^2      (significant wave height, fetch-saturated)
     T_p ~ 0.73 U          (peak period)
     L   = g T_p^2 / 2pi   (peak wavelength)                            */
function wavePhysicsForWind(speed){
 const u=cl(Number.isFinite(+speed)?+speed:0,0,40),g=9.81,hs=cl(.0025*u*u,.02,2.6),period=cl(.73*u,2,16),length=g*period*period/(2*Math.PI);
 return{wind:u,hs,period,length,chop:cl(.04+u*.017,0,.6)};
}
let waveAuto=false,waveAutoApplied=-1;
function applyWavePhysics(speed){
 const p=wavePhysicsForWind(speed);
 waterWindSpeed=p.wind;U.uWindSpeed.value=p.wind;
 ampUser=p.hs;U.amp.value=p.hs;
 waterWavePeriod=p.period;U.uWavePeriod.value=p.period;
 waveChop=p.chop;U.uChop.value=p.chop;
 return p;
}
/* Runs once a frame: the climate is the source of truth only while the artist
   has asked the sea to follow it. No slider is moved behind their back. */
function stepWaveClimate(){
 if(!waveAuto)return;
 const wx=window.FELandscapeWeather;
 const w=wx&&wx.state?+wx.state.wind:NaN;
 if(!Number.isFinite(w)||Math.abs(w-waveAutoApplied)<.05)return;
 waveAutoApplied=w;applyWavePhysics(w);
}
window.__feWavePhysics=wavePhysicsForWind;
function updateTessendorfOcean(now,force=false){const interval=[110,90,65,50][waterQuality]||65;if(!force&&now-fftUpdateAt<interval)return;try{const lengths=FFT_LENGTHS.map(x=>x/Math.max(U.uWaveScale.value,.1));U.uFFTLen0.value=lengths[0];U.uFFTLen1.value=lengths[1];U.uFFTLen2.value=lengths[2];const resolution=FFT_RESOLUTION[waterQuality]||128,time=U.t.value*6/Math.max(U.uWavePeriod.value,.5),core=window.FELandscapeCore;let fields=null,size=resolution;const native=!!(core&&core.ready&&typeof core.oceanConfigure==='function'&&core.oceanConfigure(resolution,lengths,U.uWindSpeed.value,waterWindDir,seed+37)&&core.oceanUpdate(time,1,1,FFT_MAX_HEIGHT,FFT_MAX_DISPLACE));if(native)size=core.oceanResolution;else{tessendorfOcean.configure({resolution,lengths,windSpeed:U.uWindSpeed.value,windDirection:waterWindDir,seed:seed+37});fields=tessendorfOcean.update(time,{amplitude:1,choppiness:1})}if(!fftTextures.length||fftTextures[0].image.width!==size){fftTextures.forEach(t=>t.dispose());fftTextures=native?[makeFFTTexture(size),makeFFTTexture(size),makeFFTTexture(size)]:fields.map(makeTessendorfTexture);U.uFFT0.value=fftTextures[0];U.uFFT1.value=fftTextures[1];U.uFFT2.value=fftTextures[2]}if(native){for(let i=0;i<3;i++)writeFFTTexture(fftTextures[i],core.oceanCascadeRgba(i));const foam=typeof core.oceanCascadeFoam==='function'?core.oceanCascadeFoam(0):null;if(foam){writeFoamTexture(ensureFoamTexture(size),foam);fftFoamZeroed=false}else clearFoamTexture()}else{fields.forEach((f,i)=>writeTessendorfTexture(fftTextures[i],f));clearFoamTexture()}U.uFFTSize.value=size;fftUpdateAt=now;fftErrorShown=false}catch(e){if(!fftErrorShown){fftErrorShown=true;showErr('Tessendorf FFT ocean solver failed: '+(e?.message||e))}}}
updateTessendorfOcean(performance.now(),true);
waterMat.onBeforeCompile=shader=>{const refs=['t','amp','wy','uChop','uWindSpeed','uWavePeriod','uWaveScale','uWindDir','hm','hm2','uTf','uTl','uTa','uTdx','uTdz','uTsF','uTurbidity','uTransparency','uTurbidColor','deep','shal','uFoamAmt','uFoamThreshold','uShoreFoam','clar','rain','top','hor','uFFT0','uFFT1','uFFT2','uFFTFoam','uFFTLen0','uFFTLen1','uFFTLen2','uFFTSize','uTerrainOrigin','uCubeReflection','uReflect'];for(const k of refs)shader.uniforms[k]=U[k];const shared='\n'+WH.replace('vec2 waveGrad(vec2 p){',RIPF+'\nvec2 waveGrad(vec2 p){')+'\n';shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>'+shared).replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\nvec4 waterBaseWorld=modelMatrix*vec4(position,1.);float waterBaseDepth=max(wy-th(waterBaseWorld.xz),0.);vec2 waterGrad;vec2 waterHorizontal;float waterWave=wvh(waterBaseWorld.xz,8,waterGrad,waterHorizontal);float waterFade=smoothstep(.15,2.3,waterBaseDepth);float tsF=clamp(uTsF,0.,1.);vec2 windSlope=waterGrad*amp*waterFade*(1.-tsF*.85);vec2 tsSlope=vec2(0.);if(tsF>0.001){float tsE=2.;float tsHx=tsH(waterBaseWorld.xz+vec2(tsE,0.))-tsH(waterBaseWorld.xz);float tsHz=tsH(waterBaseWorld.xz+vec2(0.,tsE))-tsH(waterBaseWorld.xz);tsSlope=vec2(tsHx,tsHz)/tsE;}vec2 waterSlope=windSlope+tsSlope*tsF;objectNormal=normalize(vec3(-waterSlope.x,1.,-waterSlope.y));waterWorldNormal=normalize(mat3(modelMatrix)*objectNormal);').replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.xz+=waterHorizontal*amp*uChop*waterFade;float waterRainHeight=rain>.01?length(rainRip(waterBaseWorld.xz)+rainRip(waterBaseWorld.xz*1.7+3.1)*.7)*rain*.06*smoothstep(.02,.7,waterBaseDepth):0.;transformed.y+=waterWave*amp*waterFade*(1.-tsF*.85)+tsH(waterBaseWorld.xz)*tsF+waterRainHeight*(1.-tsF*.7);w=(modelMatrix*vec4(transformed,1.)).xyz;');shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>'+shared+'\nuniform samplerCube uCubeReflection;uniform float uReflect;\n').replace('#include <color_fragment>','#include <color_fragment>\nfloat waterDepth=max(wy+tsH(w.xz)-th(w.xz),0.);float waterAtten=1.-exp(-waterDepth*(.12+uTurbidity*.9)/max(clar,.1));vec3 waterTint=mix(shal,deep,clamp(waterAtten,0.,1.));waterTint=mix(waterTint,uTurbidColor,clamp(uTurbidity*.38,0.,.8));vec2 waterGradF,waterHorizontalF;wvh(w.xz,8,waterGradF,waterHorizontalF);float waterSlope=length(waterGradF*amp);float crestFoam=smoothstep(uFoamThreshold,uFoamThreshold+.6,waterSlope*(.35+uWindSpeed*.045));float fftFoam=texture2D(uFFTFoam,vec2(w.xz/uFFTLen0+.5)).r;crestFoam=max(crestFoam,fftFoam);float waveSet=clamp(.55+.45*sin(t*1.05-dot(w.xz,uWindDir)*.22)+.18*sin(t*.41+dot(w.xz,vec2(-uWindDir.y,uWindDir.x))*.7),0.,1.);float runup=waveSet*waveSet*(3.-2.*waveSet);float shoreBandW=max(uShoreFoam,.05)*(.72+.6*runup)*(.6+.8*min(amp,2.));float shoreBand=1.-smoothstep(0.,max(shoreBandW,.02),waterDepth);float shoreLip=1.-smoothstep(0.,max(uShoreFoam*.3,.03),waterDepth);vec2 shoreGrad;float shoreLace=waveNoise(w.xz*.92+vec2(t*.2,-t*.16),shoreGrad)*.55+waveNoise(w.xz*2.4-uWindDir*t*.14,shoreGrad)*.45;float shoreFoam=(shoreBand*mix(.34,.86,runup)+shoreLip*runup*.5)*mix(.5,1.18,shoreLace)*smoothstep(0.,.02,waterDepth);float waterRainMask=clamp(rain,0.,1.)*mix(.55,1.,smoothstep(0.,1.6,waterDepth));vec2 rainColorRipples=rainRip(w.xz)+rainRip(w.xz*1.7+3.1)*.7;float rainRippleFoam=length(rainColorRipples)*waterRainMask*.22;float rainFoam=clamp(rain,0.,1.)*.06+rainRippleFoam;vec2 foamGrad;float foamNoise=waveNoise(w.xz*.17+uWindDir*t*.035,foamGrad);float foamMask=clamp((crestFoam*mix(.55,1.25,foamNoise)+shoreFoam*mix(.72,1.12,foamNoise)+rainFoam)*uFoamAmt,0.,.94);float waterFoam=foamMask;diffuseColor.rgb=mix(waterTint,vec3(.9,.96,.98),waterFoam);diffuseColor.a=1.;').replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nvec3 waterTriW=pow(abs(normalize(waterWorldNormal)),vec3(4.));waterTriW/=max(dot(waterTriW,vec3(1.)),.001);vec2 waterTriGX,waterTriGY,waterTriGZ;float waterTriScale=.62*uWaveScale;float waterTriX=waveNoise(w.yz*waterTriScale+uWindDir*t*.025,waterTriGX),waterTriY=waveNoise(w.xz*waterTriScale+uWindDir*t*.025,waterTriGY),waterTriZ=waveNoise(w.xy*waterTriScale,waterTriGZ);waterTriGX*=waterTriScale;waterTriGY*=waterTriScale;waterTriGZ*=waterTriScale;float waterTriGrain=waterTriX*waterTriW.x+waterTriY*waterTriW.y+waterTriZ*waterTriW.z;roughnessFactor=clamp(roughnessFactor+(waterTriGrain-.5)*.055+uTurbidity*.08,.025,.98);').replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nfloat waterNdotV=abs(dot(normalize(normal),normalize(vViewPosition)));float waterFresnel=.02+.98*pow(1.-clamp(waterNdotV,0.,1.),5.);vec3 waterTriGrad=vec3(0.,waterTriGX.x,waterTriGX.y)*waterTriW.x+vec3(waterTriGY.x,0.,waterTriGY.y)*waterTriW.y+vec3(waterTriGZ.x,waterTriGZ.y,0.)*waterTriW.z;vec3 waterRainNormal=vec3(rainColorRipples.x,0.,rainColorRipples.y)*waterRainMask*.9;vec3 waterMicroNormal=normalize(waterWorldNormal+vec3(-waterTriGrad.x*.11,0.,-waterTriGrad.z*.11)+waterRainNormal);normal=normalize(mat3(viewMatrix)*waterMicroNormal);');shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_end>','vec3 waterViewDir=normalize(cameraPosition-w);vec3 waterReflectDir=reflect(-waterViewDir,normalize(waterMicroNormal));vec3 waterCubeColor=textureCube(uCubeReflection,waterReflectDir).rgb;float waterViewFresnel=.02+.98*pow(1.-clamp(abs(dot(normalize(waterMicroNormal),waterViewDir)),0.,1.),5.);float waterCubeWeight=clamp(uReflect*(.2+.8*waterViewFresnel)*(1.-roughnessFactor*.35),0.,.95);reflectedLight.indirectSpecular=mix(reflectedLight.indirectSpecular,waterCubeColor,waterCubeWeight);reflectedLight.directSpecular*=.22;\n#include <lights_fragment_end>');};
waterMat.customProgramCacheKey=()=>'terrain-water-pbr-v9-triplanar-fft-foam-shore-sets';
const water=new THREE.Mesh(makeWaterGeometry(waterQuality),waterMat);water.frustumCulled=false;water.visible=true;scene.add(water);water.name='Water Surface';
const makeWaterReflectionTarget=()=>new THREE.WebGLCubeRenderTarget(WATER_QUALITY[waterQuality].reflection,{format:THREE.RGBFormat,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter});let waterReflectionRT=makeWaterReflectionTarget();waterReflectionRT.texture.mapping=THREE.CubeReflectionMapping;U.uCubeReflection.value=waterReflectionRT.texture;const waterReflectionCam=new THREE.CubeCamera(.1,1600,waterReflectionRT);waterReflectionCam.name='Water Reflection Probe';scene.add(waterReflectionCam);waterMat.envMap=waterReflectionRT.texture;
function syncWaterPhysical(){waterMat.roughness=exClamp(U.uRoughness.value,.025,1);waterMat.clearcoat=exClamp(1.-U.uRoughness.value*.35,0,1);waterMat.clearcoatRoughness=exClamp(U.uRoughness.value*.35,.025,.6);waterMat.envMapIntensity=exClamp(U.uReflect.value,0,1.5);/* F0 at normal incidence for water is 0.02 (n = 1.333), and three maps
   reflectivity onto F0 = 0.16 r^2, so 0.354 is the only value that is water.
   The slider moves the glancing reflection within a narrow band around that
   — it must not pretend water has the IOR of glass, which is what 0.5 (F0
   0.04, n 1.5) and above were doing. */
waterMat.reflectivity=exClamp(Math.sqrt(.02/.16)+(U.uReflect.value-1)*.06,.28,.46);waterMat.transmission=Math.max(.001,exClamp(U.uRefraction.value*U.uTransparency.value*WATER_QUALITY[waterQuality].transmission,0,1));waterMat.opacity=1}
let waterReflectionInterval=WATER_QUALITY[waterQuality].interval,waterReflectionReady=false,waterReflectionFailures=0,waterReflectionFailed=false,waterReflectionRetryAt=0,waterReflectionViewMovedAt=performance.now();const waterReflectionViewAnchor=cam.position.clone(),waterReflectionOrientationAnchor=cam.quaternion.clone();
function resizeWaterReflectionTarget(){const size=WATER_QUALITY[waterQuality].reflection;if(waterReflectionRT.width!==size||waterReflectionRT.height!==size){waterReflectionRT.setSize(size,size);waterReflectionCam.renderTarget=waterReflectionRT;waterReflectionRT.texture.mapping=THREE.CubeReflectionMapping;U.uCubeReflection.value=waterReflectionRT.texture;waterMat.envMap=waterReflectionRT.texture;waterMat.needsUpdate=true}waterReflectionReady=false;waterReflectionViewMovedAt=performance.now()}
function setWaterQuality(q){q=exClamp(Math.round(Number(q)||0),0,WATER_QUALITY.length-1);const cfg=WATER_QUALITY[q];if(q!==waterQuality){water.geometry.dispose();water.geometry=makeWaterGeometry(q);waterQuality=q}resizeWaterReflectionTarget();waterReflectionInterval=cfg.interval;waterReflectionFailed=false;waterReflectionRetryAt=0;}
function beginWaterReflectionCapture(){const keep=new Set([ter,sky,sun,sun.target,hemi,envFill,waterReflectionCam,...clouds]);if(typeof OW!=='undefined'&&OW?.active)keep.add(OW.group);if(typeof mapRoot!=='undefined'&&mapRoot)keep.add(mapRoot);for(const o of typeof objs!=='undefined'?objs:[]){const kind=String(o.userData?.n||o.name||'').split('.')[0].toLowerCase();if(/grass|flower|daisy|tulip|lavender|pine|oak|birch|palm|shrub|rock|spruce|krumm|juniper|saguaro|barrel|prickly|acacia|joshua|agave|sage|sandrock|deadtree|ashbush|treefern|fern|basalt/i.test(kind))keep.add(o)}for(const k of ['grass','tallgrass','flower','daisy','tulip','lavender','rock','sandrock','basalt','pine','oak','birch','palm','shrub','spruce','krumm','juniper','saguaro','barrel','prickly','acacia','joshua','agave','sage','deadtree','ashbush','treefern','fern']){const K=KIND[k];if(!K)continue;for(const list of [K.meshes,K.shadowMeshes])if(Array.isArray(list))for(const o of list)if(o)keep.add(o)}const waterVisible=water.visible,hidden=[],sunVisible=sun.visible,normalScales=[U.uNS?.value,U.uNM?.value,U.uNP?.value];water.visible=false;sun.visible=false;if(U.uNS)U.uNS.value=0;if(U.uNM)U.uNM.value=0;if(U.uNP)U.uNP.value=0;for(const o of scene.children){if(o===water||keep.has(o))continue;if(o.visible){hidden.push(o);o.visible=false}}return()=>{water.visible=waterVisible;sun.visible=sunVisible;if(U.uNS)U.uNS.value=normalScales[0];if(U.uNM)U.uNM.value=normalScales[1];if(U.uNP)U.uNP.value=normalScales[2];for(const o of hidden)o.visible=true}}
function waterReflectionProbeXZ(){const open=typeof OW!=='undefined'&&OW?.active,p=exploreMode?cam.getWorldPosition(new THREE.Vector3()):cam.position,cx=p.x,cz=p.z,half=open?OW.config.sizeKm*500:S*.5,probeY=water.position.y+.42,ground=(x,z)=>open?OW.heightAt(x,z):hgt(x,z),free=(x,z)=>Math.abs(x)>=half-.25||Math.abs(z)>=half-.25||ground(x,z)<=probeY-.04;if(free(cx,cz))return{x:cx,z:cz};let dx=cx-(oc.target?.x||0),dz=cz-(oc.target?.z||0),len=Math.hypot(dx,dz);if(len<.01){const a=(az||0)*Math.PI/180;dx=Math.cos(a);dz=Math.sin(a);len=1}const base=Math.atan2(dz,dx),limit=open?Math.min(Math.max(OW.chunkSize*2,half*.65),5000):Math.max(S*1.5,64),step=open?32:4;for(let r=step;r<=limit;r+=step)for(let i=0;i<8;i++){const a=base+i*Math.PI/4,x=cx+Math.cos(a)*r,z=cz+Math.sin(a)*r;if(free(x,z))return{x,z}}return{x:cx+dx/len*(limit+step),z:cz+dz/len*(limit+step)}}
function updateWaterReflection(){if(!water.visible||U.uReflect.value<.01||waterReflectionFailed&&performance.now()<waterReflectionRetryAt)return;const now=performance.now();if(cam.position.distanceToSquared(waterReflectionViewAnchor)>.0025||cam.quaternion.angleTo(waterReflectionOrientationAnchor)>.003){waterReflectionViewAnchor.copy(cam.position);waterReflectionOrientationAnchor.copy(cam.quaternion);waterReflectionViewMovedAt=now;return}if(now-waterReflectionViewMovedAt<350||waterReflectionReady&&fr%waterReflectionInterval!==0)return;const probe=waterReflectionProbeXZ(),restoreReflectionScene=beginWaterReflectionCapture();waterReflectionCam.position.set(probe.x,water.position.y+.42,probe.z);try{waterReflectionCam.update(ren,scene);waterReflectionReady=true;waterReflectionFailed=false;waterReflectionRetryAt=0;waterReflectionFailures=0;if(waterMat.envMap!==waterReflectionRT.texture){waterMat.envMap=waterReflectionRT.texture;waterMat.needsUpdate=true}}catch(e){waterReflectionReady=false;waterReflectionFailed=true;waterReflectionRetryAt=performance.now()+3000;if(++waterReflectionFailures===1)console.warn('Dynamic water environment reflection capture failed; keeping the last captured frame.',e)}finally{restoreReflectionScene()}}
/* ---------------------------------------------------------------- */
/* Water is an optical medium, not a colour swatch                   */
/* ---------------------------------------------------------------- */
/* A body of water looks the way it does because of what is dissolved and
   suspended in it. Each preset below is therefore described by measurements a
   limnologist would recognise - a Jerlov optical water type, a CDOM (gilvin)
   load, a suspended-sediment load, a Secchi depth, a Beaufort sea state -
   and its deep/shallow/turbid colours are *derived* from those with the
   Beer-Lambert law against the C++ `fe_water_optical` kernel. The authored
   colours are kept only as the exposure reference (their peak channel), so a
   preset keeps the brightness the look was tuned to while its hue comes from
   physics. */
const WATER_SILT=[[.55,.50,.42],[.52,.47,.38],[.50,.44,.33],[.46,.40,.30],[.45,.38,.27],[.56,.52,.45],[.50,.46,.38],[.48,.42,.32]];
const WATER_OPTICAL_FALLBACK=[
 [.3050,.0545,.0145,.0030],[.3500,.0750,.0200,.0100],[.4200,.1100,.0450,.0500],[.5500,.2000,.1150,.3500],
 [.7200,.3600,.3000,1.2000],[.3250,.0620,.0180,.0045],[.3850,.0680,.0280,.0070],[.4800,.1450,.0850,.0900]];
function waterOpticalFor(source){
 const type=cl((typeof source==='number'?source:source&&source.jerlov)|0,0,7);
 let o=null;
 if(typeof core!=='undefined'&&core&&typeof core.waterOptical==='function')o=core.waterOptical(type);
 if(!o)o=WATER_OPTICAL_FALLBACK[type];
 /* CDOM absorbs short wavelengths hardest, which is what turns a peat bog
    brown instead of blue: it is a blue absorber, not a dye. */
 const cdom=cl((source&&source.cdom)||0,0,2);
 return [o[0],o[1]+cdom*.35,o[2]+cdom*1.60,o[3],o[4]===undefined?o[3]:o[4],o[5]===undefined?o[3]:o[5]];
}
function waterScaleTo(rgb,reference){
 const peak=Math.max(rgb[0],rgb[1],rgb[2])||1;
 const ref=Math.max(Array.isArray(reference)||ArrayBuffer.isView(reference)?Math.max(reference[0],reference[1],reference[2]):1,.02);
 return rgb.map(v=>cl(v/peak*ref,0,1));
}
/* Light coming back out of shallow water is mostly the bed seen through the
   column, which is why a reef over sand is turquoise while the same water over
   rock is dark: red is gone after a few metres, so the bed's neutral albedo
   arrives blue-green. */
function waterShallowColour(source){
 const o=waterOpticalFor(source),d=3,bottom=[.42,.38,.30],out=[0,0,0];
 for(let i=0;i<3;i++){
  const s=o[3+i]/(o[i]+o[3+i]);
  out[i]=bottom[i]*Math.exp(-o[i]*d)+s*.12;
 }
 const peak=Math.max(out[0],out[1],out[2])||1;
 return out.map(v=>cl(v/peak,0,1));
}
function waterColumnColour(source,depth){
 const o=waterOpticalFor(source),d=cl(depth===undefined?9:depth,0,60),out=[0,0,0];
 for(let i=0;i<3;i++){
  const a=o[i],b=o[3+i],t=Math.exp(-a*d),s=b/(a+b);
  /* Light that survived the path plus the part the water scattered back. */
  out[i]=t*(1-s)+s*.55;
 }
 const peak=Math.max(out[0],out[1],out[2])||1;
 return out.map(v=>cl(v/peak,0,1));
}
function beaufortOf(speed){
 const bands=[0.3,1.6,3.4,5.5,8,10.8,13.9,17.2,20.8,24.5,28.5,32.7];
 const u=cl(+speed||0,0,60);
 for(let i=0;i<bands.length;i++)if(u<bands[i])return i;
 return 12;
}
/* Hydration is idempotent and lazy: the array literal stays a literal (it is
   the exposure reference the presets were tuned against) while every read of a
   preset returns the physical version. */
function waterProfileFor(index){
 const p=WATER_PROFILES[cl(index|0,0,WATER_PROFILES.length-1)];
 if(!p)return null;
 if(p.__hydrated)return p;
 p.__hydrated=true;
 const sediment=cl(p.sediment===undefined?.05:p.sediment,0,1);
 const o=waterOpticalFor(p);
 const silt=WATER_SILT[cl(p.jerlov|0,0,7)];
 p.deep=waterScaleTo(waterColumnColour(p,12),p.deep);
 /* Shallow water is the bottom seen through the water, so the sediment tints
    it directly - that is why a silty river reads brown at the edge and a reef
    reads turquoise. */
 const shallow=waterShallowColour(p).map((v,i)=>v+(silt[i]-v)*sediment);
 p.shallow=waterScaleTo(shallow,p.shallow);
 p.turbid=waterScaleTo(silt,p.turbid);
 /* Secchi depth from the diffuse attenuation in the green/blue, 1.44/Kd. */
 const kd=(o[1]+o[2])*.5+o[3];
 p.secchi=+(1.44/Math.max(kd,1e-4)).toFixed(1);
 p.clarity=cl(p.secchi/10,.3,4);
 p.turbidity=cl(sediment*.9+o[3]*.15,.02,1);
 /* How much of the bed a swimmer sees: it follows the Secchi depth, not the
    silt load alone. A peat bog carries almost no suspended sediment but eats
    its own light within a metre, and deriving transmission from sediment gave
    it 92% — so the darkest water in the list rendered like glass. */
 p.transparency=cl(.12+.88*(1-Math.exp(-p.secchi/6))-sediment*.25,.08,1);
 p.beaufort=beaufortOf(p.wind);
 p.optics={type:cl(p.jerlov|0,0,7),absorb:[+o[0].toFixed(4),+o[1].toFixed(4),+o[2].toFixed(4)],scatter:+o[3].toFixed(4)};
 return p;
}
window.__feWaterPresets=()=>WATER_PROFILES.map((p,i)=>waterProfileFor(i));
window.__feWaterOptics=waterOpticalFor;

const WATER_PROFILES=[
 /* The three originals keep their authored order of fields: the studio tests
    pin that these presets own independent colour, wave and optical controls. */
 {name:'Ocean',deep:[.004,.025,.14],shallow:[.018,.19,.46],clarity:1.8,height:1.25,scale:1,speed:1.55,period:8,chop:.26,roughness:.09,reflect:1.12,refraction:.58,turbidity:.08,transparency:.94,turbid:[.025,.12,.27],foam:.9,threshold:.7,shore:1.15,wind:12,direction:35,jerlov:0,cdom:0,sediment:.02,tempC:17,salinityPSU:35,fetchKm:400},
 {name:'Lagoon',deep:[.012,.25,.28],shallow:[.14,.72,.53],clarity:4.2,height:.22,scale:.72,speed:.62,period:6,chop:.06,roughness:.07,reflect:.82,refraction:.88,turbidity:.035,transparency:1,turbid:[.07,.4,.32],foam:.24,threshold:.9,shore:.55,wind:4.5,direction:20,jerlov:2,cdom:.02,sediment:.06,tempC:27,salinityPSU:34,fetchKm:6},
 {name:'Murky',deep:[.075,.072,.032],shallow:[.3,.24,.085],clarity:.45,height:.24,scale:.8,speed:.52,period:7,chop:.06,roughness:.86,reflect:.2,refraction:.08,turbidity:1,transparency:.12,turbid:[.32,.26,.09],foam:.06,threshold:.98,shore:.2,wind:4.5,direction:55,jerlov:4,cdom:.25,sediment:.85,tempC:21,salinityPSU:2,fetchKm:1.5},
 {name:'Reef',deep:[.008,.09,.20],shallow:[.05,.42,.44],clarity:3.6,height:.42,scale:.9,speed:.8,period:6.4,chop:.1,roughness:.08,reflect:.95,refraction:.8,turbidity:.05,transparency:.98,turbid:[.32,.44,.36],foam:.42,threshold:.86,shore:.8,wind:6,direction:120,jerlov:5,cdom:0,sediment:.03,tempC:29,salinityPSU:35,fetchKm:12},
 {name:'Alpine Lake',deep:[.006,.06,.10],shallow:[.06,.26,.30],clarity:3.2,height:.16,scale:.78,speed:.5,period:4.4,chop:.05,roughness:.06,reflect:.9,refraction:.86,turbidity:.04,transparency:.96,turbid:[.28,.32,.26],foam:.14,threshold:.94,shore:.4,wind:4.5,direction:250,jerlov:1,cdom:.04,sediment:.05,tempC:7,salinityPSU:.1,fetchKm:3},
 {name:'River',deep:[.10,.085,.03],shallow:[.34,.29,.13],clarity:.5,height:.2,scale:.85,speed:1.6,period:3.2,chop:.1,roughness:.5,reflect:.32,refraction:.2,turbidity:.85,transparency:.3,turbid:[.42,.34,.16],foam:.5,threshold:.82,shore:.5,wind:4,direction:80,jerlov:3,cdom:.3,sediment:.7,tempC:16,salinityPSU:.2,fetchKm:.6},
 {name:'Estuary',deep:[.07,.08,.045],shallow:[.28,.3,.16],clarity:.35,height:.3,scale:.88,speed:.9,period:4.2,chop:.08,roughness:.42,reflect:.42,refraction:.32,turbidity:.7,transparency:.44,turbid:[.36,.32,.18],foam:.3,threshold:.9,shore:.6,wind:6.5,direction:100,jerlov:4,cdom:.2,sediment:.5,tempC:19,salinityPSU:12,fetchKm:4},
 {name:'Peat Bog',deep:[.05,.06,.02],shallow:[.24,.22,.06],clarity:.3,height:.06,scale:.7,speed:.3,period:2.6,chop:.03,roughness:.24,reflect:.4,refraction:.5,turbidity:.4,transparency:.7,turbid:[.26,.2,.06],foam:.05,threshold:.97,shore:.15,wind:2.5,direction:15,jerlov:1,cdom:.9,sediment:.15,tempC:12,salinityPSU:.05,fetchKm:.15}
];
function setWater(i){const p=waterProfileFor(Number(i));if(!p)return;wp=Number(i);water.userData.waterProfile=p.name;U.deep.value.setRGB(...p.deep);U.shal.value.setRGB(...p.shallow);U.clar.value=p.clarity;U.amp.value=ampUser=p.height;waterWaveScale=p.scale;U.uWaveScale.value=p.scale;wspd=p.speed;waterWavePeriod=p.period;U.uWavePeriod.value=p.period;waveChop=p.chop;U.uChop.value=p.chop;U.uRoughness.value=(window.FELandscapeRealism&&window.FELandscapeRealism.waterRoughness)?window.FELandscapeRealism.waterRoughness(p):p.roughness;U.uReflect.value=p.reflect;U.uRefraction.value=p.refraction;U.uTurbidity.value=p.turbidity;U.uTransparency.value=p.transparency;U.uTurbidColor.value.setRGB(...p.turbid);U.uFoamAmt.value=p.foam;U.uFoamThreshold.value=p.threshold;U.uShoreFoam.value=p.shore;waterWindSpeed=p.wind;waterWindDir=p.direction;U.uWindDir.value.set(Math.cos(waterWindDir*Math.PI/180),Math.sin(waterWindDir*Math.PI/180));U.uWindSpeed.value=waterWindSpeed;}
setWater(0);
/* clouds */
const cc=document.createElement('canvas');cc.width=cc.height=64;const cx=cc.getContext('2d'),gr=cx.createRadialGradient(32,32,0,32,32,32);
gr.addColorStop(0,'rgba(255,255,255,.9)');gr.addColorStop(1,'rgba(255,255,255,0)');cx.fillStyle=gr;cx.fillRect(0,0,64,64);
const ctex=new THREE.CanvasTexture(cc),clouds=[];
for(let i=0;i<14;i++){const g=new THREE.Group();g.position.set((R()-.5)*500,70+R()*40,(R()-.5)*500);
for(let k=0;k<7;k++){const s=new THREE.Sprite(new THREE.SpriteMaterial({map:ctex,transparent:true,depthWrite:false,fog:false,opacity:.75}));s.scale.set(40+R()*30,22+R()*10,1);s.position.set((R()-.5)*50,R()*6,(R()-.5)*20);g.add(s)}scene.add(g);clouds.push(g)}
/* terrain */
const H=new Float32Array(W*W),MI=new Uint8Array(W*W).fill(255);
const hmTex=new THREE.DataTexture(H,W,W,THREE.RedFormat,THREE.FloatType);hmTex.minFilter=hmTex.magFilter=THREE.NearestFilter;U.hm.value=hmTex;
/* Grid geometry, built as typed arrays instead of three's PlaneGeometry.
   Building a 513x513 plane through PlaneGeometry costs 130 ms of the studio's
   boot on a desktop and several hundred on a phone: it pushes positions and
   uvs into plain JS arrays, allocates a 1.57 million element JS array for the
   index, then converts all of it. The layout below is byte-for-byte the same
   plane three produces -- same winding, same uv origin, same XZ orientation
   after the -90 degree X rotation -- written straight into the buffers the GPU
   wants, which takes a tenth of that. Heights and normals still come from the
   kernel; this only assembles the buffer, which is the GPU bridge's job. */
function feGridGeometry(n,span){
 const W=n+1,cnt=W*W,pos=new Float32Array(cnt*3),nrm=new Float32Array(cnt*3),uv=new Float32Array(cnt*2),idx=new Uint32Array(n*n*6);
 let p=0,u=0;
 for(let j=0;j<W;j++){
  const z=(j/n-.5)*span,v=1-j/n;
  for(let i=0;i<W;i++){
   pos[p]=(i/n-.5)*span;pos[p+1]=0;pos[p+2]=z;
   nrm[p+1]=1;
   uv[u++]=i/n;uv[u++]=v;
   p+=3;
  }
 }
 let k=0;
 for(let j=0;j<n;j++)for(let i=0;i<n;i++){
  const a=j*W+i,b=(j+1)*W+i,d=a+1,c=b+1;
  idx[k++]=a;idx[k++]=b;idx[k++]=d;idx[k++]=b;idx[k++]=c;idx[k++]=d;
 }
 const geo=new THREE.BufferGeometry();
 geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
 geo.setAttribute('normal',new THREE.BufferAttribute(nrm,3));
 geo.setAttribute('uv',new THREE.BufferAttribute(uv,2));
 geo.setIndex(new THREE.BufferAttribute(idx,1));
 return geo;
}
const tg=feGridGeometry(N,S),PA=tg.attributes.position,SWA=new Float32Array(W*W*4),SWB=new Float32Array(W*W*4),SWC=new Float32Array(W*W*4);
tg.setAttribute('color',new THREE.BufferAttribute(new Float32Array(W*W*3),3));tg.setAttribute('surfaceWeightsA',new THREE.BufferAttribute(SWA,4));tg.setAttribute('surfaceWeightsB',new THREE.BufferAttribute(SWB,4));tg.setAttribute('surfaceWeightsC',new THREE.BufferAttribute(SWC,4));const C=tg.attributes.color;
function mkNormal(){const n=128,c=document.createElement('canvas');c.width=c.height=n;const x=c.getContext('2d'),d=x.createImageData(n,n),hash2=(a,b)=>{const s=Math.sin(a*127.1+b*311.7)*43758.5453;return s-Math.floor(s)},noise2=(u,v)=>{const ix=Math.floor(u),iy=Math.floor(v),fx=u-ix,fy=v-iy,tx=fx*fx*(3-2*fx),ty=fy*fy*(3-2*fy),h=(a,b)=>hash2(ix+a,iy+b),a=h(0,0)*(1-tx)+h(1,0)*tx,b=h(0,1)*(1-tx)+h(1,1)*tx;return a*(1-ty)+b*ty},g=new Float32Array(n*n);for(let y=0;y<n;y++)for(let i=0;i<n;i++){const u=i/n*4,v=y/n*4;g[y*n+i]=noise2(u,v)*.62+noise2(u*2.03+13.1,v*2.03-7.2)*.26+noise2(u*4.1-3.5,v*4.1+9.4)*.12}const G=(a,b)=>g[((b+n)%n)*n+((a+n)%n)];
for(let y=0;y<n;y++)for(let i=0;i<n;i++){const nx=-(G(i+1,y)-G(i-1,y))*2,ny=-(G(i,y+1)-G(i,y-1))*2,l=Math.hypot(nx,ny,1),k=(y*n+i)*4;d.data[k]=(nx/l*.5+.5)*255;d.data[k+1]=(ny/l*.5+.5)*255;d.data[k+2]=255/l;d.data[k+3]=255}
x.putImageData(d,0,0);const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(40,40);return t}
/* Deferred fallback textures -----------------------------------------------
   Boot used to spend its module-load budget drawing roughly eighty thousand
   canvas operations of JS stand-in textures -- five 256 px terrain details,
   twelve 256 px biome tiles and their 1024x768 atlas -- and then the C++
   surface kernels replaced every one of them a moment later. The canvases and
   the GPU textures are still made here, because materials and shaders need a
   texture object to bind before the first frame, but the pixels are painted in
   five-millisecond idle slices once that first frame is on screen. If the C++
   path takes over, discard() drops the queue instead of paying for work
   nobody sees. */
const BOOT_PAINT=(()=>{
  const jobs=[];let queued=false,closed=false;
  const now=()=>(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  function idle(fn){
    if(typeof requestIdleCallback==='function')requestIdleCallback(fn,{timeout:600});
    else if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>requestAnimationFrame(fn));
    else setTimeout(fn,32);
  }
  function drain(){
    queued=false;
    const deadline=now()+5;
    while(jobs.length){
      const job=jobs.shift();
      try{job()}catch(error){if(typeof console!=='undefined')console.warn('deferred surface texture skipped',error)}
      if(now()>=deadline)break;
    }
    if(jobs.length&&!closed)queue();
  }
  function queue(){
    if(queued||closed)return;
    queued=true;idle(drain);
  }
  return {
    add(fn){if(closed)return;jobs.push(fn);queue()},
    discard(){closed=true;jobs.length=0},
    pending(){return jobs.length},
  };
})();
if(typeof window!=='undefined')window.FE_BOOT_PAINT=BOOT_PAINT;
function terrainDetailTex(kind){const c=document.createElement('canvas');c.width=c.height=256;const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;if('colorSpace'in t&&THREE.NoColorSpace!==undefined)t.colorSpace=THREE.NoColorSpace;else if('encoding'in t)t.encoding=THREE.LinearEncoding;t.needsUpdate=true;
/* The base colour is one fillRect and it has to be there before anything
   else touches this canvas: the C++ surface pass multiplies its detail into
   the pixels that are already here, so a deferred base comes out black.
   Only the thousands of noise strokes are deferred. */
{const x=c.getContext('2d'),cfg={grass:[220,234,210],soil:[202,188,168],rock:[210,212,214],snow:[244,247,250],rough:[210,210,210]}[kind]||[210,210,210];x.fillStyle=`rgb(${cfg[0]},${cfg[1]},${cfg[2]})`;x.fillRect(0,0,256,256);}
BOOT_PAINT.add(()=>{const x=c.getContext('2d'),cfg={grass:[220,234,210],soil:[202,188,168],rock:[210,212,214],snow:[244,247,250],rough:[210,210,210]}[kind]||[210,210,210];for(let i=0;i<5200;i++){const n=(R()-.5)*(kind==='rough'?74:46),v=Math.max(0,Math.min(255,Math.round(cfg[0]+n)));x.fillStyle=`rgba(${v},${Math.max(0,Math.min(255,cfg[1]+n))},${Math.max(0,Math.min(255,cfg[2]+n))},${.12+R()*.32})`;const w=kind==='grass'?1+R()*2:1+R()*4,h=kind==='rock'?1+R()*5:1+R()*3;x.fillRect(R()*256,R()*256,w,h)}if(kind==='grass'){for(let i=0;i<260;i++){x.strokeStyle=`rgba(48,78,38,${.1+R()*.16})`;x.lineWidth=.5+R();const px=R()*256,py=R()*256;x.beginPath();x.moveTo(px,py);x.quadraticCurveTo(px+(R()-.5)*4,py-3,px+(R()-.5)*7,py-7-R()*12);x.stroke()}}else if(kind==='rock'){for(let i=0;i<42;i++){const px=R()*256,py=R()*256;x.strokeStyle=`rgba(90,94,98,${.1+R()*.15})`;x.lineWidth=.5+R()*1.3;x.beginPath();x.moveTo(px,py);x.lineTo(px+(R()-.5)*30,py+(R()-.5)*25);x.stroke()}}t.needsUpdate=true});return t}const TERRAIN_PBR={grass:terrainDetailTex('grass'),soil:terrainDetailTex('soil'),rock:terrainDetailTex('rock'),snow:terrainDetailTex('snow'),rough:terrainDetailTex('rough')};
const OW_SURFACE_DEFS=[{key:'hills',label:'Hills',rgb:[103,129,76],rough:.9},{key:'alpine',label:'Alpine',rgb:[139,148,139],rough:.84},{key:'desert',label:'Desert',rgb:[185,145,87],rough:.92},{key:'volcano',label:'Volcano',rgb:[57,54,52],rough:.96},{key:'shore',label:'Sand Shores',rgb:[218,198,145],rough:.98},{key:'rocky',label:'Rocky Mountains',rgb:[112,108,100],rough:.9},{key:'grassy',label:'Grassy',rgb:[83,133,59],rough:.96},{key:'sand',label:'Sand',rgb:[185,150,96],rough:.94},{key:'lava',label:'Lava',rgb:[183,54,16],rough:.74},{key:'magma',label:'Magma',rgb:[107,24,44],rough:.66},{key:'pebbles',label:'Pebbles',rgb:[122,118,109],rough:.88},{key:'beach',label:'Beach Sand',rgb:[226,207,154],rough:.98}];
function owSurfaceTexture(def,i){const c=document.createElement('canvas');c.width=c.height=256;const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.anisotropy=Math.min(4,ren.capabilities.getMaxAnisotropy()||1);if('encoding'in t)t.encoding=THREE.SRGBEncoding||THREE.sRGBEncoding;t.needsUpdate=true;
/* The base colour is one fillRect and it has to be there before anything
   else touches this canvas: the C++ surface pass multiplies its detail into
   the pixels that are already here, so a deferred base comes out black.
   Only the thousands of noise strokes are deferred. */
{const x=c.getContext('2d'),[r,g,b]=def.rgb;x.fillStyle='rgb('+r+','+g+','+b+')';x.fillRect(0,0,256,256);}
BOOT_PAINT.add(()=>{const x=c.getContext('2d'),[r,g,b]=def.rgb,key=def.key;let state=(0x9e3779b9^Math.imul(i+1,0x45d9f3b))>>>0;const rnd=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296};for(let n=0;n<4200;n++){const q=(rnd()-.5)*(key==='grassy'?36:58),a=cl(Math.round(r+q),0,255),bb=cl(Math.round(g+q*.82),0,255),cc=cl(Math.round(b+q*.66),0,255);x.fillStyle='rgba('+a+','+bb+','+cc+','+(.12+rnd()*.3)+')';const px=rnd()*256,py=rnd()*256;if(key==='grassy'){x.strokeStyle=x.fillStyle;x.lineWidth=.35+rnd()*.7;x.beginPath();x.moveTo(px,py);x.lineTo(px+(rnd()-.5)*5,py-3-rnd()*12);x.stroke()}else{x.fillRect(px,py,1+rnd()*3,1+rnd()*4)}}if(key==='pebbles'){for(let n=0;n<650;n++){const px=rnd()*256,py=rnd()*256,rx=1+rnd()*4,ry=1+rnd()*3,v=Math.round(80+rnd()*105);x.fillStyle='rgba('+v+','+v+','+(v-5)+','+(.22+rnd()*.42)+')';x.beginPath();x.ellipse(px,py,rx,ry,rnd()*.4,0,6.283);x.fill();x.strokeStyle='rgba(255,255,255,.13)';x.lineWidth=.5;x.stroke()}}if(key==='sand'||key==='shore'||key==='beach'){for(let n=0;n<170;n++){const py=rnd()*256;x.strokeStyle='rgba('+Math.min(255,r+22)+','+Math.min(255,g+18)+','+Math.min(255,b+8)+','+(.08+rnd()*.18)+')';x.lineWidth=.4+rnd()*1.1;x.beginPath();x.moveTo(0,py);x.quadraticCurveTo(128,py+(rnd()-.5)*9,256,py+(rnd()-.5)*12);x.stroke()}}if(key==='lava'||key==='magma'||key==='volcano'||key==='rocky'){const glow=key==='magma'?'rgba(255,72,38,.55)':'rgba(255,145,35,.55)';for(let n=0;n<(key==='lava'||key==='magma'?55:34);n++){const px=rnd()*256,py=rnd()*256;x.strokeStyle=glow;x.lineWidth=.5+rnd()*1.8;x.beginPath();x.moveTo(px,py);x.lineTo(px+(rnd()-.5)*42,py+(rnd()-.5)*32);x.lineTo(px+(rnd()-.5)*64,py+(rnd()-.5)*56);x.stroke()}}t.needsUpdate=true});return t}const OW_PAINT_RGB=new Uint8Array(OW_SURFACE_DEFS.flatMap(d=>d.rgb));
const OW_SURFACE_MAPS=OW_SURFACE_DEFS.map(owSurfaceTexture),OW_SURFACE_ROUGHNESS=OW_SURFACE_DEFS.map(x=>x.rough);
const OW_SURFACE_ATLAS=(()=>{const tile=256,gutter=4,cell=tile+gutter*2,c=document.createElement('canvas');c.width=cell*4;c.height=cell*3;const a=new THREE.CanvasTexture(c);a.wrapS=a.wrapT=THREE.ClampToEdgeWrapping;/* Base fill is synchronous for the same reason the tiles are: the ground
   shader samples this atlas from the very first frame, and a transparent
   atlas reads as a black surface wherever the user has painted. */
{const g=c.getContext('2d');OW_SURFACE_DEFS.forEach((d,i)=>{g.fillStyle='rgb('+d.rgb[0]+','+d.rgb[1]+','+d.rgb[2]+')';g.fillRect((i%4)*cell,Math.floor(i/4)*cell,cell,cell)});a.needsUpdate=true}a.minFilter=THREE.LinearMipmapLinearFilter;a.magFilter=THREE.LinearFilter;a.anisotropy=Math.min(8,ren.capabilities.getMaxAnisotropy()||1);if('encoding'in a)a.encoding=THREE.SRGBEncoding||THREE.sRGBEncoding;;BOOT_PAINT.add(()=>{const x=c.getContext('2d');OW_SURFACE_MAPS.forEach((t,i)=>{const px=(i%4)*cell,py=Math.floor(i/4)*cell,img=t.image;x.drawImage(img,px+gutter,py+gutter,tile,tile);x.drawImage(img,0,0,1,tile,px,py+gutter,gutter,tile);x.drawImage(img,tile-1,0,1,tile,px+gutter+tile,py+gutter,gutter,tile);x.drawImage(img,0,0,tile,1,px+gutter,py,tile,gutter);x.drawImage(img,0,tile-1,tile,1,px+gutter,py+gutter+tile,tile,gutter)});a.needsUpdate=true});return a})();const tm=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.84,metalness:0,normalMap:mkNormal(),normalScale:new THREE.Vector2(.34,.34)});tm.userData.surfacePaintEnabled=true;tm.onBeforeCompile=shader=>{shader.uniforms.uTriGrass={value:TERRAIN_PBR.grass};shader.uniforms.uTriSoil={value:TERRAIN_PBR.soil};shader.uniforms.uTriRock={value:TERRAIN_PBR.rock};shader.uniforms.uTriSnow={value:TERRAIN_PBR.snow};shader.uniforms.uTriRough={value:TERRAIN_PBR.rough};shader.uniforms.uTriScale={value:.72};/* The material layers scale with the Micro detail slider, which owns the
   uniform the detail pass installs later in the boot. The object is shared,
   not copied, so both passes read the one control. */
shader.uniforms.uTriDet=window.FE_DET||{value:.4};shader.uniforms.uSurfRough={value:new THREE.Vector4(.93,.97,.62,.46)};tm.userData.feShader=shader;const pars='\nvarying vec3 vTerrainWorld;varying vec3 vTerrainNormal;uniform sampler2D uTriGrass,uTriSoil,uTriRock,uTriSnow,uTriRough;uniform float uTriScale,uTriDet;uniform vec4 uSurfRough;float triGray(sampler2D tex,vec3 p,vec3 w,float sc){return texture2D(tex,p.zy*sc).r*w.x+texture2D(tex,p.xz*sc).r*w.y+texture2D(tex,p.xy*sc).r*w.z;}\n';shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vTerrainWorld;varying vec3 vTerrainNormal;').replace('#include <begin_vertex>','#include <begin_vertex>\nvTerrainWorld=(modelMatrix*vec4(transformed,1.)).xyz;vTerrainNormal=normalize(mat3(modelMatrix)*objectNormal);');shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>'+pars).replace('#include <color_fragment>','#include <color_fragment>\nvec3 tN=normalize(vTerrainNormal),tW=pow(abs(tN),vec3(4.));tW/=max(dot(tW,vec3(1.)),.001);vec3 tBase=diffuseColor.rgb;float tSlope=1.-abs(tN.y);float tRock=clamp(smoothstep(.24,.72,tSlope)*.9,0.,.9);float tSnow=smoothstep(.75,.94,min(tBase.r,min(tBase.g,tBase.b)));float tSand=clamp((tBase.r-tBase.b)*1.7,0.,.62)*(1.-tRock)*(1.-tSnow);float tGrass=max(0.,1.-tRock-tSnow-tSand);float dG=triGray(uTriGrass,vTerrainWorld,tW,uTriScale*1.7),dS=triGray(uTriSoil,vTerrainWorld,tW,uTriScale),dR=triGray(uTriRock,vTerrainWorld,tW,uTriScale*.55),dN=triGray(uTriSnow,vTerrainWorld,tW,uTriScale*1.15);float detail=(dG*tGrass+dS*tSand+dR*tRock+dN*tSnow);/* The layers are not only brightness: grass reads slightly cool, sand and soil warm, stone neutral and snow a touch blue. The tint follows the Micro detail slider, so every slider at zero returns the flat procedural look. */vec3 tTint=(vec3(.94,1.02,.82)*tGrass+vec3(1.06,.99,.86)*tSand+vec3(.98,.99,1.01)*tRock+vec3(1.,1.015,1.05)*tSnow)/max(tGrass+tSand+tRock+tSnow,1e-3);float tMat=clamp(.68+detail*.42,.72,1.18);vec3 tShade=mix(vec3(1.),tMat*tTint,.78);diffuseColor.rgb*=mix(vec3(1.),tShade,clamp(uTriDet*1.6,0.,1.));').replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nfloat tR=triGray(uTriRough,vTerrainWorld,tW,uTriScale*1.2);roughnessFactor=clamp(roughnessFactor+(tR-.82)*.24,.55,1.);\n/* Measured roughness per surface instead of one value for the whole map:\n   fresh snow is glossy, loam is matte, granite sits between. The weights are\n   the same tGrass / tSand / tRock / tSnow masks the colour blend uses. */\nvec4 feSurfW=vec4(tGrass,tSand,tRock,tSnow);\nfeSurfW/=max(dot(feSurfW,vec4(1.)),1e-3);\nroughnessFactor=mix(roughnessFactor,clamp(dot(feSurfW,uSurfRough),.04,1.),.85);').replace('#include <aomap_fragment>','#include <aomap_fragment>\nfloat tAO=triGray(uTriRough,vTerrainWorld,tW,uTriScale*.8);ambientOcclusion*=mix(.78,1.,clamp(tAO,.3,1.));')};tm.customProgramCacheKey=()=>'terrain-triplanar-pbr-v2';tm.color.setScalar(.9);
const ter=new THREE.Mesh(tg,tm);ter.receiveShadow=true;ter.castShadow=false;ter.frustumCulled=false;scene.add(ter);
OW={active:false,generated:false,generating:false,config:{sizeKm:12,seed:42817,blend:.58,biomeMix:{hills:1,alpine:1,desert:1,volc:1},mountainHeight:48,waterCoverage:35,waterLevel:-28,vegetationDensity:.9},chunkSize:256,radius:1,chunks:new Map(),editStore:new Map(),queue:[],activeJob:null,token:0,lastCenterX:NaN,lastCenterZ:NaN,group:new THREE.Group(),savedScene:null,selected:null,history:[],redo:[],maxHistory:8,fallbackModels:new Map()};OW.group.name='Open World streamed chunks';OW.group.visible=false;scene.add(OW.group);window.__defaultOpenWorldGroup=OW.group;
const PAL=[];
function hash(x,y){const s=Math.sin(x*127.1+y*311.7+seed)*43758.5453;return s-Math.floor(s)}
function vn(x,y){const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);return hash(ix,iy)*(1-u)*(1-v)+hash(ix+1,iy)*u*(1-v)+hash(ix,iy+1)*(1-u)*v+hash(ix+1,iy+1)*u*v}
const mx3=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t],sm=(a,b,x)=>{const t=cl((x-a)/(b-a),0,1);return t*t*(3-2*t)};
/* Slope as a real gradient: rise over run over a 3 m window.
   The old measure added the two raw one-cell height deltas, so on a 0.78 m
   grid every noisy cell read as a cliff and the palette painted over half
   the island rock and soil instead of grass. A central difference over two
   cells either side ignores per-cell noise and keeps the threshold meaning
   an angle: 1.0 here is 45 degrees. */
const slopeAt=(i,j)=>{const i0=Math.max(0,i-2),i1=Math.min(N,i+2),j0=Math.max(0,j-2),j1=Math.min(N,j+2);const dx=(H[j*W+i1]-H[j*W+i0])/Math.max(1e-4,(i1-i0)*D),dz=(H[j1*W+i]-H[j0*W+i])/Math.max(1e-4,(j1-j0)*D);return Math.hypot(dx,dz)};
function mIdx(i,j){const k=j*W+i,h=H[k];if(MI[k]!=255)return MI[k];const n=vn(i*.071+seed*.17,j*.071-seed*.11),cliff=rockT+(.5-n)*.55;if(h<wl+.35+n*.55)return 3;if(h>snowL-1+(n-.5)*2.2)return 4;if(slopeAt(i,j)>cliff)return 2;if(h>9+(n-.5)*4)return 1;return 0}
function col(i,j){const k=j*W+i,h=H[k],sl=slopeAt(i,j),paintSum=SWA[k*4]+SWA[k*4+1]+SWA[k*4+2]+SWA[k*4+3]+SWB[k*4]+SWB[k*4+1]+SWB[k*4+2]+SWB[k*4+3]+SWC[k*4]+SWC[k*4+1]+SWC[k*4+2]+SWC[k*4+3];let c;if(paintSum>.001){c=[0,0,0];for(let q=0;q<OW_SURFACE_DEFS.length;q++){const w=q<4?SWA[k*4+q]:q<8?SWB[k*4+q-4]:SWC[k*4+q-8],rgb=OW_SURFACE_DEFS[q].rgb;c[0]+=rgb[0]/255*w;c[1]+=rgb[1]/255*w;c[2]+=rgb[2]/255*w}c=c.map(x=>x/paintSum)}else if(MI[k]!=255)c=PAL[MI[k]]||PAL[0];else{const broad=vn(i*.045+seed*.09,j*.045-seed*.12),mid=vn(i*.14+seed*.23,j*.14-seed*.31),fine=vn(i*.36-seed*.17,j*.36+seed*.31),field=broad*.56+mid*.3+fine*.14,ground=sm(.4,.68,field+cl((h-12)*.002,-.03,.03));c=mx3(PAL[0],PAL[1],ground*.34);const rockThreshold=rockT+(broad-.5)*.5+(mid-.5)*.25,cliff=sm(rockThreshold-.25,rockThreshold+1.15,sl),outcrop=sm(.72,.9,field)*.25,rock=cl(cliff*.88+outcrop*(1-cliff*.65),0,1);c=mx3(c,PAL[2],rock);const shore=1-sm(wl-.35+(broad-.5)*.6,wl+1.55+(broad-.5)*1.3,h),dune=biome=='desert'?sm(.46,.69,field)*(1-cliff*.8):0,sand=cl(Math.max(shore,dune)*(1-cliff*.6),0,1);c=mx3(c,PAL[3],sand);const snowNoise=(broad-.5)*6+(mid-.5)*3+(fine-.5)*1.5,snow=sm(snowL-1.2+snowNoise,snowL+3.4+snowNoise,h)*(1-cliff*.25);c=mx3(c,PAL[4],snow);const variation=.9+.18*broad+.08*(mid-.5)+.06*(fine-.5)+.04*(hash(i,j*7)-.5);c=c.map(q=>q*variation)}const v=.94+.12*hash(i*3,j*7);C.setXYZ(k,c[0]*v,c[1]*v,c[2]*v)}
function upd(x0=0,x1=N,z0=0,z1=N){
 const rx0=Math.max(0,Math.min(N,x0)),rx1=Math.max(0,Math.min(N,x1)),rz0=Math.max(0,Math.min(N,z0)),rz1=Math.max(0,Math.min(N,z1));
 const native=window.FELandscapeCore.colors({n:N,size:S,heights:H,weightsA:SWA,weightsB:SWB,weightsC:SWC,materials:MI,pal:PAL,paint:OW_PAINT_RGB,water:wl,rock:rockT,snow:snowL,desert:biome==='desert',seed,rect:[rx0,rx1,rz0,rz1],output:C.array});
 if(!native)for(let j=rz0;j<=rz1;j++)for(let i=rx0;i<=rx1;i++)col(i,j);
 for(let j=rz0;j<=rz1;j++)for(let i=rx0;i<=rx1;i++)PA.setY(j*W+i,H[j*W+i]);
 PA.needsUpdate=C.needsUpdate=hmTex.needsUpdate=tg.attributes.surfaceWeightsA.needsUpdate=tg.attributes.surfaceWeightsB.needsUpdate=tg.attributes.surfaceWeightsC.needsUpdate=true;
 if(window.FELandscapeCore.normals({n:N,size:S,heights:H,output:tg.attributes.normal.array}))tg.attributes.normal.needsUpdate=true;else tg.computeVertexNormals();
 tg.boundingSphere=tg.boundingBox=null;
}
/* The same refresh as upd(), but only the changed band goes to the GPU. A live
   erosion run uploads a row band (position, colour, normal) instead of pushing the
   heights, the colours, the normals, the three surface-weight attributes and the
   height texture — measured in docs/PERFORMANCE.md. */
/* Shader heightmap, one band at a time. `upd()` re-uploads the whole 513² float
 texture (1 MB) because it is the one place that may change every row; a live
 erosion slice only moved a rectangle, so the texture is patched through
 gl.texSubImage2D with a 32-row scratch texture instead. */
const HMB_ROWS=32;let hmBand=null,hmBandBuf=null;
function updLiveHeight(z0,z1){
 /* Rebuilt if the grid ever changes width, so a stale band can never be pasted
    into a texture of a different size. */
 if(!hmBand||!hmBandBuf||hmBandBuf.length!==W*HMB_ROWS){
  hmBandBuf=new Float32Array(W*HMB_ROWS);
  hmBand=new THREE.DataTexture(hmBandBuf,W,HMB_ROWS,THREE.RedFormat,THREE.FloatType);
  hmBand.minFilter=hmBand.magFilter=THREE.NearestFilter;hmBand.generateMipmaps=false;hmBand.needsUpdate=true;
 }
 if(!ren||typeof ren.copyTextureToTexture!=='function')return 0;
 let copies=0;
 for(let end=z1;end>=z0;){
  const start=Math.min(Math.max(z0,end-HMB_ROWS+1),W-HMB_ROWS);
  hmBandBuf.set(H.subarray(start*W,(start+HMB_ROWS)*W));
  ren.copyTextureToTexture({x:0,y:start},hmBand,hmTex);
  copies++;end=start-1;
 }
 return copies;
}
function updLive(x0,x1,z0,z1){
 const core=window.FELandscapeCore,rect=[x0,x1,z0,z1];
 if(!core.colors({n:N,size:S,heights:H,weightsA:SWA,weightsB:SWB,weightsC:SWC,materials:MI,pal:PAL,paint:OW_PAINT_RGB,water:wl,rock:rockT,snow:snowL,desert:biome==='desert',seed,rect,output:C.array}))
  for(let j=z0;j<=z1;j++)for(let i=x0;i<=x1;i++)col(i,j);
 /* Track how high the band reaches while it is being written, so the bounding
    sphere is only rebuilt when the eroded ground actually grew past the one we
    have — recomputing a 513² sphere on every upload would cost more than the
    upload. Erosion mostly lowers ground, so this is nearly always free. */
 let bandY=0;
 for(let j=z0;j<=z1;j++)for(let i=x0;i<=x1;i++){const k=j*W+i,y=H[k];PA.setY(k,y);if(y>bandY)bandY=y}
 const first=z0*W,count=(z1-z0+1)*W;
 PA.updateRange.offset=first*3;PA.updateRange.count=count*3;PA.needsUpdate=true;
 C.updateRange.offset=first*3;C.updateRange.count=count*3;C.needsUpdate=true;
 const nrm=tg.attributes.normal;
 if(core.normalsRegion({n:N,size:S,heights:H,rect,output:nrm.array})){
  nrm.updateRange.offset=first*3;nrm.updateRange.count=count*3;nrm.needsUpdate=true;
 }
 updLiveHeight(z0,z1);
 const seen=tg.userData.liveMaxY;
 if(seen===undefined||bandY>seen){
  tg.userData.liveMaxY=bandY;
  tg.geometry.computeBoundingSphere();
  /* One metre of pad: a later band can rise without crossing `seen` again, and
     a sphere is allowed to be conservative. */
  if(tg.geometry.boundingSphere)tg.geometry.boundingSphere.radius+=1;
  tg.boundingBox=null;
 }
}
let GENC=0;const PLC={mtn:0,base:0};
function landRaw(x,z){const wx=(vn(x*.012+seed*.13+41,z*.012+seed*.07+13)-.5)*10,wz=(vn(x*.012+seed*.03+17,z*.012+seed*.17+61)-.5)*10;let n=0,a=.56,f=.026;for(let o=0;o<4;o++){n+=(vn((x+wx)*f+o*17,(z+wz)*f+o*11)-.5)*a;a*=.5;f*=2.05}let ridge=0,ra=.55,rf=.035;for(let o=0;o<4;o++){const q=vn((x+wx*.4)*rf+31+o*7,(z+wz*.4)*rf-17);ridge+=(1-Math.abs(q*2-1))*ra;ra*=.5;rf*=2.05}ridge=ridge/1.03125-.5;return n*hs*1.65+ridge*hs*.6+1.6}
function landH(x,z){const r=Math.hypot(x,z);let m=0,a=.55,f=.0019;for(let o=0;o<4;o++){const q=vn(x*f+seed*.21+o*13,z*f-seed*.11);m+=(1-Math.abs(q*2-1))*a;a*=.5;f*=2.1}m=m/1.03125;return landRaw(x,z)+PLC.base+PLC.mtn*Math.pow(m,1.6)*190*smJ(15,420,r)}
function gen(seedIn,cont){GENC=cont?1:0;seed=seedIn===undefined?R()*100:seedIn;MI.fill(255);SWA.fill(0);SWB.fill(0);SWC.fill(0);const native=window.FELandscapeCore.generate({n:N,size:S,heights:H,seed,hs,continental:!!GENC,base:PLC.base,mountain:PLC.mtn});if(!native)for(let j=0;j<W;j++)for(let i=0;i<W;i++){const x=i*D-S/2,z=j*D-S/2,wx=(vn(x*.012+seed*.13+41,z*.012+seed*.07+13)-.5)*10,wz=(vn(x*.012+seed*.03+17,z*.012+seed*.17+61)-.5)*10;let n=0,a=.56,f=.026;for(let o=0;o<4;o++){n+=(vn((x+wx)*f+o*17,(z+wz)*f+o*11)-.5)*a;a*=.5;f*=2.05}let ridge=0,ra=.55,rf=.035;for(let o=0;o<4;o++){const q=vn((x+wx*.4)*rf+31+o*7,(z+wz*.4)*rf-17);ridge+=(1-Math.abs(q*2-1))*ra;ra*=.5;rf*=2.05}ridge=ridge/1.03125-.5;const r=Math.hypot(x,z)/(S/2),e2=Math.max(Math.abs(x),Math.abs(z))/(S/2),fd=sm(.62,.93,e2),h0=n*hs*1.65+ridge*hs*.6-r*r*10+1.6;H[j*W+i]=GENC?landH(x,z):h0*(1-fd)-14*fd}upd();try{SB.seed=seed;sbSoon()}catch(e){}}
function hgt(x,z){if(OW?.active)return OW.heightAt(x,z);const u=cl((x+S/2)/D,0,N-.001),v=cl((z+S/2)/D,0,N-.001),i=u|0,j=v|0,a=u-i,b=v-j,k=j*W+i;return H[k]*(1-a)*(1-b)+H[k+1]*a*(1-b)+H[k+W]*(1-a)*b+H[k+W+1]*a*b}
const SHORE_SPRAY_COUNT=160;let shoreSpray=null,sprayLife=null,sprayMaxLife=null,sprayVelocity=null;
function createShoreSpray(){const p=new Float32Array(SHORE_SPRAY_COUNT*3),sz=new Float32Array(SHORE_SPRAY_COUNT),al=new Float32Array(SHORE_SPRAY_COUNT);sprayLife=new Float32Array(SHORE_SPRAY_COUNT);sprayMaxLife=new Float32Array(SHORE_SPRAY_COUNT);sprayVelocity=new Float32Array(SHORE_SPRAY_COUNT*3);const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(p,3));geo.setAttribute('aSize',new THREE.BufferAttribute(sz,1));geo.setAttribute('aAlpha',new THREE.BufferAttribute(al,1));const mat=new THREE.ShaderMaterial({uniforms:{uSize:{value:34}},vertexShader:'attribute float aSize,aAlpha;uniform float uSize;varying float vAlpha;void main(){vAlpha=aAlpha;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(aSize*uSize/max(-mv.z,1.),1.,14.);gl_Position=projectionMatrix*mv;}',fragmentShader:'varying float vAlpha;void main(){vec2 q=gl_PointCoord-vec2(.5);float d=length(q);float a=(1.-smoothstep(.12,.5,d))*vAlpha;if(a<.015)discard;gl_FragColor=vec4(.82,.93,1.,a);}',transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});shoreSpray=new THREE.Points(geo,mat);shoreSpray.name='Ocean shoreline spray';shoreSpray.frustumCulled=false;shoreSpray.renderOrder=4;shoreSpray.visible=false;scene.add(shoreSpray);for(let i=0;i<SHORE_SPRAY_COUNT;i++)resetShoreSpray(i,true)}
function resetShoreSpray(i,initial=false){const p=shoreSpray?.geometry?.attributes?.position,sz=shoreSpray?.geometry?.attributes?.aSize,al=shoreSpray?.geometry?.attributes?.aAlpha;if(!p)return;let found=false;const center=OW?.active?owCenter():{x:0,z:0},span=OW?.active?120:S-2;for(let tries=0;tries<48;tries++){const x=center.x+(R()-.5)*span,z=center.z+(R()-.5)*span,ground=hgt(x,z),depth=wl-ground,crest=Math.sin(x*.091+z*.137+U.t.value*1.35+R()*2.4);if(depth<-.2||depth>1.15||crest<.1)continue;const j=i*3;p.array[j]=x;p.array[j+1]=Math.max(wl,ground)+.04+R()*.22;p.array[j+2]=z;sprayVelocity[j]=Math.cos(waterWindDir*Math.PI/180)*(.3+R()*1.1)+(R()-.5)*.7;sprayVelocity[j+1]=.8+R()*2.2+Math.min(waterWindSpeed,20)*.035;sprayVelocity[j+2]=Math.sin(waterWindDir*Math.PI/180)*(.3+R()*1.1)+(R()-.5)*.7;sprayLife[i]=sprayMaxLife[i]=.28+R()*.78;sz.array[i]=2.2+R()*4.2;al.array[i]=initial?0:.3+R()*.48;found=true;break}if(!found){const j=i*3;p.array[j]=0;p.array[j+1]=-10000;p.array[j+2]=0;sprayLife[i]=0;al.array[i]=0}if(initial){p.needsUpdate=true;sz.needsUpdate=true;al.needsUpdate=true}}
function updateShoreSpray(dt){if(!water.visible||waterWindSpeed<2.5){if(shoreSpray)shoreSpray.visible=false;return}if(!shoreSpray)createShoreSpray();shoreSpray.visible=true;const p=shoreSpray.geometry.attributes.position,al=shoreSpray.geometry.attributes.aAlpha;for(let i=0;i<SHORE_SPRAY_COUNT;i++){const j=i*3;sprayLife[i]-=dt;if(sprayLife[i]<=0||p.array[j+1]<Math.max(wl,hgt(p.array[j],p.array[j+2]))-.08){resetShoreSpray(i);continue}sprayVelocity[j]*=Math.max(0,1-dt*.65);sprayVelocity[j+2]*=Math.max(0,1-dt*.65);sprayVelocity[j+1]-=9.81*dt*.72;p.array[j]+=sprayVelocity[j]*dt;p.array[j+1]+=sprayVelocity[j+1]*dt;p.array[j+2]+=sprayVelocity[j+2]*dt;al.array[i]=cl(sprayLife[i]/sprayMaxLife[i],0,1)*cl(waterWindSpeed/12,.18,.72)}p.needsUpdate=true;al.needsUpdate=true}
function sculpt(p,dt){if(window.FELandscapeCore.brush({tool:br.tool,n:N,size:S,heights:H,x:p.x,z:p.z,radius:br.r,strength:br.str,dt,target:fl,seed})){const r=br.r,gx0=Math.max(0,Math.floor((p.x+S/2-r)/D)-1),gx1=Math.min(N,Math.ceil((p.x+S/2+r)/D)+1),gz0=Math.max(0,Math.floor((p.z+S/2-r)/D)-1),gz1=Math.min(N,Math.ceil((p.z+S/2+r)/D)+1);upd(gx0,gx1,gz0,gz1);if(br.tool==='erode')upd();resnapRect(gx0,gx1,gz0,gz1);return}if(br.tool=='erode'){erode(p);upd();resnapRect(Math.max(0,Math.floor((p.x+S/2-br.r*3)/D)),Math.min(N,Math.ceil((p.x+S/2+br.r*3)/D)),Math.max(0,Math.floor((p.z+S/2-br.r*3)/D)),Math.min(N,Math.ceil((p.z+S/2+br.r*3)/D)));return}const r=br.r,x0=Math.max(0,Math.floor((p.x+S/2-r)/D)),x1=Math.min(N,Math.ceil((p.x+S/2+r)/D)),z0=Math.max(0,Math.floor((p.z+S/2-r)/D)),z1=Math.min(N,Math.ceil((p.z+S/2+r)/D)),src=br.tool=='smooth'?H.slice():0;
for(let j=z0;j<=z1;j++)for(let i=x0;i<=x1;i++){const d=Math.hypot(i*D-S/2-p.x,j*D-S/2-p.z)/r;if(d>=1)continue;const f=(1-d*d)**2,k=j*W+i;
switch(br.tool){case'raise':H[k]+=br.str*f*dt*10;break;case'lower':H[k]-=br.str*f*dt*10;break;
case'flat':H[k]+=(fl-H[k])*Math.min(1,f*dt*10*br.str);break;
case'smooth':{const a=(src[k-(i>0)]+src[k+(i<N)]+src[k-(j>0)*W]+src[k+(j<N)*W])/4;H[k]+=(a-H[k])*Math.min(1,f*dt*14*br.str)}break;
case'terrace':H[k]+=(Math.round(H[k]/3)*3-H[k])*Math.min(1,f*dt*10*br.str);break;case'biome':if(f>.035)paintTerrainWorldSurface(k,normalWorldMaterial,cl(f*2*br.str,0,1));break;case'paint':if(normalWorldMaterialBrush){if(f>.035)paintTerrainWorldSurface(k,normalWorldMaterial,cl(f*2*br.str,0,1))}else if(f>.2){SWA.fill(0,k*4,k*4+4);SWB.fill(0,k*4,k*4+4);SWC.fill(0,k*4,k*4+4);MI[k]=br.tex}}}
const ux0=Math.max(0,x0-1),ux1=Math.min(N,x1+1),uz0=Math.max(0,z0-1),uz1=Math.min(N,z1+1);upd(ux0,ux1,uz0,uz1);if(br.tool!=='paint'&&br.tool!=='biome')resnapRect(ux0,ux1,uz0,uz1)}
/* biomes + erosion */
let biome='hills',hs=34,rockT=1.3,snowL=16,veg=1;
const BIO={hills:{p:[[.28,.5,.16],[.42,.29,.17],[.42,.42,.44],[.64,.56,.38],[.92,.94,.98]],s:16,v:1},
alpine:{p:[[.18,.3,.12],[.3,.26,.2],[.3,.31,.34],[.55,.55,.5],[.92,.95,1]],s:7,v:.6},
desert:{p:[[.8,.66,.42],[.62,.42,.24],[.55,.3,.18],[.72,.6,.42],[.72,.6,.42]],s:16,v:.3},
volc:{p:[[.1,.1,.11],[.16,.13,.12],[.07,.07,.08],[.13,.12,.12],[.2,.2,.22]],s:16,v:.2}};
/* The palette is written the way a person reads a colour (sRGB), but vertex
   colours reach the shader as linear light. Handing the display value
   straight to the material made every lawn a pastel mint and every rock a
   pale talc, which is the "no material" look: mid grey-green is about 0.5
   in sRGB but a lawn's real albedo is nearer 0.05. so the palette is
   converted once, here, and everything downstream works in linear. */
const toLinear=c=>Math.pow(Math.max(0,c),2.2);
function setBiome(b,init){biome=b;const o=BIO[b];PAL.length=0;PAL.push(...o.p.map(col=>col.map(toLinear)),[.13,.13,.14]);snowL=o.s;veg=o.v;if(!init){push();if(!BSP[b].includes(br.kind)&&br.kind!='erase')br.kind='grass';const gk=ensure('grass');if(gk)gk.tint=kt('grass');upd();scatter(1)}}
setBiome('hills',1);
function bump(x,z,v){const u=cl((x+S/2)/D,0,N-.001),w=cl((z+S/2)/D,0,N-.001),i=u|0,j=w|0,a=u-i,b=w-j,k=j*W+i;H[k]+=v*(1-a)*(1-b);H[k+1]+=v*a*(1-b);H[k+W]+=v*(1-a)*b;H[k+W+1]+=v*a*b}
function erode(p){const n=Math.round(30+90*br.str);for(let q=0;q<n;q++){const a=R()*6.283,d=Math.sqrt(R())*br.r;let x=p.x+Math.cos(a)*d,z=p.z+Math.sin(a)*d,vx=0,vz=0,sed=0,sp=1;
for(let t=0;t<32;t++){if(Math.abs(x)>S/2-D*.5||Math.abs(z)>S/2-D*.5)break;const h0=hgt(x,z),gx=(hgt(x+D,z)-hgt(x-D,z))/(2*D),gz=(hgt(x,z+D)-hgt(x,z-D))/(2*D);vx=vx*.5-gx;vz=vz*.5-gz;const l=Math.hypot(vx,vz);if(l<1e-4)break;vx/=l;vz/=l;
const nx=x+vx*D,nz=z+vz*D,dh=hgt(nx,nz)-h0,cap=Math.max(-dh,.03)*sp*6;
if(sed>cap||dh>0){const m=dh>0?Math.min(dh,sed):(sed-cap)*.3;bump(x,z,m);sed-=m}else{const m=Math.min((cap-sed)*.3,-dh);bump(x,z,-m*.5);sed+=m*.5}
sp=Math.sqrt(Math.max(sp*sp-dh*2,.05));x=nx;z=nz}}}
/* foliage (InstancedMesh) */
const cy=(a,b,h,n)=>new THREE.CylinderGeometry(a,b,h,n),co=(r,h,n)=>new THREE.ConeGeometry(r,h,n),bx=(x,y,z)=>new THREE.BoxGeometry(x,y,z);
const hh=(a,b)=>{const s=Math.sin(a*12.9898+b*78.233)*43758.5453;return s-Math.floor(s)};
const grad=(c0,c1)=>t=>c0.map((v,i)=>v+(c1[i]-v)*t);
function mergeG(list){const P=[],Nm=[],Cl=[],T=[];list.forEach(([g,f,us=[1,1,1]])=>{if(!us[3])g.computeVertexNormals();if(g.index)g=g.toNonIndexed();g.computeBoundingBox();const b=g.boundingBox,p=g.attributes.position,n=g.attributes.normal,u=g.attributes.uv;
for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),c=f((y-b.min.y)/((b.max.y-b.min.y)||1),n.getY(i),x,y,z),j=1+(hh(x*9+y*5,z*9)-.5)*.24*us[2];P.push(x,y,z);Nm.push(n.getX(i),n.getY(i),n.getZ(i));Cl.push(c[0]*j,c[1]*j,c[2]*j);T.push(u?u.getX(i)*us[0]:0,u?u.getY(i)*us[1]:0)}});
const o=new THREE.BufferGeometry();o.setAttribute('position',new THREE.Float32BufferAttribute(P,3));o.setAttribute('normal',new THREE.Float32BufferAttribute(Nm,3));o.setAttribute('color',new THREE.Float32BufferAttribute(Cl,3));o.setAttribute('uv',new THREE.Float32BufferAttribute(T,2));return o}
const wob=(g,a)=>{const p=g.attributes.position;for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),k=1+a*(hh(Math.round(x*30),Math.round(z*30)+y*7)-.5);p.setX(i,x*k);p.setZ(i,z*k)}return g};
const blob=(r,x,y,z,a)=>{const g=new THREE.SphereGeometry(1,12,9),p=g.attributes.position;for(let i=0;i<p.count;i++){const X=p.getX(i),Y=p.getY(i),Z=p.getZ(i),k=r*(1+a*Math.sin(X*3.1+Y*2.3+x)*Math.sin(Z*2.7+X*1.9+y));p.setXYZ(i,X*k,Y*k*.85,Z*k)}return g.translate(x,y,z)};
const PALF=[[1,.35,.5],[1,.85,.2],[1,1,1],[.65,.45,.95],[1,.5,.15]];
const BMAT=[];
const KIND={},dm=new THREE.Object3D(),dmi=new THREE.Object3D(),tcol=new THREE.Color(),WU={value:0},WW={value:1};
/* Every mesh a kind owns, whatever tier it belongs to. Anything that hides,
   disposes or reconfigures a species has to see all three tiers, or the
   impostors keep drawing after the world they belong to is gone. */
const kindMeshes=K=>K?[...(K.meshes||[]),...(K.lowMeshes||[]),...(K.shadowMeshes||[]),...(K.impMesh?[K.impMesh]:[])]:[];
const NO_SELF_SHADOW_RECEIVE=new Set(['rock','sandrock','basalt','grass','tallgrass','flower','daisy','tulip','lavender','pine','oak','birch','palm','shrub','spruce','krumm','juniper','saguaro','barrel','prickly','acacia','joshua','agave','sage','deadtree','ashbush','treefern','fern']);
const SHADOW_PROXY_STRIDE=8;

function makeBotanicalShadowProxy(geometry,material,capacity,name){const proxy=new THREE.InstancedMesh(geometry,material,Math.max(1,capacity));proxy.instanceMatrix.setUsage(THREE.DynamicDrawUsage);proxy.instanceColor=new THREE.BufferAttribute(new Float32Array(Math.max(1,capacity)*3).fill(1),3);proxy.instanceColor.setUsage(THREE.DynamicDrawUsage);proxy.count=0;proxy.frustumCulled=false;proxy.castShadow=true;proxy.receiveShadow=false;proxy.layers.set(1);proxy.name=name;const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide});depth.customProgramCacheKey=()=> 'foliage-shadow-wind-v1';depth.onBeforeCompile=s=>{s.uniforms.uT=WU;s.uniforms.uW=WW;s.vertexShader=s.vertexShader.replace('#include <common>','#include <common>\nuniform float uT,uW;').replace('#include <begin_vertex>','#include <begin_vertex>\n#ifdef USE_INSTANCING\nfloat sw=sin(uT*.9+instanceMatrix[3].x*.12+instanceMatrix[3].z*.08);transformed.xz+=vec2(.8,.6)*position.y*position.y*sw*.012*uW;\n#endif')};proxy.customDepthMaterial=depth;return proxy}
const LEAFV='float th_=fract(sin(dot(wp,vec2(12.9898,78.233)))*43758.5453);vTree=th_;float sdl=(vR*.8+.2*(1.-clamp(aCen.y/12.,0.,1.))+th_*.4)/1.4;float pf=0.;if(sdl<uShedS0)pf=1.;else if(sdl<uShedE)pf=clamp((uClk-(uShedT0+(sdl-uShedS0)/max(uShedR,1e-5)))/(8.0+vR*7.0),0.,1.);pf *= step(0.15, vR);vFall=pf;float gr=clamp(uGrow*1.5-vR*.5-th_*.3,0.,1.);vec3 off=transformed-aCen;if(pf>0.){float settle=smoothstep(.82,.995,pf);float ang=pf*(5.+vR*9.)+vR*30.+sin(uClk*1.2+vR*17.)*(1.-settle)*.12;float cA=cos(ang),sA=sin(ang);vec3 o2=vec3(off.x*cA-off.z*sA,off.y,off.x*sA+off.z*cA);float tl=sin(uClk*1.5+vR*20.+th_*6.)*.42*(1.-settle),cT=cos(tl),sT=sin(tl);o2=vec3(o2.x,o2.y*cT-o2.z*sT,o2.y*sT+o2.z*cT);vec3 C=aCen;float fallp=pf*pf*(3.-2.*pf);C.y=mix(C.y,.03,fallp)+sin(uClk*2.+vR*41.)*.08*pf*(1.-settle);float ws=clamp(uW,0.,3.);vec2 flutter=vec2(sin(uClk*1.8+vR*40.+th_),cos(uClk*1.4+vR*33.+th_))*(.05+.035*ws)*pf*(1.-settle);vec2 move=wd*ws*pf*.65+flutter;C.xz+=clamp(move,vec2(-3.),vec2(3.));o2*=mix(1.,.38,settle);o2.y*=mix(1.,.12,settle);transformed=C+o2;}else{transformed=aCen+off*gr;}\n';
const NOLEAF='vTree=fract(sin(dot(wp,vec2(12.9898,78.233)))*43758.5453);vFall=0.;\n';
/* Skeletal wind. `aSway` is baked by the flora kernel: 0 at the trunk collar,
   1 at a terminal twig, and `aPhase` is accumulated down each branch path. The
   bend therefore runs through the hierarchy — the trunk barely moves, a limb
   swings as a unit, and two limbs of the same length swing out of step — which
   a single height-squared law can never do. Geometry without the attributes
   reads 0 and keeps the old behaviour exactly. */
/* Skeletal wind, and the only wind a grown plant gets.
   `aSway` is 0 at the trunk collar and 1 at a terminal twig, `aPhase` is the
   accumulated phase down that branch path. Three things make a tree bend like a
   tree instead of flying like a kite:
     - the collar never moves. The old law started at 12% of full amplitude, so
       the base of the trunk slid across the ground and the whole plant read as a
       cut-out being dragged through the air;
     - one frequency per plant. The old law ran the twigs at up to 1.8x the
       trunk's rate, so a limb waved while its trunk moved at a different tempo,
       which looks like a snake because nothing is connected to anything;
     - every branch pushes along its own horizontal axis rather than the world
       wind axis, so limbs lean apart instead of translating as one board.
   The bend is quadratic in height, which is what a cantilever does, and the
   whole displacement scales with aSway, so a leaf card with no skeleton reads 0
   and behaves exactly as before. */
const SKEL='float skH=max(position.y,0.);float skT=clamp(skH/12.,0.,1.25);float skBend=skT*skT;float skW=.72+.28*aSway;float skB=sin(uT*skW+aPhase)+.18*sin(uT*skW*2.03+aPhase*1.4+1.7);vec2 skDir=wd+vec2(cos(aPhase),sin(aPhase))*.35;transformed.xz+=skDir*(skBend*aSway*uW*'+(0.5).toFixed(3)+')*skB*gust;transformed.y-=skBend*aSway*uW*.06*abs(skB)*gust;\n';
/* One material can carry more than one shader injection: the terrain owns the
   triplanar material layers (grass, soil, rock, snow), a plant owns the wind
   shader, and the detail pass adds surface micro-structure on top of either.
   Assigning onBeforeCompile straight over the top silently replaced whatever
   was already there, and the detail pass did exactly that to the terrain: the
   measured texture of the ground never reached a pixel and the land fell back
   to flat vertex colour, which is what "the land has no material" was. The
   injections are a stack now. Adding one keeps the ones already present, the
   newest runs last, and adding the same id again replaces it instead of
   stacking a second copy. The stack lives in a WeakMap because Material.clone()
   copies userData through JSON, which would carry a stack with the functions
   stripped out of it. */
const FESHADER=new WeakMap();
function addShader(m,id,key,fn){
 if(!m)return m;
 let rec=FESHADER.get(m);
 if(!rec){
  rec={stack:[],off:false};
  if(typeof m.onBeforeCompile==='function'){
   const prev=m.onBeforeCompile,prevKey=typeof m.customProgramCacheKey==='function'?m.customProgramCacheKey.bind(m):null;
   rec.stack.push({id:'base',key:prevKey||(()=>''),fn:prev});
  }
  FESHADER.set(m,rec);
 }
 const at=rec.stack.findIndex(e=>e.id===id),entry={id,key,fn};
 if(at>=0)rec.stack[at]=entry;else rec.stack.push(entry);
 rec.write=()=>{
  /* Oldest first: the material's own injection, then the passes in the order
     they were installed, each editing the shader the one before it produced.
     The open-world litter switch looks for text the detail pass has just
     added, so a pass that ran earlier could never see it. */
  m.onBeforeCompile=(s,r)=>{if(rec.off)return;for(let i=0;i<rec.stack.length;i++)rec.stack[i].fn(s,r)};
  m.customProgramCacheKey=()=>rec.stack.map(e=>e.key()).join('|')+(rec.off?'|off':'');
 };
 rec.write();
 return m;
}
/* Drop one named injection and rebuild the material around what is left: a
   shader that will not compile takes only the pass that broke it down with it,
   so the ground keeps its material layers when the micro-detail pass is the
   thing the device refused. */
function shaderDrop(m,id){
 const rec=FESHADER.get(m);if(!rec)return 0;
 const at=rec.stack.findIndex(e=>e.id===id);
 if(at<0)return 0;
 rec.stack.splice(at,1);
 if(rec.write)rec.write();m.needsUpdate=true;
 return 1;
}
/* Turn every injection on a material off (or back on) without throwing the
   stack away: the ground fallback compiles the stock shader, and the stack is
   still there when the user turns the shader back on. */
function shaderOff(m,on){
 const rec=FESHADER.get(m);if(!rec)return 0;
 rec.off=!!on;if(rec.write)rec.write();m.needsUpdate=true;
 return 1;
}
function wind(m,a,wf,fx,tk){fx=fx||'';tk=tk||1;addShader(m,'wind',()=>'w6'+a+fx+tk,s=>{const u=s.uniforms;u.uT=WU;u.uW=WW;u.uShed=FXU.shed;u.uShedF=FXU.shedF;u.uAut=FXU.aut;u.uSnowK=FXU.snowK;u.uBloom=FXU.bloom;u.uTor=FXU.tor;u.uTorS=FXU.torS;u.uGrow=FXU.grow;u.uShedS0=FXU.s0;u.uShedT0=FXU.t0;u.uShedR=FXU.sr;u.uShedE=FXU.se;u.uClk=FXU.clk;u.uTorV=FXU.torV;u.uTorD=FXU.torD;u.uSunD=FXU.sunD;u.uSunI=FXU.sunI;u.uWet=FXU.wet;u.uRainK=FXU.rain;const fa=(a>=.0015&&a<.01)?a*18:0;
let fr='';if(fx.includes('s'))fr+='if(vFall>=1.||vR<vTs*.9)discard;\n';if(fx.includes('S'))fr+='if(vR<uShedF||vR<vTs)discard;\n';if(fx.includes('b'))fr+='if(vR>uBloom)discard;\n';
if(fx.includes('a'))fr+='float at=clamp(uAut*1.35-vTree*.55+(vR-.5)*.25,0.,1.);float fam=fract(vTree*7.7);vec3 endc=fam<.35?vec3(1.6,.4,.2):(fam<.7?vec3(1.75,.9,.22):vec3(1.1,.62,.28));vec3 ac=mix(vec3(1.),vec3(1.45,1.3,.4),smoothstep(0.,.35,at));ac=mix(ac,endc,smoothstep(.35,.8,at));ac*=1.-.25*smoothstep(.85,1.,at)*fract(vR*3.3);diffuseColor.rgb*=ac;\n';if(fx.includes('g'))fr+='diffuseColor.rgb*=mix(vec3(1.),vec3(1.45,1.15,.55),uAut);\n';
if(fx.includes('l'))fr+='diffuseColor.rgb+=diffuseColor.rgb*vec3(1.08,1.18,.72)*vBk*.52;\n';
if(fx.includes('d'))fr+='diffuseColor.rgb*=1.-(1.-smoothstep(0.,1.4,vY))*.3;\n';
if(fx.includes('w'))fr+='float vGr=1.-smoothstep(0.,1.6,vY);diffuseColor.rgb*=1.-vGr*.38;diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.72,1.,.55),vGr*.45*step(.45,fract(vR*3.7)));\n';
fr+='diffuseColor.rgb*=1.-uWet*.2;\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(.93,.95,1.),clamp(vSn*uSnowK*1.4,0.,1.));\n';
s.vertexShader='attribute float aRnd;attribute vec3 aCen;attribute float aSway;attribute float aPhase;varying float vR,vSn,vTs,vBk,vY,vFall,vTree;uniform float uT,uW,uTorS,uTorV,uSunI,uShed,uGrow,uShedS0,uShedT0,uShedR,uShedE,uClk;uniform vec3 uTor,uSunD;uniform vec2 uTorD;\n'+s.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n#ifdef USE_INSTANCING\nvec2 wp=vec2(instanceMatrix[3].x,instanceMatrix[3].z);\n#else\nvec2 wp=vec2(modelMatrix[3].x,modelMatrix[3].z);\n#endif\nvR=aRnd;vY=position.y;vSn=clamp(normal.y*1.25-.1,0.,1.);float py=max(position.y,0.);vec2 wd=vec2(.8,.6);float gust=.6+.4*sin(dot(wp,wd)*.07-uT*.55)+.2*sin(dot(wp,vec2(-.6,.8))*.11+uT*.37);float wv=position.y*position.y*uW;float sway=sin(uT*.9+dot(wp,wd)*.12)*.5+.5;/* A geometry with a skeleton is moved by SKEL alone: the legacy shear below translated the whole plant by its height. */\ntransformed.xz+=wd*wv*'+(a*.8).toFixed(4)+'*gust*(.35+.65*sway)*(1.-clamp(aSway*1.6,0.,1.));\n'+(SKEL)+'\n'+(fa?'float rd=length(position.xz);float fl=smoothstep(.4,2.8,rd)*smoothstep(1.,6.,position.y);float ph2=position.x*1.9+position.z*2.3+position.y*.7+wp.x*.31+wp.y*.17;transformed+=vec3(sin(uT*3.3+ph2),sin(uT*2.1+ph2*1.3)*.4,cos(uT*2.9+ph2*.9))*fl*'+fa.toFixed(4)+'*uW*(.4+gust);\n':'')+(a>0||wf>0||fx.includes('l')||fx.includes('g')||fx.includes('w')?'vec2 td=wp-uTor.xy;float tr=length(td)+.001;vec2 tn=td/tr;float vt=uTorV*uTorS*(tr<uTor.z?tr/uTor.z:pow(uTor.z/tr,.65));vec2 wv2=vec2(-tn.y,tn.x)*vt-tn*vt*.38+uTorD*uTorS*.6;float vs=length(wv2);float Dm=7.5*(1.-exp(-vs*vs/1444.));float pyn=py/9.;transformed.xz+=wv2/(vs+.001)*min(Dm*pyn*pyn*'+tk.toFixed(1)+',py*.8);transformed.xz+=vec2(sin(uT*11.+py*3.+wp.x),cos(uT*9.+py*2.7+wp.y))*.1*pow(clamp(vs/40.,0.,1.),1.5)*min(py,3.);vTs=clamp((vs-26.)/38.,0.,1.);\n':'vTs=0.;\n')+(fx.includes('s')?LEAFV:NOLEAF)+(fx.includes('l')?'vec3 leafN=normal;\n#ifdef USE_INSTANCING\nleafN=mat3(instanceMatrix)*leafN;\n#endif\nvec3 sunView=normalize(mat3(viewMatrix)*uSunD);vBk=pow(max(dot(-sunView,normalize(normalMatrix*leafN)),0.),1.6)*clamp(uSunI,0.,2.);\n':'vBk=0.;\n'));
s.fragmentShader='varying float vR,vSn,vTs,vBk,vY,vFall,vTree;uniform float uShed,uShedF,uAut,uSnowK,uBloom,uWet,uRainK;\n'+s.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n'+fr).replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\n/* Rain wets bark and stone: the PBR roughness falls and the sun glints off\n   upward faces. No particles are involved, only this one uniform. */\nroughnessFactor*=mix(1.,.55,clamp(uRainK,0.,1.));roughnessFactor=mix(roughnessFactor,roughnessFactor*.35,clamp(uRainK*vSn*1.3,0.,1.));')})};
function depthFx(m,fx){if(!/[sSb]/.test(fx))return;addShader(m,'depth',()=>'dfx3'+fx,s=>{s.uniforms.uShed=FXU.shed;s.uniforms.uShedF=FXU.shedF;s.uniforms.uBloom=FXU.bloom;s.uniforms.uGrow=FXU.grow;s.uniforms.uW=WW;s.uniforms.uT=WU;s.uniforms.uShedS0=FXU.s0;s.uniforms.uShedT0=FXU.t0;s.uniforms.uShedR=FXU.sr;s.uniforms.uShedE=FXU.se;s.uniforms.uClk=FXU.clk;
let fr='';if(fx.includes('s'))fr+='if(vFall>=1.)discard;\n';if(fx.includes('S'))fr+='if(vR<uShedF)discard;\n';if(fx.includes('b'))fr+='if(vR>uBloom)discard;\n';
s.vertexShader='attribute float aRnd;attribute vec3 aCen;attribute float aSway;attribute float aPhase;varying float vR,vFall,vTree;uniform float uShed,uGrow,uW,uT,uShedS0,uShedT0,uShedR,uShedE,uClk;\n'+s.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n#ifdef USE_INSTANCING\nvec2 wp=vec2(instanceMatrix[3].x,instanceMatrix[3].z);\n#else\nvec2 wp=vec2(modelMatrix[3].x,modelMatrix[3].z);\n#endif\nvR=aRnd;vec2 wd=vec2(.8,.6);float gust=.6+.4*sin(dot(wp,wd)*.07-uT*.55)+.2*sin(dot(wp,vec2(-.6,.8))*.11+uT*.37);\n'+(SKEL)+'\n'+(fx.includes('s')?LEAFV:'vFall=0.;vTree=0.;')+'\n');
s.fragmentShader='varying float vR,vFall,vTree;uniform float uShedF,uBloom;\n'+s.fragmentShader.replace('#include <alphatest_fragment>',fr+'#include <alphatest_fragment>')})};
const TREE_SIZE_SCALE={pine:1.7,oak:1.75,birch:1.7,palm:1.65,spruce:1.7,krumm:1.4,juniper:1.4,acacia:1.7,joshua:1.65,deadtree:1.65},TREE_SIZE_MIN={palm:1.8,oak:1.2,birch:1.1},TREE_SIZE_MAX={palm:2.8};
const SHADOW_LOW_DETAIL=new Set(['rock','sandrock','basalt','pine','oak','birch','palm','spruce','house','block','mid','tower']);
function mk(n,max,parts,sh){const isLow=detail<=0,K=KIND[n]={list:[],max,size:TREE_SIZE_SCALE[n]||1,vr:.35,tint:[1,1,1],meshes:[],shadowMeshes:[],selectionGrid:null,selectionGridDirty:true,selectionBounds:null};const createInst=(g,material)=>{const m=new THREE.InstancedMesh(g,material,max);m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);m.instanceColor=new THREE.BufferAttribute(new Float32Array(max*3).fill(1),3);m.instanceColor.setUsage(THREE.DynamicDrawUsage);m.count=0;m.frustumCulled=false;m.castShadow=isLow?SHADOW_LOW_DETAIL.has(n):!!sh;m.receiveShadow=!NO_SELF_SHADOW_RECEIVE.has(n);m.userData={pal:null,nt:null,vi:null,vn:null,part:null};return m};K.meshes=parts.map(([g,o={}],partIndex)=>{const P={vertexColors:true,side:o.ds?THREE.DoubleSide:THREE.FrontSide};if(o.map)P.map=o.map;if(o.cut){P.alphaTest=o.cut;if(MSAA)P.alphaToCoverage=true}let mt;if(o.ph){mt=new THREE.MeshPhongMaterial({...P,shininess:o.shn||30,specular:o.sp||0x222222});if(o.em){mt.emissive=new THREE.Color(1,1,1);mt.emissiveMap=o.em;mt.emissiveIntensity=0;BMAT.push(mt)}}else if(o.phys){if(o.nm){P.normalMap=o.nm;P.normalScale=new THREE.Vector2(o.ns||.45,o.ns||.45)}if(o.rm)P.roughnessMap=o.rm;if(o.bump){P.bumpMap=o.map;P.bumpScale=o.bump}mt=new THREE.MeshPhysicalMaterial({...P,roughness:o.roughness??.78,metalness:0,clearcoat:o.clearcoat??.1,clearcoatRoughness:o.clearcoatRoughness??.48});mt.envMapIntensity=o.env??.62}else if(o.pbr){mt=new THREE.MeshStandardMaterial({...P,roughness:1,metalness:1,roughnessMap:o.pbr,metalnessMap:o.pbr,bumpMap:o.map,bumpScale:o.bump||.5,emissive:new THREE.Color(1,1,1),emissiveMap:o.em,emissiveIntensity:0});mt.envMapIntensity=1.1;BMAT.push(mt)}else if(o.std){if(o.bump){P.bumpMap=o.map;P.bumpScale=o.bump}if(o.nm){P.normalMap=o.nm;P.normalScale=new THREE.Vector2(o.ns||1,o.ns||1)}if(o.rm)P.roughnessMap=o.rm;mt=new THREE.MeshStandardMaterial({...P,roughness:.93,metalness:0});mt.envMapIntensity=.72;if(o.det)injectDetail(mt,true)}else mt=new THREE.MeshLambertMaterial(P);if(o.w||o.sn)wind(mt,o.w||0,o.wf||0,(o.fx||'')+(o.cut&&o.map?'l':'')+(o.std&&!o.det&&!o.cut&&!o.sn?'w':'')+(o.pbr?'d':''),o.tk||1);const m=createInst(g,mt);m.name=n+' part '+partIndex+' high';m.userData={kind:n,pal:o.pal,nt:o.nt,vi:o.vi,vn:o.vn,part:o.part,lodGeom:o.lodGeom||null,sourceListIndices:[]};if(o.cut&&sh){const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:o.map,alphaTest:o.cut,side:THREE.DoubleSide});depthFx(depth,o.fx||'');m.customDepthMaterial=depth}scene.add(m);return m});if(n==='grass'||n==='tallgrass')K.shadowMeshes=K.meshes.map((m,i)=>{const src=m,p=makeBotanicalShadowProxy(src.geometry,src.material,Math.ceil(max/SHADOW_PROXY_STRIDE),n+' shadow caster');scene.add(p);return p});return K}
const FXU={rain:{value:0},s0:{value:0},t0:{value:0},sr:{value:.006},se:{value:0},clk:{value:0},grow:{value:1},lit:{value:0},treeMap:{value:null},shed:{value:0},shedF:{value:0},aut:{value:0},snowK:{value:0},bloom:{value:0},torS:{value:0},torV:{value:68},torD:{value:new THREE.Vector2()},sunD:U.sd,sunI:{value:1},tor:{value:new THREE.Vector3(0,0,10)},wet:{value:0}};
const DQ={leaf:1.6,seg:1.3,rock:1.3},DQP=[{leaf:.55,seg:.7,rock:.7},{leaf:1,seg:1,rock:1},{leaf:1.6,seg:1.3,rock:1.3},{leaf:2.4,seg:1.7,rock:1.7}],LZREG={};const LOD_FULL_KEY='final3d.lodFullDistance.v2';
function storedLodFullDistance(){try{const v=Number(localStorage.getItem(LOD_FULL_KEY));return Number.isFinite(v)&&v>=250&&v<=2500?v:750}catch{return 750}}
function setLodFullDistance(v){lodFullDistance=cl(Math.round(Number(v)||750),250,2500);try{localStorage.setItem(LOD_FULL_KEY,String(lodFullDistance))}catch{}lodPending=true;lodSettled=false;lodMotionAt=-1e9}
function buildLowDetail(fn){const saved={...DQ};Object.assign(DQ,{leaf:Math.max(.42,saved.leaf*.42),seg:Math.max(.55,saved.seg*.62),rock:Math.max(.5,saved.rock*.6)});try{return fn()}finally{Object.assign(DQ,saved)}}
let detail=HANDSET?1:2,lodFullDistance=storedLodFullDistance(),lodPending=false,lodIndex=0,treeMapDirty=false,treeMapT=0;
function applyDetail(i){if(typeof buildEager!='function')return;if(i==detail){applyPreviewPixelRatio();return}detail=i;U.uQ.value=[0,1,2,2][i];Object.assign(DQ,DQP[i]);if(typeof resetImpostors==='function')resetImpostors();const saved={};
for(const k in KIND){const K=KIND[k];saved[k]={list:K.list,size:K.size,vr:K.vr,tint:K.tint,max:K.max};kindMeshes(K).forEach(m=>{for(let j=BMAT.length-1;j>=0;j--)if(BMAT[j]===m.material)BMAT.splice(j,1);m.parent?.remove(m);m.geometry?.dispose?.();m.material?.dispose?.()});delete KIND[k]}
for(const k in LZREG)LAZY[k]=()=>lazyBuild(k);
buildEager();
for(const k in saved){const K=KIND[k]||ensure(k);if(!K)continue;K.size=saved[k].size;K.vr=saved[k].vr;K.tint=saved[k].tint;K.list=saved[k].list;if(Math.max(saved[k].max||0,K.list.length)>K.max)growManualCapacity(k,Math.max(saved[k].max||0,K.list.length))}
if(mode=='wire')shade();for(const k in KIND)sync(k);if(OW?.active){for(const K of Object.values(KIND))for(const m of kindMeshes(K))m.visible=false;for(const c of OW.chunks.values())OW.syncChunk(c);OW.applyQuality()}if(foliageSelectMode)updateFoliageGlow();updSky();if(window.OW_API?.refreshFar)window.OW_API.refreshFar()}
const LAZY={};function ensure(k){if(KIND[k])return KIND[k];const f=LAZY[k];window.__feFoliageLodDirty=true;if(f){LAZY[k]=null;try{f()}catch(e){showErr('Species '+k+': '+e.message)}try{window.FELandscapeRealism&&window.FELandscapeRealism.refreshKind(k)}catch(e){}try{window.__feGrowSpecies&&window.__feGrowSpecies()}catch(e){}}return KIND[k]}
const simple=(g,c)=>{const n=g.attributes.position.count,a=new Float32Array(n*3);for(let i=0;i<n;i++){a[i*3]=c[0];a[i*3+1]=c[1];a[i*3+2]=c[2]}g.setAttribute('color',new THREE.BufferAttribute(a,3));return g};
let MODELS_ERR=null;
function fallbackModels(){for(const k in KIND){kindMeshes(KIND[k]).forEach(m=>scene.remove(m));delete KIND[k]}
const sp=(r,y)=>simple(new THREE.SphereGeometry(r,8,6).translate(0,y,0),[1,1,1]);
mk('grass',9000,[[simple(co(.3,1,4).translate(0,.5,0),[.3,.55,.15]),{ds:1}]],false);
mk('flower',3000,[[simple(new THREE.SphereGeometry(.12,6,5).translate(0,.5,0),[.9,.4,.6]),{}]],false);
mk('pine',1200,[[simple(co(1.8,9,8).translate(0,5,0),[.1,.3,.12]),{}]],true);
mk('oak',900,[[simple(new THREE.SphereGeometry(2.6,10,8).translate(0,6,0),[.2,.45,.15]),{}]],true);
mk('birch',1200,[[simple(new THREE.SphereGeometry(1.5,8,6).translate(0,6,0),[.35,.55,.2]),{}]],true);
mk('palm',600,[[simple(co(1.5,8,6).translate(0,4,0),[.2,.45,.2]),{}]],true);
mk('shrub',2000,[[simple(new THREE.SphereGeometry(.9,8,6).translate(0,.6,0),[.2,.42,.12]),{}]],true);
mk('rock',600,[[simple(new THREE.DodecahedronGeometry(1).translate(0,.5,0),[.4,.4,.42]),{}]],true);
mk('house',1500,[[simple(bx(6,5,6).translate(0,2.5,0),[.8,.75,.65]),{}]],true);
mk('block',500,[[simple(bx(8,12,8).translate(0,6,0),[.6,.58,.55]),{}]],true);
mk('mid',400,[[simple(bx(9,24,9).translate(0,12,0),[.55,.58,.62]),{}]],true);
mk('tower',250,[[simple(bx(6,50,6).translate(0,25,0),[.4,.5,.6]),{}]],true);
['house','block','mid','tower'].forEach(k=>KIND[k].vr=.08);KIND.rock.vr=.7}