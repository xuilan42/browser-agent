/**
 * «Сетевой терминал» поверх fetch — безопасная замена части консольных команд.
 * Настоящий shell из расширения недоступен (песочница Chrome), поэтому это
 * HTTP-инструменты: запрос (curl-лайт), http-ping (доступность+время), заголовки,
 * DNS через публичный resolver. ICMP-пинг и системные утилиты недоступны.
 */

const DEFAULT_TIMEOUT = 15000;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

/** curl-лайт: запрос с методом/заголовками/телом, возврат статуса и тела. */
export async function httpRequest(opts = {}) {
  const url = normalizeUrl(opts.url);
  if (!url) return { ok: false, error: 'Укажи url' };

  const method = String(opts.method || 'GET').toUpperCase();
  const maxChars = Math.min(Number(opts.maxChars) || 8000, 30000);
  const { signal, done } = withTimeout(Number(opts.timeoutMs) || DEFAULT_TIMEOUT);
  const started = Date.now();

  try {
    const init = { method, signal, redirect: 'follow' };
    if (opts.headers && typeof opts.headers === 'object') init.headers = opts.headers;
    if (opts.body != null && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    const ms = Date.now() - started;
    let body = '';
    if (method !== 'HEAD') {
      body = await res.text().catch(() => '');
      if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…[truncated]';
    }
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      timeMs: ms,
      headers: headersToObject(res.headers),
      body,
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'таймаут' : err?.message || String(err), url };
  } finally {
    done();
  }
}

/** HTTP-«пинг»: несколько запросов, статус и время ответа (не ICMP). */
export async function httpPing(opts = {}) {
  const url = normalizeUrl(opts.url);
  if (!url) return { ok: false, error: 'Укажи url' };
  const count = Math.min(Math.max(Number(opts.count) || 3, 1), 10);
  const times = [];
  let status = 0;
  let lastError = '';

  for (let i = 0; i < count; i++) {
    const { signal, done } = withTimeout(Number(opts.timeoutMs) || 8000);
    const t0 = Date.now();
    try {
      // HEAD дешевле; если сервер его не любит — ответит статусом, нам важно время
      const res = await fetch(url, { method: 'HEAD', signal, redirect: 'follow' });
      status = res.status;
      times.push(Date.now() - t0);
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? 'таймаут' : err?.message || String(err);
      times.push(null);
    } finally {
      done();
    }
  }

  const ok = times.filter((t) => t != null);
  const lost = times.length - ok.length;
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
  return {
    ok: ok.length > 0,
    url,
    status,
    sent: count,
    received: ok.length,
    lostPct: Math.round((lost / count) * 100),
    minMs: ok.length ? Math.min(...ok) : null,
    maxMs: ok.length ? Math.max(...ok) : null,
    avgMs: avg,
    error: ok.length ? undefined : lastError || 'нет ответа',
  };
}

/** Только заголовки ответа (аналог curl -I). */
export async function httpHeaders(opts = {}) {
  const res = await httpRequest({ ...opts, method: 'HEAD', maxChars: 0 });
  if (!res.ok) {
    // некоторые серверы не поддерживают HEAD — пробуем GET только ради заголовков
    const g = await httpRequest({ ...opts, method: 'GET', maxChars: 0 });
    return g.ok ? { ok: true, status: g.status, url: g.url, headers: g.headers } : res;
  }
  return { ok: true, status: res.status, url: res.url, headers: res.headers };
}

/** DNS-резолв через публичный DoH-резолвер Google (системный dig/nslookup недоступен). */
export async function dnsLookup(opts = {}) {
  const name = String(opts.name || opts.host || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
  if (!name) return { ok: false, error: 'Укажи имя хоста' };
  const type = String(opts.recordType || opts.type || 'A').toUpperCase();
  const { signal, done } = withTimeout(Number(opts.timeoutMs) || 8000);
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { signal, headers: { Accept: 'application/dns-json' } }
    );
    if (!res.ok) return { ok: false, error: `DNS HTTP ${res.status}`, name };
    const data = await res.json();
    const answers = (data.Answer || []).map((a) => ({ name: a.name, type: a.type, ttl: a.TTL, data: a.data }));
    return { ok: true, name, type, answers, status: data.Status };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'таймаут' : err?.message || String(err), name };
  } finally {
    done();
  }
}

/**
 * Поддомены из публичных логов Certificate Transparency (crt.sh).
 * Пассивный источник: разбирает уже выданные TLS-сертификаты, не брутфорс и не скан.
 */
export async function subdomains(opts = {}) {
  const domain = String(opts.name || opts.host || opts.domain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .replace(/^\*\.?/, '');
  if (!domain) return { ok: false, error: 'Укажи домен (name)' };

  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const { signal, done } = withTimeout(Number(opts.timeoutMs) || 20000);
  try {
    const res = await fetch(
      `https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`,
      { signal, headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return { ok: false, error: `crt.sh HTTP ${res.status}`, domain };
    const data = await res.json().catch(() => []);
    const set = new Set();
    for (const row of Array.isArray(data) ? data : []) {
      const names = String(row.name_value || '').split('\n');
      for (let n of names) {
        n = n.trim().toLowerCase().replace(/^\*\.?/, '');
        if (n && (n === domain || n.endsWith(`.${domain}`))) set.add(n);
      }
      if (set.size >= limit) break;
    }
    const found = [...set].sort();
    return {
      ok: true,
      domain,
      count: found.length,
      subdomains: found.slice(0, limit),
      note: 'Источник: публичные логи Certificate Transparency (crt.sh). Это не полный список: только домены из выданных сертификатов.',
    };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'таймаут' : err?.message || String(err), domain };
  } finally {
    done();
  }
}

/** Диспетчер подкоманд сетевого терминала. */
export async function runNetCmd(message = {}) {
  const cmd = String(message.cmd || message.command || '').toLowerCase();
  switch (cmd) {
    case 'http':
    case 'curl':
    case 'request':
      return httpRequest(message);
    case 'ping':
      return httpPing(message);
    case 'headers':
    case 'head':
      return httpHeaders(message);
    case 'dns':
    case 'lookup':
    case 'nslookup':
      return dnsLookup(message);
    case 'subdomains':
    case 'subs':
      return subdomains(message);
    default:
      return {
        ok: false,
        error: `Неизвестная команда: ${cmd || '(пусто)'}. Доступно: http, ping, headers, dns, subdomains`,
      };
  }
}
