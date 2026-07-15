using Microsoft.AspNetCore.Http;
using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace MpvWasm;

public sealed class MpvWasmProxyService
{
    static readonly HttpClient Client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.None,
        UseCookies = false,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10)
    });

    public async Task<HttpResponseMessage> SendAsync(string encodedUrl, string encodedHeaders, HttpRequest request, ModuleConf conf, CancellationToken cancellationToken)
    {
        var method = HttpMethods.IsHead(request.Method) ? HttpMethod.Head : HttpMethod.Get;
        var headers = MpvWasmHeaders.DecodeOutboundHeaders(encodedHeaders, conf);
        var url = MpvWasmUrlCodec.DecodeUrl(encodedUrl);
        var uri = new Uri(url);

        for (var redirect = 0; ; redirect++)
        {
            await MpvWasmSecurity.ValidateUriAsync(uri, conf, cancellationToken);

            var message = new HttpRequestMessage(method, uri);
            MpvWasmHeaders.ApplyRequestHeaders(message, request.Headers, headers);

            var timeout = TimeSpan.FromSeconds(Math.Max(1, conf.timeoutSeconds));
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(timeout);

            var response = await Client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, timeoutCts.Token);
            if (!IsRedirect(response.StatusCode))
                return response;

            if (redirect >= Math.Max(0, conf.maxRedirects))
            {
                response.Dispose();
                throw new InvalidOperationException("Too many upstream redirects");
            }

            var location = response.Headers.Location;
            response.Dispose();
            if (location == null)
                throw new InvalidOperationException("Upstream redirect without Location header");

            uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
        }
    }

    static bool IsRedirect(HttpStatusCode status) =>
        status == HttpStatusCode.Moved ||
        status == HttpStatusCode.Found ||
        status == HttpStatusCode.SeeOther ||
        status == HttpStatusCode.TemporaryRedirect ||
        status == HttpStatusCode.PermanentRedirect;
}
