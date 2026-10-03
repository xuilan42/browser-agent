/**
 * Поиск в интернете:
 * 1) Wikipedia (ru/en) — стабильно, без капчи
 * 2) DuckDuckGo Instant Answer (EN)
 * 3) Поиск через фоновую вкладку браузера (DuckDuckGo HTML, затем Bing)
 */

/**
 * @param {string} query
 * @param {{ limit?: number, signal?: AbortSignal, searchInTab?: (q: string, limit: number) => Promise<object[]> }} [opts]
 */
export async function webSearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Пустой запрос' };

  const limit = Math.min(Math.max(Number(opts.limit) || 6, 1), 10);
  const signal = opts.signal;

  const errors = [];
  /** @type {object[]} */
  let results = [];
  let abstract = '';
  let abstractSource = '';
  let abstractUrl = '';
  const providers = [];

  // 1) Wikipedia
  try {
    const wiki = await searchWikipedia(q, limit, signal);
    if (wiki.abstract) {
      abstract = wiki.abstract;
      abstractSource = wiki.abstractSource;
      abstractUrl = wiki.abstractUrl;
      providers.push('wikipedia');
    }
    mergeResults(results, wiki.results);
  } catch (err) {
    errors.push(`wikipedia: ${err?.message || err}`);
  }

  // 2) DDG Instant Answer (часто пусто на RU, но полезно на EN)
  try {
    const instant = await searchInstantAnswer(q, signal);
    if (instant?.abstract && !abstract) {
      abstract = instant.abstract;
      abstractSource = instant.abstractSource || 'DuckDuckGo';
      abstractUrl = instant.abstractUrl || '';
      providers.push('duckduckgo-ia');
    }
    if (instant?.related?.length) mergeResults(results, instant.related);
  } catch (err) {
    errors.push(`ddg-ia: ${err?.message || err}`);
  }

  // 3) Органика через вкладку браузера (если передали хелпер) или fetch fallback
  if (results.length < 3) {
    try {
      if (typeof opts.searchInTab === 'function') {
        const organic = await opts.searchInTab(q, limit);
        if (organic?.length) providers.push('browser-tab');
        mergeResults(results, organic || []);
      }
    } catch (err) {
      errors.push(`organic: ${err?.message || err}`);
    }
  }

  results = results.slice(0, limit);

  if (!results.length && !abstract) {
    return {
      ok: false,
      error:
        errors[0] ||
        'Ничего не найдено. Попробуй уточнить запрос (например: «Павел Дуров») или повторить.',
      query: q,
      errors,
    };
  }

  return {
    ok: true,
    query: q,
    provider: providers.join('+') || 'mixed',
    abstract,
    abstractSource,
    abstractUrl,
    results,
  };
}

/**
 * Скачать и вытащить читаемый текст со страницы.
 */
export async function fetchUrlText(url, opts = {}) {
  const href = String(url || '').trim();
  if (!/^https?:\/\//i.test(href)) {
    return { ok: false, error: 'URL должен начинаться с http(s)://' };
  }

  const signal = opts.signal;
  const maxChars = Math.min(Number(opts.maxChars) || 12000, 30000);

  try {
    const res = await fetch(href, {
      method: 'GET',
      signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, url: href };
    }
    const ctype = res.headers.get('content-type') || '';
    if (!/html|text|xml|json/i.test(ctype) && ctype) {
      return { ok: false, error: `Неподдерживаемый тип: ${ctype}`, url: href };
    }

    const raw = await res.text();
    if (/json/i.test(ctype)) {
      return { ok: true, url: href, title: 'JSON', text: raw.slice(0, maxChars) };
    }

    return { ok: true, url: href, ...parseHtmlDocument(raw, href, maxChars) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), url: href };
  }
}

async function searchWikipedia(query, limit, signal) {
  const langs = detectLangs(query);
  /** @type {object[]} */
  const results = [];
  let abstract = '';
  let abstractSource = '';
  let abstractUrl = '';
  const headers = {
    Accept: 'application/json',
    'Api-User-Agent': 'BrowserAgent/0.6 (Chrome extension; local use)',
  };

  for (const lang of langs) {
    const openUrl =
      `https://${lang}.wikipedia.org/w/api.php?action=opensearch` +
      `&search=${encodeURIComponent(query)}&limit=${limit}&namespace=0&format=json&origin=*`;
    const res = await fetch(openUrl, { signal, headers });
    if (!res.ok) continue;
    const data = await res.json();
    const titles = data[1] || [];
    const urls = data[3] || [];

    for (let i = 0; i < titles.length; i++) {
      results.push({
        title: titles[i],
        url: urls[i],
        snippet: `Wikipedia (${lang})`,
      });
    }

    if (!abstract && titles[0]) {
      const summary = await fetchWikiSummary(lang, titles[0], signal);
      if (summary?.extract) {
        abstract = summary.extract;
        abstractSource = `Wikipedia (${lang})`;
        abstractUrl = summary.content_urls?.desktop?.page || urls[0] || '';
      }
    }

    if (results.length >= limit && abstract) break;
  }

  return {
    abstract,
    abstractSource,
    abstractUrl,
    results: results.slice(0, limit),
  };
}

async function fetchWikiSummary(lang, title, signal) {
  const url =
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
    encodeURIComponent(title.replace(/ /g, '_'));
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'Api-User-Agent': 'BrowserAgent/0.6 (Chrome extension; local use)',
    },
  });
  if (!res.ok) return null;
  return res.json();
}

function detectLangs(query) {
  if (/[а-яё]/i.test(query)) return ['ru', 'en'];
  return ['en', 'ru'];
}

async function searchInstantAnswer(query, signal) {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
    `&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();

  const related = [];
  for (const item of data.RelatedTopics || []) {
    if (item.Topics) {
      for (const sub of item.Topics) pushRelated(related, sub);
    } else {
      pushRelated(related, item);
    }
    if (related.length >= 6) break;
  }

  return {
    abstract: String(data.AbstractText || '').trim(),
    abstractSource: String(data.AbstractSource || '').trim(),
    abstractUrl: String(data.AbstractURL || '').trim(),
    related,
  };
}

function pushRelated(list, item) {
  if (!item?.FirstURL || !item?.Text) return;
  list.push({
    title: String(item.Text).split(' - ')[0].slice(0, 120),
    url: item.FirstURL,
    snippet: String(item.Text).slice(0, 240),
  });
}

/** Парсер результатов со страницы поиска (инжектится во вкладку). */
export function extractSearchResultsFromPage(limit = 6) {
  const host = location.hostname;
  /** @type {{ title: string, url: string, snippet: string }[]} */
  const results = [];

  const push = (title, href, snippet = '') => {
    if (!title || !href) return;
    if (href.startsWith('/')) {
      try {
        href = new URL(href, location.origin).href;
      } catch {
        return;
      }
    }
    if (!/^https?:/i.test(href)) return;
    if (/duckduckgo\.com\/(y\.js|anomaly)/i.test(href)) return;
    if (results.some((r) => r.url === href)) return;
    results.push({
      title: title.replace(/\s+/g, ' ').trim().slice(0, 160),
      url: href,
      snippet: String(snippet || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240),
    });
  };

  if (host.includes('duckduckgo.com')) {
    document.querySelectorAll('[data-testid="result"], article[data-testid="result"], .result, .results_links').forEach((el) => {
      const a =
        el.querySelector('a[data-testid="result-title-a"]') ||
        el.querySelector('h2 a') ||
        el.querySelector('a.result__a') ||
        el.querySelector('a[href]');
      const sn =
        el.querySelector('[data-result="snippet"]') ||
        el.querySelector('.result__snippet') ||
        el.querySelector('span[class*="snippet"]');
      if (a) push(a.textContent || '', a.href, sn?.textContent || '');
    });
    // lite
    document.querySelectorAll('a.result-link').forEach((a) => {
      const row = a.closest('tr') || a.parentElement;
      const sn = row?.querySelector('.result-snippet');
      push(a.textContent || '', a.href, sn?.textContent || '');
    });
  }

  if (host.includes('google.')) {
    document.querySelectorAll('#search a h3').forEach((h3) => {
      const a = h3.closest('a');
      if (!a) return;
      const block = a.closest('div')?.parentElement;
      const sn = block?.querySelector('[data-sncf], .VwiC3b, .IsZvec');
      push(h3.textContent || '', a.href, sn?.textContent || '');
    });
  }

  if (host.includes('bing.com')) {
    document.querySelectorAll('li.b_algo').forEach((li) => {
      const a = li.querySelector('h2 a');
      const sn = li.querySelector('.b_caption p');
      if (a) push(a.textContent || '', a.href, sn?.textContent || '');
    });
  }

  return results.slice(0, limit);
}

function mergeResults(target, incoming) {
  for (const item of incoming || []) {
    if (!item?.url || !item?.title) continue;
    if (target.some((r) => r.url === item.url)) continue;
    target.push(item);
  }
}

function parseHtmlDocument(html, url, maxChars) {
  // В service worker нет DOMParser/innerText — чистим HTML регулярками
  const title = decodeEntities(
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim()
  );
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, ' ');
  const main =
    /<article\b[\s\S]*?<\/article>/i.exec(body)?.[0] ||
    /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  if (main) body = main;

  let text = decodeEntities(
    body
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…[truncated]';
  return { title: title || url, text };
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…' };
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return named[e.toLowerCase()] ?? m;
  });
}
