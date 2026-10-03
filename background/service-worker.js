/**
 * Service worker: боковая панель, контекст страницы, действия, веб-поиск.
 */

import { webSearch, fetchUrlText, extractSearchResultsFromPage } from '../lib/search.js';

/** @type {number|null} */
let lastPageTabId = null;

// Клик по иконке открывает боковую панель Chrome (panel/index.html).
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('Browser Agent: sidePanel behavior', err));
}

// Резервный путь, если setPanelBehavior недоступен или не сработал.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn('Browser Agent: sidePanel open', err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_PAGE_CONTEXT') {
    resolveTab({ tabId: message.tabId, windowId: message.windowId })
      .then((tab) => getPageContext(tab, { withScreenshot: Boolean(message.withScreenshot) }))
      .then((context) => {
        if (context?.tabId) lastPageTabId = context.tabId;
        sendResponse({ ok: true, context });
      })
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'RUN_PAGE_ACTION') {
    const tabId = message.tabId || lastPageTabId;
    runPageAction(tabId, message.action)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'SEARCH_WEB') {
    webSearch(message.query, {
      limit: message.limit,
      searchInTab: searchViaBrowserTab,
    })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'FETCH_URL') {
    fetchUrlText(message.url, { maxChars: message.maxChars })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === 'OPEN_URL') {
    openUrl(message.url, {
      tabId: message.tabId || lastPageTabId,
      newTab: Boolean(message.newTab),
    })
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  return false;
});

function isInjectableUrl(url) {
  if (!url) return false;
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  ) {
    return false;
  }
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Выбирает вкладку, к которой относится запрос из боковой панели.
 * Панель живёт в своём окне и передаёт windowId — берём активную вкладку этого окна.
 * @param {{ tabId?: number, windowId?: number }} [opts]
 */
async function resolveTab({ tabId, windowId } = {}) {
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && isInjectableUrl(tab.url || '')) return tab;
    } catch {
      /* ignore */
    }
  }

  // Активная вкладка окна, в котором открыта панель.
  if (windowId != null) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab) return tab;
    } catch {
      /* ignore */
    }
  }

  if (lastPageTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastPageTabId);
      if (tab && isInjectableUrl(tab.url || '')) return tab;
    } catch {
      lastPageTabId = null;
    }
  }

  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const others = await chrome.tabs.query({ active: true });
  const candidates = [...focused, ...others.filter((t) => !focused.some((f) => f.id === t.id))];
  return (
    candidates.find((t) => t.url && isInjectableUrl(t.url)) || candidates[0] || null
  );
}

async function getPageContext(tab, { withScreenshot = false } = {}) {
  if (!tab?.id) return null;

  const url = tab.url || '';
  if (!isInjectableUrl(url)) {
    return {
      tabId: tab.id,
      url,
      title: tab.title || '',
      text: '',
      selection: '',
      restricted: true,
    };
  }

  // после клика или навигации страница может ещё грузиться
  if (tab.status === 'loading') {
    await waitForTabLoad(tab.id, 6000);
    await delay(150);
  }

  let snapshot = {};
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/extract.js'],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        typeof window.__browserAgentExtract === 'function'
          ? window.__browserAgentExtract()
          : null,
    });
    snapshot = result || {};
  } catch (err) {
    console.warn('Browser Agent: extract failed', err);
    return {
      tabId: tab.id,
      url,
      title: tab.title || '',
      text: '',
      selection: '',
      restricted: true,
      error: err?.message || String(err),
    };
  }

  /** @type {string|null} */
  let screenshot = null;
  // captureVisibleTab снимает только активную вкладку окна
  if (withScreenshot && tab.active && tab.windowId != null) {
    try {
      await setMarks(tab.id, true);
      await delay(80);
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 70,
      });
      screenshot = await downscaleDataUrl(raw, 1280);
    } catch (err) {
      console.warn('Browser Agent: screenshot failed', err);
    } finally {
      await setMarks(tab.id, false);
    }
  }

  return {
    tabId: tab.id,
    url: snapshot.url || url,
    title: snapshot.title || tab.title || '',
    lang: snapshot.lang || '',
    description: snapshot.description || '',
    selection: snapshot.selection || '',
    headings: snapshot.headings || [],
    links: snapshot.links || [],
    buttons: snapshot.buttons || [],
    inputs: snapshot.inputs || [],
    images: snapshot.images || [],
    interactive: snapshot.interactive || [],
    text: snapshot.text || '',
    viewport: snapshot.viewport || '',
    scrollY: snapshot.scrollY ?? 0,
    scrollMax: snapshot.scrollMax ?? 0,
    screenshot,
    restricted: false,
  };
}

async function runPageAction(preferredTabId, action) {
  const tab = await resolveTab({ tabId: preferredTabId });
  if (!tab?.id) return { ok: false, error: 'Вкладка не найдена' };
  if (!isInjectableUrl(tab.url || '')) {
    return { ok: false, error: 'На этой вкладке действия недоступны' };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/actions.js'],
    });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (act) => {
        if (typeof window.__browserAgentAction !== 'function') {
          return { ok: false, error: 'actions.js не загружен' };
        }
        return window.__browserAgentAction(act);
      },
      args: [action],
    });
    lastPageTabId = tab.id;
    return result || { ok: false, error: 'Пустой результат действия' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function openUrl(url, { tabId = null, newTab = false } = {}) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) {
    return { ok: false, error: 'URL должен начинаться с http(s)://' };
  }

  try {
    if (newTab || !tabId) {
      const tab = await chrome.tabs.create({ url: href, active: true });
      if (tab?.id) {
        lastPageTabId = tab.id;
        await waitForTabLoad(tab.id, 10000);
      }
      return { ok: true, result: `opened new tab`, url: href, tabId: tab?.id };
    }
    await chrome.tabs.update(tabId, { url: href, active: true });
    lastPageTabId = tabId;
    // сразу после update статус ещё может быть 'complete' от старой страницы
    await delay(300);
    await waitForTabLoad(tabId, 10000);
    return { ok: true, result: `navigated tab`, url: href, tabId };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), url: href };
  }
}

/**
 * Открывает поиск во фоновой вкладке и парсит выдачу из DOM —
 * так обходим блокировку fetch/anomaly у DuckDuckGo.
 */
async function searchViaBrowserTab(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];

  const urls = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=ru`,
  ];

  for (const searchUrl of urls) {
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url: searchUrl, active: false });
      tabId = tab.id;
      if (!tabId) continue;

      await waitForTabLoad(tabId, 12000);
      await delay(900);

      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractSearchResultsFromPage,
        args: [limit],
      });

      const list = Array.isArray(result) ? result : [];
      if (list.length) return list;
    } catch (err) {
      console.warn('Browser Agent searchViaBrowserTab', err);
    } finally {
      if (tabId != null) await safeRemoveTab(tabId);
    }
  }

  return [];
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        finish();
      }
    }
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') {
        clearTimeout(timer);
        finish();
      }
    }).catch(finish);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function safeRemoveTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already closed */
  }
}

async function setMarks(tabId, show) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (flag) => (typeof window.__browserAgentMarks === 'function' ? window.__browserAgentMarks(flag) : 0),
      args: [show],
    });
  } catch {
    /* страница могла уйти на другой адрес */
  }
}

/** Уменьшает скриншот: меньше токенов у vision-моделей и быстрее запрос. */
async function downscaleDataUrl(dataUrl, maxWidth) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width <= maxWidth) {
      bitmap.close();
      return dataUrl;
    }
    const width = maxWidth;
    const height = Math.round((bitmap.height * maxWidth) / bitmap.width);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch (err) {
    console.warn('Browser Agent: downscale failed', err);
    return dataUrl;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
