/**
 * Постоянные вставки: восстанавливает сохранённые элементы при каждой загрузке страницы.
 * Обычный content script (не ES-module). Правила лежат в chrome.storage.local['injections'].
 * Вставленный HTML санируется (без <script>, on*-обработчиков, javascript:-ссылок),
 * поэтому постоянная вставка не превращается в вечно исполняемый скрипт.
 */
(() => {
  if (window.__browserAgentPersistLoaded) return;
  window.__browserAgentPersistLoaded = true;

  const INJECTIONS_KEY = 'injections';
  const POSITIONS = ['beforebegin', 'afterbegin', 'beforeend', 'afterend'];

  function matchKey(url, scope) {
    try {
      const u = new URL(url);
      return scope === 'origin' ? u.origin : `${u.origin}${u.pathname}`;
    } catch {
      return '';
    }
  }

  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    tpl.content.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());
    tpl.content.querySelectorAll('*').forEach((node) => {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) node.removeAttribute(attr.name);
        else if (/^(href|src|xlink:href)$/.test(name) && /^\s*javascript:/i.test(attr.value)) {
          node.removeAttribute(attr.name);
        }
      }
    });
    return tpl.innerHTML;
  }

  function applyOne(rec) {
    if (!rec || !rec.html) return false;
    // уже вставлено на этой странице — не дублируем
    if (document.querySelector(`[data-ba-persist="${cssEscape(rec.id)}"]`)) return true;

    let target;
    try {
      target = document.querySelector(rec.selector || 'body');
    } catch {
      target = null;
    }
    if (!target) return false;

    const position = POSITIONS.includes(rec.position) ? rec.position : 'beforeend';

    // Оборачиваем вставку в контейнер с меткой, чтобы потом находить и не плодить копии
    const wrap = document.createElement('div');
    wrap.setAttribute('data-ba-persist', rec.id);
    wrap.style.display = 'contents'; // контейнер не ломает layout
    wrap.innerHTML = sanitizeHtml(rec.html);

    if (rec.css) {
      const style = document.createElement('style');
      style.setAttribute('data-ba-persist-style', rec.id);
      style.textContent = String(rec.css);
      (document.head || document.documentElement).appendChild(style);
    }

    target.insertAdjacentElement(position, wrap);
    return true;
  }

  function cssEscape(v) {
    return window.CSS?.escape ? CSS.escape(String(v)) : String(v).replace(/"/g, '\\"');
  }

  function run() {
    chrome.storage.local.get(INJECTIONS_KEY, (data) => {
      const all = (data && data[INJECTIONS_KEY]) || [];
      const url = location.href;
      const rules = all.filter((r) => r && r.match === matchKey(url, r.scope || 'url'));
      if (!rules.length) return;

      const pending = rules.filter((r) => !applyOne(r));
      if (!pending.length) return;

      // Нужные контейнеры могли ещё не отрисоваться (SPA, ленивый рендер) — ждём их
      let tries = 0;
      const observer = new MutationObserver(() => {
        for (let i = pending.length - 1; i >= 0; i--) {
          if (applyOne(pending[i])) pending.splice(i, 1);
        }
        if (!pending.length || ++tries > 60) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      // страховочный стоп через 20 секунд
      setTimeout(() => observer.disconnect(), 20000);
    });
  }

  // Повторно применить, если панель/агент изменили список во время открытой страницы
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[INJECTIONS_KEY]) run();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
