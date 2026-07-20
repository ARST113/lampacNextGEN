using Microsoft.AspNetCore.Mvc;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.Services;
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace Collaps;

public class CollapsController : BaseOnlineController<ModuleConf>
{
    CollapsInvoke oninvk;

    public CollapsController() : base(ModInit.conf)
    {
        loadKitInitialization = (j, i, c) =>
        {
            if (j.ContainsKey("dash"))
                i.dash = c.dash;

            return i;
        };

        requestInitialization = () =>
        {
            oninvk = new CollapsInvoke
            (
               host,
               "lite/collaps",
               httpHydra,
               init.host,
               init.dash,
               onstreamtofile => HostStreamProxy(Encoder.Uri(onstreamtofile)),
               (onstreamtofile, audio) => accsArgs($"{host}/lite/collaps/video.m3u8?id={EncryptQuery(onstreamtofile)}&audio={audio}")
            );
        };
    }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/collaps")]
    async public Task<ActionResult> Index(long orid, string imdb_id, long kinopoisk_id, string title, string original_title, string t = null, short s = -1, bool rjson = false, bool similar = false)
    {
        if (similar || (orid == 0 && kinopoisk_id == 0 && string.IsNullOrWhiteSpace(imdb_id)))
            return await RouteSearch(title);

        if (await IsRequestBlocked(rch: true))
            return badInitMsg;

    rhubFallback:
        var cache = await InvokeCacheResult($"collaps:view:{imdb_id}:{kinopoisk_id}:{orid}", 20,
            () => oninvk.Embed(imdb_id, kinopoisk_id, orid),
            textJson: true
        );

        if (IsRhubFallback(cache))
            goto rhubFallback;

        return ContentTpl(cache, () => oninvk.Tpl(
            cache.Value,
            imdb_id,
            kinopoisk_id,
            orid,
            title,
            original_title,
            s,
            t,
            vast: init.vast,
            rjson: rjson,
            headers: init.streamproxy ? null : httpHeaders(init.host, init.headers_stream)
        ));
    }


    [HttpGet]
    [Route("lite/collaps/video.m3u8")]
    async public Task<ActionResult> Video(string id, int audio = 0)
    {
        if (await IsRequestBlocked(rch: true))
            return badInitMsg;

        string stream = DecryptQuery(id);
        if (string.IsNullOrWhiteSpace(stream))
            return OnError();

        string proxyUrl = HostStreamProxy(Encoder.Uri(stream));
        if (string.IsNullOrWhiteSpace(proxyUrl))
            return OnError();

        string localUrl = proxyUrl;
        if (Uri.TryCreate(proxyUrl, UriKind.Absolute, out var proxyUri))
            localUrl = $"http://127.0.0.1:8242{proxyUri.PathAndQuery}";
        else if (proxyUrl.StartsWith("/", StringComparison.Ordinal))
            localUrl = "http://127.0.0.1:8242" + proxyUrl;

        string manifest = await Http.Get(localUrl, timeoutSeconds: 30);
        if (string.IsNullOrWhiteSpace(manifest))
            return OnError();

        manifest = Regex.Replace(manifest, "(?m)^#EXT-X-MEDIA:TYPE=AUDIO,[^\\r\\n]+$", match =>
        {
            string line = match.Value;
            var name = Regex.Match(line, "NAME=\\\"[^\\\"]*?([0-9]+)\\\"", RegexOptions.IgnoreCase);
            bool selected = name.Success && int.TryParse(name.Groups[1].Value, out int index) && index == audio;

            line = Regex.Replace(line, "DEFAULT=(YES|NO)", selected ? "DEFAULT=YES" : "DEFAULT=NO", RegexOptions.IgnoreCase);
            line = Regex.Replace(line, "AUTOSELECT=(YES|NO)", selected ? "AUTOSELECT=YES" : "AUTOSELECT=NO", RegexOptions.IgnoreCase);
            return line;
        });

        string publicHost = $"{Request.Scheme}://{Request.Host}";
        manifest = Regex.Replace(manifest, "https?://127\\.0\\.0\\.1:8242", publicHost, RegexOptions.IgnoreCase);

        return Content(manifest, "application/vnd.apple.mpegurl");
    }


    [HttpGet, Staticache(manually: true)]
    [Route("lite/collaps-search")]
    async public Task<ActionResult> RouteSearch(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return OnError();

        if (await IsRequestBlocked(rch: true))
            return badInitMsg;

    rhubFallback:
        var cache = await InvokeCacheResult<List<ResultSearch>>($"collaps:search:{title}", 40, textJson: true, onget: async e =>
        {
            string uri = $"{init.apihost}/list?token={init.token}&name={HttpUtility.UrlEncode(title)}";

            var root = await httpHydra.Get<RootSearch>(uri, safety: true);

            if (root?.results == null)
                return e.Fail("results", refresh_proxy: true);

            return e.Success(root.results);
        });

        if (IsRhubFallback(cache, safety: true))
            goto rhubFallback;

        return ContentTpl(cache, () =>
        {
            var stpl = new SimilarTpl(cache.Value.Count);

            foreach (var j in cache.Value)
            {
                stpl.Append(
                    j.name ?? j.origin_name,
                    j.year.ToString(),
                    string.Empty,
                    $"{host}/lite/collaps?orid={j.id}",
                    PosterApi.Size(j.poster)
                );
            }

            return stpl;
        });
    }
}
