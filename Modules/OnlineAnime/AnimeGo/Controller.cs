using Microsoft.AspNetCore.Mvc;
using Shared;
using Shared.Attributes;
using Shared.Models.Base;
using Shared.Models.Templates;
using Shared.Services.Utilities;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web;

namespace AnimeGo;

public class AnimeGoController : BaseOnlineController
{
    public AnimeGoController() : base(ModInit.conf) { }

    [HttpGet, Staticache(manually: true)]
    [Route("lite/animego")]
    async public Task<ActionResult> Index(string title, string original_title, short year, int pid, string uri, short s, string t, bool similar = false, bool rjson = false)
    {
        if (string.IsNullOrWhiteSpace(title))
            return OnError();

        if (await IsRequestBlocked(rch: false))
            return badInitMsg;

        if (pid == 0)
        {
            var cache = await InvokeCacheResult<List<SearchItem>>($"animego:search:v2:{title}:{original_title}", TimeSpan.FromHours(4), async e =>
            {
                string query = string.IsNullOrWhiteSpace(original_title) ? title : original_title;
                string search = await httpHydra.Get($"{init.host}/index.php?do=search&subaction=search&story={HttpUtility.UrlEncode(query)}");
                if (string.IsNullOrWhiteSpace(search) && !string.Equals(query, title, StringComparison.OrdinalIgnoreCase))
                    search = await httpHydra.Get($"{init.host}/index.php?do=search&subaction=search&story={HttpUtility.UrlEncode(title)}");

                if (string.IsNullOrWhiteSpace(search))
                    return e.Fail("search", refresh_proxy: true);

                string stitle = SearchNameTo.Convert(title);
                string soriginal = SearchNameTo.Convert(original_title);
                var catalog = new List<SearchItem>();

                foreach (Match article in Regex.Matches(search, "<article\\b(?<attrs>[^>]*)>(?<body>.*?)</article>", RegexOptions.IgnoreCase | RegexOptions.Singleline))
                {
                    string attrs = article.Groups["attrs"].Value;
                    string body = article.Groups["body"].Value;
                    string id = Attr(attrs, "data-news-id");
                    string href = Regex.Match(body, "<a\\b[^>]*href=\\\"(?<v>[^\\\"]+)\\\"[^>]*class=\\\"[^\\\"]*anime-card__poster", RegexOptions.IgnoreCase).Groups["v"].Value;
                    string name = HtmlText(Regex.Match(body, "class=\\\"anime-card__title\\\"[^>]*>(?<v>.*?)</a>", RegexOptions.IgnoreCase | RegexOptions.Singleline).Groups["v"].Value);
                    string animeYear = Regex.Match(body, "xfsearch/year/(?<v>[0-9]{4})", RegexOptions.IgnoreCase).Groups["v"].Value;
                    string image = Regex.Match(body, "<img\\b[^>]*src=\\\"(?<v>[^\\\"]+)\\\"[^>]*class=\\\"[^\\\"]*anime-card__img", RegexOptions.IgnoreCase).Groups["v"].Value;

                    if (!int.TryParse(id, out int newsId) || string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(href))
                        continue;

                    string normalized = SearchNameTo.Convert(name);
                    bool coincidence = SearchNameTo.Equals(normalized, stitle)
                        || SearchNameTo.Equals(normalized, soriginal)
                        || SearchNameTo.Contains(normalized, stitle)
                        || SearchNameTo.Contains(normalized, soriginal);

                    if (!coincidence && catalog.Count > 0)
                        continue;

                    catalog.Add(new SearchItem
                    {
                        title = name,
                        year = animeYear,
                        pid = newsId,
                        uri = AbsoluteUrl(href),
                        season = coincidence && (year <= 0 || animeYear == year.ToString()) ? "1" : "0",
                        image = AbsoluteUrl(image)
                    });
                }

                if (catalog.Count == 0)
                    return e.Fail("catalog");

                return e.Success(catalog);
            });

            if (!cache.IsSuccess)
                return OnError(cache.ErrorMsg);

            if (!similar && cache.Value.Count == 1)
            {
                var item = cache.Value[0];
                return LocalRedirect(accsArgs($"/lite/animego?rjson={rjson}&title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&pid={item.pid}&uri={HttpUtility.UrlEncode(item.uri)}&s={item.season}"));
            }

            var stpl = new SimilarTpl(cache.Value.Count);
            foreach (var item in cache.Value)
            {
                stpl.Append(
                    item.title,
                    item.year,
                    string.Empty,
                    $"{host}/lite/animego?title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&pid={item.pid}&uri={HttpUtility.UrlEncode(item.uri)}&s={item.season}",
                    PosterApi.Size(item.image)
                );
            }

            return ContentTpl(stpl);
        }

        var playlist = await InvokeCacheResult<PlaylistData>($"animego:playlist:v2:{pid}", TimeSpan.FromHours(1), async result =>
        {
            string referer = string.IsNullOrWhiteSpace(uri) ? $"{init.host}/" : uri;
            string content = await httpHydra.Post(
                $"{init.host}/engine/ajax/controller.php?mod=anime_grabber&module=kodik_playlist_ajax_screen",
                $"news_id={pid}&action=load_player&reason=lazy",
                addheaders: HeadersModel.Init(
                    ("referer", referer),
                    ("x-requested-with", "XMLHttpRequest")
                )
            );

            if (string.IsNullOrWhiteSpace(content))
                return result.Fail("player", refresh_proxy: true);

            var data = ParsePlaylist(content);
            if (data.translations.Count == 0 || data.episodes.Count == 0)
                return result.Fail("playlist");

            return result.Success(data);
        });

        return ContentTpl(playlist, () =>
        {
            string selected = playlist.Value.translations.Any(i => i.id == t)
                ? t
                : playlist.Value.translations.FirstOrDefault(i => playlist.Value.episodes.Any(e => e.translation == i.id))?.id;

            if (string.IsNullOrWhiteSpace(selected))
                return default;

            var selectedTranslation = playlist.Value.translations.First(i => i.id == selected);
            var episodes = playlist.Value.episodes
                .Where(i => i.translation == selected)
                .OrderBy(i => i.season)
                .ThenBy(i => i.episode)
                .ToList();

            var vtpl = new VoiceTpl(playlist.Value.translations.Count);
            foreach (var translation in playlist.Value.translations)
            {
                vtpl.Append(
                    translation.name,
                    translation.id == selected,
                    $"{host}/lite/animego?rjson={rjson}&title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&pid={pid}&uri={HttpUtility.UrlEncode(uri)}&s={s}&t={translation.id}"
                );
            }

            var etpl = new EpisodeTpl(vtpl, episodes.Count);
            foreach (var episode in episodes)
            {
                string playerLink = AbsolutePlayerUrl(episode.link);
                string link = $"{host}/lite/kodik/video?title={HttpUtility.UrlEncode(title)}&original_title={HttpUtility.UrlEncode(original_title)}&link={HttpUtility.UrlEncode(playerLink)}&episode={episode.episode}";
                string streamlink = accsArgs($"{link.Replace("/video", "/video.m3u8")}&play=true");
                string episodeName = string.IsNullOrWhiteSpace(episode.title)
                    ? $"{episode.episode} серия"
                    : $"{episode.episode} серия - {episode.title}";

                etpl.Append(
                    episodeName,
                    title,
                    episode.season > 0 ? episode.season.ToString() : s.ToString(),
                    episode.episode.ToString(),
                    link,
                    "call",
                    streamlink: streamlink,
                    voice_name: selectedTranslation.name
                );
            }

            return etpl;
        });
    }

    static PlaylistData ParsePlaylist(string content)
    {
        var result = new PlaylistData();
        var translationIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var episodeKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (Match row in Regex.Matches(content, "<li\\b(?<attrs>[^>]*)>(?<body>.*?)</li>", RegexOptions.IgnoreCase | RegexOptions.Singleline))
        {
            string attrs = row.Groups["attrs"].Value;
            string translation = Attr(attrs, "data-this_translator");
            if (string.IsNullOrWhiteSpace(translation))
                continue;

            string episodeValue = Attr(attrs, "data-this_episode");
            if (string.IsNullOrWhiteSpace(episodeValue))
            {
                string name = HtmlText(row.Groups["body"].Value);
                if (!string.IsNullOrWhiteSpace(name) && translationIds.Add(translation))
                    result.translations.Add(new TranslationItem { id = translation, name = name });
                continue;
            }

            if (!int.TryParse(episodeValue, out int episode))
                continue;

            int.TryParse(Attr(attrs, "data-this_season"), out int season);
            string link = HttpUtility.HtmlDecode(Attr(attrs, "data-this_link"));
            if (string.IsNullOrWhiteSpace(link))
                continue;

            string key = $"{translation}:{season}:{episode}";
            if (!episodeKeys.Add(key))
                continue;

            string body = row.Groups["body"].Value;
            string episodeTitle = HttpUtility.HtmlDecode(Regex.Match(body, "data-episode-title=\\\"(?<v>[^\\\"]*)", RegexOptions.IgnoreCase).Groups["v"].Value).Trim();

            result.episodes.Add(new EpisodeItem
            {
                translation = translation,
                season = season,
                episode = episode,
                title = episodeTitle,
                link = link
            });
        }

        return result;
    }

    static string Attr(string html, string name)
        => HttpUtility.HtmlDecode(Regex.Match(html ?? string.Empty, $"\\b{Regex.Escape(name)}=\\\"(?<v>[^\\\"]*)", RegexOptions.IgnoreCase).Groups["v"].Value);

    static string HtmlText(string html)
        => HttpUtility.HtmlDecode(Regex.Replace(html ?? string.Empty, "<[^>]+>", " ")).Trim();

    static string AbsoluteUrl(string url)
    {
        url = HttpUtility.HtmlDecode(url ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(url) || url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            return url;
        if (url.StartsWith("//"))
            return "https:" + url;
        return ModInit.conf.host.TrimEnd('/') + "/" + url.TrimStart('/');
    }

    static string AbsolutePlayerUrl(string url)
    {
        url = HttpUtility.HtmlDecode(url ?? string.Empty).Trim();
        return url.StartsWith("//") ? "https:" + url : url;
    }

    sealed class SearchItem
    {
        public string title { get; set; }
        public string year { get; set; }
        public int pid { get; set; }
        public string uri { get; set; }
        public string season { get; set; }
        public string image { get; set; }
    }

    sealed class PlaylistData
    {
        public List<TranslationItem> translations { get; set; } = new();
        public List<EpisodeItem> episodes { get; set; } = new();
    }

    sealed class TranslationItem
    {
        public string id { get; set; }
        public string name { get; set; }
    }

    sealed class EpisodeItem
    {
        public string translation { get; set; }
        public int season { get; set; }
        public int episode { get; set; }
        public string title { get; set; }
        public string link { get; set; }
    }
}
