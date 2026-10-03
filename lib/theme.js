/**
 * Тема: light | dark | system
 */

/** @param {'light'|'dark'|'system'} theme */
export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
  return prefersDark ? 'dark' : 'light';
}

/** @param {'light'|'dark'|'system'} theme */
export function applyTheme(theme) {
  const resolved = resolveTheme(theme || 'system');
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
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
    if (theme === 'system') applyTheme('system');
  };

  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
