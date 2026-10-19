const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Exercise the actual production lifeSource method without a running Lampac server.
const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const begin = plugin.indexOf('    this.lifeSource = function () {');
const end = plugin.indexOf('    this.createSource = function () {', begin);
assert.ok(begin >= 0 && end > begin, 'progressive discovery method exists');
const method = plugin.slice(begin, end);

function harness(responses) {
  const changes = [];
  let polls = 0;
  const network = {
    silent(url, success, fail) {
      polls++;
      const answer = responses.shift();
      setTimeout(() => answer instanceof Error ? fail(answer) : success(answer), 0);
    }
  };
  const deps = {
    network,
    filter: {
      set(name, entries) { changes.push(entries.map(e => [e.source, e.ghost])); },
      chosen() {},
      render() { return { find() { return { remove() {} }; } }; }
    },
    timers: (callback) => setTimeout(callback, 1)
  };
  const code = [
    'var Defined={localhost:"http://test/"},lifeNetwork=deps.network;',
    'var filter=deps.filter,Lampa={Arrays:{getKeys:Object.keys}};',
    'var balanserName=function(e){return e.name},account=function(url){return url};',
    'var addHeaders=function(){return {}},setTimeout=deps.timers;',
    'var sources={},filter_sources=[],balanser="",lifeSession=0;',
    'var life_wait_times=0,life_wait_timer=null;',
    method,
    'return this.lifeSource;'
  ].join('\n');
  const comp = { memkey: 'test', requestParams(url) { return url; } };
  const run = new Function('deps', code).call(comp, deps);
  return { resolve: () => run.call(comp), changes, polls: () => polls };
}

function provider(name, show) {
  return { name, url: '/' + name, show };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 30));

test('first ready source is available while slow one continues in background', async () => {
  const h = harness([
    { ready: false, online: [provider('fast', true)] },
    { ready: true, online: [provider('fast', true), provider('slow', true)] }
  ]);
  const ready = await h.resolve();
  assert.deepEqual(ready.map(x => x.name), ['fast']);
  await pause();
  assert.deepEqual(h.changes[h.changes.length - 1], [['fast', false], ['slow', false]]);
  assert.equal(h.polls(), 2);
});

test('pending source updates its availability without restarting the view', async () => {
  const h = harness([
    { ready: false, online: [] },
    { ready: false, online: [provider('one', false)] },
    { ready: true, online: [provider('one', true)] }
  ]);
  assert.deepEqual((await h.resolve()).map(x => x.name), ['one']);
  assert.deepEqual(h.changes, [[['one', true]], [['one', false]]]);
});

test('temporary failure does not abort progressive polling', async () => {
  const h = harness([
    new Error('timeout'),
    { ready: true, online: [provider('recovered', true)] }
  ]);
  assert.deepEqual((await h.resolve()).map(x => x.name), ['recovered']);
  assert.equal(h.polls(), 2);
});

test('no online sources rejects instead of reporting success', async () => {
  const h = harness([{ ready: true, online: [] }]);
  await assert.rejects(h.resolve());
});
