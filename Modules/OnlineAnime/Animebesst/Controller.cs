using Microsoft.AspNetCore.Mvc;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.PlaywrightCore;
using Shared.Services.HTTP;
using Shared.Services.RxEnumerate;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace Animebesst;

public class AnimebesstController : BaseOnlineController
{
    public AnimebesstController() : base(ModInit.conf) { }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/animebesst")]
    async public Task<ActionResult> Index(string title, string uri, short s, bool rjson = false, bool similar = false)
    {
        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

    rhubFallback:
        if (string.IsNullOrEmpty(uri))
        {
            if (string.IsNullOrWhiteSpace(title))
                return OnError();

            #region Поиск
            var cache = await InvokeCacheResult<List<(string title, string year, string uri, string s, string img)>>($"animebesst:search:{title}", TimeSpan.FromHours(4), async e =>
            {
                bool reqOk = false;
                int httpLen = -1;
                int pwLen = -1;
                bool httpCf = false;
                bool pwCf = false;
                List<(string title, string year, string uri, string s, string img)> catalog = null;

                void parseSearch(string search, bool playwright = false)
                {
                    if (playwright)
                    {
                        pwLen = search?.Length ?? -1;
                        pwCf = !string.IsNullOrEmpty(search) && IsCloudflareChallenge(search);
                    }
                    else
                    {
                        httpLen = search?.Length ?? -1;
                        httpCf = !string.IsNullOrEmpty(search) && IsCloudflareChallenge(search);
                    }

                    var parsed = ParseSearch(search);
                    reqOk = parsed.reqOk;
                    catalog = parsed.catalog;
                }

                string data = $"do=search&subaction=search&search_start=0&full_search=0&result_from=1&story={HttpUtility.UrlEncode(title)}";

                await httpHydra.PostSpan($"{init.host}/index.php?do=search", data, search => parseSearch(search.ToString()));

                if (catalog == null || catalog.Count == 0)
                {
                    string searchUrl = $"{init.host}/index.php?{data}";
                    string html = await FlareSolverrGet(searchUrl);
                    if (string.IsNullOrEmpty(html))
                        html = await PlaywrightHttp.Get(init, searchUrl);

                    parseSearch(html, playwright: true);
                }

                if ((catalog == null || catalog.Count == 0) && !reqOk)
                    return e.Fail("catalog", refresh_proxy: true);

                return e.Success(catalog ?? new List<(string title, string year, string uri, string s, string img)>());
            });

            if (IsRhubFallback(cache))
                goto rhubFallback;

            if (cache.Value != null && cache.Value.Count == 0)
                return OnError();

            if (!similar && cache.Value != null && cache.Value.Count == 1)
                return LocalRedirect(accsArgs($"/lite/animebesst?rjson={rjson}&title={HttpUtility.UrlEncode(title)}&uri={HttpUtility.UrlEncode(cache.Value[0].uri)}&s={cache.Value[0].s}"));

            return ContentTpl(cache, () =>
            {
                var stpl = new SimilarTpl(cache.Value.Count);

                foreach (var res in cache.Value)
                {
                    stpl.Append(
                        res.title,
                        res.year,
                        string.Empty,
                        $"{host}/lite/animebesst?title={HttpUtility.UrlEncode(title)}&uri={HttpUtility.UrlEncode(res.uri)}&s={res.s}",
                        PosterApi.Size(res.img)
                    );
                }

                return stpl;
            });
            #endregion
        }
        else
        {
            #region Серии
            var cache = await InvokeCacheResult<List<(string episode, string name, string uri)>>($"animebesst:playlist:{uri}", TimeSpan.FromHours(1), async e =>
            {
                var links = new List<(string episode, string name, string uri)>(5);

                void parsePlaylist(string news)
                {
                    foreach (var link in ParsePlaylist(news))
                        links.Add(link);
                }

                await httpHydra.GetSpan(uri, news => parsePlaylist(news.ToString()));

                if (links.Count == 0)
                {
                    string html = await FlareSolverrGet(uri);
                    if (string.IsNullOrEmpty(html))
                        html = await PlaywrightHttp.Get(init, uri);

                    parsePlaylist(html);
                }

                if (links.Count == 0)
                    return e.Fail("links", refresh_proxy: true);

                return e.Success(links);
            });

            if (IsRhubFallback(cache))
                goto rhubFallback;

            return ContentTpl(cache, () =>
            {
                var etpl = new EpisodeTpl(cache.Value.Count);

                foreach (var l in cache.Value)
                {
                    string name = string.IsNullOrEmpty(l.name) ? $"{l.episode} серия" : $"{l.episode} {l.name}";
                    string voice_name = !string.IsNullOrEmpty(l.name) ? Regex.Replace(l.name, "(^\\(|\\)$)", "") : "AnimeBesst";

                    string link = accsArgs($"{host}/lite/animebesst/video.m3u8?uri={HttpUtility.UrlEncode(l.uri)}&title={HttpUtility.UrlEncode(title)}");

                    etpl.Append(
                        name,
                        $"{title} / {name}",
                        s,
                        l.episode,
                        link,
                        "call",
                        streamlink: $"{link}&play=true",
                        voice_name: Regex.Unescape(voice_name)
                    );
                }

                return etpl;
            });
            #endregion
        }
    }

    #region Video
    [HttpGet, Staticache(manually: true)]
    [Route("lite/animebesst/video.m3u8")]
    async public Task<ActionResult> Video(string uri, string title, bool play)
    {
        if (await IsRequestBlocked(rch: false, rch_check: false))
            return badInitMsg;

    rhubFallback:
        var cache = await InvokeCacheResult<string>($"animebesst:video:{uri}", 30, async e =>
        {
            string hls = null;
            string iframeUrl = $"https://{uri}";

            void parseIframe(string iframe)
            {
                hls = Rx.Match(iframe, "file:\"(https?://[^\"]+\\.m3u8)\"");
            }

            await httpHydra.GetSpan(iframeUrl, addheaders: HeadersModel.Init("referer", init.host), spanAction: iframe => parseIframe(iframe.ToString()));

            if (string.IsNullOrEmpty(hls))
            {
                string html = await FlareSolverrGet(iframeUrl);
                if (string.IsNullOrEmpty(html))
                    html = await PlaywrightHttp.Get(init, iframeUrl);

                parseIframe(html);
            }

            if (string.IsNullOrEmpty(hls))
                return e.Fail("hls", refresh_proxy: true);

            return e.Success(hls);
        });

        if (IsRhubFallback(cache))
            goto rhubFallback;

        if (!cache.IsSuccess)
            return OnError(cache.ErrorMsg);

        string link = HostStreamProxy(cache.Value);

        if (play)
            return RedirectToPlay(link);

        return ContentTo(VideoTpl.ToJson(
            "play",
            link,
            title,
            vast: init.vast,
            httpContext: HttpContext
        ));
    }
    #endregion

    static (bool reqOk, List<(string title, string year, string uri, string s, string img)> catalog) ParseSearch(string search)
    {
        if (string.IsNullOrEmpty(search))
            return (false, null);

        bool reqOk = search.Contains(">Поиск по сайту<", StringComparison.OrdinalIgnoreCase) ||
                     search.Contains("shortstory-listab", StringComparison.OrdinalIgnoreCase);

        if (IsCloudflareChallenge(search))
            return (false, null);

        var sidebar = Rx.Split("id=\"sidebar\"", search);
        if (sidebar.Count == 0)
            return (reqOk, null);

        var rx = Rx.Split("class=\"shortstory-listab\"", sidebar[0].Span, 1);
        if (rx.Count == 0)
            return (reqOk, null);

        var catalog = new List<(string title, string year, string uri, string s, string img)>(rx.Count);

        foreach (var row in rx.Rows())
        {
            if (row.Contains("Новости"))
                continue;

            var g = row.Groups("class=\"shortstory-listab-title\"><a href=\"(https?://[^\"]+\\.html)\">([^<]+)</a>");

            if (!string.IsNullOrWhiteSpace(g[1].Value) && !string.IsNullOrWhiteSpace(g[2].Value))
            {
                string season = "0";
                if (g[2].Value.Contains("сезон"))
                {
                    season = Regex.Match(g[2].Value, "([0-9]+) сезон").Groups[1].Value;
                    if (string.IsNullOrEmpty(season))
                        season = "1";
                }

                catalog.Add((
                    g[2].Value,
                    row.Match("\">([0-9]{4})</a>"),
                    g[1].Value,
                    season,
                    row.Match("<img class=\"img-fit lozad\" data-src=\"([^\"]+)\"")
                ));
            }
        }

        return (reqOk, catalog);
    }

    static List<(string episode, string name, string uri)> ParsePlaylist(string news)
    {
        var links = new List<(string episode, string name, string uri)>(5);

        if (string.IsNullOrEmpty(news) || IsCloudflareChallenge(news))
            return links;

        string videoList = Rx.Match(news, "var videoList ?=([^\n\r]+)");
        if (videoList == null)
            return links;

        var match = Regex.Match(videoList, "\"id\":\"([0-9]+)( [^\"]+)?\",\"link\":\"(https?:)?\\\\/\\\\/([^\"]+)\"");
        while (match.Success)
        {
            if (!string.IsNullOrWhiteSpace(match.Groups[1].Value) && !string.IsNullOrWhiteSpace(match.Groups[4].Value))
                links.Add((match.Groups[1].Value, match.Groups[2].Value.Trim(), match.Groups[4].Value.Replace("\\", "")));

            match = match.NextMatch();
        }

        return links;
    }


    static async Task<string> FlareSolverrGet(string url)
    {
        try
        {
            string payload = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                ["cmd"] = "request.get",
                ["url"] = url,
                ["maxTimeout"] = 90_000
            });

            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(100) };
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var responseMessage = await client.PostAsync("http://127.0.0.1:8191/v1", content);
            string json = await responseMessage.Content.ReadAsStringAsync();
            if (string.IsNullOrEmpty(json))
                return null;

            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("status", out var status) || !status.ValueEquals("ok"))
                return null;

            if (doc.RootElement.TryGetProperty("solution", out var solution) && solution.TryGetProperty("response", out var response))
                return response.GetString();
        }
        catch { }

        return null;
    }

    static bool IsCloudflareChallenge(string html)
    {
        return html.Contains("challenges.cloudflare.com", StringComparison.OrdinalIgnoreCase) ||
               html.Contains("Just a moment", StringComparison.OrdinalIgnoreCase) ||
               html.Contains("cf-browser-verification", StringComparison.OrdinalIgnoreCase);
    }
}
