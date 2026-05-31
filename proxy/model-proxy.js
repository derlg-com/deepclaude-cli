import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { Transform } from 'stream';
import { anthropicToOpenAI, openAIToAnthropic, OpenAIToAnthropicStream, fixResponseHeaders } from './openai-translator.js';

const ANTHROPIC_FALLBACK = 'https://api.anthropic.com';
const MODEL_PATHS = ['/v1/messages'];
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per request

const MODEL_REMAP = {
    deepseek: {
        'claude-opus-4-6':    'deepseek-v4-pro',
        'claude-opus-4-7':    'deepseek-v4-pro',
        'claude-sonnet-4-6':  'deepseek-v4-flash',
        'claude-sonnet-4-5-20250929': 'deepseek-v4-flash',
        'claude-haiku-4-5-20251001':  'deepseek-v4-flash',
    },
    openrouter: {
        'claude-opus-4-6':    'deepseek/deepseek-v4-pro',
        'claude-opus-4-7':    'deepseek/deepseek-v4-pro',
        'claude-sonnet-4-6':  'deepseek/deepseek-v4-flash',
        'claude-sonnet-4-5-20250929': 'deepseek/deepseek-v4-flash',
        'claude-haiku-4-5-20251001':  'deepseek/deepseek-v4-flash',
    },
    // Kimi uses native Anthropic format — model is always kimi-for-coding
    kimi: {
        'claude-opus-4-6':    'kimi-for-coding',
        'claude-opus-4-7':    'kimi-for-coding',
        'claude-sonnet-4-6':  'kimi-for-coding',
        'claude-sonnet-4-5-20250929': 'kimi-for-coding',
        'claude-haiku-4-5-20251001':  'kimi-for-coding',
    },
    // Nvidia uses OpenAI format — needs translation
    nvidia: {
        'claude-opus-4-6':    'moonshotai/kimi-k2.6',
        'claude-opus-4-7':    'moonshotai/kimi-k2.6',
        'claude-sonnet-4-6':  'moonshotai/kimi-k2.6',
        'claude-sonnet-4-5-20250929': 'moonshotai/kimi-k2.6',
        'claude-haiku-4-5-20251001':  'moonshotai/kimi-k2.6',
    },
    // Doubleword uses OpenAI format — needs translation
    doubleword: {
        'claude-opus-4-6':    'deepseek-ai/DeepSeek-V4-Pro',
        'claude-opus-4-7':    'deepseek-ai/DeepSeek-V4-Pro',
        'claude-sonnet-4-6':  'deepseek-ai/DeepSeek-V4-Pro',
        'claude-sonnet-4-5-20250929': 'deepseek-ai/DeepSeek-V4-Pro',
        'claude-haiku-4-5-20251001':  'deepseek-ai/DeepSeek-V4-Pro',
    },
    // AWS Bedrock — map to inference-profile model IDs. Override via AWS_MODEL env var.
    aws: (() => {
        const m = process.env.AWS_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
        return {
            'claude-opus-4-6':    m,
            'claude-opus-4-7':    m,
            'claude-sonnet-4-6':  m,
            'claude-sonnet-4-5-20250929': m,
            'claude-haiku-4-5-20251001':  m,
        };
    })(),
};

const PRICING_PER_M = {
    deepseek:   { input: 0.44,  output: 0.87 },
    openrouter: { input: 0.44,  output: 0.87 },
    fireworks:  { input: 1.74,  output: 3.48 },
    nvidia:     { input: 0.44,  output: 0.87 },
    kimi:       { input: 0.00,  output: 0.00 },  // subscription-based
    doubleword: { input: 0.44,  output: 0.87 },
    aws:        { input: 3.00,  output: 15.00 },  // AWS Bedrock Claude Sonnet
    anthropic:  { input: 3.00,  output: 15.00 },
    _single:    { input: 0.44,  output: 0.87 },
};

/**
 * Backends that use OpenAI Chat Completions format instead of Anthropic
 * Messages format. These require full request/response translation.
 */
const OPENAI_COMPAT_BACKENDS = new Set(['nvidia', 'doubleword']);

/**
 * Backends that use AWS Bedrock InvokeModelWithResponseStream:
 *  - URL contains the model ID
 *  - Bearer auth (with AWS API key ABSK...)
 *  - Body has no `model` field, requires `anthropic_version: "bedrock-2023-05-31"`
 *  - Response is AWS Event Stream binary (must decode → Anthropic SSE)
 */
const BEDROCK_BACKENDS = new Set(['aws']);

/**
 * Backends that need anthropic-beta and other Anthropic-specific headers
 * stripped (they reject unknown headers).
 */
const STRIP_ANTHROPIC_HEADERS = new Set(['kimi', 'nvidia', 'doubleword', 'aws']);

// ── Unified gateway model registry ──────────────────────────────
// In gateway mode the proxy advertises every configured provider's
// models through GET /v1/models so Claude Code's /model picker (with
// CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1) lists them all.
// Claude Code only keeps model ids matching /^(claude|anthropic)/i, so
// ids are prefixed `claude-gw-<prov>-<model>`; the human label (with the
// provider name) goes in display_name. A trailing [1m] makes Claude Code
// size the context window to 1M for capable models.
const PROVIDER_LABELS = {
    deepseek: 'DeepSeek', openrouter: 'OpenRouter', fireworks: 'Fireworks',
    nvidia: 'Nvidia', kimi: 'Kimi', doubleword: 'Doubleword',
};
const ENV_MODELS_KEY = {
    nvidia: 'NVIDIA_MODELS', deepseek: 'DEEPSEEK_MODELS', doubleword: 'DOUBLEWORD_MODELS',
    openrouter: 'OPENROUTER_MODELS', fireworks: 'FIREWORKS_MODELS', kimi: 'KIMI_MODELS',
};
// Curated defaults shown when <PROV>_MODELS isn't set. Kiro/AWS are Claude
// backends launched on their own (-b kiro/-b aws) and aren't aggregated here.
const GATEWAY_MODEL_LISTS = {
    nvidia: ['nvidia/nemotron-3-super-120b-a12b', 'moonshotai/kimi-k2.6', 'deepseek-ai/deepseek-v4-pro', 'qwen/qwen3-coder-480b-a35b-instruct', 'openai/gpt-oss-120b'],
    deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    doubleword: ['deepseek-ai/DeepSeek-V4-Pro'],
    openrouter: ['deepseek/deepseek-v4-pro'],
    fireworks: ['accounts/fireworks/models/deepseek-v4-pro'],
    kimi: ['kimi-for-coding'],
};

function isOneMModel(model) {
    return /deepseek-v4|deepseek-v3\.2|nemotron/i.test(model);
}

// Build the registry from the configured backends. Returns an array of
// { id, idBase, backend, upstreamModel, display }.
function buildGatewayRegistry(allBackends) {
    const entries = [];
    for (const prov of Object.keys(GATEWAY_MODEL_LISTS)) {
        if (!allBackends[prov] || !allBackends[prov].apiKey) continue;
        const envList = (process.env[ENV_MODELS_KEY[prov]] || '').split(',').map(s => s.trim()).filter(Boolean);
        const models = envList.length ? envList : GATEWAY_MODEL_LISTS[prov];
        for (const model of models) {
            const idBase = 'claude-gw-' + (prov + '-' + model).replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '');
            const id = idBase + (isOneMModel(model) ? '[1m]' : '');
            entries.push({ id, idBase, backend: prov, upstreamModel: model, display: `${PROVIDER_LABELS[prov] || prov}: ${model}` });
        }
    }
    return entries;
}

// Resolve a model id from Claude Code back to its registry entry. Tolerates
// the optional trailing [1m] suffix.
function lookupGatewayModel(registry, model) {
    if (!model) return null;
    const base = String(model).replace(/\[1m\]$/, '');
    return registry.find(e => e.id === model || e.idBase === base) || null;
}


/**
 * Transform stream that intercepts SSE events and injects missing `usage`
 * fields. DeepSeek/OpenRouter may omit `usage` in message_start or
 * message_delta, which crashes Claude Code ("$.input_tokens" is undefined).
 */
class UsageNormalizer extends Transform {
    constructor(onUsage) {
        super();
        this._buf = '';
        this._onUsage = onUsage;
        this._inputTokens = 0;
        this._outputTokens = 0;
    }

    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const parts = this._buf.split('\n\n');
        this._buf = parts.pop();
        for (const part of parts) {
            this.push(this._fix(part) + '\n\n');
        }
        cb();
    }

    _fix(event) {
        const m = event.match(/^data: (.+)$/m);
        if (!m) return event;
        try {
            const d = JSON.parse(m[1]);
            let changed = false;
            if (d.type === 'message_start' && d.message) {
                if (d.message.usage) {
                    this._inputTokens = d.message.usage.input_tokens || 0;
                } else {
                    d.message.usage = { input_tokens: 0, output_tokens: 0 };
                    changed = true;
                }
            }
            if (d.type === 'message_delta') {
                if (d.usage) {
                    this._outputTokens = d.usage.output_tokens || 0;
                } else {
                    d.usage = { output_tokens: 0 };
                    changed = true;
                }
            }
            if (changed) return event.replace(m[1], () => JSON.stringify(d));
        } catch { /* not JSON, pass through */ }
        return event;
    }

    _flush(cb) {
        if (this._buf.trim()) this.push(this._fix(this._buf) + '\n\n');
        if (this._onUsage) this._onUsage(this._inputTokens, this._outputTokens);
        cb();
    }
}

/**
 * For non-streaming JSON responses, ensure `usage` exists.
 */
function normalizeJsonBody(buf) {
    try {
        const obj = JSON.parse(buf);
        if (obj.type === 'message' && !obj.usage) {
            obj.usage = { input_tokens: 0, output_tokens: 0 };
            return Buffer.from(JSON.stringify(obj));
        }
    } catch { /* not JSON */ }
    return buf;
}

function stripAllThinkingBlocks(body) {
    if (!body?.messages) return;
    for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(b => b.type !== 'thinking');
    }
}

function stripUnsignedThinkingBlocks(body) {
    if (!body?.messages) return;
    for (const msg of body.messages) {
        if (!Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter(
            block => block.type !== 'thinking' || block.signature
        );
    }
}

/**
 * Decodes AWS Bedrock Event Stream (binary framing) into Anthropic SSE.
 *
 * Frame layout: [totalLen:4 BE][headersLen:4 BE][preludeCRC:4][headers][payload][messageCRC:4]
 * Each frame's payload (for event-type "chunk") is JSON: { "bytes": "<base64 Anthropic event>" }.
 * We base64-decode that and re-emit as an SSE event Claude Code understands.
 */
class BedrockEventStreamToSSE extends Transform {
    constructor(onUsage) {
        super();
        this._buf = Buffer.alloc(0);
        this._onUsage = onUsage;
        this._in = 0;
        this._out = 0;
    }

    _transform(chunk, _enc, cb) {
        this._buf = Buffer.concat([this._buf, chunk]);
        this._parseFrames();
        cb();
    }

    _parseFrames() {
        while (this._buf.length >= 12) {
            const totalLen = this._buf.readUInt32BE(0);
            if (totalLen < 16 || totalLen > 16 * 1024 * 1024) { this._buf = Buffer.alloc(0); return; }
            if (this._buf.length < totalLen) return; // wait for full frame
            const headersLen = this._buf.readUInt32BE(4);
            const headersStart = 12;
            const payloadStart = headersStart + headersLen;
            const payloadEnd = totalLen - 4;
            const headers = this._parseHeaders(headersStart, payloadStart);
            const payload = this._buf.slice(payloadStart, payloadEnd);
            this._handle(headers, payload);
            this._buf = this._buf.slice(totalLen);
        }
    }

    _parseHeaders(start, end) {
        const headers = {};
        let off = start;
        while (off < end) {
            if (off + 1 > end) break;
            const nameLen = this._buf.readUInt8(off); off += 1;
            if (off + nameLen > end) break;
            const name = this._buf.slice(off, off + nameLen).toString(); off += nameLen;
            if (off + 1 > end) break;
            const type = this._buf.readUInt8(off); off += 1;
            if (type === 7) { // string
                if (off + 2 > end) break;
                const vLen = this._buf.readUInt16BE(off); off += 2;
                if (off + vLen > end) break;
                headers[name] = this._buf.slice(off, off + vLen).toString();
                off += vLen;
            } else {
                break; // unknown type — bail
            }
        }
        return headers;
    }

    _handle(headers, payload) {
        const eventType = headers[':event-type'];
        const messageType = headers[':message-type'];

        if (messageType === 'exception' || messageType === 'error') {
            let msg = payload.toString();
            try { const j = JSON.parse(msg); msg = j.message || msg; } catch {}
            this.push(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg.substring(0, 500) } })}\n\n`);
            return;
        }

        if (eventType !== 'chunk') return;

        try {
            const wrapper = JSON.parse(payload.toString());
            if (!wrapper.bytes) return;
            const decoded = Buffer.from(wrapper.bytes, 'base64').toString();
            const event = JSON.parse(decoded);
            const name = event.type;
            if (event.type === 'message_start' && event.message?.usage) {
                this._in = event.message.usage.input_tokens || 0;
            }
            if (event.type === 'message_delta' && event.usage) {
                this._out = event.usage.output_tokens || 0;
            }
            this.push(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch (e) {
            console.error('[BEDROCK] failed to decode event:', e.message);
        }
    }

    _flush(cb) {
        if (this._onUsage) this._onUsage(this._in, this._out);
        cb();
    }
}

export function startModelProxy({ targetUrl, apiKey, startPort = 3200, backends, defaultMode }) {
    return new Promise((resolve, reject) => {
        const initialTarget = new URL(targetUrl);
        const initialBearer = targetUrl.includes('openrouter') || targetUrl.includes('fireworks')
            || targetUrl.includes('nvidia') || targetUrl.includes('doubleword');

        const allBackends = {};
        if (backends) {
            for (const [name, cfg] of Object.entries(backends)) {
                allBackends[name] = {
                    target: new URL(cfg.url),
                    apiKey: cfg.apiKey,
                    useBearer: cfg.url.includes('openrouter') || cfg.url.includes('fireworks')
                        || cfg.url.includes('nvidia') || cfg.url.includes('doubleword'),
                };
            }
        }
        const initialName = defaultMode || (backends ? 'anthropic' : null);
        const startBackend = initialName && initialName !== 'anthropic' && allBackends[initialName];

        // Gateway (multi-provider) mode: aggregate every backend's models
        // into one /model picker and route each request by its model id.
        const gatewayMode = initialName === 'gateway';
        const gatewayRegistry = gatewayMode ? buildGatewayRegistry(allBackends) : [];
        if (gatewayMode) {
            console.error(`[MODEL-PROXY] gateway mode: ${gatewayRegistry.length} models from ${[...new Set(gatewayRegistry.map(e => e.backend))].join(', ')}`);
        }

        const state = {
            mode: initialName || '_single',
            target: startBackend ? startBackend.target : initialTarget,
            apiKey: startBackend ? startBackend.apiKey : apiKey,
            useBearer: startBackend ? startBackend.useBearer : initialBearer,
            hadNonAnthropicSession: !!startBackend,
        };

        let reqCount = 0;
        const t0Global = Date.now();
        const costs = {};

        function recordUsage(backend, inputTokens, outputTokens) {
            if (!costs[backend]) costs[backend] = { input: 0, output: 0, requests: 0 };
            costs[backend].input += inputTokens || 0;
            costs[backend].output += outputTokens || 0;
            costs[backend].requests++;
        }

        function getCostSummary() {
            const summary = {};
            let totalActual = 0;
            let totalAnthropic = 0;
            for (const [backend, tokens] of Object.entries(costs)) {
                const p = PRICING_PER_M[backend] || PRICING_PER_M._single;
                const ap = PRICING_PER_M.anthropic;
                const actual = (tokens.input * p.input + tokens.output * p.output) / 1_000_000;
                const anthropicEq = (tokens.input * ap.input + tokens.output * ap.output) / 1_000_000;
                totalActual += actual;
                totalAnthropic += anthropicEq;
                summary[backend] = {
                    input_tokens: tokens.input,
                    output_tokens: tokens.output,
                    requests: tokens.requests,
                    cost: +actual.toFixed(4),
                    anthropic_equivalent: +anthropicEq.toFixed(4),
                };
            }
            return {
                backends: summary,
                total_cost: +totalActual.toFixed(4),
                anthropic_equivalent: +totalAnthropic.toFixed(4),
                savings: +((totalAnthropic - totalActual).toFixed(4)),
            };
        }

        function switchMode(name) {
            if (name === 'anthropic') {
                const prev = state.mode;
                state.mode = 'anthropic';
                state.target = new URL(ANTHROPIC_FALLBACK);
                state.apiKey = null;
                state.useBearer = false;
                return { mode: 'anthropic', previous: prev };
            }
            const b = allBackends[name];
            if (!b) return { error: `Unknown backend: ${name}. Valid: anthropic, ${Object.keys(allBackends).join(', ')}` };
            if (!b.apiKey) return { error: `API key not set for ${name}` };
            const prev = state.mode;
            state.mode = name;
            state.target = b.target;
            state.apiKey = b.apiKey;
            state.useBearer = b.useBearer;
            state.hadNonAnthropicSession = true;
            return { mode: name, previous: prev };
        }

        const server = createServer((clientReq, clientRes) => {
            const urlPath = clientReq.url.split('?')[0];

            // Control endpoints — /_proxy/* (never collides with /v1/*)
            if (urlPath.startsWith('/_proxy/')) {
                if (urlPath === '/_proxy/status') {
                    clientRes.writeHead(200, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({
                        mode: state.mode,
                        uptime: Math.round((Date.now() - t0Global) / 1000),
                        requests: reqCount,
                    }));
                    return;
                }
                if (urlPath === '/_proxy/cost') {
                    clientRes.writeHead(200, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify(getCostSummary()));
                    return;
                }
                if (urlPath === '/_proxy/mode' && clientReq.method === 'POST') {
                    const origin = clientReq.headers['origin'] || '';
                    if (origin && !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost')) {
                        clientRes.writeHead(403, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ error: 'Forbidden' }));
                        return;
                    }
                    const chunks = [];
                    let bodySize = 0;
                    clientReq.on('data', c => {
                        bodySize += c.length;
                        if (bodySize > 1024) { clientReq.destroy(); return; }
                        chunks.push(c);
                    });
                    clientReq.on('end', () => {
                        const body = Buffer.concat(chunks).toString();
                        const m = body.match(/backend=([a-z]+)/);
                        if (!m) {
                            clientRes.writeHead(400, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify({ error: 'Missing backend= in body' }));
                            return;
                        }
                        const result = switchMode(m[1]);
                        if (result.error) {
                            clientRes.writeHead(400, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify(result));
                            return;
                        }
                        console.error(`[MODEL-PROXY] Mode switched: ${result.previous} → ${result.mode}`);
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify(result));
                    });
                    return;
                }
                if (urlPath === '/_proxy/mode' && clientReq.method !== 'POST') {
                    clientRes.writeHead(405, { 'content-type': 'application/json' });
                    clientRes.end(JSON.stringify({ error: 'Use POST' }));
                    return;
                }
                clientRes.writeHead(404, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            // Gateway model discovery: Claude Code (with
            // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1) fetches this to
            // populate its /model picker with every provider's models.
            if (gatewayMode && urlPath === '/v1/models' && clientReq.method === 'GET') {
                clientRes.writeHead(200, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({
                    data: gatewayRegistry.map(e => ({
                        type: 'model',
                        id: e.id,
                        display_name: e.display,
                        created_at: '2025-01-01T00:00:00Z',
                    })),
                }));
                return;
            }

            // In anthropic mode, everything passes through transparently
            const isAnthropicMode = state.mode === 'anthropic';
            const isModelCall = !isAnthropicMode && MODEL_PATHS.includes(urlPath);

            // Per-request route. Defaults to the session backend (state); in
            // gateway mode it's overridden from the model id after the body is
            // parsed (see clientReq.on('end')). Request-local so concurrent
            // requests to different providers never clobber each other.
            let rtMode = state.mode, rtTarget = state.target, rtKey = state.apiKey, rtUseBearer = state.useBearer;

            let isOpenAICompat = isModelCall && OPENAI_COMPAT_BACKENDS.has(rtMode);
            let isBedrock = isModelCall && BEDROCK_BACKENDS.has(rtMode);
            let dest = isModelCall ? rtTarget : new URL(ANTHROPIC_FALLBACK);

            // Build upstream path
            let fullPath;
            if (isModelCall) {
                if (isOpenAICompat) {
                    // OpenAI-compatible: always POST to /v1/chat/completions
                    fullPath = '/v1/chat/completions';
                } else if (isBedrock) {
                    // Path built later (need the model ID from the parsed body); placeholder for now.
                    fullPath = '/__bedrock_pending__';
                } else {
                    const base = rtTarget.pathname.replace(/\/$/, '');
                    let overlap = '';
                    for (let i = 1; i <= Math.min(base.length, urlPath.length); i++) {
                        if (base.endsWith(urlPath.substring(0, i))) overlap = urlPath.substring(0, i);
                    }
                    fullPath = overlap ? base + urlPath.substring(overlap.length) : base + urlPath;
                }
            } else {
                fullPath = clientReq.url;
            }

            const reqId = ++reqCount;
            const t0 = Date.now();

            if (isModelCall) {
                console.error(`[MODEL-PROXY] #${reqId} → ${dest.hostname}${fullPath} (${rtMode}${isOpenAICompat ? ', OpenAI-compat' : ''})`);
            }

            let headers = { ...clientReq.headers, host: dest.host };
            delete headers['content-length'];

            if (isModelCall) {
                delete headers['authorization'];
                delete headers['x-api-key'];
                if (isBedrock) {
                    // Bedrock uses Bearer auth with the API key (ABSK...).
                    headers['authorization'] = `Bearer ${rtKey}`;
                } else if (rtUseBearer) {
                    headers['authorization'] = `Bearer ${rtKey}`;
                } else {
                    headers['x-api-key'] = rtKey;
                }

                // Strip Anthropic-specific headers that some backends reject
                if (STRIP_ANTHROPIC_HEADERS.has(rtMode)) {
                    delete headers['anthropic-beta'];
                }

                // OpenAI-compat backends need different content negotiation
                if (isOpenAICompat) {
                    delete headers['anthropic-version'];
                    delete headers['anthropic-beta'];
                    headers['content-type'] = 'application/json';
                    // For streaming, set Accept header
                    headers['accept'] = 'text/event-stream';
                }

                // Bedrock: server replies with AWS Event Stream binary
                if (isBedrock) {
                    delete headers['anthropic-version'];
                    delete headers['anthropic-beta'];
                    headers['content-type'] = 'application/json';
                    headers['accept'] = 'application/vnd.amazon.eventstream';
                }
            }

            const chunks = [];
            clientReq.on('data', c => chunks.push(c));
            clientReq.on('end', () => {
                let body = Buffer.concat(chunks);
                let parsedAnthropicBody = null;
                let targetModel = null;

                // Parse and remap model names
                if (isModelCall) {
                    try {
                        parsedAnthropicBody = JSON.parse(body);
                    } catch { /* pass through */ }
                }

                // Gateway routing: choose the backend from the selected model
                // id (falls back to the first registry model for bootstrap /
                // unmatched calls), then recompute the route for that backend.
                if (gatewayMode && isModelCall && parsedAnthropicBody) {
                    const entry = lookupGatewayModel(gatewayRegistry, parsedAnthropicBody.model) || gatewayRegistry[0];
                    if (entry) {
                        const b = allBackends[entry.backend];
                        rtMode = entry.backend; rtTarget = b.target; rtKey = b.apiKey; rtUseBearer = b.useBearer;
                        parsedAnthropicBody.model = entry.upstreamModel;
                        targetModel = entry.upstreamModel;
                        isOpenAICompat = OPENAI_COMPAT_BACKENDS.has(rtMode);
                        isBedrock = BEDROCK_BACKENDS.has(rtMode);
                        dest = rtTarget;
                        if (isOpenAICompat) {
                            fullPath = '/v1/chat/completions';
                        } else {
                            const base = rtTarget.pathname.replace(/\/$/, '');
                            let overlap = '';
                            for (let i = 1; i <= Math.min(base.length, urlPath.length); i++) {
                                if (base.endsWith(urlPath.substring(0, i))) overlap = urlPath.substring(0, i);
                            }
                            fullPath = overlap ? base + urlPath.substring(overlap.length) : base + urlPath;
                        }
                        headers = { ...clientReq.headers, host: dest.host };
                        delete headers['content-length'];
                        delete headers['authorization'];
                        delete headers['x-api-key'];
                        if (rtUseBearer) headers['authorization'] = `Bearer ${rtKey}`;
                        else headers['x-api-key'] = rtKey;
                        if (STRIP_ANTHROPIC_HEADERS.has(rtMode)) delete headers['anthropic-beta'];
                        if (isOpenAICompat) {
                            delete headers['anthropic-version'];
                            delete headers['anthropic-beta'];
                            headers['content-type'] = 'application/json';
                            headers['accept'] = 'text/event-stream';
                        }
                        console.error(`[MODEL-PROXY] #${reqId} gateway route → ${rtMode}:${entry.upstreamModel} (${dest.hostname})`);
                    }
                }

                if (isModelCall && parsedAnthropicBody && MODEL_REMAP[state.mode]) {
                    const mapped = MODEL_REMAP[state.mode][parsedAnthropicBody.model];
                    if (mapped) {
                        console.error(`[MODEL-PROXY] #${reqId} model remap: ${parsedAnthropicBody.model} → ${mapped}`);
                        parsedAnthropicBody.model = mapped;
                        targetModel = mapped;
                    } else {
                        targetModel = parsedAnthropicBody.model;
                    }
                }

                // Strip thinking blocks before forwarding
                if (isAnthropicMode && MODEL_PATHS.includes(urlPath)) {
                    try {
                        const parsed = parsedAnthropicBody || JSON.parse(body);
                        if (state.hadNonAnthropicSession) {
                            stripAllThinkingBlocks(parsed);
                        } else {
                            stripUnsignedThinkingBlocks(parsed);
                        }
                        body = Buffer.from(JSON.stringify(parsed));
                    } catch { /* pass through */ }
                }
                if (isModelCall && parsedAnthropicBody) {
                    stripAllThinkingBlocks(parsedAnthropicBody);
                }

                // Translate to OpenAI format for OpenAI-compat backends
                if (isOpenAICompat && parsedAnthropicBody) {
                    const openaiBody = anthropicToOpenAI(parsedAnthropicBody, targetModel || parsedAnthropicBody.model);
                    body = Buffer.from(JSON.stringify(openaiBody));
                    console.error(`[MODEL-PROXY] #${reqId} translated Anthropic→OpenAI (stream=${openaiBody.stream})`);
                } else if (isBedrock && parsedAnthropicBody) {
                    // Bedrock rejects any unknown top-level field with "Extra inputs are not permitted".
                    // Claude Code sends fields like context_management, mcp_servers, metadata,
                    // service_tier, etc. that Bedrock doesn't accept. Use a strict whitelist of fields
                    // AWS Bedrock documents as supported (see model-parameters-anthropic-claude-messages-request-response).
                    const modelId = targetModel || parsedAnthropicBody.model;
                    fullPath = `/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`;
                    const BEDROCK_ALLOWED = [
                        'max_tokens', 'system', 'messages',
                        'temperature', 'top_p', 'top_k',
                        'tools', 'tool_choice', 'stop_sequences',
                        'thinking',         // extended thinking (Claude on Bedrock supports it)
                        'output_config',    // effort param (with effort-2025-11-24 beta)
                    ];
                    const bedrockBody = { anthropic_version: 'bedrock-2023-05-31' };
                    for (const k of BEDROCK_ALLOWED) {
                        if (parsedAnthropicBody[k] !== undefined) bedrockBody[k] = parsedAnthropicBody[k];
                    }
                    // 1M context: Bedrock takes the beta in the body (header is stripped),
                    // and only when explicitly wanted. Opt in via CONTEXT_WINDOW_TOKENS>=1000000.
                    // Scoped to Claude Code's 1M-capable set (opus-4-6/7/8, sonnet-4-0/5/6).
                    const wants1M = parseInt(process.env.CONTEXT_WINDOW_TOKENS || '0', 10) >= 1000000;
                    if (wants1M && /claude-(opus-4-[678]|sonnet-4-[056])/.test(modelId.toLowerCase())) {
                        bedrockBody.anthropic_beta = ['context-1m-2025-08-07'];
                    }
                    body = Buffer.from(JSON.stringify(bedrockBody));
                    console.error(`[MODEL-PROXY] #${reqId} → bedrock ${modelId} (${Object.keys(bedrockBody).length} fields)`);
                } else if (isModelCall && parsedAnthropicBody) {
                    body = Buffer.from(JSON.stringify(parsedAnthropicBody));
                }

                const opts = {
                    hostname: dest.hostname,
                    port: dest.port || 443,
                    path: fullPath,
                    method: clientReq.method,
                    headers: { ...headers, 'content-length': body.length },
                    timeout: REQUEST_TIMEOUT_MS,
                };

                const proxyReq = httpsRequest(opts, (proxyRes) => {
                    if (isModelCall) {
                        const ttfb = Date.now() - t0;
                        console.error(`[MODEL-PROXY] #${reqId} TTFB ${ttfb}ms (status ${proxyRes.statusCode})`);
                    }

                    // Log error responses for debugging
                    if (isModelCall && proxyRes.statusCode >= 400) {
                        const errChunks = [];
                        proxyRes.on('data', c => errChunks.push(c));
                        proxyRes.on('end', () => {
                            const errBody = Buffer.concat(errChunks).toString();
                            console.error(`[MODEL-PROXY] #${reqId} ERROR ${proxyRes.statusCode}: ${errBody.substring(0, 500)}`);
                            // Return error as Anthropic-format error
                            const errorResp = {
                                type: 'error',
                                error: {
                                    type: 'api_error',
                                    message: `Upstream ${rtMode} returned ${proxyRes.statusCode}: ${errBody.substring(0, 200)}`,
                                },
                            };
                            clientRes.writeHead(proxyRes.statusCode, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify(errorResp));
                        });
                        return;
                    }

                    const ct = proxyRes.headers['content-type'] || '';
                    const isSSE = ct.includes('text/event-stream');
                    const isAwsEventStream = ct.includes('application/vnd.amazon.eventstream');

                    // ── Bedrock AWS Event Stream → Anthropic SSE ──
                    if (isModelCall && isBedrock && isAwsEventStream) {
                        clientRes.writeHead(proxyRes.statusCode, {
                            'content-type': 'text/event-stream',
                            'cache-control': 'no-cache',
                            'connection': 'keep-alive',
                        });
                        const decoder = new BedrockEventStreamToSSE(
                            (inp, out) => recordUsage(rtMode, inp, out)
                        );
                        proxyRes.pipe(decoder).pipe(clientRes);
                        proxyRes.on('end', () => {
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (Bedrock→SSE)`);
                        });
                        return;
                    }

                    // ── OpenAI-compat streaming → translate back to Anthropic SSE ──
                    if (isModelCall && isOpenAICompat && isSSE) {
                        const anthropicHeaders = fixResponseHeaders(proxyRes.headers, true);
                        clientRes.writeHead(proxyRes.statusCode, anthropicHeaders);
                        const translator = new OpenAIToAnthropicStream(
                            targetModel || parsedAnthropicBody?.model,
                            (inp, out) => recordUsage(rtMode, inp, out)
                        );
                        proxyRes.pipe(translator).pipe(clientRes);
                        proxyRes.on('end', () => {
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (OpenAI→Anthropic SSE, ${translator._inputTokens}in/${translator._outputTokens}out)`);
                        });
                        return;
                    }

                    // ── OpenAI-compat JSON → translate back to Anthropic JSON ──
                    if (isModelCall && isOpenAICompat && ct.includes('application/json')) {
                        const respChunks = [];
                        proxyRes.on('data', c => respChunks.push(c));
                        proxyRes.on('end', () => {
                            const raw = Buffer.concat(respChunks);
                            try {
                                const openaiResp = JSON.parse(raw);
                                const anthropicResp = openAIToAnthropic(openaiResp, targetModel || parsedAnthropicBody?.model);
                                recordUsage(rtMode, anthropicResp.usage.input_tokens, anthropicResp.usage.output_tokens);
                                const fixed = Buffer.from(JSON.stringify(anthropicResp));
                                const outHeaders = fixResponseHeaders(proxyRes.headers, false);
                                outHeaders['content-length'] = fixed.length;
                                clientRes.writeHead(proxyRes.statusCode, outHeaders);
                                clientRes.end(fixed);
                                console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (OpenAI→Anthropic JSON)`);
                            } catch (e) {
                                console.error(`[MODEL-PROXY] #${reqId} translation error: ${e.message}`);
                                clientRes.writeHead(502, { 'content-type': 'application/json' });
                                clientRes.end(JSON.stringify({ error: { message: 'Translation error' } }));
                            }
                        });
                        return;
                    }

                    // ── Native Anthropic SSE (DeepSeek, Kimi, OpenRouter) ──
                    if (isModelCall && isSSE) {
                        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                        const norm = new UsageNormalizer((inp, out) => recordUsage(rtMode, inp, out));
                        proxyRes.pipe(norm).pipe(clientRes);
                        proxyRes.on('end', () => {
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${norm._inputTokens}in/${norm._outputTokens}out)`);
                        });
                    } else if (isModelCall && ct.includes('application/json')) {
                        const respChunks = [];
                        proxyRes.on('data', c => respChunks.push(c));
                        proxyRes.on('end', () => {
                            const raw = Buffer.concat(respChunks);
                            const fixed = normalizeJsonBody(raw);
                            try {
                                const j = JSON.parse(fixed);
                                if (j.usage) recordUsage(rtMode, j.usage.input_tokens, j.usage.output_tokens);
                            } catch {}
                            const outHeaders = { ...proxyRes.headers, 'content-length': fixed.length };
                            clientRes.writeHead(proxyRes.statusCode, outHeaders);
                            clientRes.end(fixed);
                            console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s (json, ${fixed.length}b)`);
                        });
                    } else {
                        // Non-model or unknown content-type: pass through
                        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                        proxyRes.pipe(clientRes);
                        if (isModelCall) {
                            proxyRes.on('end', () => {
                                console.error(`[MODEL-PROXY] #${reqId} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                            });
                        }
                    }
                });

                proxyReq.on('timeout', () => {
                    console.error(`[MODEL-PROXY] #${reqId} TIMEOUT after ${REQUEST_TIMEOUT_MS / 1000}s`);
                    proxyReq.destroy(new Error('Request timeout'));
                });

                proxyReq.on('error', (err) => {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                    console.error(`[MODEL-PROXY] #${reqId} ERROR after ${elapsed}s: ${err.message}`);
                    if (!clientRes.headersSent) {
                        clientRes.writeHead(502, { 'content-type': 'application/json' });
                    }
                    clientRes.end(JSON.stringify({ error: { message: 'Upstream connection error' } }));
                });

                proxyReq.end(body);
            });
        });

        function tryListen(port) {
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE' && port < startPort + 20) {
                    tryListen(port + 1);
                } else {
                    reject(err);
                }
            });
            server.listen(port, '127.0.0.1', () => {
                const actualPort = server.address().port;
                console.error(`[MODEL-PROXY] Listening on 127.0.0.1:${actualPort} → ${targetUrl} (mode: ${state.mode})`);
                resolve({ port: actualPort, close: () => server.close(), switchMode });
            });
        }

        tryListen(startPort);
    });
}
