using System;
using System.Collections.Generic;

namespace PidTor;

public sealed class AnimeResolveRequest
{
    public long id { get; set; }
    public long tmdb_id { get; set; }
    public string imdb_id { get; set; }
    public long kinopoisk_id { get; set; }
    public string source { get; set; }
    public string title { get; set; }
    public string original_title { get; set; }
    public string original_language { get; set; }
    public int year { get; set; }
    public bool serial { get; set; }
    public bool anime { get; set; }
    public int season { get; set; }
    public int episode { get; set; }
    public string season_title { get; set; }
    public int season_year { get; set; }
    public int season_episodes { get; set; }
    public string genres { get; set; }
}

public sealed class AnimeResolveResult
{
    public string provider { get; set; } = "shikimori";
    public long id { get; set; }
    public double matched_score { get; set; }
    public string kind { get; set; }
    public int year { get; set; }
    public int selected_season { get; set; }
    public List<string> aliases { get; set; } = new();
    public List<AnimeSeasonMatch> seasons { get; set; } = new();
}

public sealed class AnimeSeasonMatch
{
    public int season { get; set; }
    public long shikimori_id { get; set; }
    public string kind { get; set; }
    public int year { get; set; }
    public int episodes { get; set; }
    public List<string> aliases { get; set; } = new();
}

internal sealed class ShikimoriGraphResponse
{
    public ShikimoriGraphData data { get; set; }
    public List<ShikimoriGraphError> errors { get; set; }
}

internal sealed class ShikimoriGraphData
{
    public List<ShikimoriAnime> animes { get; set; }
}

internal sealed class ShikimoriGraphError
{
    public string message { get; set; }
}

internal sealed class ShikimoriAnime
{
    public string id { get; set; }
    public string name { get; set; }
    public string russian { get; set; }
    public string english { get; set; }
    public string japanese { get; set; }
    public List<string> synonyms { get; set; }
    public string kind { get; set; }
    public int episodes { get; set; }
    public ShikimoriDate airedOn { get; set; }
    public ShikimoriDate releasedOn { get; set; }
    public List<ShikimoriRelated> related { get; set; }
}

internal sealed class ShikimoriDate
{
    public int? year { get; set; }
    public int? month { get; set; }
    public int? day { get; set; }
    public string date { get; set; }
}

internal sealed class ShikimoriRelated
{
    public string relationKind { get; set; }
    public string relationText { get; set; }
    public ShikimoriAnime anime { get; set; }
}
