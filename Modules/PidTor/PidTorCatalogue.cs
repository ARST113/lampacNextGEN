using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace PidTor;

public sealed class PidTorCatalogue
{
    readonly PidTorCacheStore store;
    readonly TimeProvider clock;
    static readonly ConcurrentDictionary<string, Lazy<Task<CatalogueSnapshot>>> flights = new();
    public PidTorCatalogue(PidTorCacheStore store, TimeProvider clock = null)
    { this.store = store; this.clock = clock ?? TimeProvider.System; }

    public async Task<CatalogueSnapshot> GetAsync(CatalogueSearchContext context,
        Func<Task<IReadOnlyList<CatalogueRelease>>> fetch, CancellationToken ct = default)
    {
        if (context.Key.MediaId <= 0)
            return new CatalogueSnapshot { Key = context.Key, Releases = new(await fetch().WaitAsync(TimeSpan.FromSeconds(20), ct)), FetchedAt = clock.GetUtcNow() };
        CatalogueSnapshot saved = null;
        try { saved = await store.ReadCatalogueAsync(context.Key, ct); }
        catch (Microsoft.Data.Sqlite.SqliteException) { }
        catch (System.IO.IOException) { }
        catch (UnauthorizedAccessException) { }
        if (saved != null && saved.FetchedAt > clock.GetUtcNow().AddMinutes(-15)) return saved;
        string key = store.DatabasePath + "|" + context.Key.MediaId + "|" + context.Key.ContextKey;
        var flight = flights.GetOrAdd(key, _ => new Lazy<Task<CatalogueSnapshot>>(() => Refresh(context, fetch)));
        var task = flight.Value;
        _ = RemoveCompleted(key, flight, task);
        if (saved != null) { _ = Observe(task); return saved; }
        return await task.WaitAsync(ct);
    }
    async Task<CatalogueSnapshot> Refresh(CatalogueSearchContext context, Func<Task<IReadOnlyList<CatalogueRelease>>> fetch)
    {
        var releases = await fetch().WaitAsync(TimeSpan.FromSeconds(20));
        var time = clock.GetUtcNow();
        try
        {
            await store.MergeCatalogueAsync(context.Key, releases, time);
            return await store.ReadCatalogueAsync(context.Key);
        }
        catch (Microsoft.Data.Sqlite.SqliteException) { }
        catch (System.IO.IOException) { }
        catch (UnauthorizedAccessException) { }
        return new CatalogueSnapshot { Key = context.Key, Releases = new(releases), FetchedAt = time };
    }
    static async Task Observe(Task task) { try { await task; } catch { /* Old snapshot remains usable. */ } }
    static async Task RemoveCompleted(string key, Lazy<Task<CatalogueSnapshot>> flight, Task task)
    {
        try { await task; } catch { }
        ((ICollection<KeyValuePair<string, Lazy<Task<CatalogueSnapshot>>>>)flights).Remove(new(key, flight));
    }
}
