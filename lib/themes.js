/**
 * Реестр тем чата.
 *
 * Тема — это именованный набор CSS-переменных (тех же, что в panel.css :root).
 * Встроенные темы (light/dark) заданы здесь, пользовательские хранятся в
 * chrome.storage.local['customThemes'] и применяются тем же движком.
 *
 * Это каркас: добавить новую тему = добавить объект { id, name, base, vars }.
 * Редактор тем в UI пока заглушка — движок применения уже полностью рабочий.
 */

/** Полный список переменных, из которых состоит тема (совпадает с panel.css). */
export const THEME_VARS = [
  'bg',
  'bg-elev',
  'bg-top',
  'bg-composer',
  'ink',
  'muted',
  'line',
  'accent',
  'accent-ink',
  'user',
  'user-ink',
  'danger',
  'danger-bg',
  'danger-line',
  'input-bg',
  'app-border',
  'glow',
  'grad-a',
  'grad-b',
  'shadow',
  'icon-btn-hover-bg',
];

/**
 * Встроенные темы. `base` — какой data-theme использовать как подложку
 * (light|dark), чтобы не описывать абсолютно все переменные в кастомной теме.
 * @typedef {{ id: string, name: string, base: 'light'|'dark', builtin?: boolean, vars?: Record<string,string> }} Theme
 */

/** @type {Theme[]} */
export const BUILTIN_THEMES = [
  { id: 'light', name: 'Светлая', base: 'light', builtin: true, vars: {} },
  { id: 'dark', name: 'Тёмная', base: 'dark', builtin: true, vars: {} },
];

/** Спец-значение: следовать системной теме. Обрабатывается в theme.js. */
export const SYSTEM_THEME_ID = 'system';

const CUSTOM_THEMES_KEY = 'customThemes';

/** @returns {Promise<Theme[]>} пользовательские темы из storage */
export async function getCustomThemes() {
  try {
    const data = await chrome.storage.local.get(CUSTOM_THEMES_KEY);
    const list = data[CUSTOM_THEMES_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Все темы: встроенные + пользовательские. */
export async function getAllThemes() {
  const custom = await getCustomThemes();
  return [...BUILTIN_THEMES, ...custom];
}

/** Тема по id (или null). Синхронный поиск по уже загруженному списку. */
export function findTheme(themes, id) {
  return themes.find((t) => t.id === id) || null;
}

/** Нормализует и сохраняет пользовательскую тему (создаёт или обновляет по id). */
export async function saveCustomTheme(theme) {
  const id = String(theme?.id || '').trim() || `theme-${Date.now()}`;
  if (BUILTIN_THEMES.some((t) => t.id === id)) {
    throw new Error('Нельзя переопределить встроенную тему — выбери другой id');
  }
  const entry = {
    id,
    name: String(theme?.name || id),
    base: theme?.base === 'dark' ? 'dark' : 'light',
    builtin: false,
    vars: sanitizeVars(theme?.vars),
  };
  const custom = await getCustomThemes();
  const idx = custom.findIndex((t) => t.id === id);
  if (idx >= 0) custom[idx] = entry;
  else custom.push(entry);
  await chrome.storage.local.set({ [CUSTOM_THEMES_KEY]: custom.slice(0, 50) });
  return entry;
}

export async function removeCustomTheme(id) {
  const custom = await getCustomThemes();
  const next = custom.filter((t) => t.id !== id);
  await chrome.storage.local.set({ [CUSTOM_THEMES_KEY]: next });
  return custom.length - next.length;
}

/**
 * Безопасное значение CSS-переменной темы: только цвета и градиенты из цветов.
 * Не пускаем url(), expression, ;, }, @import, комментарии — чтобы тема не могла
 * сломать вёрстку или подтянуть внешний ресурс.
 * @param {string} v
 */
export function isSafeColor(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 200) return false;
  // запрещённые конструкции
  if (/[;{}]/.test(s)) return false;
  if (/url\s*\(|expression|@import|javascript:|\/\*|\*\//i.test(s)) return false;

  const COLOR =
    /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-z]+)$/i;

  // Градиенты: разбираем на части и проверяем, что внутри только цвета/позиции/углы
  const grad = /^(linear|radial|conic)-gradient\((.*)\)$/i.exec(s);
  if (grad) {
    const inner = grad[2];
    if (/[;{}]/.test(inner) || /url\s*\(|expression/i.test(inner)) return false;
    const parts = inner.split(',').map((p) => p.trim());
    for (const p of parts) {
      // угол/направление/позиция
      if (/^-?\d+(\.\d+)?(deg|rad|turn|%|px)?$/.test(p)) continue;
      if (/^(to\s+(top|bottom|left|right)(\s+(top|bottom|left|right))?|circle|ellipse|at\s+[\w%\s]+|from\s+[\w.%]+)$/i.test(p)) continue;
      // «цвет позиция» или просто цвет
      const seg = p.split(/\s+/);
      const color = seg[0];
      if (!COLOR.test(color)) return false;
      for (const extra of seg.slice(1)) {
        if (!/^-?\d+(\.\d+)?(%|px|deg)?$/.test(extra)) return false;
      }
    }
    return true;
  }

  return COLOR.test(s);
}

/** Оставляет только известные переменные с БЕЗОПАСНЫМИ цветовыми значениями. */
function sanitizeVars(vars) {
  const out = {};
  if (vars && typeof vars === 'object') {
    for (const key of THEME_VARS) {
      const v = vars[key];
      if (typeof v === 'string' && v.trim() && isSafeColor(v)) out[key] = v.trim();
    }
  }
  return out;
}

/** Превращает vars темы в CSS-текст правила для [data-theme="id"]. */
export function themeToCssVars(theme) {
  const vars = sanitizeVars(theme?.vars);
  const body = Object.entries(vars)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n');
  return body ? `[data-theme="${cssId(theme.id)}"] {\n${body}\n}` : '';
}

function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}
