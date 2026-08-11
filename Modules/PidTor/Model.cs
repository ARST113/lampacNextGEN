using System;
using System.Collections.Generic;

namespace PidTor;

public class Torrent
{
    public Torrent() { }

    public Torrent(string name, string voice, string magnet, int sid, string tr, string quality, long size, string mediainfo, Result torrent)
    {
        this.name = name;
        this.voice = voice;
        this.magnet = magnet;
        this.sid = sid;
        this.tr = tr;
        this.quality = quality;
        this.size = size;
        this.mediainfo = mediainfo;
        this.torrent = torrent;
    }

    public string name { get; set; }
    public string voice { get; set; }
    public string magnet { get; set; }
    public int sid { get; set; }
    public string tr { get; set; }
    public string quality { get; set; }
    public long size { get; set; }
    public string mediainfo { get; set; }
    public Result torrent { get; set; }
}

public class FileStat
{
    public short id { get; set; }

    public string path { get; set; }
}

public class Info
{
    public int quality { get; set; }

    public string videotype { get; set; }

    public string[] voices { get; set; }

    public string sizeName { get; set; }

    public short[] seasons { get; set; }

    public string name { get; set; }

    public string originalname { get; set; }
}

public class Result
{
    public string Tracker { get; set; }
    public string Title { get; set; }
    public long? Size { get; set; }
    public int Seeders { get; set; }
    public string MagnetUri { get; set; }
    public Info info { get; set; }
    public List<FfStream> ffprobe { get; set; }
    public HashSet<string> languages { get; set; }

    public DateTime PublishDate { get; set; }
}

public class FfStream
{
    public int index { get; set; }
    public string codec_name { get; set; }
    public string codec_long_name { get; set; }
    public string codec_type { get; set; }
    public int? width { get; set; }
    public int? height { get; set; }
    public string profile { get; set; }
    public string level { get; set; }
    public string pix_fmt { get; set; }
    public string color_range { get; set; }
    public string color_space { get; set; }
    public string color_transfer { get; set; }
    public string color_primaries { get; set; }
    public string sample_rate { get; set; }
    public int? channels { get; set; }
    public string channel_layout { get; set; }
    public string bit_rate { get; set; }
    public FfTags tags { get; set; }
    public FfDisposition disposition { get; set; }
}

public class FfTags
{
    public string language { get; set; }
    public string title { get; set; }
    public string handler_name { get; set; }
}

public class FfDisposition
{
    public int @default { get; set; }
    public int forced { get; set; }
}

public class RootObject
{
    public Result[] Results { get; set; }
}

public class Stat
{
    public FileStat[] file_stats { get; set; }
}
