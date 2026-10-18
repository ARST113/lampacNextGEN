using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Shared.Models.Base;
using Shared;
using System.Reflection;
using System.Text.Json.Nodes;

int checks = 0;
void Check(bool passed, string name)
{
    if (!passed) throw new Exception(name);
    checks++;
}
DefaultHttpContext Context(string uid, string query = "")
{
    var context = new DefaultHttpContext();
    context.Request.QueryString = new QueryString(query);
    context.Features.Set(new RequestModel { user_uid = uid });
    return context;
}
string Resolve(DefaultHttpContext context) => (string)typeof(Sync.SyncController).Assembly
    .GetType("LampacSync.Shared.LampacSyncIdentity").GetMethod("Resolve", BindingFlags.Public | BindingFlags.Static)
    .Invoke(null, [context.Features.Get<RequestModel>(), context]);

CoreInit.conf.accsdb.users.Add(new AccsUser { id = "base-a", ids = ["basic-password-a"] });
CoreInit.conf.accsdb.users.Add(new AccsUser { id = "base-b" });
var basic = Context("base-a");
Check(Resolve(basic) == "base-a", "Basic mode must use the existing account namespace");
Check(Resolve(Context("base-b", "?sync_id=basic-password-a")) == "base-a", "A typed basic password must join its original namespace");
Check(Resolve(Context("base-b", "?sync_id=base-a")) == "base-a", "A typed basic UID must join its original namespace");
var own = Context("base-a", "?sync_id=family%20%2B%20%D1%82%D0%B5%D1%81%D1%82");
var other = Context("base-b", own.Request.QueryString.Value);
string group = Resolve(own);
Check(group == Resolve(other), "The same custom ID must join different login accounts");
Check(group.StartsWith("lampac-sync-") && group.Length == 76, "Only the hash belongs in the namespace");
Check(Resolve(Context("base-a", "?sync_id=other-family")) != group, "Different codes must be isolated");
Check(Resolve(Context(null, "?sync_id=family")) == null, "A custom ID must not bypass login");
Check(Resolve(Context("base-a", "?sync_id=")) == null, "An empty explicit ID is invalid");
Check(Resolve(Context("base-a", "?sync_id=a&sync_id=b")) == null, "Ambiguous IDs are invalid");
Check(Resolve(Context("base-a", "?sync_id=" + new string('a', 129))) == null, "Long IDs are invalid");
Check(Resolve(Context("base-a", "?sync_id=bad%00code")) == null, "Control characters are invalid");
Check(own.Features.Get<RequestModel>().user_uid == "base-a", "Sync selection must not change playback login");

var account = new Sync.SyncController { ControllerContext = new ControllerContext { HttpContext = own } };
var response = (JsonResult)account.Account();
var responseJson = System.Text.Json.JsonSerializer.SerializeToNode(response.Value);
Check(responseJson["success"].GetValue<bool>() && responseJson["user_uid"].GetValue<string>() == group, "Account endpoint must resolve the custom namespace");
Check(typeof(Sync.SyncController).GetMethod("Account").GetCustomAttribute<AllowAnonymousAttribute>() == null, "Account endpoint must remain protected");

string BookmarkUid(DefaultHttpContext context) => (string)typeof(Sync.BookmarkController)
    .GetMethod("getUserid", BindingFlags.NonPublic | BindingFlags.Static)
    .Invoke(null, [context.Features.Get<RequestModel>(), context]);
string TimecodeUid(DefaultHttpContext context)
{
    var controller = new TimeCode.TimeCodeController { ControllerContext = new ControllerContext { HttpContext = context } };
    return (string)typeof(TimeCode.TimeCodeController).GetMethod("getUserid", BindingFlags.NonPublic | BindingFlags.Instance)
        .Invoke(controller, [context.Features.Get<RequestModel>()]);
}
string StoragePath(DefaultHttpContext context, string profile = "")
{
    var controller = new Storage.StorageController { ControllerContext = new ControllerContext { HttpContext = context } };
    return (string)typeof(Storage.StorageController).GetMethod("getFilePath", BindingFlags.NonPublic | BindingFlags.Instance)
        .Invoke(controller, ["sync_view", profile, false, null]);
}
Check(BookmarkUid(own) == group && TimecodeUid(own) == group, "Bookmarks and timecodes must use the same custom namespace");
Check(StoragePath(own) == StoragePath(other) && StoragePath(own) != StoragePath(basic), "History namespace must match across logins and retain basic storage");
var profile = Context("base-a", own.Request.QueryString.Value + "&profile_id=kids");
Check(BookmarkUid(profile) == group + "_kids" && TimecodeUid(profile) == group + "_kids", "Profiles must isolate bookmark and timecode data consistently");
Check(StoragePath(own, "kids") != StoragePath(own), "History profiles must remain isolated");
Console.WriteLine($"Lampac sync backend: {checks} checks passed");
