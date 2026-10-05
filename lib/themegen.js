/**
 * Генерация темы чата по текстовому описанию через настроенный LLM.
 * Переиспользует API чата (base URL, ключ, модель). Без диалога — один запрос.
 */

import { createProvider, validateApiSettings } from './api.js';
import { THEME_VARS, isSafeColor } from './themes.js';

const VAR_HINTS = {
  bg: 'фон приложения',
  'bg-elev': 'фон карточек/приподнятых блоков',
  'bg-top': 'фон шапки',
  'bg-composer': 'фон поля ввода снизу',
  ink: 'основной текст',
  muted: 'приглушённый текст',
  line: 'границы и разделители',
  accent: 'акцентный цвет (кнопки, ссылки)',
  'accent-ink': 'текст на акцентном фоне',
  user: 'фон сообщений пользователя',
  'user-ink': 'текст сообщений пользователя',
  danger: 'цвет ошибок',
  'danger-bg': 'фон ошибок',
  'danger-line': 'граница ошибок',
  'input-bg': 'фон полей ввода',
  'app-border': 'внешняя рамка окна',
  glow: 'свечение/тень акцента (можно rgba)',
  'grad-a': 'первый цвет фонового градиента',
  'grad-b': 'второй цвет фонового градиента',
  shadow: 'тень (можно rgba в box-shadow-значении — только цвет)',
  'icon-btn-hover-bg': 'фон кнопок-иконок при наведении',
};

function buildPrompt(idea) {
  const vars = THEME_VARS.map((k) => `  "${k}": "<${VAR_HINTS[k] || k}>"`).join(',\n');
  return [
    {
      role: 'system',
      content:
        'Ты генератор цветовых тем для UI чата. Верни СТРОГО один JSON-объект и ничего больше — ' +
        'без пояснений, без markdown, без ```.\n' +
        'Формат:\n' +
        '{\n' +
        '  "name": "короткое название темы",\n' +
        '  "base": "light" | "dark",\n' +
        '  "vars": {\n' +
        vars +
        '\n  }\n}\n' +
        'Значения — только CSS-цвета (#hex, rgb()/rgba(), hsl()), для grad-a/grad-b — цвета. ' +
        'Не используй url(), картинки, точки с запятой. Подбери гармоничную, читаемую палитру ' +
        '(достаточный контраст текста и фона). base выбери по светлости фона.',
    },
    { role: 'user', content: `Опиши тему: ${idea}` },
  ];
}

/** Достаёт первый JSON-объект из текста ответа модели. */
function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param {string} idea описание темы от пользователя
 * @param {object} apiSettings настройки API (как из options.read())
 * @returns {Promise<{ name: string, base: 'light'|'dark', vars: Record<string,string>, dropped: string[] }>}
 */
export async function generateTheme(idea, apiSettings) {
  const text = String(idea || '').trim();
  if (!text) throw new Error('Опиши тему словами');

  const cfg = { ...apiSettings, stream: false };
  const errors = validateApiSettings(cfg);
  if (errors.length) throw new Error(`Сначала настрой API: ${errors[0]}`);

  const provider = createProvider(cfg);
  const reply = await provider.chat(buildPrompt(text), {});
  const parsed = extractJson(reply);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Модель вернула не JSON. Попробуй переформулировать идею.');
  }

  const base = parsed.base === 'dark' ? 'dark' : 'light';
  const name = String(parsed.name || text).slice(0, 60);
  const vars = {};
  const dropped = [];
  const srcVars = parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {};
  for (const key of THEME_VARS) {
    const v = srcVars[key];
    if (typeof v === 'string' && isSafeColor(v)) vars[key] = v.trim();
    else if (v != null) dropped.push(key);
  }

  if (!Object.keys(vars).length) {
    throw new Error('В ответе нет корректных цветов. Попробуй ещё раз или задай тему вручную.');
  }
  return { name, base, vars, dropped };
}
