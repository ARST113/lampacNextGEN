using Microsoft.AspNetCore.Http;
using Shared;
using Shared.Models.Events;
using Shared.Models.Module;
using Shared.Models.Module.Interfaces;
using System;
using System.Threading.Tasks;

namespace Prewarm;

public class ModInit : IModuleLoaded
{
    static readonly Func<bool, EventMiddleware, Task<bool>> MiddlewareHandler = OnMiddleware;

    public void Loaded(InitspaceModel initspace)
    {
        EventListener.MiddlewareAsync += MiddlewareHandler;
        PrewarmService.Log("module loaded");
    }

    public void Dispose()
    {
        EventListener.MiddlewareAsync -= MiddlewareHandler;
    }

    static async Task<bool> OnMiddleware(bool first, EventMiddleware e)
    {
        try
        {
            var context = e.httpContext;
            var request = context?.Request;

            if (request == null || !HttpMethods.IsGet(request.Method)) return true;

            string path = (request.Path.Value ?? string.Empty).TrimEnd('/');
            string query = request.QueryString.Value ?? string.Empty;

            if (first)
            {
                // Карточка фильма/сериала открывается запросом /lite/events?life=true.
                // Это самая ранняя точка, где известны id и сезон: прогреваем источники заранее.
                if (path.Equals("/lite/events", StringComparison.OrdinalIgnoreCase) &&
                    query.IndexOf("life=true", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    PrewarmService.Trigger(query);
                }

                return true;
            }

            // Второй проход: то, что уже прогрето, отдаём из своего кэша — без похода в источник.
            if (PrewarmService.TryServe(path, query, out string body, out string contentType))
            {
                context.Response.ContentType = contentType;
                context.Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
                context.Response.Headers["X-Prewarm"] = "hit";
                await context.Response.WriteAsync(body, context.RequestAborted);
                return false;
            }
        }
        catch
        {
        }

        return true;
    }
}
