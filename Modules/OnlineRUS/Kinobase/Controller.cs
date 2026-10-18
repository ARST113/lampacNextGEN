using Microsoft.AspNetCore.Mvc;
using Microsoft.Playwright;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.PlaywrightCore;
using Shared.Services;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Kinobase;

public class KinobaseController : BaseOnlineController<ModuleConf>
{
    string selectedProxyAddress;

    public KinobaseController() : base(ModInit.conf) { }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/kinobase")]
    async public Task<ActionResult> Index(string title, short year, short s = -1, string href = null, string t = null, bool rjson = false, bool similar = false, string source = null, string id = null)
    {
        if (PlaywrightBrowser.Status == PlaywrightStatus.disabled)
            return OnError();

        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        if (string.IsNullOrEmpty(href) && !string.IsNullOrEmpty(source) && !string.IsNullOrEmpty(id))
        {
            if (source.Equals("kinobase", StringComparison.OrdinalIgnoreCase))
                href = id;
        }

        var oninvk = new KinobaseInvoke
        (
           host,
           init,
           ongettourl =>
           {
               if (ongettourl.Contains("/search?query="))
                   return httpHydra.Get(ongettourl, addheaders: HeadersModel.Init("referer", init.host));

               return black_magic(ongettourl);
           },
           streamfile =>
           {
               System.Net.WebProxy streamProxy = null;
               if (!string.IsNullOrWhiteSpace(selectedProxyAddress))
                   streamProxy = ProxyManager.ConfigureWebProxy(init.proxy, selectedProxyAddress).proxy;

               return HostStreamProxy(init, streamfile, proxy: streamProxy);
           }
        );

        #region search
        if (string.IsNullOrEmpty(href))
        {
            var search = await InvokeCacheResult<SearchModel>($"kinobase:search:{title}:{year}", TimeSpan.FromHours(4), async e =>
            {
                var content = await oninvk.Search(title, year);
                if (content == null)
                    return e.Fail("search");

                return e.Success(content);
            });

            if (similar || string.IsNullOrEmpty(search.Value?.link))
                return ContentTpl(search, () => search.Value.similar);

            if (string.IsNullOrEmpty(search.Value?.link))
                return OnError();

            href = search.Value?.link;
        }
        #endregion

        var cache = await InvokeCacheResult<EmbedModel>($"kinobase:view:{href}:{proxyManager?.CurrentProxyIp}", 20, textJson: true, onget: async e =>
        {
            var content = await oninvk.Embed(href, init.playerjs);
            if (content == null)
                return e.Fail("embed");

            content.proxy = selectedProxyAddress;
            return e.Success(content);
        });

        if (cache.IsSuccess && cache.Value.IsEmpty)
            return ShowError(cache.Value.errormsg);

        selectedProxyAddress = cache.Value?.proxy;

        return ContentTpl(cache,
            () => oninvk.Tpl(cache.Value, title, href, s, t, rjson)
        );
    }

    #region black_magic
    async Task<string> black_magic(string uri)
    {
        var attempts = new List<(string address, (string ip, string username, string password) data)>();
        if (init.proxy?.list != null && init.proxy.list.Length > 0)
        {
            foreach (string address in init.proxy.list.Where(i => !string.IsNullOrWhiteSpace(i)).Distinct())
            {
                var configured = ProxyManager.ConfigureWebProxy(init.proxy, address);
                attempts.Add((address, configured.data));
            }
        }
        else
        {
            attempts.Add((null, proxy_data));
        }

        foreach (var attempt in attempts)
        {
            try
            {
                using var browser = new PlaywrightBrowser();
                var page = await browser.NewPageAsync(init.plugin, proxy: attempt.data, headers: init.headers).ConfigureAwait(false);
                if (page == null)
                    continue;

                await page.Context.AddCookiesAsync(new List<Cookie>()
                {
                    new Cookie()
                    {
                        Name = "player_settings",
                        Value = $"{(init.playerjs ? "new" : "old")}|{(init.hls ? "hls" : "mp4")}|{(init.hdr ? 1 : 0)}",
                        Domain = Regex.Match(init.host, "^https?://([^/]+)").Groups[1].Value,
                        Path = "/",
                        Expires = 2220002226
                    }
                }).ConfigureAwait(false);

                await page.RouteAsync("**/*", async route =>
                {
                    try
                    {
                        if (route.Request.Url.Contains("/playerjs."))
                        {
                            await route.FulfillAsync(new RouteFulfillOptions
                            {
                                Body = ModInit.playerjs
                            });

                            return;
                        }
                        else if (route.Request.Url.Contains("/uppod.js"))
                        {
                            await route.FulfillAsync(new RouteFulfillOptions
                            {
                                Body = ModInit.uppod
                            });

                            return;
                        }

                        if (!route.Request.Url.Contains(init.host) || route.Request.Url.Contains("/comments"))
                        {
                            await route.AbortAsync();
                            return;
                        }

                        if (await PlaywrightBase.AbortOrCache(page, route, abortMedia: true, patterCache: "/js/(jquery|boot)\\.js"))
                            return;

                        await route.ContinueAsync();
                    }
                    catch (Exception ex)
                    {
                        Serilog.Log.Error(ex, "{Class} {CatchId}", "Kinobase", "id_gcc4caoa");
                    }
                });

                await page.GotoAsync(uri, new PageGotoOptions
                {
                    WaitUntil = WaitUntilState.DOMContentLoaded,
                    Timeout = 20_000
                }).ConfigureAwait(false);

                await Task.WhenAny(
                    browser.WaitForAnySelectorAsync(page, "#playerjsfile", ".uppod-media", ".alert"),
                    Task.Delay(TimeSpan.FromSeconds(10))
                ).ConfigureAwait(false);

                string content = await page.ContentAsync().ConfigureAwait(false);
                bool hasPlayer = content.Contains("id=\"playerjsfile\"") || content.Contains("class=\"uppod-media\"");
                string alert = Regex.Match(content, "<div class=\"alert\">\\s*<h3>([^<]+)").Groups[1].Value.Trim();
                Console.WriteLine($"[Kinobase] route={attempt.address ?? "direct"} player={hasPlayer} alert={alert}");

                if (hasPlayer)
                {
                    selectedProxyAddress = attempt.address;
                    return content;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Kinobase] route={attempt.address ?? "direct"} error={ex.Message}");
            }
        }

        return null;
    }
    #endregion
}
