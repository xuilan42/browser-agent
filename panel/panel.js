import {
  getHistory,
  saveHistory,
  clearHistory,
  getSettings,
  saveSettings,
  onSettingsChanged,
  getInjectionsForUrl,
  removeInjection,
} from '../lib/storage.js';
import { runAgent } from '../lib/agent.js';
import { applyTheme, resolveTheme, watchSystemTheme } from '../lib/theme.js';
import { summarizeContextMeta } from '../lib/page.js';
import { renderMarkdown } from '../lib/markdown.js';
import { labelAction } from '../lib/tools.js';

const chatEl = document.getElementById('chat');
const inputEl = document.getElementById('input');
const btnSend = document.getElementById('btnSend');
const btnClear = document.getElementById('btnClear');
const btnDraw = document.getElementById('btnDraw');
const btnPersist = document.getElementById('btnPersist');
const persistPanel = document.getElementById('persistPanel');
const persistList = document.getElementById('persistList');
const btnPersistClose = document.getElementById('btnPersistClose');
const btnSettings = document.getElementById('btnSettings');
const btnTheme = document.getElementById('btnTheme');
const pageHint = document.getElementById('pageHint');
const statusHint = document.getElementById('statusHint');
const confirmBar = document.getElementById('confirmBar');
const confirmText = document.getElementById('confirmText');
const btnAllow = document.getElementById('btnAllow');
const btnDeny = document.getElementById('btnDeny');

/** @type {{ id: string, role: 'user'|'assistant'|'error', content: string }[]} */
let messages = [];
let busy = false;
/** @type {AbortController|null} */
let abortCtrl = null;
/** Окно браузера, в котором открыта панель: из него берём активную вкладку */
let windowId = null;
let hintTimer = 0;
/** @type {'light'|'dark'|'system'} */
let themePref = 'system';

init();

async function init() {
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {
    windowId = null;
  }
  const settings = await getSettings();
  themePref = settings.theme || 'system';
  applyTheme(themePref);
  watchSystemTheme(async () => themePref);

  messages = await getHistory();
  render();
  await refreshPageHint();

  btnSend.addEventListener('click', () => {
    if (busy) {
      abortCtrl?.abort();
      return;
    }
    onSend();
  });
  btnClear.addEventListener('click', onClear);
  btnDraw.addEventListener('click', onToggleDraw);
  btnPersist.addEventListener('click', togglePersistPanel);
  btnPersistClose.addEventListener('click', () => (persistPanel.hidden = true));
  btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  btnTheme.addEventListener('click', cycleTheme);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy) onSend();
    }
  });

  inputEl.addEventListener('input', autosize);
  autosize();
  inputEl.focus();
  watchTabs();

  onSettingsChanged((next) => {
    themePref = next.theme || 'system';
    applyTheme(themePref);
  });
}

async function cycleTheme() {
  const resolved = resolveTheme(themePref);
  const next = resolved === 'dark' ? 'light' : 'dark';
  themePref = next;
  applyTheme(next);
  await saveSettings({ theme: next });
}

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 120)}px`;
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function render() {
  chatEl.innerHTML = '';

  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML =
      '<strong>Спроси что угодно</strong>«чё на странице», «пролистай», «найди в инете …» — агент смотрит, действует и ищет.';
    chatEl.appendChild(empty);
    return;
  }

  for (const m of messages) {
    chatEl.appendChild(messageNode(m));
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function messageNode(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'error' ? 'error' : m.role}`;
  el.dataset.id = m.id;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent =
    m.role === 'user' ? 'you' : m.role === 'assistant' ? 'agent' : 'error';

  const body = document.createElement('div');
  body.className = 'body';
  setMessageBody(body, m.role, m.content, { streaming: false });

  el.append(meta, body);
  return el;
}

function setMessageBody(node, role, content, { streaming = false } = {}) {
  if (role === 'assistant' && !streaming) {
    node.classList.add('md');
    node.innerHTML = renderMarkdown(content || '');
  } else {
    node.classList.remove('md');
    node.textContent = content || '';
  }
}

/** Панель живёт при переключении вкладок — подсказка «что вижу» следует за активной вкладкой. */
function watchTabs() {
  const schedule = (winId) => {
    if (windowId != null && winId != null && winId !== windowId) return;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      // во время работы агента не трогаем страницу лишним снимком: он перенумеровал бы ref
      if (!busy) refreshPageHint();
    }, 400);
  };
  chrome.tabs.onActivated.addListener((info) => schedule(info.windowId));
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.status === 'complete' || info.url)) schedule(tab.windowId);
  });
  chrome.windows.onFocusChanged.addListener((id) => {
    if (id !== chrome.windows.WINDOW_ID_NONE) schedule(id);
  });
}

/** Запрос подтверждения прямо в панели (window.confirm в боковой панели ненадёжен). */
function askConfirm(reason) {
  return new Promise((resolve) => {
    const signal = abortCtrl?.signal;
    const finish = (value) => {
      confirmBar.hidden = true;
      btnAllow.onclick = null;
      btnDeny.onclick = null;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort);
    confirmText.textContent = `Агент хочет выполнить ${reason}. Разрешить?`;
    confirmBar.hidden = false;
    btnAllow.onclick = () => finish(true);
    btnDeny.onclick = () => finish(false);
  });
}

async function getPageContext({ withScreenshot = false, tabId } = {}) {
  try {
    const settings = await getSettings();
    const wantShot = withScreenshot && settings.includeScreenshot !== false;
    const res = await chrome.runtime.sendMessage({
      type: 'GET_PAGE_CONTEXT',
      withScreenshot: wantShot,
      tabId,
      windowId,
    });
    if (res?.ok) return res.context;
  } catch {
    /* ignore */
  }
  return null;
}

async function refreshPageHint() {
  const ctx = await getPageContext({ withScreenshot: false });
  const meta = summarizeContextMeta(ctx);
  pageHint.textContent = meta.label;
  pageHint.classList.toggle('ok', meta.ok);
  pageHint.classList.toggle('bad', !meta.ok);
  pageHint.title = ctx?.url || ctx?.title || '';
}

async function onSend() {
  const text = inputEl.value.trim();
  if (!text || busy) return;

  inputEl.value = '';
  autosize();

  const userMsg = { id: uid(), role: 'user', content: text };
  messages.push(userMsg);
  render();
  await saveHistory(messages.filter((m) => m.role !== 'error'));

  const assistantMsg = { id: uid(), role: 'assistant', content: '' };
  messages.push(assistantMsg);
  render();
  const node = chatEl.querySelector(`[data-id="${assistantMsg.id}"] .body`);
  if (node) node.classList.add('typing');
  /** Лента шагов агента: что он делает на странице */
  let stepsEl = null;
  let stepLine = null;
  if (node?.parentElement) {
    stepsEl = document.createElement('div');
    stepsEl.className = 'steps';
    node.parentElement.insertBefore(stepsEl, node);
  }

  setBusy(true);
  abortCtrl = new AbortController();

  try {
    statusHint.textContent = 'Смотрю страницу…';
    // Каждый запрос заново читает вкладку — в т.ч. «чё на этой странице»
    const pageContext = await getPageContext({ withScreenshot: true });
    const meta = summarizeContextMeta(pageContext);
    pageHint.textContent = meta.label;
    pageHint.classList.toggle('ok', meta.ok);
    pageHint.classList.toggle('bad', !meta.ok);

    const historyForApi = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(0, -1)
      .map(({ role, content }) => ({ role, content }));

    statusHint.textContent = 'Агент думает… нажми ■ чтобы остановить';

    const reply = await runAgent({
      history: historyForApi,
      userText: text,
      pageContext,
      opts: {
        signal: abortCtrl.signal,
        refreshContext: (o) => getPageContext(o),
        confirmAction: ({ reason }) => askConfirm(reason),
        onStatus: (s) => {
          statusHint.textContent = s;
        },
        onAction: ({ phase, action, result }) => {
          if (phase === 'start') {
            statusHint.textContent = `Делаю: ${labelAction(action)}…`;
            if (stepsEl) {
              stepLine = document.createElement('div');
              stepLine.className = 'step run';
              stepLine.textContent = labelAction(action);
              stepsEl.appendChild(stepLine);
              chatEl.scrollTop = chatEl.scrollHeight;
            }
          } else if (phase === 'done') {
            statusHint.textContent = result?.ok
              ? `Ок: ${result.result || action.tool}`
              : `Ошибка: ${result?.error || action.tool}`;
            if (stepLine) {
              stepLine.className = `step ${result?.ok ? 'ok' : 'err'}`;
              if (!result?.ok && result?.error) stepLine.title = result.error;
              stepLine = null;
            }
          }
        },
        onDelta: (chunk) => {
          assistantMsg.content += chunk;
          if (node) {
            setMessageBody(node, 'assistant', assistantMsg.content, { streaming: true });
            chatEl.scrollTop = chatEl.scrollHeight;
          }
        },
      },
    });

    if (!assistantMsg.content) assistantMsg.content = reply;
    if (node) {
      node.classList.remove('typing');
      setMessageBody(node, 'assistant', assistantMsg.content, { streaming: false });
    }
    await saveHistory(messages.filter((m) => m.role !== 'error'));
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      if (!assistantMsg.content) {
        messages = messages.filter((m) => m.id !== assistantMsg.id);
        messages.push({
          id: uid(),
          role: 'error',
          content: err?.name === 'TimeoutError' ? 'Таймаут запроса к API' : 'Генерация остановлена',
        });
      } else if (node) {
        node.classList.remove('typing');
        setMessageBody(node, 'assistant', assistantMsg.content, { streaming: false });
      }
      render();
      await saveHistory(messages.filter((m) => m.role !== 'error' && m.content));
      return;
    }

    messages = messages.filter((m) => m.id !== assistantMsg.id);
    messages.push({
      id: uid(),
      role: 'error',
      content: err?.message || String(err),
    });
    render();
  } finally {
    setBusy(false);
    abortCtrl = null;
    refreshPageHint();
  }
}

async function onClear() {
  if (busy && abortCtrl) abortCtrl.abort();
  messages = [];
  await clearHistory();
  render();
  statusHint.textContent = 'Чат очищен';
  setTimeout(() => {
    if (!busy) statusHint.textContent = 'Enter — отправить · Shift+Enter — новая строка';
  }, 1500);
}

/** Ручной режим рисования: включает/выключает canvas-оверлей на активной вкладке. */
async function onToggleDraw() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_DRAW', windowId });
    if (res?.ok) {
      const on = /on/.test(res.result || '');
      btnDraw.classList.toggle('active', on);
      flashHint(on ? 'Режим рисования включён — рисуй на странице' : 'Режим рисования выключен');
    } else {
      flashHint(res?.error || 'Не удалось включить рисование');
    }
  } catch (err) {
    flashHint(err?.message || String(err));
  }
}

function flashHint(text) {
  statusHint.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    if (!busy) statusHint.textContent = 'Enter — отправить · Shift+Enter — новая строка';
  }, 2000);
}

/** Активная вкладка окна, в котором открыта панель. */
async function activeTab() {
  try {
    const q = windowId != null ? { active: true, windowId } : { active: true, lastFocusedWindow: true };
    const [tab] = await chrome.tabs.query(q);
    return tab || null;
  } catch {
    return null;
  }
}

async function togglePersistPanel() {
  if (!persistPanel.hidden) {
    persistPanel.hidden = true;
    return;
  }
  await renderPersistList();
  persistPanel.hidden = false;
}

async function renderPersistList() {
  const tab = await activeTab();
  const items = tab?.url ? await getInjectionsForUrl(tab.url) : [];
  persistList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'persist-empty';
    empty.textContent = 'Для этой страницы нет сохранённых элементов.';
    persistList.appendChild(empty);
    return;
  }

  for (const rec of items) {
    const row = document.createElement('div');
    row.className = 'persist-item';

    const info = document.createElement('div');
    info.className = 'persist-info';
    const scope = rec.scope === 'origin' ? 'весь домен' : 'эта страница';
    info.innerHTML =
      `<span class="persist-scope">${scope}</span>` +
      `<span class="persist-sel">${escapeText(rec.selector)} · ${escapeText(rec.position)}</span>`;
    info.title = rec.html || '';

    const del = document.createElement('button');
    del.className = 'persist-del';
    del.textContent = 'Удалить';
    del.onclick = async () => {
      await removeInjection(rec.id);
      await renderPersistList();
      flashHint('Элемент удалён (обнови страницу, чтобы он исчез там)');
    };

    row.append(info, del);
    persistList.appendChild(row);
  }
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function setBusy(value) {
  busy = value;
  btnSend.classList.toggle('is-busy', value);
  btnSend.title = value ? 'Остановить' : 'Отправить';
  btnSend.setAttribute('aria-label', value ? 'Остановить' : 'Отправить');
  inputEl.disabled = value;
  if (!value) {
    statusHint.textContent = 'Enter — отправить · Shift+Enter — новая строка';
  }
}
