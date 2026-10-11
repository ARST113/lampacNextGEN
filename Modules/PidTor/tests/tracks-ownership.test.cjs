'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const file = path.join(__dirname, '..', '..', 'Tracks', 'plugin.js');
const source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(ast.parseDiagnostics.length, 0);
let handler;
function find(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'Lampa.Player.listener.follow'
      && node.arguments[0]?.text === 'start') handler = node.arguments[1].getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(handler, 'actual Tracks player-start handler must exist');
const calls = [];
const start = vm.runInNewContext('(' + handler + ')', { subscribeTracks: data => calls.push(data) });
start({ torrent_hash: 'a'.repeat(40), pidtor_nextgen: true });
assert.equal(calls.length, 0, 'Tracks must not compete with PidTor controls');
start({ torrent_hash: 'b'.repeat(40) });
assert.equal(calls.length, 1, 'ordinary torrents must keep Tracks');
start({});
assert.equal(calls.length, 1);
console.log('Tracks ownership: 3/3 passed');
