/**
 * Лёгкий безопасный markdown → HTML.
 * Поддержка: # ## ###, ** **, * *, ~~ ~~, `code`, ```blocks```,
 * списки -, *, 1., ссылки, цитаты >, ---.
 */

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} raw
 * @returns {string} HTML
 */
export function renderMarkdown(raw) {
  if (!raw) return '';

  const text = String(raw).replace(/\r\n/g, '\n');
  const blocks = [];
  let i = 0;

  // Вырезаем fenced code blocks
  const withoutFences = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = `@@BLOCK${blocks.length}@@`;
    blocks.push(
      `<pre class="md-pre"><code class="md-code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
    );
    return id;
  });

  const lines = withoutFences.split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol'
  let quoteBuf = [];

  const flushList = () => {
    if (!listType) return;
    out.push(listType === 'ul' ? '</ul>' : '</ol>');
    listType = null;
  };

  const flushQuote = () => {
    if (!quoteBuf.length) return;
    out.push(`<blockquote class="md-quote">${quoteBuf.join('<br>')}</blockquote>`);
    quoteBuf = [];
  };

  for (const line of lines) {
    const fenceToken = line.match(/^@@BLOCK(\d+)@@$/);
    if (fenceToken) {
      flushList();
      flushQuote();
      out.push(blocks[Number(fenceToken[1])]);
      continue;
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      flushList();
      flushQuote();
      out.push('<hr class="md-hr">');
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
      quoteBuf.push(inline(quote[1]));
      continue;
    }
    flushQuote();

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') {
        flushList();
        out.push('<ul class="md-list">');
        listType = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') {
        flushList();
        out.push('<ol class="md-list">');
        listType = 'ol';
      }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }

    flushList();

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${inline(h[2])}</h${level}>`);
      continue;
    }

    if (!line.trim()) {
      out.push('<div class="md-spacer"></div>');
      continue;
    }

    out.push(`<p class="md-p">${inline(line)}</p>`);
  }

  flushList();
  flushQuote();

  return out.join('');
}

function emphasis(s) {
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

function inline(src) {
  // Код и ссылки прячем в заглушки, чтобы *, _ внутри них не превращались в разметку
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  let s = escapeHtml(src.replace(/\u0000/g, ''));
  s = s.replace(/`([^`]+)`/g, (_, code) => keep(`<code class="md-inline">${code}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, href) =>
    keep(
      `<a class="md-a" href="${href}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`
    )
  );
  s = emphasis(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}
