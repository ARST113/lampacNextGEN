/* Native Lampa video is the master clock. Audio PCM is timestamped, resampled and rendered independently.
 *
 * android-7: часы звука идут сами (свободный ход), а расхождение с видео
 * выбирается мягко, изменением хода в пределах ±2.5%, а не мгновенным
 * перескоком. Жёсткий скачок часов оставлен только для перемотки и паузы:
 * каждый перескок — это выброшенный кусок PCM и щелчок. */
class LampaAudioBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.clockUs = 0;
    this.rate = 1;
    this.skew = 1;            // мягкая подстройка хода часов к видео
    this.paused = true;
    this.volume = 1;
    this.reportFrames = 0;
    this.underruns = 0;       // кадры, которые нечем было заполнить
    this.gaps = 0;            // сколько раз подряд шли без данных
    this.slips = 0;           // жёсткие перескоки часов (перемотка/пауза)
    this.skewed = 0;          // сколько раз подстраивали ход
    this.capacity = 600;
    this.dropped = 0;
    this.inGap = false;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      switch (data.type) {
        case 'clear':
          this.blocks.length = 0;
          this.clockUs = Math.max(0, Number(data.clockUs || 0));
          this.underruns = 0;
          this.gaps = 0;
          this.dropped = 0;
          this.skew = 1;
          this.inGap = false;
          break;
        case 'sync': {
          const target = Math.max(0, Number(data.clockUs || 0));
          const delta = target - this.clockUs;
          // Перескок — только когда это действительно перемотка, пауза или первый запуск.
          if (this.paused || Math.abs(delta) > 400000) {
            this.clockUs = target;
            this.skew = 1;
            if (!this.paused) this.slips++;
          } else {
            // Держим ход в пределах ±2.5%: расхождение до 25 мс выбирается за секунду,
            // звук при этом не рвётся.
            const next = 1 + delta / 1000000;
            const clamped = Math.max(0.975, Math.min(1.025, next));
            if (Math.abs(clamped - 1) > 0.0005) this.skewed++;
            this.skew = clamped;
          }
          this.paused = !!data.paused;
          this.rate = Math.max(0.25, Math.min(4, Number(data.rate || 1)));
          this.volume = Math.max(0, Math.min(1, Number(data.volume)));
          if (!isFinite(this.volume)) this.volume = 1;
          break;
        }
        case 'pcm': {
          const pcm = data.pcm instanceof Float32Array ? data.pcm : new Float32Array(data.pcm);
          const channels = Math.max(1, Math.min(16, Number(data.channels || 2)));
          const rate = Math.max(8000, Number(data.sampleRate || 48000));
          const samples = Math.floor(pcm.length / channels);
          const start = Number(data.ptsUs);
          if (!samples || !isFinite(start)) break;
          if (this.blocks.length >= this.capacity) { this.dropped++; break; }
          this.blocks.push({ pcm, channels, rate, samples, start, end: start + samples * 1000000 / rate });
          this.blocks.sort((a, b) => a.start - b.start);
          break;
        }
      }
    };
  }
  mix(block, frame, channel) {
    const channels = block.channels;
    const index = Math.max(0, Math.min(block.samples - 1, frame)) * channels;
    const pcm = block.pcm;
    if (channels === 1) return pcm[index] || 0;
    if (channels === 2) return pcm[index + channel] || 0;
    // Common FFmpeg 5.1 layout: FL FR FC LFE BL BR.
    let value = pcm[index + channel] || 0;
    if (channels >= 3) value += (pcm[index + 2] || 0) * 0.7071;
    if (channels >= 5) value += (pcm[index + (channel === 0 ? 4 : (channels >= 6 ? 5 : 4))] || 0) * 0.5;
    if (channels >= 7) value += (pcm[index + (channel === 0 ? 6 : (channels >= 8 ? 7 : 6))] || 0) * 0.3;
    return value * 0.65;
  }
  report() {
    const last = this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
    this.port.postMessage({
      type: 'status',
      clockUs: Math.round(this.clockUs),
      bufferedUs: Math.max(0, Math.round((last ? last.end : this.clockUs) - this.clockUs)),
      queueLength: this.blocks.length,
      capacity: this.capacity,
      dropped: this.dropped,
      paused: this.paused,
      underruns: this.underruns,
      gaps: this.gaps,
      slips: this.slips,
      skewed: this.skewed,
      skew: this.skew
    });
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.paused) break;
      const now = this.clockUs;
      while (this.blocks.length && this.blocks[0].end <= now) this.blocks.shift();
      const block = this.blocks.length ? this.blocks[0] : null;
      if (block && now >= block.start && now < block.end) {
        this.inGap = false;
        const position = (now - block.start) * block.rate / 1000000;
        const frame = Math.floor(position);
        const alpha = position - frame;
        for (let channel = 0; channel < output.length; channel++) {
          const a = this.mix(block, frame, channel);
          const b = this.mix(block, Math.min(block.samples - 1, frame + 1), channel);
          const value = (a + (b - a) * alpha) * this.volume;
          output[channel][i] = Math.max(-1, Math.min(1, value));
        }
      } else {
        // Данных нет: считаем провал и идём дальше — как только часы дойдут до
        // начала следующего блока, звук продолжится с него же.
        this.underruns++;
        if (!this.inGap) { this.inGap = true; this.gaps++; }
      }
      this.clockUs += this.rate * this.skew * 1000000 / sampleRate;
    }
    this.reportFrames += frames;
    if (this.reportFrames >= sampleRate / 5) { this.reportFrames = 0; this.report(); }
    return true;
  }
}
registerProcessor('lampa-audio-wasm-bridge', LampaAudioBridgeProcessor);
