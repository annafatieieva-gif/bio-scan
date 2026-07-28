// ocr.js — розпізнавання тексту з фото та PDF + пошук показників аналізів

// Словник показників: ключ, підписи для пошуку (регекс-варіанти), одиниця за замовчуванням,
// орієнтовний "нормальний" діапазон для дорослих (довідково, НЕ медична консультація).
const TEST_DICTIONARY = [
  { key: 'hemoglobin', label: 'Гемоглобін', pat: /гемоглобін|hgb|hb\b/i, unit: 'г/л', ref: [120, 160] },
  { key: 'erythrocytes', label: 'Еритроцити', pat: /еритроцит|rbc\b/i, unit: '×10¹²/л', ref: [3.8, 5.5] },
  { key: 'leukocytes', label: 'Лейкоцити', pat: /лейкоцит|wbc\b/i, unit: '×10⁹/л', ref: [4, 9] },
  { key: 'platelets', label: 'Тромбоцити', pat: /тромбоцит|plt\b/i, unit: '×10⁹/л', ref: [150, 400] },
  { key: 'esr', label: 'ШОЕ', pat: /шое|шзе|esr\b/i, unit: 'мм/год', ref: [0, 15] },
  { key: 'glucose', label: 'Глюкоза', pat: /глюкоз/i, unit: 'ммоль/л', ref: [3.9, 5.9] },
  { key: 'total_cholesterol', label: 'Холестерин загальний', pat: /холестерин\s*(загальн|заг\.)?|cholesterol/i, unit: 'ммоль/л', ref: [0, 5.2] },
  { key: 'ldl', label: 'ЛПНЩ (LDL)', pat: /лпнщ|ldl/i, unit: 'ммоль/л', ref: [0, 3.0] },
  { key: 'hdl', label: 'ЛПВЩ (HDL)', pat: /лпвщ|hdl/i, unit: 'ммоль/л', ref: [1.0, 999] },
  { key: 'triglycerides', label: 'Тригліцериди', pat: /тригліцерид/i, unit: 'ммоль/л', ref: [0, 1.7] },
  { key: 'alt', label: 'АЛТ', pat: /\balt\b|алт\b/i, unit: 'Од/л', ref: [0, 41] },
  { key: 'ast', label: 'АСТ', pat: /\bast\b|аст\b/i, unit: 'Од/л', ref: [0, 40] },
  { key: 'bilirubin', label: 'Білірубін загальний', pat: /білірубін/i, unit: 'мкмоль/л', ref: [3.4, 20.5] },
  { key: 'creatinine', label: 'Креатинін', pat: /креатинін/i, unit: 'мкмоль/л', ref: [53, 106] },
  { key: 'urea', label: 'Сечовина', pat: /сечовин/i, unit: 'ммоль/л', ref: [2.5, 7.5] },
  { key: 'tsh', label: 'ТТГ', pat: /ттг|tsh\b/i, unit: 'мОд/л', ref: [0.4, 4.0] },
  { key: 'ft4', label: 'Т4 вільний', pat: /т4\s*вільн|free\s*t4|ft4/i, unit: 'пмоль/л', ref: [9, 22] },
  { key: 'ferritin', label: 'Феритин', pat: /феритин/i, unit: 'мкг/л', ref: [15, 150] },
  { key: 'vitd', label: 'Вітамін D', pat: /вітамін\s*d|25-oh|витамин\s*d/i, unit: 'нг/мл', ref: [30, 100] },
  { key: 'b12', label: 'Вітамін B12', pat: /в12|b12|вітамін\s*b12/i, unit: 'пг/мл', ref: [190, 900] },
  { key: 'iron', label: 'Залізо', pat: /залізо\b|iron\b/i, unit: 'мкмоль/л', ref: [9, 30] },
  { key: 'crp', label: 'СРБ (CRP)', pat: /срб|crp/i, unit: 'мг/л', ref: [0, 5] },
];

const OCR = {
  dictionary: TEST_DICTIONARY,

  // Розпізнати текст із зображення (dataURL або Blob)
  async recognizeImage(source, onProgress) {
    const { data } = await Tesseract.recognize(source, 'ukr+eng', {
      logger: (m) => {
        if (onProgress && m.status === 'recognizing text') {
          onProgress(Math.round(m.progress * 100));
        }
      }
    });
    return data.text || '';
  },

  // Витягти текст з PDF: спершу пробуємо текстовий шар, якщо мало тексту — рендеримо
  // сторінки в canvas і робимо OCR (для сканованих бланків).
  async extractPdf(arrayBuffer, onProgress) {
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((it) => it.str).join(' ');
      fullText += pageText + '\n';
    }

    if (fullText.trim().length > 40) {
      return fullText; // текстовий PDF — OCR не потрібен
    }

    // Схоже на скан — рендеримо кожну сторінку і женемо через Tesseract
    let ocrText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pageText = await this.recognizeImage(canvas, (p) => {
        if (onProgress) onProgress(Math.round(((i - 1) + p / 100) / pdf.numPages * 100));
      });
      ocrText += pageText + '\n';
    }
    return ocrText;
  },

  // Пошук показників у розпізнаному тексті. Приймає словник ззовні (базовий +
  // раніше "вивчені" показники), щоб з часом розпізнавання розширювалось.
  // Шукає число (можливо з комою) поруч (до ~60 символів) після назви показника.
  findMarkers(text, dictionary) {
    const dict = dictionary || TEST_DICTIONARY;
    const found = [];
    const clean = text.replace(/\s+/g, ' ');
    for (const test of dict) {
      const re = new RegExp(test.pat instanceof RegExp ? test.pat.source : test.pat, 'gi');
      let m;
      while ((m = re.exec(clean)) !== null) {
        const tail = clean.slice(m.index, m.index + 140);
        const numMatch = tail.match(/(\d{1,4}[.,]\d{1,3}|\d{1,4})/);
        if (numMatch) {
          const value = parseFloat(numMatch[1].replace(',', '.'));
          if (!isNaN(value)) {
            // Референс беремо з самого бланка, якщо він там є — лабораторії
            // часто мають власні межі, точніші за загальний довідник.
            const afterValue = tail.slice(numMatch.index + numMatch[0].length);
            const docRef = this.parseRefFromTail(afterValue);
            found.push({ key: test.key, label: test.label, unit: test.unit, value, ref: docRef || test.ref || null });
            break; // одне значення на показник з одного тексту достатньо
          }
        }
        re.lastIndex = m.index + 1; // захист від нескінченного циклу на нульовій довжині
      }
    }
    return found;
  },

  // Шукає в тексті одразу після результату і одиниці вимірювання референтний
  // діапазон виду "4.0 - 5.5" або "< 4" / ">= 9". Повертає [low, high] або null.
  // Це best-effort: для показників із віковими/іншими багаторівневими нормами
  // (напр. феритин) може підхопити не той рядок — тому завжди варто звірити
  // з оригінальним бланком.
  parseRefFromTail(str) {
    const rangeMatch = str.match(/(\d{1,4}(?:[.,]\d{1,3})?)\s*[-–]\s*(\d{1,4}(?:[.,]\d{1,3})?)/);
    if (rangeMatch) {
      const low = parseFloat(rangeMatch[1].replace(',', '.'));
      const high = parseFloat(rangeMatch[2].replace(',', '.'));
      if (!isNaN(low) && !isNaN(high) && high >= low) return [low, high];
    }
    const ltMatch = str.match(/<\s*=?\s*(\d{1,4}(?:[.,]\d{1,3})?)/);
    if (ltMatch) {
      const high = parseFloat(ltMatch[1].replace(',', '.'));
      if (!isNaN(high)) return [0, high];
    }
    return null;
  },

  // Екранування спецсимволів regex — потрібно, щоб зберегти довільну назву
  // показника як шаблон пошуку на майбутнє.
  escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  // Стабільний ключ з довільного тексту (щоб однакова назва завжди
  // потрапляла в один і той самий показник/графік).
  keyFromLabel(label) {
    const norm = label.trim().toLowerCase();
    let h = 7;
    for (const ch of norm) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return 'custom_' + h.toString(36);
  },

  // Шукає рядки виду "Назва показника  <число> <одиниця?>", які НЕ збігаються
  // з жодним відомим показником зі словника — це кандидати на нові показники,
  // яких додаток ще не знає. Результат — для перегляду й підтвердження людиною.
  findGenericCandidates(text, dictionary) {
    const dict = dictionary || TEST_DICTIONARY;
    const lineRe = /([^\d\n:]{3,40}?)[\s:–\-]{1,3}(\d{1,4}(?:[.,]\d{1,3})?)\s*([a-zA-Zа-яА-ЯіІїЇєЄґҐ/%°]{0,15})/u;
    const rawLines = text.split(/\n+/).flatMap((l) => l.split(/ {2,}/));
    const candidates = [];
    const seen = new Set();

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (line.length < 5) continue;
      const m = line.match(lineRe);
      if (!m) continue;
      const label = m[1].trim().replace(/^[-–•\s]+/, '');
      if (label.length < 3 || !/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(label)) continue;

      const alreadyKnown = dict.some((t) => {
        const re = new RegExp(t.pat instanceof RegExp ? t.pat.source : t.pat, 'i');
        return re.test(label);
      });
      if (alreadyKnown) continue;

      const norm = label.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);

      const value = parseFloat(m[2].replace(',', '.'));
      if (isNaN(value)) continue;

      const afterMatch = line.slice(m.index + m[0].length);
      const ref = this.parseRefFromTail(afterMatch);

      candidates.push({ label, value, unit: m[3] || '', ref });
      if (candidates.length >= 12) break;
    }
    return candidates;
  }
};
