using System;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using CefSharp;
using NLog;

namespace VRCX;

/// <summary>
/// Read-only localhost HTTP API served on the overlay listener (http://127.0.0.1:34582/)
/// for the AIRI integration (a local AI companion reading who is in the current instance).
///
/// GET /paw/players
///   200 application/json  - payload from window.$pinia.airiIntegration.getPlayersJson()
///   403 {"enabled":false} - integration is disabled in the app (default)
/// GET /paw/status
///   200 {"enabled":bool,"version":"...","playerCount":n}
///
/// Common errors:
///   403 - request carries an Origin header (blocks cross-site reads from web pages)
///         or does not come from the loopback interface
///   405 - method other than GET
///   503 - main browser/page not ready
/// </summary>
public static class PawApi
{
    private static readonly Logger logger = LogManager.GetCurrentClassLogger();

    private const string PlayersPath = "/paw/players";
    private const string StatusPath = "/paw/status";
    private static readonly TimeSpan ScriptTimeout = TimeSpan.FromSeconds(2);
    private static readonly SemaphoreSlim Concurrency = new(4, 4);

    private const string PlayersScript =
        "(function(){var s=window.$pinia&&window.$pinia.airiIntegration;" +
        "if(!s||typeof s.getPlayersJson!=='function')return false;" +
        "var r=s.getPlayersJson();return typeof r==='string'?r:null;})()";

    private const string StatusScript =
        "(function(){var s=window.$pinia&&window.$pinia.airiIntegration;" +
        "if(!s||typeof s.getStatusJson!=='function')return false;" +
        "return s.getStatusJson();})()";

    public static bool IsPawRequest(HttpListenerRequest request)
    {
        var path = request.Url?.AbsolutePath;
        return path != null && path.StartsWith("/paw/", StringComparison.OrdinalIgnoreCase);
    }

    public static async Task HandleRequest(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        try
        {
            if (!string.IsNullOrEmpty(request.Headers["Origin"]))
            {
                await WriteJson(response, 403, "{\"error\":\"origin_not_allowed\"}");
                return;
            }

            // DNS rebinding: a web page can point its own domain at 127.0.0.1 and make same-origin
            // requests (no Origin header). Only accept the loopback host names.
            var host = request.UserHostName?.Split(':')[0];
            if (request.RemoteEndPoint == null || !IPAddress.IsLoopback(request.RemoteEndPoint.Address) ||
                (host != "127.0.0.1" && host != "localhost" && host != "[::1]"))
            {
                await WriteJson(response, 403, "{\"error\":\"forbidden\"}");
                return;
            }

            if (!string.Equals(request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase))
            {
                response.Headers["Allow"] = "GET";
                await WriteJson(response, 405, "{\"error\":\"method_not_allowed\"}");
                return;
            }

            var path = request.Url!.AbsolutePath.TrimEnd('/');
            if (string.Equals(path, PlayersPath, StringComparison.OrdinalIgnoreCase))
            {
                await HandlePlayers(response);
            }
            else if (string.Equals(path, StatusPath, StringComparison.OrdinalIgnoreCase))
            {
                await HandleStatus(response);
            }
            else
            {
                await WriteJson(response, 404, "{\"error\":\"not_found\"}");
            }
        }
        catch (Exception e)
        {
            logger.Error(e, "PAW API request failed");
            try
            {
                await WriteJson(response, 500, "{\"error\":\"internal_error\"}");
            }
            catch
            {
                // response already closed
            }
        }
    }

    private static async Task HandlePlayers(HttpListenerResponse response)
    {
        var (ready, result) = await Evaluate(PlayersScript);
        if (!ready)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        if (result is not string json)
        {
            await WriteJson(response, 403, "{\"enabled\":false}");
            return;
        }

        await WriteJson(response, 200, json);
    }

    private static async Task HandleStatus(HttpListenerResponse response)
    {
        var (ready, result) = await Evaluate(StatusScript);
        if (!ready || result is not string json)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        var enabled = false;
        var playerCount = 0;
        using (var document = JsonDocument.Parse(json))
        {
            var root = document.RootElement;
            if (root.TryGetProperty("enabled", out var enabledElement) &&
                enabledElement.ValueKind == JsonValueKind.True)
                enabled = true;
            if (root.TryGetProperty("playerCount", out var countElement) &&
                countElement.ValueKind == JsonValueKind.Number)
                playerCount = countElement.GetInt32();
        }

        var status = JsonSerializer.Serialize(new
        {
            enabled,
            version = Program.Version,
            playerCount
        });
        await WriteJson(response, 200, status);
    }

    /// <summary>
    /// Evaluates a script in the main frame. Returns ready=false when the browser
    /// is not available, the script failed/timed out, or the store is missing.
    /// </summary>
    private static async Task<(bool ready, object result)> Evaluate(string script)
    {
        var browser = MainForm.Instance?.Browser;
        if (browser == null || !browser.IsBrowserInitialized || browser.IsLoading ||
            !browser.CanExecuteJavascriptInMainFrame)
            return (false, null);

        if (!await Concurrency.WaitAsync(ScriptTimeout))
            return (false, null);

        try
        {
            var response = await browser.EvaluateScriptAsync(script, ScriptTimeout);
            if (!response.Success || response.Result is false)
                return (false, null);

            return (true, response.Result);
        }
        catch (Exception e)
        {
            logger.Warn(e, "PAW API script evaluation failed");
            return (false, null);
        }
        finally
        {
            Concurrency.Release();
        }
    }

    private static async Task WriteJson(HttpListenerResponse response, int statusCode, string json)
    {
        var buffer = Encoding.UTF8.GetBytes(json);
        response.StatusCode = statusCode;
        response.ContentType = "application/json; charset=utf-8";
        response.ContentEncoding = Encoding.UTF8;
        response.ContentLength64 = buffer.Length;
        response.Headers["Cache-Control"] = "no-store";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        await response.OutputStream.WriteAsync(buffer);
        response.Close();
    }
}
