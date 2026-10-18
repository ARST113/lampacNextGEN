using Microsoft.AspNetCore.Http;
using Newtonsoft.Json.Linq;
using Shared.Models.Base;
using Shared.Models.Events;
using Shared.Models.Module;
using Shared.Models.Module.Interfaces;
using Shared.Services;
using System.Collections.Generic;
using Shared;

namespace Zetflix;

public class ModInit : IModuleLoaded, IModuleOnline, IModuleOnlineSpider
{
    public static ModuleConf conf;

    public List<ModuleOnlineItem> Invoke(HttpContext httpContext, RequestModel requestInfo, string host, OnlineEventsModel args)
    {
        return new List<ModuleOnlineItem>()
        {
            new(conf)
        };
    }

    public List<ModuleOnlineSpiderItem> Spider(HttpContext httpContext, RequestModel requestInfo, string host, OnlineSpiderModel args)
    {
        return new List<ModuleOnlineSpiderItem>()
        {
            new(conf, "zetflix-search")
        };
    }

    public void Loaded(InitspaceModel baseconf)
    {
        CoreInit.conf.online.with_search.Add("zetflix");

        updateConf();
        EventListener.UpdateInitFile += updateConf;
        EventListener.OnlineApiQuality += onlineApiQuality;
    }

    public void Dispose()
    {
        EventListener.UpdateInitFile -= updateConf;
        EventListener.OnlineApiQuality -= onlineApiQuality;
    }

    void updateConf()
    {
        conf = ModuleInvoke.Init("Zetflix", new ModuleConf("Zetflix", "https://apbugall.org/v2", "https://tories-as.stloadi.live", "5286c49a9d29cad731353b68d3f1f5", "", false, true)
        {
            enable = true,
            displayindex = 510,
            httpversion = 2,
            rch_access = "apk,cors,web",
            stream_access = "apk,cors,web",
            streamproxy = true,
            reserve = true
        });
    }

    string onlineApiQuality(EventOnlineApiQuality e)
    {
        bool m4s = conf.m4s;

        if (e.balanser == "zetflix" && e.kitconf != null && e.kitconf.TryGetValue("Zetflix", out JToken kit))
        {
            if (kit["m4s"] != null)
                m4s = kit.Value<bool>("m4s");
        }

        return e.balanser switch
        {
            "zetflix" => (m4s ? " ~ 2160p" : " ~ 1080p"),
            _ => null
        };
    }
}
