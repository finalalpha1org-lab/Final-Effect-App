import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let combinedTerrainPath;
function terrainForTests(){
  if(combinedTerrainPath)return combinedTerrainPath;
  const sourceRoot=existsSync(resolve(projectRoot,'public','Terrain_system_.html'))?resolve(projectRoot,'public'):projectRoot;
  const parts=Array.from({length:9},(_,i)=>`terrain-main-${String(i+1).padStart(2,'0')}.js`);
  let html=readFileSync(resolve(sourceRoot,'Terrain_system_.html'),'utf8');
  for(const name of parts){const source=readFileSync(resolve(sourceRoot,name),'utf8');if(source.toLowerCase().includes('</script'))throw new Error(`Unsafe script terminator in ${name}`);const tag=`<script src="./${name}"></script>`;if(html.split(tag).length-1!==1)throw new Error(`Expected one ${name} source tag`);html=html.replace(tag,`<script>\n${source}\n</script>`)}
  combinedTerrainPath=join(tmpdir(),`final-effect-terrain-${process.pid}.html`);writeFileSync(combinedTerrainPath,html);return combinedTerrainPath;
}
export function appPath(name) {
  if(name==='Terrain_system_.html'&&existsSync(resolve(projectRoot,'public','terrain-main-01.js')))return terrainForTests();
  const publicPath = resolve(projectRoot, 'public', name);
  return existsSync(publicPath) ? publicPath : resolve(projectRoot, name);
}
