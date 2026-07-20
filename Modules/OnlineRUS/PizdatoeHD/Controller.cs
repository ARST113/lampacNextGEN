using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.Playwright;
using Shared;
using Shared.Attributes;
using Shared.Models;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.PlaywrightCore;
using Shared.Services;
using Shared.Services.Utilities;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;
using BrowserCookie = Microsoft.Playwright.Cookie;

namespace PizdatoeHD;

public class PizdatoeHDController : BaseOnlineController<ModuleConf>
{
    PizdaInvoke oninvk;

    public PizdatoeHDController() : base(ModInit.conf)
    {
        requestInitializationAsync = async () =>
        {
            oninvk = new PizdaInvoke
            (
                host,
                "lite/pizdatoehd",
                init,
                (streamfile, streamProxyAddress) =>
                {
                    if (init.cdn != null && !streamfile.Contains(".vtt"))
                        streamfile = Regex.Replace(streamfile, "https?://[^/]+", init.cdn);

                    WebProxy streamProxy = null;
                    if (!string.IsNullOrWhiteSpace(streamProxyAddress))
                        streamProxy = ProxyManager.ConfigureWebProxy(init.proxy, streamProxyAddress).proxy;

                    return HostStreamProxy(init, streamfile, proxy: streamProxy);
                }
            );
        };
    }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/pizdatoehd")]
    async public Task<ActionResult> Index(string imdb_id, long kinopoisk_id, string title, string original_title, byte clarification, short year, string href, string t, short s = -1, bool rjson = false, bool similar = false, string source = null, string id = null)
    {
        bool blocked = await IsRequestBlocked(rch: false);
        Console.WriteLine($"[PizdatoeHD] request blocked={blocked} title={title} href={href} enable={init.enable} rhub={init.rhub}");
        if (blocked)
            return badInitMsg;

        if (string.IsNullOrEmpty(href) && !string.IsNullOrEmpty(source) && !string.IsNullOrEmpty(id))
        {
            if (source.Equals("rezka", StringComparison.OrdinalIgnoreCase) ||
                source.Equals("hdrezka", StringComparison.OrdinalIgnoreCase))
                href = id;
        }

        if (string.IsNullOrWhiteSpace(href) && string.IsNullOrWhiteSpace(title))
            return OnError();

        using (var browser = new PlaywrightBrowser(init.priorityBrowser))
        {
            IPage page = null;

            #region search
            if (string.IsNullOrEmpty(href))
            {
                CacheResult<SearchModel> search;

                string _kp = kinopoisk_id.ToString();
                string normalizedTitle = SearchNameTo.Convert(title);
                string normalizedOriginalTitle = SearchNameTo.Convert(original_title);
                var matches = ModInit.database
                    .Where(e =>
                        (imdb_id != null && e.Value.imdb == imdb_id) ||
                        (_kp != "0" && e.Value.kp == _kp) ||
                        (
                            (year <= 0 || e.Value.year == year.ToString()) &&
                            (
                                SearchNameTo.Equals(e.Value.title, normalizedTitle) ||
                                SearchNameTo.Equals(e.Value.title, normalizedOriginalTitle)
                            )
                        )
                    )
                    .ToList();

                Console.WriteLine($"[PizdatoeHD] search local title={title} kp={kinopoisk_id} imdb={imdb_id} matches={matches.Count}");

                if (matches.Count != 0)
                {
                    var model = new SearchModel()
                    {
                        similar = new List<SimilarModel>()
                    };

                    foreach (var entry in matches)
                    {
                        model.similar.Add(new SimilarModel()
                        {
                            title = entry.Value.title,
                            year = entry.Value.year,
                            href = entry.Value.href,
                            img = entry.Value.img
                        });
                    }

                    if (model.similar.Count == 1)
                        model.href = model.similar[0].href;

                    search = new CacheResult<SearchModel>()
                    {
                        IsSuccess = true,
                        Value = model
                    };
                }
                else
                {
                    search = await InvokeCacheResult<SearchModel>($"pizdatoehd:search:{title}:{original_title}:{clarification}:{year}", 240, textJson: true, onget: async e =>
                    {
                        try
                        {
                            page = await browser.NewPageAsync(init.plugin, init.headers, proxy: proxy_data, imitationHuman: true).ConfigureAwait(false);
                            if (page == null)
                                return e.Fail("page");

                            await AdsBlockRouteAsync(page);

                            SearchModel best = null;
                            var queries = new[]
                            {
                                clarification == 1 ? title : original_title,
                                title
                            }
                            .Where(query => !string.IsNullOrWhiteSpace(query))
                            .Distinct(StringComparer.OrdinalIgnoreCase);

                            foreach (string query in queries)
                            {
                                string search_uri = $"{init.host}/search/?do=search&subaction=search&q={HttpUtility.UrlEncode(query)}";
                                var result = await page.GotoAsync(search_uri, new PageGotoOptions()
                                {
                                    WaitUntil = WaitUntilState.DOMContentLoaded,
                                    Timeout = 10_000
                                });

                                if (result == null)
                                    continue;

                                string html = await result.TextAsync();
                                if (string.IsNullOrEmpty(html))
                                    continue;

                                var content = oninvk.Search(html, title, original_title, year);
                                if (content == null || content.IsError)
                                    continue;

                                if (content.IsEmpty)
                                {
                                    if (content.content != null)
                                        return e.Fail(content.content);

                                    continue;
                                }

                                if (!string.IsNullOrEmpty(content.href))
                                    return e.Success(content);

                                if ((content.similar?.Count ?? 0) > (best?.similar?.Count ?? 0))
                                    best = content;
                            }

                            if (best != null)
                                return e.Success(best);

                            return e.Fail(string.Empty, refresh_proxy: true);
                        }
                        catch (Exception ex)
                        {
                            Serilog.Log.Error(ex, "{Class} {CatchId}", "PizdatoeHD", "search");
                            return e.Fail("catch");
                        }
                    });
                }

                if (search.ErrorMsg != null)
                    return ShowError(string.IsNullOrEmpty(search.ErrorMsg) ? "поиск не дал результатов" : search.ErrorMsg);

                if (similar || string.IsNullOrEmpty(search.Value?.href))
                {
                    if (search.Value?.IsEmpty == true)
                        return ShowError(search.Value.content ?? "поиск не дал результатов");

                    return ContentTpl(search, () =>
                    {
                        if (search.Value.similar == null)
                            return default;

                        var stpl = new SimilarTpl(search.Value.similar.Count);
                        string enc_title = HttpUtility.UrlEncode(title);
                        string enc_original_title = HttpUtility.UrlEncode(original_title);

                        foreach (var similar in search.Value.similar)
                        {
                            string link = $"{host}/lite/pizdatoehd?rjson={rjson}&title={enc_title}&original_title={enc_original_title}&href={HttpUtility.UrlEncode(similar.href)}";

                            stpl.Append(
                                similar.title,
                                similar.year,
                                string.Empty,
                                link,
                                PosterApi.Size(similar.img)
                            );
                        }

                        return stpl;
                    });
                }

                href = search.Value.href;
            }
            #endregion

            Console.WriteLine($"[PizdatoeHD] selected href={href}");

            #region news
            var cache = await InvokeCacheResult<RootObject>($"pizdatoehd:{href}", 15, async e =>
            {
                try
                {
                    string html = null;

                    if (page != null && init.imitationHuman)
                    {
                        if (await GotoLinkAsync(page, href))
                            html = await page.ContentAsync();
                    }

                    if (html == null || !html.Contains("b-sidecover"))
                    {
                        if (page == null)
                        {
                            page = await browser.NewPageAsync(init.plugin, init.headers, proxy: proxy_data, imitationHuman: true).ConfigureAwait(false);
                            if (page == null)
                                return e.Fail("page");

                            await AdsBlockRouteAsync(page);
                        }

                        var result = await page.GotoAsync($"{init.host}/{href}", new PageGotoOptions()
                        {
                            WaitUntil = WaitUntilState.DOMContentLoaded,
                            Timeout = 10_000
                        });

                        if (result == null)
                            return e.Fail("не удалось загрузить страницу", refresh_proxy: true);

                        html = await page.ContentAsync();
                        Console.WriteLine($"[PizdatoeHD] card status={result.Status} url={page.Url} size={html?.Length ?? 0} challenge={html?.Contains("id=\"anubis_challenge\"") == true} access={html?.Contains("error-code", StringComparison.OrdinalIgnoreCase) == true}");
                    }

                    html = await SolveAnubisAsync(page, $"{init.host}/{href}", html);

                    Console.WriteLine($"[PizdatoeHD] card solved url={page.Url} size={html?.Length ?? 0} challenge={html?.Contains("id=\"anubis_challenge\"") == true} seasons={html?.Contains("data-season_id=", StringComparison.Ordinal) == true}");

                    if (string.IsNullOrEmpty(html))
                        return e.Fail("не удалось получить содержимое страницы");

                    var content = oninvk.Embed(href, html);
                    if (content == null)
                    {
                        Console.WriteLine($"[PizdatoeHD] embed failed href={href} title={await page.TitleAsync()}");
                        return e.Fail("не удалось распарсить страницу");
                    }

                    return e.Success(content);
                }
                catch (Exception ex)
                {
                    Serilog.Log.Error(ex, "{Class} {CatchId}", "PizdatoeHD", "news");
                    return e.Fail("catch");
                }
            });
            #endregion

            if (cache.Value?.IsEmpty == true)
                return ShowError(cache.Value.content);

            return ContentTpl(cache,
                () => oninvk.Tpl(cache.Value, accsArgs(string.Empty), title, original_title, href, t, s, rjson)
            );
        }
    }

    #region Movie
    [HttpGet, Staticache(manually: true)]
    [Route("lite/pizdatoehd/movie")]
    [Route("lite/pizdatoehd/movie.m3u8")]
    async public Task<ActionResult> Movie(string title, string original_title, string href, string voice, int t, short s = -1, short e = -1, bool play = false)
    {
        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        var cache = await InvokeCacheResult<MovieModel>(ipkey($"pizdatoehd:movie:{voice}:{href}:{t}:{s}:{e}"), TimeSpan.FromSeconds(20), async result =>
        {
            var attempts = new List<(string address, WebProxy http, (string ip, string username, string password) data)>();
            if (init.proxy?.list != null && init.proxy.list.Length > 0)
            {
                foreach (string address in init.proxy.list.OrderBy(_ => Guid.NewGuid()))
                {
                    var configured = ProxyManager.ConfigureWebProxy(init.proxy, address);
                    attempts.Add((address, configured.proxy, configured.data));
                }
            }
            else
            {
                attempts.Add((null, proxy, proxy_data));
            }

            foreach (var attempt in attempts)
            {
                using var browser = new PlaywrightBrowser(init.priorityBrowser);
                try
                {
                    var page = await browser.NewPageAsync(init.plugin, init.headers, proxy: attempt.data, imitationHuman: true).ConfigureAwait(false);
                    if (page == null)
                        continue;

                    await AdsBlockRouteAsync(page);

                    if (!string.IsNullOrEmpty(init.cookie))
                    {
                        var cookies = new List<BrowserCookie>();
                        var excookie = DateTimeOffset.UtcNow.AddYears(1).ToUnixTimeSeconds();

                        foreach (string line in init.cookie.Split(";"))
                        {
                            if (line.Contains("dle_user_id") || line.Contains("dle_password"))
                            {
                                cookies.Add(new BrowserCookie()
                                {
                                    Domain = "." + Regex.Replace(init.host, "^https?://", ""),
                                    Expires = excookie,
                                    Path = "/",
                                    HttpOnly = true,
                                    Name = line.Split("=")[0].Trim(),
                                    Value = line.Split("=")[1].Trim()
                                });
                            }
                        }

                        if (cookies.Count > 0)
                            await page.Context.AddCookiesAsync(cookies);
                    }

                    if (string.IsNullOrEmpty(voice))
                    {
                        page.Response += async (s, e) =>
                        {
                            if (e.Request.Method == "POST" && e.Request.Url.Contains("/get_cdn_series/"))
                            {
                                string json = await e.TextAsync();
                                browser.SetPageResult(json);
                            }
                        };

                        string requestedUrl = $"{init.host}/{href}#t:{t}-s:{s}-e:{e}";
                        var pageResult = await page.GotoAsync(requestedUrl, new PageGotoOptions
                        {
                            WaitUntil = WaitUntilState.DOMContentLoaded,
                            Timeout = 25_000
                        });

                        if (pageResult == null)
                            continue;

                        string html = await page.ContentAsync();
                        await SolveAnubisAsync(page, requestedUrl, html, attempt.http);

                        string json = await browser.WaitPageResult(10);
                        if (string.IsNullOrEmpty(json))
                            continue;

                        var content = oninvk.AjaxMovie(json);
                        if (content == null)
                            continue;

                        content.proxy = attempt.address;
                        return result.Success(content);
                    }
                    else
                    {
                        var page_result = await page.GotoAsync($"{init.host}/{voice}", new PageGotoOptions()
                        {
                            WaitUntil = WaitUntilState.DOMContentLoaded,
                            Timeout = 20_000
                        });

                        if (page_result == null)
                            continue;

                        string html = await page.ContentAsync();
                        html = await SolveAnubisAsync(page, $"{init.host}/{voice}", html, attempt.http);
                        if (string.IsNullOrEmpty(html))
                            continue;

                        var content = oninvk.Movie(html);
                        if (content == null)
                            continue;

                        content.proxy = attempt.address;
                        return result.Success(content);
                    }
                }
                catch (Exception ex)
                {
                    Serilog.Log.Warning(ex, "PizdatoeHD movie attempt failed Proxy={Proxy}", attempt.data.ip);
                }
            }

            return result.Fail("all proxy attempts failed", refresh_proxy: true);
        });

        if (cache.Value?.links == null || cache.Value.links.Count == 0)
            return OnError();

        string result = oninvk.Movie(cache.Value, title, original_title, play, HttpContext, vast: init.vast);
        if (result == null)
            return OnError();

        if (play)
            return RedirectToPlay(result);

        return ContentTo(result);
    }
    #endregion

    #region SolveAnubisAsync
    async Task<string> SolveAnubisAsync(IPage page, string requestedUrl, string html, WebProxy requestProxy = null)
    {
        if (page == null || string.IsNullOrEmpty(html) || !html.Contains("id=\"anubis_challenge\""))
            return html;

        try
        {
            string json = Regex.Match(html, "id=\"anubis_challenge\"[^>]+>([^\\n\\r<]+)").Groups[1].Value;
            string id = Regex.Match(json, "\"id\":\"([^\"]+)\"").Groups[1].Value;
            string userAgent = Regex.Match(json, "\"User-Agent\":\"([^\"]+)\"").Groups[1].Value;
            if (string.IsNullOrWhiteSpace(json) || string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(userAgent))
                return html;

            Console.WriteLine($"[PizdatoeHD] Anubis challenge id={id}");

            // Stop the challenge page before solving it ourselves, otherwise its worker
            // races the server-side solver and consumes the same one-time challenge.
            await page.GotoAsync("about:blank", new PageGotoOptions
            {
                WaitUntil = WaitUntilState.DOMContentLoaded,
                Timeout = 5_000
            });

            AnubisFast.Result result = await AnubisFast.SolveAsync(json.Trim());
            string domain = new Uri(init.host).Host;
            string passUrl = result.BuildPassUrl(init.host, $"{init.host.TrimEnd('/')}/");
            string authCookie = null;
            int passStatus = 0;

            using (var handler = new HttpClientHandler
            {
                AllowAutoRedirect = false,
                UseProxy = requestProxy != null || proxy != null,
                Proxy = requestProxy ?? proxy
            })
            using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) })
            using (var request = new HttpRequestMessage(HttpMethod.Get, passUrl))
            {
                request.Headers.TryAddWithoutValidation("Cookie", $"techaro.lol-anubis-cookie-verification={id}");
                request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
                request.Headers.TryAddWithoutValidation("Referer", $"{init.host.TrimEnd('/')}/");
                request.Headers.TryAddWithoutValidation("sec-fetch-dest", "document");
                request.Headers.TryAddWithoutValidation("sec-fetch-mode", "navigate");
                request.Headers.TryAddWithoutValidation("sec-fetch-site", "same-origin");

                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
                passStatus = (int)response.StatusCode;
                if (response.Headers.TryGetValues("Set-Cookie", out var cookies))
                {
                    foreach (string line in cookies)
                    {
                        const string prefix = "techaro.lol-anubis-auth=";
                        int start = line.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
                        if (start < 0)
                            continue;

                        start += prefix.Length;
                        int end = line.IndexOf(';', start);
                        authCookie = line.Substring(start, end < 0 ? line.Length - start : end - start);
                        break;
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(authCookie))
            {
                Console.WriteLine($"[PizdatoeHD] Anubis auth cookie missing status={passStatus}");
                return html;
            }

            Console.WriteLine($"[PizdatoeHD] Anubis auth status={passStatus}");

            await page.Context.AddCookiesAsync(new[]
            {
                new BrowserCookie
                {
                    Name = "techaro.lol-anubis-cookie-verification",
                    Value = id,
                    Domain = domain,
                    Path = "/",
                    Secure = true
                },
                new BrowserCookie
                {
                    Name = "techaro.lol-anubis-auth",
                    Value = authCookie,
                    Domain = domain,
                    Path = "/",
                    Secure = true,
                    HttpOnly = true
                }
            });

            var finalResponse = await page.GotoAsync(requestedUrl, new PageGotoOptions
            {
                WaitUntil = WaitUntilState.DOMContentLoaded,
                Timeout = 20_000
            });

            string finalHtml = await page.ContentAsync();
            Console.WriteLine($"[PizdatoeHD] Anubis final status={finalResponse?.Status ?? 0} url={page.Url} size={finalHtml?.Length ?? 0}");
            return finalHtml;
        }
        catch (Exception ex)
        {
            Serilog.Log.Error(ex, "{Class} {CatchId}", "PizdatoeHD", "anubis");
            return html;
        }
    }
    #endregion

    #region GotoLinkAsync
    async public Task<bool> GotoLinkAsync(IPage page, string href)
    {
        try
        {
            var container = page.Locator("div.b-content__inline_item-link").Filter(new()
            {
                Has = page.Locator($"a[href*='{href}']")
            });

            if (container == null || await container.CountAsync() != 1)
                return false;

            var link = container.Locator("a");
            if (link == null)
                return false;

            await link.ClickAsync();

            await page.WaitForURLAsync($"**/{href}", new PageWaitForURLOptions()
            {
                WaitUntil = WaitUntilState.DOMContentLoaded,
                Timeout = 8_000
            });

            return true;
        }
        catch
        {
            return false;
        }
    }
    #endregion

    #region AdsBlockRouteAsync
    async public Task AdsBlockRouteAsync(IPage page)
    {
        const string adspattern = "(vk.com|ad2the.net|schulist.link|clarity.ms|frane[a-z]ki.net|cdn.jsdelivr.net/npm/yandex-metrica-watch/tag.js)";

        await page.RouteAsync("**/*", async route =>
        {
            try
            {
                if (Regex.IsMatch(route.Request.Url, adspattern, RegexOptions.IgnoreCase))
                    await route.AbortAsync();
                else
                    await route.ContinueAsync();
            }
            catch { }
        });
    }
    #endregion
}
