'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const workletPath = path.resolve(__dirname, '../Modules/MpvWasm/assets/mpvwasm-audio-worklet.js');
const hybridPath = path.resolve(__dirname, '../Modules/MpvWasm/assets/mpvwasm-hybrid-webcodecs.js');

function createProcessor(outputRate = 48000) {
  let Processor;
  const messages = [];
  class MockAudioWorkletProcessor {
    constructor() {
      this.port = { onmessage: null, postMessage(message) { messages.push(message); } };
    }
  }
  vm.runInNewContext(fs.readFileSync(workletPath, 'utf8'), {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor(name, cls) {
      assert.equal(name, 'mpvwasm-pcm-processor');
      Processor = cls;
    },
    sampleRate: outputRate,
    currentFrame: 0,
    Float32Array,
    Number,
    Math
  }, { filename: workletPath });
  const processor = new Processor();
  const post = (data) => processor.port.onmessage({ data });
  const render = (channelCount, frames = 128) => {
    const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
    processor.process([], [channels]);
    return channels;
  };
  return { processor, post, render, messages };
}

test('44.1 kHz input plays for one second at 48 kHz output without clock drift', () => {
  const { processor, post, render } = createProcessor(48000);
  post({ type: 'reset', basePtsUs: 0, hasBasePts: false });
  const pcm = new Float32Array(44100 * 2);
  for (let i = 0; i < 44100; i++) {
    pcm[2 * i] = Math.sin(2 * Math.PI * 440 * i / 44100) * 0.4;
    pcm[2 * i + 1] = pcm[2 * i];
  }
  post({ type: 'pcm', pcm, channels: 2, sampleRate: 44100, ptsUs: 0 });
  post({ type: 'state', paused: false });
  for (let i = 0; i < 375; i++) {
    const output = render(2);
    assert.ok(output[0].every(v => Number.isFinite(v)));
  }
  assert.ok(Math.abs(processor.clockUs - 1000000) < 200, 'audio PTS tracks real output duration');
  assert.equal(processor.underruns, 0);
});

test('48 kHz input at 48 kHz retains original timing and channel amplitudes', () => {
  const { processor, post, render } = createProcessor();
  const pcm = new Float32Array(480 * 2);
  for (let i = 0; i < pcm.length; i += 2) { pcm[i] = 0.1; pcm[i + 1] = -0.2; }
  post({ type: 'pcm', pcm, channels: 2, sampleRate: 48000, ptsUs: 5000000 });
  post({ type: 'state', paused: false });
  const output = render(2);
  assert.ok(Math.abs(output[0][0] - 0.1) < 0.00001);
  assert.ok(Math.abs(output[1][0] + 0.2) < 0.00001);
  assert.ok(Math.abs(processor.clockUs - (5000000 + 128 / 48000 * 1000000)) < 2);
});

test('discrete six-channel output preserves FL FR FC LFE SL SR without stereo downmix', () => {
  const { post, render } = createProcessor();
  const pcm = new Float32Array(256 * 6);
  const values = [0.1, -0.2, 0.3, 0.4, -0.5, 0.6];
  for (let i = 0; i < 256; i++)
    for (let ch = 0; ch < 6; ch++) pcm[i * 6 + ch] = values[ch];
  post({ type: 'pcm', pcm, channels: 6, sampleRate: 48000, ptsUs: 0 });
  post({ type: 'state', paused: false });
  const output = render(6);
  for (let ch = 0; ch < 6; ch++) assert.ok(Math.abs(output[ch][0] - values[ch]) < 0.00001, 'channel ' + ch);
});

test('eight-channel source folds rear/side pairs only if destination offers six channels', () => {
  const { post, render } = createProcessor();
  const pcm = new Float32Array(256 * 8);
  const values = [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.2, 0.3];
  for (let i = 0; i < 256; i++)
    for (let ch = 0; ch < 8; ch++) pcm[i * 8 + ch] = values[ch];
  post({ type: 'pcm', pcm, channels: 8, sampleRate: 48000, ptsUs: 0 });
  post({ type: 'state', paused: false });
  const output = render(6);
  assert.ok(Math.abs(output[4][0] - (0.1 + 0.7071 * 0.2)) < 0.00001);
  assert.ok(Math.abs(output[5][0] - (0.2 + 0.7071 * 0.3)) < 0.00001);
});

test('pause and reset clear the audio queue and do not advance playback clock', () => {
  const { processor, post, render } = createProcessor();
  post({ type: 'pcm', pcm: new Float32Array(48000), channels: 1, sampleRate: 48000, ptsUs: 100000 });
  post({ type: 'state', paused: true });
  render(2);
  assert.equal(processor.clockUs, 100000);
  post({ type: 'reset', basePtsUs: 4000000, hasBasePts: true });
  assert.equal(processor.queue.length, 0);
  assert.equal(processor.clockUs, 4000000);
  post({ type: 'state', paused: false });
  render(2);
  assert.equal(processor.clockUs, 4000000);
  assert.equal(processor.underruns, 1);
});

test('4K decode and decoded-frame queues are bounded and surround is device-gated', () => {
  const source = fs.readFileSync(hybridPath, 'utf8');
  assert.match(source, /width >= 3000 \? 8 : 16/);
  assert.match(source, /width >= 3000 \? 36 : 48/);
  assert.match(source, /maxDecodeQueue/);
  assert.match(source, /destination\.maxChannelCount/);
  assert.match(source, /outputChannelCount: \[wantedChannels\]/);
  assert.match(source, /audioOutputSampleRate/);
});
