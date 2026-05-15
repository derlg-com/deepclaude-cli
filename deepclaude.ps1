<#
.SYNOPSIS
    deepclaude — Use Claude Code with DeepSeek V4 Pro or other cheap backends.

.USAGE
    deepclaude                      # DeepSeek V4 Pro (default)
    deepclaude --backend or         # OpenRouter (cheapest)
    deepclaude --backend fw         # Fireworks AI (fastest)
    deepclaude --backend nv         # Nvidia NIM (kimi-k2.6)
    deepclaude --backend kimi       # Kimi Code (subscription)
    deepclaude --backend dw         # Doubleword AI
    deepclaude --backend kiro       # Kiro (AWS Claude, via kirocc)
    deepclaude --backend anthropic  # Normal Claude Code
    deepclaude --remote             # Remote control + default backend
    deepclaude --status             # Show keys and backends
    deepclaude --cost               # Pricing comparison
    deepclaude --benchmark          # Latency test
#>

param(
    [Alias("b")]
    [string]$Backend,
    [Alias("r")]
    [switch]$Remote,
    [switch]$Status,
    [switch]$Cost,
    [switch]$Benchmark,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Load .env if present ──
$envFile = Join-Path $ScriptDir "proxy\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^\s*#' -or [string]::IsNullOrWhiteSpace($line)) { return }
        # Strip inline comments
        $line = $line -replace '\s+#.*$', ''
        if ($line -match '^([A-Z_]+)=(.*)$') {
            $key = $Matches[1]
            $val = $Matches[2]
            # Only set if not already in environment
            if (-not [Environment]::GetEnvironmentVariable($key, "Process")) {
                [Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
}

if (-not $Backend -and -not $Status -and -not $Cost -and -not $Benchmark -and -not $Help) {
    $envProvider = $env:API_PROVIDER
    $Backend = if ($env:CHEAPCLAUDE_DEFAULT_BACKEND) { $env:CHEAPCLAUDE_DEFAULT_BACKEND }
               elseif ($envProvider) { $envProvider }
               else { "ds" }
}

# --- Config ---
$DeepSeekKey = if ($env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY } else {
    [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
}
$OpenRouterKey = if ($env:OPENROUTER_API_KEY) { $env:OPENROUTER_API_KEY } else {
    [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "User")
}
$FireworksKey = if ($env:FIREWORKS_API_KEY) { $env:FIREWORKS_API_KEY } else {
    [Environment]::GetEnvironmentVariable("FIREWORKS_API_KEY", "User")
}
$NvidiaKey = if ($env:NVIDIA_API_KEY) { $env:NVIDIA_API_KEY } else {
    [Environment]::GetEnvironmentVariable("NVIDIA_API_KEY", "User")
}
$KimiKey = if ($env:KIMI_API_KEY) { $env:KIMI_API_KEY } else {
    [Environment]::GetEnvironmentVariable("KIMI_API_KEY", "User")
}
$DoublewordKey = if ($env:DOUBLEWORD_API_KEY) { $env:DOUBLEWORD_API_KEY } else {
    [Environment]::GetEnvironmentVariable("DOUBLEWORD_API_KEY", "User")
}
$KiroKey = if ($env:KIRO_API_KEY) { $env:KIRO_API_KEY } else {
    [Environment]::GetEnvironmentVariable("KIRO_API_KEY", "User")
}

$NvidiaModel = if ($env:NVIDIA_MODEL) { $env:NVIDIA_MODEL } else { "moonshotai/kimi-k2.6" }
$KimiModel = if ($env:KIMI_MODEL) { $env:KIMI_MODEL } else { "kimi-for-coding" }
$DoublewordModel = if ($env:DOUBLEWORD_MODEL) { $env:DOUBLEWORD_MODEL } else { "deepseek-ai/DeepSeek-V4-Pro" }
$DeepSeekModel = if ($env:DEEPSEEK_MODEL) { $env:DEEPSEEK_MODEL } else { "deepseek-v4-pro" }
$KiroModel = if ($env:KIRO_MODEL) { $env:KIRO_MODEL } else { "claude-sonnet-4.6" }
$KiroccPort = 3456

$Providers = @{
    ds = @{
        name = "DeepSeek (direct)"; needsProxy = $false
        url = "https://api.deepseek.com/anthropic"
        key = $DeepSeekKey; keyName = "DEEPSEEK_API_KEY"
        opus = $DeepSeekModel; sonnet = $DeepSeekModel
        haiku = "deepseek-v4-flash"; subagent = "deepseek-v4-flash"
    }
    or = @{
        name = "OpenRouter"; needsProxy = $false
        url = "https://openrouter.ai/api"
        key = $OpenRouterKey; keyName = "OPENROUTER_API_KEY"
        opus = "deepseek/deepseek-v4-pro"; sonnet = "deepseek/deepseek-v4-pro"
        haiku = "deepseek/deepseek-v4-pro"; subagent = "deepseek/deepseek-v4-pro"
    }
    fw = @{
        name = "Fireworks AI"; needsProxy = $false
        url = "https://api.fireworks.ai/inference"
        key = $FireworksKey; keyName = "FIREWORKS_API_KEY"
        opus = "accounts/fireworks/models/deepseek-v4-pro"
        sonnet = "accounts/fireworks/models/deepseek-v4-pro"
        haiku = "accounts/fireworks/models/deepseek-v4-pro"
        subagent = "accounts/fireworks/models/deepseek-v4-pro"
    }
    nv = @{
        name = "Nvidia NIM"; needsProxy = $true; canonical = "nvidia"
        url = "https://integrate.api.nvidia.com/v1"
        key = $NvidiaKey; keyName = "NVIDIA_API_KEY"
        opus = $NvidiaModel; sonnet = $NvidiaModel
        haiku = $NvidiaModel; subagent = $NvidiaModel
    }
    kimi = @{
        name = "Kimi Code"; needsProxy = $false
        url = "https://api.kimi.com/coding/"
        key = $KimiKey; keyName = "KIMI_API_KEY"
        opus = $KimiModel; sonnet = $KimiModel
        haiku = $KimiModel; subagent = $KimiModel
    }
    dw = @{
        name = "Doubleword AI"; needsProxy = $true; canonical = "doubleword"
        url = "https://api.doubleword.ai/v1"
        key = $DoublewordKey; keyName = "DOUBLEWORD_API_KEY"
        opus = $DoublewordModel; sonnet = $DoublewordModel
        haiku = $DoublewordModel; subagent = $DoublewordModel
    }
    kiro = @{
        name = "Kiro (AWS Claude)"; needsProxy = $false; needsKirocc = $true
        url = "http://127.0.0.1:$KiroccPort"
        key = "dummy"; keyName = "KIRO_API_KEY"
        opus = $KiroModel; sonnet = $KiroModel
        haiku = "claude-haiku-4.5"; subagent = "claude-haiku-4.5"
    }
}

function Get-KeyDisplay($k) {
    if (-not $k) { return "MISSING" }
    return "set (****" + $k.Substring($k.Length - [Math]::Min(4, $k.Length)) + ")"
}

# --- Status ---
if ($Status) {
    Write-Host "`n  deepclaude - Backend Status" -ForegroundColor Cyan
    Write-Host "  ============================" -ForegroundColor DarkGray
    Write-Host "`n  Keys:" -ForegroundColor Yellow
    Write-Host "    DEEPSEEK_API_KEY:    $(Get-KeyDisplay $DeepSeekKey)"
    Write-Host "    OPENROUTER_API_KEY:  $(Get-KeyDisplay $OpenRouterKey)"
    Write-Host "    FIREWORKS_API_KEY:   $(Get-KeyDisplay $FireworksKey)"
    Write-Host "    NVIDIA_API_KEY:      $(Get-KeyDisplay $NvidiaKey)"
    Write-Host "    KIMI_API_KEY:        $(Get-KeyDisplay $KimiKey)"
    Write-Host "    DOUBLEWORD_API_KEY:  $(Get-KeyDisplay $DoublewordKey)"
    Write-Host "    KIRO_API_KEY:        $(Get-KeyDisplay $KiroKey)"
    $kiroccPath = Get-Command kirocc -ErrorAction SilentlyContinue
    Write-Host "    kirocc:              $(if ($kiroccPath) { 'installed' } else { 'NOT FOUND' })"
    Write-Host "`n  Backends:" -ForegroundColor Yellow
    Write-Host "    deepclaude              # DeepSeek V4 Pro (default)"
    Write-Host "    deepclaude -b or        # OpenRouter (cheapest)"
    Write-Host "    deepclaude -b fw        # Fireworks AI (fastest)"
    Write-Host "    deepclaude -b nv        # Nvidia NIM (kimi-k2.6)"
    Write-Host "    deepclaude -b kimi      # Kimi Code (subscription)"
    Write-Host "    deepclaude -b dw        # Doubleword AI"
    Write-Host "    deepclaude -b kiro      # Kiro (AWS Claude, via kirocc)"
    Write-Host "    deepclaude -b anthropic # Normal Claude Code"
    Write-Host ""
    exit 0
}

# --- Cost ---
if ($Cost) {
    Write-Host "`n  DeepClaude Provider Pricing" -ForegroundColor Cyan
    Write-Host "  ===========================" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Provider        Input/M    Output/M   Notes" -ForegroundColor Yellow
    Write-Host "  ----------      --------   --------   -----------"
    Write-Host "  DeepSeek        `$0.44      `$0.87      Native Anthropic" -ForegroundColor Green
    Write-Host "  OpenRouter      `$0.44      `$0.87      Multi-provider"
    Write-Host "  Fireworks       `$1.74      `$3.48      Low latency"
    Write-Host "  Nvidia NIM      `$0.44      `$0.87      OpenAI-compat"
    Write-Host "  Kimi Code       subscription         Anthropic-native"
    Write-Host "  Doubleword      `$0.44      `$0.87      OpenAI-compat"
    Write-Host "  Kiro            subscription         AWS Claude (kirocc)"
    Write-Host "  Anthropic       `$3.00      `$15.00     Official"
    Write-Host ""
    exit 0
}

# --- Help ---
if ($Help) {
    Write-Host "deepclaude - Claude Code with cheap backends"
    Write-Host ""
    Write-Host "Usage: deepclaude [-b backend] [--status] [--cost] [--benchmark]"
    Write-Host ""
    Write-Host "  -b, --backend   ds (default), or, fw, nv, kimi, dw, kiro, anthropic"
    Write-Host "  --status        Show keys and backends"
    Write-Host "  --cost          Pricing comparison"
    Write-Host "  --benchmark     Latency test"
    exit 0
}

# --- Benchmark ---
if ($Benchmark) {
    Write-Host "`n  Latency Benchmark" -ForegroundColor Cyan
    Write-Host "  ==================" -ForegroundColor DarkGray
    foreach ($id in @("ds","or","fw")) {
        $p = $Providers[$id]
        Write-Host "  $($p.name)..." -NoNewline
        if (-not $p.key) { Write-Host " SKIP (no key)" -ForegroundColor DarkGray; continue }
        $useBearer = $id -in @("or","fw")
        $headers = if ($useBearer) {
            @{ "Authorization" = "Bearer $($p.key)"; "content-type" = "application/json"; "anthropic-version" = "2023-06-01" }
        } else {
            @{ "x-api-key" = $p.key; "content-type" = "application/json"; "anthropic-version" = "2023-06-01" }
        }
        $body = @{ model = $p.opus; max_tokens = 32; messages = @(@{ role = "user"; content = "Reply: ok" }) } | ConvertTo-Json -Depth 5
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $null = Invoke-RestMethod -Uri "$($p.url)/v1/messages" -Method POST -Headers $headers -Body $body -TimeoutSec 30
            $sw.Stop()
            Write-Host " OK ($($sw.ElapsedMilliseconds)ms)" -ForegroundColor Green
        } catch {
            $sw.Stop()
            $code = if ($_.Exception.Response) { $_.Exception.Response.StatusCode.value__ } else { "timeout" }
            Write-Host " FAIL ($code, $($sw.ElapsedMilliseconds)ms)" -ForegroundColor Red
        }
    }
    Write-Host ""
    exit 0
}

# ── Helper: Start proxy for OpenAI-compat backends ──
function Start-TranslationProxy {
    param($Provider)
    $proxyScript = Join-Path $ScriptDir "proxy\start-proxy.js"
    $canonical = if ($Provider.canonical) { $Provider.canonical } else { $Backend }
    $tempFile = [System.IO.Path]::GetTempFileName()

    $proxyProc = Start-Process -FilePath "node" `
        -ArgumentList @($proxyScript, $Provider.url, $Provider.key) `
        -PassThru -WindowStyle Hidden -RedirectStandardOutput $tempFile

    $tries = 0
    while ($tries -lt 30) {
        Start-Sleep -Milliseconds 200
        $tries++
        if (Test-Path $tempFile) {
            $content = Get-Content $tempFile -ErrorAction SilentlyContinue
            if ($content) { break }
        }
    }

    $proxyPort = (Get-Content $tempFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    Remove-Item $tempFile -ErrorAction SilentlyContinue

    if (-not $proxyPort) {
        if ($proxyProc -and -not $proxyProc.HasExited) { Stop-Process -Id $proxyProc.Id -Force }
        throw "Proxy failed to start"
    }

    return @{ Port = ($proxyPort -replace '[^0-9]',''); Proc = $proxyProc }
}

# ── Helper: Start kirocc gateway for Kiro backend ──
function Start-KiroccGateway {
    # Find kirocc binary
    $kiroccBin = Get-Command kirocc -ErrorAction SilentlyContinue
    if (-not $kiroccBin) {
        $homeBin = Join-Path $HOME ".local/bin/kirocc"
        if (Test-Path $homeBin) { $kiroccBin = $homeBin }
        else {
            $goBin = Join-Path $HOME "go/bin/kirocc.exe"
            if (Test-Path $goBin) { $kiroccBin = $goBin }
        }
    } else {
        $kiroccBin = $kiroccBin.Source
    }
    if (-not $kiroccBin -or -not (Test-Path $kiroccBin)) {
        throw "kirocc not found. Install: GOEXPERIMENT=jsonv2 go install github.com/d-kuro/kirocc/cmd/kirocc@latest"
    }

    # Auth mode: KIRO_API_KEY (ksk_...) bypasses OAuth/SQLite entirely.
    # kirocc uses the key directly as a Bearer token + sends "TokenType: API_KEY"
    # header so the Kiro backend routes it through API key validation, not OAuth.
    if ($KiroKey) {
        Write-Host "  Using KIRO_API_KEY for authentication (no OAuth required)" -ForegroundColor DarkGray
        # kirocc reads KIRO_API_KEY from the environment automatically — nothing else needed.
    } else {
        # Fall back to kiro-cli SQLite OAuth tokens.
        $kiroDB = Join-Path $HOME ".local/share/kiro-cli/data.sqlite3"
        if ($IsWindows) { $kiroDB = Join-Path $env:LOCALAPPDATA "kiro-cli/data.sqlite3" }
        $hasTokens = $false
        if (Test-Path $kiroDB) {
            try {
                $pyCheck = python3 -c @"
import sqlite3
try:
    c = sqlite3.connect('$($kiroDB -replace "\\","/')')
    r = c.execute("SELECT COUNT(*) FROM auth_kv WHERE key LIKE 'kirocli:%:token'").fetchone()
    print('true' if r and r[0] > 0 else 'false')
except: print('false')
"@ 2>$null
                if ($pyCheck -eq 'true') { $hasTokens = $true }
            } catch { }
        }

        if (-not $hasTokens) {
            Write-Host ""
            Write-Host "  ╭─────────────────────────────────────────────────╮" -ForegroundColor Cyan
            Write-Host "  │  First-time setup: Kiro login required (once)   │" -ForegroundColor Cyan
            Write-Host "  │  kirocc auto-refreshes tokens after this.       │" -ForegroundColor Cyan
            Write-Host "  ╰─────────────────────────────────────────────────╯" -ForegroundColor Cyan
            Write-Host ""
            $kiroCli = Get-Command kiro-cli -ErrorAction SilentlyContinue
            if (-not $kiroCli) {
                $kiroCliPath = Join-Path $HOME ".local/bin/kiro-cli"
                if (Test-Path $kiroCliPath) { $kiroCli = $kiroCliPath }
            } else { $kiroCli = $kiroCli.Source }

            if ($kiroCli -and (Test-Path $kiroCli)) {
                & $kiroCli login
                # Re-check tokens
                try {
                    $pyCheck = python3 -c @"
import sqlite3
try:
    c = sqlite3.connect('$($kiroDB -replace "\\","/')')
    r = c.execute("SELECT COUNT(*) FROM auth_kv WHERE key LIKE 'kirocli:%:token'").fetchone()
    print('true' if r and r[0] > 0 else 'false')
except: print('false')
"@ 2>$null
                    if ($pyCheck -eq 'true') { $hasTokens = $true }
                } catch { }
                if (-not $hasTokens) {
                    throw "Kiro auth failed. Run 'kiro-cli login' manually."
                }
                Write-Host "  ✓ Kiro login successful — tokens will auto-refresh" -ForegroundColor Green
            } else {
                throw "kiro-cli not found. Install: curl -fsSL https://kiro.dev/install.sh | bash"
            }
        }
    }

    Write-Host "  Starting kirocc gateway on :$KiroccPort..." -ForegroundColor DarkGray

    # Kill any stale kirocc already listening on this port.
    # Use Stop-Process -Force (equivalent to kill -9 / SIGKILL) — NOT graceful termination.
    # Graceful stop triggers Go's http.Server.Shutdown() which waits for active connections
    # to drain before releasing the listen socket. Active claude sessions keep connections
    # open indefinitely, so graceful stop leaves the port bound forever and the new
    # kirocc (with the correct auth) can never start.
    $stalePid = (Get-NetTCPConnection -LocalPort $KiroccPort -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($stalePid) {
        Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 200
    }

    # Map Claude Code's date-suffixed model names to Kiro model IDs.
    # Claude Code appends dates internally (e.g. claude-sonnet-4-6-20250514).
    # The Kiro backend rejects these — this table strips them before the request
    # reaches the upstream API.
    $env:KIROCC_MODEL_MAPPINGS = '[{"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000},{"anthropic":"claude-sonnet-4-5-20250929","kiro":"claude-sonnet-4.5","context_window_size":200000},{"anthropic":"claude-haiku-4-5-20250929","kiro":"claude-haiku-4.5","context_window_size":200000},{"anthropic":"claude-opus-4-6-20250514","kiro":"claude-opus-4.6","context_window_size":1000000},{"anthropic":"claude-opus-4-7-20250514","kiro":"claude-opus-4.7","context_window_size":1000000}]'

    # kirocc inherits KIRO_API_KEY from the current process environment automatically.
    $proc = Start-Process -FilePath $kiroccBin -ArgumentList "-port",$KiroccPort `
        -PassThru -WindowStyle Hidden

    # Poll until kirocc is accepting connections (typically < 100ms).
    # TimeoutSec 1 prevents Invoke-RestMethod from hanging if kirocc accepts
    # the TCP connection but does not respond.
    $tries = 0
    while ($tries -lt 30) {
        Start-Sleep -Milliseconds 300
        $tries++
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$KiroccPort/v1/models" -TimeoutSec 1
            break
        } catch { }
    }

    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$KiroccPort/v1/models" -TimeoutSec 1
    } catch {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        throw "kirocc failed to start on port $KiroccPort"
    }

    Write-Host "  kirocc ready -> Kiro (AWS Claude)" -ForegroundColor Green
    return $proc
}

# --- Remote ---
if ($Remote) {
    if ($Backend -eq "anthropic") {
        Write-Host "`n  Launching remote control (Anthropic)...`n" -ForegroundColor Cyan
        foreach ($v in @("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL","CLAUDE_CODE_EFFORT_LEVEL")) {
            Remove-Item "Env:$v" -ErrorAction SilentlyContinue
        }
        Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
        & claude remote-control @Args
        exit 0
    }

    $p = $Providers[$Backend]
    if (-not $p) { Write-Host "ERROR: Unknown backend '$Backend'. Use: ds, or, fw, nv, kimi, dw, kiro, anthropic" -ForegroundColor Red; exit 1 }
    if (-not $p.needsKirocc -and -not $p.key) { Write-Host "ERROR: $($p.keyName) not set" -ForegroundColor Red; exit 1 }

    # Kiro backend in remote mode
    if ($p.needsKirocc) {
        try {
            $kiroccProc = Start-KiroccGateway
        } catch {
            Write-Host "ERROR: $_" -ForegroundColor Red; exit 1
        }
        Write-Host "  Launching remote control via Kiro...`n" -ForegroundColor Cyan
        $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$KiroccPort"
        Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
        try {
            & claude remote-control @Args
        } finally {
            if ($kiroccProc -and -not $kiroccProc.HasExited) {
                Stop-Process -Id $kiroccProc.Id -Force -ErrorAction SilentlyContinue
                Write-Host "  kirocc stopped." -ForegroundColor DarkGray
            }
        }
        exit 0
    }

    Write-Host "`n  Starting model proxy for $($p.name)..." -ForegroundColor Cyan

    $proxyScript = Join-Path $ScriptDir "proxy\start-proxy.js"
    $proxyProc = Start-Process -FilePath "node" -ArgumentList $proxyScript,$p.url,$p.key -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\deepclaude-proxy-port.txt"

    $tries = 0
    while ($tries -lt 30) {
        Start-Sleep -Milliseconds 200
        $tries++
        if (Test-Path "$env:TEMP\deepclaude-proxy-port.txt") {
            $content = Get-Content "$env:TEMP\deepclaude-proxy-port.txt" -ErrorAction SilentlyContinue
            if ($content) { break }
        }
    }

    $proxyPort = (Get-Content "$env:TEMP\deepclaude-proxy-port.txt" -ErrorAction SilentlyContinue | Select-Object -First 1)
    Remove-Item "$env:TEMP\deepclaude-proxy-port.txt" -ErrorAction SilentlyContinue

    if (-not $proxyPort) {
        Write-Host "ERROR: Proxy failed to start" -ForegroundColor Red
        if ($proxyProc -and -not $proxyProc.HasExited) { Stop-Process -Id $proxyProc.Id -Force }
        exit 1
    }

    Write-Host "  Proxy on :$proxyPort -> $($p.url)" -ForegroundColor DarkGray
    Write-Host "  Launching remote control via $($p.name)...`n" -ForegroundColor Cyan

    $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$proxyPort"
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = $p.opus
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $p.sonnet
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $p.haiku
    $env:CLAUDE_CODE_SUBAGENT_MODEL = $p.subagent
    $env:CLAUDE_CODE_EFFORT_LEVEL = "max"
    Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue

    try {
        & claude remote-control @Args
    } finally {
        if ($proxyProc -and -not $proxyProc.HasExited) {
            Stop-Process -Id $proxyProc.Id -Force -ErrorAction SilentlyContinue
            Write-Host "  Proxy stopped." -ForegroundColor DarkGray
        }
    }
    exit 0
}

# --- Launch ---
if ($Backend -eq "anthropic") {
    foreach ($v in @("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL","ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL","CLAUDE_CODE_EFFORT_LEVEL")) {
        Remove-Item "Env:$v" -ErrorAction SilentlyContinue
    }
    Write-Host "`n  Launching Claude Code (normal Anthropic)...`n" -ForegroundColor Cyan
    & claude @Args
    exit 0
}

$p = $Providers[$Backend]
if (-not $p) { Write-Host "ERROR: Unknown backend '$Backend'. Use: ds, or, fw, nv, kimi, dw, kiro, anthropic" -ForegroundColor Red; exit 1 }
if (-not $p.needsKirocc -and -not $p.key) { Write-Host "ERROR: $($p.keyName) not set" -ForegroundColor Red; exit 1 }

Write-Host "`n  Launching Claude Code via $($p.name)..." -ForegroundColor Cyan
Write-Host "  Endpoint: $($p.url)" -ForegroundColor DarkGray
Write-Host "  Model: $($p.opus) (main) + $($p.haiku) (subagents)" -ForegroundColor DarkGray
Write-Host ""

# Kiro backend: start kirocc gateway
if ($p.needsKirocc) {
    try {
        $kiroccProc = Start-KiroccGateway
    } catch {
        Write-Host "ERROR: $_" -ForegroundColor Red; exit 1
    }
    $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$KiroccPort"
    $env:ANTHROPIC_AUTH_TOKEN = "kiro-managed"
}
# OpenAI-compat backends need the translation proxy
elseif ($p.needsProxy) {
    Write-Host "  Starting translation proxy..." -ForegroundColor DarkGray
    try {
        $proxy = Start-TranslationProxy -Provider $p
        $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$($proxy.Port)"
        $env:ANTHROPIC_AUTH_TOKEN = "proxy-managed"
    } catch {
        Write-Host "ERROR: $_" -ForegroundColor Red
        exit 1
    }
} else {
    $env:ANTHROPIC_BASE_URL = $p.url
    $env:ANTHROPIC_AUTH_TOKEN = $p.key
}

$env:ANTHROPIC_MODEL = $p.opus
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $p.opus
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $p.sonnet
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $p.haiku
$env:CLAUDE_CODE_SUBAGENT_MODEL = $p.subagent
$env:CLAUDE_CODE_EFFORT_LEVEL = "max"
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue

try {
    & claude @Args
} finally {
    if ($kiroccProc -and -not $kiroccProc.HasExited) {
        Stop-Process -Id $kiroccProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  kirocc stopped." -ForegroundColor DarkGray
    }
    if ($proxy -and $proxy.Proc -and -not $proxy.Proc.HasExited) {
        Stop-Process -Id $proxy.Proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Proxy stopped." -ForegroundColor DarkGray
    }
    foreach ($v in @("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL","ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL","CLAUDE_CODE_SUBAGENT_MODEL","CLAUDE_CODE_EFFORT_LEVEL")) {
        Remove-Item "Env:$v" -ErrorAction SilentlyContinue
    }
}
