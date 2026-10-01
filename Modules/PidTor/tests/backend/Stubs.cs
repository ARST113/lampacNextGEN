using System.Security.Cryptography;
using System.Text;
namespace Shared.Models.Online.Settings
{
    public class PidTorSettings
    {
        public string redapi = "http://fixture.invalid";
        public string apikey;
        public bool gst = true;
        public int min_sid = 15;
        public long max_size;
        public long max_serial_size;
    }
}
namespace Shared.Services
{
    public static class Http
    {
        public static PidTor.RootObject Result;
        public static Task<T> Get<T>(string url, int timeoutSeconds, bool textJson)
            => Task.FromResult((T)(object)Result);
    }
}
namespace Shared.Services.Utilities
{
    public static class CrypTo
    {
        public static string md5(string text) => Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    }
}
namespace PidTor
{
    public static class ModInit { public static int anime_min_sid = 2; }
    public static class AnimeTitleResolver
    {
        public static bool IsAnime(AnimeResolveRequest request) => request.anime;
        public static (string, string) SearchTitles(AnimeResolveRequest request, AnimeResolveResult resolved) => (request.title, request.original_title);
    }
    public static class TorrentTrackerFallback { public static string FromMagnet(string magnet) => "tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce"; }
}
