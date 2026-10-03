/**
 * Инжектится во вкладку: рисование поверх сайта.
 * Прозрачный canvas на весь экран + мини-панель инструментов.
 * Один и тот же API используют и панель инструментов (ручной режим),
 * и агент (через действие draw).
 *
 * Не ES-module — работает через chrome.scripting.executeScript({ files }).
 */
(() => {
  if (window.__browserAgentDraw) return;

  const ROOT_ID = 'browser-agent-draw-root';
  const Z = '2147483640';
  const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827', '#ffffff'];

  const state = {
    enabled: false,
    tool: 'brush', // brush | line | rect | text | eraser
    color: '#ef4444',
    width: 4,
    /** @type {object[]} список фигур для перерисовки при ресайзе */
    shapes: [],
    drawing: false,
    start: null,
    current: null,
  };

  let root = null;
  let canvas = null;
  let ctx = null;
  let panel = null;

  function ensureUi() {
    if (root) return root;

    root = document.createElement('div');
    root.id = ROOT_ID;
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      zIndex: Z,
      margin: '0',
      padding: '0',
      pointerEvents: 'none',
    });

    canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      cursor: 'crosshair',
    });
    root.appendChild(canvas);

    panel = buildPanel();
    root.appendChild(panel);

    document.documentElement.appendChild(root);
    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', onResize, { passive: true });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown, true);

    return root;
  }

  function buildPanel() {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
      padding: '6px 8px',
      background: 'rgba(17,24,39,0.92)',
      borderRadius: '12px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      font: '13px/1 system-ui, sans-serif',
      color: '#fff',
      pointerEvents: 'auto',
      userSelect: 'none',
    });
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());

    const tools = [
      ['brush', '✏️', 'Кисть'],
      ['line', '╱', 'Линия'],
      ['rect', '▭', 'Прямоугольник'],
      ['text', 'T', 'Текст'],
      ['eraser', '⌫', 'Ластик'],
    ];
    const toolBtns = {};
    for (const [id, label, title] of tools) {
      const b = iconBtn(label, title);
      b.onclick = () => setTool(id, toolBtns);
      toolBtns[id] = b;
      bar.appendChild(b);
    }
    toolBtns.brush.dataset.active = '1';
    applyActiveStyle(toolBtns);

    bar.appendChild(sep());

    for (const c of COLORS) {
      const sw = document.createElement('button');
      Object.assign(sw.style, {
        width: '18px',
        height: '18px',
        borderRadius: '50%',
        border: c === '#ffffff' ? '1px solid #999' : '1px solid rgba(255,255,255,0.3)',
        background: c,
        cursor: 'pointer',
        padding: '0',
        outline: c === state.color ? '2px solid #fff' : 'none',
      });
      sw.title = c;
      sw.onclick = () => {
        state.color = c;
        [...bar.querySelectorAll('button[data-sw]')].forEach(
          (x) => (x.style.outline = x.dataset.sw === c ? '2px solid #fff' : 'none')
        );
      };
      sw.dataset.sw = c;
      bar.appendChild(sw);
    }

    bar.appendChild(sep());

    const range = document.createElement('input');
    range.type = 'range';
    range.min = '1';
    range.max = '30';
    range.value = String(state.width);
    range.title = 'Толщина';
    range.style.width = '70px';
    range.style.cursor = 'pointer';
    range.oninput = () => (state.width = Number(range.value));
    bar.appendChild(range);

    bar.appendChild(sep());

    const clearBtn = iconBtn('🗑', 'Очистить всё');
    clearBtn.onclick = () => clear();
    bar.appendChild(clearBtn);

    const saveBtn = iconBtn('⬇', 'Скачать PNG');
    saveBtn.onclick = () => savePng();
    bar.appendChild(saveBtn);

    const closeBtn = iconBtn('✕', 'Выйти из режима рисования');
    closeBtn.onclick = () => disable();
    bar.appendChild(closeBtn);

    return bar;
  }

  function iconBtn(label, title) {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      minWidth: '28px',
      height: '28px',
      padding: '0 6px',
      border: '0',
      borderRadius: '8px',
      background: 'rgba(255,255,255,0.1)',
      color: '#fff',
      cursor: 'pointer',
      font: '14px/1 system-ui, sans-serif',
    });
    return b;
  }

  function sep() {
    const s = document.createElement('span');
    Object.assign(s.style, { width: '1px', height: '20px', background: 'rgba(255,255,255,0.2)' });
    return s;
  }

  function applyActiveStyle(toolBtns) {
    for (const b of Object.values(toolBtns)) {
      b.style.background = b.dataset.active ? '#2dd4bf' : 'rgba(255,255,255,0.1)';
      b.style.color = b.dataset.active ? '#042f2e' : '#fff';
    }
  }

  function setTool(id, toolBtns) {
    state.tool = id;
    for (const [k, b] of Object.entries(toolBtns)) {
      if (k === id) b.dataset.active = '1';
      else delete b.dataset.active;
    }
    applyActiveStyle(toolBtns);
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function onResize() {
    resizeCanvas();
  }

  function redraw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of state.shapes) drawShape(s);
    if (state.current) drawShape(state.current);
  }

  function drawShape(s) {
    ctx.save();
    if (s.type === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokePath(s.points);
    } else if (s.type === 'brush') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokePath(s.points);
    } else if (s.type === 'line') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
    } else if (s.type === 'rect') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.strokeRect(
        Math.min(s.x1, s.x2),
        Math.min(s.y1, s.y2),
        Math.abs(s.x2 - s.x1),
        Math.abs(s.y2 - s.y1)
      );
    } else if (s.type === 'text') {
      ctx.fillStyle = s.color;
      const size = Math.max(12, s.width * 5);
      ctx.font = `bold ${size}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(s.text, s.x, s.y);
    }
    ctx.restore();
  }

  function strokePath(points) {
    if (!points || points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (points.length === 1) {
      ctx.lineTo(points[0].x + 0.1, points[0].y + 0.1);
    }
    ctx.stroke();
  }

  function pos(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function onPointerDown(e) {
    if (!state.enabled) return;
    e.preventDefault();
    const p = pos(e);

    if (state.tool === 'text') {
      const text = window.prompt('Текст:');
      if (text) {
        state.shapes.push({ type: 'text', x: p.x, y: p.y, text, color: state.color, width: state.width });
        redraw();
      }
      return;
    }

    state.drawing = true;
    state.start = p;
    if (state.tool === 'brush' || state.tool === 'eraser') {
      state.current = { type: state.tool, points: [p], color: state.color, width: state.width };
    } else {
      state.current = { type: state.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: state.color, width: state.width };
    }
  }

  function onPointerMove(e) {
    if (!state.enabled || !state.drawing || !state.current) return;
    const p = pos(e);
    if (state.current.type === 'brush' || state.current.type === 'eraser') {
      state.current.points.push(p);
    } else {
      state.current.x2 = p.x;
      state.current.y2 = p.y;
    }
    redraw();
  }

  function onPointerUp() {
    if (!state.drawing || !state.current) return;
    state.drawing = false;
    state.shapes.push(state.current);
    state.current = null;
    redraw();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && state.enabled) {
      e.stopPropagation();
      disable();
    }
  }

  function setCanvasInteractive(on) {
    canvas.style.pointerEvents = on ? 'auto' : 'none';
  }

  // ---- публичный API ----

  function enable() {
    ensureUi();
    state.enabled = true;
    root.style.display = 'block';
    panel.style.display = 'flex';
    setCanvasInteractive(true);
    return { ok: true, result: 'drawing mode on' };
  }

  function disable() {
    if (!root) return { ok: true, result: 'drawing mode off' };
    state.enabled = false;
    state.drawing = false;
    state.current = null;
    setCanvasInteractive(false);
    panel.style.display = 'none';
    return { ok: true, result: 'drawing mode off' };
  }

  function clear() {
    state.shapes = [];
    state.current = null;
    if (ctx) redraw();
    return { ok: true, result: 'canvas cleared' };
  }

  function savePng() {
    ensureUi();
    try {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `browser-agent-drawing-${Date.now()}.png`;
      a.click();
      return { ok: true, result: 'png saved' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * Команда рисования (для агента и панели).
   * op: enable | disable | clear | save | stroke | line | rect | text | toggle
   */
  function command(cmd) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'empty draw command' };
    const op = String(cmd.op || '').toLowerCase();
    const color = cmd.color || state.color;
    const width = Number(cmd.width) || state.width;

    switch (op) {
      case 'enable':
        return enable();
      case 'disable':
        return disable();
      case 'toggle':
        return state.enabled ? disable() : enable();
      case 'clear':
        return clear();
      case 'save':
        return savePng();
      case 'stroke': {
        ensureUi();
        const points = (cmd.points || []).map((p) => ({ x: Number(p.x), y: Number(p.y) }));
        if (points.length < 1) return { ok: false, error: 'stroke needs points [{x,y},…]' };
        state.shapes.push({ type: 'brush', points, color, width });
        redraw();
        return { ok: true, result: `stroke ${points.length} pts` };
      }
      case 'line': {
        ensureUi();
        state.shapes.push({ type: 'line', x1: +cmd.x1, y1: +cmd.y1, x2: +cmd.x2, y2: +cmd.y2, color, width });
        redraw();
        return { ok: true, result: 'line drawn' };
      }
      case 'rect': {
        ensureUi();
        state.shapes.push({ type: 'rect', x1: +cmd.x1, y1: +cmd.y1, x2: +cmd.x2, y2: +cmd.y2, color, width });
        redraw();
        return { ok: true, result: 'rect drawn' };
      }
      case 'text': {
        ensureUi();
        if (!cmd.text) return { ok: false, error: 'text op needs "text"' };
        state.shapes.push({ type: 'text', x: +cmd.x, y: +cmd.y, text: String(cmd.text), color, width });
        redraw();
        return { ok: true, result: 'text drawn' };
      }
      default:
        return { ok: false, error: `unknown draw op: ${op}` };
    }
  }

  window.__browserAgentDraw = { command, enable, disable, clear, savePng };
})();
