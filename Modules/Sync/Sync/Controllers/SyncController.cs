using LampacSync.Shared;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shared;
using Shared.Attributes;
using Shared.Services;
using System.Web;

namespace Sync;

public class SyncController : BaseController
{
    #region sync.js
    [HttpGet, AllowAnonymous]
    [Staticache(cacheMinutes: 10)]
    [Route("sync.js")]
    [Route("sync/js/{token}")]
    public ActionResult SyncJS(string token, bool lite)
    {
        string plugin = (LampacSyncIdentity.ReadScript(ModInit.modpath) + "\n" +
            FileCache.ReadAllText($"{ModInit.modpath}/plugins/sync_v2/sync.js", "sync.js"))
            .Replace("{sync-invc}", FileCache.ReadAllText($"{ModInit.modpath}/plugins/sync-invc.js", "sync-invc.js"))
            .Replace("{localhost}", host)
            .Replace("{token}", HttpUtility.UrlEncode(token));

        return Content(plugin, "application/javascript; charset=utf-8");
    }
    #endregion

    [HttpGet]
    [Route("sync/account")]
    public ActionResult Account()
    {
        string uid = LampacSyncIdentity.Resolve(requestInfo, HttpContext);
        if (uid == null)
            return BadRequest(new { success = false, invalid_sync_id = true });
        return Json(new { success = true, user_uid = uid });
    }

    #region invc-ws.js
    [HttpGet, AllowAnonymous]
    [Staticache(cacheMinutes: 10)]
    [Route("invc-ws.js")]
    [Route("invc-ws/js/{token}")]
    public ActionResult InvcSyncJS(string token)
    {
        string plugin = (LampacSyncIdentity.ReadScript(ModInit.modpath) + "\n" +
            FileCache.ReadAllText($"{ModInit.modpath}/plugins/sync_v2/invc-ws.js", "invc-ws.js"))
            .Replace("{localhost}", host)
            .Replace("{token}", HttpUtility.UrlEncode(token));

        return Content(plugin, "application/javascript; charset=utf-8");
    }
    #endregion
}
