# deepclaude

Use Claude Code's autonomous agent loop with **DeepSeek V4 Pro**, **Kiro**, **AWS Bedrock**, **Nvidia NIM**, **Kimi Code**, **Doubleword AI**, or any Anthropic-compatible backend. Same UX, up to 17× cheaper — or even **free with a subscription**.

![Remote control running DeepSeek V4 Pro in the browser](screenshots/remote-control-deepseek.png)

## What this does

Claude Code is the best autonomous coding agent — but it costs $200/month with usage caps. **deepclaude** swaps the brain while keeping the body:

```
Your terminal
  +-- Claude Code CLI (tool loop, file editing, bash, git — unchanged)
        +-- API calls -> Your chosen backend instead of Anthropic
```

Everything works: file reading, editing, bash execution, subagent spawning, autonomous multi-step coding loops. The only difference is which model thinks.

---

## Quick start (2 minutes)

### 1. Get an API key

Pick any backend (or multiple). See [Provider Setup](#provider-setup) below.

### 2. Configure

```bash
# Copy the example env file
cp proxy/.env.example proxy/.env
# Edit with your API keys
nano proxy/.env
```

### 3. Install

**macOS/Linux:**
```bash
chmod +x deepclaude.sh
sudo ln -s "$(pwd)/deepclaude.sh" /usr/local/bin/deepclaude
```

**Windows (PowerShell):**
```powershell
Copy-Item deepclaude.ps1 "$env:USERPROFILE\.local\bin\deepclaude.ps1"
```

### 4. Use it

```bash
deepclaude                      # Launch with default backend (from API_PROVIDER in .env)
deepclaude -b kiro              # Use Kiro (AWS Claude, subscription)
deepclaude -b aws               # Use AWS Bedrock (your own AWS account)
deepclaude -b nv                # Use Nvidia NIM
deepclaude -b kimi              # Use Kimi Code
deepclaude -b dw                # Use Doubleword AI
deepclaude -b or                # Use OpenRouter
deepclaude -b fw                # Use Fireworks AI
deepclaude -b anthropic         # Normal Claude Code
deepclaude --remote             # Remote control mode (browser URL)
deepclaude --status             # Show all backends and key status
deepclaude --cost               # Pricing comparison
deepclaude --benchmark          # Latency test
```

---

## Supported backends

| Backend | Flag | Input/M | Output/M | Protocol | Notes |
|---|---|---|---|---|---|
| **DeepSeek** (default) | `-b ds` | $0.44 | $0.87 | Anthropic-native | Auto context caching |
| **Kiro** ⭐ | `-b kiro` | subscription | subscription | AWS (kirocc gateway) | Claude Sonnet 4.6 via Kiro Pro |
| **AWS Bedrock** | `-b aws` | $3.00 | $15.00 | Bedrock (proxy) | Your own AWS account, Claude Sonnet 4.6 |
| **OpenRouter** | `-b or` | $0.44 | $0.87 | Anthropic-native | Multi-provider routing |
| **Fireworks AI** | `-b fw` | $1.74 | $3.48 | Anthropic-native | Lowest latency (US) |
| **Nvidia NIM** | `-b nv` | $0.44 | $0.87 | OpenAI-compat → proxy | kimi-k2.6 default |
| **Kimi Code** | `-b kimi` | subscription | subscription | Anthropic-native | kimi-for-coding |
| **Doubleword AI** | `-b dw` | $0.44 | $0.87 | OpenAI-compat → proxy | DeepSeek-V4-Pro |
| **Anthropic** | `-b anthropic` | $3.00 | $15.00 | Official | Original Claude Opus |

---

## Architecture

deepclaude uses four routing strategies depending on the backend type:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          deepclaude launcher                              │
│                   (deepclaude.sh / deepclaude.ps1)                       │
├──────────────┬──────────────────┬───────────────────┬────────────────────┤
│  Native      │  OpenAI-compat   │  Kiro             │  AWS Bedrock        │
│  Backends    │  Backends        │  Backend          │  Backend            │
├──────────────┼──────────────────┼───────────────────┼────────────────────┤
│ DeepSeek     │ Nvidia NIM       │ Kiro (Pro/Free)   │ Bedrock (own AWS)   │
│ OpenRouter   │ Doubleword AI    │                   │                     │
│ Fireworks    │                  │                   │                     │
│ Kimi Code    │                  │                   │                     │
├──────────────┼──────────────────┼───────────────────┼────────────────────┤
│              │  Node.js Proxy   │  kirocc Gateway   │  Node.js Proxy      │
│  Direct      │  Anthropic ↔     │  Anthropic ↔      │  Anthropic ↔        │
│  Connect     │  OpenAI format   │  AWS Event Stream │  AWS Event Stream   │
│              │  Port: dynamic   │  Port: 3456       │  Port: dynamic      │
├──────────────┼──────────────────┼───────────────────┼────────────────────┤
│ Claude Code  │ Claude Code      │ Claude Code       │ Claude Code         │
│  ↓           │  ↓               │  ↓                │  ↓                  │
│ Backend API  │ localhost:PORT   │ localhost:3456    │ localhost:PORT      │
└──────────────┴──────────────────┴───────────────────┴────────────────────┘
```

### Routing Strategy

| Strategy | Backends | How it works |
|---|---|---|
| **Direct connect** | DeepSeek, OpenRouter, Fireworks, Kimi | Backend speaks Anthropic Messages API natively. `ANTHROPIC_BASE_URL` points directly to the backend. |
| **Node.js proxy (OpenAI-compat)** | Nvidia, Doubleword | Backend speaks OpenAI Chat Completions API. A local Node.js proxy translates Anthropic ↔ OpenAI format in real-time. |
| **kirocc gateway** | Kiro | Backend uses AWS Event Stream protocol. The `kirocc` Go binary translates Anthropic Messages API ↔ Kiro's internal AWS protocol. |
| **Node.js proxy (Bedrock)** | AWS Bedrock | Same proxy handles Bedrock natively: builds `/model/{id}/invoke-with-response-stream` URLs, adds `anthropic_version: "bedrock-2023-05-31"`, decodes AWS Event Stream → SSE. |

---

## Provider Setup

### DeepSeek (default)

**Type:** Anthropic-native (direct connect)  
**Cost:** $0.44/M input, $0.87/M output  
**Model:** `deepseek-v4-pro`

```bash
# Get key from https://platform.deepseek.com
export DEEPSEEK_API_KEY="sk-your-key"
deepclaude           # or: deepclaude -b ds
```

**`.env` config:**
```ini
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_MODEL=deepseek-v4-pro
```

---

### Kiro (AWS Claude) ⭐

**Type:** kirocc gateway (Go binary)  
**Cost:** Subscription-based ($0 Free / $20 Pro / $40 Pro+)  
**Models:** `claude-sonnet-4.6` (Pro), `claude-sonnet-4.5` (Free), `claude-haiku-4.5`, `claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`

Kiro provides access to Claude models through Amazon's AWS infrastructure using a subscription model instead of per-token billing.

#### Prerequisites

1. **Install Kiro CLI:**
   ```bash
   # Download from https://kiro.dev/downloads/
   # Or install via package manager
   ```

2. **Login to Kiro CLI:**
   ```bash
   kiro-cli login
   # Opens browser for authentication (GitHub, Google, or AWS Builder ID)
   ```

3. **Install kirocc gateway:**
   ```bash
   # Requires Go 1.24+
   GOEXPERIMENT=jsonv2 go install github.com/d-kuro/kirocc/cmd/kirocc@latest
   ```

4. **Upgrade to Pro (for Sonnet 4.6):**
   - Visit [app.kiro.dev](https://app.kiro.dev) and upgrade to Pro ($20/mo)
   - Free tier only has access to Sonnet 4.5 and Haiku 4.5

#### Usage

```bash
deepclaude -b kiro              # Launch with Sonnet 4.6 (default)
deepclaude -b kiro --remote     # Remote control mode
```

**`.env` config:**
```ini
KIRO_API_KEY=ksk_your-key-here
KIRO_MODEL=claude-sonnet-4.6    # Must use dot notation!
```

#### How Kiro works internally

```
Claude Code → kirocc (:3456) → AWS Event Stream → Kiro Backend → Claude Model
                 │
                 ├── Reads Kiro CLI credentials from SQLite DB
                 ├── Maps model names (claude-sonnet-4-6 → claude-sonnet-4.6)
                 ├── Maps date-suffixed names (claude-sonnet-4-6-20250514 → claude-sonnet-4.6)
                 └── Translates Anthropic Messages API ↔ AWS CodeWhisperer protocol
```

#### Kiro model availability by plan

| Plan | Models | Credits/month |
|---|---|---|
| Free ($0) | Sonnet 4.5, Haiku 4.5 | 50 |
| Pro ($20) | + Sonnet 4.6, Opus 4.6 | 1,000 |
| Pro+ ($40) | + Sonnet 4.6, Opus 4.6 | 2,000 |
| Power ($200) | + Sonnet 4.6, Opus 4.6, Opus 4.7, Opus 4.8 | 10,000 |

#### Troubleshooting Kiro

- **"Invalid model ID"**: Your plan doesn't have access to that model. Check with `deepclaude --status` or upgrade at [app.kiro.dev](https://app.kiro.dev).
- **"kirocc not found"**: Install with `GOEXPERIMENT=jsonv2 go install github.com/d-kuro/kirocc/cmd/kirocc@latest`
- **Auth errors**: Run `kiro-cli logout && kiro-cli login` to refresh credentials.
- **Model names**: Always use **dot notation** (e.g., `claude-sonnet-4.6`) in `.env`, NOT dashes.

---

### AWS Bedrock

**Type:** Bedrock (via Node.js proxy)
**Cost:** Per-token via your AWS account (same as Anthropic direct: $3 / $15 per M for Sonnet 4)
**Models:** Any Claude model on Bedrock — `global.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-sonnet-4-5-20250929-v1:0`, etc.

Bedrock differs from Kiro in two important ways:
- You use **your own AWS account** and get billed by AWS directly.
- Authentication uses an **AWS Bedrock API key** (`ABSK…` prefix), not Kiro CLI credentials.

#### Setup

1. **Get an AWS Bedrock API key:**
   - Open the [AWS Bedrock console](https://console.aws.amazon.com/bedrock/) → **API keys** → *Create API key*.
   - Save the key (it starts with `ABSK…`). The key is **region-bound** — note which region you created it in.

2. **Request model access** (one time):
   - In the Bedrock console, go to **Model access** and request access to any Claude model you want to use (e.g., Claude Sonnet 4.6).

3. **Configure `proxy/.env`:**
   ```ini
   AWS_API_KEY=ABSK…
   AWS_REGION=us-east-1
   AWS_MODEL=global.anthropic.claude-sonnet-4-6
   ```

4. **Run it:**
   ```bash
   deepclaude -b aws
   ```

#### Model ID format

Newer Claude models on Bedrock require an **inference-profile prefix**, not a raw foundation model ID:

| Prefix | Routes to |
|---|---|
| `us.anthropic.…` | US regions (us-east-1, us-west-2) |
| `eu.anthropic.…` | EU regions |
| `apac.anthropic.…` | Asia-Pacific regions |
| `global.anthropic.…` | Cross-region (works from any region) |

If you see `Invocation of model … with on-demand throughput isn't supported`, add one of these prefixes to `AWS_MODEL` and retry.

#### What works through the Bedrock path

The proxy converts Claude Code requests into Bedrock's expected shape:
- Strips Claude Code-only fields (`context_management`, `mcp_servers`, `metadata`, `service_tier`, etc.) using a strict whitelist.
- Adds `anthropic_version: "bedrock-2023-05-31"`.
- Decodes the AWS Event Stream binary response back into Anthropic SSE.
- Extended thinking, tool use, system prompts, and multimodal input all pass through.

---

### Nvidia NIM

**Type:** OpenAI-compatible (via Node.js proxy)  
**Cost:** $0.44/M input, $0.87/M output  
**Model:** `moonshotai/kimi-k2.6`

```bash
# Get key from https://build.nvidia.com
export NVIDIA_API_KEY="nvapi-your-key"
deepclaude -b nv
```

**`.env` config:**
```ini
NVIDIA_API_KEY=nvapi-your-key
NVIDIA_MODEL=moonshotai/kimi-k2.6
```

---

### Kimi Code

**Type:** Anthropic-native (direct connect)  
**Cost:** Subscription-based  
**Model:** `kimi-for-coding`

```bash
# Get key from https://kimi.com
export KIMI_API_KEY="sk-your-key"
deepclaude -b kimi
```

**`.env` config:**
```ini
KIMI_API_KEY=sk-your-key
KIMI_MODEL=kimi-for-coding
```

---

### Doubleword AI

**Type:** OpenAI-compatible (via Node.js proxy)  
**Cost:** $0.44/M input, $0.87/M output  
**Model:** `deepseek-ai/DeepSeek-V4-Pro`

```bash
# Get key from https://doubleword.ai
export DOUBLEWORD_API_KEY="sk-your-key"
deepclaude -b dw
```

**`.env` config:**
```ini
DOUBLEWORD_API_KEY=sk-your-key
DOUBLEWORD_MODEL=deepseek-ai/DeepSeek-V4-Pro
```

**Docs:** [docs.doubleword.ai/inference-api/tool-calling](https://docs.doubleword.ai/inference-api/tool-calling)

---

### OpenRouter

**Type:** Anthropic-native (direct connect)  
**Cost:** $0.44/M input, $0.87/M output  
**Model:** `deepseek/deepseek-v4-pro`

```bash
# Get key from https://openrouter.ai
export OPENROUTER_API_KEY="sk-or-your-key"
deepclaude -b or
```

---

### Fireworks AI

**Type:** Anthropic-native (direct connect)  
**Cost:** $1.74/M input, $3.48/M output  
**Model:** `accounts/fireworks/models/deepseek-v4-pro`

```bash
# Get key from https://fireworks.ai
export FIREWORKS_API_KEY="fw_your-key"
deepclaude -b fw
```

---

## How it works

Claude Code reads these environment variables to determine where to send API calls:

| Variable | What it does |
|---|---|
| `ANTHROPIC_BASE_URL` | API endpoint (default: api.anthropic.com) |
| `ANTHROPIC_AUTH_TOKEN` | API key for the backend |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Model name for Opus-tier tasks |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Model name for Sonnet-tier tasks |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Model name for Haiku-tier (subagents) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Model for spawned subagents |

**deepclaude** sets these per-session (not permanently), launches Claude Code, then restores your original settings on exit.

---

## Remote control (`--remote`)

Open a Claude Code session in any browser — with your chosen backend as the brain:

```bash
deepclaude --remote                # Remote control + DeepSeek
deepclaude --remote -b kiro        # Remote control + Kiro (AWS Claude)
deepclaude --remote -b aws         # Remote control + AWS Bedrock
deepclaude --remote -b or          # Remote control + OpenRouter
deepclaude --remote -b anthropic   # Remote control + Anthropic (normal)
```

This prints a `https://claude.ai/code/session_...` URL you can open on your phone, tablet, or any browser.

```
claude remote-control
  +-- Bridge WebSocket -> wss://bridge.claudeusercontent.com (Anthropic)
  +-- Model API calls  -> Your chosen backend
```

**Prerequisites:** Must be logged into Claude Code (`claude auth login`) and have a claude.ai subscription.

---

## Cost comparison

| Usage level | Anthropic Max | deepclaude (DeepSeek) | Kiro Pro | Savings |
|---|---|---|---|---|
| Light (10 days/mo) | $200/mo (capped) | ~$20/mo | $20/mo | 90% |
| Heavy (25 days/mo) | $200/mo (capped) | ~$50/mo | $20/mo | 75-90% |
| With auto loops | $200/mo (capped) | ~$80/mo | $20-40/mo | 60-90% |

---

## Project structure

```
deepclaude-cli/
├── deepclaude.sh          # Main launcher (Linux/macOS)
├── deepclaude.ps1         # Main launcher (Windows)
├── proxy/
│   ├── .env               # API keys and configuration
│   ├── .env.example       # Template for .env
│   ├── model-proxy.js     # HTTP proxy server (Anthropic ↔ backend)
│   ├── openai-translator.js  # Anthropic ↔ OpenAI format translator
│   ├── start-proxy.js     # Proxy entry point
│   └── README.md          # Proxy technical details
├── screenshots/           # Documentation images
└── README.md              # This file
```

### Key files explained

| File | Purpose |
|---|---|
| `deepclaude.sh` | Bash launcher. Resolves backend, starts proxy/kirocc if needed, sets env vars, launches `claude`. |
| `deepclaude.ps1` | PowerShell equivalent for Windows. Same logic, different syntax. |
| `model-proxy.js` | HTTP server that routes `/v1/messages` to the active backend. Handles live switching, cost tracking. |
| `openai-translator.js` | Streaming translator between Anthropic Messages API and OpenAI Chat Completions API. Used by Nvidia and Doubleword backends. |
| `start-proxy.js` | Starts the proxy server with the given backend URL and key. Outputs the port number for the shell script. |

---

## What works and what doesn't

### Works
- File reading, writing, editing (Read/Write/Edit tools)
- Bash/PowerShell execution
- Glob and Grep search
- Multi-step autonomous tool loops
- Subagent spawning
- Git operations
- Project initialization (`/init`)
- Thinking mode (enabled by default)

### Doesn't work or degraded

| Feature | Reason |
|---|---|
| Image/vision input | DeepSeek/Kimi endpoints don't support images |
| MCP server tools | Not all backends support MCP |
| Prompt caching savings | Each backend has its own caching; Anthropic's `cache_control` is ignored |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DEEPSEEK_API_KEY` | For DeepSeek | API key from platform.deepseek.com |
| `OPENROUTER_API_KEY` | For OpenRouter | API key from openrouter.ai |
| `FIREWORKS_API_KEY` | For Fireworks | API key from fireworks.ai |
| `NVIDIA_API_KEY` | For Nvidia | API key from build.nvidia.com |
| `KIMI_API_KEY` | For Kimi | API key from kimi.com |
| `DOUBLEWORD_API_KEY` | For Doubleword | API key from doubleword.ai |
| `KIRO_API_KEY` | For Kiro | API key (ksk_ prefix) from kiro.dev |
| `AWS_API_KEY` | For AWS Bedrock | Bedrock API key (ABSK prefix) from AWS Console |
| `AWS_REGION` | For AWS Bedrock | Region the key was issued in (e.g. `us-east-1`) |
| `AWS_MODEL` | For AWS Bedrock | Bedrock model ID, e.g. `global.anthropic.claude-sonnet-4-6` |
| `API_PROVIDER` | No | Default backend (ds, or, fw, nv, kimi, dw, kiro, aws) |
| `CONTEXT_WINDOW_TOKENS` | No | Override the context window (tokens) for non-Kiro backends, e.g. `1000000`. See [Context window](#context-window). |

---

## Context window

Claude Code only knows the context-window size of Anthropic's own models — it defaults **every other model to 200K tokens**, even when the backend model supports far more. deepclaude unlocks the real window automatically:

| Backend | How the window is set |
|---|---|
| **Kiro** | The launcher appends a `[1m]` suffix to 1M-capable Opus models (`claude-opus-4.6/4.7/4.8`). kirocc strips `[1m]` upstream and maps to the real SKU. Auto-compaction stays on. |
| **DeepSeek / OpenRouter / Fireworks / Nvidia / Kimi / Doubleword** | The launcher auto-detects the window from the model name (e.g. DeepSeek V4 → 1M, Kimi → 256K, Nemotron → 1M) and sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. |
| **AWS Bedrock** | Opt-in: set `CONTEXT_WINDOW_TOKENS=1000000` and the proxy adds the `context-1m-2025-08-07` beta to the request body for 1M-capable Claude models. |

**Manual override:** set `CONTEXT_WINDOW_TOKENS` in `proxy/.env` to your model's real window. This always wins over auto-detection:

```ini
CONTEXT_WINDOW_TOKENS=1000000
```

**Tradeoff:** for non-Kiro backends, unlocking a larger window requires `DISABLE_COMPACT=1` (Claude Code's own requirement), so auto-compaction is turned off. Use `/compact` manually for very long sessions. Set the value to the model's *actual* window — going higher than the backend supports causes upstream errors.

---

## VS Code / Cursor integration

Add terminal profiles to launch deepclaude from the IDE:

**Linux/macOS:**
```json
{
  "terminal.integrated.profiles.linux": {
    "DeepClaude Agent": {
      "path": "/usr/local/bin/deepclaude"
    }
  }
}
```

**Windows:**
```json
{
  "terminal.integrated.profiles.windows": {
    "DeepClaude Agent": {
      "path": "powershell.exe",
      "args": ["-ExecutionPolicy", "Bypass", "-NoExit", "-File", "C:\\path\\to\\deepclaude.ps1"]
    }
  }
}
```

---

## License

MIT
