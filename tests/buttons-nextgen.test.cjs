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
vm.runInNewContext(src,context,{filename:'buttons-nextgen.js'});
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
assert.ok(src.includes('top:calc(100% + .2em)'), 'hover text must be an overlay');
assert.ok(!src.includes("        saveOrder();\n\n        setTimeout"), 'render must not persist transient order');
console.log('Passed: syntax, legacy migration bootstrap, isolated profiles, sync snapshot, cloud restore, stable hover layout');
