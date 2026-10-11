/* MPV2 audio renderer: resampling, PTS clock and discrete surround PCM.
 * Input: interleaved Float32 PCM. Output: browser AudioContext sample rate.
 * Actual channel delivery depends on AudioDestinationNode / OS hardware.
 */
class MpvWasmPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.currentOffset = 0;
    this.sourceChannels = 2;
    this.sourceRate = sampleRate;
    this.basePtsUs = 0;
    this.clockUs = 0;
    this.hasBasePts = false;
    this.playedSamples = 0;
    this.queuedSamples = 0;
    this.volume = 1;
    this.paused = true;
    this.lastReportFrame = 0;
    this.processCalls = 0;
    this.underruns = 0;
    this.outputPeak = 0;
    this.outputChannels = 2;
    this.statusContextFrame = null;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'reset') {
        this.queue = [];
        this.current = null;
        this.currentOffset = 0;
        this.basePtsUs = Number(data.basePtsUs || 0);
        this.clockUs = this.basePtsUs;
        this.hasBasePts = !!data.hasBasePts;
        this.playedSamples = 0;
        this.queuedSamples = 0;
        this.outputPeak = 0;
        this.report(true);
      } else if (data.type === 'volume') {
        this.volume = Math.max(0, Math.min(1, Number(data.volume || 0)));
      } else if (data.type === 'state') {
        this.paused = !!data.paused;
        this.report(true);
      } else if (data.type === 'pcm' && data.pcm) {
        const pcm = data.pcm instanceof Float32Array ? data.pcm : new Float32Array(data.pcm);
        const channels = Math.max(1, Math.min(8, Number(data.channels || 2)));
        const rate = Math.max(1, Number(data.sampleRate || sampleRate));
        const frames = Math.floor(pcm.length / channels);
        if (!frames) return;
        const ptsUs = Number(data.ptsUs);
        if (!this.hasBasePts && Number.isFinite(ptsUs)) {
          this.basePtsUs = ptsUs;
          this.clockUs = ptsUs;
          this.hasBasePts = true;
        }
        this.sourceChannels = channels;
        this.sourceRate = rate;
        this.queue.push({
          pcm: pcm,
          channels: channels,
          rate: rate,
          samples: frames,
          ptsUs: Number.isFinite(ptsUs) ? ptsUs : this.clockUs
        });
        this.queuedSamples += frames;
      }
    };
  }

  nextBlock() {
    while (true) {
      if (!this.current) {
        if (!this.queue.length) return null;
        this.current = this.queue.shift();
      }
      if (this.currentOffset < this.current.samples) return this.current;
      this.currentOffset -= this.current.samples;
      this.current = null;
    }
  }

  readSource(block, frame, channel) {
    const index = Math.min(block.samples - 1, Math.max(0, frame));
    return block.pcm[index * block.channels + Math.min(channel, block.channels - 1)] || 0;
  }

  interpolateSource(block, offset, fraction, sourceChannel) {
    if (sourceChannel >= block.channels) return 0;
    const a = this.readSource(block, offset, sourceChannel);
    let b = a;
    if (offset + 1 < block.samples) {
      b = this.readSource(block, offset + 1, sourceChannel);
    } else if (this.queue.length) {
      const next = this.queue[0];
      const expectedPts = block.ptsUs + block.samples * 1000000 / block.rate;
      if (next.channels === block.channels && next.rate === block.rate &&
          Math.abs(next.ptsUs - expectedPts) < 20000) {
        b = this.readSource(next, 0, sourceChannel);
      }
    }
    return a + (b - a) * fraction;
  }

  sampleAt(block, position, channel, outputChannels) {
    const offset = Math.floor(position);
    const fraction = position - offset;
    const channels = block.channels;
    if (outputChannels > 2) {
      if (channels === 1) return channel === 2 ? this.interpolateSource(block, offset, fraction, 0) : 0;
      if (channels === 2) return channel < 2 ? this.interpolateSource(block, offset, fraction, channel) : 0;
      if (outputChannels === 6 && channels >= 8 && (channel === 4 || channel === 5)) {
        return this.interpolateSource(block, offset, fraction, channel) +
          0.7071 * this.interpolateSource(block, offset, fraction, channel + 2);
      }
      return this.interpolateSource(block, offset, fraction, channel);
    }
    if (channels === 1) return this.interpolateSource(block, offset, fraction, 0);
    if (channels === 2) return this.interpolateSource(block, offset, fraction, channel);
    if (channel === 0) {
      return this.interpolateSource(block, offset, fraction, 0) +
        this.interpolateSource(block, offset, fraction, 2) * 0.7071 +
        this.interpolateSource(block, offset, fraction, 4) * 0.5 +
        (channels >= 8 ? this.interpolateSource(block, offset, fraction, 6) * 0.35 : 0);
    }
    return this.interpolateSource(block, offset, fraction, 1) +
      this.interpolateSource(block, offset, fraction, 2) * 0.7071 +
      (channels >= 6 ? this.interpolateSource(block, offset, fraction, 5) * 0.5 : 0) +
      (channels >= 8 ? this.interpolateSource(block, offset, fraction, 7) * 0.35 : 0);
  }

  bufferedUs() {
    let total = 0;
    if (this.current) {
      total += Math.max(0, this.current.samples - this.currentOffset) * 1000000 / this.current.rate;
    }
    for (let i = 0; i < this.queue.length; i++) {
      const block = this.queue[i];
      total += block.samples * 1000000 / block.rate;
    }
    return Math.max(0, Math.round(total));
  }

  report(force) {
    const frameNow = typeof currentFrame === 'number' ? currentFrame : this.playedSamples;
    if (!force && frameNow - this.lastReportFrame < sampleRate / 5) return;
    this.lastReportFrame = frameNow;
    const remainingUs = this.bufferedUs();
    this.port.postMessage({
      type: 'clock',
      clockUs: Math.round(this.clockUs),
      contextFrame: this.statusContextFrame,
      playedSamples: this.playedSamples,
      queuedSamples: this.queuedSamples,
      bufferSamples: Math.round(remainingUs * sampleRate / 1000000),
      bufferUs: remainingUs,
      sampleRate: this.sourceRate,
      channels: this.sourceChannels,
      outputChannels: this.outputChannels,
      outputSampleRate: sampleRate,
      paused: this.paused,
      processCalls: this.processCalls,
      underruns: this.underruns,
      outputPeak: this.outputPeak
    });
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    this.processCalls++;
    this.outputChannels = output.length;
    this.statusContextFrame = typeof currentFrame === 'number' ? currentFrame + output[0].length : null;
    if (this.paused) {
      this.report(false);
      return true;
    }
    const frames = output[0].length;
    let produced = 0;
    let peak = 0;
    for (let frame = 0; frame < frames; frame++) {
      const block = this.nextBlock();
      if (!block) break;
      const position = this.currentOffset;
      for (let ch = 0; ch < output.length; ch++) {
        const value = this.sampleAt(block, position, ch, output.length) * this.volume;
        output[ch][frame] = Math.max(-1, Math.min(1, value));
        peak = Math.max(peak, Math.abs(output[ch][frame]));
      }
      this.currentOffset += block.rate / sampleRate;
      this.clockUs = block.ptsUs + Math.min(this.currentOffset, block.samples) * 1000000 / block.rate;
      produced++;
    }
    this.playedSamples += produced;
    if (produced < frames) this.underruns++;
    this.outputPeak = Math.max(peak, this.outputPeak * 0.85);
    this.report(false);
    return true;
  }
}

registerProcessor('mpvwasm-pcm-processor', MpvWasmPcmProcessor);
