using Microsoft.AspNetCore.Mvc;
using Microsoft.Playwright;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.PlaywrightCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace Vibix;

public class VibixController : BaseOnlineController
{
    public VibixController() : base(ModInit.conf) { }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/vibix")]
    async public Task<ActionResult> Index(string imdb_id, long kinopoisk_id, string title, string original_title, string t = null, short s = -1, bool rjson = false)
    {
        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        if (string.IsNullOrEmpty(imdb_id) && kinopoisk_id == 0)
            return OnError();

        var cache = await InvokeCacheResult<List<Item>>(ipkey($"vibix:{imdb_id}:{kinopoisk_id}"), 20, async e =>
        {
            string json = await black_magic(imdb_id, kinopoisk_id);
            if (string.IsNullOrWhiteSpace(json))
                return null;

            List<Item> root = null;

            try
            {
                root = JsonConvert.DeserializeObject<List<Item>>(json);
            }
            catch { }

            if (root == null || root.Count == 0)
                return e.Fail("root", refresh_proxy: true);

            return e.Success(root);
        });

        if (!cache.IsSuccess)
            return OnError(cache.ErrorMsg);

        if (cache.Value.First().file != null)
        {
            #region Фильм
            var mtpl = new MovieTpl(title, original_title, 1);

            foreach (var movie in cache.Value)
            {
                movie.voices ??= ParseVoices(movie.file);

                if (movie.voices.Count == 0)
                    continue;

                foreach (var v in movie.voices)
                {
                    if (v.Value.Count > 0)
                    {
                        mtpl.Append(
                            v.Key ?? movie.title,
                            accsArgs(v.Value[0].link),
                            streamquality: new StreamQualityTpl(v.Value, linkPredicate: accsArgs),
                            voice_name: v.Key ?? movie.title ?? "Vibix",
                            vast: init.vast
                        );
                    }
                }
            }

            return ContentTpl(mtpl);
            #endregion
        }
        else
        {
            #region Сериал
            string enc_title = HttpUtility.UrlEncode(title);
            string enc_original_title = HttpUtility.UrlEncode(original_title);

            if (s == -1)
            {
                var tpl = new SeasonTpl(cache.Value.Count);

                foreach (var season in cache.Value)
                {
                    if (int.TryParse(Regex.Match(season.title, "([0-9]+)$").Groups[1].Value, out int _s) && _s > 0)
                    {
                        tpl.Append(
                            $"{_s} сезон",
                            $"{host}/lite/vibix?rjson={rjson}&kinopoisk_id={kinopoisk_id}&imdb_id={imdb_id}&title={enc_title}&original_title={enc_original_title}&s={_s}",
                            _s
                        );
                    }
                }

                return ContentTpl(tpl);
            }
            else
            {
                var season = cache.Value.FirstOrDefault(i => i.title?.EndsWith($" {s}") == true);
                if (season?.folder == null)
                    return OnError();

                foreach (var episode in season.folder)
                {
                    string file = episode.folder?.FirstOrDefault(i => !string.IsNullOrEmpty(i.file))?.file ?? episode.file;
                    episode.voices = ParseVoices(file);
                }

                var voiceNames = season.folder
                    .Where(i => i.voices != null)
                    .SelectMany(i => i.voices.Keys)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();

                string selectedVoice = voiceNames.FirstOrDefault(i => string.Equals(i, t, StringComparison.OrdinalIgnoreCase))
                    ?? voiceNames.FirstOrDefault();

                if (string.IsNullOrEmpty(selectedVoice))
                    return OnError();

                var vtpl = new VoiceTpl(voiceNames.Count);
                foreach (string voice in voiceNames)
                {
                    vtpl.Append(
                        voice,
                        string.Equals(voice, selectedVoice, StringComparison.OrdinalIgnoreCase),
                        $"{host}/lite/vibix?rjson={rjson}&kinopoisk_id={kinopoisk_id}&imdb_id={imdb_id}&title={enc_title}&original_title={enc_original_title}&s={s}&t={HttpUtility.UrlEncode(voice)}"
                    );
                }

                var etpl = new EpisodeTpl(vtpl, season.folder.Length);

                foreach (var episode in season.folder)
                {
                    string name = episode.title;
                    var voice = episode.voices?.FirstOrDefault(i => string.Equals(i.Key, selectedVoice, StringComparison.OrdinalIgnoreCase));
                    var streams = voice?.Value;

                    if (string.IsNullOrEmpty(name) || streams == null || streams.Count == 0)
                        continue;

                    etpl.Append(
                        name,
                        title ?? original_title,
                        s,
                        Regex.Match(name, "([0-9]+)").Groups[1].Value,
                        accsArgs(streams[0].link),
                        streamquality: new StreamQualityTpl(streams, linkPredicate: accsArgs),
                        voice_name: selectedVoice,
                        vast: init.vast
                    );
                }

                return ContentTpl(etpl);
            }
            #endregion
        }
    }


    Dictionary<string, List<StreamQualityDto>> ParseVoices(string file)
    {
        var voices = new Dictionary<string, List<StreamQualityDto>>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(file))
            return voices;

        foreach (Match qualityMatch in Regex.Matches(file, @"\[(?<q>480|720|1080)p\](?<items>.*?)(?=,\[(?:480|720|1080)p\]|$)", RegexOptions.Singleline))
        {
            string items = qualityMatch.Groups["items"].Value;
            var voiceMatches = Regex.Matches(items, @"\{(?<voice>[^}]+)\}(?<file>https?://[^,\t\[\;{ ]+)", RegexOptions.Singleline);

            if (voiceMatches.Count == 0)
            {
                var defaultFile = Regex.Match(items, @"(?<file>https?://[^,\t\[\;{ ]+)").Groups["file"].Value;
                if (!string.IsNullOrEmpty(defaultFile))
                    AppendVoiceStream(voices, "Vibix", qualityMatch.Groups["q"].Value, defaultFile);
                continue;
            }

            foreach (Match voiceMatch in voiceMatches)
            {
                AppendVoiceStream(
                    voices,
                    voiceMatch.Groups["voice"].Value,
                    qualityMatch.Groups["q"].Value,
                    voiceMatch.Groups["file"].Value
                );
            }
        }

        return voices;
    }

    void AppendVoiceStream(Dictionary<string, List<StreamQualityDto>> voices, string voice, string quality, string file)
    {
        if (!voices.TryGetValue(voice, out var streams))
        {
            streams = new List<StreamQualityDto>(3);
            voices[voice] = streams;
        }

        streams.Insert(0, new StreamQualityDto(
            $"{host}/lite/vibix/video.m3u8?id={EncryptQuery(file)}",
            quality + "p"
        ));
    }


    #region Video
    [HttpGet, Staticache(manually: true)]
    [Route("lite/vibix/video.m3u8")]
    async public Task<ActionResult> Video(string id)
    {
        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        string uri = DecryptQuery(id);
        if (string.IsNullOrEmpty(uri))
            return OnError();

        string origin = Regex.Match(uri, "^(https?://[^/]+)").Groups[1].Value;

        var headers = HeadersModel.Init(
            ("accept", "*/*"),
            ("origin", origin),
            ("referer", $"{origin}/"),
            ("sec-fetch-dest", "empty"),
            ("sec-fetch-mode", "cors"),
            ("sec-fetch-site", "same-site")
        );

        JObject root = await InvokeCache(ipkey($"vibix:{uri}"), 20, async
            () => await httpHydra.Get<JObject>(uri, addheaders: headers)
        );

        if (!root.TryGetValue("p", out JToken pToken) || !root.TryGetValue("v", out JToken vToken))
            return OnError();

        int version = vToken.Value<int>();
        string payload = pToken.Value<string>();

        if (string.IsNullOrEmpty(payload) || version != 1)
            return OnError();

        string data = new string(payload.Reverse().ToArray());
        byte[] decoded = Convert.FromBase64String(PadBase64(data));

        const string ApiDecoderKey = "RySdvcyu5iTUxn97vn4HwoniwgxaCynA";

        byte[] key = Encoding.ASCII.GetBytes(ApiDecoderKey);
        for (int i = 0; i < decoded.Length; i++)
            decoded[i] = (byte)(decoded[i] ^ key[i % key.Length]);

        string m3u8 = Encoding.UTF8.GetString(decoded);
        m3u8 = Regex.Replace(m3u8, "(https://[^\n\r]+)", u => HostStreamProxy(u.Value, headers));

        return Content(m3u8, "application/vnd.apple.mpegurl");
    }
    #endregion

    #region black_magic
    async Task<string> black_magic(string imdb_id, long kinopoisk_id)
    {
        try
        {
            using (var browser = new PlaywrightBrowser(init.priorityBrowser))
            {
                var page = await browser.NewPageAsync(init.plugin, proxy: proxy_data, headers: init.headers).ConfigureAwait(false);
                if (page == null)
                    return null;

                await page.RouteAsync("**/*", async route =>
                {
                    try
                    {
                        if (route.Request.Url.StartsWith("https://coldfilm.ink"))
                        {
                            string target = kinopoisk_id > 0
                                ? $"data-type=\"kp\" data-id=\"{kinopoisk_id}\""
                                : $"data-type=\"imdb\" data-id=\"{imdb_id}\"";

                            await route.FulfillAsync(new RouteFulfillOptions
                            {
                                Body = $@"<html lang=""ru"">
                                    <head>
                                        <meta charset=""UTF-8"">
                                        <script src=""https://graphicslab.io/sdk/v2/rendex-sdk.min.js""></script>
                                    </head>
                                    <body>
                                        <ins data-publisher-id=""674784070"" {target}></ins>
                                    </body>
                                </html>"
                            });
                        }
                        else
                        {
                            if (route.Request.Url.Contains("/embed.js"))
                            {
                                await route.FulfillAsync(new RouteFulfillOptions
                                {
                                    Body = System.IO.File.ReadAllText($"{ModInit.path}/embed.js")
                                });
                            }
                            else
                            {
                                if (!Regex.IsMatch(route.Request.Url, "(kinescopecdn|graphicslab|coldfilm)\\.") ||
                                    route.Request.Url.Contains("/index.m3u8"))
                                {
                                    await route.AbortAsync();
                                    return;
                                }

                                if (await PlaywrightBase.AbortOrCache(page, route))
                                    return;

                                await route.ContinueAsync();
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Serilog.Log.Error(ex, "{Class} {CatchId}", "Vibix", "id_t2yqc1oa");
                    }
                });

                PlaywrightBase.GotoAsync(page, "https://coldfilm.ink/");

                var frame = page.FrameLocator("iframe[src*='kinescopecdn.net']");

                await frame.Locator("#playerjsfile").WaitForAsync(new()
                {
                    Timeout = 10000
                });

                return await frame.Locator("#playerjsfile").TextContentAsync();
            }
        }
        catch { return null; }
    }
    #endregion


    static string PadBase64(string value)
    {
        int mod = value.Length % 4;
        if (mod == 0)
            return value;

        return value + new string('=', 4 - mod);
    }
}
