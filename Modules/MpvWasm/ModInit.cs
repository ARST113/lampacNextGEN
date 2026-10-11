using Shared;
using Shared.Models.Events;
using Shared.Models.Module;
using Shared.Models.Module.Interfaces;
using Shared.Services;
using System.IO;

namespace MpvWasm;

public class ModInit : IModuleLoaded
{
    public static string modpath = string.Empty;
    public static ModuleConf conf = new();

    public void Loaded(InitspaceModel baseconf)
    {
        modpath = baseconf.path;
        UpdateConf();
        EventListener.UpdateInitFile += UpdateConf;

        if (conf.limit_map != null)
        {
            foreach (var m in conf.limit_map)
                CoreInit.conf.WAF.limit_map.Insert(0, m);
        }

        Directory.CreateDirectory(GetAssetsRoot());
        // Deploy lightweight audio-only scripts with the module. Reuse the existing
        // FFmpeg WASM binaries from the configured MpvWasm assets directory.
        foreach (var asset in new[]
        {
            "mpvwasm-audio-only-worker.js",
            "mpvwasm-audio-only-worklet.js"
        })
        {
            var source = Path.GetFullPath(Path.Combine(modpath, "assets", asset));
            var destination = Path.GetFullPath(Path.Combine(GetAssetsRoot(), asset));
            if (!File.Exists(source) ||
                string.Equals(source, destination, System.StringComparison.OrdinalIgnoreCase))
                continue;

            try { File.Copy(source, destination, overwrite: true); }
            catch (System.Exception exception)
            {
                Serilog.Log.Warning(exception, "MpvWasm audio asset deployment failed: {Asset}", asset);
            }
        }
    }

    public void Dispose()
    {
        EventListener.UpdateInitFile -= UpdateConf;
    }

    static void UpdateConf()
    {
        conf = ModuleInvoke.Init("mpvwasm", new ModuleConf
        {
            limit_map = ModuleConf.DefaultLimitMap()
        });
    }

    public static string GetAssetsRoot()
    {
        var path = string.IsNullOrWhiteSpace(conf.assetsPath)
            ? "plugins/mpvwasm"
            : conf.assetsPath.Trim();

        return Path.GetFullPath(path);
    }
}
