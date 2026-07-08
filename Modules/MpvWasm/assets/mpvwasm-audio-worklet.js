class MpvWasmPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.currentOffset = 0;
    this.sourceChannels = 2;
    this.sourceRate = sampleRate;
    this.basePtsUs = 0;
    this.hasBasePts = false;
    this.playedSamples = 0;
    this.queuedSamples = 0;
    this.volume = 1;
    this.lastReportFrame = 0;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'reset') {
        this.queue = [];
        this.current = null;
        this.currentOffset = 0;
        this.basePtsUs = Number(data.basePtsUs || 0);
        this.hasBasePts = !!data.hasBasePts;
        this.playedSamples = 0;
        this.queuedSamples = 0;
        this.report(true);
        return;
      }

      if (data.type === 'volume') {
        this.volume = Math.max(0, Math.min(1, Number(data.volume || 0)));
        return;
      }

      if (data.type === 'pcm' && data.pcm) {
        const pcm = data.pcm instanceof Float32Array ? data.pcm : new Float32Array(data.pcm);
        const channels = Math.max(1, Number(data.channels || 2));
        const samples = Math.floor(pcm.length / channels);
        if (!samples) return;
        if (!this.hasBasePts && isFinite(Number(data.ptsUs))) {
          this.basePtsUs = Number(data.ptsUs);
          this.hasBasePts = true;
        }
        this.sourceChannels = channels;
        this.sourceRate = Math.max(1, Number(data.sampleRate || sampleRate));
        this.queue.push({
          pcm,
          channels,
          samples,
          ptsUs: Number(data.ptsUs || 0)
        });
        this.queuedSamples += samples;
      }
    };
  }

  nextBlock() {
    if (!this.current && this.queue.length) {
      this.current = this.queue.shift();
      this.currentOffset = 0;
    }
    return this.current;
  }

  sampleAt(block, frame, channel) {
    const channels = block.channels || 2;
    const offset = frame * channels;
    if (channels === 1) return block.pcm[offset] || 0;
    if (channel === 0) {
      let value = block.pcm[offset] || 0;
      if (channels > 2) value += (block.pcm[offset + 2] || 0) * 0.7;
      if (channels > 4) value += (block.pcm[offset + 4] || 0) * 0.5;
      return value;
    }
    let value = block.pcm[offset + 1] || 0;
    if (channels > 2) value += (block.pcm[offset + 2] || 0) * 0.7;
    if (channels > 5) value += (block.pcm[offset + 5] || 0) * 0.5;
    return value;
  }

  report(force) {
    const frameNow = typeof globalThis.currentFrame === 'number' ? globalThis.currentFrame : 0;
    if (!force && frameNow - this.lastReportFrame < sampleRate / 5) return;
    this.lastReportFrame = frameNow;
    const bufferSamples = Math.max(0, this.queuedSamples - this.playedSamples);
    const rate = Math.max(1, this.sourceRate || sampleRate);
    this.port.postMessage({
      type: 'clock',
      clockUs: this.basePtsUs + Math.round(this.playedSamples / rate * 1000000),
      playedSamples: this.playedSamples,
      queuedSamples: this.queuedSamples,
      bufferSamples,
      bufferUs: Math.round(bufferSamples / rate * 1000000),
      sampleRate: rate,
      channels: this.sourceChannels
    });
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length;
    let produced = 0;

    for (let i = 0; i < frames; i++) {
      const block = this.nextBlock();
      if (!block) break;

      for (let ch = 0; ch < output.length; ch++) {
        const value = this.sampleAt(block, this.currentOffset, ch) * this.volume;
        output[ch][i] = Math.max(-1, Math.min(1, value));
      }

      this.currentOffset++;
      produced++;

      if (this.currentOffset >= block.samples) {
        this.current = null;
        this.currentOffset = 0;
      }
    }

    if (produced) this.playedSamples += produced;
    this.report(false);
    return true;
  }
}

registerProcessor('mpvwasm-pcm-processor', MpvWasmPcmProcessor);
