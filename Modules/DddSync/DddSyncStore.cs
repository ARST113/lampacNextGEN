using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Serilog;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace DddSync;

public static class DddSyncStore
{
    const int MaxItems = 2000;
    static readonly TimeSpan MaxAge = TimeSpan.FromDays(180);
    static readonly Encoding Utf8NoBom = new UTF8Encoding(false);
    static readonly object Sync = new();
    static readonly ILogger Log = Serilog.Log.ForContext(typeof(DddSyncStore));

    static string storePath;
    static Dictionary<string, JObject> items = new();
    static bool loaded;

    public static void Initialize(string path)
    {
        lock (Sync)
        {
            storePath = path;
            Directory.CreateDirectory(Path.GetDirectoryName(storePath) ?? ".");
            loaded = false;
            EnsureLoaded();
            CleanupLocked(NowMs());
            SaveLocked();
        }

        Log.Information("[DddSync] module initialized");
    }

    public static int ApplyEvents(string deviceId, JArray events)
    {
        var accepted = 0;
        var changed = false;
        var now = NowMs();

        lock (Sync)
        {
            EnsureLoaded();

            foreach (var token in events)
            {
                if (token is not JObject ev)
                    continue;

                var normalized = NormalizeEvent(deviceId, ev, now);
                if (normalized == null)
                    continue;

                accepted++;

                var key = normalized.Value.key;
                var eventTs = normalized.Value.ts;
                var record = normalized.Value.record;

                if (items.TryGetValue(key, out var current))
                {
                    var currentTs = current.Value<long?>("updatedAt") ?? 0;
                    if (eventTs < currentTs)
                        continue;

                    MergeRecord(current, record);
                    items[key] = current;
                }
                else
                {
                    items[key] = record;
                }

                changed = true;
                Log.Information("[DddSync] stored progress: deviceId={DeviceId} contentKey={ContentKey}",
                    Short(deviceId, 80), Short(record.Value<string>("contentKey") ?? record.Value<string>("sourceKey") ?? "", 120));
            }

            var removed = CleanupLocked(now);
            if (removed > 0)
                Log.Information("[DddSync] cleanup removed items: {Count}", removed);

            if (changed || removed > 0)
                SaveLocked();
        }

        Log.Information("[DddSync] accepted events: {Count}", accepted);
        return accepted;
    }

    public static JArray Latest(long since, int limit, string deviceId)
    {
        lock (Sync)
        {
            EnsureLoaded();

            var query = items.Values
                .Where(x => (x.Value<long?>("updatedAt") ?? 0) > since);

            if (!string.IsNullOrWhiteSpace(deviceId))
                query = query.Where(x => string.Equals(x.Value<string>("deviceId"), deviceId, StringComparison.Ordinal));

            var result = new JArray(query
                .OrderBy(x => x.Value<long?>("updatedAt") ?? 0)
                .Take(limit)
                .Select(ClonePublicRecord));

            Log.Information("[DddSync] returned latest items: {Count}", result.Count);
            return result;
        }
    }

    static (string key, long ts, JObject record)? NormalizeEvent(string rootDeviceId, JObject ev, long now)
    {
        var type = CleanString(ev.Value<string>("type"), 64);
        var sessionId = CleanString(ev.Value<string>("sessionId"), 256);
        var eventDeviceId = CleanString(ev.Value<string>("deviceId"), 256);
        var deviceId = string.IsNullOrWhiteSpace(eventDeviceId) ? rootDeviceId : eventDeviceId;
        var ts = ev.Value<long?>("ts") ?? now;

        var context = ev["context"] as JObject ?? new JObject();
        var payload = ev["payload"] as JObject ?? new JObject();

        var contentKey = CleanString(context.Value<string>("contentKey"), 256);
        var sourceKey = CleanString(context.Value<string>("sourceKey"), 256);
        if (string.IsNullOrWhiteSpace(contentKey) && string.IsNullOrWhiteSpace(sourceKey))
        {
            var uriForKey = CleanString(context.Value<string>("uri"), 4096);
            if (!string.IsNullOrWhiteSpace(uriForKey))
                sourceKey = "uri:" + Sha256(uriForKey);
        }

        if (string.IsNullOrWhiteSpace(deviceId) || (string.IsNullOrWhiteSpace(contentKey) && string.IsNullOrWhiteSpace(sourceKey)))
            return null;

        var record = new JObject
        {
            ["deviceId"] = deviceId,
            ["sessionId"] = sessionId,
            ["contentKey"] = contentKey,
            ["sourceKey"] = sourceKey,
            ["timelineHash"] = CleanString(context.Value<string>("timelineHash"), 256),
            ["sourceKind"] = CleanString(context.Value<string>("sourceKind"), 256),
            ["uri"] = CleanString(context.Value<string>("uri"), 4096),
            ["title"] = CleanString(context.Value<string>("title"), 512),
            ["filename"] = CleanString(context.Value<string>("filename"), 512),
            ["updatedAt"] = ts
        };

        CopyLong(payload, record, "position");
        CopyLong(payload, record, "duration");
        CopyInt(payload, record, "windowIndex");
        CopyInt(payload, record, "playlistSize");
        CopyBool(payload, record, "isPlaying");

        var reason = CleanString(payload.Value<string>("reason"), 256);
        if (string.IsNullOrWhiteSpace(reason))
            reason = type;
        record["reason"] = reason;

        if (type == "session_started")
        {
            record["finished"] = false;
            record["endBy"] = null;
        }
        else if (type == "playback_ended")
        {
            record["finished"] = true;
            record["endBy"] = "playback_ended";
        }
        else if (type == "session_finished")
        {
            record["endBy"] = CleanString(payload.Value<string>("endBy"), 256) ?? "session_finished";
            if (payload["finished"] != null)
                record["finished"] = ReadBool(payload["finished"]);
        }
        else if (payload["finished"] != null)
        {
            record["finished"] = ReadBool(payload["finished"]);
        }

        if (type == "error")
            record["lastError"] = CleanString(payload.Value<string>("error") ?? payload.Value<string>("message"), 512);

        if (type == "track_selection_changed")
        {
            var trackType = CleanString(payload.Value<string>("trackType"), 64);
            var isAudio = string.Equals(trackType, "audio", StringComparison.OrdinalIgnoreCase);
            var isSubtitle = string.Equals(trackType, "subtitle", StringComparison.OrdinalIgnoreCase);

            if (isAudio || string.IsNullOrWhiteSpace(trackType))
            {
                record["selectedAudioTrack"] = CleanString(payload.Value<string>("selectedAudioTrack") ?? payload.Value<string>("audioTrack") ?? payload.Value<string>("label"), 256);
                record["selectedAudioTrackId"] = CleanString(payload.Value<string>("selectedAudioTrackId") ?? payload.Value<string>("trackId"), 256);
                record["selectedAudioTrackLanguage"] = CleanString(payload.Value<string>("selectedAudioTrackLanguage") ?? payload.Value<string>("language"), 128);
                record["selectedAudioTrackMimeType"] = CleanString(payload.Value<string>("selectedAudioTrackMimeType") ?? payload.Value<string>("sampleMimeType"), 128);

                var selectedAudioTrackIndex = payload.Value<int?>("selectedAudioTrackIndex") ?? payload.Value<int?>("trackIndex");
                if (selectedAudioTrackIndex != null)
                    record["selectedAudioTrackIndex"] = Math.Max(0, selectedAudioTrackIndex.Value);

                var selectedAudioTrackChannels = payload.Value<int?>("selectedAudioTrackChannels") ?? payload.Value<int?>("channelCount");
                if (selectedAudioTrackChannels != null)
                    record["selectedAudioTrackChannels"] = Math.Max(0, selectedAudioTrackChannels.Value);
            }

            if (isSubtitle || string.IsNullOrWhiteSpace(trackType))
            {
                record["selectedSubtitleTrack"] = CleanString(payload.Value<string>("selectedSubtitleTrack") ?? payload.Value<string>("subtitleTrack") ?? payload.Value<string>("label"), 256);
                record["selectedSubtitleTrackId"] = CleanString(payload.Value<string>("selectedSubtitleTrackId") ?? payload.Value<string>("trackId"), 256);
                record["selectedSubtitleTrackLanguage"] = CleanString(payload.Value<string>("selectedSubtitleTrackLanguage") ?? payload.Value<string>("language"), 128);
                record["selectedSubtitleTrackMimeType"] = CleanString(payload.Value<string>("selectedSubtitleTrackMimeType") ?? payload.Value<string>("sampleMimeType"), 128);

                var selectedSubtitleTrackIndex = payload.Value<int?>("selectedSubtitleTrackIndex") ?? payload.Value<int?>("trackIndex");
                if (selectedSubtitleTrackIndex != null)
                    record["selectedSubtitleTrackIndex"] = Math.Max(0, selectedSubtitleTrackIndex.Value);
            }
        }

        var keyMaterial = !string.IsNullOrWhiteSpace(contentKey) ? contentKey : sourceKey;
        return (deviceId + "\0" + keyMaterial, ts, record);
    }

    static void MergeRecord(JObject target, JObject patch)
    {
        foreach (var prop in patch.Properties())
        {
            if (prop.Value.Type == JTokenType.Null)
                continue;

            if (prop.Value.Type == JTokenType.String && string.IsNullOrWhiteSpace(prop.Value.ToString()))
                continue;

            target[prop.Name] = prop.Value.DeepClone();
        }

        if (target["finished"] == null)
            target["finished"] = false;
    }

    static JObject ClonePublicRecord(JObject source)
    {
        var clone = new JObject();
        foreach (var name in new[]
        {
            "deviceId", "sessionId", "contentKey", "sourceKey", "timelineHash", "sourceKind", "uri",
            "title", "filename", "position", "duration", "windowIndex", "playlistSize", "isPlaying",
            "finished", "endBy", "reason", "updatedAt", "lastError", "selectedAudioTrack",
            "selectedAudioTrackId", "selectedAudioTrackIndex", "selectedAudioTrackLanguage",
            "selectedAudioTrackMimeType", "selectedAudioTrackChannels", "selectedSubtitleTrack",
            "selectedSubtitleTrackId", "selectedSubtitleTrackIndex", "selectedSubtitleTrackLanguage",
            "selectedSubtitleTrackMimeType"
        })
        {
            if (source.TryGetValue(name, out var value))
                clone[name] = value.DeepClone();
        }

        if (clone["finished"] == null)
            clone["finished"] = false;
        if (clone["endBy"] == null)
            clone["endBy"] = null;

        return clone;
    }

    static void EnsureLoaded()
    {
        if (loaded)
            return;

        items = new Dictionary<string, JObject>();
        loaded = true;

        if (string.IsNullOrWhiteSpace(storePath) || !File.Exists(storePath))
            return;

        try
        {
            var root = JObject.Parse(File.ReadAllText(storePath, Encoding.UTF8));
            var array = root["items"] as JArray ?? new JArray();
            foreach (var item in array.OfType<JObject>())
            {
                var deviceId = item.Value<string>("deviceId");
                var keyMaterial = item.Value<string>("contentKey") ?? item.Value<string>("sourceKey");
                if (string.IsNullOrWhiteSpace(deviceId) || string.IsNullOrWhiteSpace(keyMaterial))
                    continue;

                items[deviceId + "\0" + keyMaterial] = item;
            }
        }
        catch (Exception ex)
        {
            Log.Warning(ex, "[DddSync] rejected invalid payload: failed to read store");
            items = new Dictionary<string, JObject>();
        }
    }

    static int CleanupLocked(long now)
    {
        var minTs = now - (long)MaxAge.TotalMilliseconds;
        var remove = items
            .Where(kv => (kv.Value.Value<long?>("updatedAt") ?? 0) < minTs)
            .Select(kv => kv.Key)
            .ToList();

        foreach (var key in remove)
            items.Remove(key);

        if (items.Count <= MaxItems)
            return remove.Count;

        var overflow = items
            .OrderBy(kv => kv.Value.Value<long?>("updatedAt") ?? 0)
            .Take(items.Count - MaxItems)
            .Select(kv => kv.Key)
            .ToList();

        foreach (var key in overflow)
            items.Remove(key);

        return remove.Count + overflow.Count;
    }

    static void SaveLocked()
    {
        if (string.IsNullOrWhiteSpace(storePath))
            return;

        Directory.CreateDirectory(Path.GetDirectoryName(storePath) ?? ".");
        var tmp = storePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var root = new JObject
        {
            ["schema"] = 1,
            ["savedAt"] = NowMs(),
            ["items"] = new JArray(items.Values.OrderByDescending(x => x.Value<long?>("updatedAt") ?? 0).Select(ClonePublicRecord))
        };

        File.WriteAllText(tmp, root.ToString(Formatting.Indented), Utf8NoBom);
        File.Move(tmp, storePath, true);
    }

    static void CopyLong(JObject src, JObject dst, string name)
    {
        if (src[name] == null)
            return;

        var value = src.Value<long?>(name);
        if (value != null)
            dst[name] = Math.Max(0, value.Value);
    }

    static void CopyInt(JObject src, JObject dst, string name)
    {
        if (src[name] == null)
            return;

        var value = src.Value<int?>(name);
        if (value != null)
            dst[name] = Math.Max(0, value.Value);
    }

    static void CopyBool(JObject src, JObject dst, string name)
    {
        if (src[name] != null)
            dst[name] = ReadBool(src[name]);
    }

    static bool ReadBool(JToken token)
    {
        if (token.Type == JTokenType.Boolean)
            return token.Value<bool>();
        return string.Equals(token.ToString(), "true", StringComparison.OrdinalIgnoreCase) || token.ToString() == "1";
    }

    static string CleanString(string value, int max)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        value = value.Trim();
        return value.Length <= max ? value : value.Substring(0, max);
    }

    static string Short(string value, int max)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= max)
            return value;
        return value.Substring(0, max) + "...";
    }

    static string Sha256(string value)
    {
        using var sha = SHA256.Create();
        return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
    }

    static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
