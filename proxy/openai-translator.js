/**
 * openai-translator.js
 * =====================
 * Bidirectional translator between Anthropic Messages API format
 * and OpenAI Chat Completions API format.
 *
 * Claude Code speaks Anthropic protocol. OpenAI-compatible providers
 * (Nvidia, Doubleword, etc.) speak OpenAI protocol. This module sits
 * in the proxy and translates:
 *
 *   Anthropic Request  →  OpenAI Request   (outbound)
 *   OpenAI Response    →  Anthropic Response (inbound)
 *   OpenAI SSE Stream  →  Anthropic SSE Stream (inbound streaming)
 */

import { Transform } from 'stream';

// ─────────────────────────────────────────────────────────────────
// REQUEST: Anthropic → OpenAI
// ─────────────────────────────────────────────────────────────────

/**
 * Convert an Anthropic Messages API request body to an OpenAI
 * Chat Completions request body.
 */
export function anthropicToOpenAI(body, targetModel) {
    const messages = [];

    // System prompt → OpenAI system message
    if (body.system) {
        if (typeof body.system === 'string') {
            messages.push({ role: 'system', content: body.system });
        } else if (Array.isArray(body.system)) {
            // Anthropic allows system as array of content blocks
            const text = body.system
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');
            if (text) messages.push({ role: 'system', content: text });
        }
    }

    // Convert each Anthropic message
    for (const msg of (body.messages || [])) {
        const converted = convertAnthropicMessage(msg);
        if (converted) {
            if (Array.isArray(converted)) {
                messages.push(...converted);
            } else {
                messages.push(converted);
            }
        }
    }

    const result = {
        model: targetModel || body.model,
        messages,
        stream: body.stream !== false,  // default to streaming
    };

    // Max tokens
    if (body.max_tokens) {
        result.max_tokens = body.max_tokens;
    }

    // Temperature
    if (body.temperature !== undefined) {
        result.temperature = body.temperature;
    }

    // Top-p
    if (body.top_p !== undefined) {
        result.top_p = body.top_p;
    }

    // Stop sequences
    if (body.stop_sequences && body.stop_sequences.length > 0) {
        result.stop = body.stop_sequences;
    }

    // Tools → OpenAI function calling format
    if (body.tools && body.tools.length > 0) {
        result.tools = body.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.input_schema || { type: 'object', properties: {} },
            },
        }));
        // tool_choice
        if (body.tool_choice) {
            if (body.tool_choice.type === 'auto') {
                result.tool_choice = 'auto';
            } else if (body.tool_choice.type === 'any') {
                result.tool_choice = 'required';
            } else if (body.tool_choice.type === 'tool') {
                result.tool_choice = {
                    type: 'function',
                    function: { name: body.tool_choice.name },
                };
            }
        }
    }

    // Stream options for usage in streaming mode
    if (result.stream) {
        result.stream_options = { include_usage: true };
    }

    return result;
}

/**
 * Convert a single Anthropic message to OpenAI message(s).
 */
function convertAnthropicMessage(msg) {
    if (msg.role === 'user') {
        return convertUserMessage(msg);
    }
    if (msg.role === 'assistant') {
        return convertAssistantMessage(msg);
    }
    return null;
}

function convertUserMessage(msg) {
    // Simple string content
    if (typeof msg.content === 'string') {
        return { role: 'user', content: msg.content };
    }

    // Array of content blocks
    if (Array.isArray(msg.content)) {
        // Check for tool_result blocks (these become separate messages in OpenAI)
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

        const results = [];

        // Non-tool blocks become a user message
        if (otherBlocks.length > 0) {
            const parts = [];
            for (const block of otherBlocks) {
                if (block.type === 'text') {
                    parts.push({ type: 'text', text: block.text });
                } else if (block.type === 'image') {
                    // Anthropic image → OpenAI image_url
                    if (block.source?.type === 'base64') {
                        parts.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${block.source.media_type};base64,${block.source.data}`,
                            },
                        });
                    } else if (block.source?.type === 'url') {
                        parts.push({
                            type: 'image_url',
                            image_url: { url: block.source.url },
                        });
                    }
                }
            }
            if (parts.length === 1 && parts[0].type === 'text') {
                results.push({ role: 'user', content: parts[0].text });
            } else if (parts.length > 0) {
                results.push({ role: 'user', content: parts });
            }
        }

        // Tool results become tool messages
        for (const tr of toolResults) {
            let content = '';
            if (typeof tr.content === 'string') {
                content = tr.content;
            } else if (Array.isArray(tr.content)) {
                content = tr.content
                    .filter(b => b.type === 'text')
                    .map(b => b.text)
                    .join('\n');
            }
            results.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id,
                content: content || '',
            });
        }

        return results.length === 1 ? results[0] : results;
    }

    return { role: 'user', content: String(msg.content) };
}

function convertAssistantMessage(msg) {
    if (typeof msg.content === 'string') {
        return { role: 'assistant', content: msg.content };
    }

    if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolCalls = [];

        for (const block of msg.content) {
            if (block.type === 'text') {
                textParts.push(block.text);
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: typeof block.input === 'string'
                            ? block.input
                            : JSON.stringify(block.input),
                    },
                });
            }
            // Skip 'thinking' blocks — already stripped by the proxy
        }

        const result = { role: 'assistant' };
        if (textParts.length > 0) {
            result.content = textParts.join('');
        } else {
            result.content = null;
        }
        if (toolCalls.length > 0) {
            result.tool_calls = toolCalls;
        }
        return result;
    }

    return { role: 'assistant', content: String(msg.content) };
}


// ─────────────────────────────────────────────────────────────────
// RESPONSE: OpenAI → Anthropic (non-streaming)
// ─────────────────────────────────────────────────────────────────

/**
 * Convert an OpenAI Chat Completions response to an Anthropic
 * Messages API response.
 */
export function openAIToAnthropic(openaiResp, requestModel) {
    const choice = openaiResp.choices?.[0];
    if (!choice) {
        return {
            id: openaiResp.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: requestModel || openaiResp.model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: openaiResp.usage?.prompt_tokens || 0,
                output_tokens: openaiResp.usage?.completion_tokens || 0,
            },
        };
    }

    const content = [];
    const message = choice.message;

    // Text content
    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }

    // Tool calls → Anthropic tool_use blocks
    if (message.tool_calls) {
        for (const tc of message.tool_calls) {
            let input;
            try {
                input = JSON.parse(tc.function.arguments);
            } catch {
                input = { raw: tc.function.arguments };
            }
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input,
            });
        }
    }

    // If no content at all, add empty text
    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    // Map finish_reason to stop_reason
    let stopReason = 'end_turn';
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
        stopReason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
        stopReason = 'max_tokens';
    } else if (choice.finish_reason === 'stop') {
        stopReason = 'end_turn';
    }

    return {
        id: openaiResp.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content,
        model: requestModel || openaiResp.model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
    };
}


// ─────────────────────────────────────────────────────────────────
// STREAMING: OpenAI SSE → Anthropic SSE
// ─────────────────────────────────────────────────────────────────

/**
 * Transform stream that converts OpenAI streaming SSE chunks
 * into Anthropic streaming SSE events.
 *
 * OpenAI emits: data: {"choices":[{"delta":{"content":"..."}}]}
 * Anthropic expects:
 *   event: message_start       → {type:"message_start", message:{...}}
 *   event: content_block_start → {type:"content_block_start", index:0, content_block:{type:"text",text:""}}
 *   event: content_block_delta → {type:"content_block_delta", index:0, delta:{type:"text_delta",text:"..."}}
 *   event: content_block_stop  → {type:"content_block_stop", index:0}
 *   event: message_delta       → {type:"message_delta", delta:{stop_reason:"end_turn"}, usage:{output_tokens:N}}
 *   event: message_stop        → {type:"message_stop"}
 */
export class OpenAIToAnthropicStream extends Transform {
    constructor(requestModel, onUsage) {
        super();
        this._buf = '';
        this._requestModel = requestModel;
        this._onUsage = onUsage;
        this._started = false;
        this._currentBlockIndex = -1;
        this._currentBlockType = null;  // 'text' or 'tool_use'
        this._inputTokens = 0;
        this._outputTokens = 0;
        this._toolCallBuffers = {};     // id → {id, name, arguments}
        this._textStarted = false;
        this._messageId = `msg_${Date.now()}`;
    }

    _transform(chunk, _enc, cb) {
        this._buf += chunk.toString();
        const parts = this._buf.split('\n');
        // Keep the last incomplete line in the buffer
        this._buf = parts.pop();

        for (const line of parts) {
            this._processLine(line.trim());
        }
        cb();
    }

    _flush(cb) {
        // Process any remaining data
        if (this._buf.trim()) {
            this._processLine(this._buf.trim());
        }

        // Close any open blocks
        if (this._currentBlockIndex >= 0) {
            this._emitEvent('content_block_stop', { type: 'content_block_stop', index: this._currentBlockIndex });
        }

        // Emit message_delta and message_stop if we started
        if (this._started) {
            this._emitEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: this._outputTokens },
            });
            this._emitEvent('message_stop', { type: 'message_stop' });
        }

        if (this._onUsage) {
            this._onUsage(this._inputTokens, this._outputTokens);
        }
        cb();
    }

    _processLine(line) {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6);
        if (data === '[DONE]') {
            // Stream finished — handled in _flush
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            return; // Not valid JSON
        }

        // Emit message_start on first chunk
        if (!this._started) {
            this._started = true;
            this._emitEvent('message_start', {
                type: 'message_start',
                message: {
                    id: parsed.id || this._messageId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: this._requestModel || parsed.model || 'unknown',
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            });
        }

        // Track usage from stream_options
        if (parsed.usage) {
            this._inputTokens = parsed.usage.prompt_tokens || this._inputTokens;
            this._outputTokens = parsed.usage.completion_tokens || this._outputTokens;
        }

        const choice = parsed.choices?.[0];
        if (!choice) return;

        const delta = choice.delta || {};
        const finishReason = choice.finish_reason;

        // Handle text content
        if (delta.content !== undefined && delta.content !== null) {
            if (!this._textStarted) {
                this._textStarted = true;
                this._currentBlockIndex++;
                this._currentBlockType = 'text';
                this._emitEvent('content_block_start', {
                    type: 'content_block_start',
                    index: this._currentBlockIndex,
                    content_block: { type: 'text', text: '' },
                });
            }
            if (delta.content) {
                this._emitEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: this._currentBlockIndex,
                    delta: { type: 'text_delta', text: delta.content },
                });
            }
        }

        // Handle tool calls
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                const tcIndex = tc.index !== undefined ? tc.index : 0;
                const tcKey = `tc_${tcIndex}`;

                if (!this._toolCallBuffers[tcKey]) {
                    // Close any previous block
                    if (this._currentBlockIndex >= 0 && this._currentBlockType !== null) {
                        this._emitEvent('content_block_stop', {
                            type: 'content_block_stop',
                            index: this._currentBlockIndex,
                        });
                    }

                    // New tool call
                    this._currentBlockIndex++;
                    this._currentBlockType = 'tool_use';
                    this._toolCallBuffers[tcKey] = {
                        id: tc.id || `toolu_${Date.now()}_${tcIndex}`,
                        name: tc.function?.name || '',
                        arguments: '',
                        blockIndex: this._currentBlockIndex,
                    };

                    this._emitEvent('content_block_start', {
                        type: 'content_block_start',
                        index: this._currentBlockIndex,
                        content_block: {
                            type: 'tool_use',
                            id: this._toolCallBuffers[tcKey].id,
                            name: this._toolCallBuffers[tcKey].name,
                            input: {},
                        },
                    });
                }

                // Accumulate tool call arguments
                if (tc.function?.arguments) {
                    this._toolCallBuffers[tcKey].arguments += tc.function.arguments;
                    this._emitEvent('content_block_delta', {
                        type: 'content_block_delta',
                        index: this._toolCallBuffers[tcKey].blockIndex,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: tc.function.arguments,
                        },
                    });
                }

                // Update name if provided
                if (tc.function?.name) {
                    this._toolCallBuffers[tcKey].name = tc.function.name;
                }
            }
        }

        // Handle finish_reason
        if (finishReason) {
            // Close open block
            if (this._currentBlockIndex >= 0) {
                this._emitEvent('content_block_stop', {
                    type: 'content_block_stop',
                    index: this._currentBlockIndex,
                });
                this._currentBlockType = null;
            }

            // Map finish reason
            let stopReason = 'end_turn';
            if (finishReason === 'tool_calls' || finishReason === 'function_call') {
                stopReason = 'tool_use';
            } else if (finishReason === 'length') {
                stopReason = 'max_tokens';
            }

            this._emitEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: this._outputTokens },
            });
            this._emitEvent('message_stop', { type: 'message_stop' });
            this._started = false; // Prevent _flush from double-emitting
        }
    }

    _emitEvent(eventType, data) {
        this.push(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    }
}


// ─────────────────────────────────────────────────────────────────
// RESPONSE HEADERS: Fix content-type for translated responses
// ─────────────────────────────────────────────────────────────────

/**
 * Fix upstream response headers for Anthropic format.
 * OpenAI returns application/json or text/event-stream;
 * Claude Code expects the same content types.
 */
export function fixResponseHeaders(headers, isStreaming) {
    const fixed = { ...headers };
    if (isStreaming) {
        fixed['content-type'] = 'text/event-stream';
    } else {
        fixed['content-type'] = 'application/json';
    }
    // Remove transfer-encoding since we may modify content
    delete fixed['content-length'];
    delete fixed['transfer-encoding'];
    return fixed;
}
