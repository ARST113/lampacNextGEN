using System;
using System.Linq;
using System.IO;
using Microsoft.AspNetCore.Http;
using Shared.Models.Base;
using Shared.Services;
using System.Security.Cryptography;
using System.Text;

namespace LampacSync.Shared;

/// <summary>Resolves a sync namespace without changing the authenticated playback account.</summary>
internal static class LampacSyncIdentity
{
    public static string ReadScript(string modulePath)
    {
        string packaged = Path.Combine(modulePath, "sync-account.js");
        string path = File.Exists(packaged) ? packaged : Path.Combine(modulePath, "../Shared/sync-account.js");
        return FileCache.ReadAllText(path, "sync-account.js");
    }

    public static string Resolve(RequestModel requestInfo, HttpContext context)
    {
        if (string.IsNullOrEmpty(requestInfo?.user_uid))
            return null;

        if (!context.Request.Query.TryGetValue("sync_id", out var values))
            return requestInfo.user_uid;

        if (values.Count != 1)
            return null;

        string id = values[0]?.Trim();
        if (string.IsNullOrEmpty(id) || id.Length > 128 || id.Any(char.IsControl))
            return null;

        // Basic IDs and their passwords keep the existing history namespace,
        // including when another device enters that same value manually.
        if (string.Equals(id, requestInfo.user_uid, StringComparison.OrdinalIgnoreCase))
            return requestInfo.user_uid;
        var existing = global::Shared.CoreInit.conf?.accsdb?.findUser(id);
        if (!string.IsNullOrEmpty(existing?.id))
            return existing.id;

        // The code is a capability shared by its holders, independent of their logins.
        // Never put the plain code in a filesystem path or a socket registration.
        return "lampac-sync-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant();
    }
}
