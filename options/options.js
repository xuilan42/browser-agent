import { DEFAULT_SETTINGS, getSettings, saveSettings, onSettingsChanged } from '../lib/storage.js';
import { createProvider, validateApiSettings } from '../lib/api.js';
import { applyTheme, watchSystemTheme } from '../lib/theme.js';

const PRESETS = {
  openai: {
    provider: 'openai-compatible',
    apiBaseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    customHeaders: '',
  },
  openrouter: {
    provider: 'openai-compatible',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    customHeaders: '{\n  "HTTP-Referer": "https://browser-agent.local",\n  "X-Title": "Browser Agent"\n}',
  },
  anthropic: {
    provider: 'anthropic',
    apiBaseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
    customHeaders: '',
  },
  ollama: {
    provider: 'openai-compatible',
    apiBaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2',
    apiKey: 'ollama',
    customHeaders: '',
  },
  lmstudio: {
    provider: 'openai-compatible',
    apiBaseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    apiKey: '',
    customHeaders: '',
  },
};

const fields = [
  'provider',
  'apiBaseUrl',
  'apiKey',
  'model',
  'customHeaders',
  'systemPrompt',
  'temperature',
  'topP',
  'maxTokens',
  'maxContextChars',
  'maxSteps',
  'timeoutMs',
  'theme',
];

const checks = [
  'stream',
  'includePageContext',
  'includeScreenshot',
  'enableActions',
  'enableWebSearch',
  'confirmRiskyActions',
  'sendTemperature',
  'sendTopP',
];

const form = document.getElementById('form');
const saveStatus = document.getElementById('saveStatus');
const testStatus = document.getElementById('testStatus');
const btnTest = document.getElementById('btnTest');
const btnModels = document.getElementById('btnModels');
const btnToggleKey = document.getElementById('btnToggleKey');
const modelList = document.getElementById('modelList');
const themeSelect = document.getElementById('theme');

init();

async function init() {
  const settings = await getSettings();
  fill(settings);
  applyTheme(settings.theme);
  syncThemeSwitch(settings.theme);
  watchSystemTheme(async () => (await getSettings()).theme);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const next = read();
    const errors = validateApiSettings(next);
    if (errors.length) {
      flash(saveStatus, errors[0], 'err');
      return;
    }
    await saveSettings(next);
    applyTheme(next.theme);
    syncThemeSwitch(next.theme);
    flash(saveStatus, 'Сохранено', 'ok');
  });

  document.getElementById('sendTemperature').addEventListener('change', syncParamToggles);
  document.getElementById('sendTopP').addEventListener('change', syncParamToggles);

  btnTest.addEventListener('click', onTest);
  btnModels.addEventListener('click', onFetchModels);
  btnToggleKey.addEventListener('click', () => {
    const input = document.getElementById('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  themeSelect.addEventListener('change', async () => {
    const theme = themeSelect.value;
    applyTheme(theme);
    syncThemeSwitch(theme);
    await saveSettings({ theme });
  });

  document.querySelectorAll('[data-theme-set]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theme = btn.getAttribute('data-theme-set');
      themeSelect.value = theme;
      applyTheme(theme);
      syncThemeSwitch(theme);
      await saveSettings({ theme });
    });
  });

  document.getElementById('provider').addEventListener('change', (e) => {
    if (e.target.value === 'anthropic') {
      const url = document.getElementById('apiBaseUrl');
      if (!url.value.includes('anthropic')) url.value = 'https://api.anthropic.com';
    }
  });

  document.getElementById('apiKey').addEventListener('change', () => {
    maybeAutofixEndpoint();
  });
  document.getElementById('apiKey').addEventListener('blur', () => {
    maybeAutofixEndpoint();
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      fill({ ...read(), ...preset });
      // Пресет сразу сохраняем по URL/модели, ключ не трогаем если пресет его не задаёт
      const partial = { ...preset };
      await saveSettings(partial);
      flash(saveStatus, `Пресет «${btn.textContent.trim()}» сохранён`, 'ok');
    });
  });

  onSettingsChanged((next) => {
    if (document.activeElement && form.contains(document.activeElement)) return;
    fill(next);
    applyTheme(next.theme);
    syncThemeSwitch(next.theme);
  });
}

function syncThemeSwitch(theme) {
  document.querySelectorAll('[data-theme-set]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-theme-set') === theme);
  });
}

function fill(settings) {
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) el.value = settings[key] ?? DEFAULT_SETTINGS[key] ?? '';
  }
  for (const key of checks) {
    const el = document.getElementById(key);
    if (el) el.checked = Boolean(settings[key]);
  }
  syncParamToggles();
}

/** Серое числовое поле, когда соответствующий параметр отключён. */
function syncParamToggles() {
  const pairs = [
    ['sendTemperature', 'temperature'],
    ['sendTopP', 'topP'],
  ];
  for (const [toggleId, inputId] of pairs) {
    const toggle = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    if (toggle && input) {
      input.disabled = !toggle.checked;
      input.style.opacity = toggle.checked ? '' : '0.5';
    }
  }
}

function read() {
  return {
    provider: document.getElementById('provider').value,
    apiBaseUrl: document.getElementById('apiBaseUrl').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('model').value.trim(),
    customHeaders: document.getElementById('customHeaders').value.trim(),
    systemPrompt: document.getElementById('systemPrompt').value,
    temperature: num('temperature'),
    topP: num('topP'),
    maxTokens: num('maxTokens'),
    maxContextChars: num('maxContextChars'),
    maxSteps: num('maxSteps'),
    timeoutMs: num('timeoutMs'),
    theme: document.getElementById('theme').value,
    stream: document.getElementById('stream').checked,
    includePageContext: document.getElementById('includePageContext').checked,
    includeScreenshot: document.getElementById('includeScreenshot').checked,
    enableActions: document.getElementById('enableActions').checked,
    enableWebSearch: document.getElementById('enableWebSearch').checked,
    confirmRiskyActions: document.getElementById('confirmRiskyActions').checked,
    sendTemperature: document.getElementById('sendTemperature').checked,
    sendTopP: document.getElementById('sendTopP').checked,
  };
}

function num(id) {
  const value = parseFloat(document.getElementById(id).value);
  return Number.isFinite(value) ? value : DEFAULT_SETTINGS[id];
}

async function maybeAutofixEndpoint() {
  const key = document.getElementById('apiKey').value.trim();
  const urlEl = document.getElementById('apiBaseUrl');
  const modelEl = document.getElementById('model');
  const providerEl = document.getElementById('provider');
  const headersEl = document.getElementById('customHeaders');

  if (key.startsWith('sk-or-') && urlEl.value.includes('api.openai.com')) {
    providerEl.value = 'openai-compatible';
    urlEl.value = 'https://openrouter.ai/api/v1';
    if (!modelEl.value.includes('/')) modelEl.value = 'openai/gpt-4o-mini';
    if (!headersEl.value.trim()) {
      headersEl.value =
        '{\n  "HTTP-Referer": "https://browser-agent.local",\n  "X-Title": "Browser Agent"\n}';
    }
    flash(
      saveStatus,
      'Обнаружен ключ OpenRouter — Base URL переключён на openrouter.ai. Нажми Сохранить.',
      'ok'
    );
  }

  if (key.startsWith('sk-ant-')) {
    providerEl.value = 'anthropic';
    if (!urlEl.value.includes('anthropic')) urlEl.value = 'https://api.anthropic.com';
  }
}

async function onTest() {
  testStatus.textContent = 'Проверяю…';
  testStatus.className = 'note';
  btnTest.disabled = true;

  try {
    const cfg = read();
    const errors = validateApiSettings(cfg);
    if (errors.length) throw new Error(errors[0]);
    const provider = createProvider({ ...cfg, stream: false });
    const reply = await provider.testConnection();
    flash(testStatus, `OK: ${String(reply).slice(0, 100)}`, 'ok');
  } catch (err) {
    flash(testStatus, err?.message || String(err), 'err');
  } finally {
    btnTest.disabled = false;
  }
}

async function onFetchModels() {
  testStatus.textContent = 'Загружаю модели…';
  testStatus.className = 'note';
  btnModels.disabled = true;

  try {
    const cfg = read();
    if (!cfg.apiBaseUrl) throw new Error('Укажите Base URL');
    const provider = createProvider(cfg);
    const models = await provider.listModels();
    modelList.innerHTML = '';
    for (const id of models.slice(0, 200)) {
      const opt = document.createElement('option');
      opt.value = id;
      modelList.appendChild(opt);
    }
    flash(testStatus, `Найдено моделей: ${models.length}. Выбери в поле Model.`, 'ok');
  } catch (err) {
    flash(testStatus, err?.message || String(err), 'err');
  } finally {
    btnModels.disabled = false;
  }
}

function flash(el, text, cls) {
  el.textContent = text;
  el.className = cls ? `note ${cls}` : 'note';
  if (el === saveStatus && cls === 'ok') {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, 2500);
  }
}
