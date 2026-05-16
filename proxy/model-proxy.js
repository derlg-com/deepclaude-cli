import { createServer, request as httpRequest } from 'http';
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
};

const PRICING_PER_M = {
    deepseek:   { input: 0.44,  output: 0.87 },
    openrouter: { input: 0.44,  output: 0.87 },
    fireworks:  { input: 1.74,  output: 3.48 },
    nvidia:     { input: 0.44,  output: 0.87 },
    kimi:       { input: 0.00,  output: 0.00 },  // subscription-based
    kiro:       { input: 0.00,  output: 0.00 },  // subscription-based
    doubleword: { input: 0.44,  output: 0.87 },
    anthropic:  { input: 3.00,  output: 15.00 },
    _single:    { input: 0.44,  output: 0.87 },
};

/**
 * Backends that use OpenAI Chat Completions format instead of Anthropic
 * Messages format. These require full request/response translation.
 */
const OPENAI_COMPAT_BACKENDS = new Set(['nvidia', 'doubleword']);

// Backends that route to a local HTTP gateway (no TLS, no auth header injection)
const LOCAL_HTTP_BACKENDS = new Set(['kiro']);

/**
 * Backends that need anthropic-beta and other Anthropic-specific headers
 * stripped (they reject unknown headers).
 */
const STRIP_ANTHROPIC_HEADERS = new Set(['kimi', 'nvidia', 'doubleword']);

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
        // Also remove reasoning_content field from tool-call messages (kimi rejects it)
        for (const block of msg.content) {
            if (block.reasoning_content !== undefined) delete block.reasoning_content;
        }
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

        const state = {
            mode: initialName || '_single',
            target: startBackend ? startBackend.target : initialTarget,
            apiKey: startBackend ? startBackend.apiKey : apiKey,
            useBearer: startBackend ? startBackend.useBearer : initialBearer,
            hadNonAnthropicSession: !!startBackend,
            modelOverride: null,
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
                        model_override: state.modelOverride || null,
                        available_backends: ['anthropic', ...Object.keys(allBackends)],
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
                if (urlPath === '/_proxy/model' && clientReq.method === 'POST') {
                    const chunks = [];
                    clientReq.on('data', c => chunks.push(c));
                    clientReq.on('end', () => {
                        const body = Buffer.concat(chunks).toString();
                        const m = body.match(/model=([^&]*)/);
                        const model = m ? decodeURIComponent(m[1]).trim() : '';
                        state.modelOverride = model || null;
                        const msg = model ? `Model override set: ${model}` : 'Model override cleared';
                        console.error(`[MODEL-PROXY] ${msg}`);
                        clientRes.writeHead(200, { 'content-type': 'application/json' });
                        clientRes.end(JSON.stringify({ model_override: state.modelOverride }));
                    });
                    return;
                }
                clientRes.writeHead(404, { 'content-type': 'application/json' });
                clientRes.end(JSON.stringify({ error: 'Not found' }));
                return;
            }

            // In anthropic mode, everything passes through transparently
            const isAnthropicMode = state.mode === 'anthropic';
            const isModelCall = !isAnthropicMode && MODEL_PATHS.includes(urlPath);
            const isOpenAICompat = isModelCall && OPENAI_COMPAT_BACKENDS.has(state.mode);
            const dest = isModelCall ? state.target : new URL(ANTHROPIC_FALLBACK);

            // Build upstream path
            let fullPath;
            if (isModelCall) {
                if (isOpenAICompat) {
                    // OpenAI-compatible: always POST to /v1/chat/completions
                    fullPath = '/v1/chat/completions';
                } else {
                    const base = state.target.pathname.replace(/\/$/, '');
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
                console.error(`[MODEL-PROXY] #${reqId} → ${dest.hostname}${fullPath} (${state.mode}${isOpenAICompat ? ', OpenAI-compat' : ''})`);
            }

            const headers = { ...clientReq.headers, host: dest.host };
            delete headers['content-length'];

            if (isModelCall) {
                delete headers['authorization'];
                delete headers['x-api-key'];
                if (LOCAL_HTTP_BACKENDS.has(state.mode)) {
                    // kiro: kirocc manages its own auth — don't inject any auth header
                } else if (state.useBearer) {
                    headers['authorization'] = `Bearer ${state.apiKey}`;
                } else {
                    headers['x-api-key'] = state.apiKey;
                }

                // Strip Anthropic-specific headers that some backends reject
                if (STRIP_ANTHROPIC_HEADERS.has(state.mode)) {
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

                if (isModelCall && parsedAnthropicBody && state.modelOverride) {
                    console.error(`[MODEL-PROXY] #${reqId} model override: ${parsedAnthropicBody.model} → ${state.modelOverride}`);
                    parsedAnthropicBody.model = state.modelOverride;
                    targetModel = state.modelOverride;
                } else if (isModelCall && parsedAnthropicBody && MODEL_REMAP[state.mode]) {
                    const mapped = MODEL_REMAP[state.mode][parsedAnthropicBody.model];
                    if (mapped) {
                        console.error(`[MODEL-PROXY] #${reqId} model remap: ${parsedAnthropicBody.model} → ${mapped}`);
                        parsedAnthropicBody.model = mapped;
                        targetModel = mapped;
                    } else {
                        targetModel = parsedAnthropicBody.model;
                    }
                }

                // Non-kiro backends don't support thinking — strip the top-level
                // "thinking" param so providers like kimi don't expect reasoning_content.
                if (isModelCall && parsedAnthropicBody && !LOCAL_HTTP_BACKENDS.has(state.mode)) {
                    delete parsedAnthropicBody.thinking;
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
                } else if (isModelCall && parsedAnthropicBody) {
                    body = Buffer.from(JSON.stringify(parsedAnthropicBody));
                }

                const isLocalBackend = LOCAL_HTTP_BACKENDS.has(state.mode);
                const opts = {
                    hostname: dest.hostname,
                    port: dest.port || (isLocalBackend ? 80 : 443),
                    path: fullPath,
                    method: clientReq.method,
                    headers: { ...headers, 'content-length': body.length },
                    timeout: REQUEST_TIMEOUT_MS,
                };

                const makeRequest = isLocalBackend ? httpRequest : httpsRequest;
                const proxyReq = makeRequest(opts, (proxyRes) => {
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
                                    message: `Upstream ${state.mode} returned ${proxyRes.statusCode}: ${errBody.substring(0, 200)}`,
                                },
                            };
                            clientRes.writeHead(proxyRes.statusCode, { 'content-type': 'application/json' });
                            clientRes.end(JSON.stringify(errorResp));
                        });
                        return;
                    }

                    const ct = proxyRes.headers['content-type'] || '';
                    const isSSE = ct.includes('text/event-stream');

                    // ── OpenAI-compat streaming → translate back to Anthropic SSE ──
                    if (isModelCall && isOpenAICompat && isSSE) {
                        const anthropicHeaders = fixResponseHeaders(proxyRes.headers, true);
                        clientRes.writeHead(proxyRes.statusCode, anthropicHeaders);
                        const translator = new OpenAIToAnthropicStream(
                            targetModel || parsedAnthropicBody?.model,
                            (inp, out) => recordUsage(state.mode, inp, out)
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
                                recordUsage(state.mode, anthropicResp.usage.input_tokens, anthropicResp.usage.output_tokens);
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
                        const norm = new UsageNormalizer((inp, out) => recordUsage(state.mode, inp, out));
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
                                if (j.usage) recordUsage(state.mode, j.usage.input_tokens, j.usage.output_tokens);
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
