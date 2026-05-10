#!/usr/bin/env node
import { startModelProxy } from './model-proxy.js';

const BACKEND_DEFS = {
    deepseek: { url: 'https://api.deepseek.com/anthropic', keyEnv: 'DEEPSEEK_API_KEY' },
    openrouter: { url: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
    fireworks: { url: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
    kimi: { url: 'https://api.kimi.com/coding/', keyEnv: 'KIMI_API_KEY' },
    nvidia: { url: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY' },
    doubleword: { url: 'https://api.doubleword.ai/v1', keyEnv: 'DOUBLEWORD_API_KEY' },
};

// Parse --mode from argv regardless of position
const allArgs = process.argv.slice(2);
const modeIdx = allArgs.indexOf('--mode');
const cliMode = modeIdx >= 0 ? allArgs[modeIdx + 1] : null;
const portIdx = allArgs.indexOf('--port');
const cliPort = portIdx >= 0 ? parseInt(allArgs[portIdx + 1], 10) : null;

// Filter out flags to get positional args
const positional = allArgs.filter((a, i) => {
    if (a === '--mode' || a === '--port') return false;
    if (i > 0 && (allArgs[i - 1] === '--mode' || allArgs[i - 1] === '--port')) return false;
    return true;
});

const targetUrl = positional[0] || process.env.CHEAPCLAUDE_TARGET_URL;
const apiKey = positional[1] || process.env.CHEAPCLAUDE_API_KEY;

// Build backends from env vars
const backends = {};
for (const [name, def] of Object.entries(BACKEND_DEFS)) {
    const key = process.env[def.keyEnv];
    if (key || !(targetUrl && apiKey)) {
        backends[name] = { url: def.url, apiKey: key || null };
    }
}

if (targetUrl && apiKey) {
    // Legacy-compatible mode: URL + key provided as positional args
    // Now also respects --mode flag for setting the default backend
    const hasBackends = Object.keys(backends).length > 0;
    const defaultMode = cliMode || undefined;

    const { port } = await startModelProxy({
        targetUrl,
        apiKey,
        startPort: cliPort || 3200,
        backends: hasBackends ? backends : undefined,
        defaultMode,
    });
    console.log(port);
} else {
    // Standalone mode with live toggle
    const fallbackUrl = backends.deepseek?.url || 'https://api.deepseek.com/anthropic';
    const fallbackKey = backends.deepseek?.apiKey || 'unused';
    const defaultMode = cliMode || 'anthropic';
    const port = cliPort || 3200;

    const proxy = await startModelProxy({
        targetUrl: fallbackUrl,
        apiKey: fallbackKey,
        startPort: port,
        backends,
        defaultMode,
    });

    console.error(`Proxy on :${proxy.port} (mode: ${defaultMode})`);
    console.error(`Switch: curl -sX POST http://127.0.0.1:${proxy.port}/_proxy/mode -d backend=deepseek`);
    console.error(`Status: curl -s http://127.0.0.1:${proxy.port}/_proxy/status`);
}
