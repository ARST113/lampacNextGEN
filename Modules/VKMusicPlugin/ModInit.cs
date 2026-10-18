using Shared.Models.Module;
using System;

namespace VKMusicPlugin;

public class ModInit
{
    public static void loaded(InitspaceModel conf)
    {
        Console.WriteLine("VKMusicPlugin loaded");
    }

    public static void Dispose()
    {
        Console.WriteLine("VKMusicPlugin dispose");
    }
}
