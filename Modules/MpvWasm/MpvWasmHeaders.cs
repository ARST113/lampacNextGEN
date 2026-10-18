using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;

namespace MpvWasm;

public static class MpvWasmHeaders
{
    static readonly HashSet<string> BaseAllowedRequestHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "User-Agent",
        "Referer",
        "Origin",
        "Accept",
        "Accept-Language"
    };

    static readonly HashSet<string> HopByHopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection",
        "Keep-Alive",
        "Proxy-Authenticate",
        "Proxy-Authorization",
        "TE",
        "Trailer",
        "Transfer-Encoding",
        "Upgrade",
        "Host",
        "Content-Length"
    };

    static readonly string[] ForwardResponseHeaders =
    [
        "Content-Type",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "Last-Modified",
        "ETag",
        "Cache-Control",
        "Expires"
    ];

    public static Dictionary<string, string> DecodeOutboundHeaders(string encodedHeaders, ModuleConf conf)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(encodedHeaders))
            return result;

        var json = MpvWasmUrlCodec.DecodeString(encodedHeaders);
        Dictionary<string, string>? headers;
        try
        {
            headers = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
        }
        catch (JsonException ex)
        {
            throw new ArgumentException("Invalid encoded headers JSON", ex);
        }

        if (headers == null)
            return result;

        foreach (var pair in headers)
        {
            var name = pair.Key?.Trim();
            var value = pair.Value?.Trim();
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(value))
                continue;
            if (!IsAllowedOutboundHeader(name, conf))
                continue;
            if (name.Contains('\r') || name.Contains('\n') || value.Contains('\r') || value.Contains('\n'))
                continue;

            result[name] = value;
        }

        return result;
    }

    public static bool IsAllowedOutboundHeader(string name, ModuleConf conf)
    {
        if (string.IsNullOrWhiteSpace(name) || HopByHopHeaders.Contains(name))
            return false;
        if (name.StartsWith("Proxy-", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase))
            return false;
        if (BaseAllowedRequestHeaders.Contains(name))
            return true;
        if (name.Equals("Cookie", StringComparison.OrdinalIgnoreCase))
            return conf.allowCookieHeader;
        if (name.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
            return conf.allowAuthorizationHeader;

        return false;
    }

    public static void ApplyRequestHeaders(HttpRequestMessage message, IHeaderDictionary incoming, Dictionary<string, string> encodedHeaders)
    {
        foreach (var pair in encodedHeaders)
            message.Headers.TryAddWithoutValidation(pair.Key, pair.Value);

        if (incoming.TryGetValue("Range", out var range) && !string.IsNullOrWhiteSpace(range.FirstOrDefault()))
            message.Headers.TryAddWithoutValidation("Range", range.FirstOrDefault());
    }

    public static void CopyProxyResponseHeaders(HttpResponseMessage upstream, HttpResponse downstream, ModuleConf conf)
    {
        if (upstream.Content.Headers.ContentType != null)
            downstream.ContentType = upstream.Content.Headers.ContentType.ToString();

        if (upstream.Content.Headers.ContentLength.HasValue)
            downstream.ContentLength = upstream.Content.Headers.ContentLength.Value;

        foreach (var header in ForwardResponseHeaders)
        {
            if (header.Equals("Content-Type", StringComparison.OrdinalIgnoreCase) ||
                header.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                continue;

            if (upstream.Content.Headers.TryGetValues(header, out var contentValues))
                downstream.Headers[header] = contentValues.ToArray();
            else if (upstream.Headers.TryGetValues(header, out var values))
                downstream.Headers[header] = values.ToArray();
        }

        if (!downstream.Headers.ContainsKey("Accept-Ranges"))
            downstream.Headers["Accept-Ranges"] = "bytes";

        if (conf.exposeCors)
            ApplyCors(downstream);
    }

    public static void ApplyCors(HttpResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS";
        response.Headers["Access-Control-Allow-Headers"] = "Range, Content-Type, User-Agent, Referer, Origin, Accept, Accept-Language, Authorization, Cookie";
        response.Headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges, Last-Modified, ETag";
    }
}
