using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Serilog;
using Shared;
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace DddSync;

[AllowAnonymous]
public class DddSyncController : BaseController
{
    const string ModuleName = "ddd-sync";
    const int Schema = 1;
    const int MaxBodyBytes = 256 * 1024;
    const int MaxEvents = 100;
    const int DefaultLimit = 200;
    const int MaxLimit = 1000;

    static readonly ILogger Log = Serilog.Log.ForContext<DddSyncController>();
    static readonly HashSet<string> AllowedTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "session_started",
        "position_tick",
        "playback_state_changed",
        "seek_completed",
        "playlist_item_changed",
        "playback_ended",
        "session_finished",
        "error",
        "track_selection_changed",
        "user_action"
    };

    [HttpOptions]
    [Route("/ddd-sync/v1/{*path}")]
    public IActionResult Options()
    {
        return JsonOk(new JObject { ["ok"] = true });
    }

    [HttpGet]
    [Route("/ddd-sync/v1/ping")]
    public IActionResult Ping()
    {
        return JsonOk(new JObject
        {
            ["ok"] = true,
            ["module"] = ModuleName,
            ["schema"] = Schema,
            ["serverTime"] = NowMs()
        });
    }

    [HttpPost]
    [Route("/ddd-sync/v1/events")]
    public async Task<IActionResult> Events()
    {
        string body;
        try
        {
            body = await ReadBodyLimitedAsync().ConfigureAwait(false);
        }
        catch (InvalidOperationException ex)
        {
            Log.Warning("[DddSync] rejected invalid payload: {Reason}", ex.Message);
            return JsonError(400, ex.Message);
        }

        JObject root;
        try
        {
            root = JObject.Parse(body);
        }
        catch (Exception ex)
        {
            Log.Warning("[DddSync] rejected invalid payload: invalid JSON");
            return JsonError(400, "invalid JSON: " + ex.Message);
        }

        var validation = ValidatePayload(root);
        if (validation != null)
        {
            Log.Warning("[DddSync] rejected invalid payload: {Reason}", validation);
            return JsonError(400, validation);
        }

        var deviceId = root.Value<string>("deviceId").Trim();
        var events = (JArray)root["events"];
        var accepted = DddSyncStore.ApplyEvents(deviceId, events);

        return JsonOk(new JObject
        {
            ["ok"] = true,
            ["accepted"] = accepted,
            ["serverTime"] = NowMs()
        });
    }

    [HttpGet]
    [Route("/ddd-sync/v1/latest")]
    public IActionResult Latest()
    {
        var since = ReadLongQuery("since", 0);
        var limit = Math.Clamp(ReadIntQuery("limit", DefaultLimit), 1, MaxLimit);
        var deviceId = Request.Query.TryGetValue("deviceId", out var d) ? d.ToString().Trim() : null;

        if (!string.IsNullOrWhiteSpace(deviceId) && deviceId.Length > 256)
            return JsonError(400, "deviceId is too long");

        var items = DddSyncStore.Latest(since, limit, deviceId);
        return JsonOk(new JObject
        {
            ["ok"] = true,
            ["cursor"] = NowMs(),
            ["items"] = items
        });
    }

    [HttpGet]
    [Route("/ddd-sync/v1/client.js")]
    public IActionResult ClientJs()
    {
        AddCors();
        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
        var path = Path.Combine(ModInit.modpath, "client.js");
        var js = System.IO.File.ReadAllText(path, Encoding.UTF8);
        return Content(js, "application/javascript; charset=utf-8");
    }

    async Task<string> ReadBodyLimitedAsync()
    {
        if (Request.ContentLength.HasValue && Request.ContentLength.Value > MaxBodyBytes)
            throw new InvalidOperationException("request body is too large");

        using var ms = new MemoryStream();
        var buffer = new byte[8192];

        while (true)
        {
            var read = await Request.Body.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
            if (read <= 0)
                break;

            ms.Write(buffer, 0, read);
            if (ms.Length > MaxBodyBytes)
                throw new InvalidOperationException("request body is too large");
        }

        return Encoding.UTF8.GetString(ms.ToArray());
    }

    string ValidatePayload(JObject root)
    {
        if (root.Value<int?>("schema") is int schema && schema != Schema)
            return "unsupported schema";

        var deviceId = root.Value<string>("deviceId");
        if (string.IsNullOrWhiteSpace(deviceId))
            return "deviceId is required";
        if (deviceId.Trim().Length > 256)
            return "deviceId is too long";

        if (root["events"] is not JArray events)
            return "events array is required";
        if (events.Count > MaxEvents)
            return "too many events";
        if (events.Count == 0)
            return "events array is empty";

        for (var i = 0; i < events.Count; i++)
        {
            if (events[i] is not JObject ev)
                return $"events[{i}] must be object";

            if (ev.Value<int?>("schema") is int eventSchema && eventSchema != Schema)
                return $"events[{i}].schema is unsupported";

            var type = ev.Value<string>("type");
            if (string.IsNullOrWhiteSpace(type))
                return $"events[{i}].type is required";
            if (!AllowedTypes.Contains(type.Trim()))
                return $"events[{i}].type is not supported";

            if (TooLong(ev.Value<string>("deviceId"), 256)) return $"events[{i}].deviceId is too long";
            if (TooLong(ev.Value<string>("sessionId"), 256)) return $"events[{i}].sessionId is too long";
            if (TooLong(ev.Value<string>("client"), 256)) return $"events[{i}].client is too long";

            if (ev["context"] is JObject context)
            {
                if (TooLong(context.Value<string>("contentKey"), 256)) return $"events[{i}].context.contentKey is too long";
                if (TooLong(context.Value<string>("sourceKey"), 256)) return $"events[{i}].context.sourceKey is too long";
                if (TooLong(context.Value<string>("timelineHash"), 256)) return $"events[{i}].context.timelineHash is too long";
                if (TooLong(context.Value<string>("sourceKind"), 256)) return $"events[{i}].context.sourceKind is too long";
                if (TooLong(context.Value<string>("uri"), 4096)) return $"events[{i}].context.uri is too long";
                if (TooLong(context.Value<string>("title"), 512)) return $"events[{i}].context.title is too long";
                if (TooLong(context.Value<string>("filename"), 512)) return $"events[{i}].context.filename is too long";

                var hasKey = !string.IsNullOrWhiteSpace(context.Value<string>("contentKey")) ||
                             !string.IsNullOrWhiteSpace(context.Value<string>("sourceKey")) ||
                             !string.IsNullOrWhiteSpace(context.Value<string>("uri"));
                if (!hasKey)
                    return $"events[{i}].context.contentKey or sourceKey is required";
            }
            else
            {
                return $"events[{i}].context is required";
            }

            if (ev["payload"] is JObject payload)
            {
                if (TooLong(payload.Value<string>("reason"), 256)) return $"events[{i}].payload.reason is too long";
                if (TooLong(payload.Value<string>("endBy"), 256)) return $"events[{i}].payload.endBy is too long";
                if (TooLong(payload.Value<string>("error"), 512)) return $"events[{i}].payload.error is too long";
                if (TooLong(payload.Value<string>("message"), 512)) return $"events[{i}].payload.message is too long";
                if (TooLong(payload.Value<string>("selectedAudioTrack"), 256)) return $"events[{i}].payload.selectedAudioTrack is too long";
                if (TooLong(payload.Value<string>("selectedSubtitleTrack"), 256)) return $"events[{i}].payload.selectedSubtitleTrack is too long";
            }
        }

        return null;
    }

    IActionResult JsonOk(JObject obj) => JsonResult(200, obj);

    IActionResult JsonError(int status, string error)
    {
        return JsonResult(status, new JObject
        {
            ["ok"] = false,
            ["error"] = error,
            ["serverTime"] = NowMs()
        });
    }

    IActionResult JsonResult(int status, JObject obj)
    {
        AddCors();
        return new ContentResult
        {
            StatusCode = status,
            ContentType = "application/json; charset=utf-8",
            Content = obj.ToString(Formatting.None)
        };
    }

    void AddCors()
    {
        Response.Headers["Access-Control-Allow-Origin"] = "*";
        Response.Headers["Access-Control-Allow-Headers"] = "Content-Type";
        Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }

    long ReadLongQuery(string name, long fallback)
    {
        if (Request.Query.TryGetValue(name, out var value) && long.TryParse(value.ToString(), out var parsed))
            return Math.Max(0, parsed);
        return fallback;
    }

    int ReadIntQuery(string name, int fallback)
    {
        if (Request.Query.TryGetValue(name, out var value) && int.TryParse(value.ToString(), out var parsed))
            return parsed;
        return fallback;
    }

    static bool TooLong(string value, int max) => !string.IsNullOrEmpty(value) && value.Length > max;

    static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}
