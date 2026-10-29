/* Smoke checks for the Lampa Buttons NextGen plugin; no external dependencies. */
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname,'../Plugins/buttons-nextgen.js'),'utf8');
new vm.Script(src,{filename:'buttons-nextgen.js'});
function jquery() {
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
vm.runInNewContext(src.replace('    init();', '    window.__bmTest = {getBtnIdentifier, bmLegacyId, bmMigrateIds}; init();'),context,{filename:'buttons-nextgen.js'});
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
assert.ok(!src.includes("find('.button--play, .button--edit-order, .button--folder').remove()"),
  'editor resets must never remove native Watch');
assert.ok(src.includes("sources.children('.full-start__button').not('.hide,.button--play')"),
  'Watch menu torrent and JacRed sources must be collected');
assert.ok(src.includes("source.trigger(e.type)"),
  'source button proxy must forward activation to the original');
assert.ok(src.includes("bmSourceObserver.observe(sources[0]"),
  'dynamic source buttons must be observed');
assert.ok(src.includes("{ name: 'torrent', patterns: ['torrent', 'jacred'] }"),
  'JacRed should appear alongside Torrents');
assert.ok(src.includes("target.children('.view--online.lampac--button')"),
  'avoid duplicate Lampac Online button');
assert.ok(src.includes('top:calc(100% + .2em)'), 'hover text must be an overlay');
assert.ok(!src.includes("        saveOrder();\n\n        setTimeout"), 'render must not persist transient order');
console.log('Passed: syntax, legacy migration bootstrap, isolated profiles, sync snapshot, cloud restore, stable hover layout');
