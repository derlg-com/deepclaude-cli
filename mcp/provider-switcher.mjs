#!/usr/bin/env node
// MCP stdio server — exposes switch_provider, switch_model, get_status tools
// Claude Code starts this automatically; it talks to the deepclaude proxy on DEEPCLAUDE_PROXY_PORT.

import { request as httpReq } from 'http';

const PROXY_PORT = process.env.DEEPCLAUDE_PROXY_PORT || '3200';

const ALIASES = {
    ds: 'deepseek', deepseek: 'deepseek',
    or: 'openrouter', openrouter: 'openrouter',
    fw: 'fireworks', fireworks: 'fireworks',
    nv: 'nvidia', nvidia: 'nvidia',
    kimi: 'kimi',
    dw: 'doubleword', doubleword: 'doubleword',
    kiro: 'kiro',
    anthropic: 'anthropic',
};

const TOOLS = [
    {
        name: 'switch_provider',
        description: 'Switch the AI backend provider while Claude Code is running. Providers: kiro, ds (deepseek), kimi, or (openrouter), fw (fireworks), nv (nvidia), dw (doubleword), anthropic.',
        inputSchema: {
            type: 'object',
            properties: {
                provider: { type: 'string', description: 'Provider name or shorthand: kiro, ds, kimi, or, fw, nv, dw, anthropic' },
            },
            required: ['provider'],
        },
    },
    {
        name: 'switch_model',
        description: 'Override the model used for API requests. Pass an empty string to clear the override and use the provider default.',
        inputSchema: {
            type: 'object',
            properties: {
                model: { type: 'string', description: 'Model ID, e.g. deepseek-v3, kimi-for-coding. Empty string clears override.' },
            },
            required: ['model'],
        },
    },
    {
        name: 'get_status',
        description: 'Get the current provider, model override, available backends, and proxy uptime.',
        inputSchema: { type: 'object', properties: {} },
    },
];

function proxyCall(method, path, body) {
    return new Promise((resolve, reject) => {
        const postData = body || '';
        const opts = {
            hostname: '127.0.0.1',
            port: parseInt(PROXY_PORT, 10),
            path,
            method,
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(postData),
            },
        };
        const req = httpReq(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { resolve({ raw: Buffer.concat(chunks).toString() }); }
            });
        });
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function callTool(name, args) {
    if (name === 'switch_provider') {
        const raw = (args.provider || '').toLowerCase().trim();
        const canonical = ALIASES[raw];
        if (!canonical) {
            return { content: [{ type: 'text', text: `Unknown provider "${raw}". Use: kiro, ds, kimi, or, fw, nv, dw, anthropic` }], isError: true };
        }
        try {
            const result = await proxyCall('POST', '/_proxy/mode', `backend=${canonical}`);
            if (result.error) return { content: [{ type: 'text', text: `Switch failed: ${result.error}` }], isError: true };
            return { content: [{ type: 'text', text: `Provider switched: ${result.previous} → ${result.mode}` }] };
        } catch {
            return { content: [{ type: 'text', text: `Proxy unreachable on port ${PROXY_PORT}. Is deepclaude running?` }], isError: true };
        }
    }

    if (name === 'switch_model') {
        const model = (args.model || '').trim();
        try {
            const result = await proxyCall('POST', '/_proxy/model', `model=${encodeURIComponent(model)}`);
            if (result.error) return { content: [{ type: 'text', text: `Model switch failed: ${result.error}` }], isError: true };
            const msg = model ? `Model override set to: ${model}` : 'Model override cleared — using provider default';
            return { content: [{ type: 'text', text: msg }] };
        } catch {
            return { content: [{ type: 'text', text: `Proxy unreachable on port ${PROXY_PORT}.` }], isError: true };
        }
    }

    if (name === 'get_status') {
        try {
            const result = await proxyCall('GET', '/_proxy/status', '');
            const lines = [
                `Provider: ${result.mode}`,
                `Model override: ${result.model_override || '(none — using provider default)'}`,
                `Available: ${(result.available_backends || []).join(', ')}`,
                `Uptime: ${result.uptime}s | Requests: ${result.requests}`,
            ];
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch {
            return { content: [{ type: 'text', text: `Proxy unreachable on port ${PROXY_PORT}.` }], isError: true };
        }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'deepclaude-switcher', version: '1.0.0' } } };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
        const result = await callTool(params.name, params.arguments || {});
        return { jsonrpc: '2.0', id, result };
    }
    if (id !== undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
    }
    return null;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let msg;
        try { msg = JSON.parse(t); } catch { continue; }
        const resp = await handle(msg);
        if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    }
});
