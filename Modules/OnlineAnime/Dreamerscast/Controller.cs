using Microsoft.AspNetCore.Mvc;
using Shared.Attributes;
using Shared.Services.RxEnumerate;
using System.Text.Json;
using System.Text;
using Shared;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.Services.Utilities;
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace Dreamerscast;

public class DreamerscastController : BaseOnlineController
{
    public DreamerscastController() : base(ModInit.conf) { }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/dreamerscast")]
    async public Task<ActionResult> Index(string title, short year, string uri, short s = 1, bool rjson = false, bool similar = false)
    {
        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        if (string.IsNullOrWhiteSpace(uri))
        {
            if (string.IsNullOrWhiteSpace(title))
                return OnError();

        rhubFallback:
            var cache = await InvokeCacheResult<List<SearchItem>>($"dreamerscast:search:{title}", TimeSpan.FromHours(4), textJson: true, onget: async e =>
            {
                var search = await httpHydra.Post<SearchResponse>($"{init.host}/", $"search={HttpUtility.UrlEncode(title)}&status=&pageSize=16&pageNumber=1", textJson: true, addheaders: HeadersModel.Init(
                    ("x-requested-with", "XMLHttpRequest"),
                    ("referer", init.host + "/")
                ));

                if (search?.releases == null)
                    return e.Fail("search", refresh_proxy: true);

                var catalog = new List<SearchItem>();

                foreach (var item in search.releases)
                {
                    string img = item.image;

                    if (!string.IsNullOrEmpty(img) && img.StartsWith("//"))
                        img = "https:" + img;
                    else if (!string.IsNullOrEmpty(img) && img.StartsWith("/"))
                        img = init.host + img;

                    string animeSeason = Regex.Match(item.original ?? string.Empty, " ([0-9]+)nd ").Groups[1].Value;
                    if (string.IsNullOrWhiteSpace(animeSeason))
                        animeSeason = "1";

                    catalog.Add(new SearchItem
                    {
                        title = item.russian ?? item.original,
                        year = item.dateissue,
                        uri = item.url,
                        s = animeSeason,
                        img = img
                    });
                }

                if (catalog.Count == 0)
                    return e.Fail("catalog");

                return e.Success(catalog);
            });

            if (IsRhubFallback(cache))
                goto rhubFallback;

            if (!similar && cache.Value != null && cache.Value.Count == 1)
                return LocalRedirect(accsArgs($"/lite/dreamerscast?rjson={rjson}&title={HttpUtility.UrlEncode(title)}&uri={HttpUtility.UrlEncode(cache.Value[0].uri)}&s={cache.Value[0].s}"));

            return ContentTpl(cache, () =>
            {
                var stpl = new SimilarTpl(cache.Value.Count);

                foreach (var res in cache.Value)
                {
                    stpl.Append(
                        res.title,
                        res.year.ToString(),
                        string.Empty,
                        $"{host}/lite/dreamerscast?title={HttpUtility.UrlEncode(title)}&uri={HttpUtility.UrlEncode(res.uri)}&s={res.s}",
                        PosterApi.Size(res.img)
                    );
                }

                return stpl;
            });
        }
        else
        {
        rhubFallback:
            var cache = await InvokeCacheResult<List<Episode>>($"dreamerscast:release:{uri}", 20, textJson: true, onget: async e =>
            {
                var episodes = new List<Episode>();
                string failReason = "episodes";

                string html = await httpHydra.Get(init.host + uri);
                if (string.IsNullOrEmpty(html))
                {
                    failReason = "html";
                }
                else
                {
                    string base64 = Regex.Match(html, "Playerjs\\(\"#2([^\"]+)\"\\);").Groups[1].Value;
                    if (string.IsNullOrEmpty(base64))
                    {
                        failReason = "playerjs";
                        goto finishDreamerscastParse;
                    }

                    string cleanBase64 = Regex.Replace(base64, "//[^=]+==", "");
                    int remainder = cleanBase64.Length % 4;
                    if (remainder > 0)
                        cleanBase64 = cleanBase64.PadRight(cleanBase64.Length + 4 - remainder, '=');

                    string json = Encoding.UTF8.GetString(Convert.FromBase64String(cleanBase64));
                    if (string.IsNullOrEmpty(json))
                    {
                        failReason = "json";
                        goto finishDreamerscastParse;
                    }

                    try
                    {
                        using var doc = JsonDocument.Parse(json, new JsonDocumentOptions
                        {
                            AllowTrailingCommas = true
                        });

                        if (doc.RootElement.TryGetProperty("file", out var fileElement))
                        {
                            if (fileElement.ValueKind == JsonValueKind.String)
                            {
                                string hls = getHls(fileElement.GetString());
                                if (hls != null)
                                {
                                    episodes.Add(new Episode
                                    {
                                        name = "1 \u0441\u0435\u0440\u0438\u044F",
                                        episode = "1",
                                        hls = hls
                                    });
                                    failReason = null;
                                }
                            }
                            else if (fileElement.ValueKind == JsonValueKind.Array)
                            {
                                foreach (var item in fileElement.EnumerateArray())
                                {
                                    string itemTitle = item.TryGetProperty("title", out var titleElement) ? titleElement.GetString() : null;
                                    string itemFile = item.TryGetProperty("file", out var itemFileElement) ? itemFileElement.GetString() : null;
                                    string hls = getHls(itemFile);
                                    if (hls == null)
                                        continue;

                                    episodes.Add(new Episode
                                    {
                                        name = itemTitle,
                                        episode = Regex.Match(itemTitle ?? string.Empty, "([0-9]+)").Groups[1].Value,
                                        hls = hls
                                    });
                                    failReason = null;
                                }
                            }
                        }
                    }
                    catch (Exception ex) { failReason = "parse:" + ex.GetType().Name; }
                }

            finishDreamerscastParse:
                if (episodes.Count == 0)
                    return e.Fail(failReason ?? "episodes", refresh_proxy: true);

                return e.Success(episodes);
            });

            if (IsRhubFallback(cache))
                goto rhubFallback;

            return ContentTpl(cache, () =>
            {
                var etpl = new EpisodeTpl(cache.Value.Count);

                foreach (var item in cache.Value)
                {
                    string ep = string.IsNullOrWhiteSpace(item.episode) ? "1" : item.episode;

                    etpl.Append(
                        string.IsNullOrWhiteSpace(item.name) ? $"{ep} серия" : item.name,
                        title,
                        s,
                        ep,
                        HostStreamProxy(item.hls)
                    );
                }

                return etpl;
            });
        }
    }


    static string getHls(string file)
    {
        if (string.IsNullOrEmpty(file))
            return null;

        foreach (Match match in Regex.Matches(file, "https?://[^\\s]+"))
        {
            string url = match.Value;
            if (url.Contains("/hls/"))
                return url.Trim().TrimEnd(',', ';');
        }

        return null;
    }
}
