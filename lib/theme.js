/**
 * Применение темы: system | light | dark | <id пользовательской темы>.
 *
 * Встроенные light/dark работают через data-theme и переменные в panel.css.
 * Пользовательские темы догружаются из реестра (themes.js) и инжектятся как
 * CSS-переменные в <style id="ba-theme-vars">. База (light/dark) задаёт
 * color-scheme и подложку переменных.
 */

import {
  SYSTEM_THEME_ID,
  getAllThemes,
  findTheme,
  themeToCssVars,
  BUILTIN_THEMES,
} from './themes.js';

const STYLE_ID = 'ba-theme-vars';

/** Кэш тем, чтобы applyTheme работал синхронно после первичной загрузки. */
let themeCache = [...BUILTIN_THEMES];

/** Подтянуть все темы (вкл. пользовательские) в кэш. Вызывать при старте страницы. */
export async function loadThemes() {
  try {
    themeCache = await getAllThemes();
  } catch {
    themeCache = [...BUILTIN_THEMES];
  }
  return themeCache;
}

/**
 * Разрешает запрошенную тему в конкретный применяемый data-theme.
 * @param {string} theme id темы или 'system'
 */
export function resolveTheme(theme) {
  // Обратная совместимость: прямые light/dark
  if (theme === 'light' || theme === 'dark') return theme;

  if (!theme || theme === SYSTEM_THEME_ID) {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
    return prefersDark ? 'dark' : 'light';
  }

  // Пользовательская/именованная тема
  const found = findTheme(themeCache, theme);
  if (found) return found.id;

  // Неизвестная тема — безопасный фолбэк
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  return prefersDark ? 'dark' : 'light';
}

/** Инжектит/обновляет <style> с переменными пользовательских тем. */
function ensureThemeStyles() {
  const custom = themeCache.filter((t) => !t.builtin);
  let style = document.getElementById(STYLE_ID);
  if (!custom.length) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = custom.map(themeToCssVars).filter(Boolean).join('\n\n');
}

/**
 * @param {string} theme id темы или 'system'
 * @returns {string} применённый data-theme
 */
export function applyTheme(theme) {
  const resolved = resolveTheme(theme || SYSTEM_THEME_ID);
  const found = findTheme(themeCache, resolved);
  const scheme = found ? found.base : resolved === 'dark' ? 'dark' : 'light';

  ensureThemeStyles();
  document.documentElement.dataset.theme = resolved;
  // color-scheme берём из базы темы (нативные контролы, скроллбары)
  document.documentElement.style.colorScheme = scheme;
  return resolved;
}

/**
 * @param {() => string | Promise<string>} getTheme
 * @returns {() => void} cleanup
 */
export function watchSystemTheme(getTheme) {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};

  const onChange = async () => {
    const theme = await getTheme();
    if (!theme || theme === SYSTEM_THEME_ID) applyTheme(SYSTEM_THEME_ID);
  };

  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
