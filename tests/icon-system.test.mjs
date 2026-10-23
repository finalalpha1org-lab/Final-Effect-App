import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';

/* The app used emoji as product icons. This suite keeps the replacement
   honest: every glyph that appears anywhere in the shipped sources must map to
   a real SVG path, the renderer must be well formed, and hydration must turn a
   text node into an icon without touching code. */
const sources = [
  'index.html','Terrain_system_.html','simulationCore.js','fe-cpp-engine.js','worker.js',
  'volume-atlas.js','volume-library.js','tessendorf-ocean.js','scatter-spacing.js',
  'open-world.js','open-world-generator.js',
  ...Array.from({length:9},(_,i)=>`terrain-main-${String(i+1).padStart(2,'0')}.js`)
].filter(existsSync);

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync('fe-icons.js','utf8'), ctx);
const FEIcons = ctx.FEIcons;

const EMOJI = /[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]|[\u{1F000}-\u{1FAFF}]/gu;

test('the icon set is a complete, well formed 24x24 stroke library',()=>{
  assert.ok(FEIcons.names.length >= 120, `expected a full set, found ${FEIcons.names.length}`);
  for(const name of FEIcons.names){
    const markup = FEIcons.svg(name);
    assert.match(markup,/^<svg class="ico" viewBox="0 0 24 24"/);
    assert.match(markup,/<\/svg>$/);
    assert.ok(!/undefined|NaN/.test(markup),`${name} renders cleanly`);
    assert.ok(markup.includes('stroke="currentColor"'),`${name} inherits the text colour`);
  }
  assert.equal(FEIcons.svg('does-not-exist'), FEIcons.svg('sparkle'), 'unknown names fall back');
});

test('every emoji that still exists in the sources has an SVG replacement',()=>{
  const seen = new Set();
  for(const file of sources){
    const text = readFileSync(file,'utf8');
    for(const glyph of text.match(EMOJI) || []){
      if(glyph==='\uFE0F'||glyph==='\u200D'||glyph==='\u20E3') continue;
      seen.add(glyph);
    }
  }
  assert.ok(seen.size>80,`the sweep covers the real UI (${seen.size} glyphs)`);
  const missing=[...seen].filter(g=>!FEIcons.glyphIcon(g));
  assert.deepEqual(missing,[],'no glyph is left unmapped');
  for(const glyph of seen){
    assert.ok(FEIcons.names.includes(FEIcons.glyphIcon(glyph)),`${glyph} points at a real icon`);
  }
});

test('hydration swaps text emoji for icons, leaves code alone and strips <option>',()=>{
  class El{
    constructor(tag){this.nodeName=tag;this.nodeType=1;this.childNodes=[];this.parentNode=null;this.attrs={};this._html='';this.classList={add(){}};}
    set innerHTML(v){this._html=v;} get innerHTML(){return this._html;}
    appendChild(node){node.parentNode=this;this.childNodes.push(node);return node;}
    replaceChild(fresh,old){
      const at=this.childNodes.indexOf(old);
      assert.ok(at>=0,'the old node is attached');
      const incoming=fresh.childNodes?fresh.childNodes.slice():[fresh];
      for(const node of incoming) node.parentNode=this;
      this.childNodes.splice(at,1,...incoming);
    }
    removeAttribute(key){delete this.attrs[key];}
    getAttribute(key){return Object.prototype.hasOwnProperty.call(this.attrs,key)?this.attrs[key]:null;}
    querySelectorAll(){return [];}
  }
  const text=value=>({nodeType:3,nodeValue:value,parentNode:null,isConnected:true});
  const doc={
    body:new El('BODY'),
    createElement:tag=>new El(tag.toUpperCase()),
    createTextNode:text,
    createDocumentFragment:()=>{const frag={nodeType:11,childNodes:[],appendChild(n){n.parentNode=null;this.childNodes.push(n);}};return frag;},
    createTreeWalker(host){
      const stack=[host];const out=[];
      const walk=node=>{for(const child of node.childNodes||[]){if(child.nodeType===3)out.push(child);else if(child.childNodes)walk(child);}};
      walk(host);
      let i=0;return {nextNode:()=>out[i++]||null,currentNode:null};
    }
  };
  ctx.document=doc;
  const paragraph=new El('P');
  const label=text('Save 🧊 scene');
  paragraph.appendChild(label);
  const code=new El('SCRIPT');
  const codeText=text('const icon = "🧊";');
  code.appendChild(codeText);
  doc.body.appendChild(paragraph);
  doc.body.appendChild(code);

  FEIcons.hydrate(doc.body);

  const iconChild=paragraph.childNodes.find(node=>node.nodeType===1);
  assert.ok(iconChild,'the emoji became an element');
  assert.match(iconChild.innerHTML,/^<svg class="ico"/,'the element holds real SVG');
  assert.ok(iconChild.innerHTML.includes('stroke="currentColor"'));
  assert.equal(paragraph.childNodes.filter(n=>n.nodeType===3).map(n=>n.nodeValue).join(''),'Save  scene','the text around the icon survives');
  assert.equal(codeText.nodeValue,'const icon = "🧊";','script source is never rewritten');

  const option=new El('OPTION');
  const optionText=text('🔒 Locked');
  option.appendChild(optionText);
  doc.body.appendChild(option);
  FEIcons.hydrate(doc.body);
  assert.equal(optionText.nodeValue,'Locked','select options keep plain text');
});

test('both pages load the icon system before the app scripts',()=>{
  for(const file of ['index.html','Terrain_system_.html']){
    const html=readFileSync(file,'utf8');
    const tag=/<script src="\.?\/?fe-icons\.js"><\/script>/;
    assert.equal(html.split(tag).length-1,1,`${file} loads the icon renderer once`);
    const iconAt=html.search(tag);
    const firstApp=Math.min(
      ...['simulationCore.js','terrain-main-01.js','volume-atlas.js']
        .map(name=>html.indexOf(name)).filter(index=>index>=0)
    );
    assert.ok(iconAt<firstApp,`${file} loads icons before the app`);
  }
});

test('the home screen ships SVG tiles, the lock badge and the 3D Workspace name',()=>{
  const html=readFileSync('index.html','utf8');
  assert.ok(html.includes('data-ico="cube"'),'the workspace card has an icon tile');
  assert.ok(!html.includes('Workspace (3D Animation)'),'the old studio name is gone');
  assert.ok(html.includes('<b>3D Workspace</b>'),'the studio is called 3D Workspace');
  assert.equal(html.split('data-open="core"').length-1,1);
  const home=html.slice(html.indexOf('<div id="home-grid">'),html.indexOf('<!-- Recent Projects Section'));
  assert.ok(home.length>0);
  const leftover=home.match(EMOJI);
  assert.equal(leftover,null,'the studio grid has no emoji left');
  assert.ok(html.includes('data-ico="lock"'),'locked studios use the lock icon');
  assert.ok(html.includes('data-ico="flask"'),'the benchmark button uses the flask icon');
});

test('the Add 3D Element sheet draws real primitive icons, not emoji',()=>{
  /* Cylinder used to borrow the oil-drum glyph (rendered as a log) and Cone
     borrowed the ruler glyph. Each primitive now has its own outline. */
  for(const name of ['cylinder','cone','plane','bulb']){
    assert.ok(FEIcons.names.includes(name),`${name} must exist in the icon set`);
    assert.ok(FEIcons.svg(name).includes('<path') || FEIcons.svg(name).includes('<ellipse'),
      `${name} must be drawn from geometry`);
  }
  const page = readFileSync('index.html','utf8');
  const start = page.indexOf('<div id="add-3d-body">');
  const end = page.indexOf('</aside>',start);
  assert.ok(start > 0 && end > start);
  const body = page.slice(start,end);
  const buttons = [...body.matchAll(/<button class="add-3d-card-btn"[^>]*><i data-ico="([a-z0-9]+)"><\/i><span>([^<]+)<\/span>/g)];
  assert.equal(buttons.length,8,`all eight primitives are declarative icons, found ${buttons.length}`);
  const byLabel = Object.fromEntries(buttons.map(b=>[b[2],b[1]]));
  assert.equal(byLabel.Cylinder,'cylinder');
  assert.equal(byLabel.Cone,'cone');
  assert.equal(byLabel.Plane,'plane');
  assert.equal(byLabel.Light,'bulb');
  assert.ok(!EMOJI.test(body),'no emoji is left in the Add 3D sheet');
});
