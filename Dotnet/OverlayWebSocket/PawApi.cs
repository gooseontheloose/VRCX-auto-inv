using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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
///   200 {"enabled":bool,"actionsEnabled":bool,"version":"...","playerCount":n}
///
/// Actions (only when "Allow AIRI actions" is also on). Header X-Paw-Token is required
/// (the token is in %APPDATA%\VRCX\paw-airi-token.txt; 401 otherwise):
/// POST /paw/friend-request {"userId":"usr_..."}
/// POST /paw/friend-accept  {"userId":"usr_..."}
/// GET  /paw/friend-status?userId=usr_...
/// GET  /paw/friend-requests
///   200 {"ok":true,"requests":[{"userId","displayName","createdAt"}]} - incoming pending
///       friend requests VRCX already knows (notification table), newest first, max 50
///   200 {"ok":bool,"result":"...","userId":"...","displayName":"..."}
///       (friend-status: {"ok":true,"isFriend":b,"outgoingPending":b,"incomingPending":b,...})
///   400 invalid_user_id / self_not_allowed, 403 {"enabled":b,"actionsEnabled":false,...},
///   429 rate_limited, 502 vrchat_error
///
/// Common errors:
///   403 - request carries an Origin header (blocks cross-site reads from web pages)
///         or does not come from the loopback interface
///   405 - wrong method (POST only for friend-request/friend-accept, GET otherwise)
///   503 - main browser/page not ready
/// </summary>
public static class PawApi
{
    private static readonly Logger logger = LogManager.GetCurrentClassLogger();

    private const string PlayersPath = "/paw/players";
    private const string StatusPath = "/paw/status";
    private const string TokenFileName = "paw-airi-token.txt";
    private const string TokenHeader = "X-Paw-Token";
    private const int MaxBodyBytes = 4096;
    private static readonly TimeSpan ActionTimeout = TimeSpan.FromSeconds(30);
    private static readonly SemaphoreSlim ActionConcurrency = new(1, 1);
    private static readonly Regex UserIdRegex = new(
        "^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOptions.CultureInvariant);
    private static byte[] _token;
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

            var path = request.Url!.AbsolutePath.TrimEnd('/');
            var actionKind = GetActionKind(path);
            var allowedMethod = actionKind is "friend-request" or "friend-accept" ? "POST" : "GET";
            if (!string.Equals(request.HttpMethod, allowedMethod, StringComparison.OrdinalIgnoreCase))
            {
                response.Headers["Allow"] = allowedMethod;
                await WriteJson(response, 405, "{\"error\":\"method_not_allowed\"}");
                return;
            }

            if (actionKind != null)
            {
                await HandleAction(request, response, actionKind);
            }
            else if (string.Equals(path, PlayersPath, StringComparison.OrdinalIgnoreCase))
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

    /// <summary>
    /// Loads the action token from paw-airi-token.txt, creating it once with a random value.
    /// </summary>
    public static void InitToken()
    {
        try
        {
            var path = Path.Join(Program.AppDataDirectory, TokenFileName);
            string token = null;
            if (File.Exists(path))
            {
                token = File.ReadAllText(path).Trim();
                if (!Regex.IsMatch(token, "^[0-9a-f]{64}$"))
                    token = null;
            }

            if (token == null)
            {
                token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
                Directory.CreateDirectory(Program.AppDataDirectory);
                File.WriteAllText(path, token);
                logger.Info("PAW API: created AIRI action token at {0}", path);
            }

            _token = Encoding.ASCII.GetBytes(token);
        }
        catch (Exception e)
        {
            _token = null;
            logger.Error(e, "PAW API: could not load or create the AIRI action token; actions are disabled");
        }
    }

    internal static bool IsTokenValid(string provided)
    {
        var expected = _token;
        if (expected == null || string.IsNullOrEmpty(provided))
            return false;
        var actual = Encoding.UTF8.GetBytes(provided.Trim());
        // Constant time for equal lengths; the token length itself (64) is not secret.
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static string GetActionKind(string path)
    {
        if (string.Equals(path, "/paw/friend-request", StringComparison.OrdinalIgnoreCase))
            return "friend-request";
        if (string.Equals(path, "/paw/friend-accept", StringComparison.OrdinalIgnoreCase))
            return "friend-accept";
        if (string.Equals(path, "/paw/friend-status", StringComparison.OrdinalIgnoreCase))
            return "friend-status";
        if (string.Equals(path, "/paw/friend-requests", StringComparison.OrdinalIgnoreCase))
            return "friend-requests";
        return null;
    }

    private static async Task<string> ReadUserId(HttpListenerRequest request, string kind)
    {
        if (kind == "friend-status")
            return request.QueryString["userId"];

        if (request.ContentLength64 > MaxBodyBytes)
            return null;

        var buffer = new byte[MaxBodyBytes + 1];
        var total = 0;
        int read;
        while (total < buffer.Length &&
               (read = await request.InputStream.ReadAsync(buffer.AsMemory(total, buffer.Length - total))) > 0)
            total += read;
        if (total > MaxBodyBytes)
            return null;

        try
        {
            using var document = JsonDocument.Parse(buffer.AsMemory(0, total));
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("userId", out var element) &&
                element.ValueKind == JsonValueKind.String)
                return element.GetString();
        }
        catch (JsonException)
        {
            // invalid body
        }

        return null;
    }

    private static async Task HandleAction(HttpListenerRequest request, HttpListenerResponse response, string kind)
    {
        if (!IsTokenValid(request.Headers[TokenHeader]))
        {
            logger.Warn("PAW API: {0} rejected, missing or wrong {1}", kind, TokenHeader);
            await WriteJson(response, 401, "{\"error\":\"unauthorized\"}");
            return;
        }

        // friend-requests lists incoming requests and takes no userId.
        var userId = kind == "friend-requests" ? "" : await ReadUserId(request, kind);
        if (userId == null || (kind != "friend-requests" && !UserIdRegex.IsMatch(userId)))
        {
            await WriteJson(response, 400, "{\"ok\":false,\"error\":\"invalid_user_id\"}");
            return;
        }

        var browser = MainForm.Instance?.Browser;
        if (browser == null || !browser.IsBrowserInitialized || browser.IsLoading ||
            !browser.CanExecuteJavascriptInMainFrame)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        if (!await ActionConcurrency.WaitAsync(ActionTimeout))
        {
            await WriteJson(response, 503, "{\"error\":\"busy\"}");
            return;
        }

        string resultJson;
        try
        {
            // userId is regex-validated and JSON-encoded, so it cannot break out of the string literal.
            var script =
                "var s=window.$pinia&&window.$pinia.airiIntegration;" +
                "if(!s||typeof s.handleActionRequest!=='function')return false;" +
                $"return s.handleActionRequest({JsonSerializer.Serialize(kind)},{JsonSerializer.Serialize(userId)});";
            var scriptResponse = await browser.EvaluateScriptAsPromiseAsync(script, ActionTimeout);
            resultJson = scriptResponse.Success ? scriptResponse.Result as string : null;
        }
        catch (Exception e)
        {
            logger.Warn(e, "PAW API action script failed");
            resultJson = null;
        }
        finally
        {
            ActionConcurrency.Release();
        }

        if (resultJson == null)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        int status;
        string body;
        using (var document = JsonDocument.Parse(resultJson))
        {
            var root = document.RootElement;
            status = root.GetProperty("status").GetInt32();
            var bodyElement = root.GetProperty("body");
            body = bodyElement.GetRawText();
            var displayName = bodyElement.ValueKind == JsonValueKind.Object &&
                              bodyElement.TryGetProperty("displayName", out var nameElement) &&
                              nameElement.ValueKind == JsonValueKind.String
                ? nameElement.GetString()
                : "";
            if (kind == "friend-requests")
            {
                var count = bodyElement.ValueKind == JsonValueKind.Object &&
                            bodyElement.TryGetProperty("requests", out var requestsElement) &&
                            requestsElement.ValueKind == JsonValueKind.Array
                    ? requestsElement.GetArrayLength()
                    : 0;
                logger.Info("PAW API action {0} -> {1} count={2}", kind, status, count);
            }
            else
            {
                logger.Info("PAW API action {0} userId={1} displayName=\"{2}\" -> {3} {4}",
                    kind, userId, displayName, status, body);
            }
        }

        await WriteJson(response, status, body);
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
        var actionsEnabled = false;
        var playerCount = 0;
        using (var document = JsonDocument.Parse(json))
        {
            var root = document.RootElement;
            if (root.TryGetProperty("enabled", out var enabledElement) &&
                enabledElement.ValueKind == JsonValueKind.True)
                enabled = true;
            if (root.TryGetProperty("actionsEnabled", out var actionsElement) &&
                actionsElement.ValueKind == JsonValueKind.True)
                actionsEnabled = true;
            if (root.TryGetProperty("playerCount", out var countElement) &&
                countElement.ValueKind == JsonValueKind.Number)
                playerCount = countElement.GetInt32();
        }

        var status = JsonSerializer.Serialize(new
        {
            enabled,
            actionsEnabled,
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
