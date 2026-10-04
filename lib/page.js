/**
 * Форматирует снимок страницы в текст для LLM.
 */
export function formatPageContext(pageContext, maxChars = 16000) {
  if (!pageContext) return '';

  const parts = [];
  parts.push(`URL: ${pageContext.url || ''}`);
  parts.push(`Title: ${pageContext.title || ''}`);
  if (pageContext.lang) parts.push(`Language: ${pageContext.lang}`);
  if (pageContext.viewport) parts.push(`Viewport: ${pageContext.viewport}`);
  if (pageContext.scrollY != null) {
    parts.push(
      `ScrollY: ${pageContext.scrollY}` +
        (pageContext.scrollMax ? ` (можно прокрутить ещё до ${pageContext.scrollMax})` : '')
    );
  }
  if (pageContext.description) parts.push(`Description: ${pageContext.description}`);

  if (pageContext.restricted) {
    parts.push('Access: restricted (system page — content unavailable)');
  }

  if (pageContext.selection) {
    parts.push(`User selection:\n${pageContext.selection}`);
  }

  if (pageContext.interactive?.length) {
    const line = (el) => {
      const bits = [`[${el.ref}]`, `<${el.tag}${el.type ? ` type=${el.type}` : ''}>`];
      if (el.popup) bits.push('(пункт выпадающего списка)');
      if (el.text) bits.push(`“${el.text}”`);
      if (el.href) bits.push(`→ ${el.href}`);
      if (el.name) bits.push(`name=${el.name}`);
      if (el.at) bits.push(`@${el.at}`);
      return `- ${bits.join(' ')}`;
    };
    const onScreen = pageContext.interactive.filter((el) => el.inView);
    const offScreen = pageContext.interactive.filter((el) => !el.inView);
    if (onScreen.length) {
      parts.push(
        'Interactive elements ON SCREEN (ref, @x,y — центр в пикселях viewport):\n' +
          onScreen.map(line).join('\n')
      );
    }
    if (offScreen.length) {
      parts.push('Interactive elements OFF SCREEN (нужен scroll):\n' + offScreen.map(line).join('\n'));
    }
  }

  if (pageContext.headings?.length) {
    parts.push(
      'Headings:\n' +
        pageContext.headings.map((h) => `- ${h.level}: ${h.text}`).join('\n')
    );
  }

  if (pageContext.buttons?.length) {
    parts.push('Visible buttons/actions:\n' + pageContext.buttons.map((b) => `- ${b}`).join('\n'));
  }

  if (pageContext.links?.length) {
    parts.push(
      'Links (sample):\n' +
        pageContext.links
          .slice(0, 30)
          .map((l) => `- ${l.text}: ${l.href}`)
          .join('\n')
    );
  }

  if (pageContext.inputs?.length) {
    parts.push(
      'Form fields:\n' +
        pageContext.inputs
          .map((i) => `- [${i.type}] ${i.name || i.label}${i.value ? ` = ${i.value}` : ''}`)
          .join('\n')
    );
  }

  if (pageContext.images?.length) {
    const withAlt = pageContext.images.filter((i) => i.alt);
    if (withAlt.length) {
      parts.push('Images:\n' + withAlt.map((i) => `- ${i.alt}`).join('\n'));
    }
  }

  if (pageContext.text) {
    parts.push(`Visible page text:\n${pageContext.text}`);
  }

  if (pageContext.screenshot) {
    parts.push('Screenshot: приложен отдельным изображением (рамки с ref — интерактивные элементы).');
  }

  let out = parts.join('\n\n');
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + '\n…[truncated]';
  }
  return out;
}

export function summarizeContextMeta(pageContext) {
  if (!pageContext) return { ok: false, label: 'Страница недоступна' };
  if (pageContext.restricted) return { ok: false, label: 'Системная вкладка' };
  const chars = (pageContext.text || '').length;
  const bits = [];
  if (chars) bits.push(`${Math.round(chars / 100) / 10}k символов`);
  if (pageContext.headings?.length) bits.push(`${pageContext.headings.length} заг.`);
  if (pageContext.links?.length) bits.push(`${pageContext.links.length} ссылок`);
  if (pageContext.interactive?.length) bits.push(`${pageContext.interactive.length} el`);
  if (pageContext.screenshot) bits.push('скрин');
  return {
    ok: true,
    label: bits.length ? `Вижу страницу · ${bits.join(' · ')}` : pageContext.title || 'Страница',
  };
}
