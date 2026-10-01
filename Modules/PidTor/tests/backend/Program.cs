using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using PidTor;
using Shared.Models.Online.Settings;

int failed = 0;
int total = 0;
if (args.Contains("--live"))
{
    using var input = JsonDocument.Parse(Console.ReadLine());
    var type = typeof(Result).Assembly.GetType("PidTor.TorrentFileProbe");
    var client = Activator.CreateInstance(type, input.RootElement.GetProperty("target").GetString(), new HttpClient());
    var response = await Probe(client, input.RootElement.GetProperty("hash").GetString(), input.RootElement.GetProperty("index").GetInt32(), input.RootElement.GetProperty("trackers").GetString());
    var streams = (List<FfStream>)response.GetType().GetProperty("streams").GetValue(response);
    Console.WriteLine(JsonSerializer.Serialize(new { sample = input.RootElement.GetProperty("sample").GetString(), file_index = input.RootElement.GetProperty("index").GetInt32(), error = Error(response), streams_count = streams.Count, audio = streams.Where(stream => stream.codec_type == "audio").Select(stream => new { index = stream.index, language = stream.tags?.language, title = stream.tags?.title ?? stream.tags?.handler_name, codec = stream.codec_name, channels = stream.channels }) }));
    return streams.Count > 0 ? 0 : 1;
}
async Task Check(string name, Func<Task> run)
{
    total++;
    try { await run(); Console.WriteLine("PASS " + name); }
    catch (Exception error) { failed++; Console.WriteLine("FAIL " + name + ": " + error.GetBaseException().Message); }
}
void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
Result Torrent(int n, int seeds = 20, string title = "Fixture S02E01 1080p", short[] seasons = null)
    => new() { Title = title, Tracker = "fixture", Seeders = seeds, Size = 1000, MagnetUri = "magnet:?xt=urn:btih:" + n.ToString("x40"), info = new Info { seasons = seasons ?? new short[] { 2 }, quality = 1080, voices = new[] { "Voice " + n } } };
Task<PidTorPlayerResponse> Search(params Result[] results)
{
    Shared.Services.Http.Result = new RootObject { Results = results };
    return PidTorPlayerSearch.SearchAsync(new PidTorSettings(), new AnimeResolveRequest { title = "Fixture", original_title = "Fixture", serial = true, season = 2, episode = 1 }, null, "https://fixture.invalid");
}
await Check("unprobed torrents with different voices stay distinct", async () =>
{
    var response = await Search(Torrent(1), Torrent(2));
    Require(response.variants.Count == 2, "expected 2 variants, got " + response.variants.Count);
});
await Check("positive-seed fallback when min_sid leaves no results", async () =>
{
    var response = await Search(Torrent(1, 2), Torrent(2, 2));
    Require(response.variants.Sum(v => v.replicas.Count) == 2, "all low-seed but live torrents were discarded");
});
await Check("season title fallback when parsed season metadata is missing", async () =>
{
    var torrent = Torrent(1); torrent.info.seasons = null;
    Require((await Search(torrent)).variants.Count == 1, "S02E01 lost without info.seasons");
});
await Check("nine different voice variants survive search", async () =>
{
    var response = await Search(Enumerable.Range(1, 9).Select(i => Torrent(i, 20, "Fixture S02E01 1080p", new short[] { 2 })).ToArray());
    Require(response.variants.Count == 9, "expected 9 variants, got " + response.variants.Count);
});
await Check("another season must not be substituted", async () =>
{
    Require((await Search(Torrent(1, 20, "Fixture S01E01 1080p", new short[] { 1 }))).variants.Count == 0, "wrong season returned");
});

await Check("unmarked first season requires exact title and matching release year", async () =>
{
    var full = Torrent(1, 19, "Mouse (1-20 episodes) / 2021 / WEBRip 1080p");
    full.info.seasons = null; full.info.name = "Mouse";
    var wrongYear = Torrent(2, 30, "Mouse (12 episodes) / 2003 / DVDRip");
    wrongYear.info.seasons = null; wrongYear.info.name = "Mouse";
    var wrongTitle = Torrent(3, 30, "Other show / 2021 / WEBRip");
    wrongTitle.info.seasons = null; wrongTitle.info.name = "Other show";
    Shared.Services.Http.Result = new RootObject { Results = new[] { full, wrongYear, wrongTitle } };
    var response = await PidTorPlayerSearch.SearchAsync(new PidTorSettings(),
        new AnimeResolveRequest { title = "Mouse", original_title = "Mouse", year = 2021, serial = true, season = 1, episode = 2 }, null, "https://fixture.invalid");
    Require(response.variants.Count == 1 && response.variants[0].replicas.Single().infohash == 1.ToString("x40"), "full matching first season lost or wrong title/year included");
});
await Check("low seed distinct voices survive alongside a preferred seeded release", async () =>
{
    var response = await Search(Torrent(1, 19), Torrent(2, 5), Torrent(3, 0));
    Require(response.variants.Count == 2, "live alternative voice removed by global min_sid threshold");
});

Result Borden(int n, short season = 4, int year = 2026, string original = "Monster: The Lizzie Borden Story")
{
    var result = Torrent(n, 4, $"{original} / {year} / Season {season} / SkipDubb", new short[] { season });
    result.info.name = "Monster"; result.info.originalname = original;
    return result;
}
Task<PidTorPlayerResponse> BordenSearch(params Result[] releases)
{
    Shared.Services.Http.Result = new RootObject { Results = releases };
    return PidTorPlayerSearch.SearchAsync(new PidTorSettings(), new AnimeResolveRequest {
        title = "Monster: The Lizzie Borden Story", original_title = "Monster: The Lizzie Borden Story",
        year = 2026, serial = true, season = 1, episode = 2 }, null, "https://fixture.invalid");
}
await Check("named Borden story maps physical season four to card season one", async () =>
{
    var response = await BordenSearch(Borden(10), Borden(11, 1));
    Require(response.variants.Count == 2, "valid season-four voice release was discarded");
    var mapped = response.variants.SelectMany(v => v.replicas).Single(r => r.infohash == 10.ToString("x40"));
    var query = System.Web.HttpUtility.ParseQueryString(new Uri(mapped.episodes_url).Query);
    Require(query["s"] == "4" && query["display_s"] == "1", "physical files and displayed season were conflated");
    var native = response.variants.SelectMany(v => v.replicas).Single(r => r.infohash == 11.ToString("x40"));
    Require(System.Web.HttpUtility.ParseQueryString(new Uri(native.episodes_url).Query)["s"] == "1", "native season-one release was remapped");
});
await Check("Borden mapping rejects another story, year, or ambiguous physical season", async () =>
{
    var ambiguous = Borden(13); ambiguous.info.seasons = new short[] { 3, 4 };
    var wrongParsedTitle = Borden(14); wrongParsedTitle.info.originalname = "Monster: The Jeffrey Dahmer Story";
    Require((await BordenSearch(Borden(10, 4, 2025), Borden(11, 4, 2026, "Monster: The Jeffrey Dahmer Story"),
        Borden(12, 3), ambiguous, wrongParsedTitle)).variants.Count == 0, "an unrelated anthology season leaked into the story");
});
await Check("Borden displayed season is only changed for the named mapped story", () =>
{
    var method = typeof(PidTorPlayerSearch).GetMethod("EpisodeSeason");
    Require(method != null, "physical season-four files need an explicit display-season projection");
    short Project(short physical, short display, string original) => (short)method.Invoke(null, new object[] { physical, display, original });
    Require(Project(4, 1, "Monster: The Lizzie Borden Story") == 1, "story must display card season one");
    Require(Project(4, 0, "Monster: The Lizzie Borden Story") == 4, "legacy season four was changed");
    Require(Project(2, 1, "Mouse") == 2 && Project(4, 1, "Monster: The Jeffrey Dahmer Story") == 4,
        "ordinary seasons or another story were relabeled");
    return Task.CompletedTask;
});
await Check("parsed anthology season beats the episode range after the season label", async () =>
{
    var release = Borden(10);
    release.Title = "Monster (4 season: 1-8 episodes) / Monster: The Lizzie Borden Story / 2026 / SkipDubb";
    Require((await BordenSearch(release)).variants.Count == 1, "episode one was mistaken for the source season");
});

Result UnnamedVoice(params FfStream[] audio)
{
    var result = Torrent(1, 19, "Fixture S02 / 2021 / ПМ (Тайм Медиа Групп) / WEBRip (1080p)");
    result.ffprobe = new() { new() { index = 0, codec_type = "video", codec_name = "h264", width = 1920, height = 818 } };
    result.ffprobe.AddRange(audio);
    return result;
}
string ReleaseVoice(PidTorPlayerVariant variant)
    => (string)typeof(PidTorPlayerVariant).GetProperty("release_voice")?.GetValue(variant);
await Check("single unnamed UND audio uses the release studio without changing stream metadata", async () =>
{
    var stream = new FfStream { index = 1, codec_type = "audio", codec_name = "aac", tags = new FfTags { language = "und" } };
    var variant = (await Search(UnnamedVoice(stream))).variants.Single();
    Require(ReleaseVoice(variant) == "Тайм Медиа Групп", "release studio was not carried to exact-file hydration");
    Require(variant.audio.Count == 1 && variant.audio[0].title == "Тайм Медиа Групп", "unnamed track label missing");
    Require(variant.audio[0].language == "und" && variant.audio[0].stream_index == 1 && stream.tags.title == null,
        "stream index, language, or original ffprobe was fabricated");
});
await Check("generic SoundHandler is not a studio name for one UND audio stream", async () =>
{
    var variant = (await Search(UnnamedVoice(new FfStream { index = 1, codec_type = "audio",
        tags = new FfTags { language = "und", handler_name = "SoundHandler" } }))).variants.Single();
    Require(variant.audio[0].title == "Тайм Медиа Групп", "generic container handler hid the named release studio");
});
await Check("release studio never overwrites a named or language-tagged audio stream", async () =>
{
    foreach (var tags in new[] { new FfTags { language = "und", title = "Verified voice" },
        new FfTags { language = "und", handler_name = "Verified handler" }, new FfTags { language = "eng" } })
    {
        var variant = (await Search(UnnamedVoice(new FfStream { index = 1, codec_type = "audio", tags = tags }))).variants.Single();
        Require(variant.audio[0].title == (tags.title ?? tags.handler_name ?? "eng"), "real audio metadata was overwritten");
    }
});
await Check("release studio does not fabricate tracks or assign one studio to multiple unnamed streams", async () =>
{
    var empty = (await Search(UnnamedVoice())).variants.Single();
    Require(empty.audio.Count == 0 && ReleaseVoice(empty) == "Тайм Медиа Групп", "cold catalog lost the credit or fabricated audio");
    var multiple = (await Search(UnnamedVoice(new FfStream { index = 1, codec_type = "audio" },
        new FfStream { index = 2, codec_type = "audio" }))).variants.Single();
    Require(multiple.audio.Count == 2 && multiple.audio.All(a => a.title == "und"), "ambiguous audio tracks were named from one credit");
});
await Check("unrecognized or multiple release credits do not become a single voice label", async () =>
{
    foreach (var title in new[] { "Fixture S02 / 2021 / WEBRip (1080p)",
        "Fixture S02 / ПМ (Studio One, Studio Two) / WEBRip", "Fixture S02 / ПМ (One) / ЛМ (Two) / WEBRip" })
    {
        var release = UnnamedVoice(new FfStream { index = 1, codec_type = "audio" }); release.Title = title;
        var variant = (await Search(release)).variants.Single();
        Require(string.IsNullOrEmpty(ReleaseVoice(variant)) && variant.audio[0].title == "und", "an ambiguous credit was guessed");
    }
});

await Check("cropped widescreen video retains its horizontal quality tier", async () =>
{
    foreach (var sample in new[] { (1920, 804, "1080p"), (1920, 800, "1080p"), (1280, 536, "720p"), (3840, 1600, "2160p") })
    {
        var torrent = Torrent(1);
        torrent.ffprobe = new() { new() { index = 0, codec_type = "video", codec_name = "h264", width = sample.Item1, height = sample.Item2 } };
        Require((await Search(torrent)).variants.Single().video.quality == sample.Item3, $"wrong tier for {sample.Item1}x{sample.Item2}");
    }
});
await Check("stereoscopic release is not chosen as an ordinary 2D copy", async () =>
{
    var response = await Search(Torrent(1, 100, "Fixture S02E01 3D HOU 1080p"), Torrent(2, 20, "Fixture S02E01 1080p"));
    Require(response.variants.Count == 1 && response.variants[0].replicas.Single().infohash == 2.ToString("x40"), "3D mixed into 2D choices");
});
await Check("voice releases are not lost behind a global 24-result quality limit", async () =>
{
    var response = await Search(Enumerable.Range(1, 40).Select(i => Torrent(i)).ToArray());
    Require(response.variants.Count == 40, "missing releases with distinct voices: " + response.variants.Count);
});
await Check("NextGen catalog does not activate GStreamer from old server settings", async () =>
{
    Require(!(await Search(Torrent(1))).gst, "old gst setting still enables transcoding");
});

object ProbeClient(FakeHandler handler)
{
    var type = typeof(Result).Assembly.GetType("PidTor.TorrentFileProbe");
    Require(type != null, "TorrentFileProbe is missing");
    return Activator.CreateInstance(type, "http://probe.fixture", new HttpClient(handler));
}
async Task<object> Probe(object client, string hash, int index, string trackers = "tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce")
{
    var task = (Task)client.GetType().GetMethod("ProbeAsync").Invoke(client, new object[] { hash, index, trackers });
    await task;
    return task.GetType().GetProperty("Result").GetValue(task);
}
int StreamCount(object result) => ((System.Collections.ICollection)result.GetType().GetProperty("streams").GetValue(result)).Count;
string Error(object result) => (string)result.GetType().GetProperty("error").GetValue(result);
string hash = new string('a', 40);
await Check("invalid hash never touches probe server", async () =>
{
    var handler = new FakeHandler(); var result = await Probe(ProbeClient(handler), "../../etc", 1);
    Require(StreamCount(result) == 0 && handler.Calls.Count == 0 && Error(result) != null, "invalid hash reached network");
});
await Check("metadata cached by exact file index", async () =>
{
    var handler = new FakeHandler(); var client = ProbeClient(handler);
    var one = await Probe(client, hash, 1); var repeated = await Probe(client, hash, 1); var two = await Probe(client, hash, 2);
    Require(StreamCount(one) == 2 && StreamCount(two) == 3, "wrong episode metadata");
    Require(handler.Calls.Count(c => c.Contains("/ffp/")) == 2, "cache ignored file index or repeated probe");
});
await Check("concurrent same-file requests share one ffprobe", async () =>
{
    var handler = new FakeHandler(); var client = ProbeClient(handler);
    await Task.WhenAll(Probe(client, hash, 1), Probe(client, hash, 1), Probe(client, hash, 1));
    Require(handler.Calls.Count(c => c.Contains("/ffp/")) == 1, "duplicate ffprobe started");
});
await Check("existing torrent is never re-added or deleted", async () =>
{
    var handler = new FakeHandler(); await Probe(ProbeClient(handler), hash, 1);
    Require(!handler.Bodies.Any(b => b.Contains("\"add\"") || b.Contains("\"rem\"")), "existing parser torrent modified");
});
await Check("missing file does not borrow another episode", async () =>
{
    var handler = new FakeHandler(); var result = await Probe(ProbeClient(handler), hash, 7);
    Require(StreamCount(result) == 0 && Error(result) != null, "borrowed wrong file");
    Require(!handler.Calls.Any(c => c.Contains("/ffp/")), "probed missing file");
});
await Check("failed probe does not expose raw server response", async () =>
{
    var handler = new FakeHandler { FailProbe = true }; var result = await Probe(ProbeClient(handler), hash, 1);
    Require(StreamCount(result) == 0 && Error(result) != null && !Error(result).Contains("fixture-secret"), "raw response exposed");
});
await Check("probe concurrency is limited to two", async () =>
{
    var handler = new FakeHandler(); var client = ProbeClient(handler);
    await Task.WhenAll(Enumerable.Range(1, 4).Select(i => Probe(client, i.ToString("x40"), 1)));
    Require(handler.MaxActive <= 2, "unbounded ffprobe concurrency");
});
await Check("new torrent is transient and private trackers are rejected", async () =>
{
    var handler = new FakeHandler { MissingTorrent = true };
    var result = await Probe(ProbeClient(handler), hash, 1, "tr=http%3A%2F%2F127.0.0.1%3A80%2Fadmin&tr=http%3A%2F%2F10.0.0.1%2Fadmin");
    Require(StreamCount(result) == 2, "new torrent was not probed");
    var added = handler.Bodies.First(body => body.Contains("\"add\""));
    using var json = JsonDocument.Parse(added);
    Require(!json.RootElement.GetProperty("save_to_db").GetBoolean(), "saved diagnostic torrent to DB");
    Require(!added.Contains("127.0.0.1") && !added.Contains("10.0.0.1"), "private tracker accepted");
});
await Check("unexpected upstream JSON is a safe failure", async () =>
{
    var handler = new FakeHandler { ScalarResponse = true };
    var result = await Probe(ProbeClient(handler), hash, 1);
    Require(StreamCount(result) == 0 && Error(result) != null, "unexpected JSON not handled");
});
await Check("torrent stays alive while cold ffprobe is pending", async () =>
{
    var handler = new FakeHandler { RequiresKeepAlive = true };
    var result = await Probe(ProbeClient(handler), hash, 1);
    Require(StreamCount(result) == 2, "torrent expired while ffprobe waited for data");
});
await Check("real ffprobe numeric level is accepted by parser models", async () =>
{
    var handler = new FakeHandler { NumericVideoLevel = true };
    var result = await Probe(ProbeClient(handler), hash, 1);
    Require(StreamCount(result) == 2, "real numeric ffprobe level rejected");
});
Console.WriteLine($"Backend: {total - failed}/{total} passed");
return failed == 0 ? 0 : 1;

sealed class FakeHandler : HttpMessageHandler
{
    public List<string> Calls = new();
    public List<string> Bodies = new();
    public bool FailProbe;
    public bool MissingTorrent;
    public bool ScalarResponse;
    public bool RequiresKeepAlive;
    public bool NumericVideoLevel;
    bool added;
    bool probing;
    readonly TaskCompletionSource keepAlive = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int MaxActive;
    int active;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Calls) Calls.Add(request.RequestUri.AbsolutePath);
        if (request.Content != null)
        {
            var body = await request.Content.ReadAsStringAsync(cancellationToken); lock (Bodies) Bodies.Add(body);
            if (probing && body.Contains("\"get\"")) keepAlive.TrySetResult();
            if (body.Contains("\"add\"")) added = true;
            if (MissingTorrent && !added) return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("not found") };
        }
        if (ScalarResponse) return Json("fixture-secret");
        if (request.RequestUri.AbsolutePath.Contains("/ffp/"))
        {
            if (RequiresKeepAlive)
            {
                probing = true;
                await Task.WhenAny(keepAlive.Task, Task.Delay(8000, cancellationToken));
                if (!keepAlive.Task.IsCompleted) return new HttpResponseMessage(HttpStatusCode.BadRequest);
            }
            int current = Interlocked.Increment(ref active); lock (Calls) MaxActive = Math.Max(MaxActive, current);
            await Task.Delay(35, cancellationToken); Interlocked.Decrement(ref active);
            if (FailProbe) return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("fixture-secret") };
            int count = request.RequestUri.AbsolutePath.EndsWith("/2") ? 3 : 2;
            return Json(new { streams = Enumerable.Range(0, count).Select(i => new { index = i, codec_type = i == 0 ? "video" : "audio", codec_name = i == 0 ? "h264" : "aac", level = NumericVideoLevel && i == 0 ? (int?)41 : null, tags = new { language = "rus", title = "Voice " + i } }) });
        }
        return Json(new { hash = new string('a', 40), file_stats = new[] { new { id = 1, path = "S02E01.mkv" }, new { id = 2, path = "S02E02.mkv" } } });
    }
    static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
}
