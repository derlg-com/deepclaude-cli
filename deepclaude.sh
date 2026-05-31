#!/usr/bin/env bash
# deepclaude — Use Claude Code with DeepSeek V4 Pro or other cheap backends
# Usage: deepclaude [--backend ds|or|fw|nv|kimi|dw|anthropic] [--remote] [--status] [--cost] [--benchmark]

set -euo pipefail

# Resolve symlinks so SCRIPT_DIR points to the real repo, not /usr/local/bin
# (deepclaude is typically symlinked into PATH).
_SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$_SOURCE" ]]; do
    _DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
    _SOURCE="$(readlink "$_SOURCE")"
    [[ "$_SOURCE" != /* ]] && _SOURCE="$_DIR/$_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
unset _SOURCE _DIR

# ── Load .env if present ──
ENV_FILE="$SCRIPT_DIR/proxy/.env"
if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        # Strip inline comments (only outside quotes)
        line="${line%%#*}"
        # Trim whitespace
        line="$(echo "$line" | xargs)"
        [[ -z "$line" ]] && continue
        # Only export if not already set in environment
        key="${line%%=*}"
        if [[ -z "${!key:-}" ]]; then
            export "$line"
        fi
    done < "$ENV_FILE"
fi

# --- Config ---
DEEPSEEK_URL="https://api.deepseek.com/anthropic"
OPENROUTER_URL="https://openrouter.ai/api"
FIREWORKS_URL="https://api.fireworks.ai/inference"
NVIDIA_URL="https://integrate.api.nvidia.com/v1"
KIMI_URL="https://api.kimi.com/coding/"
DOUBLEWORD_URL="https://api.doubleword.ai/v1"
KIROCC_PORT=3456  # Port for kirocc gateway (Kiro backend)
AWS_REGION_DEFAULT="${AWS_REGION:-us-east-1}"
AWS_URL="https://bedrock-runtime.${AWS_REGION_DEFAULT}.amazonaws.com"

# Read default from .env API_PROVIDER or fallback to ds
DEFAULT_BACKEND="${API_PROVIDER:-ds}"
BACKEND="${CHEAPCLAUDE_DEFAULT_BACKEND:-$DEFAULT_BACKEND}"
ACTION="launch"
SWITCH_BACKEND=""
PROXY_PID=""

# --- Parse args ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend|-b) BACKEND="$2"; shift 2 ;;
        --switch|-s)  ACTION="switch"; SWITCH_BACKEND="$2"; shift 2 ;;
        --remote|-r)  ACTION="remote"; shift ;;
        --status)     ACTION="status"; shift ;;
        --cost)       ACTION="cost"; shift ;;
        --benchmark)  ACTION="benchmark"; shift ;;
        --help|-h)    ACTION="help"; shift ;;
        *)            break ;;
    esac
done

cleanup_proxy() {
    if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
        kill "$PROXY_PID" 2>/dev/null || true
        echo "  Proxy stopped."
    fi
}
trap cleanup_proxy EXIT

mask_key() {
    local k="$1"
    if [[ -z "$k" ]]; then echo "MISSING"; else echo "set (****${k: -4})"; fi
}

resolve_backend() {
    local url="" key="" opus="" sonnet="" haiku="" subagent=""
    case "$BACKEND" in
        ds|deepseek)
            key="${DEEPSEEK_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DEEPSEEK_API_KEY not set" >&2; exit 1; }
            url="$DEEPSEEK_URL"
            opus="${DEEPSEEK_MODEL:-deepseek-v4-pro}"; sonnet="${DEEPSEEK_MODEL:-deepseek-v4-pro}"
            haiku="deepseek-v4-flash"; subagent="deepseek-v4-flash"
            ;;
        or|openrouter)
            key="${OPENROUTER_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: OPENROUTER_API_KEY not set" >&2; exit 1; }
            url="$OPENROUTER_URL"
            opus="deepseek/deepseek-v4-pro"; sonnet="deepseek/deepseek-v4-pro"
            haiku="deepseek/deepseek-v4-pro"; subagent="deepseek/deepseek-v4-pro"
            ;;
        fw|fireworks)
            key="${FIREWORKS_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: FIREWORKS_API_KEY not set" >&2; exit 1; }
            url="$FIREWORKS_URL"
            opus="accounts/fireworks/models/deepseek-v4-pro"
            sonnet="accounts/fireworks/models/deepseek-v4-pro"
            haiku="accounts/fireworks/models/deepseek-v4-pro"
            subagent="accounts/fireworks/models/deepseek-v4-pro"
            ;;
        nv|nvidia)
            key="${NVIDIA_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: NVIDIA_API_KEY not set" >&2; exit 1; }
            url="$NVIDIA_URL"
            opus="${NVIDIA_MODEL:-moonshotai/kimi-k2.6}"; sonnet="${NVIDIA_MODEL:-moonshotai/kimi-k2.6}"
            haiku="${NVIDIA_MODEL:-moonshotai/kimi-k2.6}"; subagent="${NVIDIA_MODEL:-moonshotai/kimi-k2.6}"
            ;;
        kimi)
            key="${KIMI_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: KIMI_API_KEY not set" >&2; exit 1; }
            url="$KIMI_URL"
            opus="${KIMI_MODEL:-kimi-for-coding}"; sonnet="${KIMI_MODEL:-kimi-for-coding}"
            haiku="${KIMI_MODEL:-kimi-for-coding}"; subagent="${KIMI_MODEL:-kimi-for-coding}"
            ;;
        dw|doubleword)
            key="${DOUBLEWORD_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: DOUBLEWORD_API_KEY not set" >&2; exit 1; }
            url="$DOUBLEWORD_URL"
            opus="${DOUBLEWORD_MODEL:-deepseek-ai/DeepSeek-V4-Pro}"; sonnet="${DOUBLEWORD_MODEL:-deepseek-ai/DeepSeek-V4-Pro}"
            haiku="${DOUBLEWORD_MODEL:-deepseek-ai/DeepSeek-V4-Pro}"; subagent="${DOUBLEWORD_MODEL:-deepseek-ai/DeepSeek-V4-Pro}"
            ;;
        kiro)
            # Kiro uses kirocc gateway — no API key needed (uses Kiro CLI auth)
            # Model names must use dot notation without date suffixes.
            #
            # KIRO_MODEL       — main model (Opus / Sonnet tiers)
            # KIRO_HAIKU_MODEL — model for subagents / Haiku tier (cheaper)
            #                    Defaults to claude-haiku-4.5 so subagents
            #                    don't burn Opus credits when KIRO_MODEL is Opus.
            url="http://127.0.0.1:$KIROCC_PORT"
            key="dummy"  # kirocc ignores this unless -api-key is set
            opus="${KIRO_MODEL:-claude-sonnet-4.6}"
            # Claude Code selects the 1M context window only when the launched
            # model id carries a [1m] suffix. Append it for 1M-capable models
            # (must match the 1000000 entries in KIROCC_MODEL_MAPPINGS below);
            # kirocc strips [1m] and maps to the real Kiro SKU upstream.
            case "$opus" in
                *'[1m]') ;;
                claude-opus-4.6|claude-opus-4.7|claude-opus-4.8) opus="${opus}[1m]" ;;
            esac
            sonnet="$opus"
            haiku="${KIRO_HAIKU_MODEL:-claude-haiku-4.5}"
            subagent="${KIRO_HAIKU_MODEL:-claude-haiku-4.5}"
            ;;
        aws|bedrock)
            # AWS Bedrock with API key (ABSK prefix). Region from AWS_REGION (default us-east-1).
            # Models use Bedrock inference-profile IDs (e.g. us.anthropic.claude-sonnet-4-5-...).
            key="${AWS_API_KEY:-}"
            [[ -z "$key" ]] && { echo "ERROR: AWS_API_KEY not set" >&2; exit 1; }
            url="$AWS_URL"
            opus="${AWS_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
            sonnet="${AWS_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
            haiku="${AWS_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
            subagent="${AWS_MODEL:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
            ;;
        anthropic) ;;
        *) echo "ERROR: Unknown backend '$BACKEND'. Use: ds, or, fw, nv, kimi, dw, kiro, aws, anthropic" >&2; exit 1 ;;
    esac
    RESOLVED_URL="$url"; RESOLVED_KEY="$key"
    RESOLVED_OPUS="$opus"; RESOLVED_SONNET="$sonnet"
    RESOLVED_HAIKU="$haiku"; RESOLVED_SUBAGENT="$subagent"
}

# Infer a model's real context window (tokens). Tries, in order:
#   1. explicit CONTEXT_WINDOW_TOKENS env (user override, always wins)
#   2. a lookup by model-name substring (case-insensitive)
#   3. empty (caller keeps Claude Code's 200k default)
detect_context_window() {
    local model="${1,,}"
    if [[ -n "${CONTEXT_WINDOW_TOKENS:-}" ]]; then
        echo "$CONTEXT_WINDOW_TOKENS"; return
    fi
    case "$model" in
        *deepseek-v4*|*deepseek-v3.2*)        echo 1000000 ;;
        *nemotron*)                            echo 1000000 ;;  # nemotron-3-super 1M
        *kimi-k2*|*kimi-for-coding*|*moonshot*|*kimi*) echo 262144 ;;  # 256k
        *deepseek*)                            echo 131072 ;;   # older deepseek 128k
        *)                                     echo "" ;;
    esac
}

set_model_env() {
    export ANTHROPIC_MODEL="$RESOLVED_OPUS"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$RESOLVED_OPUS"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$RESOLVED_SONNET"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$RESOLVED_HAIKU"
    export CLAUDE_CODE_SUBAGENT_MODEL="$RESOLVED_SUBAGENT"
    export CLAUDE_CODE_EFFORT_LEVEL="max"

    # Context-window unlock for non-Claude backends. Claude Code defaults every
    # non-Claude model ID to 200k. Kiro uses the [1m] model-name trick (handled
    # in resolve_backend, preserves auto-compaction). All other backends forward
    # the model name verbatim upstream, so the only safe lever is an explicit
    # CLAUDE_CODE_MAX_CONTEXT_TOKENS, which Claude Code honours only when
    # DISABLE_COMPACT is truthy. Auto-detected from the model name; override
    # with CONTEXT_WINDOW_TOKENS in .env.
    if ! needs_kirocc; then
        local cw
        cw=$(detect_context_window "$RESOLVED_OPUS")
        if [[ -n "$cw" ]]; then
            export DISABLE_COMPACT=1
            export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$cw"
        fi
    fi
}

show_status() {
    echo ""
    echo "  deepclaude — Backend Status"
    echo "  ============================"
    echo ""
    echo "  Keys:"
    echo "    DEEPSEEK_API_KEY:    $(mask_key "${DEEPSEEK_API_KEY:-}")"
    echo "    OPENROUTER_API_KEY:  $(mask_key "${OPENROUTER_API_KEY:-}")"
    echo "    FIREWORKS_API_KEY:   $(mask_key "${FIREWORKS_API_KEY:-}")"
    echo "    NVIDIA_API_KEY:      $(mask_key "${NVIDIA_API_KEY:-}")"
    echo "    KIMI_API_KEY:        $(mask_key "${KIMI_API_KEY:-}")"
    echo "    DOUBLEWORD_API_KEY:  $(mask_key "${DOUBLEWORD_API_KEY:-}")"
    echo "    KIRO_API_KEY:        $(mask_key "${KIRO_API_KEY:-}")"
    echo "    AWS_API_KEY:         $(mask_key "${AWS_API_KEY:-}")"
    echo "    kirocc:              $(which kirocc 2>/dev/null && echo 'installed' || echo 'NOT FOUND')"
    echo ""
    echo "  Backends:"
    echo "    deepclaude                  # DeepSeek V4 Pro (default)"
    echo "    deepclaude -b or            # OpenRouter (cheapest)"
    echo "    deepclaude -b fw            # Fireworks AI (fastest)"
    echo "    deepclaude -b nv            # Nvidia NIM (kimi-k2.6)"
    echo "    deepclaude -b kimi          # Kimi Code (subscription)"
    echo "    deepclaude -b dw            # Doubleword AI"
    echo "    deepclaude -b kiro          # Kiro (AWS Claude, via kirocc)"
    echo "    deepclaude -b aws           # AWS Bedrock (your own AWS account)"
    echo "    deepclaude -b anthropic     # Normal Claude Code"
    echo "    deepclaude --remote         # Remote control + default backend"
    echo ""
    local proxy_status
    proxy_status=$(curl -s http://127.0.0.1:3200/_proxy/status 2>/dev/null) || proxy_status=""
    if [[ -n "$proxy_status" ]]; then
        echo "  Proxy: running"
        echo "    $proxy_status"
    else
        echo "  Proxy: not running"
    fi
    echo ""
}

show_cost() {
    echo ""
    echo "  DeepClaude Provider Pricing"
    echo "  ==========================="
    echo ""
    echo "  Provider        Input/M    Output/M   Notes"
    echo "  ----------      --------   --------   -----------"
    echo "  DeepSeek        \$0.44      \$0.87      Native Anthropic"
    echo "  OpenRouter      \$0.44      \$0.87      Multi-provider"
    echo "  Fireworks       \$1.74      \$3.48      Low latency"
    echo "  Nvidia NIM      \$0.44      \$0.87      OpenAI-compat"
    echo "  Kimi Code       subscription         Anthropic-native"
    echo "  Doubleword      \$0.44      \$0.87      OpenAI-compat"
    echo "  Kiro            subscription         AWS Claude (kirocc)"
    echo "  AWS Bedrock     \$3.00      \$15.00     Your own AWS account"
    echo "  Anthropic       \$3.00      \$15.00     Official"
    echo ""
    echo "  Monthly estimate (heavy use, 25 days): \$30-80"
    echo ""
}

show_help() {
    echo "deepclaude — Claude Code with cheap backends"
    echo ""
    echo "Usage: deepclaude [options] [-- claude-args...]"
    echo ""
    echo "Options:"
    echo "  -b, --backend <backend>  Backend to use (default: ds)"
    echo "     ds|deepseek           DeepSeek V4 Pro (native Anthropic)"
    echo "     or|openrouter         OpenRouter (multi-provider)"
    echo "     fw|fireworks          Fireworks AI (low latency)"
    echo "     nv|nvidia             Nvidia NIM (OpenAI-compat, kimi-k2.6)"
    echo "     kimi                  Kimi Code (native Anthropic, subscription)"
    echo "     dw|doubleword         Doubleword AI (OpenAI-compat)"
    echo "     kiro                  Kiro (AWS Claude via kirocc gateway)"
    echo "     aws|bedrock           AWS Bedrock (your own AWS account)"
    echo "     anthropic             Normal Claude Code"
    echo "  -r, --remote             Remote control mode (browser URL)"
    echo "  --status                 Show keys and backends"
    echo "  --cost                   Pricing comparison"
    echo "  --benchmark              Latency test"
    echo "  -s, --switch <backend>   Switch proxy mid-session"
    echo "  -h, --help               This help"
    echo ""
    echo "Environment variables:"
    echo "  DEEPSEEK_API_KEY      DeepSeek API key"
    echo "  OPENROUTER_API_KEY    OpenRouter API key"
    echo "  FIREWORKS_API_KEY     Fireworks API key"
    echo "  NVIDIA_API_KEY        Nvidia NIM API key"
    echo "  KIMI_API_KEY          Kimi Code API key"
    echo "  DOUBLEWORD_API_KEY    Doubleword AI API key"
    echo "  KIRO_API_KEY          Kiro API key (ksk_ prefix)"
    echo "  AWS_API_KEY           AWS Bedrock API key (ABSK prefix)"
    echo "  AWS_REGION            AWS region (default: us-east-1)"
    echo "  AWS_MODEL             Bedrock model ID (default: global.anthropic.claude-sonnet-4-6)"
    echo ""
    echo "Config: Edit proxy/.env to set API_PROVIDER and API keys."
}

do_switch() {
    local backend="$SWITCH_BACKEND"
    case "$backend" in
        ds|deepseek)   backend="deepseek" ;;
        or|openrouter) backend="openrouter" ;;
        fw|fireworks)  backend="fireworks" ;;
        nv|nvidia)     backend="nvidia" ;;
        kimi)          backend="kimi" ;;
        dw|doubleword) backend="doubleword" ;;
        anthropic)     backend="anthropic" ;;
        *) echo "ERROR: Unknown backend '$backend'. Use: ds, or, fw, nv, kimi, dw, anthropic" >&2; exit 1 ;;
    esac
    local resp
    resp=$(curl -sX POST http://127.0.0.1:3200/_proxy/mode -d "backend=$backend" 2>/dev/null) || {
        echo "  Proxy not running. Start with: deepclaude" >&2; exit 1
    }
    echo "  $resp"
}

run_benchmark() {
    echo ""
    echo "  Latency Benchmark (1 request each)"
    echo "  ==================================="
    for name in deepseek openrouter fireworks; do
        local url="" key="" model=""
        case "$name" in
            deepseek)   url="$DEEPSEEK_URL"; key="${DEEPSEEK_API_KEY:-}"; model="deepseek-v4-pro" ;;
            openrouter) url="$OPENROUTER_URL"; key="${OPENROUTER_API_KEY:-}"; model="deepseek/deepseek-v4-pro" ;;
            fireworks)  url="$FIREWORKS_URL"; key="${FIREWORKS_API_KEY:-}"; model="accounts/fireworks/models/deepseek-v4-pro" ;;
        esac
        if [[ -z "$key" ]]; then echo "  $name: SKIP (no key)"; continue; fi
        local start_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$url/v1/messages" \
            -H "x-api-key: $key" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" \
            -d "{\"model\":\"$model\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply: ok\"}]}" \
            --max-time 30 2>/dev/null || echo "timeout")
        local end_ms=$(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))')
        local elapsed=$((end_ms - start_ms))
        if [[ "$status" == "200" ]]; then
            echo "  $name: OK (${elapsed}ms)"
        else
            echo "  $name: FAIL ($status, ${elapsed}ms)"
        fi
    done
    echo ""
}

# ── Determine if backend needs the Node.js proxy (OpenAI-compat backends) ──
needs_proxy() {
    case "$BACKEND" in
        nv|nvidia|dw|doubleword|aws|bedrock) return 0 ;;
        *) return 1 ;;
    esac
}

# ── Determine if backend needs the kirocc gateway ──
needs_kirocc() {
    case "$BACKEND" in
        kiro) return 0 ;;
        *) return 1 ;;
    esac
}

# ── Map shorthand backend names to canonical names for the proxy ──
canonical_backend() {
    case "$BACKEND" in
        ds|deepseek)   echo "deepseek" ;;
        or|openrouter) echo "openrouter" ;;
        fw|fireworks)  echo "fireworks" ;;
        nv|nvidia)     echo "nvidia" ;;
        kimi)          echo "kimi" ;;
        dw|doubleword) echo "doubleword" ;;
        kiro)          echo "kiro" ;;
        aws|bedrock)   echo "aws" ;;
        *)             echo "$BACKEND" ;;
    esac
}

launch_claude() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        echo "  Launching Claude Code (normal Anthropic backend)..."
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
        unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        unset CLAUDE_CODE_EFFORT_LEVEL
        unset DISABLE_COMPACT CLAUDE_CODE_MAX_CONTEXT_TOKENS
        exec claude "$@"
    fi

    resolve_backend

    echo "  Launching Claude Code via $BACKEND..."
    echo "  Endpoint: $RESOLVED_URL"
    echo "  Model: $RESOLVED_OPUS (main) + $RESOLVED_HAIKU (subagents)"
    echo ""

    # Kiro backend: start kirocc gateway (Go binary, Anthropic↔AWS Event Stream).
    if needs_kirocc; then
        local kirocc_bin
        kirocc_bin=$(which kirocc 2>/dev/null || echo "$HOME/.local/bin/kirocc")
        if [[ ! -x "$kirocc_bin" ]]; then
            echo "ERROR: kirocc not found. Install with:" >&2
            echo "  GOEXPERIMENT=jsonv2 go install github.com/d-kuro/kirocc/cmd/kirocc@latest" >&2
            exit 1
        fi

        # When KIRO_API_KEY (ksk_...) is set, kirocc uses it directly — no OAuth or DB needed.
        # Otherwise, kirocc reads OAuth tokens from Kiro CLI's SQLite DB.
        if [[ -n "${KIRO_API_KEY:-}" ]]; then
            echo "  Using KIRO_API_KEY for authentication (no OAuth required)"
        else
            local kiro_db="$HOME/.local/share/kiro-cli/data.sqlite3"
            local has_tokens=false
            if [[ -f "$kiro_db" ]] && command -v python3 &>/dev/null; then
                has_tokens=$(python3 -c "
import sqlite3, sys
try:
    c = sqlite3.connect('$kiro_db')
    r = c.execute(\"SELECT COUNT(*) FROM auth_kv WHERE key LIKE 'kirocli:%:token'\").fetchone()
    print('true' if r and r[0] > 0 else 'false')
except: print('false')
" 2>/dev/null)
            fi

            if [[ "$has_tokens" != "true" ]]; then
                echo ""
                echo "  ╭─────────────────────────────────────────────────╮"
                echo "  │  First-time setup: Kiro login required (once)   │"
                echo "  │  kirocc auto-refreshes tokens after this.       │"
                echo "  ╰─────────────────────────────────────────────────╯"
                echo ""
                local kiro_cli
                kiro_cli=$(command -v kiro-cli 2>/dev/null || echo "$HOME/.local/bin/kiro-cli")
                if [[ -x "$kiro_cli" ]]; then
                    "$kiro_cli" login
                    # Re-check tokens
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
                        echo "ERROR: Kiro auth failed. Run 'kiro-cli login' manually." >&2
                        exit 1
                    fi
                    echo "  ✓ Kiro login successful — tokens will auto-refresh"
                else
                    echo "ERROR: kiro-cli not found. Install: curl -fsSL https://kiro.dev/install.sh | bash" >&2
                    exit 1
                fi
            fi
        fi

        echo "  Starting kirocc gateway on :$KIROCC_PORT..."

        # Kill any stale kirocc already bound to this port.
        # Use ss (fast, no NFS hang risk) first; lsof with a 3s timeout as fallback.
        # SIGKILL: SIGTERM triggers graceful shutdown that waits for active connections.
        local stale_pid
        stale_pid=$(ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null | awk -F'pid=' '/LISTEN/{split($2,a,","); print a[1]}' | head -1)
        if [[ -z "$stale_pid" ]]; then
            # ss couldn't determine PID; try lsof with a 3s timeout
            stale_pid=$(timeout 3 lsof -ti tcp:"$KIROCC_PORT" -s TCP:LISTEN 2>/dev/null || true)
        fi
        if [[ -n "$stale_pid" ]]; then
            kill -9 "$stale_pid" 2>/dev/null || true
            # Wait until the port is actually free (max 2s).
            local wait_n=0
            while timeout 1 ss -tlnp "sport = :$KIROCC_PORT" 2>/dev/null | grep -q LISTEN && [[ $wait_n -lt 20 ]]; do
                sleep 0.1
                wait_n=$((wait_n + 1))
            done
        fi

        # Map Claude Code's date-suffixed model names to Kiro model IDs.
        # Claude Code sends e.g. "claude-sonnet-4-6-20250514" but Kiro only
        # recognizes base names like "claude-sonnet-4.6".
        export KIROCC_MODEL_MAPPINGS='[
          {"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000},
          {"anthropic":"claude-sonnet-4-5-20250929","kiro":"claude-sonnet-4.5","context_window_size":200000},
          {"anthropic":"claude-haiku-4-5-20250929","kiro":"claude-haiku-4.5","context_window_size":200000},
          {"anthropic":"claude-opus-4-6-20250514","kiro":"claude-opus-4.6","context_window_size":1000000},
          {"anthropic":"claude-opus-4-7-20250514","kiro":"claude-opus-4.7","context_window_size":1000000},
          {"anthropic":"claude-opus-4-7","kiro":"claude-opus-4.7","context_window_size":1000000},
          {"anthropic":"claude-opus-4-8-20250514","kiro":"claude-opus-4.8","context_window_size":1000000},
          {"anthropic":"claude-opus-4-8","kiro":"claude-opus-4.8","context_window_size":1000000}
        ]'

        local kirocc_log
        kirocc_log=$(mktemp /tmp/kirocc-XXXXXX.log)
        "$kirocc_bin" -port "$KIROCC_PORT" > "$kirocc_log" 2>&1 &
        PROXY_PID=$!

        # Wait for kirocc to be ready (max ~9s).
        local tries=0
        while ! curl -s --max-time 1 "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1 && [[ $tries -lt 30 ]]; do
            sleep 0.3
            tries=$((tries + 1))
            # Print a dot every 3 tries (~1s) so the user sees progress.
            if (( tries % 3 == 0 )); then
                printf '.'
            fi
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
        echo ""

        export ANTHROPIC_BASE_URL="http://127.0.0.1:$KIROCC_PORT"
        export ANTHROPIC_AUTH_TOKEN="kiro-managed"
        # Override model names with dot-notation IDs that Kiro accepts
        set_model_env
        unset ANTHROPIC_API_KEY

        exec claude --model "$RESOLVED_OPUS" "$@"
    fi

    # OpenAI-compat backends (nvidia, doubleword) MUST go through the proxy
    # for Anthropic↔OpenAI format translation.
    # Kimi and other native-Anthropic backends can connect directly.
    if needs_proxy; then
        echo "  Starting translation proxy for $BACKEND..."

        # Pass all env vars so proxy can find the keys
        export NVIDIA_API_KEY="${NVIDIA_API_KEY:-}"
        export KIMI_API_KEY="${KIMI_API_KEY:-}"
        export DOUBLEWORD_API_KEY="${DOUBLEWORD_API_KEY:-}"
        export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
        export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
        export FIREWORKS_API_KEY="${FIREWORKS_API_KEY:-}"
        export AWS_API_KEY="${AWS_API_KEY:-}"
        export AWS_REGION="${AWS_REGION:-us-east-1}"
        export AWS_MODEL="${AWS_MODEL:-}"

        local canonical
        canonical=$(canonical_backend)

        local port_file
        port_file=$(mktemp)
        # stdout = port number only; stderr = proxy logs (to terminal)
        node "$SCRIPT_DIR/proxy/start-proxy.js" "$RESOLVED_URL" "$RESOLVED_KEY" --mode "$canonical" > "$port_file" 2>/dev/null &
        PROXY_PID=$!

        local tries=0
        while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
            sleep 0.2
            tries=$((tries + 1))
        done

        if [[ ! -s "$port_file" ]]; then
            echo "ERROR: Proxy failed to start" >&2
            cat "$port_file" >&2 2>/dev/null || true
            rm -f "$port_file"
            exit 1
        fi

        # Extract the bare port number (only digits on a line by itself)
        local proxy_port
        proxy_port=$(grep -oE '^[0-9]+$' "$port_file" | head -1)
        rm -f "$port_file"

        if [[ -z "$proxy_port" ]]; then
            echo "ERROR: Could not determine proxy port" >&2
            exit 1
        fi

        echo "  Proxy on :$proxy_port → $RESOLVED_URL"
        echo ""

        export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
        # The proxy handles auth, so we use a dummy token
        export ANTHROPIC_AUTH_TOKEN="proxy-managed"
        set_model_env
        unset ANTHROPIC_API_KEY

        exec claude --model "$RESOLVED_OPUS" "$@"
    fi

    # Native Anthropic-format backends (deepseek, openrouter, fireworks, kimi)
    export ANTHROPIC_BASE_URL="$RESOLVED_URL"
    export ANTHROPIC_AUTH_TOKEN="$RESOLVED_KEY"
    set_model_env
    unset ANTHROPIC_API_KEY

    exec claude --model "$RESOLVED_OPUS" "$@"
}

launch_remote() {
    if [[ "$BACKEND" == "anthropic" ]]; then
        echo "  Launching remote control (Anthropic)..."
        unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
        unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
        unset ANTHROPIC_DEFAULT_HAIKU_MODEL CLAUDE_CODE_SUBAGENT_MODEL
        unset CLAUDE_CODE_EFFORT_LEVEL ANTHROPIC_API_KEY
        exec claude remote-control "$@"
    fi

    resolve_backend

    echo "  Starting model proxy for $BACKEND..."

    # Kiro backend: use kirocc for remote mode too
    if needs_kirocc; then
        local kirocc_bin
        kirocc_bin=$(which kirocc 2>/dev/null || echo "$HOME/.local/bin/kirocc")
        if [[ ! -x "$kirocc_bin" ]]; then
            echo "ERROR: kirocc not found." >&2; exit 1
        fi

        "$kirocc_bin" -port "$KIROCC_PORT" > /dev/null 2>&1 &
        PROXY_PID=$!
        local tries=0
        while ! curl -s "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1 && [[ $tries -lt 30 ]]; do
            sleep 0.3; tries=$((tries + 1))
        done

        echo "  kirocc ready → Kiro (AWS Claude)"
        echo "  Launching remote control via kiro..."
        echo ""

        export ANTHROPIC_BASE_URL="http://127.0.0.1:$KIROCC_PORT"
        unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

        claude remote-control "$@"
        return
    fi

    # Pass all env vars so proxy can find the keys
    export NVIDIA_API_KEY="${NVIDIA_API_KEY:-}"
    export KIMI_API_KEY="${KIMI_API_KEY:-}"
    export DOUBLEWORD_API_KEY="${DOUBLEWORD_API_KEY:-}"
    export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
    export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
    export FIREWORKS_API_KEY="${FIREWORKS_API_KEY:-}"

    local port_file
    port_file=$(mktemp)
    node "$SCRIPT_DIR/proxy/start-proxy.js" "$RESOLVED_URL" "$RESOLVED_KEY" > "$port_file" 2>/dev/null &
    PROXY_PID=$!

    local tries=0
    while [[ ! -s "$port_file" ]] && [[ $tries -lt 30 ]]; do
        sleep 0.2
        tries=$((tries + 1))
    done

    if [[ ! -s "$port_file" ]]; then
        echo "ERROR: Proxy failed to start" >&2
        rm -f "$port_file"
        exit 1
    fi

    local proxy_port
    proxy_port=$(grep -oE '^[0-9]+$' "$port_file" | head -1)
    rm -f "$port_file"

    echo "  Proxy on :$proxy_port -> $RESOLVED_URL"
    echo "  Launching remote control via $BACKEND..."
    echo ""

    export ANTHROPIC_BASE_URL="http://127.0.0.1:$proxy_port"
    set_model_env
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

    claude remote-control "$@"
}

# --- Main ---
case "$ACTION" in
    status)    show_status ;;
    cost)      show_cost ;;
    benchmark) run_benchmark ;;
    help)      show_help ;;
    switch)    do_switch ;;
    remote)    launch_remote "$@" ;;
    launch)    launch_claude "$@" ;;
esac
