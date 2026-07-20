using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json.Linq;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.Services;
using Shared.Services.RxEnumerate;
using Shared.Services.Utilities;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace Kinotochka;

public class KinotochkaController : BaseOnlineController
{
    static readonly HttpClient http2Client = FriendlyHttp.CreateHttp2Client(useCookies: false);

    public KinotochkaController() : base(ModInit.conf)
    {
        requestInitialization += () =>
        {
            if (init.httpversion == 2)
                httpHydra.RegisterHttp(http2Client);
        };
    }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/kinotochka")]
    async public Task<ActionResult> Index(long kinopoisk_id, string title, string original_title, short serial, string newsuri, string t = null, short s = -1, bool rjson = false)
    {
        if (string.IsNullOrWhiteSpace(title))
            return OnError();

        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        // enable 720p
        string cookie = init.cookie;

        if (serial == 1)
        {
            if (s == -1)
            {
                #region Сезоны
            rhubFallback:

                var cache = await InvokeCacheResult<List<Season>>($"kinotochka:seasons:{title}", TimeSpan.FromHours(4), textJson: true, onget: async e =>
                {
                    List<Season> links = null;

                    if (kinopoisk_id > 0) // https://kinovibe.co/embed.html
                    {
                        var root = await httpHydra.Get<List<Season>>($"{init.host}/api/find-by-kinopoisk.php?kinopoisk={kinopoisk_id}", textJson: true);

                        if (root == null || root.Count == 0)
                            return e.Fail("find-by-kinopoisk", refresh_proxy: true);

                        links = new List<Season>(root.Count);
                        foreach (var item in root)
                        {
                            string url = item.url;
                            string sname = Regex.Match(url, "-([0-9]+)-sezon").Groups[1].Value;
                            if (!string.IsNullOrEmpty(sname))
                            {
                                links.Add(new Season()
                                {
                                    name = $"{sname} сезон",
                                    url = $"{host}/lite/kinotochka?rjson={rjson}&kinopoisk_id={kinopoisk_id}&title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&serial={serial}&s={sname}&newsuri={HttpUtility.UrlEncode(url)}",
                                    season = sname
                                });
                            }
                        }

                        if (links.Count == 0)
                            return e.Fail("links");
                    }
                    else
                    {
                        bool reqOk = false;
                        string data = $"do=search&subaction=search&search_start=0&full_search=0&result_from=1&story={HttpUtility.UrlEncode(title)}";

                        await httpHydra.PostSpan($"{init.host}/index.php?do=search", data, search =>
                        {
                            reqOk = search.Contains(">Поиск по сайту<", StringComparison.OrdinalIgnoreCase);

                            var rx = Rx.Split("sres-wrap clearfix", search, 1);
                            links = new List<Season>(rx.Count);

                            string stitle = SearchNameTo.Convert(title);

                            foreach (var row in rx.Rows())
                            {
                                var gname = row.Groups("<h2>([^<]+) (([0-9]+) Сезон) \\([0-9]{4}\\)</h2>", RegexOptions.IgnoreCase);

                                if (SearchNameTo.Equals(gname[1].Value, stitle))
                                {
                                    string uri = row.Match("href=\"(https?://[^\"]+\\.html)\"");
                                    if (string.IsNullOrWhiteSpace(uri))
                                        continue;

                                    links.Add(new Season()
                                    {
                                        name = gname[2].Value.ToLower(),
                                        url = $"{host}/lite/kinotochka?rjson={rjson}&kinopoisk_id={kinopoisk_id}&title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&serial={serial}&s={gname[3].Value}&newsuri={HttpUtility.UrlEncode(uri)}",
                                        season = gname[3].Value
                                    });
                                }
                            }
                        });

                        if (links == null || links.Count == 0)
                            return e.Fail("links", refresh_proxy: !reqOk);
                    }

                    links.Reverse();
                    return e.Success(links);
                });

                if (IsRhubFallback(cache))
                    goto rhubFallback;

                return ContentTpl(cache, () =>
                {
                    var tpl = new SeasonTpl(cache.Value.Count);

                    foreach (var l in cache.Value)
                    {
                        tpl.Append(
                            l.name,
                            l.url,
                            l.season
                        );
                    }

                    return tpl;
                });
                #endregion
            }
            else
            {
                #region Серии
            rhubFallback:

                var cache = await InvokeCacheResult<List<Episode>>($"kinotochka:playlist:v2:{newsuri}", 30, textJson: true, onget: async e =>
                {
                    string filetxt = null;

                    await httpHydra.GetSpan(newsuri, addheaders: HeadersModel.Init("cookie", cookie), safety: !string.IsNullOrEmpty(cookie), spanAction: news =>
                    {
                        filetxt = Rx.Match(news, "file:\"(https?://[^\"]+\\.txt)\"");
                    });

                    if (string.IsNullOrEmpty(filetxt))
                        return e.Fail("filetxt", refresh_proxy: true);

                    var root = await httpHydra.Get<RootEpisode>(filetxt, addheaders: HeadersModel.Init("cookie", cookie), safety: !string.IsNullOrEmpty(cookie), textJson: true);

                    if (root?.playlist == null)
                        return e.Fail("playlist", refresh_proxy: true);

                    var links = new List<Episode>(root.playlist.Count);

                    foreach (var pl in root.playlist)
                    {
                        if (!string.IsNullOrWhiteSpace(pl.comment) && !string.IsNullOrWhiteSpace(pl.file))
                        {
                            if (pl.file.Contains("].mp4"))
                                pl.file = Regex.Replace(pl.file, "\\[[^\\]]+,([0-9]+)\\]\\.mp4$", "$1.mp4");

                            string voice = Regex.Match(pl.comment, "\\[([^\\]]+)\\]").Groups[1].Value.Trim();
                            if (string.IsNullOrEmpty(voice))
                                voice = Regex.Match(pl.comment, "<br\\s*/?>\\s*([^<]+)", RegexOptions.IgnoreCase).Groups[1].Value.Trim();
                            if (string.IsNullOrEmpty(voice))
                                voice = "Kinotochka";

                            string episode = Regex.Replace(pl.comment, "<br\\s*/?>.*$", string.Empty, RegexOptions.IgnoreCase).Trim();
                            links.Add(new(episode, pl.file, voice));
                        }
                    }

                    if (links.Count == 0)
                        return e.Fail("links");

                    return e.Success(links);
                });

                if (IsRhubFallback(cache, safety: !string.IsNullOrEmpty(cookie)))
                    goto rhubFallback;

                return ContentTpl(cache, () =>
                {
                    var voiceNames = cache.Value
                        .Where(i => !string.IsNullOrWhiteSpace(i.voice))
                        .Select(i => i.voice)
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .ToList();

                    string selectedVoice = voiceNames.FirstOrDefault(i => string.Equals(i, t, StringComparison.OrdinalIgnoreCase))
                        ?? voiceNames.FirstOrDefault();

                    var vtpl = new VoiceTpl(voiceNames.Count);
                    foreach (string voice in voiceNames)
                    {
                        vtpl.Append(
                            voice,
                            string.Equals(voice, selectedVoice, StringComparison.OrdinalIgnoreCase),
                            $"{host}/lite/kinotochka?rjson={rjson}&kinopoisk_id={kinopoisk_id}&title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&serial={serial}&s={s}&newsuri={HttpUtility.UrlEncode(newsuri)}&t={HttpUtility.UrlEncode(voice)}"
                        );
                    }

                    var etpl = new EpisodeTpl(vtpl, cache.Value.Count);

                    foreach (var l in cache.Value.Where(i => string.Equals(i.voice, selectedVoice, StringComparison.OrdinalIgnoreCase)))
                    {
                        etpl.Append(
                            l.comment,
                            title,
                            s,
                            Regex.Match(l.comment, "^([0-9]+)").Groups[1].Value,
                            HostStreamProxy(l.file),
                            voice_name: selectedVoice,
                            vast: init.vast
                        );
                    }

                    return etpl;
                });
                #endregion
            }
        }
        else
        {
            #region Фильм
            if (kinopoisk_id == 0)
                return OnError();

        rhubFallback:
            var cache = await InvokeCacheResult<EmbedModel>($"kinotochka:view:{kinopoisk_id}", 30, textJson: true, onget: async e =>
            {
                string file = null;

                var root = await httpHydra.Get<JArray>($"{init.host}/api/find-by-kinopoisk.php?kinopoisk={kinopoisk_id}");
                if (root == null || root.Count == 0)
                    return e.Fail("root");

                await httpHydra.GetSpan(root.First.Value<string>("url"), addheaders: HeadersModel.Init("cookie", cookie), safety: !string.IsNullOrEmpty(cookie), spanAction: embed =>
                {
                    file = Rx.Match(embed, "id:\"playerjshd\", file:\"(https?://[^\"]+)\"");
                    if (string.IsNullOrEmpty(file))
                        return;

                    foreach (string f in file.Split(",").Reverse())
                    {
                        if (string.IsNullOrWhiteSpace(f))
                            continue;

                        file = f;
                        break;
                    }
                });

                if (string.IsNullOrEmpty(file))
                    return e.Fail("file", refresh_proxy: true);

                return e.Success(new EmbedModel() { content = file });
            });

            if (IsRhubFallback(cache, safety: !string.IsNullOrEmpty(cookie)))
                goto rhubFallback;

            return ContentTpl(cache, () =>
            {
                var mtpl = new MovieTpl(title, original_title, 1);

                mtpl.Append(
                    "По умолчанию",
                    HostStreamProxy(cache.Value.content),
                    voice_name: "Kinotochka",
                    vast: init.vast
                );

                return mtpl;
            });
            #endregion
        }
    }
}
