using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using Shared;
using Shared.Attributes;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace AdminPanel;

[Authorization(redirectUri: "/adminpanel/auth")]
public class AdminPanelController : BaseController
{
    const string InitFile = "init.conf";
    const string CurrentFile = "current.conf";
    const string UsersFile = "users.json";
    const string AdminKey = "_admin";
    static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

    static readonly JsonSerializerSettings CamelJson = new()
    {
        ContractResolver = new CamelCasePropertyNamesContractResolver(),
        NullValueHandling = NullValueHandling.Ignore
    };

    sealed class PluginInfo
    {
        public string id { get; set; }
        public string kind { get; set; }
        public string key { get; set; }
        public string url { get; set; }
        public string name { get; set; }
        public string author { get; set; }
        public string description { get; set; }
        public int status { get; set; }
        public bool builtin { get; set; }
        public bool profileSwitchable { get; set; } = true;
        public bool deletable { get; set; } = true;
        public JObject source { get; set; }
    }

    sealed class SourceSpec
    {
        public string key { get; init; }
        public string name { get; init; }
        public string group { get; init; }
        public string groupTitle { get; init; }
        public string moduleName { get; init; }
        public string[] configKeys { get; init; } = Array.Empty<string>();
        public bool disableEngFlag { get; init; }
        public bool master { get; init; }
    }

    [HttpGet]
    [AllowAnonymous]
    [Route("/adminpanel/auth")]
    public ActionResult Auth()
    {
        var path = Path.Combine(ModInit.modpath, "auth.html");
        var html = System.IO.File.ReadAllText(path, Encoding.UTF8);
        return Content(html, "text/html; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel")]
    public ActionResult Index()
    {
        var path = Path.Combine(ModInit.modpath, "index.html");
        var html = System.IO.File.ReadAllText(path, Encoding.UTF8);
        return Content(html, "text/html; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel/legacy")]
    public ActionResult Legacy()
    {
        var path = Path.Combine(ModInit.modpath, "index-legacy.html");
        var html = System.IO.File.ReadAllText(path, Encoding.UTF8);
        return Content(html, "text/html; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel/test")]
    public ActionResult Test()
    {
        var path = Path.Combine(ModInit.modpath, "index-combined-test.html");
        var html = System.IO.File.ReadAllText(path, Encoding.UTF8);
        return Content(html, "text/html; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel/api/overview")]
    public ActionResult Overview()
    {
        var users = LoadUsersArray();
        var plugins = LoadPluginInfos();
        var activePlugins = plugins.Count(p => p.status == 1);

        return JsonContent(new JObject
        {
            ["profiles"] = users.Count,
            ["plugins"] = plugins.Count,
            ["activePlugins"] = activePlugins,
            ["usersFile"] = UsersFile,
            ["initFile"] = InitFile
        });
    }

    [HttpGet]
    [Route("/adminpanel/api/profiles")]
    public ActionResult Profiles()
    {
        var users = LoadUsersArray();
        var plugins = LoadPluginInfos();
        return JsonContent(new JArray(users.OfType<JObject>().Select(u => BuildProfileDto(u, plugins))));
    }

    [HttpPost]
    [Route("/adminpanel/api/profiles")]
    public async Task<IActionResult> CreateProfile()
    {
        var body = await ReadBodyObjectAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        var id = CleanText(body.obj.Value<string>("id"));
        var name = CleanText(body.obj.Value<string>("name") ?? body.obj.Value<string>("comment"));
        if (string.IsNullOrWhiteSpace(id))
            return AdminJsonError(400, "profile id is required");
        if (string.IsNullOrWhiteSpace(name))
            return AdminJsonError(400, "profile name is required");

        var users = LoadUsersArray();
        if (FindUser(users, id) != null)
            return AdminJsonError(400, "profile already exists");

        var user = new JObject
        {
            ["id"] = id,
            ["ids"] = NormalizeIds(body.obj["ids"] as JArray, id),
            ["IsPasswd"] = false,
            ["expires"] = CleanText(body.obj.Value<string>("expires")) ?? "2099-12-31T23:59:59",
            ["group"] = ReadInt(body.obj, "group", 0),
            ["ban"] = ReadBool(body.obj, "ban", false),
            ["ban_msg"] = JValue.CreateNull(),
            ["comment"] = name
        };

        ApplyProfileAdmin(user, body.obj);
        users.Add(user);

        var backup = await SaveUsersArrayAsync(users).ConfigureAwait(false);
        return AdminJsonOk(backup);
    }

    [HttpPut, HttpPost]
    [Route("/adminpanel/api/profiles/{id}")]
    public async Task<IActionResult> UpdateProfile(string id)
    {
        var body = await ReadBodyObjectAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        var users = LoadUsersArray();
        var user = FindUser(users, id);
        if (user == null)
            return AdminJsonError(404, "profile not found");

        var newId = CleanText(body.obj.Value<string>("id"));
        var effectiveId = id;
        if (!string.IsNullOrWhiteSpace(newId) && !newId.Equals(id, StringComparison.OrdinalIgnoreCase))
        {
            if (FindUser(users, newId) != null)
                return AdminJsonError(400, "profile id already exists");

            user["id"] = newId;
            effectiveId = newId;
        }
        else if (!string.IsNullOrWhiteSpace(newId))
            effectiveId = newId;

        var name = CleanText(body.obj.Value<string>("name") ?? body.obj.Value<string>("comment"));
        if (!string.IsNullOrWhiteSpace(name))
            user["comment"] = name;

        if (body.obj.TryGetValue("expires", out var expires))
            user["expires"] = CleanText(expires.ToString());
        if (body.obj.TryGetValue("group", out _))
            user["group"] = ReadInt(body.obj, "group", 0);
        if (body.obj.TryGetValue("ban", out _))
            user["ban"] = ReadBool(body.obj, "ban", false);
        if (body.obj.TryGetValue("ban_msg", out var banMsg))
            user["ban_msg"] = banMsg.Type == JTokenType.Null ? JValue.CreateNull() : CleanText(banMsg.ToString());
        if (body.obj["ids"] is JArray ids)
            user["ids"] = NormalizeIds(ids, effectiveId);
        else
            user["ids"] = NormalizeIds(user["ids"] as JArray, effectiveId);
        if (body.obj.TryGetValue("IsPasswd", out _))
            user["IsPasswd"] = ReadBool(body.obj, "IsPasswd", false);

        ApplyProfileAdmin(user, body.obj);

        var backup = await SaveUsersArrayAsync(users).ConfigureAwait(false);
        return AdminJsonOk(backup);
    }

    [HttpDelete]
    [Route("/adminpanel/api/profiles/{id}")]
    public Task<IActionResult> DeleteProfile(string id) => DeleteProfileCore(id);

    [HttpPost]
    [Route("/adminpanel/api/profiles/{id}/delete")]
    public Task<IActionResult> DeleteProfilePost(string id) => DeleteProfileCore(id);

    async Task<IActionResult> DeleteProfileCore(string id)
    {
        var users = LoadUsersArray();
        if (users.Count <= 1)
            return AdminJsonError(400, "cannot delete the last profile");

        var user = FindUser(users, id);
        if (user == null)
            return AdminJsonError(404, "profile not found");

        users.Remove(user);
        var backup = await SaveUsersArrayAsync(users).ConfigureAwait(false);
        return AdminJsonOk(backup);
    }

    [HttpPut, HttpPost]
    [Route("/adminpanel/api/profiles/{profileId}/plugins")]
    public async Task<IActionResult> UpdateProfilePlugins(string profileId)
    {
        var body = await ReadBodyTokenAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        var users = LoadUsersArray();
        var user = FindUser(users, profileId);
        if (user == null)
            return AdminJsonError(404, "profile not found");

        var plugins = LoadPluginInfos();
        var map = EnsureAdminPlugins(user);

        if (body.token is JArray arr)
        {
            var enabled = new HashSet<string>(arr.Select(v => v.ToString()), StringComparer.OrdinalIgnoreCase);
            foreach (var plugin in plugins)
            {
                if (plugin.profileSwitchable)
                    map[plugin.id] = enabled.Contains(plugin.id);
            }
        }
        else if (body.token is JObject obj)
        {
            foreach (var prop in obj.Properties())
                map[prop.Name] = TokenBool(prop.Value, false);
        }
        else
            return AdminJsonError(400, "body must be an array or object");

        var backup = await SaveUsersArrayAsync(users).ConfigureAwait(false);
        return AdminJsonOk(backup);
    }

    [HttpGet]
    [Route("/adminpanel/api/plugins")]
    public ActionResult Plugins()
    {
        var users = LoadUsersArray();
        var plugins = LoadPluginInfos();
        return JsonContent(new JArray(plugins.Select(p => BuildPluginDto(p, users))));
    }

    [HttpGet]
    [Route("/adminpanel/api/sources")]
    public ActionResult Sources()
    {
        var init = LoadInitRoot();
        var current = LoadCurrentRoot();
        var sources = BuildSourceDtos(init, current);
        return JsonContent(new JArray(sources));
    }

    [HttpPut, HttpPost]
    [Route("/adminpanel/api/sources/{id}")]
    public async Task<IActionResult> UpdateSource(string id)
    {
        var body = await ReadBodyObjectAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        var spec = SourceSpecs.FirstOrDefault(s => string.Equals(s.key, id, StringComparison.OrdinalIgnoreCase));
        if (spec == null)
            return AdminJsonError(404, "source not found");

        var init = LoadInitRoot();
        var current = LoadCurrentRoot();
        var enabled = IsSourceEnabled(spec, init, current);
        if (body.obj.TryGetValue("enabled", out var enabledToken))
            enabled = TokenBool(enabledToken, enabled);
        else if (body.obj.TryGetValue("status", out var statusToken))
            enabled = TokenBool(statusToken, enabled);

        SetSourceState(init, spec, enabled);
        var backup = await SaveInitRootAsync(init).ConfigureAwait(false);
        return AdminJsonOk(backup);
    }

    [HttpPost]
    [Route("/adminpanel/api/plugins")]
    public async Task<IActionResult> CreatePlugin()
    {
        var body = await ReadBodyObjectAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        var init = LoadInitRoot();
        var arr = EnsureCustomPlugins(init);

        var url = CleanText(body.obj.Value<string>("url"));
        var validation = ValidatePluginInput(body.obj, arr, null);
        if (validation != null)
            return validation;

        var plugin = new JObject();
        ApplyPluginFields(plugin, body.obj);
        arr.Add(plugin);

        var initBackup = await SaveInitRootAsync(init).ConfigureAwait(false);

        if (body.obj["profiles"] is JArray profiles)
            await SavePluginProfilesAsync(PluginId(url), profiles).ConfigureAwait(false);

        return AdminJsonOk(initBackup);
    }

    [HttpPost]
    [Route("/adminpanel/api/plugins/upload-js")]
    [RequestSizeLimit(5_000_000)]
    public async Task<IActionResult> UploadJsPlugin()
    {
        if (!Request.HasFormContentType)
            return AdminJsonError(400, "multipart form data is required");

        var file = Request.Form.Files.GetFile("file") ?? Request.Form.Files.FirstOrDefault();
        if (file == null || file.Length <= 0)
            return AdminJsonError(400, "js file is required");
        if (file.Length > 5_000_000)
            return AdminJsonError(400, "js file is too large");

        var fileName = SafeJsUploadFileName(file.FileName);
        if (!fileName.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            return AdminJsonError(400, "only .js files can be uploaded");

        string content;
        using (var stream = file.OpenReadStream())
        using (var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true))
            content = await reader.ReadToEndAsync().ConfigureAwait(false);

        var validation = ValidateJsSyntax(content);
        if (!validation.ok)
            return AdminJsonError(400, "invalid javascript", validation.error);

        var root = AppRoot();
        var uploadDir = Path.GetFullPath(Path.Combine(root, "wwwroot", "lampac-js", "uploads"));
        var fullPath = Path.GetFullPath(Path.Combine(uploadDir, fileName));
        if (!IsUnder(fullPath, uploadDir))
            return AdminJsonError(400, "invalid file name");

        try
        {
            Directory.CreateDirectory(uploadDir);
            await NormalizeManagedDirectoryPermissionsAsync(uploadDir).ConfigureAwait(false);

            string backup = null;
            if (System.IO.File.Exists(fullPath))
                backup = BackupFile(fullPath);

            await System.IO.File.WriteAllTextAsync(fullPath, content, Utf8NoBom).ConfigureAwait(false);
            await NormalizeManagedFilePermissionsAsync(fullPath).ConfigureAwait(false);

            var result = new JObject
            {
                ["ok"] = true,
                ["url"] = "/lampac-js/uploads/" + fileName,
                ["path"] = ToRelativePath(fullPath),
                ["fileName"] = fileName,
                ["name"] = Path.GetFileNameWithoutExtension(fileName)
            };
            if (!string.IsNullOrWhiteSpace(backup))
                result["backup"] = ToRelativePath(backup);

            return JsonContent(result);
        }
        catch (IOException ex)
        {
            return AdminJsonError(500, "failed to upload plugin", ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            return AdminJsonError(500, "failed to upload plugin", ex.Message);
        }
    }

    [HttpPost]
    [Route("/adminpanel/api/profiles/upload-avatar")]
    [RequestSizeLimit(2_000_000)]
    public async Task<IActionResult> UploadProfileAvatar()
    {
        if (!Request.HasFormContentType)
            return AdminJsonError(400, "multipart form data is required");

        var file = Request.Form.Files.GetFile("file") ?? Request.Form.Files.FirstOrDefault();
        if (file == null || file.Length <= 0)
            return AdminJsonError(400, "avatar file is required");
        if (file.Length > 2_000_000)
            return AdminJsonError(400, "avatar file is too large");

        var ext = Path.GetExtension(file.FileName ?? string.Empty).ToLowerInvariant();
        if (ext != ".png" && ext != ".svg")
            return AdminJsonError(400, "only .png and .svg avatars can be uploaded");

        byte[] bytes;
        using (var stream = file.OpenReadStream())
        using (var ms = new MemoryStream())
        {
            await stream.CopyToAsync(ms).ConfigureAwait(false);
            bytes = ms.ToArray();
        }

        if (ext == ".png" && !IsPng(bytes))
            return AdminJsonError(400, "invalid png file");
        if (ext == ".svg" && !IsSafeSvg(bytes, out var svgError))
            return AdminJsonError(400, "invalid svg file", svgError);

        var fileName = SafeAvatarUploadFileName(file.FileName, ext);
        var root = AppRoot();
        var uploadDir = Path.GetFullPath(Path.Combine(root, "wwwroot", "lampac-profile-avatars"));
        var fullPath = Path.GetFullPath(Path.Combine(uploadDir, fileName));
        if (!IsUnder(fullPath, uploadDir))
            return AdminJsonError(400, "invalid file name");

        try
        {
            Directory.CreateDirectory(uploadDir);
            await NormalizeManagedDirectoryPermissionsAsync(uploadDir).ConfigureAwait(false);

            string backup = null;
            if (System.IO.File.Exists(fullPath))
                backup = BackupFile(fullPath);

            if (ext == ".svg")
                await System.IO.File.WriteAllTextAsync(fullPath, Encoding.UTF8.GetString(bytes), Utf8NoBom).ConfigureAwait(false);
            else
                await System.IO.File.WriteAllBytesAsync(fullPath, bytes).ConfigureAwait(false);

            await NormalizeManagedFilePermissionsAsync(fullPath).ConfigureAwait(false);

            var result = new JObject
            {
                ["ok"] = true,
                ["url"] = "/lampac-profile-avatars/" + fileName,
                ["path"] = ToRelativePath(fullPath),
                ["fileName"] = fileName
            };
            if (!string.IsNullOrWhiteSpace(backup))
                result["backup"] = ToRelativePath(backup);

            return JsonContent(result);
        }
        catch (IOException ex)
        {
            return AdminJsonError(500, "failed to upload avatar", ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            return AdminJsonError(500, "failed to upload avatar", ex.Message);
        }
    }

    [HttpPost]
    [Route("/adminpanel/api/modules/install")]
    [RequestSizeLimit(30_000_000)]
    public async Task<IActionResult> InstallModule()
    {
        string moduleName = null;
        string editorContent = null;
        string uploadName = null;
        byte[] uploadBytes = null;
        var autoRestart = true;

        if (Request.HasFormContentType)
        {
            moduleName = CleanText(Request.Form["name"].FirstOrDefault());
            editorContent = Request.Form["content"].FirstOrDefault();
            autoRestart = TokenBool(new JValue(Request.Form["autoRestart"].FirstOrDefault()), true);

            var file = Request.Form.Files.GetFile("file") ?? Request.Form.Files.FirstOrDefault();
            if (file != null && file.Length > 0)
            {
                if (file.Length > 30_000_000)
                    return AdminJsonError(400, "module file is too large");

                uploadName = file.FileName;
                using var ms = new MemoryStream();
                await file.CopyToAsync(ms).ConfigureAwait(false);
                uploadBytes = ms.ToArray();
            }
        }
        else
        {
            var body = await ReadBodyObjectAsync().ConfigureAwait(false);
            if (body.error != null)
                return body.error;

            moduleName = CleanText(body.obj.Value<string>("name"));
            editorContent = body.obj.Value<string>("content");
            autoRestart = ReadBool(body.obj, "autoRestart", true);
        }

        if ((uploadBytes == null || uploadBytes.Length == 0) && string.IsNullOrWhiteSpace(editorContent))
            return AdminJsonError(400, "module file or editor content is required");

        var result = await BuildAndInstallModuleAsync(moduleName, uploadName, uploadBytes, editorContent, autoRestart).ConfigureAwait(false);
        return JsonContent(result, result.Value<bool>("ok") ? 200 : 400);
    }

    [HttpPut, HttpPost]
    [Route("/adminpanel/api/plugins/{id}")]
    public async Task<IActionResult> UpdatePlugin(string id)
    {
        var body = await ReadBodyObjectAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        if (IsBuiltinPluginId(id))
            return await UpdateBuiltinPluginAsync(id, body.obj).ConfigureAwait(false);
        if (IsModulePluginId(id))
            return await UpdateModulePluginAsync(id, body.obj).ConfigureAwait(false);

        var init = LoadInitRoot();
        var arr = EnsureCustomPlugins(init);
        var plugin = FindPlugin(arr, id);
        if (plugin == null)
            return AdminJsonError(404, "plugin not found");

        var oldUrl = plugin.Value<string>("url");
        var oldId = PluginId(oldUrl);
        var validation = ValidatePluginInput(body.obj, arr, oldId);
        if (validation != null)
            return validation;

        ApplyPluginFields(plugin, body.obj);
        var newId = PluginId(plugin.Value<string>("url"));
        var initBackup = await SaveInitRootAsync(init).ConfigureAwait(false);

        if (!oldId.Equals(newId, StringComparison.OrdinalIgnoreCase))
        {
            var users = LoadUsersArray();
            foreach (var user in users.OfType<JObject>())
            {
                var map = EnsureAdminPlugins(user);
                if (map.TryGetValue(oldId, out var value))
                {
                    map[newId] = value.DeepClone();
                    map.Remove(oldId);
                }
            }
            await SaveUsersArrayAsync(users).ConfigureAwait(false);
        }

        if (body.obj["profiles"] is JArray profiles)
            await SavePluginProfilesAsync(newId, profiles).ConfigureAwait(false);

        return AdminJsonOk(initBackup);
    }

    [HttpDelete]
    [Route("/adminpanel/api/plugins/{id}")]
    public Task<IActionResult> DeletePlugin(string id) => DeletePluginCore(id);

    [HttpPost]
    [Route("/adminpanel/api/plugins/{id}/delete")]
    public Task<IActionResult> DeletePluginPost(string id) => DeletePluginCore(id);

    async Task<IActionResult> DeletePluginCore(string id)
    {
        if (IsBuiltinPluginId(id) || IsModulePluginId(id))
            return AdminJsonError(400, "standard plugin or module cannot be deleted");

        var init = LoadInitRoot();
        var arr = EnsureCustomPlugins(init);
        var plugin = FindPlugin(arr, id);
        if (plugin == null)
            return AdminJsonError(404, "plugin not found");

        arr.Remove(plugin);
        var initBackup = await SaveInitRootAsync(init).ConfigureAwait(false);

        var users = LoadUsersArray();
        foreach (var user in users.OfType<JObject>())
        {
            var map = GetAdmin(user, false)?["plugins"] as JObject;
            map?.Remove(id);
        }
        await SaveUsersArrayAsync(users).ConfigureAwait(false);

        return AdminJsonOk(initBackup);
    }

    [HttpPut, HttpPost]
    [Route("/adminpanel/api/plugins/{pluginId}/profiles")]
    public async Task<IActionResult> UpdatePluginProfiles(string pluginId)
    {
        var body = await ReadBodyTokenAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        JArray selected;
        if (body.token is JArray arr)
            selected = arr;
        else if (body.token is JObject obj && obj["profiles"] is JArray profiles)
            selected = profiles;
        else
            return AdminJsonError(400, "body must contain a profiles array");

        var backup = await SavePluginProfilesAsync(pluginId, selected).ConfigureAwait(false);
        return AdminJsonOk(backup);
    }

    [HttpPost]
    [Route("/adminpanel/api/lampac/restart")]
    public ActionResult RestartLampac()
    {
        _ = Task.Run(async () =>
        {
            await Task.Delay(500).ConfigureAwait(false);
            await RunCommandAsync("sudo", new[] { "systemctl", "restart", "lampac.service" }, 20_000).ConfigureAwait(false);
        });

        return JsonContent(new JObject
        {
            ["ok"] = true,
            ["message"] = "restart scheduled"
        });
    }

    [HttpGet]
    [Route("/adminpanel/api/lampac/status")]
    public async Task<ActionResult> LampacStatus()
    {
        var active = await RunCommandAsync("systemctl", new[] { "is-active", "lampac.service" }, 8_000).ConfigureAwait(false);
        var status = await RunCommandAsync("systemctl", new[] { "status", "lampac.service", "--no-pager", "-n", "12" }, 8_000).ConfigureAwait(false);

        return JsonContent(new JObject
        {
            ["active"] = active.output.Trim(),
            ["exitCode"] = active.exitCode,
            ["status"] = status.output.Trim()
        });
    }

    [HttpGet]
    [Route("/adminpanel/api/lampac/logs")]
    public async Task<ActionResult> LampacLogs(int lines = 200)
    {
        lines = Math.Clamp(lines, 20, 1000);
        var result = await RunCommandAsync("journalctl", new[] { "-u", "lampac.service", "--no-pager", "-n", lines.ToString() }, 10_000).ConfigureAwait(false);

        return JsonContent(new JObject
        {
            ["exitCode"] = result.exitCode,
            ["logs"] = result.output
        });
    }

    [HttpGet]
    [Route("/adminpanel/api/groups")]
    public ActionResult Groups()
    {
        var current = LoadCurrentRoot();
        var built = ConfigSectionGroups.Build(current);
        return Content(JsonConvert.SerializeObject(built, CamelJson), "application/json; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel/api/groups/catalog")]
    public ActionResult GroupsCatalog()
    {
        var built = ConfigSectionGroups.BuildCatalog();
        var current = LoadCurrentRoot();
        var inCatalog = ConfigSectionGroups.CatalogRootKeys;
        var orphans = current.Properties()
            .Select(p => p.Name)
            .Where(k => !inCatalog.Contains(k))
            .OrderBy(k => k, StringComparer.Ordinal)
            .ToArray();
        if (orphans.Length > 0)
            built.Add(new GroupDto("other", "Прочее", "Ключи из current, не из каталога групп.", orphans));

        return Content(JsonConvert.SerializeObject(built, CamelJson), "application/json; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel/api/init")]
    public ActionResult GetInit()
    {
        if (!System.IO.File.Exists(InitFile))
            return Content("{}", "application/json; charset=utf-8");

        var text = System.IO.File.ReadAllText(InitFile, Encoding.UTF8);
        return Content(NormalizeJsonText(text), "application/json; charset=utf-8");
    }

    [HttpGet]
    [Route("/adminpanel/api/current")]
    public ActionResult GetCurrent()
    {
        if (!System.IO.File.Exists(CurrentFile))
        {
            if (CoreInit.CurrentConf != null)
                return Content(CoreInit.CurrentConf.ToString(Formatting.Indented), "application/json; charset=utf-8");
            return Content("{}", "application/json; charset=utf-8");
        }

        var text = System.IO.File.ReadAllText(CurrentFile, Encoding.UTF8);
        return Content(NormalizeJsonText(text), "application/json; charset=utf-8");
    }

    [HttpPost]
    [Route("/adminpanel/api/init")]
    public async Task<IActionResult> SaveInit()
    {
        var body = await ReadBodyTokenAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        if (body.token.Type != JTokenType.Object)
            return AdminJsonError(400, "root must be a JSON object");

        try
        {
            var backup = await SaveInitRootAsync((JObject)body.token).ConfigureAwait(false);
            return AdminJsonOk(backup);
        }
        catch (IOException ex)
        {
            return AdminJsonError(500, "failed to write init.conf", ex.Message);
        }
    }

    [HttpPost]
    [Route("/adminpanel/api/init/section/{key}")]
    public async Task<IActionResult> SaveInitSection(string key)
    {
        if (string.IsNullOrWhiteSpace(key) || key.Contains('/') || key.Contains('\\'))
            return AdminJsonError(400, "invalid section key");

        var body = await ReadBodyTokenAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        try
        {
            var root = LoadInitRoot();
            root[key] = body.token.DeepClone();
            var backup = await SaveInitRootAsync(root).ConfigureAwait(false);
            return AdminJsonOk(backup);
        }
        catch (IOException ex)
        {
            return AdminJsonError(500, "failed to write init.conf", ex.Message);
        }
    }

    [HttpGet]
    [Route("/adminpanel/api/users-json")]
    public ActionResult GetUsersJson()
    {
        if (!System.IO.File.Exists(UsersFile))
            return Content("[]", "application/json; charset=utf-8");

        var text = System.IO.File.ReadAllText(UsersFile, Encoding.UTF8);
        if (string.IsNullOrWhiteSpace(text))
            return Content("[]", "application/json; charset=utf-8");

        return Content(NormalizeJsonText(text), "application/json; charset=utf-8");
    }

    [HttpPost]
    [Route("/adminpanel/api/users-json")]
    public async Task<IActionResult> SaveUsersJson()
    {
        var body = await ReadBodyTokenAsync().ConfigureAwait(false);
        if (body.error != null)
            return body.error;

        if (body.token.Type != JTokenType.Array)
            return AdminJsonError(400, "root must be a JSON array", "users.json must be a list of AccsUser objects");

        foreach (var item in (JArray)body.token)
        {
            if (item.Type != JTokenType.Object)
                return AdminJsonError(400, "invalid array item", "each element must be a JSON object");
        }

        try
        {
            var backup = await SaveUsersArrayAsync((JArray)body.token).ConfigureAwait(false);
            return AdminJsonOk(backup);
        }
        catch (IOException ex)
        {
            return AdminJsonError(500, "failed to write users.json", ex.Message);
        }
    }

    [HttpGet]
    [Route("/adminpanel/api/js-plugins")]
    public ActionResult JsPlugins()
    {
        return JsonContent(BuildJsPluginList());
    }

    [HttpGet]
    [Route("/adminpanel/api/js-plugin")]
    public ActionResult GetJsPlugin(string path)
    {
        if (!TryResolveJsPath(path, out var fullPath, out var relPath, out var error))
            return AdminJsonError(400, error);

        if (!System.IO.File.Exists(fullPath))
            return AdminJsonError(404, "file not found");

        var content = System.IO.File.ReadAllText(fullPath, Encoding.UTF8);
        var validation = ValidateJsSyntax(content);
        var info = new FileInfo(fullPath);

        return JsonContent(new JObject
        {
            ["path"] = relPath,
            ["content"] = content,
            ["size"] = info.Length,
            ["modified"] = info.LastWriteTimeUtc.ToString("o"),
            ["valid"] = validation.ok,
            ["error"] = validation.error
        });
    }

    [HttpPost]
    [Route("/adminpanel/api/js-plugin/validate")]
    public async Task<IActionResult> ValidateJsPlugin()
    {
        var body = await ReadRawBodyTextAsync().ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(body))
            return AdminJsonError(400, "empty body");

        var content = body;
        try
        {
            var parsed = JToken.Parse(body);
            if (parsed.Type == JTokenType.Object)
                content = ((JObject)parsed).Value<string>("content") ?? string.Empty;
        }
        catch (JsonException)
        {
        }

        var validation = ValidateJsSyntax(content);
        return JsonContent(new JObject
        {
            ["ok"] = validation.ok,
            ["error"] = validation.error
        });
    }

    [HttpPost]
    [Route("/adminpanel/api/js-plugin")]
    public async Task<IActionResult> SaveJsPlugin()
    {
        var body = await ReadRawBodyTextAsync().ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(body))
            return AdminJsonError(400, "empty body");

        JObject parsed;
        try
        {
            parsed = JObject.Parse(body);
        }
        catch (JsonException ex)
        {
            return AdminJsonError(400, "invalid json", ex.Message);
        }

        var path = parsed.Value<string>("path");
        var content = parsed.Value<string>("content");
        if (content == null)
            return AdminJsonError(400, "content is required");

        if (!TryResolveJsPath(path, out var fullPath, out var relPath, out var error))
            return AdminJsonError(400, error);

        if (!System.IO.File.Exists(fullPath))
            return AdminJsonError(404, "file not found");

        var validation = ValidateJsSyntax(content);
        if (!validation.ok)
            return AdminJsonError(400, "invalid javascript", validation.error);

        try
        {
            var backup = BackupFile(fullPath);
            await System.IO.File.WriteAllTextAsync(fullPath, content, Utf8NoBom).ConfigureAwait(false);

            return JsonContent(new JObject
            {
                ["ok"] = true,
                ["path"] = relPath,
                ["backup"] = ToRelativePath(backup)
            });
        }
        catch (IOException ex)
        {
            return AdminJsonError(500, "failed to write plugin", ex.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            return AdminJsonError(500, "failed to write plugin", ex.Message);
        }
    }

    async Task<string> ReadRawBodyTextAsync()
    {
        using var reader = new StreamReader(Request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        return await reader.ReadToEndAsync().ConfigureAwait(false);
    }

    static JArray BuildJsPluginList()
    {
        var list = new List<JObject>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void AddFile(string pathOrUrl, string name, string source, bool configured, int? status)
        {
            if (!TryResolveJsPath(pathOrUrl, out var fullPath, out var relPath, out _))
                return;
            if (!System.IO.File.Exists(fullPath))
                return;

            var existing = list.FirstOrDefault(x => string.Equals(x.Value<string>("path"), relPath, StringComparison.OrdinalIgnoreCase));
            if (existing != null)
            {
                if (configured)
                    existing["configured"] = true;
                if (!string.IsNullOrWhiteSpace(name))
                    existing["name"] = name;
                if (status.HasValue)
                    existing["status"] = status.Value;
                return;
            }
            if (!seen.Add(relPath.ToLowerInvariant()))
                return;

            var info = new FileInfo(fullPath);
            var item = new JObject
            {
                ["path"] = relPath,
                ["name"] = string.IsNullOrWhiteSpace(name) ? Path.GetFileNameWithoutExtension(fullPath) : name,
                ["source"] = source,
                ["url"] = ToPublicJsUrl(relPath),
                ["editablePath"] = relPath,
                ["configured"] = configured,
                ["size"] = info.Length,
                ["modified"] = info.LastWriteTimeUtc.ToString("o")
            };
            if (status.HasValue)
                item["status"] = status.Value;
            else
                item["status"] = JValue.CreateNull();
            list.Add(item);
        }

        void AddConfigured(JObject root, string source)
        {
            if (root?["LampaWeb"]?["customPlugins"] is not JArray arr)
                return;

            foreach (var token in arr.OfType<JObject>())
            {
                var url = token.Value<string>("url");
                if (string.IsNullOrWhiteSpace(url))
                    continue;
                AddFile(url, token.Value<string>("name"), source, true, ReadNullableInt(token, "status"));
            }
        }

        AddConfigured(LoadJsonObject(InitFile), "LampaWeb.customPlugins");
        AddConfigured(LoadCurrentRoot(), "current LampaWeb.customPlugins");
        foreach (var plugin in BuildBuiltinPluginInfos(LoadJsonObject(InitFile), LoadCurrentRoot()))
            AddFile(plugin.url, plugin.name, "LampaWeb.initPlugins", true, plugin.status);

        AddDirectory("wwwroot", "*.js", SearchOption.TopDirectoryOnly, "wwwroot", AddFile);
        AddDirectory(Path.Combine("wwwroot", "lampac-js"), "*.js", SearchOption.AllDirectories, "lampac-js", AddFile);
        AddDirectory("plugins", "*.js", SearchOption.TopDirectoryOnly, "plugins", AddFile);

        return new JArray(list
            .OrderByDescending(x => x.Value<bool>("configured"))
            .ThenBy(x => x.Value<string>("source"), StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.Value<string>("name"), StringComparer.OrdinalIgnoreCase));
    }

    static void AddDirectory(string dir, string pattern, SearchOption option, string source, Action<string, string, string, bool, int?> addFile)
    {
        if (!Directory.Exists(dir))
            return;

        foreach (var file in Directory.EnumerateFiles(dir, pattern, option).Take(300))
        {
            var rel = ToRelativePath(file);
            addFile(rel, null, source, false, null);
        }
    }

    static JObject LoadJsonObject(string path)
    {
        try
        {
            if (System.IO.File.Exists(path))
                return JObject.Parse(System.IO.File.ReadAllText(path, Encoding.UTF8));
        }
        catch (JsonException)
        {
        }

        return new JObject();
    }

    static int? ReadNullableInt(JObject obj, string key)
    {
        if (obj == null || !obj.TryGetValue(key, out var token) || token.Type == JTokenType.Null)
            return null;
        if (int.TryParse(token.ToString(), out var n))
            return n;
        return null;
    }

    static bool TryResolveJsPath(string path, out string fullPath, out string relPath, out string error)
    {
        fullPath = null;
        relPath = null;
        error = null;

        if (string.IsNullOrWhiteSpace(path))
        {
            error = "path is required";
            return false;
        }

        var clean = path.Trim();
        var q = clean.IndexOfAny(new[] { '?', '#' });
        if (q >= 0)
            clean = clean.Substring(0, q);

        if (clean.StartsWith("{localhost}/", StringComparison.OrdinalIgnoreCase))
            clean = "/" + clean.Substring("{localhost}/".Length);

        if (Uri.TryCreate(clean, UriKind.Absolute, out var uri))
        {
            if (IsLocalPluginHost(uri.Host))
                clean = uri.AbsolutePath;
            else
            {
                error = "external plugin urls are not editable";
                return false;
            }
        }
        else if (clean.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                 clean.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                 clean.StartsWith("//", StringComparison.Ordinal))
        {
            error = "external plugin urls are not editable";
            return false;
        }

        clean = clean.Replace('\\', '/');
        if (clean.Contains('\0') || clean.Split('/').Any(part => part == ".."))
        {
            error = "invalid path";
            return false;
        }

        var root = AppRoot();
        if (clean.StartsWith("/", StringComparison.Ordinal))
        {
            var trimmed = clean.TrimStart('/');
            var publicRel = Path.Combine("wwwroot", trimmed);
            var liveRel = Path.Combine("wwwroot", "lampac-live", trimmed);
            var moduleRel = ModulePluginRelForPublicJs(trimmed);
            if (System.IO.File.Exists(Path.Combine(root, publicRel)) || (string.IsNullOrWhiteSpace(moduleRel) && !System.IO.File.Exists(Path.Combine(root, liveRel))))
                clean = publicRel;
            else if (System.IO.File.Exists(Path.Combine(root, liveRel)))
                clean = liveRel;
            else
                clean = moduleRel ?? publicRel;
        }

        var candidate = Path.GetFullPath(Path.Combine(root, clean));
        if (!candidate.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
        {
            error = "only .js files are editable";
            return false;
        }

        if (!IsUnder(candidate, Path.Combine(root, "plugins")) &&
            !IsUnder(candidate, Path.Combine(root, "wwwroot")) &&
            !IsUnder(candidate, Path.Combine(root, "module")))
        {
            error = "path is outside editable plugin directories";
            return false;
        }

        fullPath = candidate;
        relPath = ToRelativePath(candidate);
        return true;
    }

    static bool IsLocalPluginHost(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
            return false;

        host = host.Trim().ToLowerInvariant();
        return host == "localhost" ||
               host == "127.0.0.1" ||
               host == "::1" ||
               host == "lampac.fun" ||
               host == "www.lampac.fun";
    }

    static string ToPublicJsUrl(string relPath)
    {
        if (string.IsNullOrWhiteSpace(relPath))
            return relPath;

        relPath = relPath.Replace('\\', '/');
        if (relPath.StartsWith("wwwroot/", StringComparison.OrdinalIgnoreCase))
            return "/" + relPath.Substring("wwwroot/".Length);

        return relPath;
    }

    static string ModulePluginRelForPublicJs(string publicPath)
    {
        if (string.IsNullOrWhiteSpace(publicPath))
            return null;

        return publicPath.Trim('/').ToLowerInvariant() switch
        {
            "dlna.js" => Path.Combine("module", "DLNA", "plugin.js"),
            "tracks.js" => Path.Combine("module", "Tracks", "plugin.js"),
            "transcoding.js" => Path.Combine("module", "Transcoding", "plugin.js"),
            "tmdbproxy.js" => Path.Combine("module", "Proxy", "TmdbProxy", "plugin.js"),
            "cubproxy.js" => Path.Combine("module", "Proxy", "CubProxy", "plugin.js"),
            "online.js" => Path.Combine("module", "Online", "plugin.js"),
            "watchtogether.js" => Path.Combine("module", "WatchTogether", "plugin.js"),
            "catalog.js" => Path.Combine("module", "Catalog", "plugin.js"),
            "sync.js" => Path.Combine("module", "Sync", "plugin.js"),
            "timecode.js" => Path.Combine("module", "Sync", "TimeCode", "plugin.js"),
            "ts.js" => Path.Combine("module", "TorrServer", "plugin.js"),
            _ => null
        };
    }

    async Task<JObject> BuildAndInstallModuleAsync(string requestedName, string uploadName, byte[] uploadBytes, string editorContent, bool autoRestart)
    {
        var root = AppRoot();
        var moduleRoot = Path.GetFullPath(Path.Combine(root, "module"));
        Directory.CreateDirectory(moduleRoot);

        var baseName = SafeModuleName(requestedName)
            ?? SafeModuleName(Path.GetFileNameWithoutExtension(uploadName ?? string.Empty))
            ?? "CustomModule";
        if (IsProtectedModule(baseName))
            return ModuleInstallError("protected module cannot be replaced", null);

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var stage = Path.GetFullPath(Path.Combine(moduleRoot, $"{baseName}.__install-{stamp}"));
        if (!IsUnder(stage, moduleRoot))
            return ModuleInstallError("invalid module name", null);

        Directory.CreateDirectory(stage);
        await NormalizeManagedDirectoryPermissionsAsync(stage).ConfigureAwait(false);

        try
        {
            if (uploadBytes != null && uploadBytes.Length > 0)
                WriteUploadedModuleToStage(stage, uploadName, uploadBytes, baseName);
            else
                WriteEditorModuleToStage(stage, baseName, editorContent);

            stage = NormalizeModuleStage(stage);
            var csproj = FindModuleProject(stage);
            if (string.IsNullOrWhiteSpace(csproj))
                return ModuleInstallError("module project file was not found", "Add a .csproj file to the ZIP or editor content.");

            var moduleName = SafeModuleName(requestedName) ?? SafeModuleName(Path.GetFileNameWithoutExtension(csproj));
            if (string.IsNullOrWhiteSpace(moduleName))
                return ModuleInstallError("invalid module name", null);
            if (IsProtectedModule(moduleName))
                return ModuleInstallError("protected module cannot be replaced", null);

            var build = await RunCommandAsync("dotnet", new[] { "build", csproj, "-v:minimal" }, 120_000).ConfigureAwait(false);
            if (build.exitCode != 0)
                return ModuleInstallError("module compilation failed", CleanBuildOutput(build.output, stage));

            var target = Path.GetFullPath(Path.Combine(moduleRoot, moduleName));
            if (!IsUnder(target, moduleRoot))
                return ModuleInstallError("invalid target module path", null);

            string backup = null;
            if (Directory.Exists(target))
            {
                backup = Path.GetFullPath(Path.Combine(moduleRoot, $"{moduleName}.bak-admin-{stamp}"));
                Directory.Move(target, backup);
            }

            Directory.Move(stage, target);
            stage = null;
            await NormalizeManagedTreePermissionsAsync(target).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(backup))
                await NormalizeManagedTreePermissionsAsync(backup).ConfigureAwait(false);

            var init = LoadInitRoot();
            SetModuleSkipState(init, moduleName, true);
            var initBackup = await SaveInitRootAsync(init).ConfigureAwait(false);

            if (autoRestart)
            {
                _ = Task.Run(async () =>
                {
                    await Task.Delay(700).ConfigureAwait(false);
                    await RunCommandAsync("sudo", new[] { "systemctl", "restart", "lampac.service" }, 20_000).ConfigureAwait(false);
                });
            }

            return new JObject
            {
                ["ok"] = true,
                ["moduleName"] = moduleName,
                ["path"] = ToRelativePath(target),
                ["backup"] = string.IsNullOrWhiteSpace(backup) ? null : ToRelativePath(backup),
                ["initBackup"] = initBackup,
                ["restarted"] = autoRestart,
                ["output"] = CleanBuildOutput(build.output, target)
            };
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException || ex is InvalidDataException)
        {
            return ModuleInstallError("failed to install module", ex.Message);
        }
        finally
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(stage) && Directory.Exists(stage))
                    Directory.Delete(stage, recursive: true);
            }
            catch
            {
            }
        }
    }

    static JObject ModuleInstallError(string error, string detail)
    {
        var o = new JObject
        {
            ["ok"] = false,
            ["error"] = error
        };
        if (!string.IsNullOrWhiteSpace(detail))
            o["detail"] = detail;
        return o;
    }

    static void WriteUploadedModuleToStage(string stage, string uploadName, byte[] uploadBytes, string moduleName)
    {
        var ext = Path.GetExtension(uploadName ?? string.Empty);
        if (ext.Equals(".zip", StringComparison.OrdinalIgnoreCase))
        {
            using var archive = new ZipArchive(new MemoryStream(uploadBytes), ZipArchiveMode.Read);
            foreach (var entry in archive.Entries)
            {
                if (string.IsNullOrWhiteSpace(entry.Name))
                    continue;

                var rel = entry.FullName.Replace('\\', '/');
                if (rel.StartsWith("/", StringComparison.Ordinal) || rel.Split('/').Any(x => x == ".." || x.Length == 0))
                    throw new InvalidDataException("zip contains an unsafe path: " + entry.FullName);

                var dest = Path.GetFullPath(Path.Combine(stage, rel));
                if (!IsUnder(dest, stage))
                    throw new InvalidDataException("zip contains a file outside module directory");

                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                entry.ExtractToFile(dest, overwrite: true);
            }
            return;
        }

        var fileName = Path.GetFileName(uploadName ?? string.Empty);
        if (string.IsNullOrWhiteSpace(fileName))
            fileName = moduleName + ".cs";
        fileName = SafeModuleFilePath(fileName);
        System.IO.File.WriteAllBytes(Path.Combine(stage, fileName), uploadBytes);
        if (!fileName.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            EnsureDefaultModuleProject(stage, moduleName);
    }

    static void WriteEditorModuleToStage(string stage, string moduleName, string content)
    {
        var files = ParseEditorModuleFiles(content);
        if (files.Count == 0)
            files[moduleName + ".cs"] = content ?? string.Empty;

        foreach (var pair in files)
        {
            var rel = SafeModuleFilePath(pair.Key);
            var dest = Path.GetFullPath(Path.Combine(stage, rel));
            if (!IsUnder(dest, stage))
                throw new InvalidDataException("editor contains an unsafe path: " + pair.Key);

            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            System.IO.File.WriteAllText(dest, pair.Value ?? string.Empty, Utf8NoBom);
        }

        EnsureDefaultModuleProject(stage, moduleName);
    }

    static Dictionary<string, string> ParseEditorModuleFiles(string content)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(content))
            return result;

        string current = null;
        var sb = new StringBuilder();
        foreach (var rawLine in content.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            var line = rawLine.Trim();
            var marker = TryReadFileMarker(line);
            if (!string.IsNullOrWhiteSpace(marker))
            {
                if (!string.IsNullOrWhiteSpace(current))
                    result[current] = sb.ToString();
                current = marker;
                sb.Clear();
                continue;
            }

            if (!string.IsNullOrWhiteSpace(current))
                sb.AppendLine(rawLine);
        }

        if (!string.IsNullOrWhiteSpace(current))
            result[current] = sb.ToString();

        return result;
    }

    static string TryReadFileMarker(string line)
    {
        var prefixes = new[] { "// FILE:", "# FILE:", "-- FILE:", "FILE:" };
        foreach (var prefix in prefixes)
        {
            if (line.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return CleanText(line.Substring(prefix.Length));
        }
        return null;
    }

    static string NormalizeModuleStage(string stage)
    {
        var project = FindModuleProject(stage);
        if (string.IsNullOrWhiteSpace(project))
            return stage;

        var projectDir = Path.GetDirectoryName(project);
        if (string.Equals(Path.GetFullPath(projectDir), Path.GetFullPath(stage), StringComparison.OrdinalIgnoreCase))
            return stage;

        var normalized = stage + ".normalized";
        if (Directory.Exists(normalized))
            Directory.Delete(normalized, recursive: true);
        CopyDirectory(projectDir, normalized);
        Directory.Delete(stage, recursive: true);
        Directory.Move(normalized, stage);
        return stage;
    }

    static string FindModuleProject(string stage)
    {
        if (!Directory.Exists(stage))
            return null;

        return Directory.EnumerateFiles(stage, "*.csproj", SearchOption.AllDirectories)
            .OrderBy(x => x.Count(ch => ch == Path.DirectorySeparatorChar || ch == Path.AltDirectorySeparatorChar))
            .ThenBy(x => x, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
    }

    static void EnsureDefaultModuleProject(string stage, string moduleName)
    {
        if (Directory.EnumerateFiles(stage, "*.csproj", SearchOption.TopDirectoryOnly).Any())
            return;

        var project = Path.Combine(stage, moduleName + ".csproj");
        System.IO.File.WriteAllText(project, $@"<Project Sdk=""Microsoft.NET.Sdk"">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <CopyLocalLockFileAssemblies>true</CopyLocalLockFileAssemblies>
  </PropertyGroup>

  <ItemGroup>
    <ProjectReference Include=""..\..\Shared\Shared.csproj"" />
    <ProjectReference Include=""..\..\Core\Core.csproj"" />
  </ItemGroup>

  <ItemGroup>
    <None Update=""manifest.json"">
      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    </None>
    <None Update=""plugin.js"">
      <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    </None>
  </ItemGroup>

</Project>
", Utf8NoBom);

        var manifest = Path.Combine(stage, "manifest.json");
        if (!System.IO.File.Exists(manifest))
            System.IO.File.WriteAllText(manifest, "{\n  \"enable\": true\n}\n", Utf8NoBom);
    }

    static string SafeModuleName(string name)
    {
        name = CleanText(name);
        if (string.IsNullOrWhiteSpace(name))
            return null;

        var sb = new StringBuilder();
        foreach (var ch in name)
        {
            if (ch <= 127 && (char.IsLetterOrDigit(ch) || ch == '_' || ch == '-' || ch == '.'))
                sb.Append(ch);
        }

        var clean = sb.ToString().Trim('.', '-', '_');
        return string.IsNullOrWhiteSpace(clean) ? null : clean;
    }

    static string SafeModuleFilePath(string path)
    {
        path = (path ?? string.Empty).Replace('\\', '/').Trim('/');
        if (string.IsNullOrWhiteSpace(path) || path.Split('/').Any(x => x == ".." || x.Length == 0))
            throw new InvalidDataException("invalid module file path");
        return path;
    }

    static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var dir in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(destination, Path.GetRelativePath(source, dir)));
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var dest = Path.Combine(destination, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            System.IO.File.Copy(file, dest, overwrite: true);
        }
    }

    static string CleanBuildOutput(string output, string path)
    {
        if (string.IsNullOrWhiteSpace(output))
            return string.Empty;

        var clean = output.Replace(Path.GetFullPath(path), "module").Trim();
        return clean.Length > 12_000 ? clean.Substring(clean.Length - 12_000) : clean;
    }

    static (bool ok, string error) ValidateJsSyntax(string content)
    {
        var node = FindNodePath();
        if (string.IsNullOrWhiteSpace(node))
            return (false, "node executable was not found for JavaScript validation");

        var temp = Path.Combine(Path.GetTempPath(), "lampac-admin-js-" + Guid.NewGuid().ToString("N") + ".js");
        try
        {
            System.IO.File.WriteAllText(temp, content ?? string.Empty, Utf8NoBom);
            var check = RunCommandAsync(node, new[] { "--check", temp }, 8_000).GetAwaiter().GetResult();
            if (check.exitCode == 0)
                return (true, null);

            return (false, CleanProcessMessage(check.output, temp));
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
        finally
        {
            try
            {
                if (System.IO.File.Exists(temp))
                    System.IO.File.Delete(temp);
            }
            catch
            {
            }
        }
    }

    static string FindNodePath()
    {
        var root = AppRoot();
        var candidates = new[]
        {
            "/usr/bin/node",
            "/usr/local/bin/node",
            Path.Combine(root, ".playwright", "node", "linux-x64", "node")
        };

        foreach (var candidate in candidates)
        {
            try
            {
                if (System.IO.File.Exists(candidate))
                    return candidate;
            }
            catch
            {
            }
        }

        return "node";
    }

    static string CleanProcessMessage(string message, string tempPath)
    {
        if (string.IsNullOrWhiteSpace(message))
            return "invalid javascript";

        var cleaned = message.Replace(tempPath, "plugin.js").Trim();
        return cleaned.Length > 4000 ? cleaned.Substring(0, 4000) : cleaned;
    }

    static string AppRoot() => Path.GetFullPath(Directory.GetCurrentDirectory());

    static string ToRelativePath(string path)
    {
        var rel = Path.GetRelativePath(AppRoot(), Path.GetFullPath(path));
        return rel.Replace('\\', '/');
    }

    static bool IsUnder(string fullPath, string rootPath)
    {
        var full = Path.GetFullPath(fullPath);
        var root = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    static JObject BuildProfileDto(JObject user, List<PluginInfo> plugins)
    {
        var id = user.Value<string>("id") ?? string.Empty;
        var admin = GetAdmin(user, false);
        var name = CleanText(admin?.Value<string>("name")) ?? CleanText(user.Value<string>("comment")) ?? id;
        var avatar = CleanText(admin?.Value<string>("avatar"));
        var activeCount = plugins.Count(p => p.profileSwitchable && IsPluginEnabledForProfile(user, p));

        return new JObject
        {
            ["id"] = id,
            ["name"] = name,
            ["comment"] = user["comment"]?.DeepClone(),
            ["avatar"] = avatar,
            ["expires"] = user["expires"]?.DeepClone(),
            ["group"] = user["group"]?.DeepClone(),
            ["ban"] = user["ban"]?.DeepClone() ?? new JValue(false),
            ["ban_msg"] = user["ban_msg"]?.DeepClone(),
            ["idsCount"] = user["ids"] is JArray ids ? ids.Count : 0,
            ["ids"] = user["ids"] is JArray idsArray ? idsArray.DeepClone() : new JArray(),
            ["activePlugins"] = activeCount,
            ["pluginMap"] = (admin?["plugins"] as JObject)?.DeepClone() ?? new JObject()
        };
    }

    static JObject BuildPluginDto(PluginInfo plugin, JArray users)
    {
        var profiles = new JArray();
        if (plugin.profileSwitchable)
        {
            foreach (var user in users.OfType<JObject>())
            {
                if (IsPluginEnabledForProfile(user, plugin))
                    profiles.Add(user.Value<string>("id") ?? string.Empty);
            }
        }

        var dto = new JObject
        {
            ["id"] = plugin.id,
            ["kind"] = plugin.kind ?? "custom",
            ["key"] = plugin.key,
            ["name"] = plugin.name,
            ["url"] = plugin.url,
            ["author"] = plugin.author,
            ["description"] = plugin.description,
            ["status"] = plugin.status,
            ["enabled"] = plugin.status == 1,
            ["builtin"] = plugin.builtin,
            ["profileSwitchable"] = plugin.profileSwitchable,
            ["deletable"] = plugin.deletable,
            ["profiles"] = profiles
        };

        if (TryResolveJsPath(plugin.url, out _, out var jsPath, out _))
        {
            dto["editablePath"] = jsPath;
            dto["publicUrl"] = ToPublicJsUrl(jsPath);
        }

        return dto;
    }

    static void ApplyProfileAdmin(JObject user, JObject body)
    {
        var admin = GetAdmin(user, true);
        var name = CleanText(body.Value<string>("name"));
        if (!string.IsNullOrWhiteSpace(name))
            admin["name"] = name;
        if (body.TryGetValue("avatar", out var avatar))
            admin["avatar"] = CleanText(avatar.ToString()) ?? string.Empty;
        if (admin["plugins"] == null || admin["plugins"].Type != JTokenType.Object)
            admin["plugins"] = new JObject();
    }

    static void ApplyPluginFields(JObject plugin, JObject body)
    {
        if (body.TryGetValue("name", out var name))
            plugin["name"] = CleanText(name.ToString());
        if (body.TryGetValue("url", out var url))
            plugin["url"] = CleanText(url.ToString());
        if (body.TryGetValue("author", out var author))
            plugin["author"] = CleanText(author.ToString()) ?? "admin";
        else if (plugin["author"] == null)
            plugin["author"] = "admin";
        if (body.TryGetValue("description", out var description))
            plugin["descr"] = CleanText(description.ToString()) ?? string.Empty;

        if (body.TryGetValue("enabled", out var enabled))
            plugin["status"] = TokenBool(enabled, true) ? 1 : 0;
        else if (body.TryGetValue("status", out var status))
            plugin["status"] = ReadInt(body, "status", 1) == 1 ? 1 : 0;
        else if (plugin["status"] == null)
            plugin["status"] = 1;
    }

    static IActionResult ValidatePluginInput(JObject body, JArray plugins, string currentId)
    {
        var name = CleanText(body.Value<string>("name"));
        var url = CleanText(body.Value<string>("url"));

        if (string.IsNullOrWhiteSpace(name))
            return AdminJsonError(400, "plugin name is required");
        if (string.IsNullOrWhiteSpace(url))
            return AdminJsonError(400, "plugin url is required");
        if (!IsAllowedPluginUrl(url))
            return AdminJsonError(400, "plugin url must start with http://, https://, / or {localhost}/");

        var newId = PluginId(url);
        foreach (var plugin in plugins.OfType<JObject>())
        {
            var existingId = PluginId(plugin.Value<string>("url"));
            if (!string.IsNullOrWhiteSpace(currentId) && existingId.Equals(currentId, StringComparison.OrdinalIgnoreCase))
                continue;
            if (newId.Equals(existingId, StringComparison.OrdinalIgnoreCase))
                return AdminJsonError(400, "plugin url already exists");
        }

        return null;
    }

    async Task<string> SavePluginProfilesAsync(string pluginId, JArray selectedProfiles)
    {
        var selected = new HashSet<string>(selectedProfiles.Select(v => v.ToString()), StringComparer.OrdinalIgnoreCase);
        var users = LoadUsersArray();

        foreach (var user in users.OfType<JObject>())
        {
            var id = user.Value<string>("id") ?? string.Empty;
            var map = EnsureAdminPlugins(user);
            map[pluginId] = selected.Contains(id);
        }

        return await SaveUsersArrayAsync(users).ConfigureAwait(false);
    }

    static bool IsPluginEnabledForProfile(JObject user, PluginInfo plugin)
    {
        if (!plugin.profileSwitchable)
            return plugin.status == 1;

        if (plugin.status != 1)
            return false;

        var map = GetAdmin(user, false)?["plugins"] as JObject;
        if (map == null || !map.TryGetValue(plugin.id, out var value))
            return true;

        return TokenBool(value, true);
    }

    static JArray NormalizeIds(JArray ids, string profileId)
    {
        var result = new JArray();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string value)
        {
            value = CleanText(value);
            if (string.IsNullOrWhiteSpace(value) || seen.Contains(value))
                return;

            seen.Add(value);
            result.Add(value);
        }

        Add(profileId);
        if (ids != null)
        {
            foreach (var token in ids)
                Add(token.ToString());
        }

        return result;
    }

    static JObject FindUser(JArray users, string id)
    {
        return users.OfType<JObject>().FirstOrDefault(u => string.Equals(u.Value<string>("id"), id, StringComparison.OrdinalIgnoreCase));
    }

    static JObject FindPlugin(JArray plugins, string id)
    {
        return plugins.OfType<JObject>().FirstOrDefault(p => PluginId(p.Value<string>("url")).Equals(id, StringComparison.OrdinalIgnoreCase));
    }

    static JArray EnsureCustomPlugins(JObject init)
    {
        var web = init["LampaWeb"] as JObject;
        if (web == null)
        {
            web = new JObject();
            init["LampaWeb"] = web;
        }

        var plugins = web["customPlugins"] as JArray;
        if (plugins == null)
        {
            plugins = new JArray();
            web["customPlugins"] = plugins;
        }

        return plugins;
    }

    static JObject GetAdmin(JObject user, bool create)
    {
        var admin = user[AdminKey] as JObject;
        if (admin == null && create)
        {
            admin = new JObject();
            user[AdminKey] = admin;
        }

        return admin;
    }

    static JObject EnsureAdminPlugins(JObject user)
    {
        var admin = GetAdmin(user, true);
        var plugins = admin["plugins"] as JObject;
        if (plugins == null)
        {
            plugins = new JObject();
            admin["plugins"] = plugins;
        }

        return plugins;
    }

    static List<PluginInfo> LoadPluginInfos()
    {
        var init = LoadInitRoot();
        var current = LoadCurrentRoot();
        var arr = init["LampaWeb"]?["customPlugins"] as JArray;
        if (arr == null)
            arr = new JArray();

        var result = new List<PluginInfo>();
        result.AddRange(BuildBuiltinPluginInfos(init, current));
        result.AddRange(arr.OfType<JObject>()
            .Select(p => new PluginInfo
            {
                id = PluginId(p.Value<string>("url")),
                kind = "custom",
                url = p.Value<string>("url") ?? string.Empty,
                name = p.Value<string>("name") ?? p.Value<string>("url") ?? "Plugin",
                author = p.Value<string>("author") ?? string.Empty,
                description = p.Value<string>("descr") ?? p.Value<string>("description") ?? string.Empty,
                status = ReadInt(p, "status", 1),
                builtin = false,
                profileSwitchable = true,
                deletable = true,
                source = p
            })
            .ToList());
        result.AddRange(LoadModulePluginInfos(init, current));
        return result;
    }

    static readonly string[] AnimeSourceKeys =
    {
        "AniLiberty", "AniLibria", "Animebesst", "AnimeGo", "AnimeLib", "AnimeON", "Animevost", "AniMedia", "Dreamerscast", "Kodik", "Mikai", "MoonAnime"
    };

    static readonly string[] UkrainianSourceKeys =
    {
        "Eneyida", "HdvbUA", "KinoUkr", "Kinoukr", "UAFilm", "UaKino"
    };

    static readonly string[] EnglishSourceKeys =
    {
        "Autoembed", "Hydraflix", "MovPI", "Playembed", "Rgshows", "Smashystream", "Twoembed", "VidLink", "Videasy", "Vidsrc",
        "AsiaGe", "Geosaitebi", "GetsTV", "iRemux", "LeProduction", "VeoVeo"
    };

    static readonly string[] RussianSourceKeys =
    {
        "Alloha", "Ashdi", "BamBoo", "CDNvideohub", "Collaps", "FanCDN", "Filmix", "FilmixPartner", "FilmixTV", "FlixCDN",
        "HDVB", "IptvOnline", "Kinobase", "Kinoflix", "Kinogo", "Kinotochka", "KinoPub", "Mirage", "Rezka", "RezkaPrem",
        "RutubeMovie", "Tortuga", "VideoDB", "Videoseed", "Vibix", "VkMovie", "VoKino"
    };

    static readonly SourceSpec[] SourceSpecs = BuildSourceSpecs();

    static SourceSpec[] BuildSourceSpecs()
    {
        var list = new List<SourceSpec>
        {
            new SourceSpec { key = "OnlineAnime", name = "Online Anime", group = "anime", groupTitle = "Аниме", moduleName = "OnlineAnime", configKeys = AnimeSourceKeys, master = true },
            new SourceSpec { key = "OnlineENG", name = "Online ENG", group = "english", groupTitle = "Английские", moduleName = "OnlineENG", configKeys = EnglishSourceKeys, disableEngFlag = true, master = true },
            new SourceSpec { key = "OnlineUKR", name = "Online UKR", group = "ukrainian", groupTitle = "Украинские", moduleName = "OnlineUKR", configKeys = UkrainianSourceKeys, master = true },
            new SourceSpec { key = "OnlineRUS", name = "Online RUS", group = "russian", groupTitle = "Русские", moduleName = "OnlineRUS", configKeys = RussianSourceKeys, master = true }
        };

        list.AddRange(AnimeSourceKeys.Select(k => Source(k, "anime", "Аниме", "OnlineAnime")));
        list.AddRange(EnglishSourceKeys.Select(k => Source(k, "english", "Английские", "OnlineENG")));
        list.AddRange(UkrainianSourceKeys.Select(k => Source(k, "ukrainian", "Украинские", "OnlineUKR")));
        list.AddRange(RussianSourceKeys.Select(k => Source(k, "russian", "Русские", "OnlineRUS")));
        return list.ToArray();
    }

    static SourceSpec Source(string key, string group, string groupTitle, string moduleName)
    {
        return new SourceSpec { key = key, name = key, group = group, groupTitle = groupTitle, moduleName = moduleName, configKeys = new[] { key } };
    }

    static IEnumerable<JObject> BuildSourceDtos(JObject init, JObject current)
    {
        foreach (var spec in SourceSpecs)
        {
            if (!ShouldShowSource(spec, init, current))
                continue;

            var enabled = IsSourceEnabled(spec, init, current);
            yield return new JObject
            {
                ["id"] = spec.key,
                ["key"] = spec.key,
                ["name"] = spec.name,
                ["group"] = spec.group,
                ["groupTitle"] = spec.groupTitle,
                ["moduleName"] = spec.moduleName,
                ["master"] = spec.master,
                ["enabled"] = enabled,
                ["status"] = enabled ? 1 : 0,
                ["configKeys"] = new JArray(spec.configKeys ?? Array.Empty<string>())
            };
        }
    }

    static bool ShouldShowSource(SourceSpec spec, JObject init, JObject current)
    {
        if (spec.master)
            return string.IsNullOrWhiteSpace(spec.moduleName)
                || Directory.Exists(Path.Combine("module", spec.moduleName))
                || spec.disableEngFlag
                || spec.configKeys.Any(key => init[key] != null || current[key] != null);

        return spec.configKeys.Any(key => init[key] != null || current[key] != null);
    }

    static bool IsSourceEnabled(SourceSpec spec, JObject init, JObject current)
    {
        var skipped = LoadSkippedModules(init, current);
        var enabled = true;

        if (!string.IsNullOrWhiteSpace(spec.moduleName) && skipped.Contains(spec.moduleName))
            enabled = false;

        if (spec.disableEngFlag)
        {
            var disableEng = ReadRootBool(current, "disableEng", false);
            disableEng = ReadRootBool(init, "disableEng", disableEng);
            if (disableEng)
                enabled = false;
        }

        if (!spec.master && spec.configKeys.Length > 0)
        {
            enabled = true;
            foreach (var key in spec.configKeys)
            {
                var sourceEnabled = ReadSourceEnabled(current, key, true);
                sourceEnabled = ReadSourceEnabled(init, key, sourceEnabled);
                enabled &= sourceEnabled;
            }
        }

        return enabled;
    }

    static void SetSourceState(JObject init, SourceSpec spec, bool enabled)
    {
        if (spec.master && !string.IsNullOrWhiteSpace(spec.moduleName))
            SetModuleSkipState(init, spec.moduleName, enabled);
        else if (enabled && !string.IsNullOrWhiteSpace(spec.moduleName))
            SetModuleSkipState(init, spec.moduleName, true);

        if (spec.disableEngFlag)
            init["disableEng"] = !enabled;

        foreach (var key in spec.configKeys ?? Array.Empty<string>())
            SetSourceConfigState(init, key, enabled);
    }

    static void SetLinkedSourcesForModule(JObject init, string moduleName, bool enabled)
    {
        foreach (var spec in SourceSpecs.Where(s => s.master && string.Equals(s.moduleName, moduleName, StringComparison.OrdinalIgnoreCase)))
            SetSourceState(init, spec, enabled);
    }

    static bool ReadRootBool(JObject root, string key, bool fallback)
    {
        return root.TryGetValue(key, out var value) ? TokenBool(value, fallback) : fallback;
    }

    static bool ReadSourceEnabled(JObject root, string key, bool fallback)
    {
        var section = root[key] as JObject;
        if (section == null)
            return fallback;
        if (section.TryGetValue("enable", out var enable))
            return TokenBool(enable, fallback);
        if (section.TryGetValue("enabled", out var enabled))
            return TokenBool(enabled, fallback);
        return fallback;
    }

    static void SetSourceConfigState(JObject init, string key, bool enabled)
    {
        if (string.IsNullOrWhiteSpace(key))
            return;

        var section = init[key] as JObject;
        if (section == null)
        {
            section = new JObject();
            init[key] = section;
        }

        section["enable"] = enabled;
        section["enabled"] = enabled;
    }

    static readonly (string key, string url, string name)[] BuiltinPluginDefs = new[]
    {
        ("dlna", "{localhost}/dlna.js", "DLNA"),
        ("tracks", "{localhost}/tracks.js", "Tracks"),
        ("transcoding", "{localhost}/transcoding.js", "Transcoding"),
        ("tmdbProxy", "{localhost}/tmdbproxy.js", "TMDB Proxy"),
        ("cubProxy", "{localhost}/cubproxy.js", "CUB Proxy"),
        ("online", "{localhost}/online.js", "Online"),
        ("watch_together", "{localhost}/watchtogether.js", "Watch Together"),
        ("catalog", "{localhost}/catalog.js", "Catalog"),
        ("dorama", "{localhost}/dorama.js", "Dorama"),
        ("sisi", "{localhost}/sisi.js", "SISI"),
        ("sisi", "{localhost}/startpage.js", "Start Page"),
        ("sync", "{localhost}/sync.js", "Sync"),
        ("timecode", "{localhost}/timecode.js", "Timecode Sync"),
        ("bookmark", "{localhost}/bookmark.js", "Bookmark Sync"),
        ("torrserver", "{localhost}/ts.js", "TorrServer"),
        ("backup", "{localhost}/backup.js", "Backup")
    };

    static readonly (string pluginKey, string moduleName)[] BuiltinModuleLinks = new[]
    {
        ("dlna", "DLNA"),
        ("tracks", "Tracks"),
        ("transcoding", "Transcoding"),
        ("online", "Online"),
        ("watch_together", "WatchTogether"),
        ("catalog", "Catalog"),
        ("sisi", "SISI"),
        ("sync", "Sync"),
        ("torrserver", "TorrServer")
    };

    static List<PluginInfo> BuildBuiltinPluginInfos(JObject init, JObject current)
    {
        var skipped = LoadSkippedModules(init, current);
        return BuiltinPluginDefs.Select(def =>
        {
            var enabled = ReadBuiltinPluginEnabled(init, current, def.key);
            foreach (var moduleName in LinkedModulesForBuiltin(def.key))
            {
                if (skipped.Contains(moduleName))
                    enabled = false;
            }

            return new PluginInfo
            {
                id = PluginId(def.url),
                kind = "builtin",
                key = def.key,
                url = def.url,
                name = def.name,
                author = "lampac",
                description = "Standard LampaWeb plugin",
                status = enabled ? 1 : 0,
                builtin = true,
                profileSwitchable = true,
                deletable = false
            };
        }).ToList();
    }

    static bool ReadBuiltinPluginEnabled(JObject init, JObject current, string key)
    {
        var initPlugins = init["LampaWeb"]?["initPlugins"] as JObject;
        var currentPlugins = current["LampaWeb"]?["initPlugins"] as JObject;
        var enabled = true;

        if (currentPlugins != null && currentPlugins.TryGetValue(key, out var currentValue))
            enabled = TokenBool(currentValue, enabled);
        if (initPlugins != null && initPlugins.TryGetValue(key, out var initValue))
            enabled = TokenBool(initValue, enabled);

        return enabled;
    }

    async Task<IActionResult> UpdateBuiltinPluginAsync(string id, JObject body)
    {
        var init = LoadInitRoot();
        var current = LoadCurrentRoot();
        var plugin = BuildBuiltinPluginInfos(init, current).FirstOrDefault(p => p.id.Equals(id, StringComparison.OrdinalIgnoreCase));
        if (plugin == null)
            return AdminJsonError(404, "standard plugin not found");

        var enabled = plugin.status == 1;
        if (body.TryGetValue("enabled", out var enabledToken))
            enabled = TokenBool(enabledToken, enabled);
        else if (body.TryGetValue("status", out var statusToken))
            enabled = TokenBool(statusToken, enabled);

        var web = EnsureLampaWeb(init);
        var initPlugins = web["initPlugins"] as JObject;
        if (initPlugins == null)
        {
            initPlugins = new JObject();
            web["initPlugins"] = initPlugins;
        }

        initPlugins[plugin.key] = enabled;
        foreach (var moduleName in LinkedModulesForBuiltin(plugin.key))
            SetModuleSkipState(init, moduleName, enabled);

        var initBackup = await SaveInitRootAsync(init).ConfigureAwait(false);

        if (body["profiles"] is JArray profiles)
            await SavePluginProfilesAsync(id, profiles).ConfigureAwait(false);

        return AdminJsonOk(initBackup);
    }

    static bool IsBuiltinPluginId(string id)
    {
        if (string.IsNullOrWhiteSpace(id))
            return false;
        return BuiltinPluginDefs.Any(def => PluginId(def.url).Equals(id, StringComparison.OrdinalIgnoreCase));
    }

    static IEnumerable<PluginInfo> LoadModulePluginInfos(JObject init, JObject current)
    {
        var result = new List<PluginInfo>();
        if (!Directory.Exists("module"))
            return result;

        var skipped = LoadSkippedModules(init, current);
        foreach (var dir in Directory.GetDirectories("module").OrderBy(v => v, StringComparer.OrdinalIgnoreCase))
        {
            var moduleName = new DirectoryInfo(dir).Name;
            if (IsProtectedModule(moduleName) || IsHiddenModuleDirectory(moduleName))
                continue;

            var displayName = moduleName;
            var author = "lampac";
            var description = "Lampac module";
            var manifest = Path.Combine(dir, "manifest.json");
            if (System.IO.File.Exists(manifest))
            {
                try
                {
                    var obj = JObject.Parse(System.IO.File.ReadAllText(manifest, Encoding.UTF8));
                    displayName = CleanText(obj.Value<string>("name")) ?? displayName;
                    author = CleanText(obj.Value<string>("author")) ?? author;
                    description = CleanText(obj.Value<string>("descr") ?? obj.Value<string>("description")) ?? description;
                }
                catch
                {
                }
            }

            var enabled = !skipped.Contains(moduleName);
            foreach (var pluginKey in LinkedBuiltinKeysForModule(moduleName))
            {
                if (!ReadBuiltinPluginEnabled(init, current, pluginKey))
                    enabled = false;
            }
            foreach (var spec in SourceSpecs.Where(s => s.master && string.Equals(s.moduleName, moduleName, StringComparison.OrdinalIgnoreCase)))
            {
                if (!IsSourceEnabled(spec, init, current))
                    enabled = false;
            }

            result.Add(new PluginInfo
            {
                id = ModulePluginId(moduleName),
                kind = "module",
                key = moduleName,
                url = "module/" + moduleName,
                name = displayName,
                author = author,
                description = description,
                status = enabled ? 1 : 0,
                builtin = false,
                profileSwitchable = false,
                deletable = false
            });
        }

        return result;
    }

    static HashSet<string> LoadSkippedModules(JObject init, JObject current)
    {
        var skipped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var arr = init["BaseModule"]?["SkipModules"] as JArray;
        if (arr == null)
            arr = current["BaseModule"]?["SkipModules"] as JArray;
        if (arr != null)
        {
            foreach (var token in arr)
            {
                var value = CleanText(token.ToString());
                if (!string.IsNullOrWhiteSpace(value))
                    skipped.Add(value);
            }
        }

        return skipped;
    }

    async Task<IActionResult> UpdateModulePluginAsync(string id, JObject body)
    {
        var moduleName = ModulePluginName(id);
        if (!IsSafeModuleName(moduleName) || IsProtectedModule(moduleName) || !Directory.Exists(Path.Combine("module", moduleName)))
            return AdminJsonError(404, "module not found");

        var init = LoadInitRoot();
        var current = LoadCurrentRoot();
        var skipped = LoadSkippedModules(init, current);
        var enabled = !skipped.Contains(moduleName);

        if (body.TryGetValue("enabled", out var enabledToken))
            enabled = TokenBool(enabledToken, enabled);
        else if (body.TryGetValue("status", out var statusToken))
            enabled = TokenBool(statusToken, enabled);

        SetModuleSkipState(init, moduleName, enabled);
        foreach (var pluginKey in LinkedBuiltinKeysForModule(moduleName))
            SetBuiltinInitPluginState(init, pluginKey, enabled);
        SetLinkedSourcesForModule(init, moduleName, enabled);

        var initBackup = await SaveInitRootAsync(init).ConfigureAwait(false);
        return AdminJsonOk(initBackup);
    }

    static bool IsModulePluginId(string id) => !string.IsNullOrWhiteSpace(id) && id.StartsWith("module:", StringComparison.OrdinalIgnoreCase);

    static string ModulePluginId(string moduleName) => "module:" + moduleName;

    static string ModulePluginName(string id) => IsModulePluginId(id) ? id.Substring("module:".Length) : null;

    static IEnumerable<string> LinkedModulesForBuiltin(string pluginKey)
    {
        return BuiltinModuleLinks
            .Where(x => string.Equals(x.pluginKey, pluginKey, StringComparison.OrdinalIgnoreCase))
            .Select(x => x.moduleName);
    }

    static IEnumerable<string> LinkedBuiltinKeysForModule(string moduleName)
    {
        return BuiltinModuleLinks
            .Where(x => string.Equals(x.moduleName, moduleName, StringComparison.OrdinalIgnoreCase))
            .Select(x => x.pluginKey)
            .Distinct(StringComparer.OrdinalIgnoreCase);
    }

    static void SetModuleSkipState(JObject init, string moduleName, bool enabled)
    {
        if (!IsSafeModuleName(moduleName) || !Directory.Exists(Path.Combine("module", moduleName)))
            return;

        var baseModule = EnsureBaseModule(init);
        var skipModules = EnsureStringArray(baseModule, "SkipModules");
        foreach (var token in skipModules.Where(v => string.Equals(v.ToString(), moduleName, StringComparison.OrdinalIgnoreCase)).ToList())
            token.Remove();

        if (!enabled)
            skipModules.Add(moduleName);
    }

    static void SetBuiltinInitPluginState(JObject init, string key, bool enabled)
    {
        var web = EnsureLampaWeb(init);
        var initPlugins = web["initPlugins"] as JObject;
        if (initPlugins == null)
        {
            initPlugins = new JObject();
            web["initPlugins"] = initPlugins;
        }

        initPlugins[key] = enabled;
    }

    static bool IsSafeModuleName(string moduleName)
    {
        return !string.IsNullOrWhiteSpace(moduleName) &&
               moduleName.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 &&
               moduleName.IndexOf('/') < 0 &&
               moduleName.IndexOf('\\') < 0;
    }

    static bool IsProtectedModule(string moduleName)
    {
        return string.Equals(moduleName, "AdminPanel", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(moduleName, "LampaWeb", StringComparison.OrdinalIgnoreCase);
    }

    static bool IsHiddenModuleDirectory(string moduleName)
    {
        return string.IsNullOrWhiteSpace(moduleName) ||
               moduleName.Contains(".__install-", StringComparison.OrdinalIgnoreCase) ||
               moduleName.Contains(".bak-", StringComparison.OrdinalIgnoreCase) ||
               moduleName.Contains(".bak-admin-", StringComparison.OrdinalIgnoreCase);
    }

    static JObject EnsureLampaWeb(JObject init)
    {
        var web = init["LampaWeb"] as JObject;
        if (web == null)
        {
            web = new JObject();
            init["LampaWeb"] = web;
        }

        return web;
    }

    static JObject EnsureBaseModule(JObject init)
    {
        var baseModule = init["BaseModule"] as JObject;
        if (baseModule == null)
        {
            baseModule = new JObject();
            init["BaseModule"] = baseModule;
        }

        return baseModule;
    }

    static JArray EnsureStringArray(JObject obj, string key)
    {
        var arr = obj[key] as JArray;
        if (arr == null)
        {
            arr = new JArray();
            obj[key] = arr;
        }

        return arr;
    }

    static JArray LoadUsersArray()
    {
        if (!System.IO.File.Exists(UsersFile))
            return new JArray();

        var text = System.IO.File.ReadAllText(UsersFile, Encoding.UTF8);
        if (string.IsNullOrWhiteSpace(text))
            return new JArray();

        try
        {
            return JArray.Parse(text);
        }
        catch
        {
            return new JArray();
        }
    }

    static JObject LoadInitRoot()
    {
        if (!System.IO.File.Exists(InitFile))
            return new JObject();

        try
        {
            return JObject.Parse(System.IO.File.ReadAllText(InitFile, Encoding.UTF8));
        }
        catch
        {
            return new JObject();
        }
    }

    static JObject LoadCurrentRoot()
    {
        try
        {
            if (System.IO.File.Exists(CurrentFile))
                return JObject.Parse(System.IO.File.ReadAllText(CurrentFile, Encoding.UTF8));
        }
        catch (JsonException)
        {
        }

        if (CoreInit.CurrentConf != null)
        {
            try
            {
                return (JObject)CoreInit.CurrentConf.DeepClone();
            }
            catch
            {
            }
        }

        return new JObject();
    }

    async Task<(JToken token, IActionResult error)> ReadBodyTokenAsync()
    {
        string body;
        using (var reader = new StreamReader(Request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true))
            body = await reader.ReadToEndAsync().ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(body))
            return (null, AdminJsonError(400, "empty body"));

        try
        {
            return (JToken.Parse(body), null);
        }
        catch (JsonException ex)
        {
            return (null, AdminJsonError(400, "invalid json", ex.Message));
        }
    }

    async Task<(JObject obj, IActionResult error)> ReadBodyObjectAsync()
    {
        var body = await ReadBodyTokenInstanceAsync().ConfigureAwait(false);
        if (body.error != null)
            return (null, body.error);
        if (body.token.Type != JTokenType.Object)
            return (null, AdminJsonError(400, "body must be a JSON object"));
        return ((JObject)body.token, null);
    }

    async Task<(JToken token, IActionResult error)> ReadBodyTokenInstanceAsync()
    {
        string body;
        using (var reader = new StreamReader(Request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true))
            body = await reader.ReadToEndAsync().ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(body))
            return (null, AdminJsonError(400, "empty body"));

        try
        {
            return (JToken.Parse(body), null);
        }
        catch (JsonException ex)
        {
            return (null, AdminJsonError(400, "invalid json", ex.Message));
        }
    }

    async Task<string> SaveUsersArrayAsync(JArray users)
    {
        NormalizeUsersForAccsdb(users);

        var formatted = users.ToString(Formatting.Indented);
        var backup = await WriteJsonFileAtomicAsync(UsersFile, formatted, backup: true).ConfigureAwait(false);

        var init = LoadInitRoot();
        var accsdb = init["accsdb"] as JObject;
        if (accsdb == null)
        {
            accsdb = new JObject();
            init["accsdb"] = accsdb;
        }

        accsdb["users"] = users.DeepClone();
        await SaveInitRootAsync(init).ConfigureAwait(false);

        return backup;
    }

    static void NormalizeUsersForAccsdb(JArray users)
    {
        foreach (var user in users.OfType<JObject>())
        {
            var id = CleanText(user.Value<string>("id"));
            if (!string.IsNullOrWhiteSpace(id))
                user["ids"] = NormalizeIds(user["ids"] as JArray, id);

            var expires = CleanText(user.Value<string>("expires"));
            if (!string.IsNullOrWhiteSpace(expires) && expires.Contains("/"))
            {
                if (DateTime.TryParse(expires, out var dt))
                    user["expires"] = dt.ToString("yyyy-MM-ddTHH:mm:ss");
            }
        }
    }

    static async Task<string> SaveInitRootAsync(JObject init)
    {
        var formatted = init.ToString(Formatting.Indented);
        return await WriteJsonFileAtomicAsync(InitFile, formatted, backup: true).ConfigureAwait(false);
    }

    static async Task<string> WriteJsonFileAtomicAsync(string file, string formatted, bool backup)
    {
        JToken.Parse(formatted);

        var tmp = file + ".tmp";
        await System.IO.File.WriteAllTextAsync(tmp, formatted, Utf8NoBom).ConfigureAwait(false);

        string backupPath = null;
        try
        {
            if (backup && System.IO.File.Exists(file))
            {
                backupPath = BackupFile(file);
                await NormalizeManagedFilePermissionsAsync(backupPath).ConfigureAwait(false);
            }

            try
            {
                System.IO.File.Move(tmp, file, overwrite: true);
            }
            catch (IOException ex) when (IsReplaceTargetBusy(ex))
            {
                await System.IO.File.WriteAllTextAsync(file, formatted, Utf8NoBom).ConfigureAwait(false);
            }
        }
        finally
        {
            try
            {
                if (System.IO.File.Exists(tmp))
                    System.IO.File.Delete(tmp);
            }
            catch
            {
            }
        }

        await NormalizeManagedFilePermissionsAsync(file).ConfigureAwait(false);
        return backupPath;
    }

    static async Task NormalizeManagedFilePermissionsAsync(string file)
    {
        if (string.IsNullOrWhiteSpace(file) || !System.IO.File.Exists(file))
            return;

        await RunCommandAsync("chgrp", new[] { "lampac-editors", file }, 5_000).ConfigureAwait(false);
        await RunCommandAsync("chmod", new[] { "664", file }, 5_000).ConfigureAwait(false);
    }

    static async Task NormalizeManagedDirectoryPermissionsAsync(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            return;

        await RunCommandAsync("chgrp", new[] { "lampac-editors", directory }, 5_000).ConfigureAwait(false);
        await RunCommandAsync("chmod", new[] { "775", directory }, 5_000).ConfigureAwait(false);
    }

    static async Task NormalizeManagedTreePermissionsAsync(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            return;

        await RunCommandAsync("chgrp", new[] { "-R", "lampac-editors", directory }, 10_000).ConfigureAwait(false);
        await RunCommandAsync("chmod", new[] { "-R", "u+rwX,g+rwX,o+rX", directory }, 10_000).ConfigureAwait(false);
    }

    static string SafeJsUploadFileName(string fileName)
    {
        var name = Path.GetFileNameWithoutExtension(fileName ?? string.Empty);
        var sb = new StringBuilder();

        foreach (var ch in name.ToLowerInvariant())
        {
            if (ch <= 127 && (char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' || ch == '.'))
                sb.Append(ch);
            else if (char.IsWhiteSpace(ch))
                sb.Append('-');
        }

        var clean = sb.ToString().Trim('.', '-', '_');
        if (string.IsNullOrWhiteSpace(clean))
            clean = "plugin";

        return clean + ".js";
    }

    static string SafeAvatarUploadFileName(string fileName, string ext)
    {
        var name = Path.GetFileNameWithoutExtension(fileName ?? string.Empty);
        var sb = new StringBuilder();

        foreach (var ch in name.ToLowerInvariant())
        {
            if (ch <= 127 && (char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' || ch == '.'))
                sb.Append(ch);
            else if (char.IsWhiteSpace(ch))
                sb.Append('-');
        }

        var clean = sb.ToString().Trim('.', '-', '_');
        if (string.IsNullOrWhiteSpace(clean))
            clean = "avatar";

        return clean + "-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + ext;
    }

    static bool IsPng(byte[] bytes)
    {
        return bytes != null &&
               bytes.Length > 8 &&
               bytes[0] == 0x89 &&
               bytes[1] == 0x50 &&
               bytes[2] == 0x4E &&
               bytes[3] == 0x47 &&
               bytes[4] == 0x0D &&
               bytes[5] == 0x0A &&
               bytes[6] == 0x1A &&
               bytes[7] == 0x0A;
    }

    static bool IsSafeSvg(byte[] bytes, out string error)
    {
        error = null;
        if (bytes == null || bytes.Length == 0)
        {
            error = "empty svg";
            return false;
        }

        var text = Encoding.UTF8.GetString(bytes).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        if (!text.StartsWith("<svg", StringComparison.OrdinalIgnoreCase) &&
            !text.StartsWith("<?xml", StringComparison.OrdinalIgnoreCase))
        {
            error = "svg must start with <svg>";
            return false;
        }

        var lower = text.ToLowerInvariant();
        string[] blocked =
        {
            "<script",
            "javascript:",
            "data:text/html",
            " onload=",
            " onerror=",
            " onclick=",
            " onmouseover=",
            "<foreignobject"
        };

        foreach (var pattern in blocked)
        {
            if (lower.Contains(pattern))
            {
                error = "svg contains unsafe content";
                return false;
            }
        }

        return lower.Contains("<svg");
    }

    static string BackupFile(string file)
    {
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var backup = $"{file}.bak-{stamp}";
        var i = 1;
        while (System.IO.File.Exists(backup))
            backup = $"{file}.bak-{stamp}-{i++}";

        System.IO.File.Copy(file, backup, overwrite: false);
        return backup;
    }

    static bool IsReplaceTargetBusy(IOException ex)
    {
        for (Exception e = ex; e != null; e = e.InnerException)
        {
            if (e.Message != null && e.Message.Contains("busy", StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }

    static ContentResult AdminJsonOk(string backup = null)
    {
        var o = new JObject { ["ok"] = true };
        if (!string.IsNullOrWhiteSpace(backup))
            o["backup"] = backup;

        return new ContentResult
        {
            Content = o.ToString(Formatting.None),
            ContentType = "application/json; charset=utf-8",
            StatusCode = 200
        };
    }

    static ContentResult AdminJsonError(int status, string error, string detail = null)
    {
        var o = new JObject { ["error"] = error };
        if (!string.IsNullOrEmpty(detail))
            o["detail"] = detail;
        return new ContentResult
        {
            Content = o.ToString(Formatting.None),
            ContentType = "application/json; charset=utf-8",
            StatusCode = status
        };
    }

    static ContentResult JsonContent(JToken token, int status = 200)
    {
        return new ContentResult
        {
            Content = token.ToString(Formatting.None),
            ContentType = "application/json; charset=utf-8",
            StatusCode = status
        };
    }

    static string NormalizeJsonText(string raw)
    {
        try
        {
            return JToken.Parse(raw).ToString(Formatting.Indented);
        }
        catch
        {
            return raw;
        }
    }

    static string PluginId(string url)
    {
        url = CleanText(url) ?? string.Empty;
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(url.Trim().ToLowerInvariant()));
        return "p" + Convert.ToHexString(bytes).Substring(0, 12).ToLowerInvariant();
    }

    static string CleanText(string value)
    {
        if (value == null)
            return null;
        value = value.Trim();
        return value.Length == 0 ? null : value;
    }

    static bool IsAllowedPluginUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return false;
        url = url.Trim();
        if (url.StartsWith("{localhost}/", StringComparison.OrdinalIgnoreCase) || url.StartsWith("/", StringComparison.Ordinal))
            return true;
        return Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
    }

    static int ReadInt(JObject obj, string key, int fallback)
    {
        if (!obj.TryGetValue(key, out var value))
            return fallback;

        if (value.Type == JTokenType.Integer)
            return value.Value<int>();
        if (int.TryParse(value.ToString(), out var parsed))
            return parsed;
        return fallback;
    }

    static bool ReadBool(JObject obj, string key, bool fallback)
    {
        return obj.TryGetValue(key, out var value) ? TokenBool(value, fallback) : fallback;
    }

    static bool TokenBool(JToken value, bool fallback)
    {
        if (value == null || value.Type == JTokenType.Null)
            return fallback;
        if (value.Type == JTokenType.Boolean)
            return value.Value<bool>();
        if (value.Type == JTokenType.Integer)
            return value.Value<int>() != 0;
        if (bool.TryParse(value.ToString(), out var parsed))
            return parsed;
        if (int.TryParse(value.ToString(), out var i))
            return i != 0;
        return fallback;
    }

    static async Task<(int exitCode, string output)> RunCommandAsync(string fileName, string[] args, int timeoutMs)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            foreach (var arg in args)
                psi.ArgumentList.Add(arg);

            using var proc = Process.Start(psi);
            if (proc == null)
                return (-1, "failed to start process");

            var stdout = proc.StandardOutput.ReadToEndAsync();
            var stderr = proc.StandardError.ReadToEndAsync();
            var wait = proc.WaitForExitAsync();
            var delay = Task.Delay(timeoutMs);
            var completed = await Task.WhenAny(wait, delay).ConfigureAwait(false);

            if (completed == delay)
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                return (-1, "command timed out");
            }

            await wait.ConfigureAwait(false);

            var output = (await stdout.ConfigureAwait(false)) + (await stderr.ConfigureAwait(false));
            return (proc.ExitCode, output);
        }
        catch (Exception ex)
        {
            return (-1, ex.Message);
        }
    }
}
