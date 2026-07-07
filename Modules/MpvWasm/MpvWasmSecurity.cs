using System;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace MpvWasm;

public static class MpvWasmSecurity
{
    static readonly string[] MetadataHosts =
    [
        "metadata.google.internal",
        "metadata",
        "169.254.169.254"
    ];

    public static async Task ValidateUriAsync(Uri uri, ModuleConf conf, CancellationToken cancellationToken)
    {
        if (uri == null)
            throw new InvalidOperationException("URL is empty");

        if (!uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            !uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Only http and https URLs are allowed");

        var host = NormalizeHost(uri.Host);
        if (MetadataHosts.Any(h => host.Equals(h, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Metadata endpoints are blocked");

        if (MatchesAny(host, conf.blockedHosts))
            throw new InvalidOperationException("Host is blocked by configuration");

        if (conf.allowedHosts != null && conf.allowedHosts.Length > 0 && !MatchesAny(host, conf.allowedHosts))
            throw new InvalidOperationException("Host is not allowed by configuration");

        if (conf.allowPrivateNetworks)
            return;

        if (IPAddress.TryParse(host, out var ip))
        {
            if (IsPrivateAddress(ip))
                throw new InvalidOperationException("Private network address is blocked");
            return;
        }

        IPAddress[] resolved;
        try
        {
            resolved = await Dns.GetHostAddressesAsync(host, cancellationToken);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException("Unable to resolve host for SSRF validation", ex);
        }

        if (resolved.Any(IsPrivateAddress))
            throw new InvalidOperationException("Host resolves to private network address");
    }

    public static bool IsPrivateAddress(IPAddress address)
    {
        if (IPAddress.IsLoopback(address))
            return true;

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] == 10 ||
                   b[0] == 127 ||
                   (b[0] == 100 && b[1] >= 64 && b[1] <= 127) ||
                   (b[0] == 169 && b[1] == 254) ||
                   (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
                   (b[0] == 192 && b[1] == 168);
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = address.GetAddressBytes();
            var uniqueLocal = b.Length > 0 && (b[0] & 0xfe) == 0xfc;

            return address.IsIPv6LinkLocal ||
                   address.IsIPv6SiteLocal ||
                   uniqueLocal ||
                   address.Equals(IPAddress.IPv6Loopback);
        }

        return false;
    }

    public static bool MatchesAny(string host, string[] patterns)
    {
        if (string.IsNullOrWhiteSpace(host) || patterns == null)
            return false;

        foreach (var raw in patterns)
        {
            var pattern = NormalizeHost(raw);
            if (string.IsNullOrWhiteSpace(pattern))
                continue;

            if (pattern == "*")
                return true;

            if (pattern.StartsWith("*.") && host.EndsWith(pattern[1..], StringComparison.OrdinalIgnoreCase))
                return true;

            if (host.Equals(pattern, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }

    static string NormalizeHost(string host)
    {
        host = (host ?? string.Empty).Trim().TrimEnd('.');
        return host.StartsWith("[") && host.EndsWith("]") ? host[1..^1] : host;
    }
}
