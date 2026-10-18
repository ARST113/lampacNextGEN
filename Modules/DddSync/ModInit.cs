using Shared.Models.Module;
using Shared.Models.Module.Interfaces;
using System.IO;

namespace DddSync;

public class ModInit : IModuleLoaded
{
    public static string modpath;
    public const string DataDir = "database/ddd-sync";

    public void Loaded(InitspaceModel baseconf)
    {
        modpath = baseconf.path;
        Directory.CreateDirectory(DataDir);
        DddSyncStore.Initialize(Path.Combine(DataDir, "progress.json"));
    }

    public void Dispose()
    {
    }
}
