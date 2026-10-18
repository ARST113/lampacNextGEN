using Microsoft.AspNetCore.Http;
using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace MpvWasm;

public sealed class MpvWasmHlsRewriteService
{
    readonly MpvWasmProxyService _proxy = new();

    public async Task<(HttpStatusCode Status, string ContentType, string Body)> FetchAndRewriteAsync(string encodedUrl, string encodedHeaders, HttpRequest request, ModuleConf conf, CancellationToken cancellationToken)
    {
        using var upstream = await _proxy.SendAsync(encodedUrl, encodedHeaders, request, conf, cancellationToken);
        if (!upstream.IsSuccessStatusCode)
            return (upstream.StatusCode, upstream.Content.Headers.ContentType?.ToString() ?? "text/plain", string.Empty);

        var sourceUrl = MpvWasmUrlCodec.DecodeUrl(encodedUrl);
        var manifest = await ReadManifestAsync(upstream, conf.maxManifestBytes, cancellationToken);
        var rewritten = RewriteManifest(manifest, new Uri(sourceUrl), encodedHeaders);
        return (upstream.StatusCode, "application/vnd.apple.mpegurl; charset=utf-8", rewritten);
    }

    public static string RewriteManifest(string manifest, Uri manifestUri, string encodedHeaders = "")
    {
        if (string.IsNullOrEmpty(manifest))
            return string.Empty;

        var normalized = manifest.Replace("\r\n", "\n").Replace('\r', '\n');
        var lines = normalized.Split('\n');
        var result = new StringBuilder(manifest.Length + 256);

        foreach (var line in lines)
        {
            if (line.StartsWith("#EXT-X-KEY:", StringComparison.OrdinalIgnoreCase) ||
                line.StartsWith("#EXT-X-MAP:", StringComparison.OrdinalIgnoreCase) ||
                line.StartsWith("#EXT-X-MEDIA:", StringComparison.OrdinalIgnoreCase))
            {
                result.AppendLine(RewriteUriAttributes(line, manifestUri, encodedHeaders));
                continue;
            }

            if (line.StartsWith("#") || string.IsNullOrWhiteSpace(line))
            {
                result.AppendLine(line);
                continue;
            }

            result.AppendLine(RewriteMediaUri(line.Trim(), manifestUri, encodedHeaders));
        }

        return result.ToString();
    }

    static async Task<string> ReadManifestAsync(HttpResponseMessage response, long maxBytes, CancellationToken cancellationToken)
    {
        maxBytes = Math.Max(1024, maxBytes <= 0 ? 5 * 1024 * 1024 : maxBytes);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var memory = new MemoryStream();
        var buffer = new byte[16 * 1024];

        while (true)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
            if (read <= 0)
                break;

            if (memory.Length + read > maxBytes)
                throw new InvalidOperationException("HLS manifest exceeds configured maxManifestBytes");

            memory.Write(buffer, 0, read);
        }

        return Encoding.UTF8.GetString(memory.ToArray());
    }

    static string RewriteUriAttributes(string line, Uri manifestUri, string encodedHeaders)
    {
        return Regex.Replace(line, "URI=(\"(?<quoted>[^\"]+)\"|(?<plain>[^,\\s]+))", match =>
        {
            var raw = match.Groups["quoted"].Success ? match.Groups["quoted"].Value : match.Groups["plain"].Value;
            var rewritten = RewriteMediaUri(raw, manifestUri, encodedHeaders);
            return "URI=\"" + rewritten.Replace("\"", "%22") + "\"";
        }, RegexOptions.IgnoreCase);
    }

    static string RewriteMediaUri(string raw, Uri manifestUri, string encodedHeaders)
    {
        if (string.IsNullOrWhiteSpace(raw) || IsAlreadyMpvWasm(raw))
            return raw;

        if (!Uri.TryCreate(manifestUri, raw, out var absolute))
            return raw;

        if (!absolute.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            !absolute.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            return raw;

        var route = LooksLikeHls(absolute, raw) ? "/mpvwasm/hls" : "/mpvwasm/proxy";
        var rewritten = route + "?u=" + Uri.EscapeDataString(MpvWasmUrlCodec.EncodeUrl(absolute.ToString()));
        if (!string.IsNullOrWhiteSpace(encodedHeaders))
            rewritten += "&h=" + Uri.EscapeDataString(encodedHeaders);

        return rewritten;
    }

    static bool IsAlreadyMpvWasm(string value) =>
        value.StartsWith("/mpvwasm/proxy", StringComparison.OrdinalIgnoreCase) ||
        value.StartsWith("/mpvwasm/hls", StringComparison.OrdinalIgnoreCase) ||
        value.Contains("/mpvwasm/proxy?u=", StringComparison.OrdinalIgnoreCase) ||
        value.Contains("/mpvwasm/hls?u=", StringComparison.OrdinalIgnoreCase);

    static bool LooksLikeHls(Uri absolute, string raw)
    {
        return absolute.AbsolutePath.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase) ||
               raw.Contains(".m3u8", StringComparison.OrdinalIgnoreCase);
    }
}
