using System;
using System.Text;

namespace MpvWasm;

public static class MpvWasmUrlCodec
{
    public static string EncodeUrl(string url)
    {
        if (!TryCreateHttpUri(url, out var uri, out var error))
            throw new ArgumentException(error, nameof(url));

        return EncodeString(uri.ToString());
    }

    public static string DecodeUrl(string encoded)
    {
        var value = DecodeString(encoded);
        if (!TryCreateHttpUri(value, out var uri, out var error))
            throw new ArgumentException(error, nameof(encoded));

        return uri.ToString();
    }

    public static string EncodeString(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
        return Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    public static string DecodeString(string encoded)
    {
        if (string.IsNullOrWhiteSpace(encoded))
            throw new ArgumentException("Empty base64url value");

        var value = encoded.Trim().Replace('-', '+').Replace('_', '/');
        var mod = value.Length % 4;
        if (mod == 1)
            throw new ArgumentException("Invalid base64url padding");
        if (mod > 0)
            value = value.PadRight(value.Length + (4 - mod), '=');

        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(value));
        }
        catch (FormatException ex)
        {
            throw new ArgumentException("Invalid base64url value", ex);
        }
    }

    public static bool TryCreateHttpUri(string url, out Uri uri, out string error)
    {
        uri = null!;
        error = string.Empty;

        if (string.IsNullOrWhiteSpace(url))
        {
            error = "URL is empty";
            return false;
        }

        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out uri))
        {
            error = "URL must be absolute";
            return false;
        }

        if (!uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            !uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            error = "Only http and https URLs are allowed";
            return false;
        }

        return true;
    }
}
