'use strict';
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const port = Number(process.env.CI_PORT || 8787);
const seconds = Math.max(15, Math.min(180, Number(process.env.MPV2_TEST_SECONDS || 70)));
const out = path.resolve('artifacts/mpv2-android');
fs.mkdirSync(out, { recursive: true });
const browserLog = [], snapshots = [], sleep = ms => new Promise(done => setTimeout(done, ms));
function safe(message) {
  return String(message || '').split(process.env.MPV2_VIDEO_URL || '\0').join('[STREAM_URL]').slice(0, 1500);
}
async function main() {
  let browser, page;
  const report = { startedAt: new Date().toISOString(), testSeconds: seconds,
    outcome: 'inconclusive', reason: '' };
  try {
    for (let attempt = 0; attempt < 24 && !browser; attempt++) {
      try { browser = await puppeteer.connect({
        browserURL: 'http://127.0.0.1:9222', defaultViewport: null, protocolTimeout: 20000 }); }
      catch (_) { await sleep(2500); }
    }
    if (!browser) throw new Error('Android Chrome DevTools socket unavailable');
    page = (await browser.pages())[0] || await browser.newPage();
    page.on('console', message => browserLog.push({
      at:Date.now(), type:message.type(), text:safe(message.text()) }));
    page.on('pageerror', error => browserLog.push({
      at:Date.now(), type:'pageerror', text:safe(error.stack || error.message) }));
    page.on('requestfailed', request => browserLog.push({
      at:Date.now(), type:'requestfailed',
      text:safe(request.url() + ' ' + (request.failure() && request.failure().errorText || '')) }));
    await page.goto('http://localhost:' + port + '/', { waitUntil:'domcontentloaded', timeout:45000 });
    await sleep(3000);
    console.log('[mpv2-android] Lampa page loaded; screenshots captured separately by adb');
    let previousFrames = 0, samplesWithProgress = 0, maxElapsed = 0, maxRendered = 0, last = null;
    for (let i = 0; i < seconds / 3; i++) {
      await sleep(3000);
      try {
        const data = await page.evaluate(() => {
          const ci = window.__MPV2_CI__ || {};
          const d = window.__mpvwasm_hybrid_debug || {};
          const p = window.MpvWasmLampa && MpvWasmLampa.activeInfo ?
            MpvWasmLampa.activeInfo() : null;
          return {
            timestamp:Date.now(), ci, lampaReady:!!(window.Lampa && Lampa.Player),
            playerPluginReady:!!window.MpvWasmLampa, playerActive:!!(p && p.active),
            playerBackend:p && p.activeBackend || null,
            playerLastError:p && p.lastError || window.__mpvwasm_last_error || '',
            playerElapsed:p && Number(p.elapsed || 0),
            panelVisible:!!document.querySelector('.mpvwasm-lampa-root .player-panel'),
            metrics:{
              codec:d.codec || '', renderer:d.renderer || '',
              renderFps:Number(d.renderFps || 0), decodeFps:Number(d.decodeFps || 0),
              renderedFrames:Number(d.renderedFrames || 0),
              droppedFrames:Number(d.droppedFrames || 0), driftMs:d.driftMs,
              audioBufferUs:Number(d.audioBufferUs || 0), audioDecoder:d.audioDecoder || '',
              audioOutputChannels:Number(d.audioOutputChannels || 0),
              audioDestinationMaxChannels:Number(d.audioDestinationMaxChannels || 0),
              audioUnderruns:Number(d.audioUnderruns || 0),
              decodeQueue:Number(d.decodeQueue || 0), videoQueue:Number(d.videoQueue || 0),
              buffering:!!d.buffering
            }
          };
        });
        last = data;
        maxRendered = Math.max(maxRendered, data.metrics.renderedFrames);
        maxElapsed = Math.max(maxElapsed, data.playerElapsed || 0);
        if (data.metrics.renderedFrames > previousFrames) samplesWithProgress++;
        previousFrames = data.metrics.renderedFrames;
        snapshots.push(data);
        if (i % 4 === 0) console.log('[mpv2-android] ' + JSON.stringify({
          step:i, backend:data.playerBackend, elapsed:data.playerElapsed,
          rendered:data.metrics.renderedFrames, fps:data.metrics.renderFps,
          driftMs:data.metrics.driftMs, error:safe(data.playerLastError)
        }));
      } catch (err) { browserLog.push({type:'runner',text:safe(err.message)}); }
    }
    console.log('[mpv2-android] Playback observation loop completed');
    const mediaState = await (await fetch('http://127.0.0.1:' + port + '/ci/health')).json();
    report.media = mediaState;
    report.last = last;
    report.maxRenderedFrames = maxRendered;
    report.maxElapsedSeconds = maxElapsed;
    report.samplesWithProgress = samplesWithProgress;
    if (!last || !last.ci.started) report.reason = 'Lampa or MPV2 was not initialized';
    else if (mediaState.mediaRequests === 0) report.reason = 'No requests reached chosen stream';
    else if (last.playerBackend !== 'hybrid-webcodecs') report.reason =
      'MPV2 WebCodecs inactive or HTML5 fallback: ' + last.playerBackend;
    else if (maxRendered < 15 || maxElapsed < 2 || samplesWithProgress < 3)
      report.reason = 'No sustained playback in emulated Chrome';
    else {
      report.outcome = 'playback-observed';
      report.reason = 'Emulator showed video and advancing clock; hardware A/V not verified';
    }
    if (report.outcome !== 'playback-observed') {
      report.recentErrors = browserLog.filter(x =>
        ['error','pageerror','requestfailed'].includes(x.type)).slice(-15);
      console.error('[mpv2-android] INCONCLUSIVE: ' + report.reason);
    } else console.log('[mpv2-android] PLAYBACK OBSERVED');
  } catch (error) {
    report.outcome = 'inconclusive'; report.reason = safe(error.stack || error.message);
    console.error(report.reason);
  } finally {
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out,'result.json'), JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(out,'samples.json'), JSON.stringify(snapshots,null,2));
    fs.writeFileSync(path.join(out,'console.json'), JSON.stringify(browserLog.slice(-400),null,2));
    // Android screencap is saved by drive.sh, avoiding DevTools GPU screenshot stalls.
    try { if (browser) await browser.disconnect(); } catch (_) {}
  }
  if (report.outcome !== 'playback-observed') process.exitCode = 1;
}
main();
