/**
 * Инжектится во вкладку: выполняет безопасные действия агента.
 */
(() => {
  window.__browserAgentAction = async function runPageAction(action) {
    if (!action || typeof action !== 'object') {
      return { ok: false, error: 'Пустое действие' };
    }

    const tool = String(action.tool || action.name || '').toLowerCase();
    try {
      switch (tool) {
        case 'click':
          return click(action);
        case 'scroll':
          return scroll(action);
        case 'type':
        case 'fill':
          return typeInto(action);
        case 'press':
        case 'keydown':
          return pressKey(action);
        case 'select':
          return selectOption(action);
        case 'hover':
          return hover(action);
        case 'wait':
          await sleep(Math.min(Number(action.ms) || 500, 5000));
          return { ok: true, result: `wait ${action.ms || 500}ms` };
        default:
          return { ok: false, error: `Неизвестное действие: ${tool}` };
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };

  function click(action) {
    const el = resolveElement(action);
    if (!el) return { ok: false, error: 'Элемент не найден' };
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    highlight(el);
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    return {
      ok: true,
      result: `clicked ${describe(el)}`,
      url: location.href,
    };
  }

  function scroll(action) {
    const dir = String(action.direction || 'down').toLowerCase();
    const amount = Math.min(Math.max(Number(action.amount) || 600, 50), 4000);

    if (action.ref || action.selector || action.text) {
      const el = resolveElement({ ref: action.ref, selector: action.selector, text: action.text });
      if (!el) return { ok: false, error: 'Элемент для скролла не найден' };
      el.scrollIntoView({ block: action.block || 'center', behavior: 'smooth' });
      return { ok: true, result: `scrolled to ${describe(el)}` };
    }

    if (dir === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return { ok: true, result: 'scrolled to top' };
    }
    if (dir === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      return { ok: true, result: 'scrolled to bottom' };
    }

    const vertical = dir === 'up' || dir === 'down';
    const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
    const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;

    const doc = document.scrollingElement || document.documentElement;
    const pageScrolls = vertical
      ? doc.scrollHeight > window.innerHeight + 20
      : doc.scrollWidth > window.innerWidth + 20;
    const inner = pageScrolls ? null : findScrollable(vertical);
    if (inner) {
      inner.scrollBy({ top: dy, left: dx, behavior: 'smooth' });
      return { ok: true, result: `scrolled inner container ${dir} by ${amount}px` };
    }

    window.scrollBy({ top: dy, left: dx, behavior: 'smooth' });
    return {
      ok: true,
      result: `scrolled ${dir} by ${amount}px (y=${Math.round(window.scrollY)})`,
    };
  }

  function typeInto(action) {
    const el = resolveElement(action);
    if (!el) return { ok: false, error: 'Поле ввода не найдено' };
    const text = action.text ?? action.value ?? '';
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    highlight(el);
    el.focus();

    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      return { ok: false, error: `${describe(el)} — это select, используй действие select` };
    }
    if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
      return { ok: false, error: `Нельзя печатать в ${describe(el)}` };
    }

    if (action.clear !== false) {
      if (el.isContentEditable) el.textContent = '';
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (el.isContentEditable) {
      el.textContent = (el.textContent || '') + text;
    } else {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, (action.clear === false ? el.value : '') + text);
      else el.value = (action.clear === false ? el.value : '') + text;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: `typed into ${describe(el)}: ${String(text).slice(0, 80)}` };
  }

  function pressKey(action) {
    const key = action.key || action.name;
    if (!key) return { ok: false, error: 'Не указан key' };
    const target = resolveElement(action) || document.activeElement || document.body;
    const opts = {
      key,
      code: action.code || key,
      bubbles: true,
      cancelable: true,
      ctrlKey: Boolean(action.ctrlKey),
      metaKey: Boolean(action.metaKey),
      altKey: Boolean(action.altKey),
      shiftKey: Boolean(action.shiftKey),
    };
    const notPrevented = target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    // Синтетические события не запускают действие по умолчанию — отправляем форму сами
    if (
      key === 'Enter' &&
      notPrevented &&
      target.form &&
      target.tagName.toLowerCase() === 'input' &&
      typeof target.form.requestSubmit === 'function'
    ) {
      target.form.requestSubmit();
    }
    return { ok: true, result: `pressed ${key}` };
  }

  function selectOption(action) {
    const el = resolveElement(action);
    if (!el || el.tagName.toLowerCase() !== 'select') {
      return { ok: false, error: 'select не найден' };
    }
    const value = action.value;
    const label = action.label || action.text;
    if (value != null) el.value = String(value);
    else if (label) {
      const opt = [...el.options].find(
        (o) => o.textContent.trim() === label || o.textContent.includes(label)
      );
      if (!opt) return { ok: false, error: `option «${label}» не найден` };
      el.value = opt.value;
    } else {
      return { ok: false, error: 'Укажи value или label' };
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, result: `selected ${el.value} in ${describe(el)}` };
  }

  function hover(action) {
    const el = resolveElement(action);
    if (!el) return { ok: false, error: 'Элемент не найден' };
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    highlight(el);
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    return { ok: true, result: `hovered ${describe(el)}` };
  }

  function resolveElement(action) {
    if (action.ref) {
      const byRef = document.querySelector(`[data-ba-ref="${cssEscape(String(action.ref))}"]`);
      if (byRef) return byRef;
    }
    if (action.selector) {
      try {
        const el = document.querySelector(String(action.selector));
        if (el) return el;
      } catch {
        /* invalid selector */
      }
    }
    if (action.text) {
      const byText = findByText(String(action.text), action.tag);
      if (byText) return byText;
    }
    if (action.x != null && action.y != null) {
      return elementAtPoint(Number(action.x), Number(action.y));
    }
    return null;
  }

  function elementAtPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const el = document.elementFromPoint(x, y);
    return el?.closest('a, button, input, textarea, select, summary, [role="button"], [onclick]') || el;
  }

  /** Самый большой прокручиваемый блок в области просмотра (внутренний скролл). */
  function findScrollable(vertical) {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('*')) {
      const size = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (size < 20) continue;
      const overflow = getComputedStyle(el)[vertical ? 'overflowY' : 'overflowX'];
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      const area = Math.max(w, 0) * Math.max(h, 0);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function findByText(text, tag) {
    const needle = text.trim().toLowerCase();
    if (!needle) return null;
    const sel =
      tag ||
      'a, button, [role="button"], input, textarea, select, label, summary, [onclick], [tabindex]';
    const nodes = [...document.querySelectorAll(sel)];
    const scored = nodes
      .map((el) => {
        const label = (
          el.innerText ||
          el.value ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!label) return null;
        if (label === needle) return { el, score: 3 };
        if (label.includes(needle)) return { el, score: 2 };
        if (needle.includes(label) && label.length > 2) return { el, score: 1 };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.el || null;
  }

  function describe(el) {
    const ref = el.getAttribute('data-ba-ref');
    const tag = el.tagName.toLowerCase();
    const isPassword = el.getAttribute('type') === 'password';
    const text = (
      el.innerText ||
      (isPassword ? '' : el.value) ||
      el.getAttribute('aria-label') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return `${ref ? ref + ' ' : ''}<${tag}>${text ? ` “${text}”` : ''}`;
  }

  function highlight(el) {
    const prev = el.style.outline;
    el.style.outline = '2px solid #2dd4bf';
    setTimeout(() => {
      el.style.outline = prev;
    }, 700);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
