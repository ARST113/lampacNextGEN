using Shared.Models.Templates;
using System.Collections.Generic;

namespace Kinogo;

public class SearchModel
{
    public string link { get; set; }

    public SimilarTpl similar { get; set; }
}

public class PlaylistItem
{
    public string title { get; set; }

    public string file { get; set; }

    public string subtitle { get; set; }

    public List<PlaylistItem> folder { get; set; }

    public int voice_id { get; set; }
}

public class VenomSeason
{
    public int season { get; set; }

    public List<VenomEpisode> episodes { get; set; }
}

public class VenomEpisode
{
    public string episode { get; set; }

    public string hls { get; set; }

    public string dasha { get; set; }

    public string dash { get; set; }
}
