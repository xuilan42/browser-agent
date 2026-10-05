/**
 * Иконка провайдера модели для шапки чата.
 *
 * У LLM-API нет собственных иконок — их никто не передаёт. Поэтому провайдера
 * определяем по имени модели / base URL / настройке provider и рисуем
 * собственный нейтральный глиф в фирменном цвете (не копия товарного знака).
 * Если не распознали — возвращаем null (остаётся дефолтный градиент).
 */

/**
 * @typedef {{ id: string, label: string, color: string, glyph: string }} Brand
 * glyph — внутренний SVG (без <svg>-обёртки), рисуется в viewBox 0 0 24 24.
 */

/** @type {Brand[]} */
const BRANDS = [
  {
    id: 'openai',
    label: 'OpenAI',
    color: '#10a37f',
    // стилизованный «узел» из шести лепестков (не точный логотип)
    glyph:
      '<circle cx="12" cy="12" r="7" fill="none" stroke="#fff" stroke-width="1.6"/>' +
      '<circle cx="12" cy="12" r="2.3" fill="#fff"/>',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    color: '#d97757',
    // стилизованная «A» из двух штрихов
    glyph:
      '<path d="M8 17 L12 7 L16 17" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M9.7 13.5 H14.3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  },
  {
    id: 'meta',
    label: 'Meta / Llama',
    color: '#0866ff',
    // две арки (инфинити-образно)
    glyph:
      '<path d="M4 15 C4 9, 9 9, 12 14 C15 9, 20 9, 20 15" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    color: '#fa520f',
    // три вертикальных штриха (ветер)
    glyph:
      '<path d="M7 7 V17 M12 7 V17 M17 7 V17" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  },
  {
    id: 'google',
    label: 'Google / Gemini',
    color: '#1a73e8',
    // искра из четырёх лучей
    glyph:
      '<path d="M12 5 C12 9, 13 11, 19 12 C13 13, 12 15, 12 19 C12 15, 11 13, 5 12 C11 11, 12 9, 12 5 Z" fill="#fff"/>',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    color: '#4d6bfe',
    glyph:
      '<circle cx="12" cy="12" r="6.5" fill="none" stroke="#fff" stroke-width="1.6"/>' +
      '<circle cx="14.2" cy="10" r="1.3" fill="#fff"/>',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    color: '#111111',
    // «лама» — скруглённый силуэт
    glyph:
      '<path d="M8 18 V11 C8 8, 10 7, 12 7 C14 7, 16 8, 16 11 V18" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>' +
      '<path d="M8 11 L6.5 8 M16 11 L17.5 8" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    color: '#6467f2',
    // стрелка-маршрут
    glyph:
      '<path d="M5 12 H16 M13 9 L16 12 L13 15" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
];

const BY_ID = Object.fromEntries(BRANDS.map((b) => [b.id, b]));

/**
 * Определяет провайдера по настройкам.
 * Приоритет: имя модели → base URL → провайдер Anthropic.
 * @param {{ model?: string, apiBaseUrl?: string, provider?: string }} settings
 * @returns {Brand|null}
 */
export function detectBrand(settings = {}) {
  const model = String(settings.model || '').toLowerCase();
  const base = String(settings.apiBaseUrl || '').toLowerCase();

  // Имя модели — самый точный признак (особенно на агрегаторах вроде OpenRouter,
  // где модель может быть любого вендора)
  if (/claude|anthropic/.test(model)) return BY_ID.anthropic;
  if (/gpt|o1-|o3-|o4-|davinci|openai/.test(model)) return BY_ID.openai;
  if (/llama|meta/.test(model)) return BY_ID.meta;
  if (/mistral|mixtral|codestral/.test(model)) return BY_ID.mistral;
  if (/gemini|gemma|palm|bison/.test(model)) return BY_ID.google;
  if (/deepseek/.test(model)) return BY_ID.deepseek;

  // Затем по base URL конкретного провайдера
  if (base.includes('anthropic.com')) return BY_ID.anthropic;
  if (base.includes('googleapis.com') || base.includes('generativelanguage')) return BY_ID.google;
  if (base.includes('deepseek')) return BY_ID.deepseek;
  if (base.includes('mistral')) return BY_ID.mistral;
  if (base.includes('11434') || base.includes('ollama')) return BY_ID.ollama;
  if (base.includes('api.openai.com')) return BY_ID.openai;
  // OpenRouter — только если модель не выдала конкретного вендора выше
  if (base.includes('openrouter.ai')) return BY_ID.openrouter;

  // Частые локальные модели (Ollama/LM Studio)
  if (/qwen|yi|glm|phi|vicuna|orca/.test(model)) return BY_ID.ollama;

  // Провайдер из настроек — грубый фолбэк
  if (settings.provider === 'anthropic') return BY_ID.anthropic;

  return null;
}

/** Готовый inline-SVG для иконки (24×24). */
export function brandSvg(brand) {
  if (!brand) return '';
  return (
    `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">` +
    `<rect width="24" height="24" rx="7" fill="${brand.color}"/>` +
    brand.glyph +
    `</svg>`
  );
}

export { BRANDS };
