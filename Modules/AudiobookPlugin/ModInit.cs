using Shared.Models.Module;
using System;

namespace AudiobookPlugin
{
    public class ModInit
    {
        public static void loaded(InitspaceModel conf)
        {
            Console.WriteLine("AudiobookPlugin loaded");
        }

        public static void Dispose()
        {
            Console.WriteLine("AudiobookPlugin dispose");
        }
    }
}
