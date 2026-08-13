using System.Collections.Generic;

namespace PidTor;

public sealed class PidTorPlayerResponse
{
    public int schema { get; set; } = 1;
    public string title { get; set; }
    public bool serial { get; set; }
    public int season { get; set; }
    public int episode { get; set; }
    public string resolver { get; set; }
    public long resolver_id { get; set; }
    public bool gst { get; set; }
    public List<PidTorPlayerVariant> variants { get; set; } = new();
}

public sealed class PidTorPlayerVariant
{
    public string id { get; set; }
    public PidTorVideoTrack video { get; set; }
    public List<PidTorAudioTrack> audio { get; set; } = new();
    public List<PidTorSubtitleTrack> subtitles { get; set; } = new();
    public List<PidTorReplica> replicas { get; set; } = new();
    public bool probe_required { get; set; }
}

public sealed class PidTorVideoTrack
{
    public int stream_index { get; set; }
    public int width { get; set; }
    public int height { get; set; }
    public string quality { get; set; }
    public string source { get; set; }
    public string codec { get; set; }
    public string hdr { get; set; }
    public int bit_depth { get; set; }
    public long bitrate { get; set; }
}

public sealed class PidTorAudioTrack
{
    public string id { get; set; }
    public int stream_index { get; set; }
    public string language { get; set; }
    public string title { get; set; }
    public string codec { get; set; }
    public int channels { get; set; }
    public long bitrate { get; set; }
    public bool @default { get; set; }
}

public sealed class PidTorSubtitleTrack
{
    public string id { get; set; }
    public int stream_index { get; set; }
    public string language { get; set; }
    public string title { get; set; }
    public string codec { get; set; }
    public bool forced { get; set; }
}

public sealed class PidTorReplica
{
    public string infohash { get; set; }
    public int seeders { get; set; }
    public long size { get; set; }
    public string tracker { get; set; }
    public string trackers { get; set; }
    public string stream_url { get; set; }
    public string episodes_url { get; set; }
}
