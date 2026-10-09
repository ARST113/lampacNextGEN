'use strict';
const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../Modules/LampaWeb/plugins/mpvwasm-lampa-audio.js'), 'utf8');
const activeApps = [];
afterEach(() => { activeApps.splice(0).forEach(app => app.emit('Player:destroy')); });

function mockLampa(codecs, settings = {}) {
  const listeners = {};
  const nativeListeners = {};
  const messages = [];
  const renderedTracks = [];
  const contexts = [];
  const nodes = [];
  const workers = [];
  const video = {
    tagName: 'VIDEO',
    src: 'https://example.test/film.mkv',
    currentSrc: 'https://example.test/film.mkv',
    currentTime: 14,
    volume: 0.8,
    muted: false,
    paused: false,
    playbackRate: 1,
    audioTracks: [{ enabled: true }, { enabled: false }],
    canPlayType: () => '',
    addEventListener(name, fn) { (nativeListeners[name] ||= []).push(fn); },
    removeEventListener(name, fn) {
      nativeListeners[name] = (nativeListeners[name] || []).filter(x => x !== fn);
    }
  };
  function eventTarget(name) {
    return {
      listener: {
        follow(event, fn) { (listeners[name + ':' + event] ||= []).push(fn); },
        remove(event, fn) {
          listeners[name + ':' + event] = (listeners[name + ':' + event] || []).filter(x => x !== fn);
        }
      }
    };
  }
  const mockData = { url: video.src, ffprobe: [] };
  const lampa = {
    Player: Object.assign(eventTarget('Player'), { playdata: () => mockData }),
    PlayerVideo: Object.assign(eventTarget('Video'), { video: () => video }),
    PlayerPanel: { setTracks(tracks) { renderedTracks.push(tracks); } },
    Storage: { get(name, fallback) { return Object.hasOwn(settings, name) ? settings[name] : fallback; } },
    SettingsApi: { addParam() {} },
    Noty: { show(msg) { messages.push(msg); } }
  };
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.commands = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(msg) {
      this.commands.push(msg);
      let result = {};
      if (msg.command === 'open') result = { tracks: codecs.map((name, index) => ({
        index, type: 'audio', codecName: name, title: 'Track ' + index, channels: 2
      })) };
      if (msg.command === 'select') result = { selected: msg.index, sampleRate: 48000, channels: 2 };
      if (msg.command === 'seek') result = true;
      if (msg.command === 'read') result = {
        chunks: [{ pcm: new Float32Array(48000), ptsUs: Math.round(video.currentTime * 1e6), sampleRate: 48000, channels: 2 }],
        eof: false
      };
      queueMicrotask(() => {
        if (!this.terminated && this.onmessage) this.onmessage({ data: { id: msg.id, ok: true, result } });
      });
    }
    terminate() { this.terminated = true; }
  }
  class FakeContext {
    constructor() {
      this.state = 'suspended';
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  class FakeNode {
    constructor(ctx) {
      this.ctx = ctx;
      nodes.push(this);
      this.port = {
        onmessage: null,
        commands: [],
        postMessage: (msg) => {
          this.port.commands.push(msg);
          if (msg.type === 'pcm') queueMicrotask(() => {
            this.port.onmessage?.({ data: { type: 'status', bufferedUs: 3200000 } });
          });
        }
      };
      this.closed = false;
    }
    connect() {}
    disconnect() { this.closed = true; }
  }
  const ctx = {
    window: { Lampa: lampa, isSecureContext: true, AudioContext: FakeContext, AudioWorkletNode: FakeNode },
    Lampa: lampa, AudioWorkletNode: FakeNode,
    AudioContext: FakeContext, Worker: FakeWorker,
    TextEncoder, btoa,
    console: { log() {}, warn() {}, error() {} },
    setInterval, clearInterval, setTimeout, clearTimeout,
    Promise, Uint8Array, Float32Array
  };
  vm.runInNewContext(source, ctx, { filename: 'mpvwasm-lampa-audio.js' });
  function emit(name, data) { (listeners[name] || []).forEach(fn => fn(data || mockData)); }
  function emitNative(name) { (nativeListeners[name] || []).forEach(fn => fn()); }
  async function flush() {
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  const app = { video, workers, contexts, nodes, renderedTracks, messages, emit, emitNative, flush };
  activeApps.push(app);
  return app;
}

test('keeps the original Lampa video source and timeline (AAC only)', async () => {
  const app = mockLampa(['aac']);
  app.emit('Player:ready');
  await app.flush();
  assert.equal(app.video.src, 'https://example.test/film.mkv');
  assert.equal(app.video.currentTime, 14);
  assert.equal(app.video.muted, false);
  assert.equal(app.workers.length, 1); // async probe, but no audio decoder
  assert.equal(app.workers[0].terminated, true);
  assert.equal(app.renderedTracks.length, 0);
  app.emit('Player:destroy');
});

test('AC3 uses independent worker while native Lampa owns seeking and lifecycle', async () => {
  const app = mockLampa(['ac3', 'aac']);
  app.emit('Player:ready');
  await app.flush();
  assert.equal(app.video.currentTime, 14);
  assert.equal(app.video.src, 'https://example.test/film.mkv');
  assert.equal(app.video.muted, true);
  assert.ok(app.workers[0].commands.some(x => x.command === 'select' && x.index === 0));
  assert.ok(app.workers[0].commands.some(x => x.command === 'read'));
  assert.ok(app.renderedTracks.length);
  assert.match(app.renderedTracks.at(-1)[0].title, /AC3/);

  app.video.currentTime = 87.5;
  app.emitNative('seeking');
  await app.flush();
  assert.equal(app.video.currentTime, 87.5);
  assert.ok(app.workers[0].commands.some(x => x.command === 'seek' && x.us === 87500000));
  app.emit('Player:destroy');
  assert.equal(app.video.muted, false);
  assert.equal(app.workers[0].terminated, true);
});

test('selecting native AAC restores native audio without touching video', async () => {
  const app = mockLampa(['eac3', 'aac']);
  app.emit('Player:ready');
  await app.flush();
  app.renderedTracks.at(-1)[1].onSelect();
  await app.flush();
  assert.equal(app.video.muted, false);
  assert.equal(app.video.audioTracks[1].enabled, true);
  assert.equal(app.video.currentTime, 14);
  app.emit('Player:destroy');
});

test('off mode never initializes an audio worker', async () => {
  const app = mockLampa(['dts'], { mpvwasm_audio_mode: 'off' });
  app.emit('Player:ready');
  await app.flush();
  assert.equal(app.workers.length, 0);
  assert.equal(app.video.muted, false);
  app.emit('Player:destroy');
});

test('no double initialization for ready and loadeddata on same element', async () => {
  const app = mockLampa(['dts']);
  app.emit('Player:ready');
  app.emit('Video:loadeddata');
  await app.flush();
  assert.equal(app.workers.length, 1);
  app.emit('Player:destroy');
});

test('buffers video without advancing the independent audio clock', async () => {
  const app = mockLampa(['ac3']);
  app.video.readyState = 2; // HAVE_CURRENT_DATA: waiting for more video
  app.emit('Player:ready');
  await app.flush();
  await app.flush();
  const sync = app.nodes[0].port.commands.filter(x => x.type === 'sync').at(-1);
  assert.equal(sync.paused, true);
  assert.equal(app.video.currentTime, 14);
  app.video.readyState = 4;
  // Synchronization ticks every 120 ms; observe at least one full tick.
  await app.flush();
  await app.flush();
  await app.flush();
  const resumed = app.nodes[0].port.commands.filter(x => x.type === 'sync').at(-1);
  assert.equal(resumed.paused, false);
  app.emit('Player:destroy');
});
