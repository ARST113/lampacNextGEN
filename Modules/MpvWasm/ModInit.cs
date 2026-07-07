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
