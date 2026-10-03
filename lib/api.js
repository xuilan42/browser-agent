/**
 * Клиенты внешнего LLM API.
 *
 * Провайдеры:
 * - openai-compatible — OpenAI / OpenRouter / Ollama / LM Studio / vLLM
 * - anthropic — Anthropic Messages API
 */

export class ApiError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

/**
 * @typedef {Object} ChatMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} [provider]
 * @property {string} apiBaseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {number} [temperature]
 * @property {number} [topP]
 * @property {number} [maxTokens]
 * @property {boolean} [stream]
 * @property {number} [timeoutMs]
 * @property {string} [customHeaders] JSON string
 */

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function parseCustomHeaders(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('customHeaders должен быть JSON-объектом');
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      out[k] = String(v);
    }
    return out;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(`Некорректные custom headers: ${err.message || err}`);
  }
}

function buildHeaders(config, extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...parseCustomHeaders(config.customHeaders),
    ...extra,
  };
  return headers;
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal, cleanup: () => {} };
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    ctrl.abort(new DOMException('Превышено время ожидания API', 'TimeoutError'));
  }, timeoutMs);

  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function parseErrorMessage(status, body) {
  try {
    const json = JSON.parse(body);
    const msg =
      json?.error?.message ||
      json?.message ||
      json?.error?.type ||
      (typeof json?.error === 'string' ? json.error : null) ||
      body;
    return `API ${status}: ${msg}`;
  } catch {
    return `API ${status}: ${body || 'ошибка запроса'}`;
  }
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.text) return part.text;
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

/** OpenAI-compatible chat + models */
export class OpenAICompatibleProvider {
  /** @param {ProviderConfig} config */
  constructor(config) {
    this.config = config;
  }

  get base() {
    return normalizeBaseUrl(this.config.apiBaseUrl);
  }

  get chatEndpoint() {
    return `${this.base}/chat/completions`;
  }

  get modelsEndpoint() {
    return `${this.base}/models`;
  }

  authHeaders() {
    const headers = buildHeaders(this.config);
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    // OpenRouter рекомендует эти заголовки
    if (this.base.includes('openrouter.ai')) {
      if (!headers['HTTP-Referer']) headers['HTTP-Referer'] = 'https://browser-agent.local';
      if (!headers['X-Title']) headers['X-Title'] = 'Browser Agent';
    }
    return headers;
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {{ signal?: AbortSignal, onDelta?: (chunk: string) => void, tools?: object[], toolChoice?: any }} [opts]
   */
  async chat(messages, opts = {}) {
    const result = await this.chatTurn(messages, opts);
    return result.content || '';
  }

  /**
   * Полный ход: текст и/или tool_calls.
   */
  async chatTurn(messages, opts = {}) {
    const { onDelta, tools, toolChoice } = opts;
    const wantStream = Boolean(this.config.stream && onDelta && !tools?.length);
    const { signal, cleanup } = withTimeout(opts.signal, this.config.timeoutMs ?? 120000);

    const body = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0.7,
      top_p: this.config.topP ?? 1,
      max_tokens: this.config.maxTokens ?? 1024,
      stream: wantStream,
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice || 'auto';
    }

    const send = () =>
      fetch(this.chatEndpoint, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(body),
        signal,
      });

    try {
      // Новые модели OpenAI (o-серия, gpt-5) не принимают max_tokens
      if (this.useMaxCompletionTokens) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
      let res = await send();
      if (!res.ok && res.status === 400 && body.max_tokens != null) {
        const errBody = await res.clone().text().catch(() => '');
        if (/max_completion_tokens/.test(errBody)) {
          this.useMaxCompletionTokens = true;
          body.max_completion_tokens = body.max_tokens;
          delete body.max_tokens;
          res = await send();
        }
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new ApiError(enrichApiError(res.status, errBody, this.config), {
          status: res.status,
          body: errBody,
          code:
            [400, 404, 422].includes(res.status) && /tool/i.test(errBody)
              ? 'tools_unsupported'
              : undefined,
        });
      }

      if (wantStream) {
        const content = await readOpenAiSseStream(res, onDelta, signal);
        return { content, tool_calls: [], finish_reason: 'stop' };
      }

      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      const content = extractTextContent(msg.content) || '';
      const tool_calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const finish_reason = data?.choices?.[0]?.finish_reason || '';
      if (!content && !tool_calls.length) {
        throw new ApiError('Пустой ответ API', { status: res.status, body: data });
      }
      return { content, tool_calls, finish_reason };
    } finally {
      cleanup();
    }
  }

  async listModels(signal) {
    const { signal: s, cleanup } = withTimeout(signal, this.config.timeoutMs ?? 30000);
    try {
      const res = await fetch(this.modelsEndpoint, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: s,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new ApiError(enrichApiError(res.status, errBody, this.config), {
          status: res.status,
          body: errBody,
        });
      }
      const data = await res.json();
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      return list
        .map((m) => m?.id || m?.name || '')
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    } finally {
      cleanup();
    }
  }

  async testConnection(signal) {
    return this.chat(
      [
        { role: 'system', content: 'Reply with OK only.' },
        { role: 'user', content: 'ping' },
      ],
      { signal }
    );
  }
}

/** Anthropic Messages API */
export class AnthropicProvider {
  /** @param {ProviderConfig} config */
  constructor(config) {
    this.config = config;
  }

  get messagesEndpoint() {
    const raw = normalizeBaseUrl(this.config.apiBaseUrl) || 'https://api.anthropic.com';
    if (raw.endsWith('/messages')) return raw;
    if (raw.endsWith('/v1')) return `${raw}/messages`;
    return `${raw}/v1/messages`;
  }

  authHeaders(stream) {
    const headers = buildHeaders(this.config, {
      'anthropic-version': '2023-06-01',
    });
    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }
    if (stream) {
      headers.accept = 'text/event-stream';
    }
    return headers;
  }

  splitMessages(messages) {
    let system = '';
    /** @type {{ role: string, content: any }[]} */
    const rest = [];
    for (const m of messages) {
      if (m.role === 'system') {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        system = system ? `${system}\n\n${text}` : text;
      } else {
        rest.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        });
      }
    }
    /** @type {{ role: string, content: any }[]} */
    const merged = [];
    for (const m of rest) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') {
        last.content += `\n\n${m.content}`;
      } else {
        merged.push({ ...m });
      }
    }
    if (merged.length && merged[0].role !== 'user') {
      merged.unshift({ role: 'user', content: '(continue)' });
    }
    return { system, messages: merged };
  }

  /**
   * @param {ChatMessage[]} messages
   * @param {{ signal?: AbortSignal, onDelta?: (chunk: string) => void }} [opts]
   */
  async chat(messages, opts = {}) {
    const { onDelta } = opts;
    const stream = Boolean(this.config.stream && onDelta);
    const { signal, cleanup } = withTimeout(opts.signal, this.config.timeoutMs ?? 120000);
    const { system, messages: msgs } = this.splitMessages(messages);

    const body = {
      model: this.config.model,
      max_tokens: this.config.maxTokens ?? 1024,
      messages: msgs,
      stream,
    };
    // Новые модели Claude не принимают temperature и top_p одновременно
    const topP = this.config.topP ?? 1;
    if (topP < 1) body.top_p = topP;
    else body.temperature = this.config.temperature ?? 0.7;
    if (system) body.system = system;

    try {
      const res = await fetch(this.messagesEndpoint, {
        method: 'POST',
        headers: this.authHeaders(stream),
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new ApiError(parseErrorMessage(res.status, errBody), {
          status: res.status,
          body: errBody,
        });
      }

      if (stream) {
        return readAnthropicSseStream(res, onDelta, signal);
      }

      const data = await res.json();
      const text = extractTextContent(data?.content);
      if (!text) {
        throw new ApiError('Пустой ответ API', { status: res.status, body: data });
      }
      return text;
    } finally {
      cleanup();
    }
  }

  async listModels() {
    return [
      'claude-3-5-haiku-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-7-sonnet-latest',
      'claude-sonnet-4-0',
      'claude-opus-4-0',
    ];
  }

  async testConnection(signal) {
    return this.chat(
      [
        { role: 'system', content: 'Reply with OK only.' },
        { role: 'user', content: 'ping' },
      ],
      { signal }
    );
  }
}

/**
 * @param {ProviderConfig} settings
 */
export function createProvider(settings) {
  const provider = settings.provider || 'openai-compatible';
  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(settings);
    case 'openai-compatible':
    default:
      return new OpenAICompatibleProvider(settings);
  }
}

export function validateApiSettings(settings) {
  const errors = [];
  if (!settings.apiBaseUrl?.trim()) errors.push('Укажите API Base URL');
  if (!settings.model?.trim()) errors.push('Укажите модель');
  if (!settings.apiKey?.trim() && !isLocalHost(settings.apiBaseUrl)) {
    errors.push('Укажите API Key (для localhost можно пустым)');
  }
  if (settings.customHeaders?.trim()) {
    try {
      parseCustomHeaders(settings.customHeaders);
    } catch (e) {
      errors.push(e.message || 'Некорректные custom headers');
    }
  }

  const mismatch = detectKeyEndpointMismatch(settings);
  if (mismatch) errors.push(mismatch);

  return errors;
}

/**
 * Ловит частые ошибки: OpenRouter-ключ на api.openai.com и наоборот.
 */
export function detectKeyEndpointMismatch(settings) {
  const key = String(settings.apiKey || '').trim();
  const base = normalizeBaseUrl(settings.apiBaseUrl).toLowerCase();
  if (!key || !base) return null;

  const isOpenRouterKey = key.startsWith('sk-or-');
  const isAnthropicKey = key.startsWith('sk-ant-');
  const hitsOpenAI = base.includes('api.openai.com');
  const hitsOpenRouter = base.includes('openrouter.ai');
  const provider = settings.provider || 'openai-compatible';

  if (isOpenRouterKey && hitsOpenAI) {
    return (
      'Ключ OpenRouter (sk-or-…) нельзя слать на api.openai.com. ' +
      'Поставь Base URL: https://openrouter.ai/api/v1 (пресет OpenRouter) и сохрани.'
    );
  }

  if (isOpenRouterKey && !hitsOpenRouter && provider === 'openai-compatible' && !isLocalHost(settings.apiBaseUrl)) {
    return (
      'Похоже на ключ OpenRouter — Base URL должен быть https://openrouter.ai/api/v1'
    );
  }

  if (!isOpenRouterKey && key.startsWith('sk-') && !isAnthropicKey && hitsOpenRouter) {
    return (
      'На OpenRouter нужен ключ sk-or-… с https://openrouter.ai/keys ' +
      '(обычный OpenAI sk-… там не подойдёт).'
    );
  }

  if (isAnthropicKey && (hitsOpenAI || hitsOpenRouter)) {
    return (
      'Ключ Anthropic (sk-ant-…): выбери провайдер Anthropic и Base URL https://api.anthropic.com'
    );
  }

  if (isAnthropicKey && provider !== 'anthropic') {
    return 'Ключ Anthropic: в настройках выбери провайдер «Anthropic».';
  }

  if (!isAnthropicKey && provider === 'anthropic' && (hitsOpenAI || hitsOpenRouter)) {
    return 'Для провайдера Anthropic укажи Base URL https://api.anthropic.com и ключ sk-ant-…';
  }

  return null;
}

function enrichApiError(status, body, config) {
  let msg = parseErrorMessage(status, body);
  if (status === 401) {
    const hint = detectKeyEndpointMismatch(config);
    if (hint) msg = `${msg}\n\nПодсказка: ${hint}`;
    else if (String(config.apiKey || '').startsWith('sk-or-')) {
      msg +=
        '\n\nПодсказка: ключ OpenRouter → Base URL https://openrouter.ai/api/v1, модель вида openai/gpt-4o-mini';
    }
  }
  return msg;
}

function isLocalHost(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
  } catch {
    return false;
  }
}

async function readOpenAiSseStream(res, onDelta, signal) {
  if (!res.body) throw new ApiError('Стриминг недоступен: пустое тело ответа');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException('Aborted', 'AbortError');
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta;
        const piece =
          extractTextContent(delta?.content) ||
          (typeof delta?.content === 'string' ? delta.content : '');
        if (piece) {
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* ignore malformed chunk */
      }
    }
  }

  if (!full) throw new ApiError('Пустой поток ответа API');
  return full;
}

async function readAnthropicSseStream(res, onDelta, signal) {
  if (!res.body) throw new ApiError('Стриминг недоступен: пустое тело ответа');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException('Aborted', 'AbortError');
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() || '';

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;

      try {
        const json = JSON.parse(payload);
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          const piece = json.delta.text || '';
          if (piece) {
            full += piece;
            onDelta(piece);
          }
        } else if (json.type === 'content_block_delta' && json.delta?.text) {
          const piece = json.delta.text;
          full += piece;
          onDelta(piece);
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!full) throw new ApiError('Пустой поток ответа API');
  return full;
}
