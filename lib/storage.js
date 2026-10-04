/**
 * Settings + chat history via chrome.storage.
 */

export const DEFAULT_SETTINGS = {
  provider: 'openai-compatible',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  /** JSON-объект доп. заголовков, напр. OpenRouter */
  customHeaders: '',
  systemPrompt:
    'Ты умный браузерный агент. Видишь открытую вкладку, можешь действовать на ней и искать информацию в интернете. Отвечай по делу, опирайся на факты со страницы и из поиска, указывай источники.',
  temperature: 0.1,
  /** отправлять ли temperature в запрос (некоторые модели его не принимают) */
  sendTemperature: true,
  topP: 0.2,
  /** отправлять ли top_p в запрос */
  sendTopP: true,
  maxTokens: 2048,
  includePageContext: true,
  includeScreenshot: true,
  enableActions: true,
  enableWebSearch: true,
  /** разрешить агенту выполнять произвольный JS на странице (eval_js) — опасно, по умолчанию выкл. */
  enableEvalJs: false,
  /** спрашивать подтверждение перед оплатой, удалением, отправкой форм */
  confirmRiskyActions: true,
  /** автономный режим: действовать без подтверждений (работает только при enableEvalJs) */
  autonomousMode: false,
  maxContextChars: 16000,
  /** максимум шагов «посмотрел → сделал» за один запрос */
  maxSteps: 15,
  stream: true,
  timeoutMs: 120000,
  /** 'light' | 'dark' | 'system' */
  theme: 'system',
};

const SETTINGS_KEY = 'settings';
const SECRETS_KEY = 'secrets';
const HISTORY_KEY = 'chatHistory';
const INJECTIONS_KEY = 'injections';

/** API-ключ хранится только локально и не уходит в синхронизацию аккаунта. */
export async function getSettings() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get(SECRETS_KEY),
  ]);
  const stored = syncData[SETTINGS_KEY] || {};
  const secrets = localData[SECRETS_KEY] || {};

  // миграция: ключ, сохранённый старыми версиями в sync
  if (stored.apiKey && !secrets.apiKey) {
    secrets.apiKey = stored.apiKey;
    const { apiKey: _legacy, ...rest } = stored;
    await chrome.storage.local.set({ [SECRETS_KEY]: secrets });
    await chrome.storage.sync.set({ [SETTINGS_KEY]: rest });
    return { ...DEFAULT_SETTINGS, ...rest, apiKey: secrets.apiKey };
  }

  const { apiKey: _ignored, ...rest } = stored;
  return { ...DEFAULT_SETTINGS, ...rest, apiKey: secrets.apiKey ?? DEFAULT_SETTINGS.apiKey };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  const { apiKey, ...rest } = next;
  await chrome.storage.local.set({ [SECRETS_KEY]: { apiKey: apiKey || '' } });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: rest });
  return next;
}

// ---- Постоянные вставки элементов (persistent injections) ----

/** Нормализует URL под scope: 'url' — без ?query/#hash; 'origin' — только протокол+хост. */
export function injectionMatchKey(url, scope) {
  try {
    const u = new URL(url);
    return scope === 'origin' ? u.origin : `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/** Подходит ли сохранённое правило под данный URL. */
export function injectionMatchesUrl(rec, url) {
  if (!rec) return false;
  return rec.match === injectionMatchKey(url, rec.scope || 'url');
}

export async function getInjections() {
  const data = await chrome.storage.local.get(INJECTIONS_KEY);
  return data[INJECTIONS_KEY] || [];
}

export async function getInjectionsForUrl(url) {
  const all = await getInjections();
  return all.filter((rec) => injectionMatchesUrl(rec, url));
}

export async function addInjection(rec) {
  const all = await getInjections();
  const entry = {
    id: `inj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scope: rec.scope === 'origin' ? 'origin' : 'url',
    match: rec.match,
    selector: rec.selector || 'body',
    position: rec.position || 'beforeend',
    html: rec.html || '',
    css: rec.css || '',
    createdAt: Date.now(),
  };
  all.push(entry);
  await chrome.storage.local.set({ [INJECTIONS_KEY]: all.slice(-200) });
  return entry;
}

export async function removeInjection(id) {
  const all = await getInjections();
  const next = all.filter((r) => r.id !== id);
  await chrome.storage.local.set({ [INJECTIONS_KEY]: next });
  return all.length - next.length;
}

export async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return data[HISTORY_KEY] || [];
}

export async function saveHistory(messages) {
  const trimmed = messages.slice(-200);
  await chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
}

export async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    const relevant =
      (area === 'sync' && changes[SETTINGS_KEY]) || (area === 'local' && changes[SECRETS_KEY]);
    if (!relevant) return;
    callback(await getSettings());
  });
}
