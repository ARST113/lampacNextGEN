/* Smoke checks for the Lampa Buttons NextGen plugin; no external dependencies. */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname,'../Plugins/buttons-nextgen.js'),'utf8');
new vm.Script(src,{filename:'buttons-nextgen.js'});
function jquery(node) {
  if(node&&node.label){
    node._data=node._data||{};
    return {length:1,0:node,
      attr(k){return k==='class'?'full-start__button selector '+node.label:''},
      find(){return {text(){return node.label}}},
      data(k,v){if(arguments.length===2){node._data[k]=v;return this}return node._data[k]},
      hasClass(k){return node.classList.contains(k)}
    };
  }
  return {
    length:0,
    toggle(){return this},
    append(){return this},
    find(){return this},
    first(){return this},
    children(){return this},
    not(){return this},
    css(){return this},
    addClass(){return this},
    removeClass(){return this},
    on(){return this},
    hide(){return this},
    show(){return this},
    attr(){return ''},
    data(){return undefined}
  };
}
const events = {};
const storageEvents = {};
const store = Object.create(null);
let settingsParameter;
const storage = {
  get(k,def){return Object.prototype.hasOwnProperty.call(store,k)?store[k]:def},
  set(k,v,quiet){store[k]=v;if(!quiet)(storageEvents.change||[]).forEach(fn=>fn({name:k,value:v}))},
  sync(k,kind){assert.equal(k,'buttons_ng_cloud_v1');assert.equal(kind,'object_object')},
  listener:{follow(name,fn){(storageEvents[name]||(storageEvents[name]=[])).push(fn)}}
};
store.account={profile:{id:111}};
store.button_hidden=['legacy'];
store.button_folders=[{id:'folder_1',name:'Test',buttons:['legacy']}];
const Lampa={
  Storage:storage,
  Lang:{add(){},translate(k){return k}},
  Listener:{follow(name,fn){(events[name]||(events[name]=[])).push(fn)}},
  SettingsApi:{addParam(v){settingsParameter=v}},
  Noty:{show(){}},
  Controller:{enabled(){return {name:'full_start'}},toggle(){}}
};
const context={window:{Lampa,$:jquery},Lampa,$:jquery,console,setTimeout(fn){fn();return 1},clearTimeout(){}};
vm.runInNewContext(src.replace('    init();', '    window.__bmTest = {getBtnIdentifier, bmLegacyId, bmMigrateIds, bmMoveCardButton, bmBindCardNavigation, bmRememberCardFocus, bmFindCardFocus, bmRestoreCardFocus, getFocusId:()=>bmFocusId, setCurrentContainer:function(v){currentContainer=v;}}; init();'),context,{filename:'buttons-nextgen.js'});
assert.ok(settingsParameter,'settings integration loaded');
assert.deepEqual(JSON.parse(JSON.stringify(storage.get('button_hidden'))),['legacy'],'existing setting retained');
storage.set('button_hidden',['profile-111'],true);
settingsParameter.onChange(true); // persist current profile
assert.deepEqual(JSON.parse(JSON.stringify(store.buttons_ng_profile_111.settings.button_hidden)),['profile-111']);
assert.deepEqual(JSON.parse(JSON.stringify(store.buttons_ng_cloud_v1.profile_111.settings.button_hidden)),['profile-111']);
storage.set('account',{profile:{id:222}});
assert.deepEqual(JSON.parse(JSON.stringify(store.button_hidden)),[],'second profile has independent preferences');
storage.set('button_hidden',['profile-222'],true);
settingsParameter.onChange(true);
storage.set('account',{profile:{id:111}});
assert.deepEqual(JSON.parse(JSON.stringify(store.button_hidden)),['profile-111'],'switch restores first profile');
let newer = JSON.parse(JSON.stringify(store.buttons_ng_profile_111));
newer.updated += 100000;
newer.settings.button_hidden = ['remote-111'];
store.buttons_ng_cloud_v1.profile_111 = newer;
(events.worker_storage||[]).forEach(fn=>fn({name:'buttons_ng_cloud_v1',type:'insert'}));
assert.deepEqual(JSON.parse(JSON.stringify(store.button_hidden)),['remote-111'],'server state wins when newer');

function fakeButton(initialClasses,initialText) {
  let classes=initialClasses,text=initialText;
  const values={};
  return {
    length:1,
    attr(k){return k==='class'?classes:''},
    find(k){return {text(){return text}}},
    data(k,v){if(arguments.length===2){values[k]=v;return this}return values[k]},
    change(c,t){classes=c;text=t}
  };
}
const online=fakeButton('full-start__button selector view--online','Онлайн');
const id=context.window.__bmTest.getBtnIdentifier(online);
assert.ok(id.startsWith('bm2_'),'semantic stable identifier generated');
online.change('full-start__button selector view--online focus button-mode-3','Смотреть');
assert.equal(context.window.__bmTest.getBtnIdentifier(online),id,'label and focus changes do not affect identity');
const another=fakeButton('full-start__button selector view--online provider--extra','Онлайн');
assert.notEqual(context.window.__bmTest.getBtnIdentifier(another),id,'different provider ID is distinct');
storage.set('button_hidden',['view--online_Онлайн'],true);
context.window.__bmTest.bmMigrateIds();
assert.deepEqual(JSON.parse(JSON.stringify(store.button_hidden)),[id],'legacy settings IDs migrated');
assert.ok(src.includes("var bmNativePlay = targetContainer.children('.button--play').first().detach();"),
  'native Lampa Watch button must survive layout rebuild');
assert.ok(src.includes("bmNativePlay.removeClass('selector focus').addClass('buttons-ng-native-play')"),
  'Watch stays in DOM for native source selection without becoming a TV focus target');
assert.ok(src.includes(".button--play.buttons-ng-native-play { display:none !important; }"),
  'Watch button is not visible alongside direct torrent and JacRed controls');
assert.ok(src.includes("c.collectionSet(container)") && src.includes("c.collectionFocus(candidate,container)"),
  'D-pad navigator receives new post-render controls and preserves focus');
assert.ok(!src.includes("toggle('full_start');\n            } catch"),
  'do not force-switch controller away from dynamically opened JacRed or torrent content');
assert.ok(!src.includes("find('.button--play, .button--edit-order, .button--folder').remove()"),
  'editor resets must never remove native Watch');
assert.ok(src.includes("sources.children('.full-start__button').not('.hide,.button--play')"),
  'Watch menu torrent and JacRed sources must be collected');
assert.ok(src.includes("source.trigger(e.type)"),
  'source button proxy must forward activation to the original');
assert.ok(src.includes("var pool=reusable[sourceId]") &&
  src.includes("var proxy=pool&&pool.length?pool.shift():null"),
  'refreshes must reuse the existing Torrent/JacRed proxy DOM nodes');
assert.ok(src.includes("if(fresh)proxy.on('hover:enter hover:long'"),
  'reused proxies must not accumulate duplicate enter handlers');
assert.ok(src.includes("proxy.data('buttons-ng-source-ref',this)"),
  'reused proxy must always forward to the most recent source element');
assert.ok(src.includes("reusable[key].forEach(function(stale){stale.remove()}"),
  'only genuinely unavailable source proxies should be removed');
assert.ok(!src.includes("target.children('.buttons-ng-source-bridge').remove();"),
  'a whole-strip proxy reset would invalidate remote focus on every refresh');
assert.ok(src.includes("bmSourceObserver.observe(root,"),
  'observe the card root so late provider activation or source container replacement is captured');
assert.ok(src.includes("liveSource!==bmObservedSource"),
  'replacing source container forces rerender and fresh D-pad navigation');
assert.ok(src.includes("originalNode||!container[0].contains(originalNode)"),
  'late-enabled provider must not send clicks to detached source');
assert.ok(src.includes("proxy.data('buttons-ng-source-ref',source[0])"),
  'rebind the proxy to the current provider source');
assert.ok(src.includes("!node.hasAttribute('data-buttons-ng-managed')"),
  'new buttons injected into the visible strip must be detected without self-rebuilding');
assert.ok(src.includes("var wasHidden=/(^|\\s)hide(\\s|$)/.test"),
  'source availability changes must be recognized without focus-class redraw');
assert.ok(src.includes("{ name: 'torrent', patterns: ['torrent', 'jacred'] }"),
  'JacRed should appear alongside Torrents');
assert.ok(src.includes("target.children('.view--online.lampac--button')"),
  'avoid duplicate Lampac Online button');
assert.ok(!src.includes("svg.replaceWith(LAMPAC_ICON)") && !src.includes("var LAMPAC_ICON ="),
  'rebuilding a card must not mutate provider SVG, avoiding replacement races');
assert.ok(src.includes("original SVG is hidden by a CSS rule"),
  'Google Play icon stays visible regardless of Lampac native SVG changes');
assert.ok(src.includes(".view--online.lampac--button:not(.buttons-ng-source-bridge) > svg { display:none !important; }"),
  'hide all original native Lampac icons synchronously through CSS');
assert.ok(src.includes(".view--online.lampac--button:not(.buttons-ng-source-bridge)::before {content:"),
  'render one permanent Google Play icon on the visible Online button');
assert.ok(src.includes("-webkit-mask:url(") && src.includes("background-color:currentColor"),
  'match TV focus colors and preserve the exact new logo silhouette');
assert.ok(src.includes("data:image/svg+xml,") && src.includes("M20.331"),
  'inline the Google Play icon without external file dependencies');
assert.ok(src.includes("function bmMoveCardButton(step)") && src.includes("controller.__buttonsNgNavWrap=true"),
  'TV D-pad must use stable logical order within the card button strip');
assert.ok(src.includes("controller.right=function()") && src.includes("bmMoveCardButton(1)"),
  'D-pad right must advance one visible button even if a focused label changes geometry');
assert.ok(src.includes("controller.left=function()") && src.includes("bmMoveCardButton(-1)"),
  'D-pad left must advance one visible button backwards');
assert.ok(src.includes("strip.children('.full-start__button.selector').filter(function()"),
  'D-pad sequence must use rendered DOM order, not spatial nearest-element order');
assert.ok(src.includes("this.getClientRects().length>0") && src.includes("classList.contains('hidden')"),
  'TV navigation must skip invisible and disabled buttons');
assert.ok(src.includes("if(!next)return false; // keep native boundary behavior"),
  'Native Lampa controller must retain navigation at strip boundaries');
assert.ok(src.includes("Lampa.Controller.collectionFocus(next,currentContainer)"),
  'Remote traversal must update Lampa Navigator focus and enter target');
assert.ok(src.includes('flex-wrap: wrap !important'), 'adjacent buttons must wrap to the next row');
assert.ok(src.includes('position:static !important') && src.includes('display:inline-block !important'),
  'desktop TV focused label must expand in normal flex flow');
assert.ok(src.includes('max-width:100%') && src.includes('overflow-wrap:anywhere'),
  'long labels must fit inside their row and wrap internally if necessary');
assert.ok(!src.includes('left:calc(100% - .85em)'),
  'labels must not cover other clickable controls using absolute positioning');
assert.ok(src.includes('min-width:768px') && src.includes('max-width:767px'),
  'TV CSS widths between 768 and 999 must reveal focus labels, phone stays compact');
assert.ok(src.includes('.full-start-new__buttons { min-height:0 !important; }'),
  'phone panel must not inherit the reserved desktop flex-row height after resize');
assert.ok(src.includes("mousemove.buttonsNgPointer") && src.includes("buttons-ng-hovered"),
  'desktop pointer must retain an expanded control until the mouse actually moves');
assert.ok(src.includes("buttons-ng-pointer-mode"),
  'pointer mode must distinguish stationary air-mouse hover from TV D-pad focus');
assert.ok(src.includes("keydown.buttonsNgPointer"),
  'real D-pad input must restore focus-driven label disclosure');
assert.ok(src.includes("buttons-ng-pointer-mode .full-start__button.button-mode-1.focus:not(.buttons-ng-hovered) > span"),
  'hover/focus induced by stationary pointer must not make a flex item expand');
assert.ok(src.includes("bmMouseX===e.clientX&&bmMouseY===e.clientY"),
  'synthetic hover events with unchanged pointer coordinates cannot choose new expanded item');
assert.ok(src.includes("bmPointerToDpad()"),
  'switching from air mouse to TV remote must clear frozen pointer state');
assert.ok(src.includes("bmMouseAnchor={node:target[0]") &&
  src.includes("nearAnchor||dx*dx+dy*dy<576"),
  'stable pointer hitbox and trackpad hysteresis prevent switching after flex reflow');
assert.ok(src.includes("window.__buttonsNgPointerReset=bmPointerToDpad"),
  'D-pad transition must release the mouse anchor before later pointer input');
assert.ok(src.includes("rowsHeight=Math.ceil(rect.height*2+gap)") &&
  src.includes("targetContainer.css('min-height',frameHeight+'px')"),
  'reserve second flex row to keep the entire film card vertically stable');
assert.ok(src.includes("targetContainer.css('min-height','')"),
  'reset reserved height when the strip no longer has enough buttons');
assert.ok(src.includes("strip.removeClass('buttons-ng-pointer-mode buttons-ng-mouse-active')"),
  'TV controller movement must restore D-pad mode even without native keydown');
assert.ok(src.includes('buttons-ng-mouse-active'),
  'mouse selection must suppress competing TV focus expansion');
assert.ok(!src.includes('buttons-ng-expand-left'),
  'old leftward overlay strategy must be entirely removed');
assert.ok(!src.includes("        saveOrder();\n\n        setTimeout"), 'render must not persist transient order');

/* Behavioral regression: focused button widens and flex-wrap changes geometry.
 * D-pad traversal must remain DOM-sequential, including JacRed and late controls. */
const stripElement={};
const captions=['Онлайн','PidTor','Торренты','JacRed','Трейлеры','Реакции','Подписаться'];
const nodes=captions.map(name=>{
  const hidden={value:false};
  return {
    label:name,parentNode:stripElement,_hidden:hidden,
    classList:{contains(cls){return cls==='selector'||(cls==='hidden'&&hidden.value)}},
    getClientRects(){return hidden.value?[]:[{width:80}]}
  };
});
const stripWrapper=[stripElement];
stripWrapper.first=function(){return this};
stripWrapper.removeClass=function(){return this};
stripWrapper.find=function(){return {removeClass(){}}};
stripWrapper.children=function(selector){
  const list=selector.endsWith('.focus')
    ? nodes.filter(n=>n===context.window.Navigator._focus&&n.parentNode===stripElement)
    : nodes.slice();
  list.first=function(){return this.length?[this[0]]:[]};
  list.each=function(fn){this.forEach((el,i)=>fn.call(el,i,el));return this};
  list.filter=function(fn){
    // jQuery calls the predicate with this=the DOM element (unlike Array.filter).
    const visible=Array.prototype.filter.call(this,(el,i)=>fn.call(el,i,el));
    visible.index=function(el){return this.indexOf(el)};
    return visible;
  };
  return list;
};
const fakeContainer={
  length:1,0:{},find(sel){
    assert.equal(sel,'.full-start-new__buttons');
    return stripWrapper;
  }
};
const remote={_focus:nodes[2]};
context.window.Navigator=remote;
context.window.getComputedStyle=()=>({visibility:'visible'});
const visited=[];
let fallbackRight=0,fallbackLeft=0;
const controls={
  link:{last:null},
  right(){fallbackRight++},
  left(){fallbackLeft++}
};
Lampa.Controller.enabled=()=>({name:'full_start',controller:controls});
Lampa.Controller.collectionFocus=(node)=>{
  remote._focus=node;
  visited.push(node.label);
};
const testHook=context.window.__bmTest;
testHook.setCurrentContainer(fakeContainer);
testHook.bmBindCardNavigation(controls);
controls.right();
assert.equal(remote._focus.label,'JacRed','right after Torrent must focus JacRed');
controls.right();
assert.equal(remote._focus.label,'Трейлеры','right after JacRed must focus Trailer');
controls.left();
assert.equal(remote._focus.label,'JacRed','left after Trailer must focus JacRed');
nodes[4]._hidden.value=true;
controls.right();
assert.equal(remote._focus.label,'Реакции','skip genuinely hidden controls');
remote._focus=nodes[6];
controls.right();
assert.equal(fallbackRight,1,'last button defers to native right handler');
remote._focus={parentNode:{}};
controls.left();
assert.equal(fallbackLeft,1,'outside button bar defers to native left handler');
assert.deepEqual(visited,['JacRed','Трейлеры','JacRed','Реакции'],
  'D-pad visits JacRed exactly once and does not jump by spatial geometry');

/* Dynamic provider replaces the Torrent proxy while Start.toggle runs.
 * The old DOM reference is detached; the semantic ID must survive. */
remote._focus=nodes[2];
nodes[2].label='view--torrent';
testHook.bmRememberCardFocus(nodes[2]);
assert.equal(testHook.getFocusId(),'bm2_view--torrent',
  'remember Torrent by logical ID rather than disposable DOM element');
const stale=nodes[2];
const returnController={
  link:{last:stale},
  toggle(){
    const fresh={label:'view--torrent',parentNode:stripElement,
      classList:{contains(cls){return cls==='selector'}},
      getClientRects(){return [{width:80}]}
    };
    nodes[2]=fresh;
    stale.parentNode=null;
    // Native Lampa collects new selectors but sees the old disconnected last;
    // it falls back to the first Online button.
    remote._focus=nodes[0];
  }
};
Lampa.Controller.collectionSet=()=>{remote._focus=null};
Lampa.Controller.enabled=()=>({name:'full_start',controller:returnController});
testHook.bmBindCardNavigation(returnController);
returnController.toggle();
assert.equal(remote._focus,nodes[2],'return from Torrent focuses the NEW Torrent button');
assert.equal(returnController.link.last,nodes[2],'native Start.last is rebound to live proxy');
assert.notEqual(returnController.link.last,stale,'detached Torrent proxy must not be retained');
assert.equal(testHook.getFocusId(),'bm2_view--torrent','stable focus ID survives toggle');
console.log('Passed: syntax, legacy migration bootstrap, isolated profiles, sync snapshot, cloud restore, stable layout, TV D-pad traversal and Torrent return-focus restoration');
