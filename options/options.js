import { DEFAULT_SETTINGS, getSettings, saveSettings, onSettingsChanged } from '../lib/storage.js';
import { createProvider, validateApiSettings } from '../lib/api.js';
import { applyTheme, watchSystemTheme, loadThemes } from '../lib/theme.js';
import {
  getAllThemes,
  getCustomThemes,
  saveCustomTheme,
  removeCustomTheme,
  THEME_VARS,
  SYSTEM_THEME_ID,
} from '../lib/themes.js';
import { generateTheme } from '../lib/themegen.js';

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
  'enableEvalJs',
  'autonomousMode',
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
  await loadThemes();
  await populateThemeSelect();
  await renderCustomThemes();
  initThemeEditor();
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
  document.getElementById('enableEvalJs').addEventListener('change', syncParamToggles);

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

/** Наполняет селектор темы из реестра: system + встроенные + пользовательские. */
async function populateThemeSelect() {
  if (!themeSelect) return;
  const current = themeSelect.value;
  const themes = await getAllThemes();
  themeSelect.innerHTML = '';

  const addOpt = (value, label) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    themeSelect.appendChild(opt);
  };
  addOpt(SYSTEM_THEME_ID, 'Как в системе');
  for (const t of themes) {
    if (t.id === '__preview__') continue;
    addOpt(t.id, t.name + (t.builtin ? '' : ' (своя)'));
  }

  if (current && [...themeSelect.options].some((o) => o.value === current)) {
    themeSelect.value = current;
  }
}

// ---- Редактор тем (ИИ + ручная правка) ----

const themeIdea = document.getElementById('themeIdea');
const btnThemeAi = document.getElementById('btnThemeAi');
const themeAiNote = document.getElementById('themeAiNote');
const themeForm = document.getElementById('themeForm');
const themeNameEl = document.getElementById('themeName');
const themeBaseEl = document.getElementById('themeBase');
const themeColorsEl = document.getElementById('themeColors');

/** Текущий id редактируемой темы (null — новая). */
let editingThemeId = null;

function initThemeEditor() {
  buildColorInputs();
  btnThemeAi?.addEventListener('click', onGenerateTheme);
  document.getElementById('btnNewTheme')?.addEventListener('click', () => openThemeForm(null));
  document.getElementById('btnThemePreview')?.addEventListener('click', previewDraftTheme);
  document.getElementById('btnThemeSave')?.addEventListener('click', saveDraftTheme);
  document.getElementById('btnThemeCancel')?.addEventListener('click', closeThemeForm);
}

/** Создаёт поля цвет+hex по каждой переменной темы. */
function buildColorInputs() {
  if (!themeColorsEl) return;
  themeColorsEl.innerHTML = '';
  for (const key of THEME_VARS) {
    const row = document.createElement('label');
    row.className = 'theme-color-row';
    row.dataset.var = key;

    const name = document.createElement('span');
    name.textContent = key;

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.dataset.role = 'swatch';

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.dataset.role = 'hex';
    hex.placeholder = '#rrggbb / rgb() / …';
    hex.spellcheck = false;

    // синхронизация пикера и текстового поля
    swatch.addEventListener('input', () => (hex.value = swatch.value));
    hex.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(hex.value)) swatch.value = hex.value;
    });

    row.append(name, swatch, hex);
    themeColorsEl.appendChild(row);
  }
}

function openThemeForm(theme) {
  editingThemeId = theme?.id || null;
  themeNameEl.value = theme?.name || '';
  themeBaseEl.value = theme?.base === 'dark' ? 'dark' : 'light';
  const vars = theme?.vars || {};
  for (const row of themeColorsEl.querySelectorAll('.theme-color-row')) {
    const key = row.dataset.var;
    const hex = row.querySelector('[data-role="hex"]');
    const swatch = row.querySelector('[data-role="swatch"]');
    hex.value = vars[key] || '';
    if (/^#[0-9a-f]{6}$/i.test(vars[key] || '')) swatch.value = vars[key];
  }
  themeForm.hidden = false;
}

function closeThemeForm() {
  themeForm.hidden = true;
  editingThemeId = null;
  applyTheme(themeSelect.value); // откат возможного предпросмотра
}

/** Собирает тему из полей редактора. */
function readDraftTheme() {
  const vars = {};
  for (const row of themeColorsEl.querySelectorAll('.theme-color-row')) {
    const val = row.querySelector('[data-role="hex"]').value.trim();
    if (val) vars[row.dataset.var] = val;
  }
  return {
    id: editingThemeId || undefined,
    name: themeNameEl.value.trim() || 'Моя тема',
    base: themeBaseEl.value === 'dark' ? 'dark' : 'light',
    vars,
  };
}

async function onGenerateTheme() {
  const idea = themeIdea.value.trim();
  if (!idea) {
    flash2(themeAiNote, 'Напиши описание темы', 'err');
    return;
  }
  btnThemeAi.disabled = true;
  flash2(themeAiNote, 'Генерирую тему…', '');
  try {
    const theme = await generateTheme(idea, read());
    openThemeForm({ ...theme, id: null });
    previewDraftTheme();
    const note = theme.dropped.length
      ? `Готово. Пропущено небезопасных значений: ${theme.dropped.length}. Проверь и сохрани.`
      : 'Готово — проверь цвета и сохрани.';
    flash2(themeAiNote, note, 'ok');
  } catch (err) {
    flash2(themeAiNote, err?.message || String(err), 'err');
  } finally {
    btnThemeAi.disabled = false;
  }
}

/** Применить черновик к странице настроек на лету (без сохранения). */
async function previewDraftTheme() {
  const draft = readDraftTheme();
  const tmpId = '__preview__';
  await saveCustomTheme({ ...draft, id: tmpId, name: draft.name });
  await loadThemes();
  applyTheme(tmpId);
  // временную тему держим только для превью — удалим при сохранении/отмене
}

async function saveDraftTheme() {
  const draft = readDraftTheme();
  try {
    await removeCustomTheme('__preview__');
    const theme = await saveCustomTheme(draft);
    await loadThemes();
    await populateThemeSelect();
    await renderCustomThemes();
    themeSelect.value = theme.id;
    applyTheme(theme.id);
    syncThemeSwitch(theme.id);
    await saveSettings({ theme: theme.id });
    themeForm.hidden = true;
    editingThemeId = null;
    flash(saveStatus, `Тема «${theme.name}» сохранена и применена`, 'ok');
  } catch (err) {
    flash(saveStatus, err?.message || String(err), 'err');
  }
}

/** Список пользовательских тем: редактировать / удалить. */
async function renderCustomThemes() {
  const box = document.getElementById('customThemeList');
  if (!box) return;
  const custom = (await getCustomThemes()).filter((t) => t.id !== '__preview__');
  box.innerHTML = '';
  if (!custom.length) return;

  for (const t of custom) {
    const row = document.createElement('div');
    row.className = 'theme-row';
    const label = document.createElement('span');
    label.textContent = `${t.name} (${t.base})`;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Изменить';
    edit.onclick = () => openThemeForm(t);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'theme-del';
    del.textContent = 'Удалить';
    del.onclick = async () => {
      await removeCustomTheme(t.id);
      const settings = await getSettings();
      if (settings.theme === t.id) await saveSettings({ theme: SYSTEM_THEME_ID });
      await loadThemes();
      await populateThemeSelect();
      await renderCustomThemes();
      applyTheme((await getSettings()).theme);
    };
    row.append(label, edit, del);
    box.appendChild(row);
  }
}

function flash2(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = cls ? `note ${cls}` : 'note';
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

  // Автономный режим доступен только при включённом выполнении JS
  const evalOn = document.getElementById('enableEvalJs')?.checked;
  const auto = document.getElementById('autonomousMode');
  if (auto) {
    auto.disabled = !evalOn;
    if (!evalOn) auto.checked = false;
    auto.closest('.check').style.opacity = evalOn ? '' : '0.5';
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
    enableEvalJs: document.getElementById('enableEvalJs').checked,
    autonomousMode: document.getElementById('autonomousMode').checked,
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
