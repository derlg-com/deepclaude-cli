# Comprehensive Guide: Adding LLM Providers to deepclaude-cli

This document is a deep-dive developer guide detailing exactly how new LLM providers are integrated into the `deepclaude-cli` framework. It uses our recent implementations of **Kiro**, **Doubleword AI**, **Nvidia NIM**, and **Kimi Code** as concrete examples.

---

## 1. The Architecture of deepclaude-cli

Before writing any code, you must determine how your new provider accepts API traffic. Claude Code expects to speak to the **Anthropic Messages API**. If your provider speaks something else, we have to translate it.

We have three integration strategies:

1.  **Native Anthropic API (Direct Connect)**
    *   *Examples:* Kimi Code, OpenRouter, Fireworks.
    *   *How it works:* We simply change the `ANTHROPIC_BASE_URL` environment variable to point to the provider. No proxy is needed.
2.  **OpenAI API Compatible (Node.js Proxy)**
    *   *Examples:* Doubleword AI, Nvidia NIM.
    *   *How it works:* We start a local Node.js server (`proxy/model-proxy.js`). Claude Code sends Anthropic requests to this server. `openai-translator.js` converts the request to OpenAI format, sends it to the provider, and translates the OpenAI streaming response back into Anthropic's format.
3.  **Proprietary Protocols (External Gateway)**
    *   *Example:* Kiro (AWS Event Stream).
    *   *How it works:* We execute an external Go binary (`kirocc`) on port `3456`. This binary handles AWS authentication and protocol translation.

---

## 2. Step-by-Step Implementation

Let's walk through adding a provider called **Doubleword AI** (an OpenAI-compatible provider) and **Kiro** (a proprietary gateway). You must edit 4 distinct files.

### Step 1: Update Environment Files
**Files:** `proxy/.env.example` and `proxy/.env`

Users need a place to put their API keys and specify default models.

1. Open `proxy/.env.example`.
2. Add a section for the new provider:

```ini
# --- Doubleword AI ---
# Provider: OpenAI Compatible (Needs Proxy)
DOUBLEWORD_API_KEY=sk-your-doubleword-key
DOUBLEWORD_MODEL=deepseek-ai/DeepSeek-V4-Pro

# --- Kiro (AWS Claude) ---
# Provider: kirocc Gateway
# Set KIRO_API_KEY to a ksk_... key to bypass OAuth entirely (recommended).
# Leave unset to use kiro-cli SQLite OAuth tokens instead.
KIRO_API_KEY=ksk_your-kiro-key
KIRO_MODEL=claude-sonnet-4.6
```

### Step 2: Update the Bash Script
**File:** `deepclaude.sh`

This script intercepts the user's CLI arguments and configures the environment before launching Claude Code.

**A. Load the Environment Variables:**
Find the section where variables are loaded and add your new provider:
```bash
DOUBLEWORD_API_KEY="${DOUBLEWORD_API_KEY:-$(get_env_file "DOUBLEWORD_API_KEY")}"
DOUBLEWORD_MODEL="${DOUBLEWORD_MODEL:-deepseek-ai/DeepSeek-V4-Pro}"

KIRO_API_KEY="${KIRO_API_KEY:-$(get_env_file "KIRO_API_KEY")}"
KIRO_MODEL="${KIRO_MODEL:-claude-sonnet-4.6}"
```

**B. Add the Provider Definition:**
Find the `resolve_backend()` function. This is a `case` statement.
*For Doubleword (OpenAI proxy needed):*
```bash
dw|doubleword)
    needs_proxy=true        # Tells the script to boot the Node.js proxy
    canonical="doubleword"
    url="https://api.doubleword.ai/v1"
    key="$DOUBLEWORD_API_KEY"
    opus="$DOUBLEWORD_MODEL"; sonnet="$DOUBLEWORD_MODEL"
    haiku="$DOUBLEWORD_MODEL"; subagent="$DOUBLEWORD_MODEL"
    ;;
```

*For Kiro (External gateway needed):*
```bash
kiro)
    # kirocc gateway handles auth itself (API key or SQLite OAuth)
    url="http://127.0.0.1:$KIROCC_PORT"
    key="dummy"             # kirocc ignores this; auth is internal
    opus="${KIRO_MODEL:-claude-sonnet-4.6}"; sonnet="${KIRO_MODEL:-claude-sonnet-4.6}"
    haiku="${KIRO_MODEL:-claude-haiku-4.5}"; subagent="${KIRO_MODEL:-claude-haiku-4.5}"
    ;;
```

**C. Handle Gateway Booting (Kiro-specific):**

The Kiro gateway has two auth modes and requires careful process lifecycle management. The complete booting block is:

```bash
# Inside deepclaude.sh launch_claude(), before executing 'claude'
if needs_kirocc; then
    local kirocc_bin
    kirocc_bin=$(which kirocc 2>/dev/null || echo "$HOME/.local/bin/kirocc")
    if [[ ! -x "$kirocc_bin" ]]; then
        echo "ERROR: kirocc not found." >&2; exit 1
    fi

    # Auth mode selection: API key takes full priority over OAuth
    if [[ -n "${KIRO_API_KEY:-}" ]]; then
        echo "  Using KIRO_API_KEY for authentication (no OAuth required)"
        # kirocc reads KIRO_API_KEY from the environment automatically.
        # No SQLite DB, no browser login, no token refresh needed.
    else
        # Fall back to kiro-cli SQLite OAuth tokens.
        # Check if tokens exist; if not, launch kiro-cli login (one-time browser flow).
        local kiro_db="$HOME/.local/share/kiro-cli/data.sqlite3"
        local has_tokens=false
        if [[ -f "$kiro_db" ]] && command -v python3 &>/dev/null; then
            has_tokens=$(python3 -c "
import sqlite3
try:
    c = sqlite3.connect('$kiro_db')
    r = c.execute(\"SELECT COUNT(*) FROM auth_kv WHERE key LIKE 'kirocli:%:token'\").fetchone()
    print('true' if r and r[0] > 0 else 'false')
except: print('false')
" 2>/dev/null)
        fi
        if [[ "$has_tokens" != "true" ]]; then
            kiro-cli login   # blocks until browser OAuth completes
        fi
    fi

    echo "  Starting kirocc gateway on :$KIROCC_PORT..."

    # CRITICAL: Kill any stale kirocc already bound to this port.
    # Use `ss` as the primary tool — it queries the kernel directly and never hangs.
    # Fall back to `lsof` (with a 3s hard timeout) only if ss returns no PID.
    # WARNING: plain `lsof -ti tcp:PORT` without `-s TCP:LISTEN` returns ALL processes
    # using the port (server + connected clients). Without the filter, head -1 gives you
    # the claude client PID, which kills the current session. Always filter to LISTEN state.
    # Use kill -9 (SIGKILL), NOT kill (SIGTERM): SIGTERM triggers Go's graceful
    # http.Server.Shutdown(), which waits for active connections to drain.
    # Active claude sessions keep connections open indefinitely, so SIGTERM leaves the
    # port bound forever. SIGKILL releases the socket immediately.
    local stale_pid
    stale_pid=$(ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null \
        | awk -F'pid=' '/LISTEN/{split($2,a,","); print a[1]}' | head -1)
    if [[ -z "$stale_pid" ]]; then
        stale_pid=$(timeout 3 lsof -ti tcp:"$KIROCC_PORT" -s TCP:LISTEN 2>/dev/null || true)
    fi
    if [[ -n "$stale_pid" ]]; then
        kill -9 "$stale_pid" 2>/dev/null || true
        # Wait until the port is actually free (max 2s), not just a fixed sleep.
        local wait_n=0
        while timeout 1 ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null | grep -q LISTEN \
              && [[ $wait_n -lt 20 ]]; do
            sleep 0.1
            wait_n=$((wait_n + 1))
        done
    fi

    # CRITICAL: Claude Code appends date suffixes to model IDs
    # (e.g. claude-sonnet-4-6-20250514). The Kiro backend rejects these with
    # ValidationException. KIROCC_MODEL_MAPPINGS translates them before the
    # request hits the upstream API.
    export KIROCC_MODEL_MAPPINGS='[
      {"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000},
      {"anthropic":"claude-sonnet-4-5-20250929","kiro":"claude-sonnet-4.5","context_window_size":200000},
      {"anthropic":"claude-haiku-4-5-20250929","kiro":"claude-haiku-4.5","context_window_size":200000},
      {"anthropic":"claude-opus-4-6-20250514","kiro":"claude-opus-4.6","context_window_size":1000000},
      {"anthropic":"claude-opus-4-7-20250514","kiro":"claude-opus-4.7","context_window_size":1000000}
    ]'

    # Log kirocc output to a temp file so the error is visible if startup fails.
    local kirocc_log
    kirocc_log=$(mktemp /tmp/kirocc-XXXXXX.log)

    # Start kirocc. It inherits KIRO_API_KEY from the environment automatically.
    "$kirocc_bin" -port "$KIROCC_PORT" > "$kirocc_log" 2>&1 &
    PROXY_PID=$!

    # Poll until kirocc is accepting connections (max ~9s).
    # --max-time 1 prevents curl from hanging if kirocc accepts the TCP connection
    # but does not respond. Dots give the user visible progress.
    local tries=0
    while ! curl -s --max-time 1 "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1 \
          && [[ $tries -lt 30 ]]; do
        sleep 0.3
        tries=$((tries + 1))
        if (( tries % 3 == 0 )); then printf '.'; fi
    done
    echo ""

    if ! curl -s --max-time 1 "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1; then
        echo "ERROR: kirocc failed to start on port $KIROCC_PORT" >&2
        echo "--- kirocc log ---" >&2
        cat "$kirocc_log" >&2
        echo "------------------" >&2
        rm -f "$kirocc_log"
        exit 1
    fi
    rm -f "$kirocc_log"

    echo "  kirocc ready → Kiro (AWS Claude)"
fi
```

*(Ensure `cleanup_proxy()` kills `$PROXY_PID` via a `trap cleanup_proxy EXIT`.)*

**D. Update UI Menus:**
Add your shortcode (e.g., `-b dw`) to the `print_help()`, `show_status()`, and `show_cost()` functions.

### Step 3: Update the PowerShell Script
**File:** `deepclaude.ps1`

You must strictly mirror the Bash logic into PowerShell so Windows users have feature parity.

**A. Load Environment Variables:**
```powershell
$DoublewordKey = if ($env:DOUBLEWORD_API_KEY) { $env:DOUBLEWORD_API_KEY } else { [Environment]::GetEnvironmentVariable("DOUBLEWORD_API_KEY", "User") }
$DoublewordModel = if ($env:DOUBLEWORD_MODEL) { $env:DOUBLEWORD_MODEL } else { "deepseek-ai/DeepSeek-V4-Pro" }
```

**B. Add to the `$Providers` Hashtable:**
```powershell
dw = @{
    name = "Doubleword AI"; needsProxy = $true; canonical = "doubleword"
    url = "https://api.doubleword.ai/v1"
    key = $DoublewordKey; keyName = "DOUBLEWORD_API_KEY"
    opus = $DoublewordModel; sonnet = $DoublewordModel
    haiku = $DoublewordModel; subagent = $DoublewordModel
}
```

**C. Handle Gateway Booting (Windows equivalent):**
```powershell
function Start-KiroccGateway {
    $kiroccBin = Get-Command kirocc -ErrorAction SilentlyContinue
    if (-not $kiroccBin) { $kiroccBin = Join-Path $HOME "go/bin/kirocc.exe" }

    $env:KIROCC_MODEL_MAPPINGS = '[{"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000},{"anthropic":"claude-sonnet-4-5-20250929","kiro":"claude-sonnet-4.5","context_window_size":200000},{"anthropic":"claude-haiku-4-5-20250929","kiro":"claude-haiku-4.5","context_window_size":200000},{"anthropic":"claude-opus-4-6-20250514","kiro":"claude-opus-4.6","context_window_size":1000000},{"anthropic":"claude-opus-4-7-20250514","kiro":"claude-opus-4.7","context_window_size":1000000}]'

    # Kill stale listener and wait until the port is actually free (max 2s).
    # Stop-Process -Force = SIGKILL equivalent (skips graceful Go shutdown).
    $stalePid = (Get-NetTCPConnection -LocalPort $KiroccPort -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($stalePid) {
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
        $waitN = 0
        while ((Get-NetTCPConnection -LocalPort $KiroccPort -State Listen -ErrorAction SilentlyContinue) -and $waitN -lt 20) {
            Start-Sleep -Milliseconds 100
            $waitN++
        }
    }

    # Capture output to temp files so we can show a useful error if startup fails.
    $kiroStdout = [System.IO.Path]::GetTempFileName()
    $kiroStderr = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath $kiroccBin -ArgumentList "-port",$KiroccPort `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $kiroStdout `
        -RedirectStandardError $kiroStderr

    # Poll until ready. Dots show progress. TimeoutSec 1 prevents Invoke-RestMethod
    # from hanging if kirocc accepts the TCP connection but does not respond.
    $tries = 0
    while ($tries -lt 30) {
        Start-Sleep -Milliseconds 300
        $tries++
        if ($tries % 3 -eq 0) { Write-Host -NoNewline "." }
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$KiroccPort/v1/models" -TimeoutSec 1
            break
        } catch { }
    }
    Write-Host ""

    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$KiroccPort/v1/models" -TimeoutSec 1
    } catch {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        $logLines = @(Get-Content $kiroStdout -ErrorAction SilentlyContinue) +
                    @(Get-Content $kiroStderr -ErrorAction SilentlyContinue)
        Remove-Item $kiroStdout, $kiroStderr -ErrorAction SilentlyContinue
        Write-Host "--- kirocc log ---" -ForegroundColor Red
        $logLines | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
        Write-Host "------------------" -ForegroundColor Red
        throw "kirocc failed to start on port $KiroccPort"
    }
    Remove-Item $kiroStdout, $kiroStderr -ErrorAction SilentlyContinue
    return $proc
}
```
*(Ensure the process is stopped in the `finally { }` block at the end of the script.)*

### Step 4: Update the Node.js Translator (OpenAI Compatible Only)
**File:** `proxy/openai-translator.js`

If you are using `needs_proxy=true`, you must ensure the Node.js proxy understands the specific quirks of your provider.

**A. Identify the Provider:**
In the `OpenAITranslator` constructor, detect the provider based on the URL passed from the shell script.
```javascript
constructor(targetUrl, apiKey) {
    this.targetUrl = targetUrl;

    if (targetUrl.includes('api.doubleword.ai')) {
        this.provider = 'doubleword';
    } else if (targetUrl.includes('integrate.api.nvidia.com')) {
        this.provider = 'nvidia';
    }
}
```

**B. Handle Streaming Quirks (The Reasoning Problem):**
Doubleword AI (DeepSeek models) returns a `reasoning_content` field in its streaming chunks. Claude Code (Anthropic API) expects this to be formatted as a `text` block inside the response. If you don't translate this, Claude Code won't show the "thinking" process.

Locate the `_processLine(line)` method and add provider-specific parsing:
```javascript
// Inside openai-translator.js -> _processLine()

const delta = data.choices[0].delta;

// Doubleword AI specific reasoning extraction
if (this.provider === 'doubleword' && delta.reasoning_content) {
    if (!this._thinkingStarted) {
        this._thinkingStarted = true;
        // Emit Anthropic 'content_block_start' for thinking
        this.emit('data', `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: this._contentIndex++,
            content_block: { type: "text", text: "" }
        })}\n\n`);
    }
    // Emit the actual reasoning tokens
    this.emit('data', `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: this._contentIndex - 1,
        delta: { type: "text_delta", text: delta.reasoning_content }
    })}\n\n`);
    return; // Crucial: skip standard text processing for this chunk
}
```

**C. Handle Empty Chunks & Duplicate Stops:**
Some providers (like Nvidia NIM) send empty chunks or send the `stop_reason` multiple times. You must filter these to prevent breaking the strict Anthropic protocol that Claude Code expects.
```javascript
// Filter empty chunks that lack content or reasoning
if (!delta.content && !delta.reasoning_content && !data.choices[0].finish_reason) {
    return;
}

// Prevent duplicate finish events
if (data.choices[0].finish_reason) {
    if (this._finished) return;
    this._finished = true;
    // ... emit Anthropic message_stop ...
}
```

---

## 3. Kiro API Key Authentication — Deep Dive

This section documents the full implementation of `KIRO_API_KEY` (`ksk_...`) support in `kirocc`. This is the recommended auth mode: no browser OAuth, no SQLite DB dependency, instant startup.

### 3.1 How Kiro API Keys Work

Kiro API keys (`ksk_...` prefix) are **long-lived bearer tokens**. Unlike OAuth tokens, they do not require an exchange — they are sent directly in the `Authorization: Bearer` header, exactly like any API key. The Kiro backend distinguishes them from OAuth tokens via a custom `TokenType: API_KEY` HTTP header.

Without this header, the backend treats the bearer value as an OAuth token, fails validation, and returns HTTP 403 `AccessDeniedException`. With the header, the backend routes the request through API key validation and returns a proper response.

This was discovered by disassembling the Kiro CLI (`kiro-cli`) binary — specifically the `TokenTypeInterceptor.modify_before_signing` function, which injects the `TokenType` header. The packed enum string at offset `0x2ecb90` in the binary revealed the valid values: `API_KEY` and `EXTERNAL_IDP`.

### 3.2 Changes Required in kirocc

Four files in the `kirocc-fork` need modification.

#### `internal/auth/db.go` — Add `TokenType` to Credentials

```go
type Credentials struct {
    AccessToken  string
    RefreshToken string
    ExpiresAt    int64
    Region       string
    SSORegion    string
    ClientID     string
    ClientSecret string
    ProfileARN   string
    AuthType     string
    TokenType    string // if non-empty, sent as "TokenType" HTTP header (e.g. "API_KEY")
}
```

#### `internal/auth/apikey.go` — New file: API key auth manager

```go
package auth

import (
    "context"
    "os"
    "sync"
    "time"
)

const (
    APIKeyTokenType = "API_KEY"
    apiKeyTTL       = 24 * time.Hour
)

// APIKeyAuthManager implements tokenProvider for KIRO_API_KEY (ksk_...) credentials.
// The key is used directly as the Bearer token — no exchange, no OAuth, no DB.
// The backend differentiates it from OAuth tokens via "TokenType: API_KEY" header.
type APIKeyAuthManager struct {
    apiKey string
    region string
    mu     sync.Mutex
    cached *Credentials
}

func NewAPIKeyAuthManager(apiKey string) *APIKeyAuthManager {
    return &APIKeyAuthManager{apiKey: apiKey, region: "us-east-1"}
}

func (m *APIKeyAuthManager) GetToken(_ context.Context) (*Credentials, error) {
    m.mu.Lock()
    defer m.mu.Unlock()
    if m.cached != nil && isTokenValid(m.cached.ExpiresAt) {
        c := *m.cached
        return &c, nil
    }
    creds := &Credentials{
        AccessToken: m.apiKey,
        ExpiresAt:   time.Now().Add(apiKeyTTL).Unix(),
        Region:      m.region,
        TokenType:   APIKeyTokenType,
        AuthType:    "apikey",
    }
    m.cached = creds
    c := *creds
    return &c, nil
}

func (m *APIKeyAuthManager) InvalidateCache() {
    m.mu.Lock()
    m.cached = nil
    m.mu.Unlock()
}

// GetAPIKey reads KIRO_API_KEY from the environment.
func GetAPIKey() string {
    return os.Getenv("KIRO_API_KEY")
}
```

#### `internal/kiroclient/client.go` — Propagate TokenType on every request

The `TokenRefresher` callback must return three values (token, tokenType, error) so the client updates both on a 403 retry:

```go
// TokenRefresher is called on 403 to get a fresh token.
// Returns the new token, an optional TokenType header value, and any error.
type TokenRefresher func(ctx context.Context) (newToken string, tokenType string, err error)
```

Add `tokenType` field and `WithTokenType` option to `HTTPClient`:

```go
type HTTPClient struct {
    // ...existing fields...
    tokenType string // sent as "TokenType" header if non-empty
}

func WithTokenType(tokenType string) HTTPClientOption {
    return func(c *HTTPClient) { c.tokenType = tokenType }
}
```

In `GenerateAssistantResponse`, track and send `currentTokenType` on each attempt:

```go
currentToken := token
currentTokenType := c.tokenType   // initialized from WithTokenType option

for attempt := 0; attempt <= maxRetries; attempt++ {
    // ...build req...
    if currentTokenType != "" {
        req.Header.Set("TokenType", currentTokenType)
    }

    // On 403: refresh and capture new token type
    case resp.StatusCode == http.StatusForbidden:
        if attempt < maxRetries && c.tokenRefresher != nil {
            newToken, newTokenType, err := c.tokenRefresher(ctx)
            if err == nil {
                currentToken = newToken
                currentTokenType = newTokenType
                continue
            }
        }
```

#### `cmd/kirocc/main.go` — Select auth manager based on KIRO_API_KEY

```go
var authMgr tokenProvider
if apiKey := auth.GetAPIKey(); apiKey != "" {
    slog.Info("KIRO_API_KEY detected — using API key authentication")
    authMgr = auth.NewAPIKeyAuthManager(apiKey)
} else {
    authMgr = auth.NewAuthManager(cfg.DBPath)
}
```

In `buildKiroClient`, read the initial token type so the very first request already has the `TokenType` header:

```go
func buildKiroClient(authMgr tokenProvider, cfg config.Config) kiroclient.Client {
    clientOpts := []kiroclient.HTTPClientOption{
        kiroclient.WithTokenCounter(tokencount.CountBytes),
        kiroclient.WithTokenRefresher(func(ctx context.Context) (string, string, error) {
            authMgr.InvalidateCache()
            creds, err := authMgr.GetToken(ctx)
            if err != nil {
                return "", "", err
            }
            return creds.AccessToken, creds.TokenType, nil
        }),
    }
    // Set initial TokenType from first credentials fetch.
    // Without this, the very first request goes out without the header.
    if creds, err := authMgr.GetToken(context.Background()); err == nil && creds.TokenType != "" {
        clientOpts = append(clientOpts, kiroclient.WithTokenType(creds.TokenType))
    }
    if cfg.OTel {
        clientOpts = append(clientOpts, kiroclient.WithOTel(cfg.OTelBodyLimit))
    }
    return kiroclient.NewHTTPClient(clientOpts...)
}
```

### 3.3 Building and Installing

kirocc uses `encoding/json/v2` which requires the `jsonv2` experiment flag:

```bash
cd kirocc-fork
GOEXPERIMENT=jsonv2 go build -o ~/.local/bin/kirocc ./cmd/kirocc/
```

Run tests to confirm all packages pass:

```bash
GOEXPERIMENT=jsonv2 go test ./...
```

---

## 4. Known Issues and Fixes

### Issue 1: Startup Hang — "Starting kirocc gateway on :PORT..."

**Symptom:** Script prints `Starting kirocc gateway on :3456...` and freezes. No further output. Affects second and subsequent runs when a stale kirocc is still bound to the port.

**Root cause (stale process):** A previous kirocc instance left over from a prior session is still listening on port 3456. The new kirocc fails to bind and exits silently. The health-check curl hits the stale instance but receives no response (or an unexpected one).

**Wrong fix 1 — missing `-s TCP:LISTEN` (kills claude, not kirocc):**
```bash
# WRONG: lsof without -s TCP:LISTEN returns ALL processes using the port,
# including claude clients. head -1 picks the client PID and kills the session.
stale_pid=$(lsof -ti tcp:"$KIROCC_PORT" | head -1)
kill "$stale_pid"
```

**Wrong fix 2 — SIGTERM instead of SIGKILL (port stays bound):**
```bash
# WRONG: SIGTERM → Go's http.Server.Shutdown() → waits for active connections to drain.
# Active claude sessions keep connections open indefinitely → port bound forever.
kill "$stale_pid"   # implicit SIGTERM
```

**Wrong fix 3 — fixed sleep instead of polling (race on slow systems):**
```bash
# WRONG: 200ms may not be enough on a loaded system for the kernel to release the socket.
kill -9 "$stale_pid" 2>/dev/null || true
sleep 0.2   # race condition — new kirocc may fail to bind
```

**Correct fix:**
```bash
# ss queries the kernel directly, never hangs, returns only LISTEN sockets.
# lsof with -s TCP:LISTEN is the fallback with a 3s hard timeout.
# kill -9 releases the socket immediately.
# Wait loop ensures the port is free before starting the new process.
local stale_pid
stale_pid=$(ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null \
    | awk -F'pid=' '/LISTEN/{split($2,a,","); print a[1]}' | head -1)
if [[ -z "$stale_pid" ]]; then
    stale_pid=$(timeout 3 lsof -ti tcp:"$KIROCC_PORT" -s TCP:LISTEN 2>/dev/null || true)
fi
if [[ -n "$stale_pid" ]]; then
    kill -9 "$stale_pid" 2>/dev/null || true
    local wait_n=0
    while timeout 1 ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null | grep -q LISTEN \
          && [[ $wait_n -lt 20 ]]; do
        sleep 0.1
        wait_n=$((wait_n + 1))
    done
fi
```

**Why `kill -9` is safe here:** kirocc is a stateless proxy with no write-ahead log or on-disk state. Force-killing it loses nothing. The old session's Claude Code will get a connection error on the next request, which is acceptable because the user is starting a new session anyway.

### Issue 2: Wrong Auth After Restart

**Symptom:** `KIRO_API_KEY` is set, but API calls still use the old OAuth tokens (SQLite auth). Requests may fail if OAuth tokens have expired.

**Root cause:** The stale kirocc (using SQLite auth) is still on the port. The new kirocc (with `KIRO_API_KEY`) failed to start. The health check hits the old instance and reports "ready". All subsequent requests are authenticated with OAuth, not the API key.

**Fix:** The `ss`-first + `kill -9` approach from Issue 1 ensures the new kirocc always starts fresh with the correct auth mode.

### Issue 3: curl Health Check Hangs

**Symptom:** Health check curl hangs indefinitely if kirocc accepts the TCP connection but never responds (e.g., blocked on a slow DB read at startup).

**Fix:** Always use `--max-time 1` on health check curls:
```bash
curl -s --max-time 1 "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1
```

### Issue 4: `lsof` Itself Hangs — Script Freezes at "Starting kirocc gateway..."

**Symptom:** Script freezes immediately at `Starting kirocc gateway on :3456...` even when no stale process is running and the port is free. The hang occurs on second or subsequent runs.

**Root cause:** `lsof` can block indefinitely on certain Linux systems — most commonly when NFS-mounted filesystems are present, when the kernel has zombie processes, or under high memory pressure. The command `lsof -ti tcp:PORT` scans all open file descriptors across all processes and can stall while waiting for an unresponsive NFS server or an unkillable zombie. Since the stale-PID detection runs before kirocc is even launched, the script appears stuck at the "Starting..." message with zero output.

**Wrong fix (still hangs):**
```bash
# WRONG: still uses lsof as the primary command
stale_pid=$(lsof -ti tcp:"$KIROCC_PORT" -s TCP:LISTEN 2>/dev/null)
```

**Correct fix — use `ss` as primary, `lsof` as a last-resort fallback with timeout:**
```bash
# ss talks directly to the kernel via netlink, never scans /proc, never hangs.
stale_pid=$(ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null \
    | awk -F'pid=' '/LISTEN/{split($2,a,","); print a[1]}' | head -1)
# Only call lsof if ss returned nothing, and cap it at 3 seconds.
if [[ -z "$stale_pid" ]]; then
    stale_pid=$(timeout 3 lsof -ti tcp:"$KIROCC_PORT" -s TCP:LISTEN 2>/dev/null || true)
fi
```

**Windows equivalent** — `Get-NetTCPConnection` is already kernel-backed and does not have this problem.

### Issue 5: No Error Details When kirocc Fails to Start

**Symptom:** Script prints `ERROR: kirocc failed to start on port 3456` but gives no clue why — port conflict, bad binary, missing env var, etc.

**Fix:** Redirect kirocc's output to a temp file and display it on failure:
```bash
local kirocc_log
kirocc_log=$(mktemp /tmp/kirocc-XXXXXX.log)
"$kirocc_bin" -port "$KIROCC_PORT" > "$kirocc_log" 2>&1 &

# ... health check loop ...

if ! curl -s --max-time 1 "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1; then
    echo "ERROR: kirocc failed to start on port $KIROCC_PORT" >&2
    echo "--- kirocc log ---" >&2
    cat "$kirocc_log" >&2
    echo "------------------" >&2
    rm -f "$kirocc_log"
    exit 1
fi
rm -f "$kirocc_log"
```

**PowerShell equivalent:**
```powershell
$kiroStdout = [System.IO.Path]::GetTempFileName()
$kiroStderr = [System.IO.Path]::GetTempFileName()
$proc = Start-Process -FilePath $kiroccBin -ArgumentList "-port",$KiroccPort `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $kiroStdout -RedirectStandardError $kiroStderr

# ... health check loop ...

try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$KiroccPort/v1/models" -TimeoutSec 1
} catch {
    $logLines = @(Get-Content $kiroStdout -ErrorAction SilentlyContinue) +
                @(Get-Content $kiroStderr -ErrorAction SilentlyContinue)
    Remove-Item $kiroStdout, $kiroStderr -ErrorAction SilentlyContinue
    Write-Host "--- kirocc log ---" -ForegroundColor Red
    $logLines | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
    Write-Host "------------------" -ForegroundColor Red
    throw "kirocc failed to start on port $KiroccPort"
}
Remove-Item $kiroStdout, $kiroStderr -ErrorAction SilentlyContinue
```

### Issue 6: Model ID Validation Errors

**Symptom:** Kiro backend returns `ValidationException: Invalid model ID` for every request.

**Root cause:** Claude Code internally appends date suffixes to model IDs. When you set `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.7`, Claude Code transforms this to `claude-opus-4-7-20250514` before sending it in the API request. The Kiro backend only accepts the base names (`claude-opus-4.7`).

**Fix:** Set `KIROCC_MODEL_MAPPINGS` env var before launching kirocc. It defines a translation table from Claude Code's suffixed names to Kiro's expected names:
```bash
export KIROCC_MODEL_MAPPINGS='[
  {"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000},
  {"anthropic":"claude-sonnet-4-5-20250929","kiro":"claude-sonnet-4.5","context_window_size":200000},
  {"anthropic":"claude-haiku-4-5-20250929","kiro":"claude-haiku-4.5","context_window_size":200000},
  {"anthropic":"claude-opus-4-6-20250514","kiro":"claude-opus-4.6","context_window_size":1000000},
  {"anthropic":"claude-opus-4-7-20250514","kiro":"claude-opus-4.7","context_window_size":1000000}
]'
```

---

## 5. Summary of Core Provider Types Implemented

1.  **Kimi Code (`-b kimi`)**: The easiest. Pure Anthropic format. Only required changing `.sh` and `.ps1` to route `ANTHROPIC_BASE_URL` to `api.moonshot.cn/v1`.
2.  **Nvidia NIM (`-b nv`)**: OpenAI format. Required `needs_proxy=true`. We had to update the Node proxy to strip specific system prompts that Nvidia rejected.
3.  **Doubleword AI (`-b dw`)**: OpenAI format. Required `needs_proxy=true`. We had to deeply modify the streaming parser in `openai-translator.js` to extract `reasoning_content` so DeepSeek V4 Pro's "thinking" phase was visible in Claude Code.
4.  **Kiro (`-b kiro`)**: The hardest. Required spawning a 3rd-party Go binary (`kirocc`). Key challenges:
    - **Model ID translation** via `KIROCC_MODEL_MAPPINGS` (Claude Code injects date suffixes that Kiro rejects)
    - **API key auth** (`ksk_...` keys are used directly as bearer tokens + `TokenType: API_KEY` header, no OAuth exchange needed — discovered by disassembling the kiro-cli binary)
    - **Process lifecycle management** (`ss`-first stale detection, `kill -9` to bypass Go's graceful shutdown, poll-until-free wait loop instead of fixed sleep)
    - **Health check robustness** (`--max-time 1` on curl, progress dots, kirocc log captured to temp file and shown on failure)
    - **`lsof` hang avoidance** (replaced `lsof` with `ss` as primary PID detector — `lsof` blocks indefinitely on NFS/zombie-process systems)

By following this guide, you can confidently integrate any future LLM provider, regardless of whether it uses native Anthropic, OpenAI format, or a proprietary enterprise gateway.
