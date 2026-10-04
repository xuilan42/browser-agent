/**
 * Инжектится во вкладку: снимает структурированный снимок DOM.
 * Не ES-module — должен работать через chrome.scripting.executeScript({ files }).
 */
(() => {
  window.__browserAgentExtract = function extractPageSnapshot() {
    try {
      const selection = window.getSelection()?.toString()?.trim() || '';
      const title = document.title || '';
      const lang = document.documentElement.lang || '';
      const description =
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        '';

      const root =
        document.querySelector('article') ||
        document.querySelector('[role="main"]') ||
        document.querySelector('main') ||
        document.body;

      const headings = [...document.querySelectorAll('h1, h2, h3')]
        .slice(0, 40)
        .map((el) => ({
          level: el.tagName.toLowerCase(),
          text: clean(el.innerText || el.textContent || ''),
        }))
        .filter((h) => h.text);

      const links = [...document.querySelectorAll('a[href]')]
        .slice(0, 60)
        .map((a) => ({
          text: clean(a.innerText || a.getAttribute('aria-label') || ''),
          href: absoluteUrl(a.getAttribute('href') || ''),
        }))
        .filter((l) => l.href && l.text && !l.href.startsWith('javascript:'));

      const buttons = [
        ...document.querySelectorAll(
          'button, [role="button"], input[type="submit"], input[type="button"]'
        ),
      ]
        .slice(0, 40)
        .map((el) =>
          clean(
            el.innerText ||
              el.value ||
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              ''
          )
        )
        .filter(Boolean);

      const inputs = [...document.querySelectorAll('input, textarea, select')]
        .slice(0, 40)
        .map((el) => {
          const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
          if (type === 'hidden' || type === 'password') return null;
          return {
            type,
            name: el.getAttribute('name') || el.id || '',
            label: clean(
              el.getAttribute('aria-label') ||
                el.getAttribute('placeholder') ||
                el.getAttribute('title') ||
                ''
            ),
            value:
              type === 'checkbox' || type === 'radio'
                ? String(el.checked)
                : clean(String(el.value || '').slice(0, 80)),
          };
        })
        .filter(Boolean);

      const images = [...document.querySelectorAll('img[src], img[alt]')]
        .slice(0, 20)
        .map((img) => ({
          alt: clean(img.getAttribute('alt') || ''),
          src: absoluteUrl(img.currentSrc || img.getAttribute('src') || '').slice(0, 200),
        }))
        .filter((i) => i.alt || i.src);

      // Интерактивные элементы с ref для кликов/ввода
      document.querySelectorAll('[data-ba-ref]').forEach((el) => el.removeAttribute('data-ba-ref'));
      const interactiveSel = [
        'a[href]',
        'button',
        '[role="button"]',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[contenteditable="true"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])',
        // Пункты раскрытых выпадающих списков / автодополнения / меню
        '[role="option"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '[role="treeitem"]',
        '[role="combobox"]',
        '[role="listbox"] li',
        '[role="menu"] li',
        'datalist option',
        '.option',
        '.dropdown-item',
        '.select__option',
        '.autocomplete-item',
        '[aria-selected]',
      ].join(',');
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const POPUP_SEL =
        '[role="listbox"],[role="menu"],[role="combobox"],[aria-expanded="true"],[class*="dropdown"],[class*="autocomplete"],[class*="menu"],[class*="popover"],[class*="popup"]';
      const candidates = [];
      for (const el of document.querySelectorAll(interactiveSel)) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) continue;
        const inView = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
        // Пункт внутри раскрытого выпадающего слоя — показываем в приоритете
        const role = (el.getAttribute('role') || '').toLowerCase();
        const inPopup =
          role === 'option' ||
          role === 'menuitem' ||
          Boolean(el.closest(POPUP_SEL));
        candidates.push({ el, rect, inView, inPopup });
      }
      // Приоритет: пункты раскрытых списков → видимое на экране → остальное
      candidates.sort(
        (x, y) =>
          Number(y.inPopup && y.inView) - Number(x.inPopup && x.inView) ||
          Number(y.inView) - Number(x.inView)
      );

      const interactive = [];
      for (const { el, rect, inView, inPopup } of candidates.slice(0, 150)) {
        const ref = `e${interactive.length + 1}`;
        el.setAttribute('data-ba-ref', ref);
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const text = clean(
          el.innerText ||
            (type === 'password' ? '' : el.value) ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.getAttribute('title') ||
            el.getAttribute('name') ||
            ''
        );
        interactive.push({
          ref,
          tag,
          type: type || undefined,
          text,
          href: tag === 'a' ? absoluteUrl(el.getAttribute('href') || '').slice(0, 180) : undefined,
          name: el.getAttribute('name') || el.id || undefined,
          inView,
          popup: inPopup || undefined,
          at: inView
            ? `${Math.round(rect.left + rect.width / 2)},${Math.round(rect.top + rect.height / 2)}`
            : undefined,
        });
      }

      let text = '';
      if (root) {
        text = cleanText(root.innerText || root.textContent || '');
      }
      if (text.length > 24000) text = text.slice(0, 24000);

      return {
        title,
        lang,
        description,
        selection,
        headings,
        links,
        buttons,
        inputs,
        images,
        interactive,
        text,
        url: location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        scrollY: Math.round(window.scrollY),
        scrollMax: Math.max(
          0,
          Math.round(document.documentElement.scrollHeight - window.innerHeight)
        ),
      };
    } finally {
      /* ничего не восстанавливаем: страницу мы не меняем */
    }

    function clean(s) {
      return String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    }

    function cleanText(s) {
      return String(s || '')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }

    function absoluteUrl(href) {
      try {
        return new URL(href, location.href).href;
      } catch {
        return href || '';
      }
    }
  };

  /**
   * Рисует рамки с ref поверх видимых интерактивных элементов (set-of-marks),
   * чтобы модель на скриншоте могла сопоставить картинку и ref.
   */
  window.__browserAgentMarks = function toggleMarks(show) {
    document.getElementById('browser-agent-marks')?.remove();
    if (!show) return 0;

    const layer = document.createElement('div');
    layer.id = 'browser-agent-marks';
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483645',
      pointerEvents: 'none',
      margin: '0',
      padding: '0',
    });
    const colors = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
    let n = 0;
    for (const el of document.querySelectorAll('[data-ba-ref]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) continue;
      const color = colors[n % colors.length];
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'fixed',
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        border: `2px solid ${color}`,
        boxSizing: 'border-box',
        borderRadius: '3px',
      });
      const tag = document.createElement('span');
      tag.textContent = el.getAttribute('data-ba-ref');
      Object.assign(tag.style, {
        position: 'absolute',
        left: '-2px',
        top: r.top < 14 ? '0' : '-14px',
        background: color,
        color: '#fff',
        font: 'bold 11px/14px monospace',
        padding: '0 3px',
        borderRadius: '2px',
        whiteSpace: 'nowrap',
      });
      box.appendChild(tag);
      layer.appendChild(box);
      n += 1;
    }
    document.documentElement.appendChild(layer);
    return n;
  };
})();
