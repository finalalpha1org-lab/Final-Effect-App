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
