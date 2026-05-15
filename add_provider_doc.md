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
    needs_kirocc=true       # Custom flag we added to boot the Go binary
    url="http://127.0.0.1:$KIROCC_PORT"
    key="dummy"             # Kiro uses local SQLite DB for auth, not an API key
    opus="$KIRO_MODEL"; sonnet="$KIRO_MODEL"
    haiku="claude-haiku-4.5"; subagent="claude-haiku-4.5"
    ;;
```

**C. Handle Gateway Booting (If applicable):**
If your provider requires a special binary (like Kiro), you must add logic to start it and clean it up.
```bash
# Inside deepclaude.sh, before executing 'claude'
if needs_kirocc; then
    kirocc_bin=$(which kirocc 2>/dev/null || echo "$HOME/.local/bin/kirocc")
    
    # CRITICAL: Claude Code appends date suffixes to models (e.g. claude-sonnet-4-6-20250514)
    # The Kiro backend rejects these. We MUST use KIROCC_MODEL_MAPPINGS to strip them
    # before they hit the upstream API.
    export KIROCC_MODEL_MAPPINGS='[
      {"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000},
      {"anthropic":"claude-haiku-4-5-20250929","kiro":"claude-haiku-4.5","context_window_size":200000}
    ]'

    # Start the binary in the background
    "$kirocc_bin" -port "$KIROCC_PORT" > /dev/null 2>&1 &
    PROXY_PID=$!
    
    # Wait for healthcheck
    while ! curl -s "http://127.0.0.1:$KIROCC_PORT/v1/models" > /dev/null 2>&1; do sleep 0.3; done
fi
```
*(Ensure you also add `kill $PROXY_PID` in the `cleanup()` function).*

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
    
    $env:KIROCC_MODEL_MAPPINGS = '[{"anthropic":"claude-sonnet-4-6-20250514","kiro":"claude-sonnet-4.6","context_window_size":200000}]'
    
    $proc = Start-Process -FilePath $kiroccBin -ArgumentList "-port",$KiroccPort -PassThru -WindowStyle Hidden
    return $proc
}
```
*(Ensure the process is stopped in the `finally { }` block at the end of the script).*

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

## 3. Summary of Core Provider Types Implemented

1.  **Kimi Code (`-b kimi`)**: The easiest. Pure Anthropic format. Only required changing `.sh` and `.ps1` to route `ANTHROPIC_BASE_URL` to `api.moonshot.cn/v1`.
2.  **Nvidia NIM (`-b nv`)**: OpenAI format. Required `needs_proxy=true`. We had to update the Node proxy to strip specific system prompts that Nvidia rejected.
3.  **Doubleword AI (`-b dw`)**: OpenAI format. Required `needs_proxy=true`. We had to deeply modify the streaming parser in `openai-translator.js` to extract `reasoning_content` so DeepSeek V4 Pro's "thinking" phase was visible in Claude Code.
4.  **Kiro (`-b kiro`)**: The hardest. Required spawning a 3rd-party Go binary (`kirocc`). We had to write health checks in Bash/PowerShell to wait for port 3456 to open. We also had to implement a strict `KIROCC_MODEL_MAPPINGS` JSON object because Claude Code secretly injects date suffixes (`-20250514`) into model IDs, which caused AWS to throw `ValidationException: Invalid model ID` errors.

By following this guide, you can confidently integrate any future LLM provider, regardless of whether it uses native Anthropic, OpenAI format, or a proprietary enterprise gateway.
