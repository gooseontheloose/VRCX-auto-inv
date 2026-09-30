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
///   200 {"enabled":bool,"actionsEnabled":bool,"version":"...","playerCount":n,
///        "acceptPerHour":n,"lookups":{...},"friendBudget":{...}}
///       lookups: paced group/bio lookup queue (queued, callsThisHour, hourlyCeiling,
///       paused, pauseReason, retryAfterSec, strikes, lastRateLimitAt, cacheSize, ...);
///       friendBudget: per action kind {usedHour, perHour, remainingHour, usedDay, perDay, remainingDay}
///
/// Header X-Paw-Token is required for everything below (the token is in
/// %APPDATA%\VRCX\paw-airi-token.txt; 401 otherwise):
/// GET  /paw/player?userId=usr_...  (needs the integration on, not actions)
///   200 {"ok":true,"player":{...same fields as /paw/players...},"inInstance":b,"pending":b,
///        "retryAfterSec"?:n} - looks up the player's missing bio/VRC+/group first in line
///       (waits up to 15 s), then answers with what is known
///   403 {"enabled":false,...}, 400 invalid_user_id / self_not_allowed, 503 not_logged_in
///
/// Actions (only when "Allow AIRI actions" is also on):
/// POST /paw/friend-request {"userId":"usr_..."}
/// POST /paw/friend-accept  {"userId":"usr_..."}
/// GET  /paw/friend-status?userId=usr_...
/// GET  /paw/friend-requests
///   200 {"ok":true,"requests":[{"userId","displayName","createdAt","inLobby"}],"pendingTotal":n,
///        "stale":b} - incoming pending friend requests from VRCX's notification table,
///       answered right away; senders in the instance first, then oldest first, max 50
///   503 {"error":"loading","retryAfterSec":n} - VRCX is reloading notifications and has no
///       complete list yet (e.g. right after login); ask again, don't read it as "none"
///   200 {"ok":bool,"result":"...","userId":"...","displayName":"..."}
///       (friend-status: {"ok":true,"isFriend":b,"outgoingPending":b,"incomingPending":b,...})
///   400 invalid_user_id / self_not_allowed, 403 {"enabled":b,"actionsEnabled":false,...},
///   429 {"error":"rate_limited","reason":"...","retryAfterSec":n} (VRCX's own limits),
///   429 {"error":"vrchat_rate_limited","retryAfterSec":n} (VRChat answered 429; everything
///       that calls VRChat backs off together), 502 vrchat_error,
///   504 {"error":"timeout","result":"unknown"} - no answer within 25 s; the action may
///       still complete, so check friend-status before reporting a failure
///
/// Social actions (Meow Meow): every write also needs "Allow AIRI social actions" (off by
/// default; 403 {"error":"social_disabled"} / {"error":"kind_disabled"} otherwise). Reads need
/// only the integration switch. All need X-Paw-Token.
/// POST /paw/boop           {"userId","emojiId"?}                          -> result booped|not_friends|...
/// POST /paw/invite         {"userId","messageSlot"?,"message"?,"flirty"?} -> result invited|not_in_instance|slot_cooldown|...
/// POST /paw/invite-respond {"notificationId","responseSlot"?,"message"?}  -> result responded|already_responded|...
/// POST /paw/self/status    {"status"?,"statusDescription"?}               -> result updated|unchanged|too_soon, nextAllowedAt
/// POST /paw/note           {"userId","note"}                              -> result saved|unchanged
/// GET  /paw/events?after=n  -> {"ok":true,"seq":n,"events":[...]}
/// GET  /paw/user?userId=    -> {"ok":true,"user":{...}}
/// GET  /paw/world           -> {"ok":true,"world":{...}}
///   429 {"result":"rate_limited"|"too_soon","scope":"local"|"vrchat","retryAfterSec":n}
///
/// Common errors:
///   403 - request carries an Origin header (blocks cross-site reads from web pages)
///         or does not come from the loopback interface
///   405 - wrong method (POST only for friend-request/friend-accept, GET otherwise)
///   503 - main browser/page not ready
///
/// Timeouts: every action or player request is answered within 25 s, so clients
/// should wait longer than that (the AIRI client uses 35 s).
/// </summary>
public static class PawApi
{
    private static readonly Logger logger = LogManager.GetCurrentClassLogger();

    private const string PlayersPath = "/paw/players";
    private const string PlayerPath = "/paw/player";
    private const string StatusPath = "/paw/status";
    private const string TokenFileName = "paw-airi-token.txt";
    private const string TokenHeader = "X-Paw-Token";
    private const int MaxBodyBytes = 4096;
    /// <summary>Total time an action or player request may take, queueing included.</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(25);
    private static readonly SemaphoreSlim ActionConcurrency = new(1, 1);
    private static readonly SemaphoreSlim PlayerConcurrency = new(4, 4);
    private static readonly SemaphoreSlim SocialWriteConcurrency = new(2, 2);
    private static readonly SemaphoreSlim SocialReadConcurrency = new(4, 4);
    private static readonly Regex UserIdRegex = new(
        "^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOptions.CultureInvariant);
    private static byte[] _token;
    private static readonly TimeSpan ScriptTimeout = TimeSpan.FromSeconds(2);
    private static readonly SemaphoreSlim Concurrency = new(4, 4);

    private const string TimeoutBody = "{\"ok\":false,\"error\":\"timeout\",\"result\":\"unknown\"}";

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
            var socialKind = GetSocialKind(path, out var socialIsWrite);
            var allowedMethod = actionKind is "friend-request" or "friend-accept" || socialIsWrite ? "POST" : "GET";
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
            else if (socialKind != null)
            {
                await HandleSocial(request, response, socialKind, socialIsWrite);
            }
            else if (string.Equals(path, PlayerPath, StringComparison.OrdinalIgnoreCase))
            {
                await HandlePlayer(request, response);
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

    /// <summary>Social routes: path -> store kind; isWrite for the POST routes.</summary>
    internal static string GetSocialKind(string path, out bool isWrite)
    {
        isWrite = true;
        switch (path?.ToLowerInvariant())
        {
            case "/paw/boop": return "boop";
            case "/paw/invite": return "invite";
            case "/paw/invite-respond": return "inviteRespond";
            case "/paw/self/status": return "status";
            case "/paw/note": return "note";
        }

        isWrite = false;
        switch (path?.ToLowerInvariant())
        {
            case "/paw/events": return "events";
            case "/paw/user": return "user";
            case "/paw/world": return "world";
        }

        return null;
    }

    /// <summary>Reads a request body of at most <see cref="MaxBodyBytes"/>; null when larger.</summary>
    private static async Task<byte[]> ReadBody(HttpListenerRequest request)
    {
        if (request.ContentLength64 > MaxBodyBytes)
            return null;

        var buffer = new byte[MaxBodyBytes + 1];
        var total = 0;
        int read;
        while (total < buffer.Length &&
               (read = await request.InputStream.ReadAsync(buffer.AsMemory(total, buffer.Length - total))) > 0)
            total += read;
        return total > MaxBodyBytes ? null : buffer.AsSpan(0, total).ToArray();
    }

    /// <summary>
    /// The JSON payload handed to the store: the POST body (must be a JSON object) or, for GET,
    /// the whitelisted query parameters. Re-serialized, so only well-formed JSON reaches the page.
    /// </summary>
    internal static string BuildSocialPayload(string kind, bool isWrite, byte[] body,
        System.Collections.Specialized.NameValueCollection query)
    {
        if (!isWrite)
        {
            var args = new System.Collections.Generic.Dictionary<string, string>();
            if (kind == "events" && query?["after"] != null)
                args["after"] = query["after"];
            if (kind == "user" && query?["userId"] != null)
                args["userId"] = query["userId"];
            return JsonSerializer.Serialize(args);
        }

        if (body == null)
            return null;
        try
        {
            using var document = JsonDocument.Parse(body);
            return document.RootElement.ValueKind == JsonValueKind.Object
                ? JsonSerializer.Serialize(document.RootElement)
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static async Task<string> ReadUserId(HttpListenerRequest request, string kind)
    {
        if (kind == "friend-status")
            return request.QueryString["userId"];

        var body = await ReadBody(request);
        if (body == null)
            return null;

        try
        {
            using var document = JsonDocument.Parse(body);
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

    private static CefSharp.WinForms.ChromiumWebBrowser GetReadyBrowser()
    {
        var browser = MainForm.Instance?.Browser;
        return browser != null && browser.IsBrowserInitialized && !browser.IsLoading &&
               browser.CanExecuteJavascriptInMainFrame
            ? browser
            : null;
    }

    /// <summary>
    /// Waits for a slot of <paramref name="gate"/> and runs a store method that returns a
    /// JSON {status, body} string, all within <see cref="RequestTimeout"/>.
    /// </summary>
    /// <returns>(timedOut, resultJson); resultJson is null when the page is not ready.</returns>
    private static async Task<(bool timedOut, string resultJson)> RunStoreRequest(
        CefSharp.WinForms.ChromiumWebBrowser browser, SemaphoreSlim gate, string script)
    {
        var started = DateTime.UtcNow;
        if (!await gate.WaitAsync(RequestTimeout))
            return (true, null);

        try
        {
            var remaining = RequestTimeout - (DateTime.UtcNow - started);
            if (remaining < TimeSpan.FromSeconds(1))
                return (true, null);

            var scriptResponse = await browser.EvaluateScriptAsPromiseAsync(script, remaining);
            if (scriptResponse.Success)
                return (false, scriptResponse.Result as string);
            if (scriptResponse.Message?.Contains("timeout", StringComparison.OrdinalIgnoreCase) == true)
                return (true, null);
            logger.Warn("PAW API store script failed: {0}", scriptResponse.Message);
            return (false, null);
        }
        catch (Exception e) when (e is OperationCanceledException or TimeoutException)
        {
            return (true, null);
        }
        catch (Exception e)
        {
            logger.Warn(e, "PAW API store script failed");
            return (false, null);
        }
        finally
        {
            gate.Release();
        }
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

        var browser = GetReadyBrowser();
        if (browser == null)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        // userId is regex-validated and JSON-encoded, so it cannot break out of the string literal.
        var script =
            "var s=window.$pinia&&window.$pinia.airiIntegration;" +
            "if(!s||typeof s.handleActionRequest!=='function')return false;" +
            $"return s.handleActionRequest({JsonSerializer.Serialize(kind)},{JsonSerializer.Serialize(userId)});";
        var (timedOut, resultJson) = await RunStoreRequest(browser, ActionConcurrency, script);

        if (timedOut)
        {
            // The store may still finish the action: the caller must re-check, not assume failure.
            logger.Warn("PAW API action {0} userId={1} -> 504 timeout (result unknown)", kind, userId);
            await WriteJson(response, 504, TimeoutBody);
            return;
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

    private static async Task HandleSocial(HttpListenerRequest request, HttpListenerResponse response,
        string kind, bool isWrite)
    {
        if (!IsTokenValid(request.Headers[TokenHeader]))
        {
            logger.Warn("PAW API: social {0} rejected, missing or wrong {1}", kind, TokenHeader);
            await WriteJson(response, 401, "{\"error\":\"unauthorized\"}");
            return;
        }

        var payload = BuildSocialPayload(kind, isWrite, isWrite ? await ReadBody(request) : null,
            request.QueryString);
        if (payload == null)
        {
            await WriteJson(response, 400, "{\"ok\":false,\"error\":\"invalid_body\"}");
            return;
        }

        var browser = GetReadyBrowser();
        if (browser == null)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        // kind comes from a fixed table; payload is re-serialized JSON passed as a JSON string
        // literal (System.Text.Json escapes quotes, '<', '>' and non-ASCII), parsed again by the page.
        var script =
            "var s=window.$pinia&&window.$pinia.airiIntegration;" +
            "if(!s||typeof s.handleSocialRequest!=='function')return false;" +
            $"return s.handleSocialRequest({JsonSerializer.Serialize(kind)},{JsonSerializer.Serialize(payload)});";
        var (timedOut, resultJson) = await RunStoreRequest(browser,
            isWrite ? SocialWriteConcurrency : SocialReadConcurrency, script);

        if (timedOut)
        {
            if (isWrite)
                logger.Warn("PAW API social {0} -> 504 timeout (result unknown)", kind);
            await WriteJson(response, 504, TimeoutBody);
            return;
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
            if (isWrite)
                logger.Info("PAW API social {0} target={1} -> {2} {3}", kind, SocialTarget(payload), status,
                    SocialResult(bodyElement));
        }

        await WriteJson(response, status, body);
    }

    private static string SocialResult(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object)
            return "";
        if (body.TryGetProperty("result", out var result) && result.ValueKind == JsonValueKind.String)
            return result.GetString();
        if (body.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
            return error.GetString();
        return "";
    }

    private static string SocialTarget(string payload)
    {
        try
        {
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            string target = null;
            if (root.TryGetProperty("userId", out var user) && user.ValueKind == JsonValueKind.String)
                target = user.GetString();
            else if (root.TryGetProperty("notificationId", out var notification) &&
                     notification.ValueKind == JsonValueKind.String)
                target = notification.GetString();
            return target != null && Regex.IsMatch(target, "^[a-z]{3}_[0-9a-f-]{36}$") ? target : "-";
        }
        catch (JsonException)
        {
            return "-";
        }
    }

    private static async Task HandlePlayer(HttpListenerRequest request, HttpListenerResponse response)
    {
        if (!IsTokenValid(request.Headers[TokenHeader]))
        {
            logger.Warn("PAW API: player rejected, missing or wrong {0}", TokenHeader);
            await WriteJson(response, 401, "{\"error\":\"unauthorized\"}");
            return;
        }

        var userId = request.QueryString["userId"];
        if (userId == null || !UserIdRegex.IsMatch(userId))
        {
            await WriteJson(response, 400, "{\"ok\":false,\"error\":\"invalid_user_id\"}");
            return;
        }

        var browser = GetReadyBrowser();
        if (browser == null)
        {
            await WriteJson(response, 503, "{\"error\":\"not_ready\"}");
            return;
        }

        // userId is regex-validated and JSON-encoded, so it cannot break out of the string literal.
        var script =
            "var s=window.$pinia&&window.$pinia.airiIntegration;" +
            "if(!s||typeof s.handlePlayerRequest!=='function')return false;" +
            $"return s.handlePlayerRequest({JsonSerializer.Serialize(userId)});";
        var (timedOut, resultJson) = await RunStoreRequest(browser, PlayerConcurrency, script);

        if (timedOut)
        {
            await WriteJson(response, 504, TimeoutBody);
            return;
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
            body = root.GetProperty("body").GetRawText();
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
        int? acceptPerHour = null;
        JsonElement? lookups = null;
        JsonElement? friendBudget = null;
        var socialEnabled = false;
        var socialDryRun = false;
        JsonElement? socialKinds = null;
        JsonElement? socialPause = null;
        JsonElement? socialBudget = null;
        long? eventsSeq = null;
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
            if (root.TryGetProperty("acceptPerHour", out var acceptElement) &&
                acceptElement.ValueKind == JsonValueKind.Number &&
                acceptElement.TryGetInt32(out var acceptValue))
                acceptPerHour = acceptValue;
            // Clone: the document is disposed before serialization.
            if (root.TryGetProperty("lookups", out var lookupsElement) &&
                lookupsElement.ValueKind == JsonValueKind.Object)
                lookups = lookupsElement.Clone();
            if (root.TryGetProperty("friendBudget", out var budgetElement) &&
                budgetElement.ValueKind == JsonValueKind.Object)
                friendBudget = budgetElement.Clone();
            if (root.TryGetProperty("socialEnabled", out var socialElement) &&
                socialElement.ValueKind == JsonValueKind.True)
                socialEnabled = true;
            if (root.TryGetProperty("socialDryRun", out var dryRunElement) &&
                dryRunElement.ValueKind == JsonValueKind.True)
                socialDryRun = true;
            if (root.TryGetProperty("socialKinds", out var kindsElement) &&
                kindsElement.ValueKind == JsonValueKind.Object)
                socialKinds = kindsElement.Clone();
            if (root.TryGetProperty("socialPause", out var pauseElement) &&
                pauseElement.ValueKind == JsonValueKind.Object)
                socialPause = pauseElement.Clone();
            if (root.TryGetProperty("socialBudget", out var socialBudgetElement) &&
                socialBudgetElement.ValueKind == JsonValueKind.Object)
                socialBudget = socialBudgetElement.Clone();
            if (root.TryGetProperty("eventsSeq", out var seqElement) &&
                seqElement.ValueKind == JsonValueKind.Number &&
                seqElement.TryGetInt64(out var seqValue))
                eventsSeq = seqValue;
        }

        var status = JsonSerializer.Serialize(new
        {
            enabled,
            actionsEnabled,
            version = Program.Version,
            playerCount,
            acceptPerHour,
            lookups,
            friendBudget,
            socialEnabled,
            socialDryRun,
            socialKinds,
            socialPause,
            socialBudget,
            eventsSeq
        });
        await WriteJson(response, 200, status);
    }

    /// <summary>
    /// Evaluates a script in the main frame. Returns ready=false when the browser
    /// is not available, the script failed/timed out, or the store is missing.
    /// </summary>
    private static async Task<(bool ready, object result)> Evaluate(string script)
    {
        var browser = GetReadyBrowser();
        if (browser == null)
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
