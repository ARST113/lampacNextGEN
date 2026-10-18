using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace PidTor;

public static class FileMetadataProjector
{
    public const int Version = 1;
    public static FileProjection Project(VerifiedFileFacts facts)
    {
        if (!TorrentFileKey.TryCreate(facts?.Key.InfoHash, facts?.Key.Index ?? 0, out var key)
            || key != facts.Key || string.IsNullOrWhiteSpace(facts.Path)) throw new ArgumentException("Invalid file identity");
        var raw = JArray.Parse(facts.StreamsJson);
        var indices = new HashSet<int>();
        for (int i = 0; i < raw.Count; i++)
        {
            if (raw[i] is not JObject item) throw new ArgumentException("Invalid stream");
            if (i == 0 && item["index"] == null) item["index"] = 0;
            if (item["index"]?.Type != JTokenType.Integer || !indices.Add((int)item["index"]) || (int)item["index"] < 0)
                throw new ArgumentException("Invalid stream index");
        }
        var streams = raw.ToObject<List<FfStream>>();
        var video = streams.FirstOrDefault(i => i.codec_type == "video" && i.disposition?.attached_pic != 1
            && !new[] { "png", "mjpeg", "jpeg", "gif", "bmp", "webp", "apng", "tiff" }.Contains(i.codec_name));
        if (video == null) throw new ArgumentException("No playable video");
        int width = video.width ?? 0, height = video.height ?? 0;
        var projection = new FileProjection
        {
            Streams = streams,
            Video = new PidTorVideoTrack
            {
                stream_index = video.index, width = width, height = height, codec = video.codec_name,
                quality = width >= 3000 || height >= 1800 ? "2160p" : width >= 2400 || height >= 1300 ? "1440p"
                    : width >= 1700 || height >= 900 ? "1080p" : width >= 1200 || height >= 650 ? "720p"
                    : height >= 540 ? "576p" : height >= 440 ? "480p" : "SD",
                hdr = video.color_transfer == "smpte2084" ? "hdr10" : video.color_transfer == "arib-std-b67" ? "hlg" : "sdr",
                bit_depth = video.pix_fmt?.Contains("p12") == true ? 12 : video.pix_fmt?.Contains("p10") == true ? 10
                    : !string.IsNullOrWhiteSpace(video.pix_fmt) ? 8 : 0,
                bitrate = Long(video.bit_rate)
            }
        };
        foreach (var stream in streams)
        {
            if (stream.codec_type != "audio" && stream.codec_type != "subtitle") continue;
            string language = Language(stream.tags?.language);
            bool titled = !string.IsNullOrWhiteSpace(stream.tags?.title);
            bool handled = !string.IsNullOrWhiteSpace(stream.tags?.handler_name)
                && stream.tags.handler_name != "SoundHandler";
            string title = titled ? stream.tags.title.Trim() : handled ? stream.tags.handler_name.Trim() : language;
            string id = key + ":" + stream.codec_type + ":" + stream.index;
            projection.Tracks.Add(new StoredFileTrack
            {
                TrackId = id, Type = stream.codec_type, StreamIndex = stream.index, Language = language,
                Title = title, Codec = stream.codec_name, Channels = stream.channels ?? 0,
                Default = stream.disposition?.@default == 1, Forced = stream.disposition?.forced == 1,
                LabelSource = titled ? "tags.title" : handled ? "tags.handler_name" : "language"
            });
            if (stream.codec_type == "audio") projection.Audio.Add(new PidTorAudioTrack
            {
                id = id, stream_index = stream.index, language = language, title = title,
                codec = stream.codec_name, channels = stream.channels ?? 0, bitrate = Long(stream.bit_rate),
                @default = stream.disposition?.@default == 1
            });
            else projection.Subtitles.Add(new PidTorSubtitleTrack
            {
                id = id, stream_index = stream.index, language = language, title = title,
                codec = stream.codec_name, forced = stream.disposition?.forced == 1
            });
        }
        return projection;
    }
    static long Long(string value) => long.TryParse(value, out var result) ? result : 0;
    public static string Language(string value) => (value ?? "und").Trim().ToLowerInvariant() switch
    { "ru" => "rus", "en" => "eng", "ja" => "jpn", "uk" => "ukr", "" => "und", var code => code };
}
