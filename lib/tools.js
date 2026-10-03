/**
 * Инструменты браузерного агента + парсинг action-блоков из ответа модели.
 */

export const PAGE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Клик по элементу на странице. Предпочтительно по ref из Interactive elements.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'ref вида e12' },
          text: { type: 'string', description: 'Видимый текст кнопки/ссылки, если ref неизвестен' },
          selector: { type: 'string', description: 'CSS-селектор (запасной вариант)' },
          x: { type: 'number', description: 'X в пикселях viewport — если у элемента нет ref (клик по месту на скриншоте)' },
          y: { type: 'number', description: 'Y в пикселях viewport (вместе с x)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Прокрутка страницы или к элементу.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom', 'left', 'right'],
          },
          amount: { type: 'number', description: 'Пиксели для up/down/left/right (по умолчанию 600)' },
          ref: { type: 'string', description: 'Прокрутить к элементу' },
          text: { type: 'string' },
          selector: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Ввести текст в input/textarea.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string', description: 'Что ввести' },
          selector: { type: 'string' },
          clear: { type: 'boolean', description: 'Очистить поле перед вводом (по умолчанию true)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press',
      description: 'Нажать клавишу (Enter, Escape, Tab, ArrowDown…).',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          ref: { type: 'string', description: 'Опционально — фокус на элемент' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Выбрать option в <select>.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          value: { type: 'string' },
          label: { type: 'string' },
          selector: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: 'Навести курсор на элемент (меню, всплывающие подсказки).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          text: { type: 'string' },
          selector: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_dom',
      description:
        'Изменить DOM страницы: текст, атрибут, стиль, innerHTML, вставить или удалить элемент. Правки живут только в этой вкладке и пропадают при перезагрузке (исходник сайта не меняется). Произвольный JS не выполняется.',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['text', 'attr', 'style', 'html', 'insert', 'remove'],
            description:
              'text — заменить текст; attr — атрибут (name+value, пустой value удаляет); style — стиль (name+value или объект style); html — заменить innerHTML; insert — вставить html (position); remove — удалить элемент',
          },
          ref: { type: 'string', description: 'ref целевого элемента из снимка' },
          selector: { type: 'string', description: 'CSS-селектор (если нет ref)' },
          text: { type: 'string', description: 'Для op=text' },
          name: { type: 'string', description: 'Имя атрибута (op=attr) или свойства (op=style)' },
          value: { type: 'string', description: 'Значение для attr/style' },
          style: { type: 'object', description: 'Объект CSS-свойств для op=style' },
          html: { type: 'string', description: 'HTML для op=html / insert (script и on*-обработчики вырезаются)' },
          position: {
            type: 'string',
            enum: ['beforebegin', 'afterbegin', 'beforeend', 'afterend'],
            description: 'Куда вставить для op=insert (по умолчанию beforeend)',
          },
        },
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'look',
      description:
        'Получить свежий снимок страницы и скриншот с ref-метками. Вызывай, когда нужно проверить результат или страница меняется сама.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw',
      description:
        'Рисовать поверх страницы на прозрачном холсте (для шуток и пометок: обвести элемент, подписать, пририсовать). Координаты — пиксели viewport, как @x,y у элементов. Вызывай только если пользователь просит что-то нарисовать/обвести/подписать.',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['stroke', 'line', 'rect', 'text', 'clear'],
            description:
              'stroke — ломаная по points; line — отрезок x1,y1→x2,y2; rect — рамка x1,y1→x2,y2; text — надпись в x,y; clear — стереть всё',
          },
          points: {
            type: 'array',
            description: 'Для stroke: [{x,y},…] в пикселях viewport',
            items: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
          },
          x1: { type: 'number' },
          y1: { type: 'number' },
          x2: { type: 'number' },
          y2: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          ref: { type: 'string', description: 'Для text/rect можно указать ref — возьмём центр элемента' },
          text: { type: 'string', description: 'Текст для op=text' },
          color: { type: 'string', description: 'CSS-цвет, напр. #ef4444' },
          width: { type: 'number', description: 'Толщина линии / размер текста (1–30)' },
        },
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Подождать миллисекунды (макс 5000) перед следующим шагом.',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Поиск информации в интернете (DuckDuckGo). Используй для фактов, новостей, уточнений вне текущей страницы.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
          limit: { type: 'number', description: 'Сколько результатов (1–10, по умолчанию 6)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Открыть URL «в фоне» и прочитать текст страницы (без обязательной навигации вкладки).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          maxChars: { type: 'number' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Открыть URL в текущей вкладке (или в новой, если newTab=true).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          newTab: { type: 'boolean' },
        },
        required: ['url'],
      },
    },
  },
];

export const PAGE_TOOL_NAMES = new Set([
  'click',
  'scroll',
  'type',
  'fill',
  'press',
  'keydown',
  'select',
  'hover',
  'draw',
  'edit_dom',
  'edit',
  'wait',
  'look',
]);

export const WEB_TOOL_NAMES = new Set(['web_search', 'search', 'fetch_url', 'read_url', 'open_url']);

/** @param {{ enableActions?: boolean, enableWebSearch?: boolean }} settings */
export function getActiveTools(settings) {
  const allowActions = settings.enableActions !== false;
  const allowSearch = settings.enableWebSearch !== false;
  return PAGE_TOOLS.filter((t) => {
    const name = t.function.name;
    if (name === 'wait' || name === 'look' || name === 'open_url') return allowActions || allowSearch;
    if (WEB_TOOL_NAMES.has(name)) return allowSearch;
    if (PAGE_TOOL_NAMES.has(name)) return allowActions;
    return false;
  });
}

export const ACTIONS_SYSTEM = `
Ты ВИДИШЬ страницу и РАБОТАЕШЬ с ней как пользователь: читаешь, кликаешь, вводишь текст, листаешь, ищешь в интернете.

Как ты видишь страницу:
- Текстовый снимок: Interactive elements с ref (e1, e2…); «on screen» — элементы в видимой области, у них указаны координаты центра x,y.
- Скриншот видимой области (если приложен): на нём поверх элементов нарисованы цветные рамки с подписью ref. Сопоставляй картинку и ref: нужная кнопка на скриншоте — это ref на её рамке.

Рабочий цикл — действуй сам, без вопросов «можно ли мне?»:
1. Посмотри снимок и скриншот, пойми, что на экране.
2. Сделай следующее действие (можно несколько подряд, если они независимы).
3. После действий тебе придут результат и НОВЫЙ снимок со скриншотом — проверь, получилось ли. Если нет — попробуй иначе (другой ref, scroll, текст кнопки, координаты x,y).
4. Повторяй, пока задача не выполнена. Затем дай короткий итог в Markdown: что сделал и что нашёл.
Если элемента нет на экране — scroll (или look). Если страница грузится или меняется — wait, затем look.

Формат вызова: tools ИЛИ блоки:

\`\`\`action
{"tool":"click","ref":"e3"}
\`\`\`

\`\`\`action
{"tool":"type","ref":"e10","text":"hello"}
\`\`\`

\`\`\`action
{"tool":"press","key":"Enter"}
\`\`\`

\`\`\`action
{"tool":"scroll","direction":"down","amount":800}
\`\`\`

\`\`\`action
{"tool":"click","x":420,"y":310}
\`\`\`

\`\`\`action
{"tool":"look"}
\`\`\`

\`\`\`action
{"tool":"web_search","query":"когда вышел Minecraft 1.21"}
\`\`\`

\`\`\`action
{"tool":"fetch_url","url":"https://example.com/article"}
\`\`\`

\`\`\`action
{"tool":"open_url","url":"https://example.com"}
\`\`\`

\`\`\`action
{"tool":"draw","op":"rect","x1":100,"y1":80,"x2":260,"y2":140,"color":"#ef4444","width":4}
\`\`\`

Правка страницы (инструмент edit_dom):
- Можешь менять DOM открытой вкладки: текст, атрибут, стиль, innerHTML, вставлять и удалять элементы (по ref или селектору).
- Правки живут только в этой вкладке и пропадают при перезагрузке — исходник сайта не меняется. Используй для просьб вроде «поменяй заголовок», «подсветь кнопку», «скрой баннер», «вставь блок».
- Произвольный JS выполнить нельзя; script и on*-обработчики из html вырезаются.
- op=remove и op=html (замена innerHTML) — разрушительные: применяй их только по явной просьбе пользователя.

Рисование поверх страницы (инструмент draw):
- Ты можешь рисовать на прозрачном холсте поверх сайта: обвести элемент (rect), провести линию/стрелку (line), накалякать от руки (stroke по точкам), подписать (text), стереть всё (clear).
- Это необязательная весёлая способность. Решай сам, когда она уместна: рисуй, ТОЛЬКО если пользователь прямо просит нарисовать / обвести / подписать / пририсовать что-то. Без такой просьбы не рисуй.
- Координаты бери из @x,y элементов в снимке или со скриншота (пиксели viewport). Для rect/text можно указать ref — возьму центр элемента.
- Нарисовав, коротко скажи, что сделал. Рисунок не меняет саму страницу — это просто слой поверх.

Правила:
- Не выдумывай ref — только из снимка. Ref меняются после каждого нового снимка: используй ref из ПОСЛЕДНЕГО снимка.
- Чтобы отправить поиск/форму: type в поле, затем press Enter (или click по кнопке).
- Не повторяй одно и то же действие, если оно не помогло, — смени подход или честно скажи, что не получилось.
- Для фактов вне страницы («найди», «что такое», новости) используй web_search, затем при необходимости fetch_url; ссылки на источники давай в Markdown.
- Если пользователь пишет «поищи в инете» / «погугли» без темы — возьми тему из предыдущих сообщений.
- Не вводи пароли и платёжные данные, не подтверждай оплату/удаление без явной просьбы пользователя.
- Не открывай опасные системные диалоги.
`;

export const SEARCH_ONLY_SYSTEM = `
Ты можешь ИСКАТЬ В ИНТЕРНЕТЕ через tools / action-блоки:

\`\`\`action
{"tool":"web_search","query":"..."}
\`\`\`

\`\`\`action
{"tool":"fetch_url","url":"https://..."}
\`\`\`

Для вопросов про факты, новости, «что такое», «найди» — сначала web_search, при необходимости fetch_url, затем ответь с ссылками в Markdown.
Если пользователь пишет «поищи в инете» без темы — возьми тему из предыдущих реплик и передай нормальный query в web_search.
`;

/**
 * Достаёт action-блоки из текста модели.
 * @param {string} text
 * @returns {{ actions: object[], cleanText: string }}
 */
export function parseActionBlocks(text) {
  if (!text) return { actions: [], cleanText: '' };
  const actions = [];
  const cleanText = String(text)
    .replace(/```action\s*([\s\S]*?)```/gi, (_, body) => {
      const raw = String(body).trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object') actions.push(normalizeAction(item));
          }
        } else if (parsed && typeof parsed === 'object') {
          actions.push(normalizeAction(parsed));
        }
      } catch {
        // одна строка на действие
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            actions.push(normalizeAction(JSON.parse(t)));
          } catch {
            /* ignore */
          }
        }
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { actions: actions.filter(Boolean), cleanText };
}

function normalizeAction(item) {
  const tool = item.tool || item.name || item.action;
  if (!tool) return null;
  const { tool: _t, name: _n, action: _a, arguments: args, ...rest } = item;
  return {
    tool: String(tool).toLowerCase(),
    ...(args && typeof args === 'object' ? args : {}),
    ...rest,
  };
}

/**
 * Нормализует tool_calls из OpenAI ответа в список действий.
 */
export function toolCallsToActions(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .map((tc) => {
      const name = tc?.function?.name || tc?.name;
      if (!name) return null;
      let args = {};
      const raw = tc?.function?.arguments ?? tc?.arguments ?? '{}';
      try {
        args = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
      } catch {
        args = {};
      }
      return { tool: String(name).toLowerCase(), ...args, _id: tc.id };
    })
    .filter(Boolean);
}

export function labelAction(action) {
  const t = action.tool;
  if (t === 'click') {
    const at = action.x != null && action.y != null ? ` (${action.x},${action.y})` : '';
    return `Клик${action.ref ? ` [${action.ref}]` : ''}${action.text ? ` «${action.text}»` : ''}${at}`;
  }
  if (t === 'look') return 'Осматриваю страницу';
  if (t === 'scroll') {
    if (action.ref) return `Скролл к [${action.ref}]`;
    return `Скролл ${action.direction || 'down'}`;
  }
  if (t === 'type' || t === 'fill') return `Ввод${action.ref ? ` [${action.ref}]` : ''}`;
  if (t === 'press') return `Клавиша ${action.key || ''}`;
  if (t === 'hover') return `Наведение${action.ref ? ` [${action.ref}]` : ''}`;
  if (t === 'select') return `Select${action.ref ? ` [${action.ref}]` : ''}`;
  if (t === 'draw') return `Рисую ${action.op || ''}`.trim();
  if (t === 'edit_dom' || t === 'edit') {
    return `Правка DOM: ${action.op || 'text'}${action.ref ? ` [${action.ref}]` : ''}`;
  }
  if (t === 'wait') return `Пауза ${action.ms || 500}ms`;
  if (t === 'web_search' || t === 'search') return `Поиск «${action.query || ''}»`;
  if (t === 'fetch_url' || t === 'read_url') return `Чтение ${action.url || ''}`;
  if (t === 'open_url') return `Открыть ${action.url || ''}`;
  return t;
}
