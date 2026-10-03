/**
 * Оркестрация агента: контекст страницы + скриншот + действия + веб-поиск + LLM.
 *
 * Цикл: смотрим (снимок + скриншот с ref-метками) → действуем → снова смотрим
 * и проверяем результат → повторяем, пока задача не выполнена.
 */

import { getSettings } from './storage.js';
import { createProvider, validateApiSettings, ApiError } from './api.js';
import { formatPageContext } from './page.js';
import {
  ACTIONS_SYSTEM,
  SEARCH_ONLY_SYSTEM,
  getActiveTools,
  PAGE_TOOL_NAMES,
  WEB_TOOL_NAMES,
  parseActionBlocks,
  toolCallsToActions,
  labelAction,
} from './tools.js';

export { formatPageContext } from './page.js';

const PAGE_AWARE_SYSTEM = `

У тебя есть доступ к текущей вкладке браузера: текст, заголовки, ссылки, кнопки, поля форм, интерактивные элементы с ref и (если модель поддерживает изображения) скриншот видимой области.
На вопросы вроде «чё на странице», «что здесь», «посмотри», «прочитай» сразу отвечай по снимку и скриншоту.
Если нужно найти факты в интернете («погугли», «найди», «что такое», новости) — используй web_search / fetch_url.
Если контекст пустой или страница системная — честно скажи, что не видишь содержимое.
Не выдумывай элементы и факты, которых нет в контексте/результатах поиска.

Форматируй финальные ответы в Markdown: ###, **жирный**, списки, \`код\`, ссылки.
`;

const DEFAULT_MAX_STEPS = 15;
const SNAPSHOT_PREFIXES = ['Снимок текущей вкладки', 'Обновлённый снимок страницы'];
const SHOT_HINT =
  'Скриншот видимой области вкладки. Цветные рамки с подписью — интерактивные элементы, подпись = ref. ' +
  'Проверь по нему, получилось ли действие, и продолжай задачу.';

/** Модели, которые отвергли изображения, — больше не шлём им скриншоты в этой сессии. */
const visionBlocked = new Set();
/** Сообщения, содержащие только скриншот: их можно выбрасывать целиком. */
const shotMessages = new WeakSet();

function visionKey(settings) {
  return `${settings.provider}|${settings.apiBaseUrl}|${settings.model}`;
}

export function canUseVision(settings) {
  return settings.includeScreenshot !== false && !visionBlocked.has(visionKey(settings));
}

/** Сообщение пользователя с картинкой в формате выбранного провайдера. */
export function imageMessage(text, dataUrl, provider) {
  if (provider === 'anthropic') {
    const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
    return {
      role: 'user',
      content: [
        { type: 'text', text },
        {
          type: 'image',
          source: { type: 'base64', media_type: match?.[1] || 'image/jpeg', data: match?.[2] || '' },
        },
      ],
    };
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  };
}

function hasImages(messages) {
  return messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url' || p?.type === 'image')
  );
}

/** Убирает все картинки из контекста (сообщения-скриншоты удаляются, у остальных остаётся текст). */
function dropImages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (shotMessages.has(m)) {
      messages.splice(i, 1);
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      m.content = m.content
        .filter((p) => p?.type === 'text')
        .map((p) => p.text)
        .join('\n');
    }
  }
}

/** Старые текстовые снимки страницы больше не актуальны — не раздуваем контекст. */
function pruneSnapshots(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === 'system' &&
      typeof m.content === 'string' &&
      SNAPSHOT_PREFIXES.some((p) => m.content.startsWith(p))
    ) {
      messages.splice(i, 1);
    }
  }
}

function isVisionError(err) {
  if (!(err instanceof ApiError) || ![400, 404, 415, 422].includes(err.status)) return false;
  const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body || '');
  return /image|vision|multimodal|multi-modal|modalit|unknown variant|expected a string/i.test(
    `${body} ${err.message}`
  );
}

/**
 * @param {{ role: string, content: any }[]} history
 * @param {string} userText
 * @param {object|null} pageContext
 * @param {Awaited<ReturnType<typeof getSettings>>} settings
 */
export function buildMessages(history, userText, pageContext, settings) {
  let system = `${settings.systemPrompt || ''}${PAGE_AWARE_SYSTEM}`.trim();
  const allowActions = settings.enableActions !== false;
  const allowSearch = settings.enableWebSearch !== false;
  if (allowActions) system = `${system}\n${ACTIONS_SYSTEM}`;
  else if (allowSearch) system = `${system}\n${SEARCH_ONLY_SYSTEM}`;

  /** @type {{ role: string, content: any }[]} */
  const messages = [{ role: 'system', content: system }];

  if (settings.includePageContext !== false && pageContext) {
    const ctx = formatPageContext(pageContext, settings.maxContextChars ?? 16000);
    if (ctx) {
      messages.push({
        role: 'system',
        content: `Снимок текущей вкладки (источник истины о странице):\n\n${ctx}`,
      });
    }
  }

  const recent = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-40);
  for (const m of recent) {
    if (typeof m.content === 'string' && !m.content.trim()) continue;
    messages.push({ role: m.role, content: m.content });
  }

  if (pageContext?.screenshot && canUseVision(settings)) {
    messages.push(
      imageMessage(
        `${userText}\n\n[К сообщению приложен скриншот вкладки: рамки с подписями — интерактивные элементы, подпись = ref]`,
        pageContext.screenshot,
        settings.provider || 'openai-compatible'
      )
    );
  } else {
    messages.push({ role: 'user', content: userText });
  }

  return messages;
}

/**
 * @param {object} params
 */
export async function runAgent({ history, userText, pageContext, opts = {} }) {
  const settings = await getSettings();
  const errors = validateApiSettings(settings);
  if (errors.length) throw new Error(errors[0]);

  const provider = createProvider(settings);
  const providerName = settings.provider || 'openai-compatible';
  let context = pageContext;
  const messages = buildMessages(history, userText, context, settings);
  const maxSteps = Math.min(Math.max(Number(settings.maxSteps) || DEFAULT_MAX_STEPS, 1), 40);

  const allowActions = settings.enableActions !== false;
  const allowSearch = settings.enableWebSearch !== false;
  const allowEval = settings.enableEvalJs === true; // по умолчанию выключено
  const toolsEnabled = allowActions || allowSearch;
  const activeTools = getActiveTools(settings);

  let useNativeTools =
    toolsEnabled &&
    activeTools.length > 0 &&
    providerName === 'openai-compatible' &&
    typeof provider.chatTurn === 'function';

  let finalText = '';

  /** Запрос к модели с автоматическим отказом от изображений / нативных tools, если API их не принимает. */
  const safeTurn = async (buildArgs) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callTurn(provider, messages, buildArgs());
      } catch (err) {
        lastErr = err;
        if (hasImages(messages) && isVisionError(err)) {
          visionBlocked.add(visionKey(settings));
          dropImages(messages);
          opts.onStatus?.('Модель не принимает изображения — продолжаю по тексту страницы');
          continue;
        }
        if (err instanceof ApiError && err.code === 'tools_unsupported' && useNativeTools) {
          useNativeTools = false;
          stripToolMessages(messages);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };

  const refresh = async (withScreenshot) => {
    const req = { withScreenshot, tabId: context?.tabId };
    if (typeof opts.refreshContext === 'function') return opts.refreshContext(req);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT', ...req });
      return res?.ok ? res.context : null;
    } catch {
      return null;
    }
  };

  let lastSignature = '';
  let repeats = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const isLastChance = step === maxSteps - 1;
    opts.onStatus?.(
      toolsEnabled
        ? step === 0
          ? 'Думаю…'
          : `Шаг ${step + 1} из ${maxSteps}…`
        : 'Агент думает…'
    );
    if (isLastChance && step > 0) {
      messages.push({
        role: 'system',
        content:
          'Лимит шагов исчерпан. Дай итоговый ответ пользователю: что сделано, что получилось, что осталось незавершённым.',
      });
    }

    const turn = await safeTurn(() => ({
      signal: opts.signal,
      onDelta: !toolsEnabled || isLastChance ? opts.onDelta : undefined,
      tools: useNativeTools && !isLastChance ? activeTools : undefined,
      streamFinal: !toolsEnabled || isLastChance,
    }));

    const nativeActions = useNativeTools ? toolCallsToActions(turn.tool_calls) : [];
    const parsed = parseActionBlocks(turn.content || '');
    let actions = nativeActions.length ? nativeActions : parsed.actions;
    actions = actions.filter((a) => isActionAllowed(a, allowActions, allowSearch, allowEval));
    const visible = nativeActions.length ? turn.content || '' : parsed.cleanText;

    if (!actions.length || !toolsEnabled || isLastChance) {
      finalText = visible || turn.content || '';
      if (finalText && opts.onDelta && !turn._streamed) {
        opts.onDelta(finalText);
      }
      break;
    }

    if (visible) opts.onStatus?.(visible.slice(0, 120));

    messages.push({
      role: 'assistant',
      content: turn.content || null,
      ...(turn.tool_calls?.length && useNativeTools ? { tool_calls: turn.tool_calls } : {}),
    });

    const results = [];
    let didObserve = false;

    for (const action of actions) {
      opts.onStatus?.(`Делаю: ${labelAction(action)}`);
      opts.onAction?.({ phase: 'start', action });
      const risk = settings.confirmRiskyActions !== false ? describeRisk(action, context) : '';
      const approved =
        !risk ||
        typeof opts.confirmAction !== 'function' ||
        (await opts.confirmAction({ action, reason: risk }));
      const result = approved
        ? await dispatchAction(action, context)
        : { ok: false, error: 'Пользователь отклонил действие' };
      opts.onAction?.({ phase: 'done', action, result });
      results.push({ action, result });

      if (approved && (PAGE_TOOL_NAMES.has(action.tool) || action.tool === 'open_url')) {
        didObserve = true;
      }
      if (action.tool === 'open_url' && result?.tabId) {
        context = { ...(context || {}), tabId: result.tabId };
      }

      if (action._id && turn.tool_calls?.length) {
        messages.push({
          role: 'tool',
          tool_call_id: action._id,
          content: JSON.stringify(compactResult(result)),
        });
      }

      await delay(220);
    }

    // API требует ответ на каждый tool_call, даже на отфильтрованные или нераспознанные
    for (const tc of useNativeTools ? turn.tool_calls || [] : []) {
      if (!tc?.id || messages.some((m) => m.role === 'tool' && m.tool_call_id === tc.id)) continue;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ ok: false, error: 'Инструмент недоступен или вызван некорректно' }),
      });
    }

    if (!useNativeTools || !turn.tool_calls?.length) {
      messages.push({
        role: 'user',
        content:
          'Результаты действий:\n' +
          results
            .map(
              (r, i) =>
                `${i + 1}. ${labelAction(r.action)} → ${JSON.stringify(compactResult(r.result))}`
            )
            .join('\n') +
          '\n\nПроверь результат по новому снимку страницы и продолжай задачу. Если всё сделано — дай финальный ответ пользователю без action-блоков. Указывай источники ссылками, если искал в интернете.',
      });
    }

    // Защита от зацикливания на одном и том же действии
    const signature = JSON.stringify(
      actions.map((a) => [a.tool, a.ref, a.text, a.x, a.y, a.url, a.query, a.direction, a.key])
    );
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 2) {
      messages.push({
        role: 'system',
        content:
          'Ты уже несколько раз подряд делаешь одно и то же действие, и оно не помогает. Смени подход (другой ref, прокрутка, координаты x,y, другой запрос) или честно сообщи пользователю, что не получилось.',
      });
    }

    if (didObserve && settings.includePageContext !== false) {
      const wantShot = canUseVision(settings);
      opts.onStatus?.(wantShot ? 'Смотрю на страницу…' : 'Читаю страницу…');
      context = (await refresh(wantShot)) || context;

      if (context) {
        pruneSnapshots(messages);
        const ctx = formatPageContext(context, Math.min(settings.maxContextChars ?? 16000, 12000));
        messages.push({
          role: 'system',
          content: `Обновлённый снимок страницы после действий:\n\n${ctx}`,
        });
        if (wantShot && context.screenshot) {
          dropImages(messages);
          const shot = imageMessage(SHOT_HINT, context.screenshot, providerName);
          shotMessages.add(shot);
          messages.push(shot);
        }
      }
    }
  }

  if (!finalText) {
    opts.onStatus?.('Формирую ответ…');
    const turn = await safeTurn(() => ({
      signal: opts.signal,
      onDelta: opts.onDelta,
      tools: undefined,
      streamFinal: true,
    }));
    finalText = parseActionBlocks(turn.content || '').cleanText || turn.content || '';
  }

  return finalText;
}

const RISKY_TEXT =
  /pay|buy|purchase|order|checkout|delete|remove|submit|confirm|send|transfer|sign\s?out|log\s?out|оплат|купить|заказ|удалить|отправ|подтверд|перевест|перевод|выйти/i;

/** Возвращает причину, если действие похоже на необратимое (оплата, удаление, отправка формы). */
function describeRisk(action, context) {
  // Выполнение произвольного JS — всегда под подтверждение
  if (action.tool === 'eval_js' || action.tool === 'run_js') {
    const code = String(action.code || action.js || '').replace(/\s+/g, ' ').trim();
    return `выполнение JS на странице${code ? `: ${code.slice(0, 80)}` : ''}`;
  }
  // Разрушительная правка DOM: удаление элемента или замена innerHTML
  if (action.tool === 'edit_dom' || action.tool === 'edit') {
    const op = String(action.op || '').toLowerCase();
    if (op === 'remove') return `удаление элемента${action.ref ? ` [${action.ref}]` : ''}`;
    if (op === 'html') return `замену разметки${action.ref ? ` [${action.ref}]` : ''}`;
    return '';
  }
  if (action.tool !== 'click' && !(action.tool === 'press' && action.key === 'Enter')) return '';
  const el = (context?.interactive || []).find((e) => e.ref === action.ref);
  const label = String(el?.text || action.text || '');
  if (el?.type === 'submit' || RISKY_TEXT.test(label)) {
    return label ? `«${label.slice(0, 60)}»` : 'отправка формы';
  }
  return '';
}

/** Для провайдеров без tools: превращаем tool-вызовы и их результаты в обычные сообщения. */
function stripToolMessages(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') {
      messages[i] = { role: 'user', content: `Результат действия: ${m.content}` };
    } else if (m.role === 'assistant' && m.tool_calls) {
      const { tool_calls: _calls, ...rest } = m;
      messages[i] = { ...rest, content: m.content || '(вызов инструментов)' };
    }
  }
}

function isActionAllowed(action, allowActions, allowSearch, allowEval) {
  const t = action.tool;
  if (t === 'eval_js' || t === 'run_js') return allowActions && allowEval;
  if (t === 'wait' || t === 'look' || t === 'open_url') return allowActions || allowSearch;
  if (WEB_TOOL_NAMES.has(t)) return allowSearch;
  if (PAGE_TOOL_NAMES.has(t)) return allowActions;
  return false;
}

async function dispatchAction(action, context) {
  const t = action.tool;
  if (t === 'look') return { ok: true, result: 'снимок страницы обновлён' };
  if (t === 'web_search' || t === 'search') {
    return chrome.runtime.sendMessage({
      type: 'SEARCH_WEB',
      query: action.query || action.q || action.text,
      limit: action.limit,
    });
  }
  if (t === 'fetch_url' || t === 'read_url') {
    return chrome.runtime.sendMessage({
      type: 'FETCH_URL',
      url: action.url,
      maxChars: action.maxChars,
    });
  }
  if (t === 'open_url') {
    return chrome.runtime.sendMessage({
      type: 'OPEN_URL',
      url: action.url,
      newTab: Boolean(action.newTab),
      tabId: context?.tabId,
    });
  }
  if (t === 'eval_js' || t === 'run_js') {
    return chrome.runtime.sendMessage({
      type: 'EVAL_JS',
      code: action.code || action.js || action.script,
      tabId: context?.tabId,
    });
  }
  if (t === 'persist_add') {
    return chrome.runtime.sendMessage({
      type: 'PERSIST_ADD',
      scope: action.scope,
      selector: action.selector,
      position: action.position,
      html: action.html,
      css: action.css,
      tabId: context?.tabId,
    });
  }
  if (t === 'persist_list') {
    return chrome.runtime.sendMessage({ type: 'PERSIST_LIST', tabId: context?.tabId });
  }
  if (t === 'persist_remove') {
    return chrome.runtime.sendMessage({ type: 'PERSIST_REMOVE', id: action.id });
  }
  return chrome.runtime.sendMessage({
    type: 'RUN_PAGE_ACTION',
    action,
    tabId: context?.tabId,
  });
}

function compactResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.text && String(result.text).length > 4000) {
    return { ...result, text: String(result.text).slice(0, 4000) + '…[truncated]' };
  }
  if (Array.isArray(result.results) && result.results.length > 8) {
    return { ...result, results: result.results.slice(0, 8) };
  }
  return result;
}

async function callTurn(provider, messages, { signal, onDelta, tools, streamFinal }) {
  if (typeof provider.chatTurn === 'function') {
    const prev = provider.config.stream;
    provider.config.stream = Boolean(streamFinal && onDelta && !tools?.length);
    try {
      const turn = await provider.chatTurn(messages, {
        signal,
        onDelta: provider.config.stream ? onDelta : undefined,
        tools,
      });
      turn._streamed = Boolean(provider.config.stream && onDelta);
      return turn;
    } finally {
      provider.config.stream = prev;
    }
  }

  const text = await provider.chat(messages, {
    signal,
    onDelta: streamFinal ? onDelta : undefined,
  });
  return {
    content: text,
    tool_calls: [],
    finish_reason: 'stop',
    _streamed: Boolean(streamFinal && onDelta),
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function testApiConnection(overrides = {}) {
  const settings = { ...(await getSettings()), ...overrides, stream: false };
  const errors = validateApiSettings(settings);
  if (errors.length) throw new Error(errors[0]);
  const provider = createProvider(settings);
  return provider.testConnection();
}

export async function fetchModels(overrides = {}) {
  const settings = { ...(await getSettings()), ...overrides };
  const errors = validateApiSettings({ ...settings, model: settings.model || 'x' });
  const filtered = errors.filter((e) => !e.includes('модель'));
  if (filtered.length) throw new Error(filtered[0]);
  if (!settings.apiBaseUrl?.trim()) throw new Error('Укажите API Base URL');

  const provider = createProvider(settings);
  if (typeof provider.listModels !== 'function') {
    throw new Error('Этот провайдер не поддерживает список моделей');
  }
  return provider.listModels();
}
