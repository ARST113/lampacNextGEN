using System;
using System.Buffers.Text;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace PizdatoeHD;

public static class AnubisFast
{
    public static async Task<Result> SolveAsync(string challengeJson, CancellationToken cancellationToken = default)
    {
        using var json = JsonDocument.Parse(challengeJson);

        JsonElement root = json.RootElement;
        JsonElement rules = root.GetProperty("rules");
        JsonElement challenge = root.GetProperty("challenge");

        string algorithm = rules.GetProperty("algorithm").GetString();
        if (algorithm != "fast")
            throw new NotSupportedException($"Unsupported Anubis algorithm: {algorithm}");

        string id = challenge.GetProperty("id").GetString();
        string randomData = challenge.GetProperty("randomData").GetString();
        int difficulty = rules.GetProperty("difficulty").GetInt32();

        // Two workers are enough for the fast challenge and avoid CPU spikes on the server.
        int threads = Math.Clamp(Environment.ProcessorCount / 2, 1, 2);
        var resultSource = new TaskCompletionSource<Result>(TaskCreationOptions.RunContinuationsAsynchronously);

        using var stopSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var cancellationRegistration = cancellationToken.Register(
            () => resultSource.TrySetCanceled(cancellationToken)
        );

        long startedAt = Stopwatch.GetTimestamp();
        Task[] workers = new Task[threads];

        for (int workerIndex = 0; workerIndex < threads; workerIndex++)
        {
            int startNonce = workerIndex;
            workers[workerIndex] = Task.Run(() =>
            {
                try
                {
                    FindNonce(id, randomData, difficulty, startNonce, threads, startedAt, resultSource, stopSource);
                }
                catch (Exception ex)
                {
                    if (resultSource.TrySetException(ex))
                        stopSource.Cancel();
                }
            });
        }

        try
        {
            return await resultSource.Task.ConfigureAwait(false);
        }
        finally
        {
            stopSource.Cancel();
            await Task.WhenAll(workers).ConfigureAwait(false);
        }
    }

    static void FindNonce(string id, string randomData, int difficulty, int startNonce, int threads,
        long startedAt, TaskCompletionSource<Result> resultSource, CancellationTokenSource stopSource)
    {
        byte[] prefix = Encoding.UTF8.GetBytes(randomData);
        byte[] input = new byte[prefix.Length + 20];
        prefix.CopyTo(input, 0);

        Span<byte> hash = stackalloc byte[32];
        ulong nonce = (ulong)startNonce;

        while (!stopSource.IsCancellationRequested)
        {
            if (!Utf8Formatter.TryFormat(nonce, input.AsSpan(prefix.Length), out int nonceLength))
                throw new InvalidOperationException("Cannot format Anubis nonce");

            SHA256.HashData(input.AsSpan(0, prefix.Length + nonceLength), hash);

            if (HasRequiredDifficulty(hash, difficulty))
            {
                string hashString = Convert.ToHexString(hash).ToLowerInvariant();
                long elapsedTime = Math.Max(1, (long)Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds);

                if (resultSource.TrySetResult(new Result(id, hashString, nonce, elapsedTime)))
                    stopSource.Cancel();

                return;
            }

            nonce += (ulong)threads;
        }
    }

    static bool HasRequiredDifficulty(ReadOnlySpan<byte> hash, int difficulty)
    {
        int fullZeroBytes = difficulty / 2;
        for (int i = 0; i < fullZeroBytes; i++)
        {
            if (hash[i] != 0)
                return false;
        }

        return (difficulty & 1) == 0 || (hash[fullZeroBytes] & 0xF0) == 0;
    }

    public readonly record struct Result(string Id, string Hash, ulong Nonce, long ElapsedTime)
    {
        public string BuildPassUrl(string siteUrl, string redir, string basePrefix = "")
        {
            string endpoint = $"{basePrefix.TrimEnd('/')}" + "/.within.website/x/cmd/anubis/api/pass-challenge";
            var uri = new UriBuilder(new Uri(new Uri(siteUrl), endpoint))
            {
                Query =
                    $"id={Uri.EscapeDataString(Id)}" +
                    $"&response={Uri.EscapeDataString(Hash)}" +
                    $"&nonce={Nonce}" +
                    $"&redir={Uri.EscapeDataString(redir)}" +
                    $"&elapsedTime={ElapsedTime}"
            };

            return uri.ToString();
        }
    }
}
