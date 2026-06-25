using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Web;

namespace Lampac.Modules.VKMusic;

public sealed class MusicTrack
{
    public int index { get; init; }
    public string id { get; init; } = string.Empty;
    public string owner_id { get; init; } = string.Empty;
    public string access_key { get; init; } = string.Empty;
    public string title { get; init; } = string.Empty;
    public string artist { get; set; } = string.Empty;
    public string duration { get; init; } = string.Empty;
    public long durationMs { get; init; }
    public string url { get; init; } = string.Empty;
    public string preview { get; init; } = string.Empty;
    public string source { get; init; } = "vkmusic";
    public string query { get; init; } = string.Empty;
}

public sealed class MusicAlbum
{
    public string source { get; init; } = "vkmusic";
    public string id { get; init; } = string.Empty;
    public string title { get; init; } = string.Empty;
    public string artist { get; set; } = string.Empty;
    public string year { get; init; } = string.Empty;
    public string type { get; init; } = string.Empty;
    public string url { get; init; } = string.Empty;
    public string preview { get; set; } = string.Empty;
    public string description { get; init; } = string.Empty;
    public List<MusicTrack> tracks { get; } = new();
}

public sealed record MusicRowSpec(string Title, string Id, string Query);

[Route("vkmusic")]
[AllowAnonymous]
public sealed class VKMusicController : Controller
{
    const string VkApi = "https://api.vk.com/method";
    const string VkAuth = "https://oauth.vk.com/authorize";
    const string LampaSource = "lampac_vk_music";
    const int DefaultLimit = 30;

    static readonly HttpClient Http = CreateHttpClient();

    static readonly Dictionary<string, string> VkhostApps = new(StringComparer.OrdinalIgnoreCase)
    {
        ["vk_android"] = "2274003",
        ["vk_iphone"] = "3140623",
        ["vk_ipad"] = "3682744",
        ["kate_mobile"] = "2685278",
        ["windows_phone"] = "3502557"
    };

    static readonly Dictionary<string, int> ScopeBits = new(StringComparer.OrdinalIgnoreCase)
    {
        ["notify"] = 0,
        ["friends"] = 1,
        ["photos"] = 2,
        ["audio"] = 3,
        ["video"] = 4,
        ["stories"] = 6,
        ["pages"] = 7,
        ["status"] = 10,
        ["notes"] = 11,
        ["messages"] = 12,
        ["wall"] = 13,
        ["ads"] = 15,
        ["offline"] = 16,
        ["docs"] = 17,
        ["groups"] = 18,
        ["notifications"] = 19,
        ["stats"] = 20,
        ["email"] = 22,
        ["market"] = 27
    };

    static string TokenFile => Path.Combine(AppContext.BaseDirectory, "database", "vkmusic", "token.txt");
    static string ManageKeyFile => Path.Combine(AppContext.BaseDirectory, "database", "vkmusic", "manage_key.txt");
    static string ClientIdFile => Path.Combine(AppContext.BaseDirectory, "database", "vkmusic", "client_id.txt");
    static string AuthModeFile => Path.Combine(AppContext.BaseDirectory, "database", "vkmusic", "auth_mode.txt");
    static string RedirectUriFile => Path.Combine(AppContext.BaseDirectory, "database", "vkmusic", "redirect_uri.txt");
    static string ApiVersion => Env("VK_API_VERSION", "5.199");
    static string ClientId => Setting("VK_CLIENT_ID", ClientIdFile, "2274003");

    [HttpGet("search")]
    public async Task<IActionResult> Search(string query = "", int limit = DefaultLimit, int offset = 0)
    {
        var tracks = await SearchVkMusicAsync(query, limit).ConfigureAwait(false);
        return Json(tracks.Select(track => ToAlbum(track, "search")).ToList());
    }

    [HttpGet("catalog")]
    public async Task<IActionResult> Catalog(string query = "", int page = 1, int limit = DefaultLimit)
    {
        page = Math.Max(page, 1);
        limit = Math.Clamp(limit, 1, 60);

        var searchQuery = string.IsNullOrWhiteSpace(query) ? "популярная музыка" : query;
        var tracks = await SearchVkMusicAsync(searchQuery, limit).ConfigureAwait(false);
        var cards = tracks.Select(track => ToLampaCard(ToAlbum(track, "catalog:" + searchQuery))).ToList();
        var hasMore = cards.Count >= limit && !string.IsNullOrWhiteSpace(query);

        return Json(new
        {
            url = "vk-music",
            title = string.IsNullOrWhiteSpace(query) ? "ВК Музыка" : "ВК Музыка: " + query,
            source = LampaSource,
            page,
            pages = hasMore ? 999999 : page,
            total_pages = hasMore ? 999999 : page,
            total_results = hasMore ? 999999 * limit : ((page - 1) * limit + cards.Count),
            more = hasMore,
            next = hasMore ? page + 1 : 0,
            nomore = !hasMore,
            results = cards
        });
    }

    [HttpGet("home")]
    public async Task<IActionResult> Home(int limit = 20)
    {
        limit = Math.Clamp(limit, 6, 30);
        var specs = new[]
        {
            new MusicRowSpec("ВК: популярное", "popular", "популярная музыка"),
            new MusicRowSpec("Русская музыка", "ru", "русская музыка"),
            new MusicRowSpec("Поп", "pop", "поп музыка"),
            new MusicRowSpec("Рок", "rock", "рок"),
            new MusicRowSpec("Хип-хоп", "hip-hop", "хип-хоп"),
            new MusicRowSpec("Электроника", "electronic", "электронная музыка")
        };

        var rows = new List<object>();
        foreach (var spec in specs)
        {
            var tracks = await SearchVkMusicAsync(spec.Query, limit).ConfigureAwait(false);
            var cards = tracks.Select(track => ToLampaCard(ToAlbum(track, "home:" + spec.Id))).ToList();
            if (cards.Count > 0)
                rows.Add(BuildRow(spec.Title, "vk-" + spec.Id, cards, 1, false));
        }

        return Json(rows);
    }

    [HttpGet("full")]
    public IActionResult Full(string id, string title = "", string artist = "", string year = "", string preview = "", string source = "", string track_url = "", string duration = "")
    {
        var album = BuildVkAlbum(id, title, artist, year, preview, track_url, duration);
        return Json(new { movie = ToLampaCard(album) });
    }

    [HttpGet("album")]
    public IActionResult Album(string id, string title = "", string artist = "", string year = "", string preview = "", string source = "", string track_url = "", string duration = "")
    {
        return Json(BuildVkAlbum(id, title, artist, year, preview, track_url, duration));
    }

    [HttpGet("vk/search")]
    public async Task<IActionResult> VkSearch(string query = "", int limit = 10)
    {
        return Json(await SearchVkMusicAsync(query, limit).ConfigureAwait(false));
    }

    [HttpGet("resolve")]
    public async Task<IActionResult> Resolve(string query = "", string artist = "", string title = "", string url = "")
    {
        if (!string.IsNullOrWhiteSpace(url))
        {
            return Json(new Dictionary<string, object>
            {
                ["found"] = true,
                ["track"] = new MusicTrack { index = 1, title = title, artist = artist, url = url, source = "vkmusic", query = query }
            });
        }

        var clean = CleanQuery(string.Join(" ", new[] { artist, title, query }.Where(v => !string.IsNullOrWhiteSpace(v))));
        var tracks = await SearchVkMusicAsync(clean, 8).ConfigureAwait(false);
        var best = PickBestTrack(tracks, artist, title, clean);

        return Json(new Dictionary<string, object?>
        {
            ["found"] = best != null,
            ["track"] = best
        });
    }

    [HttpGet("vk/stream")]
    public async Task<IActionResult> VkStream(string url)
    {
        var stream = await ResolveVkStreamUrlAsync(url).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(stream))
            return NotFound("VK did not return a stream or preview URL for this token");

        return await ProxyAudio(stream, GetRefererForUrl(stream)).ConfigureAwait(false);
    }

    [HttpGet("audio")]
    public Task<IActionResult> Audio(string url) => ProxyAudio(url, GetRefererForUrl(url));

    [HttpGet("img")]
    public async Task<IActionResult> Img(string url)
    {
        if (string.IsNullOrWhiteSpace(url) || !IsHttpUrl(url))
            return BadRequest("url is required");

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Referrer = new Uri(GetRefererForUrl(url));

            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, HttpContext.RequestAborted).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                return NotFound();

            var bytes = await response.Content.ReadAsByteArrayAsync(HttpContext.RequestAborted).ConfigureAwait(false);
            Response.Headers["Cache-Control"] = "public, max-age=604800";
            return File(bytes, response.Content.Headers.ContentType?.MediaType ?? "image/jpeg");
        }
        catch
        {
            return NotFound();
        }
    }

    [HttpGet("vk/auth/apps")]
    public IActionResult AuthApps() => Json(VkhostApps);

    [HttpGet("setup")]
    public IActionResult Setup(string manage_key = "")
    {
        var canManage = CanManage(manage_key);
        return Content(BuildSetupPage(manage_key, canManage), "text/html; charset=utf-8");
    }

    [HttpGet("vk/auth/url")]
    public IActionResult AuthUrl(string app = "vk_android", string client_id = "", string scopes = "audio,offline", string redirect_uri = "", string auto = "", string manage_key = "")
    {
        var configuredClientId = ClientId;
        if (string.IsNullOrWhiteSpace(configuredClientId))
            configuredClientId = "2274003";
        var resolvedClientId = !string.IsNullOrWhiteSpace(client_id)
            ? client_id
            : !string.Equals(configuredClientId, "2274003", StringComparison.Ordinal)
                ? configuredClientId
                : VkhostApps.TryGetValue(app, out var knownClientId) ? knownClientId : configuredClientId;

        var callbackRequested = auto == "1" || CallbackModeEnabled();
        var sharedVkhostClient = IsSharedVkhostClient(resolvedClientId);
        var useCallback = callbackRequested && !sharedVkhostClient && CanManage(manage_key);
        var resolvedRedirectUri = !string.IsNullOrWhiteSpace(redirect_uri)
            ? redirect_uri
            : useCallback
                ? CallbackUrl(manage_key)
                : "https://oauth.vk.com/blank.html";

        var query = HttpUtility.ParseQueryString("");
        query["client_id"] = resolvedClientId;
        query["scope"] = ScopeMask(scopes).ToString(CultureInfo.InvariantCulture);
        query["redirect_uri"] = resolvedRedirectUri;
        query["display"] = "page";
        query["response_type"] = "token";
        query["revoke"] = "1";
        var callbackState = useCallback ? CallbackState(manage_key) : "";
        if (!string.IsNullOrWhiteSpace(callbackState))
            query["state"] = callbackState;

        return Json(new
        {
            url = VkAuth + "?" + query,
            client_id = resolvedClientId,
            scopes,
            redirect_uri = resolvedRedirectUri,
            state = callbackState,
            auth_mode = useCallback ? "callback" : "blank",
            callback_requested = callbackRequested,
            callback_available = !sharedVkhostClient,
            shared_client = sharedVkhostClient,
            note = useCallback
                ? "VK will redirect back to Lampac and save the token automatically."
                : sharedVkhostClient
                    ? "Shared vkhost/mobile client_id cannot use a custom Lampac redirect_uri; VK requires oauth.vk.com/blank.html."
                    : "Callback mode is disabled or manage key is missing."
        });
    }

    [HttpGet("vk/auth/callback")]
    public IActionResult AuthCallback(string manage_key = "")
    {
        return Content(BuildCallbackPage(manage_key), "text/html; charset=utf-8");
    }

    [HttpGet("vk/auth/save")]
    [HttpPost("vk/auth/save")]
    public IActionResult AuthSave(string redirect_url = "", string access_token = "", string manage_key = "")
    {
        if (!CanManage(manage_key))
            return Unauthorized(new { error = "Set VK_MUSIC_MANAGE_KEY on the server and pass it as manage_key." });

        var parsed = string.IsNullOrWhiteSpace(access_token)
            ? ParseVkRedirect(redirect_url)
            : new Dictionary<string, string> { ["access_token"] = access_token };

        var token = parsed.GetValueOrDefault("access_token") ?? "";
        if (string.IsNullOrWhiteSpace(token))
            return BadRequest(new { error = "access_token is required" });

        SaveToken(token);
        return Json(new
        {
            saved = true,
            access_token = MaskToken(token),
            user_id = parsed.GetValueOrDefault("user_id") ?? "",
            expires_in = parsed.GetValueOrDefault("expires_in") ?? ""
        });
    }

    [HttpGet("vk/auth/status")]
    public async Task<IActionResult> AuthStatus()
    {
        var token = AccessToken();
        if (string.IsNullOrWhiteSpace(token))
            return Json(new { token = false, status = "missing", source = "", user = (object?)null });

        object? user = null;
        try
        {
            var response = await VkApiAsync("users.get", new Dictionary<string, string>()).ConfigureAwait(false);
            user = response is JsonArray arr && arr.Count > 0 ? arr[0] : response;
        }
        catch
        {
            user = null;
        }

        return Json(new
        {
            token = true,
            status = "connected",
            source = !string.IsNullOrWhiteSpace(Env("VK_ACCESS_TOKEN", "")) ? "env" : "file",
            access_token = MaskToken(token),
            user
        });
    }

    async Task<List<MusicTrack>> SearchVkMusicAsync(string query, int limit)
    {
        limit = Math.Clamp(limit, 1, 60);
        var clean = CleanQuery(query);
        if (string.IsNullOrWhiteSpace(clean))
            return new List<MusicTrack>();

        try
        {
            var response = await VkApiAsync("audio.search", new Dictionary<string, string>
            {
                ["q"] = clean,
                ["count"] = limit.ToString(CultureInfo.InvariantCulture),
                ["auto_complete"] = "1",
                ["search_own"] = "0"
            }).ConfigureAwait(false);

            return Items(response)
                .Select((item, index) => TrackFromVkJson(item, index + 1, clean))
                .Where(track => !string.IsNullOrWhiteSpace(track.title))
                .ToList();
        }
        catch
        {
            return new List<MusicTrack>();
        }
    }

    async Task<string> ResolveVkStreamUrlAsync(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return "";

        if (IsHttpUrl(value))
            return value;

        var trackId = StripVkTrackScheme(value);
        if (string.IsNullOrWhiteSpace(trackId))
            return "";

        try
        {
            var response = await VkApiAsync("audio.getById", new Dictionary<string, string>
            {
                ["audios"] = trackId
            }).ConfigureAwait(false);

            var item = Items(response).FirstOrDefault();
            var direct = FirstText(item?["url"], item?["stream_url"], item?["direct_url"]);
            if (IsHttpUrl(direct))
                return direct;
        }
        catch
        {
        }

        foreach (var parameters in PreviewParamCandidates(trackId))
        {
            try
            {
                var response = await VkApiAsync("audio.getAudioPreviewUrl", parameters).ConfigureAwait(false);
                var direct = response is JsonValue ? Text(response) : FirstText(response?["url"], response?["audio_preview_url"], response?["stream_url"]);
                if (IsHttpUrl(direct))
                    return direct;
            }
            catch
            {
            }
        }

        return "";
    }

    async Task<JsonNode?> VkApiAsync(string method, Dictionary<string, string> parameters)
    {
        var token = AccessToken();
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("VK_ACCESS_TOKEN is not configured");

        var payload = new Dictionary<string, string>(parameters)
        {
            ["access_token"] = token,
            ["v"] = ApiVersion
        };

        using var content = new FormUrlEncodedContent(payload);
        using var response = await Http.PostAsync($"{VkApi}/{method}", content, HttpContext.RequestAborted).ConfigureAwait(false);
        var body = await response.Content.ReadAsStringAsync(HttpContext.RequestAborted).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(body);
        var error = json?["error"];
        if (error != null)
            throw new InvalidOperationException(Text(error["error_msg"], "VK API error"));

        return json?["response"];
    }

    async Task<IActionResult> ProxyAudio(string url, string referer)
    {
        if (string.IsNullOrWhiteSpace(url) || !IsHttpUrl(url))
            return BadRequest("url is required");

        HttpResponseMessage response;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Referrer = new Uri(referer);

            if (Request.Headers.TryGetValue("Range", out var range))
                request.Headers.TryAddWithoutValidation("Range", range.ToString());

            response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, HttpContext.RequestAborted).ConfigureAwait(false);
        }
        catch
        {
            return StatusCode(502);
        }

        using (response)
        {
            Response.StatusCode = (int)response.StatusCode;
            Response.ContentType = response.Content.Headers.ContentType?.MediaType ?? "audio/mpeg";

            CopyHeader(response.Content.Headers.ContentLength, "Content-Length");
            CopyHeader(response.Content.Headers.ContentRange?.ToString(), "Content-Range");
            CopyHeader(response.Headers.AcceptRanges.FirstOrDefault(), "Accept-Ranges");

            await using var stream = await response.Content.ReadAsStreamAsync(HttpContext.RequestAborted).ConfigureAwait(false);
            await stream.CopyToAsync(Response.Body, HttpContext.RequestAborted).ConfigureAwait(false);
            return new EmptyResult();
        }
    }

    static MusicTrack TrackFromVkJson(JsonObject item, int index, string query)
    {
        var id = Text(item["id"]);
        var ownerId = Text(item["owner_id"]);
        var accessKey = Text(item["access_key"]);
        var fullId = FullTrackId(ownerId, id, accessKey);
        var durationSeconds = Int(item["duration"]);
        var directUrl = FirstText(item["url"], item["stream_url"], item["direct_url"]);

        return new MusicTrack
        {
            index = index,
            id = fullId,
            owner_id = ownerId,
            access_key = accessKey,
            title = Text(item["title"], "Трек"),
            artist = Text(item["artist"], "VK"),
            duration = FormatSeconds(durationSeconds),
            durationMs = durationSeconds * 1000L,
            url = IsHttpUrl(directUrl) ? directUrl : "vkmusic://" + fullId,
            preview = VkCover(item),
            source = "vkmusic",
            query = query
        };
    }

    static MusicAlbum ToAlbum(MusicTrack track, string group)
    {
        var title = string.IsNullOrWhiteSpace(track.title) ? "Трек" : track.title;
        var artist = string.IsNullOrWhiteSpace(track.artist) ? "VK" : track.artist;
        var album = new MusicAlbum
        {
            source = "vkmusic",
            id = "vk-" + StableId(group + ":" + track.id + ":" + track.url + ":" + artist + ":" + title),
            title = title,
            artist = artist,
            year = DateTime.UtcNow.Year.ToString(CultureInfo.InvariantCulture),
            type = "Track",
            url = track.url,
            preview = track.preview,
            description = artist + " - " + title
        };

        album.tracks.Add(track);
        return album;
    }

    static MusicAlbum BuildVkAlbum(string id, string title, string artist, string year, string preview, string trackUrl, string duration)
    {
        title = string.IsNullOrWhiteSpace(title) ? "Трек" : title;
        artist = string.IsNullOrWhiteSpace(artist) ? "VK" : artist;

        var album = new MusicAlbum
        {
            source = "vkmusic",
            id = string.IsNullOrWhiteSpace(id) ? "vk-" + StableId(trackUrl + ":" + artist + ":" + title) : id,
            title = title,
            artist = artist,
            year = string.IsNullOrWhiteSpace(year) ? DateTime.UtcNow.Year.ToString(CultureInfo.InvariantCulture) : year,
            type = "Track",
            url = trackUrl,
            preview = preview,
            description = artist + " - " + title
        };

        if (!string.IsNullOrWhiteSpace(trackUrl))
        {
            album.tracks.Add(new MusicTrack
            {
                index = 1,
                title = title,
                artist = artist,
                duration = duration,
                url = trackUrl,
                preview = preview,
                source = "vkmusic",
                query = artist + " " + title
            });
        }

        return album;
    }

    static object ToLampaCard(MusicAlbum album)
    {
        var title = string.IsNullOrWhiteSpace(album.title) ? "Трек" : album.title;
        var artist = string.IsNullOrWhiteSpace(album.artist) ? title : album.artist;
        var year = string.IsNullOrWhiteSpace(album.year) ? DateTime.UtcNow.Year.ToString(CultureInfo.InvariantCulture) : album.year;
        var img = string.IsNullOrWhiteSpace(album.preview) ? "./img/img_broken.svg" : album.preview;
        var id = StableId("music:" + album.id + ":" + title + ":" + artist);
        var firstTrack = album.tracks.FirstOrDefault();

        return new
        {
            id,
            title,
            name = title,
            original_title = artist,
            original_name = artist,
            overview = album.description,
            description = album.description,
            poster_path = "",
            backdrop_path = "",
            background_image = img,
            img,
            poster = img,
            production_countries = Array.Empty<object>(),
            origin_country = Array.Empty<object>(),
            spoken_languages = Array.Empty<object>(),
            production_companies = Array.Empty<object>(),
            countries = Array.Empty<object>(),
            genre_ids = Array.Empty<object>(),
            seasons = Array.Empty<object>(),
            runtime = 0,
            vote_count = 0,
            popularity = 0,
            budget = 0,
            revenue = 0,
            tagline = album.type,
            status = "",
            homepage = album.url,
            adult = false,
            number_of_episodes = 0,
            number_of_seasons = 0,
            vote_average = 0,
            release_date = year + "-01-01",
            first_air_date = "",
            original_language = "music",
            media_type = "movie",
            type = "movie",
            source = LampaSource,
            method = "movie",
            genres = new[] { new { id = StableId("artist:" + artist), name = artist } },
            music_id = album.id,
            music_source = album.source,
            music_title = title,
            music_artist = artist,
            music_year = album.year,
            music_type = album.type,
            music_preview = album.preview,
            music_url = album.url,
            music_track_url = firstTrack?.url ?? "",
            music_duration = firstTrack?.duration ?? "",
            music_album = album
        };
    }

    static object BuildRow(string title, string url, IEnumerable<object> cards, int page, bool hasMore)
    {
        var results = cards.ToList();
        return new
        {
            url,
            title,
            source = LampaSource,
            page,
            pages = hasMore ? 999999 : page,
            total_pages = hasMore ? 999999 : page,
            total_results = hasMore ? 999999 : results.Count,
            more = hasMore,
            next = hasMore ? page + 1 : 0,
            nomore = !hasMore,
            results
        };
    }

    static IEnumerable<JsonObject> Items(JsonNode? response)
    {
        if (response is JsonArray array)
            return array.OfType<JsonObject>();

        if (response?["items"] is JsonArray items)
            return items.OfType<JsonObject>();

        if (response?["audios"]?["items"] is JsonArray audioItems)
            return audioItems.OfType<JsonObject>();

        if (response?["audios"] is JsonArray audios)
            return audios.OfType<JsonObject>();

        return Enumerable.Empty<JsonObject>();
    }

    static List<Dictionary<string, string>> PreviewParamCandidates(string trackId)
    {
        var result = new List<Dictionary<string, string>>
        {
            new() { ["audio"] = trackId }
        };

        var parts = trackId.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2)
        {
            result.Add(new Dictionary<string, string> { ["owner_id"] = parts[0], ["audio_id"] = parts[1] });
            result.Add(new Dictionary<string, string> { ["audio_id"] = parts[1] });
        }

        return result;
    }

    static string VkCover(JsonObject item)
    {
        return ProxyImg(FirstText(
            item["album"]?["thumb"]?["photo_1200"],
            item["album"]?["thumb"]?["photo_600"],
            item["album"]?["thumb"]?["photo_300"],
            item["album"]?["thumb"]?["photo_270"],
            item["album"]?["thumb"]?["photo_135"],
            item["cover_url"]));
    }

    static string ProxyImg(string absoluteUrl)
    {
        if (string.IsNullOrWhiteSpace(absoluteUrl))
            return "";

        return "/vkmusic/img?url=" + HttpUtility.UrlEncode(absoluteUrl);
    }

    static HttpClient CreateHttpClient()
    {
        var handler = new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            UseProxy = false
        };

        var client = new HttpClient(handler);
        client.Timeout = TimeSpan.FromSeconds(25);
        client.DefaultRequestHeaders.UserAgent.ParseAdd(Env("VK_MUSIC_USER_AGENT", "VKMusicLampac/0.1"));
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json,text/html,*/*");
        client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("ru-RU,ru;q=0.9,en;q=0.8");
        return client;
    }

    void CopyHeader(object? value, string name)
    {
        if (value == null)
            return;

        Response.Headers[name] = value.ToString();
    }

    static MusicTrack? PickBestTrack(List<MusicTrack> tracks, string artist, string title, string query)
    {
        if (tracks == null || tracks.Count == 0)
            return null;

        var targetArtist = NormalizeMusicText(artist);
        var targetTitle = NormalizeMusicText(title);
        var targetQuery = NormalizeMusicText(query);

        if (string.IsNullOrWhiteSpace(targetTitle) && !string.IsNullOrWhiteSpace(targetQuery))
            targetTitle = targetQuery;

        return tracks
            .Select(track => new { track, score = MatchTrackScore(track, targetArtist, targetTitle, targetQuery) })
            .Where(item => item.score >= 110)
            .OrderByDescending(item => item.score)
            .ThenBy(item => item.track.index)
            .FirstOrDefault()?.track;
    }

    static int MatchTrackScore(MusicTrack track, string targetArtist, string targetTitle, string targetQuery)
    {
        var score = 0;
        var artist = NormalizeMusicText(track.artist);
        var title = NormalizeMusicText(track.title);
        var joined = (artist + " " + title).Trim();

        if (!string.IsNullOrWhiteSpace(targetArtist) && artist.Contains(targetArtist, StringComparison.OrdinalIgnoreCase))
            score += 70;
        if (!string.IsNullOrWhiteSpace(targetTitle) && title.Contains(targetTitle, StringComparison.OrdinalIgnoreCase))
            score += 90;
        if (!string.IsNullOrWhiteSpace(targetQuery) && joined.Contains(targetQuery, StringComparison.OrdinalIgnoreCase))
            score += 60;

        return score;
    }

    static Dictionary<string, string> ParseVkRedirect(string redirectUrl)
    {
        if (!Uri.TryCreate(redirectUrl, UriKind.Absolute, out var uri))
            return new Dictionary<string, string>();

        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in HttpUtility.ParseQueryString(uri.Query).AllKeys.Where(k => k != null))
            result[key!] = HttpUtility.ParseQueryString(uri.Query)[key] ?? "";

        var fragment = uri.Fragment.StartsWith("#", StringComparison.Ordinal) ? uri.Fragment[1..] : uri.Fragment;
        foreach (var key in HttpUtility.ParseQueryString(fragment).AllKeys.Where(k => k != null))
            result[key!] = HttpUtility.ParseQueryString(fragment)[key] ?? "";

        return result;
    }

    static long ScopeMask(string scopes)
    {
        long mask = 0;
        foreach (var rawScope in (scopes ?? "").Replace(" ", ",").Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var scope = rawScope.Trim();
            if (long.TryParse(scope, out var numeric))
            {
                mask |= numeric;
                continue;
            }

            if (ScopeBits.TryGetValue(scope, out var bit))
                mask |= 1L << bit;
        }

        return mask == 0 ? (1L << ScopeBits["audio"]) | (1L << ScopeBits["offline"]) : mask;
    }

    static bool CanManage(string manageKey)
    {
        if (!HasAccessToken())
            return true;

        var expected = ManageKey();
        return !string.IsNullOrWhiteSpace(expected) && manageKey == expected;
    }

    static bool HasAccessToken() => !string.IsNullOrWhiteSpace(AccessToken());

    static string ManageKey()
    {
        var env = Env("VK_MUSIC_MANAGE_KEY", "");
        if (!string.IsNullOrWhiteSpace(env))
            return env;

        try
        {
            if (System.IO.File.Exists(ManageKeyFile))
                return System.IO.File.ReadAllText(ManageKeyFile).Trim();

            var key = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            var dir = Path.GetDirectoryName(ManageKeyFile);
            if (!string.IsNullOrWhiteSpace(dir))
                Directory.CreateDirectory(dir);

            System.IO.File.WriteAllText(ManageKeyFile, key);
            return key;
        }
        catch
        {
            return "";
        }
    }

    static string AccessToken()
    {
        var env = Env("VK_ACCESS_TOKEN", "");
        if (!string.IsNullOrWhiteSpace(env))
            return env;

        try
        {
            return System.IO.File.Exists(TokenFile) ? System.IO.File.ReadAllText(TokenFile).Trim() : "";
        }
        catch
        {
            return "";
        }
    }

    static void SaveToken(string token)
    {
        var dir = Path.GetDirectoryName(TokenFile);
        if (!string.IsNullOrWhiteSpace(dir))
            Directory.CreateDirectory(dir);

        System.IO.File.WriteAllText(TokenFile, token);
    }

    static string MaskToken(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
            return "";

        return token.Length <= 12 ? "***" : token[..6] + "..." + token[^6..];
    }

    static string StripVkTrackScheme(string value)
    {
        value = (value ?? "").Trim();
        if (value.StartsWith("vkmusic://", StringComparison.OrdinalIgnoreCase))
            value = value["vkmusic://".Length..];

        return value;
    }

    static string FullTrackId(string ownerId, string id, string accessKey)
    {
        if (string.IsNullOrWhiteSpace(ownerId) || string.IsNullOrWhiteSpace(id))
            return id;

        return string.IsNullOrWhiteSpace(accessKey) ? $"{ownerId}_{id}" : $"{ownerId}_{id}_{accessKey}";
    }

    static string CleanQuery(string value)
    {
        value = (value ?? "").Trim();
        foreach (var ch in new[] { '[', ']', '{', '}', '(', ')', '*', '+', '?', '^', '$', '|', '!', ':', '"' })
            value = value.Replace(ch, ' ');

        return string.Join(' ', value.Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    static string NormalizeMusicText(string value)
    {
        value = WebUtility.HtmlDecode(value ?? "").ToLowerInvariant();
        value = RegexReplace(value, @"\s+", " ");
        return value.Trim();
    }

    static string RegexReplace(string value, string pattern, string replacement)
    {
        return System.Text.RegularExpressions.Regex.Replace(value ?? "", pattern, replacement, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    static string Text(JsonNode? node, string fallback = "")
    {
        if (node == null)
            return fallback;

        try
        {
            if (node is JsonValue value)
            {
                if (value.TryGetValue<string>(out var text))
                    return text?.Trim() ?? fallback;
                if (value.TryGetValue<int>(out var intValue))
                    return intValue.ToString(CultureInfo.InvariantCulture);
                if (value.TryGetValue<long>(out var longValue))
                    return longValue.ToString(CultureInfo.InvariantCulture);
            }

            var rendered = node.ToString().Trim();
            return string.IsNullOrWhiteSpace(rendered) ? fallback : rendered.Trim('"');
        }
        catch
        {
            return fallback;
        }
    }

    static int Int(JsonNode? node)
    {
        if (node == null)
            return 0;

        if (int.TryParse(Text(node), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
            return value;

        return 0;
    }

    static string FirstText(params JsonNode?[] values)
    {
        foreach (var value in values)
        {
            var text = Text(value);
            if (!string.IsNullOrWhiteSpace(text))
                return text;
        }

        return "";
    }

    static string FormatSeconds(int seconds)
    {
        if (seconds <= 0)
            return "";

        var span = TimeSpan.FromSeconds(seconds);
        return span.TotalHours >= 1 ? span.ToString(@"h\:mm\:ss") : span.ToString(@"m\:ss");
    }

    static string StableId(string value)
    {
        unchecked
        {
            var hash = 2166136261u;
            foreach (var ch in value ?? "")
            {
                hash ^= ch;
                hash *= 16777619;
            }

            return hash.ToString(CultureInfo.InvariantCulture);
        }
    }

    static bool IsHttpUrl(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && (uri.Scheme == "http" || uri.Scheme == "https");

    static string GetRefererForUrl(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return uri.GetLeftPart(UriPartial.Authority) + "/";

        return "https://vk.com/";
    }

    static string Env(string name, string fallback) => Environment.GetEnvironmentVariable(name) ?? fallback;

    static bool EnvFlag(string name)
    {
        var value = Env(name, "").Trim();
        return value == "1"
            || value.Equals("true", StringComparison.OrdinalIgnoreCase)
            || value.Equals("yes", StringComparison.OrdinalIgnoreCase)
            || value.Equals("on", StringComparison.OrdinalIgnoreCase);
    }

    static bool CallbackModeEnabled()
    {
        return Setting("VK_MUSIC_AUTH_MODE", AuthModeFile, "").Equals("callback", StringComparison.OrdinalIgnoreCase)
            || EnvFlag("VK_MUSIC_CALLBACK");
    }

    static bool IsSharedVkhostClient(string clientId)
    {
        return VkhostApps.Values.Any(value => string.Equals(value, clientId, StringComparison.Ordinal));
    }

    static string Setting(string envName, string file, string fallback)
    {
        var env = Env(envName, "");
        if (!string.IsNullOrWhiteSpace(env))
            return env.Trim();

        try
        {
            if (System.IO.File.Exists(file))
            {
                var value = System.IO.File.ReadAllText(file).Trim();
                if (!string.IsNullOrWhiteSpace(value))
                    return value;
            }
        }
        catch
        {
        }

        return fallback;
    }

    string PublicBaseUrl()
    {
        var proto = Request.Headers.TryGetValue("X-Forwarded-Proto", out var forwardedProto)
            ? forwardedProto.FirstOrDefault()
            : Request.Scheme;

        var host = Request.Headers.TryGetValue("X-Forwarded-Host", out var forwardedHost)
            ? forwardedHost.FirstOrDefault()
            : Request.Host.Value;

        if (string.IsNullOrWhiteSpace(proto))
            proto = "http";

        return $"{proto}://{host}".TrimEnd('/');
    }

    string CallbackUrl(string manageKey)
    {
        var configured = Setting("VK_MUSIC_REDIRECT_URI", RedirectUriFile, "");
        if (IsHttpUrl(configured))
            return configured;

        return PublicBaseUrl() + "/vkmusic-callback.html";
    }

    string CallbackState(string manageKey)
    {
        var query = HttpUtility.ParseQueryString("");
        foreach (var key in new[] { "uid", "account_email", "profile_id" })
        {
            var value = Request.Query[key].ToString();
            if (!string.IsNullOrWhiteSpace(value))
                query[key] = value;
        }

        if (!string.IsNullOrWhiteSpace(manageKey))
            query["manage_key"] = manageKey;

        return query.ToString() ?? "";
    }

#if false
    static string BuildSetupPage(string manageKey, bool canManage)
    {
        var safeKey = WebUtility.HtmlEncode(manageKey ?? "");

        if (!canManage)
        {
            return $$"""
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ВК Музыка - настройка</title>
  <style>
    body{margin:0;font-family:Arial,sans-serif;background:#111827;color:#e5e7eb}
    main{max-width:760px;margin:0 auto;padding:32px 18px}
    h1{font-size:28px;margin:0 0 14px}
    p{color:#aeb7c5;line-height:1.5}
    form{display:flex;gap:10px;margin-top:22px}
    input{flex:1;padding:13px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#fff}
    button{padding:13px 18px;border:0;border-radius:8px;background:#4f8cff;color:white;font-weight:700;cursor:pointer}
    code{background:#0b1220;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <main>
    <h1>ВК Музыка</h1>
    <p>Введите setup key для настройки токена. Ключ лежит на сервере в <code>database/vkmusic/manage_key.txt</code> или задаётся переменной <code>VK_MUSIC_MANAGE_KEY</code>.</p>
    <form method="get" action="/vkmusic/setup">
      <input name="manage_key" type="password" autocomplete="off" placeholder="manage_key">
      <button type="submit">Открыть настройку</button>
    </form>
  </main>
</body>
</html>
""";
        }

        return $$"""
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ВК Музыка - настройка</title>
  <style>
    body{margin:0;font-family:Arial,sans-serif;background:#0f172a;color:#e5e7eb}
    main{max-width:980px;margin:0 auto;padding:28px 18px 42px}
    h1{font-size:30px;margin:0 0 8px}
    h2{font-size:18px;margin:28px 0 12px}
    p{color:#aeb7c5;line-height:1.5}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .box{border:1px solid #263244;background:#111827;border-radius:8px;padding:16px}
    button,a.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px;border:0;border-radius:8px;background:#4f8cff;color:#fff;font-weight:700;text-decoration:none;cursor:pointer}
    button.secondary{background:#263244}
    input,textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#fff}
    textarea{min-height:112px;resize:vertical}
    label{display:block;margin:12px 0 6px;color:#cbd5e1}
    pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;border:1px solid #263244;border-radius:8px;padding:12px;color:#cbd5e1}
    code{background:#0b1220;padding:2px 6px;border-radius:6px}
    .ok{color:#86efac}.bad{color:#fca5a5}
    @media(max-width:760px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main>
    <h1>ВК Музыка</h1>
        <p>Здесь настраивается токен для отдельного Lampac-модуля <code>VKMusicPlugin</code>. Пароль VK сюда не вводится: вход идёт на странице VK OAuth, а callback сам сохранит токен.</p>

    <div class="grid">
      <section class="box">
        <h2>1. Авторизация VK</h2>
        <p>Нажмите кнопку и подтвердите доступ. После возврата с VK токен сохранится автоматически.</p>
        <button id="open-auth" type="button">Войти через VK и сохранить токен</button>
        <pre id="auth-url"></pre>
      </section>

      <section class="box">
        <h2>Ручной fallback</h2>
        <p>Используйте только если VK не принимает автоматический redirect на Lampac.</p>
        <input id="manage-key" type="hidden" value="{{safeKey}}">
        <label for="redirect-url">Redirect URL от VK</label>
        <textarea id="redirect-url" placeholder="https://oauth.vk.com/blank.html#access_token=..."></textarea>
        <label for="access-token">Или access_token напрямую</label>
        <input id="access-token" autocomplete="off" placeholder="необязательно">
        <p><button id="save-token" type="button">Сохранить токен</button></p>
        <pre id="save-result"></pre>
      </section>
    </div>

    <section class="box">
      <h2>Статус и тест</h2>
      <p>
        <button id="check-status" class="secondary" type="button">Проверить токен</button>
      </p>
      <pre id="status"></pre>
      <label for="query">Тестовый поиск</label>
      <input id="query" value="Daft Punk">
      <p><button id="test-search" class="secondary" type="button">Искать через /vkmusic/catalog</button></p>
      <pre id="search-result"></pre>
    </section>

    <p>После сохранения токена ищите музыку в Lampa через пункт меню <b>ВК Музыка</b> или через общий поиск, где появился отдельный источник <b>ВК Музыка</b>.</p>
  </main>
  <script>
    const key = document.getElementById('manage-key').value;
    const pretty = value => JSON.stringify(value, null, 2);

    async function json(url, options) {
      const response = await fetch(url, options || {});
      const text = await response.text();
      try { return JSON.parse(text); } catch (e) { return { status: response.status, body: text }; }
    }

    async function loadAuthUrl(openWindow) {
      const data = await json('/vkmusic/vk/auth/url?auto=1&manage_key=' + encodeURIComponent(key));
      document.getElementById('auth-url').textContent = data.url || pretty(data);
      if (openWindow && data.url) window.open(data.url, '_blank', 'noopener,noreferrer');
    }

    async function checkStatus() {
      const data = await json('/vkmusic/vk/auth/status');
      document.getElementById('status').textContent = pretty(data);
    }

    document.getElementById('open-auth').onclick = () => loadAuthUrl(true);
    document.getElementById('check-status').onclick = checkStatus;

    document.getElementById('save-token').onclick = async () => {
      const form = new FormData();
      form.set('manage_key', key);
      form.set('redirect_url', document.getElementById('redirect-url').value.trim());
      form.set('access_token', document.getElementById('access-token').value.trim());
      const data = await json('/vkmusic/vk/auth/save', { method: 'POST', body: form });
      document.getElementById('save-result').textContent = pretty(data);
      await checkStatus();
    };

    document.getElementById('test-search').onclick = async () => {
      const q = encodeURIComponent(document.getElementById('query').value.trim() || 'Daft Punk');
      const data = await json('/vkmusic/catalog?query=' + q + '&limit=5');
      document.getElementById('search-result').textContent = pretty(data);
    };

    loadAuthUrl(false);
    checkStatus();
  </script>
</body>
</html>
""";
    }

    static string BuildCallbackPage(string manageKey)
    {
        var safeKey = WebUtility.HtmlEncode(manageKey ?? "");
        return $$"""
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ВК Музыка - сохранение токена</title>
  <style>
    body{margin:0;font-family:Arial,sans-serif;background:#0f172a;color:#e5e7eb}
    main{max-width:760px;margin:0 auto;padding:32px 18px}
    h1{font-size:28px;margin:0 0 14px}
    p{color:#aeb7c5;line-height:1.5}
    pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;border:1px solid #263244;border-radius:8px;padding:12px;color:#cbd5e1}
    a.button{display:inline-flex;padding:12px 16px;border-radius:8px;background:#4f8cff;color:#fff;font-weight:700;text-decoration:none}
    .ok{color:#86efac}.bad{color:#fca5a5}
  </style>
</head>
<body>
  <main>
    <h1>ВК Музыка</h1>
    <p id="message">Сохраняю токен...</p>
    <pre id="result"></pre>
    <p><a class="button" href="/vkmusic/setup?manage_key={{safeKey}}">Вернуться к настройке</a></p>
  </main>
  <script>
    const manageKey = new URLSearchParams(location.search).get('manage_key') || '{{safeKey}}';
    const result = document.getElementById('result');
    const message = document.getElementById('message');

    function pretty(value) {
      return JSON.stringify(value, null, 2);
    }

    async function save() {
      const hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
      const token = hash.get('access_token');
      const error = hash.get('error');
      const errorDescription = hash.get('error_description');

      if (error) {
        message.className = 'bad';
        message.textContent = 'VK вернул ошибку авторизации.';
        result.textContent = errorDescription || error;
        return;
      }

      if (!token) {
        message.className = 'bad';
        message.textContent = 'access_token не найден в callback URL.';
        result.textContent = location.href;
        return;
      }

      const form = new FormData();
      form.set('manage_key', manageKey);
      form.set('access_token', token);

      const response = await fetch('/vkmusic/vk/auth/save', { method: 'POST', body: form });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = { status: response.status, body: text }; }

      if (response.ok && data.saved) {
        message.className = 'ok';
        message.textContent = 'Токен сохранён. Теперь ВК Музыка должна искать каталог в Lampa.';
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        message.className = 'bad';
        message.textContent = 'Не удалось сохранить токен.';
      }

      result.textContent = pretty(data);
    }

    save();
  </script>
</body>
</html>
""";
    }
#endif

    static string BuildSetupPage(string manageKey, bool canManage)
    {
        var safeKey = WebUtility.HtmlEncode(manageKey ?? "");

        if (!canManage)
        {
            return string.Join("\n", new[]
            {
                "<!doctype html>",
                "<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
                "<title>VK Music setup</title>",
                "<style>body{font-family:Arial,sans-serif;background:#111827;color:#e5e7eb;margin:0}main{max-width:760px;margin:0 auto;padding:32px 18px}input{width:100%;box-sizing:border-box;padding:12px;background:#0b1220;color:#fff;border:1px solid #374151;border-radius:8px}button{margin-top:12px;padding:12px 16px;border:0;border-radius:8px;background:#4f8cff;color:#fff;font-weight:700}</style>",
                "</head><body><main>",
                "<h1>VK Music setup</h1>",
                "<p>Token is already configured. Enter setup key to change it.</p>",
                "<form method='get' action='/vkmusic/setup'>",
                "<input name='manage_key' type='password' autocomplete='off' placeholder='manage_key'>",
                "<button type='submit'>Open setup</button>",
                "</form>",
                "</main></body></html>"
            });
        }

        return string.Join("\n", new[]
        {
            "<!doctype html>",
            "<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
            "<title>VK Music setup</title>",
            "<style>body{font-family:Arial,sans-serif;background:#0f172a;color:#e5e7eb;margin:0}main{max-width:960px;margin:0 auto;padding:28px 18px}section{border:1px solid #263244;background:#111827;border-radius:8px;padding:16px;margin:14px 0}button,a.button{display:inline-flex;padding:12px 16px;border:0;border-radius:8px;background:#4f8cff;color:#fff;font-weight:700;text-decoration:none;cursor:pointer}button.secondary{background:#263244}input,textarea{width:100%;box-sizing:border-box;padding:12px;background:#0b1220;color:#fff;border:1px solid #374151;border-radius:8px}textarea{min-height:90px}pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;border:1px solid #263244;border-radius:8px;padding:12px}.ok{color:#86efac}.bad{color:#fca5a5}</style>",
            "</head><body><main>",
            "<h1>VK Music setup</h1>",
            "<p>Press the button, authorize VK, and the callback will save the token automatically. VK password is entered only on VK OAuth page.</p>",
            "<input id='manage-key' type='hidden' value='" + safeKey + "'>",
            "<section><h2>1. Automatic VK authorization</h2>",
            "<button id='open-auth' type='button'>Login with VK and save token</button>",
            "<pre id='auth-url'></pre></section>",
            "<section><h2>Status and test search</h2>",
            "<button id='check-status' class='secondary' type='button'>Check token</button>",
            "<pre id='status'></pre>",
            "<input id='query' value='Daft Punk'>",
            "<p><button id='test-search' class='secondary' type='button'>Search VK Music</button></p>",
            "<pre id='search-result'></pre></section>",
            "<section><h2>Fallback</h2>",
            "<p>Use this only if VK rejects automatic redirect.</p>",
            "<textarea id='redirect-url' placeholder='https://oauth.vk.com/blank.html#access_token=...'></textarea>",
            "<p><input id='access-token' autocomplete='off' placeholder='access_token directly'></p>",
            "<button id='save-token' type='button'>Save token manually</button>",
            "<pre id='save-result'></pre></section>",
            "<script>",
            "const key=document.getElementById('manage-key').value;",
            "const pretty=v=>JSON.stringify(v,null,2);",
            "async function json(url,opt){const r=await fetch(url,opt||{});const t=await r.text();try{return JSON.parse(t)}catch(e){return{status:r.status,body:t}}}",
            "async function loadAuthUrl(openWindow){const d=await json('/vkmusic/vk/auth/url?auto=1&manage_key='+encodeURIComponent(key));document.getElementById('auth-url').textContent=d.url||pretty(d);if(openWindow&&d.url)location.href=d.url}",
            "async function checkStatus(){document.getElementById('status').textContent=pretty(await json('/vkmusic/vk/auth/status'))}",
            "document.getElementById('open-auth').onclick=()=>loadAuthUrl(true);",
            "document.getElementById('check-status').onclick=checkStatus;",
            "document.getElementById('save-token').onclick=async()=>{const f=new FormData();f.set('manage_key',key);f.set('redirect_url',document.getElementById('redirect-url').value.trim());f.set('access_token',document.getElementById('access-token').value.trim());const d=await json('/vkmusic/vk/auth/save',{method:'POST',body:f});document.getElementById('save-result').textContent=pretty(d);await checkStatus()};",
            "document.getElementById('test-search').onclick=async()=>{const q=encodeURIComponent(document.getElementById('query').value.trim()||'Daft Punk');document.getElementById('search-result').textContent=pretty(await json('/vkmusic/catalog?query='+q+'&limit=5'))};",
            "loadAuthUrl(false);checkStatus();",
            "</script>",
            "</main></body></html>"
        });
    }

    static string BuildCallbackPage(string manageKey)
    {
        var safeKey = WebUtility.HtmlEncode(manageKey ?? "");
        return string.Join("\n", new[]
        {
            "<!doctype html>",
            "<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
            "<title>VK Music token callback</title>",
            "<style>body{font-family:Arial,sans-serif;background:#0f172a;color:#e5e7eb;margin:0}main{max-width:760px;margin:0 auto;padding:32px 18px}pre{white-space:pre-wrap;word-break:break-word;background:#0b1220;border:1px solid #263244;border-radius:8px;padding:12px}.ok{color:#86efac}.bad{color:#fca5a5}a.button{display:inline-flex;padding:12px 16px;border-radius:8px;background:#4f8cff;color:#fff;font-weight:700;text-decoration:none}</style>",
            "</head><body><main>",
            "<h1>VK Music</h1>",
            "<p id='message'>Saving token...</p>",
            "<pre id='result'></pre>",
            "<p><a class='button' href='/vkmusic/setup?manage_key=" + safeKey + "'>Back to setup</a></p>",
            "<script>",
            "const manageKey=new URLSearchParams(location.search).get('manage_key')||'" + safeKey + "';",
            "const result=document.getElementById('result');const message=document.getElementById('message');",
            "const pretty=v=>JSON.stringify(v,null,2);",
            "async function save(){const h=new URLSearchParams((location.hash||'').replace(/^#/,''));const token=h.get('access_token');const error=h.get('error');if(error){message.className='bad';message.textContent='VK authorization error';result.textContent=h.get('error_description')||error;return}if(!token){message.className='bad';message.textContent='access_token was not found in callback URL';result.textContent=location.href;return}const f=new FormData();f.set('manage_key',manageKey);f.set('access_token',token);const r=await fetch('/vkmusic/vk/auth/save',{method:'POST',body:f});const t=await r.text();let d;try{d=JSON.parse(t)}catch(e){d={status:r.status,body:t}}if(r.ok&&d.saved){message.className='ok';message.textContent='Token saved. VK Music is ready for search in Lampa.';history.replaceState(null,'',location.pathname+location.search)}else{message.className='bad';message.textContent='Could not save token'}result.textContent=pretty(d)}",
            "save();",
            "</script>",
            "</main></body></html>"
        });
    }
}
