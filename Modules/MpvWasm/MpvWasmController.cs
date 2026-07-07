using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.AspNetCore.Http;
using System;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace MpvWasm;

[ApiController]
[Route("mpvwasm")]
[AllowAnonymous]
public class MpvWasmController : ControllerBase
{
    static readonly FileExtensionContentTypeProvider ContentTypes = new();
    readonly MpvWasmProxyService _proxy = new();
    readonly MpvWasmHlsRewriteService _hls = new();

    [HttpGet("health")]
    public IActionResult Health()
    {
        if (!ModInit.conf.enable)
            return StatusCode((int)HttpStatusCode.ServiceUnavailable, "MPV WASM disabled");

        return Content("OK", "text/plain");
    }

    [HttpGet("test.html")]
    public IActionResult TestPage()
    {
        if (!ModInit.conf.enableTestPage)
            return NotFound();

        if (ModInit.conf.crossOriginIsolationForTestPage)
        {
            Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
            Response.Headers["Cross-Origin-Embedder-Policy"] = "require-corp";
        }

        var assetsOk = AssetsAvailable();
        var disabled = !ModInit.conf.enable;
        var html = BuildTestPage(disabled, assetsOk);
        return Content(html, "text/html; charset=utf-8");
    }

    [HttpGet("player.js")]
    public IActionResult PlayerJs()
    {
        var path = Path.Combine(ModInit.modpath, "player.js");
        if (!System.IO.File.Exists(path))
            return NotFound();

        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        return PhysicalFile(path, "application/javascript; charset=utf-8");
    }

    [HttpGet("test.js")]
    public IActionResult TestJs()
    {
        var path = Path.Combine(ModInit.modpath, "test.js");
        if (!System.IO.File.Exists(path))
            return NotFound();

        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        return PhysicalFile(path, "application/javascript; charset=utf-8");
    }

    [HttpGet("assets/{**path}")]
    public IActionResult Asset(string path)
        => ServeAsset(path);

    [HttpGet("libmpv.js")]
    public IActionResult LibMpvJs() => ServeAsset("libmpv.js");

    [HttpGet("libmpv.wasm")]
    public IActionResult LibMpvWasm() => ServeAsset("libmpv.wasm");

    [HttpGet("libmpv.worker.js")]
    public IActionResult LibMpvWorker() => ServeAsset("libmpv.worker.js");

    [HttpGet("libmpv.data")]
    public IActionResult LibMpvData() => ServeAsset("libmpv.data");

    [AcceptVerbs("OPTIONS")]
    [Route("proxy")]
    [Route("hls")]
    public IActionResult Options()
    {
        MpvWasmHeaders.ApplyCors(Response);
        return Ok();
    }

    [AcceptVerbs("GET", "HEAD")]
    [Route("proxy")]
    public async Task<IActionResult> Proxy([FromQuery] string u, [FromQuery] string h = "")
    {
        if (!ModInit.conf.enable || !ModInit.conf.enableProxy)
            return StatusCode((int)HttpStatusCode.ServiceUnavailable, "MPV WASM proxy disabled");

        try
        {
            using var upstream = await _proxy.SendAsync(u, h, Request, ModInit.conf, HttpContext.RequestAborted);
            Response.StatusCode = (int)upstream.StatusCode;
            MpvWasmHeaders.CopyProxyResponseHeaders(upstream, Response, ModInit.conf);

            if (HttpMethods.IsHead(Request.Method))
            {
                await Response.StartAsync(HttpContext.RequestAborted);
                return new EmptyResult();
            }

            await using var stream = await upstream.Content.ReadAsStreamAsync(HttpContext.RequestAborted);
            await stream.CopyToAsync(Response.Body, HttpContext.RequestAborted);
            return new EmptyResult();
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            Console.WriteLine("[MpvWasm] blocked proxy request: " + ex.Message);
            return StatusCode((int)HttpStatusCode.Forbidden, ex.Message);
        }
        catch (TaskCanceledException)
        {
            return StatusCode(504, "Upstream timeout");
        }
    }

    [AcceptVerbs("GET", "HEAD")]
    [Route("hls")]
    public async Task<IActionResult> Hls([FromQuery] string u, [FromQuery] string h = "")
    {
        if (!ModInit.conf.enable || !ModInit.conf.enableHlsRewrite)
            return StatusCode((int)HttpStatusCode.ServiceUnavailable, "MPV WASM HLS rewrite disabled");

        try
        {
            if (HttpMethods.IsHead(Request.Method))
            {
                using var upstream = await _proxy.SendAsync(u, h, Request, ModInit.conf, HttpContext.RequestAborted);
                Response.StatusCode = (int)upstream.StatusCode;
                MpvWasmHeaders.CopyProxyResponseHeaders(upstream, Response, ModInit.conf);
                await Response.StartAsync(HttpContext.RequestAborted);
                return new EmptyResult();
            }

            var (status, contentType, body) = await _hls.FetchAndRewriteAsync(u, h, Request, ModInit.conf, HttpContext.RequestAborted);
            Response.StatusCode = (int)status;
            if (ModInit.conf.exposeCors)
                MpvWasmHeaders.ApplyCors(Response);

            return Content(body, contentType);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            Console.WriteLine("[MpvWasm] blocked HLS request: " + ex.Message);
            return StatusCode((int)HttpStatusCode.Forbidden, ex.Message);
        }
        catch (TaskCanceledException)
        {
            return StatusCode(504, "Upstream timeout");
        }
    }

    IActionResult ServeAsset(string path)
    {
        var file = ResolveAssetPath(path);
        if (file == null || !System.IO.File.Exists(file))
            return NotFound("MPV WASM asset not found");

        if (!ContentTypes.TryGetContentType(file, out var contentType))
            contentType = "application/octet-stream";

        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
        return PhysicalFile(file, contentType, enableRangeProcessing: true);
    }

    static string? ResolveAssetPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('\0'))
            return null;

        path = path.Replace('\\', '/').TrimStart('/');
        if (path.Contains("../", StringComparison.Ordinal))
            return null;

        var root = Path.GetFullPath(ModInit.GetAssetsRoot())
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(root, path));
        var rootWithSeparator = root + Path.DirectorySeparatorChar;

        return full.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    static bool AssetsAvailable()
    {
        return System.IO.File.Exists(Path.Combine(ModInit.GetAssetsRoot(), "libmpv.js")) &&
               System.IO.File.Exists(Path.Combine(ModInit.GetAssetsRoot(), "libmpv.wasm"));
    }

    static string BuildTestPage(bool disabled, bool assetsOk)
    {
        var message = disabled
            ? "MPV WASM module is disabled. Set mpvwasm.enable=true in init.conf."
            : assetsOk
                ? ""
                : "MPV WASM assets not found. Build libmpv-wasm and copy libmpv.js/libmpv.wasm/worker files to configured assets directory.";

        return $$"""
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MPV WASM test</title>
  <style>
    html,body{margin:0;background:#101114;color:#f2f2f2;font:14px/1.45 system-ui,Segoe UI,sans-serif}
    main{max-width:980px;margin:0 auto;padding:24px}
    canvas{display:block;width:100%;aspect-ratio:16/9;background:#000;border:1px solid #333}
    input,textarea{width:100%;box-sizing:border-box;margin:8px 0 12px;padding:10px;background:#181a1f;color:#fff;border:1px solid #444}
    textarea{min-height:82px;resize:vertical}
    label{display:inline-flex;align-items:center;gap:8px;margin:0 16px 12px 0}
    label input{width:auto;margin:0}
    button{margin:0 8px 8px 0;padding:9px 14px;background:#2e6df6;color:#fff;border:0;border-radius:4px}
    dl{display:grid;grid-template-columns:160px 1fr;gap:6px 14px;background:#181a1f;border:1px solid #333;padding:12px}
    dt{color:#aeb4bf}
    dd{margin:0}
    pre{white-space:pre-wrap;background:#181a1f;border:1px solid #333;padding:12px;min-height:120px}
    .warn{color:#ffd166;margin:12px 0}
  </style>
</head>
<body>
<main>
  <h1>MPV WASM test</h1>
  <div class="warn" id="warn">{{WebUtility.HtmlEncode(message)}}</div>
  <canvas id="screen"></canvas>
  <input id="source-url" value="https://example.com/video.mp4" spellcheck="false" aria-label="URL">
  <label><input id="use-proxy" type="checkbox" checked>Use proxy</label>
  <label><input id="use-hls" type="checkbox">Use HLS rewrite</label>
  <textarea id="headers-json" spellcheck="false" aria-label="Headers JSON">{}</textarea>
  <input id="built-url" value="" spellcheck="false" aria-label="Built proxy URL">
  <div>
    <button id="build-url">Build proxy URL</button>
    <button id="play">Play</button>
    <button id="pause">pause</button>
    <button id="resume">resume</button>
    <button id="back">-30s</button>
    <button id="forward">+30s</button>
  </div>
  <dl>
    <dt>duration</dt><dd id="duration">-</dd>
    <dt>elapsed</dt><dd id="elapsed">-</dd>
    <dt>buffering</dt><dd id="buffering">-</dd>
    <dt>cache</dt><dd id="cache">-</dd>
    <dt>percent</dt><dd id="percent-pos">-</dd>
    <dt>video size</dt><dd id="video-size">-</dd>
    <dt>audio tracks</dt><dd id="audio-tracks">-</dd>
    <dt>subtitle tracks</dt><dd id="subtitle-tracks">-</dd>
  </dl>
  <pre id="log"></pre>
</main>
<script src="/mpvwasm/player.js"></script>
<script type="module" src="/mpvwasm/test.js"></script>
</body>
</html>
""";
    }
}
