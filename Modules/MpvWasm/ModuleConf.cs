using Shared.Models.AppConf;
using Shared.Models.Module;
using System;
using System.Collections.Generic;

namespace MpvWasm;

public class ModuleConf : ModuleBaseConf
{
    public bool enable { get; set; }

    public string assetsPath { get; set; } = "plugins/mpvwasm";

    public bool enableProxy { get; set; } = true;

    public bool enableHlsRewrite { get; set; } = true;

    public bool enableTestPage { get; set; } = true;

    public bool allowPrivateNetworks { get; set; } = true;

    public string[] allowedHosts { get; set; } = Array.Empty<string>();

    public string[] blockedHosts { get; set; } = Array.Empty<string>();

    public int timeoutSeconds { get; set; } = 30;

    public int maxRedirects { get; set; } = 5;

    public long maxManifestBytes { get; set; } = 5 * 1024 * 1024;

    public bool exposeCors { get; set; } = true;

    public bool crossOriginIsolationForTestPage { get; set; } = true;

    public bool allowCookieHeader { get; set; }

    public bool allowAuthorizationHeader { get; set; }

    public static List<WafLimitRootMap> DefaultLimitMap() =>
    [
        new("^/mpvwasm/", new WafLimitMap { limit = 80, second = 1 })
    ];
}
