# How to Start deepclaude

A quick walkthrough for running deepclaude on Windows, macOS, and Linux.

---

## 1. Prerequisites

| Tool | Why | Install |
|---|---|---|
| **Node.js 20+** | Runs the translation proxy | https://nodejs.org |
| **Claude Code** | The CLI deepclaude wraps | https://docs.claude.com/claude-code |
| **Git** | To clone this repo | https://git-scm.com |
| **kirocc** (Kiro backend only) | Go binary, translates Anthropic ↔ Kiro AWS protocol | `GOEXPERIMENT=jsonv2 go install github.com/d-kuro/kirocc/cmd/kirocc@latest` |

Verify Claude Code works first:

```bash
claude --version
```

---

## 2. Get the code

```bash
git clone <this repo>
cd deepclaude-cli
```

---

## 3. Configure your API keys

```bash
cp proxy/.env.example proxy/.env
```

Open `proxy/.env` in any editor and fill in the keys for the provider(s) you have:

```ini
# Pick which provider deepclaude uses by default
API_PROVIDER=ds          # ds | or | fw | nv | kimi | dw | kiro | aws

# Fill in one or more — only the active provider's key is required
DEEPSEEK_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
FIREWORKS_API_KEY=fw_...
NVIDIA_API_KEY=nvapi-...
KIMI_API_KEY=sk-kimi-...
DOUBLEWORD_API_KEY=sk-...
KIRO_API_KEY=ksk_...     # also needs kirocc installed (see prerequisites)
AWS_API_KEY=ABSK...      # AWS Bedrock — also set AWS_REGION + AWS_MODEL
AWS_REGION=us-east-1
AWS_MODEL=global.anthropic.claude-sonnet-4-6
```

Where to get each key — see the README's **Provider Setup** section.

---

## 4. Install the launcher

### Linux / macOS

```bash
chmod +x deepclaude.sh
sudo ln -s "$(pwd)/deepclaude.sh" /usr/local/bin/deepclaude
```

No-sudo alternative:

```bash
mkdir -p ~/.local/bin
ln -s "$(pwd)/deepclaude.sh" ~/.local/bin/deepclaude
# make sure ~/.local/bin is on your PATH
```

### Windows (PowerShell)

```powershell
# Allow the script to run (one time)
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# Add an alias to your PowerShell profile
Add-Content $PROFILE "`nSet-Alias deepclaude '$PWD\deepclaude.ps1'"
. $PROFILE
```

---

## 5. Launch it

```bash
deepclaude                  # uses the API_PROVIDER set in .env
deepclaude -b ds            # DeepSeek
deepclaude -b kiro          # Kiro (needs kirocc + KIRO_API_KEY)
deepclaude -b aws           # AWS Bedrock (Claude Sonnet 4.6)
deepclaude -b kimi          # Kimi Code
deepclaude -b or            # OpenRouter
deepclaude -b fw            # Fireworks
deepclaude -b nv            # Nvidia NIM
deepclaude -b dw            # Doubleword AI
deepclaude -b anthropic     # Normal Claude Code

deepclaude --status         # show which keys are loaded
deepclaude --cost           # pricing comparison
deepclaude --benchmark      # latency test
```

---

## Switching providers

Change the active provider by editing `API_PROVIDER` in `proxy/.env` (or pass `-b <name>` on the command line). Provider selection is decided when you start deepclaude — to change provider mid-session, exit Claude Code and relaunch with the new backend.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `deepclaude: command not found` | Symlink isn't on PATH. Repeat step 4 or use the full path: `./deepclaude.sh`. |
| `kirocc not found` | Install it: `GOEXPERIMENT=jsonv2 go install github.com/d-kuro/kirocc/cmd/kirocc@latest` and make sure `~/go/bin` (or your `$GOBIN`) is on PATH. |
| AWS returns `Invocation of model … with on-demand throughput isn't supported` | Your `AWS_MODEL` needs an inference-profile prefix. Try `us.anthropic.claude-sonnet-4-6` or `global.anthropic.claude-sonnet-4-6`. |
| AWS returns `invalid beta flag` or `Extra inputs are not permitted` | Already handled by the proxy — restart deepclaude to pick up the latest code. |
| Port 3200 already in use | A previous proxy didn't shut down. Kill it: `lsof -ti:3200 \| xargs kill -9` (Linux/macOS). On Windows: `Get-NetTCPConnection -LocalPort 3200 \| Stop-Process -Id $_.OwningProcess -Force`. |

For anything else, check the README or open an issue.
