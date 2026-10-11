#!/usr/bin/env node
/* Прямой вызов ST-глю: открыть файл и открыть аудиодорожку, без воркера и фолбэков. */
const PW = '/srv/deepseek-harness/home/Servers/mcp/playwright/node_modules/playwright';
const CHROME = '/srv/deepseek-harness/home/Servers/chrome/chrome-linux64/chrome';
const { chromium } = require(PW);
const FILE = process.env.FILE || '/lampac-js/uploads/dts-6.1-real.mp4';
const INDEX = Number(process.env.INDEX || 1);
const GLUE = process.env.GLUE || 'mpvwasm-demuxer-st.js';
const TAG = process.env.TAG || 'dbg' + Date.now();

const probe = (arg) => new Promise((resolve) => {
  const b64url = (v) => {
    const bytes = new TextEncoder().encode(v);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/, '');
  };
  const url = location.origin + '/mpvwasm/proxy?u=' + b64url(new URL(arg.file, location.href).href);
  const base = location.origin;
  const code = `
    importScripts('${base}/mpvwasm/assets/${arg.glue}?v=${arg.tag}');
    self.MpvWasmDemuxerModule({ locateFile: function (n) { return '${base}/mpvwasm/assets/' + n + '?v=${arg.tag}'; },
                                print: function(){}, printErr: function(){} })
      .then(function (m) {
        var out = { glue: '${arg.glue}' };
        try {
          out.open = m.ccall('demux_open', 'number', ['string'], [${JSON.stringify(url)}]);
          out.tracks = JSON.parse(m.UTF8ToString(m._demux_tracks_json()));
          out.audioOpen = m._demux_audio_open(${arg.index});
          out.channels = m._demux_audio_pcm_channels();
          out.rate = m._demux_audio_sample_rate();
          if (out.audioOpen >= 0) {
            var read = m.ccall('demux_read_packet', 'number', [], []);
            out.firstRead = read;
            out.streamIndex = m._demux_packet_stream_index();
            out.decode = m._demux_audio_decode_current_packet();
            out.samples = m._demux_audio_pcm_samples();
            out.afterChannels = m._demux_audio_pcm_channels();
            var got = 0, guards = 0;
            while (guards++ < 400 && got < 3) {
              var r = m.ccall('demux_read_packet', 'number', [], []);
              if (r < 0) { out.readEnd = r; break; }
              if (m._demux_packet_stream_index() !== ${arg.index}) continue;
              m._demux_audio_decode_current_packet();
              var s = m._demux_audio_pcm_samples();
              if (s > 0) { got++; out.pcmSamples = (out.pcmSamples || 0) + s; }
            }
          }
        } catch (e) { out.error = String(e); }
        postMessage(out);
      })
      .catch(function (e) { postMessage({ glue: '${arg.glue}', loadError: String(e) }); });
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  const w = new Worker(URL.createObjectURL(blob));
  const timer = setTimeout(() => { w.terminate(); resolve({ glue: arg.glue, timeout: true }); }, 60000);
  w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
  w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ glue: arg.glue, workerError: String(e.message || e) }); };
});

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--mute-audio']
  });
  const page = await browser.newPage();
  await page.goto('https://lampac.fun/lampac-js/uploads/audio-wasm-check2.html', { waitUntil: 'domcontentloaded', timeout: 90000 });
  const r = await page.evaluate(probe, { file: FILE, index: INDEX, glue: GLUE, tag: TAG });
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
})();
