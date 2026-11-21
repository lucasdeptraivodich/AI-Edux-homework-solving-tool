/**
 * =============================================================================
 * EDUX AI QUIZ SOLVER - CONTENT SCRIPT (Manifest V3 - Phiên bản nâng cấp EduX)
 * Hỗ trợ cả 2 chế độ:
 * 1. Chế độ Từng câu một (Single Question / Pagination) với nút "Câu tiếp >" (giao diện thực tế của EduX CMCU)
 * 2. Chế độ Tất cả câu trên một trang (List view)
 * =============================================================================
 */

// =============================================================================
// 1. CẤU HÌNH & THAM SỐ
// =============================================================================
const SELECTORS = {
  // Fallback selector nếu web có class chuẩn
  questionItem: '.question-item, [class*="question-item"], [class*="quiz-item"]',
  questionText: '.question-title, .question-text, .question-content, h3, h4, [class*="question-title"]',
  optionItem: '.option-item, .answer-item, .choice-item, label, [role="radio"], [role="option"], [class*="option"], [class*="choice"]',
  optionLabel: '.option-label, .option-key, .choice-key',
  optionText: '.option-content, .option-text, .choice-content'
};

const CONFIG = {
  model: 'gemini-1.5-flash',
  minDelay: 1500, // 1.5 giây
  maxDelay: 3500, // 3.5 giây
  highlightBorder: '2px solid #28a745',
  highlightBg: 'rgba(40, 167, 69, 0.15)'
};

// =============================================================================
// 2. BIẾN TOÀN CỤC & TRẠNG THÁI
// =============================================================================
let isRunning = false;
let currentMode = 'quiz'; // 'quiz' | 'lecture'
let fastMode = false;
let lastStatusText = '';
let hudElement = null;

// Bộ nhớ đệm đáp án Bài giảng AI (chỉ lưu khi đã Kiểm tra ĐÚNG)
const LECTURE_CACHE_STORAGE_KEY = 'eduxLectureAnswerCache';
const LECTURE_CACHE_MAX_ENTRIES = 500;
const lectureAnswerCache = new Map();
let lectureCacheLoaded = false;

// =============================================================================
// 3. TIỆN ÍCH HỖ TRỢ (HELPERS)
// =============================================================================

function getRandomDelay(min = CONFIG.minDelay, max = CONFIG.maxDelay) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getSpeedDelay(normalMin, normalMax, fastMin, fastMax) {
  return fastMode ? getRandomDelay(fastMin, fastMax) : getRandomDelay(normalMin, normalMax);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(checkFn, timeoutMs = 3000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning) {
    const val = checkFn();
    if (val) return val;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
  return null;
}

function buildLectureCacheKey(questionText, options) {
  const qNorm = normalizeText(questionText).toLowerCase();
  const optsNorm = (options || [])
    .map((o) => `${o.label}:${normalizeText(o.text).toLowerCase()}`)
    .join('|');
  return `${qNorm}__${optsNorm}`;
}

async function loadLectureAnswerCache() {
  if (lectureCacheLoaded) return;
  lectureCacheLoaded = true;
  try {
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get([LECTURE_CACHE_STORAGE_KEY], (res) => resolve(res || {}));
    });
    const obj = stored[LECTURE_CACHE_STORAGE_KEY];
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        lectureAnswerCache.set(k, v);
      }
    }
  } catch (e) {}
}

function persistLectureAnswerCache() {
  try {
    while (lectureAnswerCache.size > LECTURE_CACHE_MAX_ENTRIES) {
      const oldestKey = lectureAnswerCache.keys().next().value;
      if (oldestKey === undefined) break;
      lectureAnswerCache.delete(oldestKey);
    }
    const obj = Object.fromEntries(lectureAnswerCache.entries());
    chrome.storage.local.set({ [LECTURE_CACHE_STORAGE_KEY]: obj });
  } catch (e) {}
}

function notifyPopup(action, text, isError = false) {
  if (text) {
    lastStatusText = text;
  }
  try {
    chrome.runtime.sendMessage({ action, text, isError });
  } catch (e) {
    // Popup có thể đang đóng
  }
}

// Lấy container gốc (nếu làm bài trong Dialog/Modal như Radix UI)
function getQuizRoot() {
  return document.querySelector('[role="dialog"]') ||
         document.querySelector('.quiz-container, #root, main') ||
         document.body;
}

// =============================================================================
// 4. GIAO DIỆN NỔI TRÊN TRANG (HUD)
// =============================================================================

// =============================================================================
// 4. QUẢN LÝ GIAO DIỆN (ĐÃ XÓA BANNER HUD NỔI TRÊN TRANG THEO YÊU CẦU NGƯỜI DÙNG)
// =============================================================================

function createHUD() {
  // Đã gỡ bỏ banner nổi để giao diện làm bài hoàn toàn sạch sẽ, không che khuất đề
  removeHUD();
}

function updateHUD(status, detail, progressPercent = null) {
  // Không hiển thị banner nổi trên trang, thông tin tiến trình được gửi trực tiếp về Popup
}

function removeHUD() {
  const el = document.getElementById('edux-solver-hud');
  if (el) el.remove();
  const style = document.getElementById('edux-solver-hud-style');
  if (style) style.remove();
  hudElement = null;
}

// =============================================================================
// 5. BÓC TÁCH THÔNG MINH (HỖ TRỢ ĐẶC BIỆT CHO EDUX REACT / TAILWIND)
// =============================================================================

/**
 * Lấy tổng số câu hỏi từ giao diện (ví dụ: "0/30 câu" hoặc các số trang 1, 2, ... 30)
 */
function getTotalQuestionsFromUI() {
  const root = getQuizRoot();
  const text = root.innerText || '';

  // 1. Tìm mẫu "0/30 câu" hoặc "1/30"
  const match = text.match(/(\d+)\s*\/\s*(\d+)\s*câu/i) || text.match(/(\d+)\s*\/\s*(\d+)/);
  if (match && match[2]) {
    const total = parseInt(match[2], 10);
    if (total > 0 && total <= 200) return total;
  }

  // 2. Tìm số lớn nhất trong các nút pagination ở chân trang
  const buttons = Array.from(root.querySelectorAll('button, [role="button"], span, div'));
  const pageNumbers = buttons
    .map((b) => parseInt(b.innerText?.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= 100);

  if (pageNumbers.length > 0) {
    return Math.max(...pageNumbers);
  }

  return 30; // Mặc định 30 câu nếu không tìm thấy
}

/**
 * Kích hoạt đầy đủ sự kiện Pointer + Mouse + đúng 1 lần Click an toàn cho React 18 / Vue / Angular
 */
function clickElementSafely(el) {
  if (!el) return;
  const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup'];
  eventTypes.forEach((type) => {
    try {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  });
  try {
    el.click();
  } catch (e) {}
}

/**
 * Tìm nút "Câu tiếp >" trên giao diện EduX
 */
function findNextButton() {
  const root = getQuizRoot();
  const buttons = Array.from(root.querySelectorAll('button, [role="button"], a'));
  const foundBtn = buttons.find((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const isNext =
      text.includes('Câu tiếp') ||
      text.includes('Tiếp theo') ||
      text.includes('Tiếp tục') ||
      text.includes('Kế tiếp') ||
      text === '>' ||
      text === '»';
    const notDisabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const isVisible = el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
    return isNext && notDisabled && isVisible;
  });
  if (foundBtn) return foundBtn;

  // Fallback sang div/span
  const candidates = Array.from(root.querySelectorAll('div, span'));
  return candidates.find((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const isNext = text.includes('Câu tiếp') || text === 'Câu tiếp >';
    const notDisabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const isVisible = el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
    return isNext && notDisabled && isVisible && el.children.length <= 2;
  });
}

/**
 * Tìm nút số trang cụ thể trên thanh pagination (ví dụ nút số "2", "3")
 */
function findPaginationButton(pageNum) {
  const root = getQuizRoot();
  const candidates = Array.from(root.querySelectorAll('button, [role="button"], span, div'));
  return candidates.find((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    const notDisabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const isVisible = el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
    return text === String(pageNum) && notDisabled && isVisible && el.children.length === 0;
  });
}

/**
 * Chuyển sang câu tiếp theo bằng cả 2 cách: Nút "Câu tiếp >" và Nút số trang pagination
 */
async function advanceToNextQuestion(targetNum) {
  const nextBtn = findNextButton();
  if (nextBtn) {
    clickElementSafely(nextBtn);
    await sleep(800);
  }

  // Nếu vẫn chưa chuyển trang, bấm thẳng vào số câu trên pagination
  if (targetNum) {
    const pageBtn = findPaginationButton(targetNum);
    if (pageBtn) {
      clickElementSafely(pageBtn);
      await sleep(600);
    }
  }
}

/**
 * Tìm tất cả các hàng mệnh đề ĐÚNG / SAI (True/False sub-items)
 * Tương thích cao với định dạng EduX CMCU: Mỗi mệnh đề có 2 nút [Đúng] và [Sai] bên cạnh
 */
function findTrueFalseRows(container) {
  if (!container) return [];

  const results = [];

  const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const isDungWord = (s) => {
    const t = normalize(s);
    return t === 'đúng' || t === 'true' || t === 'đ';
  };

  const isSaiWord = (s) => {
    const t = normalize(s);
    return t === 'sai' || t === 'false' || t === 's';
  };

  const getTop = (el) => {
    try {
      const rect = el.getBoundingClientRect();
      return rect.top + (window.scrollY || 0);
    } catch (e) {
      return 0;
    }
  };

  // 1. Quét tất cả các phần tử có thể tương tác (button, label, [role="button"], div, span)
  const allClickables = Array.from(
    container.querySelectorAll('button, [role="button"], label, div, span, a')
  ).filter((el) => {
    if (el.closest('#edux-solver-hud')) return false;
    const t = normalize(el.innerText || el.textContent);
    // Bỏ qua badge tiêu đề như "Đúng sai" hoặc đoạn hướng dẫn
    if (t.includes('đúng sai') || t.includes('đúng / sai') || t.includes('chọn đúng hoặc sai')) return false;
    return true;
  });

  // Tìm các phần tử là nhãn nút Đúng hoặc nút Sai
  const dungEls = allClickables.filter(
    (el) => isDungWord(el.innerText || el.textContent) && el.children.length <= 1
  );
  const saiEls = allClickables.filter(
    (el) => isSaiWord(el.innerText || el.textContent) && el.children.length <= 1
  );

  // Lọc chỉ lấy leaf nodes sâu nhất
  const leafDung = dungEls.filter((d) => !dungEls.some((other) => other !== d && d.contains(other)));
  const leafSai = saiEls.filter((s) => !saiEls.some((other) => other !== s && s.contains(other)));

  leafDung.sort((a, b) => getTop(a) - getTop(b));
  leafSai.sort((a, b) => getTop(a) - getTop(b));

  if (leafDung.length > 0 && leafSai.length > 0) {
    const usedSai = new Set();

    leafDung.forEach((dBtn, idx) => {
      const dTop = getTop(dBtn);

      // Tìm nút Sai có tọa độ Y gần nhất (cùng hàng ngang)
      let bestSai = null;
      let minDiff = Infinity;

      leafSai.forEach((sBtn) => {
        if (usedSai.has(sBtn)) return;
        const diff = Math.abs(dTop - getTop(sBtn));
        if (diff < minDiff) {
          minDiff = diff;
          bestSai = sBtn;
        }
      });

      // Nếu không khớp theo tọa độ, ghép theo thứ tự xuất hiện
      if (!bestSai && idx < leafSai.length && !usedSai.has(leafSai[idx])) {
        bestSai = leafSai[idx];
      }

      if (bestSai) {
        usedSai.add(bestSai);

        const realDungBtn = dBtn.closest('button, [role="button"], label') || dBtn;
        const realSaiBtn = bestSai.closest('button, [role="button"], label') || bestSai;

        // Tìm thẻ container chung gần nhất của cặp nút này
        let rowEl = dBtn.parentElement;
        while (rowEl && rowEl !== container && rowEl !== document.body) {
          if (rowEl.contains(bestSai)) break;
          rowEl = rowEl.parentElement;
        }

        // Bóc tách nội dung mệnh đề
        let statementText = '';
        if (rowEl) {
          const rawRowText = (rowEl.innerText || rowEl.textContent || '').trim();
          const cleanRowText = rawRowText
            .replace(/\bĐúng\b|\bSai\b|Đúng|Sai/gi, '')
            .replace(/Chọn Đúng hoặc Sai cho từng mệnh đề:?/gi, '')
            .trim();

          if (cleanRowText.length > 3) {
            statementText = cleanRowText;
          } else if (rowEl.parentElement) {
            const pText = (rowEl.parentElement.innerText || '').trim();
            const cleanPText = pText
              .replace(/\bĐúng\b|\bSai\b|Đúng|Sai/gi, '')
              .replace(/Chọn Đúng hoặc Sai cho từng mệnh đề:?/gi, '')
              .trim();
            statementText = cleanPText;
          }

          if (!statementText && rowEl.previousElementSibling) {
            statementText = (rowEl.previousElementSibling.innerText || '').trim();
          }
        }

        // Nếu nội dung chứa nhiều dòng, lọc lấy dòng của mệnh đề hiện tại
        if (statementText.includes('\n')) {
          const lines = statementText.split('\n').map((l) => l.trim()).filter(Boolean);
          const matchedLine = lines.find((l) =>
            new RegExp(`^(${idx + 1}[\\.\\:\\)]|[a-d][\\.\\:\\)])`, 'i').test(l)
          );
          if (matchedLine) {
            statementText = matchedLine;
          } else if (lines.length > 0) {
            statementText = lines[lines.length - 1];
          }
        }

        results.push({
          index: idx + 1,
          rowElement: rowEl || realDungBtn.parentElement,
          statementText: statementText || `Mệnh đề ${idx + 1}`,
          dungBtn: realDungBtn,
          saiBtn: realSaiBtn
        });
      }
    });
  }

  // Fallback 2: Quét qua các khối hàng có chứa cả chữ Đúng và Sai
  if (results.length === 0) {
    const candidateContainers = Array.from(
      container.querySelectorAll('div, li, [class*="item"], [class*="row"], tr')
    ).filter((el) => {
      if (el === container || el.contains(container)) return false;
      if (el.closest('#edux-solver-hud')) return false;

      const txt = (el.innerText || '').trim();
      if (!txt.includes('Đúng') || !txt.includes('Sai')) return false;
      if (txt.length > 500) return false;

      const cClick = Array.from(el.querySelectorAll('button, [role="button"], div, label, span, a'));
      const d = cClick.find((c) => isDungWord(c.innerText || c.textContent) && c.children.length <= 1);
      const s = cClick.find((c) => isSaiWord(c.innerText || c.textContent) && c.children.length <= 1);
      return !!(d && s);
    });

    const innermost = candidateContainers.filter(
      (cand) => !candidateContainers.some((other) => other !== cand && cand.contains(other))
    );
    innermost.sort((a, b) => getTop(a) - getTop(b));

    innermost.forEach((row, idx) => {
      const cClick = Array.from(row.querySelectorAll('button, [role="button"], div, label, span, a'));
      const d = cClick.find((c) => isDungWord(c.innerText || c.textContent) && c.children.length <= 1);
      const s = cClick.find((c) => isSaiWord(c.innerText || c.textContent) && c.children.length <= 1);
      if (d && s) {
        const realD = d.closest('button, [role="button"], label') || d;
        const realS = s.closest('button, [role="button"], label') || s;
        let st = (row.innerText || '')
          .replace(/Đúng|Sai/gi, '')
          .replace(/Chọn Đúng hoặc Sai cho từng mệnh đề:?/gi, '')
          .trim();

        results.push({
          index: idx + 1,
          rowElement: row,
          statementText: st || `Mệnh đề ${idx + 1}`,
          dungBtn: realD,
          saiBtn: realS
        });
      }
    });
  }

  return results;
}

/**
 * Bóc tách câu hỏi và các lựa chọn ĐANG HIỂN THỊ trên màn hình hiện tại (EduX Single Question)
 */
function extractCurrentSingleQuestion() {
  const root = getQuizRoot();
  const allElements = Array.from(root.querySelectorAll('*'));

  // 1. Tìm tiêu đề câu hỏi: tìm phần tử chứa "Câu [0-9]+" hoặc "Bài [0-9]+"
  let questionText = '';
  let questionNumber = 1;

  // Lọc các node chứa "Câu X" hoặc "Bài X"
  let qTitleNodes = allElements.filter((el) => {
    const text = el.innerText?.trim() || '';
    return /^(?:Câu|Bài)\s*\d+/i.test(text) && el.children.length <= 4;
  });

  if (qTitleNodes.length === 0) {
    qTitleNodes = allElements.filter((el) => {
      const text = el.innerText?.trim() || '';
      return /(?:Câu|Bài)\s*\d+/i.test(text) && text.length < 500 && el.children.length <= 6;
    });
  }

  if (qTitleNodes.length > 0) {
    const titleNode = qTitleNodes[0];
    const numMatch = (titleNode.innerText || '').match(/(?:Câu|Bài)\s*(\d+)/i);
    if (numMatch) {
      questionNumber = parseInt(numMatch[1], 10);
    }

    // Trên EduX, cấu trúc đề thi gồm hàng tiêu đề (Câu X [Trắc nghiệm] / [Đúng sai] :) và nội dung câu hỏi nằm trong .flex.items-start
    const questionRow =
      titleNode.closest('div[class*="items-start"]') ||
      titleNode.closest('div[class*="mb-2"]') ||
      titleNode.parentElement?.parentElement;

    if (questionRow && questionRow.innerText.trim().length > 20) {
      // Lấy trọn vẹn cả tiêu đề và đề bài câu hỏi
      questionText = questionRow.innerText.trim();
    } else {
      // Fallback: kết hợp title với khối nội dung kế bên
      const nextSibling = titleNode.parentElement?.nextElementSibling || titleNode.nextElementSibling;
      const siblingText = nextSibling ? nextSibling.innerText.trim() : '';
      questionText = `${titleNode.parentElement?.innerText || titleNode.innerText} ${siblingText}`.trim();
    }

    // Dọn dẹp các nhãn giao diện thừa như "Trắc nghiệm", "Đúng sai", "Điền chỗ trống" để nội dung đề bài chuẩn xác nhất
    questionText = questionText
      .replace(/Trắc nghiệm\s*[:\-]?\s*/gi, '')
      .replace(/Đúng\s*sai\s*[:\-]?\s*/gi, '')
      .replace(/Đúng\s*\/\s*Sai\s*[:\-]?\s*/gi, '')
      .replace(/Điền chỗ trống\s*[:\-]?\s*/gi, '')
      .replace(/Điền từ hoặc cụm từ phù hợp vào chỗ trống\s*[:\-]?\s*/gi, '')
      .replace(/Chọn Đúng hoặc Sai cho từng mệnh đề:?/gi, '')
      .trim();
  } else {
    // Fallback: Tìm tiêu đề thông qua thẻ h1-h4 hoặc class questionText
    const heading = root.querySelector(SELECTORS.questionText);
    if (heading) {
      questionText = heading.innerText.trim();
    }
  }

  // 2. Tìm các lựa chọn A, B, C, D (cho câu trắc nghiệm nhiều lựa chọn)
  const options = [];
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

  // Chiến lược 1: Tìm trực tiếp các hàng container lựa chọn của EduX (div có cursor-pointer và bắt đầu bằng A, B, C, D)
  const candidateRows = Array.from(
    root.querySelectorAll('div[class*="cursor-pointer"], div[class*="rounded-lg"], [role="radio"], label')
  ).filter((el) => {
    const txt = (el.innerText || '').trim();
    return /^[A-F]\.\s*/i.test(txt) && txt.length < 500 && el.children.length >= 2 && el.children.length <= 6;
  });

  // Sắp xếp các hàng theo tọa độ từ trên xuống dưới trên trang
  candidateRows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  if (candidateRows.length >= 2) {
    candidateRows.forEach((rowEl, idx) => {
      const rawText = rowEl.innerText.trim();
      const match = rawText.match(/^([A-F])[\.\:\)]\s*([\s\S]*)/i);
      const label = match ? match[1].toUpperCase() : (letters[idx] || 'A');
      const text = match ? match[2].trim() : rawText;

      if (!options.some((o) => o.label === label)) {
        options.push({
          label,
          text,
          element: rowEl
        });
      }
    });
  }

  // Chiến lược 2 (Fallback): Tìm theo từng chữ cái A, B, C, D
  if (options.length < 2) {
    options.length = 0;
    letters.slice(0, 4).forEach((letter) => {
      const regex = new RegExp(`^${letter}[\\.\\:\\)]\\s*`, 'i');
      const matchingElements = allElements.filter((el) => {
        const txt = el.innerText?.trim() || '';
        return regex.test(txt) && txt.length < 400;
      });

      if (matchingElements.length > 0) {
        matchingElements.sort((a, b) => a.innerText.length - b.innerText.length);
        const targetEl = matchingElements[0];

        const container =
          targetEl.closest('div[class*="cursor-pointer"], div[class*="rounded"], [role="radio"], label') ||
          targetEl;

        const rawText = targetEl.innerText.trim();
        const content = rawText.replace(regex, '').trim();

        options.push({
          label: letter,
          text: content || rawText,
          element: container
        });
      }
    });
  }

  // 3. Kiểm tra xem có các hàng dạng ĐÚNG / SAI (True/False sub-items) không
  const tfRows = findTrueFalseRows(root);

  // 4. Kiểm tra xem có ô nhập liệu dạng điền từ (fill_blank) không
  const fillInput = Array.from(
    root.querySelectorAll(
      'input[placeholder*="Nhập câu trả lời"], input[placeholder*="câu trả lời"], input[placeholder*="trả lời"], textarea, input[type="text"]'
    )
  ).find((el) => !el.closest('#edux-solver-hud') && (el.offsetParent !== null || el.offsetWidth > 0));

  let questionType = 'multiple_choice';
  if (tfRows.length >= 1) {
    questionType = 'true_false';
  } else if (options.length >= 2) {
    questionType = 'multiple_choice';
  } else if (fillInput) {
    questionType = 'fill_blank';
  }

  return {
    questionNumber,
    questionText,
    questionType,
    options,
    trueFalseRows: tfRows,
    inputElement: questionType === 'fill_blank' ? fillInput : null
  };
}

/**
 * Bóc tách dạng danh sách (áp dụng khi tất cả câu hỏi nằm trên 1 trang dài)
 */
function extractAllQuestionsFromDOM() {
  const root = getQuizRoot();
  const questionNodes = root.querySelectorAll(SELECTORS.questionItem);

  if (!questionNodes || questionNodes.length <= 1) {
    return []; // Nếu <= 1 thì coi như là chế độ từng câu
  }

  const questions = [];
  const alphabet = ['A', 'B', 'C', 'D', 'E', 'F'];

  questionNodes.forEach((qNode, index) => {
    let qText = '';
    const titleNode = qNode.querySelector(SELECTORS.questionText);
    qText = titleNode ? titleNode.innerText.trim() : qNode.innerText.split('\n')[0].trim();

    const optionNodes = qNode.querySelectorAll(SELECTORS.optionItem);
    const options = [];

    optionNodes.forEach((optNode, optIndex) => {
      let label = '';
      const rawText = optNode.innerText.trim();
      const prefixMatch = rawText.match(/^([A-F])[\.\:\)]/i);
      label = prefixMatch ? prefixMatch[1].toUpperCase() : (alphabet[optIndex] || 'A');

      options.push({
        label,
        text: rawText.replace(/^([A-F])[\.\:\)]\s*/i, '').trim(),
        element: optNode
      });
    });

    questions.push({
      index: index + 1,
      element: qNode,
      questionText: qText,
      options
    });
  });

  return questions;
}

// =============================================================================
// 6. TRUY VẤN GEMINI API (QUA BACKGROUND SERVICE WORKER ĐỂ VƯỢT CSP)
// =============================================================================

async function callGeminiAPI(apiKey, questionText, options, callOpts = {}) {
  const isFast = typeof callOpts.fastMode === 'boolean' ? callOpts.fastMode : fastMode;
  const formattedOptions = options
    .map((opt) => `${opt.label}. ${opt.text}`)
    .join('\n');

  const prompt = isFast
    ? `Chọn đáp án đúng nhất cho câu hỏi trắc nghiệm sau. Chỉ trả lời duy nhất 1 dòng theo mẫu "Đáp án: X" (X là A, B, C hoặc D), không giải thích.

Câu hỏi: ${questionText}
${formattedOptions}`
    : `Bạn là một giáo sư, chuyên gia học thuật đại học xuất sắc bậc tiến sĩ, có kiến thức sâu rộng và chính xác tuyệt đối trong TẤT CẢ các lĩnh vực:
- Kinh tế & Quản trị kinh doanh: Kế toán tài chính, Kế toán quản trị (hàng tồn kho, bình quân gia quyền, FIFO, kê khai thường xuyên, kiểm kê định kỳ, giá vốn hàng bán COGS, định khoản nợ/có), Tài chính doanh nghiệp (NPV, IRR, WACC, đòn bẩy, chi phí vốn), Quản trị học, Quản trị chiến lược (SWOT, Porter 5 forces, BCG), Marketing (STP, 4P, 7P), Quản trị nhân sự, Quản trị chuỗi cung ứng (EOQ, JIT).
- Kinh tế học: Kinh tế vi mô, vĩ mô (Cung cầu, độ co giãn, chi phí biên MC, doanh thu biên MR, tối đa hóa lợi nhuận, lạm phát, GDP, chính sách tài khóa/tiền tệ).
- Khoa học xã hội, Pháp luật đại cương, Triết học Mác - Lênin, Tư tưởng Hồ Chí Minh, Lịch sử Đảng.
- Khoa học tự nhiên & Kỹ thuật: Công nghệ thông tin, Kỹ thuật phần mềm, Kiểm thử phần mềm, Toán học, Xác suất thống kê.

Hãy đọc thật kỹ câu hỏi và các phương án lựa chọn dưới đây:

[ĐỀ BÀI CÂU HỎI]:
${questionText}

[DANH SÁCH LỰA CHỌN]:
${formattedOptions}

QUY TRÌNH TƯ DUY HỌC THUẬT BẮT BUỘC ĐỂ ĐẠT ĐỘ CHÍNH XÁC 100%:
1. Xác định chính xác chuyên ngành và chủ đề trọng tâm của câu hỏi.
2. Suy luận và tính toán chi tiết từng bước:
   - NẾU LÀ BÀI TOÁN TÍNH TOÁN (Kế toán, Tài chính, Kinh tế, Toán, Thống kê):
     + Liệt kê rõ các dữ kiện đề bài cho (số lượng, đơn vị, đơn giá, số dư đầu kỳ, hàng nhập, hàng xuất, số dư cuối kỳ...).
     + Nêu rõ công thức học thuật chuẩn áp dụng (Ví dụ: Đơn giá bình quân gia quyền = Tổng giá trị / Tổng số lượng; Giá vốn hàng bán = Số lượng xuất * Đơn giá bình quân; hoặc Giá vốn hàng bán = Tồn đầu kỳ + Nhập trong kỳ - Tồn cuối kỳ...).
     + Thay số và thực hiện phép tính cẩn thận từng bước, không bỏ qua các bước trung gian, đối chiếu lại kết quả số học.
   - NẾU LÀ CÂU HỎI LÝ THUYẾT / TÌNH HUỐNG (Quản trị, Marketing, Pháp luật, Triết học...):
     + Đối chiếu từng phương án với nguyên lý/khái niệm giáo trình đại học chuẩn.
     + Phân tích vì sao các phương án khác sai (bẫy khái niệm, nhầm thuật ngữ) và vì sao phương án được chọn là đúng nhất.
3. Tổng hợp kết luận rõ ràng ở cuối cùng theo đúng cú pháp sau:

[KẾT QUẢ]
Đáp án: [A, B, C hoặc D]`;

  let candidateText = '';

  // Thử gọi API (1 lần, để background tự fallback giữa các model)
  let lastError = null;
  for (let attempt = 1; attempt <= 1; attempt++) {
    try {
      const bgResponse = await new Promise((resolve, reject) => {
        // Timeout 25 giây - đủ để background thử các model chất lượng cao
        const timer = setTimeout(() => {
          reject(new Error('Quá thời gian chờ phản hồi từ Gemini API (Timeout 25s).'));
        }, 25000);

        chrome.runtime.sendMessage(
          { action: 'CALL_GEMINI_PROXY', apiKey, prompt, fastMode: isFast },
          (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!res || !res.success) {
              reject(new Error(res?.error || 'Lỗi không xác định khi gọi Gemini API.'));
            } else {
              resolve(res.data);
            }
          }
        );
      });

      candidateText = bgResponse || '';
      if (candidateText.trim().length > 0) break;
    } catch (e) {
      lastError = e;
    }
  }

  const trimmed = (candidateText || '').trim();

  // 1. Ưu tiên bóc tách từ block [KẾT QUẢ] ở cuối
  let parseZone = trimmed;
  const resultHeaderMatch = trimmed.match(/\[?\s*KẾT QUẢ\s*\]?|\[?\s*KET QUA\s*\]?/i);
  if (resultHeaderMatch) {
    parseZone = trimmed.slice(resultHeaderMatch.index);
  }

  // Bóc tách chữ cái đáp án A, B, C, D...
  const match =
    parseZone.match(/Đáp án\s*[:\-]?\s*([A-F])/i) ||
    parseZone.match(/(?:chọn|phương án|câu)\s*[:\-]?\s*([A-F])/i) ||
    parseZone.match(/\*\*([A-F])\*\*/i) ||
    parseZone.match(/^([A-F])[\.\:\)]/im) ||
    trimmed.match(/Đáp án\s*[:\-]?\s*([A-F])/i) ||
    trimmed.match(/(?:chọn|phương án|câu)\s*[:\-]?\s*([A-F])/i) ||
    trimmed.match(/\*\*([A-F])\*\*/i) ||
    trimmed.match(/^([A-F])[\.\:\)]/im) ||
    trimmed.match(/\b([A-F])\b/i);

  if (match) {
    return match[1].toUpperCase();
  }

  // 2. Fallback theo nội dung text nếu Gemini nhắc tên đáp án
  for (const opt of options) {
    if (opt.text && opt.text.length >= 3 && parseZone.toLowerCase().includes(opt.text.toLowerCase())) {
      console.log(`[EduX AI Solver] Khớp đáp án theo text: [${opt.label}] "${opt.text}"`);
      return opt.label.toUpperCase();
    }
  }

  // 3. Nếu candidate rỗng mà có lastError -> throw để tiến trình tự động retry hoặc xử lý
  if (trimmed.length === 0 && lastError) {
    throw lastError;
  }

  // 4. Fallback chống treo bài thi: nếu Gemini trả về giải thích nhưng không rõ chữ cái, chọn phương án đầu tiên
  console.warn(`[EduX AI Solver] Gemini trả về không rõ chữ cái: "${trimmed}".`);
  return options[0]?.label || 'A';
}

// =============================================================================
// 7. CLICK CHỌN & VIỀN XANH ĐÁP ÁN (TƯƠNG THÍCH REACT SYNTHETIC EVENTS)
// =============================================================================

/**
 * Xóa sạch toàn bộ viền xanh giả lập cũ trên trang (ngăn chặn tình trạng React giữ lại viền xanh cũ từ các câu trước)
 */
function clearHighlights() {
  const root = getQuizRoot();
  const highlighted = root.querySelectorAll('[data-edux-highlighted="true"]');
  highlighted.forEach((el) => {
    el.style.border = '';
    el.style.backgroundColor = '';
    el.style.boxShadow = '';
    el.removeAttribute('data-edux-highlighted');
  });

  // Quét sạch mọi div option, input, button có border inline style màu xanh lá sót lại từ các câu trước do React tái sử dụng DOM
  const allStyled = root.querySelectorAll('div[style*="border"], input[style*="border"], label[style*="border"], button[style*="border"], span[style*="border"]');
  allStyled.forEach((el) => {
    const borderStyle = el.style.border || '';
    if (borderStyle.includes('16, 185, 129') || borderStyle.includes('#10b981') || borderStyle.includes('#28a745')) {
      el.style.border = '';
      el.style.backgroundColor = '';
      el.style.boxShadow = '';
      el.removeAttribute('data-edux-highlighted');
    }
  });
}

function selectAndHighlightOption(option) {
  if (!option || !option.element) return;

  const el = option.element;

  // 1. Cuộn đến vị trí đáp án
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // 2. Xóa sạch viền xanh từ câu trước đó để không bị dính nhiều thanh xanh
  clearHighlights();

  // 3. Đánh dấu viền màu xanh lá thông báo đáp án được chọn
  el.setAttribute('data-edux-highlighted', 'true');
  el.style.border = '2px solid #10b981';
  el.style.borderRadius = '8px';
  el.style.backgroundColor = 'rgba(16, 185, 129, 0.12)';
  el.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.3)';
  el.style.transition = 'all 0.3s ease';

  // 4. Kiểm tra xem lựa chọn này đã được chọn trong React state của EduX chưa
  // EduX đánh dấu lựa chọn đã chọn bằng class border-blue-500, bg-blue-50 hoặc circle bg-blue-600
  const isAlreadySelected =
    el.classList.contains('border-blue-500') ||
    el.classList.contains('bg-blue-50') ||
    el.querySelector('.bg-blue-600') !== null;

  if (!isAlreadySelected) {
    // Click DUY NHẤT 1 lần vào container (EduX bắt sự kiện onClick trên chính container này)
    // TUYỆT ĐỐI không click thêm các thẻ con bên trong vì sẽ làm event bubbling toggle tắt lựa chọn!
    clickElementSafely(el);
  }

  // Nếu có thẻ input radio bên trong thì cập nhật checked
  const radio = el.querySelector('input[type="radio"]');
  if (radio && !radio.checked) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }

  console.log(`[EduX AI Solver] Đã chọn đáp án: [${option.label}] "${option.text}"`);
}

/**
 * Tự động điền câu trả lời vào ô nhập liệu (Áp dụng cho dạng "Điền chỗ trống")
 */
function fillAnswerToInput(inputEl, answerText) {
  if (!inputEl) return;

  inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  inputEl.focus();

  // Xóa viền cũ
  clearHighlights();

  // Sử dụng Native Property Descriptor của HTMLInputElement để kích hoạt React 18 synthetic onChange
  const prototype =
    inputEl instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  if (nativeSetter) {
    nativeSetter.call(inputEl, answerText);
  } else {
    inputEl.value = answerText;
  }

  // Phát tín hiệu input, change và blur để React state của EduX cập nhật ngay lập tức
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  inputEl.dispatchEvent(new Event('blur', { bubbles: true }));

  // Đánh dấu viền xanh thông báo đã điền
  inputEl.setAttribute('data-edux-highlighted', 'true');
  inputEl.style.border = '2px solid #10b981';
  inputEl.style.backgroundColor = 'rgba(16, 185, 129, 0.08)';
  inputEl.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.3)';

  console.log(`[EduX AI Solver] Đã điền vào ô trống: "${answerText}"`);
}

/**
 * Click chọn và làm nổi bật nút Đúng hoặc Sai (Tương thích React Synthetic Events)
 */
function clickTrueFalseButton(btn) {
  if (!btn) return;

  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Nhắm đúng thẻ tương tác (button, label hoặc container)
  const target = btn.closest('button, label, [role="button"]') || btn;
  clickElementSafely(target);

  // Kích hoạt input radio bên trong nếu có
  const radio = target.querySelector('input[type="radio"]') || target.parentElement?.querySelector('input[type="radio"]');
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    radio.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Viền xanh lá và đổ bóng thông báo đã chọn
  target.setAttribute('data-edux-highlighted', 'true');
  target.style.border = '2px solid #10b981';
  target.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
  target.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.4)';
  target.style.borderRadius = '6px';
  target.style.transition = 'all 0.2s ease';
}

/**
 * Gọi Gemini giải câu hỏi dạng ĐÚNG / SAI (Đa mệnh đề hoặc đơn mệnh đề)
 * Áp dụng Chain-of-Thought (Suy luận học thuật từng bước) để tăng tối đa độ chính xác
 */
async function callGeminiTrueFalse(apiKey, questionText, statements) {
  const formattedStatements = statements
    .map((s, idx) => `${idx + 1}. ${s.statementText}`)
    .join('\n');

  const prompt = `Bạn là một chuyên gia giáo sư học thuật đại học xuất sắc.
Hãy phân tích cẩn thận và đánh giá chính xác tính ĐÚNG hoặc SAI của từng mệnh đề trong đề thi dưới đây:

[ĐỀ BÀI CÂU HỎI]:
${questionText}

[DANH SÁCH CÁC MỆNH ĐỀ]:
${formattedStatements}

CHIẾN LƯỢC TƯ DUY NÂNG CAO ĐỘ CHÍNH XÁC (TỐI QUAN TRỌNG):
1. Nhận diện chuyên ngành học thuật (Công nghệ phần mềm, Kiểm thử phần mềm/Testing, Trí tuệ nhân tạo, Khoa học máy tính, Kinh tế, Toán học,...).
2. Phân tích ngữ nghĩa chuyên sâu và đối chiếu với các nguyên lý/chuẩn mực học thuật chính thống:
   - Cảnh giác cao độ với các từ mang tính bẫy tuyệt đối hóa như: "chỉ cần", "luôn luôn", "tất cả", "không cần", "không bao giờ" -> Trong trắc nghiệm đại học, các mệnh đề này thường là SAI trừ khi định luật/định lý phát biểu như vậy.
   - Các mệnh đề đề cập đến thực hành tốt (best practice), an toàn, xử lý ngoại lệ, kiểm thử biên (boundary test, null, buffer overflow, exception) thường là ĐÚNG.
3. Suy luận vắn tắt cho từng mệnh đề (1-2 câu giải thích lý do kỹ thuật vì sao Đúng hoặc Sai).
4. Cuối cùng, tổng hợp kết quả rõ ràng ở phần [KẾT QUẢ] theo đúng cú pháp sau để hệ thống tự động nhận diện:

[KẾT QUẢ]
1: Đúng (hoặc Sai)
2: Đúng (hoặc Sai)
3: Đúng (hoặc Sai)
4: Đúng (hoặc Sai)`;

  let responseText = '';
  try {
    responseText = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Quá thời gian chờ phản hồi từ Gemini API (Timeout 25s).'));
      }, 25000);

      chrome.runtime.sendMessage(
        { action: 'CALL_GEMINI_PROXY', apiKey, prompt },
        (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!res || !res.success) {
            reject(new Error(res?.error || 'Lỗi không xác định khi gọi Gemini API.'));
          } else {
            resolve(res.data || '');
          }
        }
      );
    });
  } catch (e) {
    throw e;
  }

  const trimmed = (responseText || '').trim();
  const results = {};

  // Nếu có phần [KẾT QUẢ], ưu tiên bóc tách từ phần [KẾT QUẢ]
  let parseZone = trimmed;
  const resultHeaderMatch = trimmed.match(/\[?\s*KẾT QUẢ\s*\]?|\[?\s*KET QUA\s*\]?/i);
  if (resultHeaderMatch) {
    parseZone = trimmed.slice(resultHeaderMatch.index);
  }

  // Phân tích từng dòng trả về (hỗ trợ cả 1:, 1., a:, a., Mệnh đề 1:, Ý 1:)
  const lines = parseZone.split('\n');
  lines.forEach((line) => {
    const match = line.match(/(?:mệnh đề\s*|ý\s*)?([1-9]|a|b|c|d)[\:\.\)\-\s]\s*(?:đáp án\s*)?[:\s]*(Đúng|Sai|True|False)/i);
    if (match) {
      const idx = isNaN(match[1]) ? match[1].toLowerCase().charCodeAt(0) - 96 : parseInt(match[1], 10);
      const val = match[2].toLowerCase();
      results[idx] = val === 'đúng' || val === 'true' ? 'Đúng' : 'Sai';
    }
  });

  // Fallback 1: Nếu parseZone chưa đủ, quét toàn bộ responseText
  if (Object.keys(results).length < statements.length) {
    trimmed.split('\n').forEach((line) => {
      const match = line.match(/(?:mệnh đề\s*|ý\s*)?([1-9]|a|b|c|d)[\:\.\)\-\s]\s*(?:đáp án\s*)?[:\s]*(Đúng|Sai|True|False)/i);
      if (match) {
        const idx = isNaN(match[1]) ? match[1].toLowerCase().charCodeAt(0) - 96 : parseInt(match[1], 10);
        const val = match[2].toLowerCase();
        if (!results[idx]) {
          results[idx] = val === 'đúng' || val === 'true' ? 'Đúng' : 'Sai';
        }
      }
    });
  }

  // Fallback 2: Nếu còn sót mệnh đề chưa parse được
  statements.forEach((s, idx) => {
    const i = idx + 1;
    if (!results[i]) {
      const regexSai = new RegExp(`(?:${i}|${String.fromCharCode(96 + i)})[^\\n]*(?:Sai|False)`, 'i');
      if (regexSai.test(trimmed)) {
        results[i] = 'Sai';
      } else {
        results[i] = 'Đúng';
      }
    }
  });

  return results;
}

/**
 * Gọi Gemini giải câu hỏi dạng ĐIỀN CHỖ TRỐNG / TỰ LUẬN NGẮN (Fill in the blank)
 */
async function callGeminiFillBlank(apiKey, questionText) {
  const prompt = `Bạn là một chuyên gia học thuật xuất sắc trình độ đại học.
Đây là câu hỏi dạng [TỰ LUẬN NGẮN / ĐIỀN TỪ VÀO CHỖ TRỐNG] (hoàn toàn không có các phương án lựa chọn A, B, C, D).

[CÂU HỎI]:
${questionText}

YÊU CẦU QUAN TRỌNG:
1. Đọc kỹ câu hỏi, tự động xác định chuyên ngành môn học và suy luận logic chính xác để tìm từ, cụm từ, thuật ngữ chuyên ngành hoặc đáp số chuẩn xác nhất điền vào chỗ trống (______).
2. Chuẩn hóa đáp án: Trả lời ngắn gọn, chuẩn xác thuật ngữ học thuật, tuyệt đối không thêm từ nối dư thừa, không viết dấu chấm câu ở cuối từ.
3. Bắt buộc trả lời ngay ở dòng đầu tiên theo đúng cú pháp sau:
Điền từ: [từ hoặc cụm từ cần điền]`;

  let responseText = '';
  try {
    responseText = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Quá thời gian chờ phản hồi từ Gemini API (Timeout 25s).'));
      }, 25000);

      chrome.runtime.sendMessage(
        { action: 'CALL_GEMINI_PROXY', apiKey, prompt },
        (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!res || !res.success) {
            reject(new Error(res?.error || 'Lỗi không xác định khi gọi Gemini API.'));
          } else {
            resolve(res.data || '');
          }
        }
      );
    });
  } catch (e) {
    throw e;
  }

  const trimmed = (responseText || '').trim();
  const match =
    trimmed.match(/Điền từ\s*[:\-]?\s*["'“]?([^"'\n\r”]+)["'”]?/i) ||
    trimmed.match(/Đáp án\s*[:\-]?\s*["'“]?([^"'\n\r”]+)["'”]?/i) ||
    trimmed.match(/^["'“]?([^"'\n\r”]+)["'”]?/);

  let result = match ? match[1].trim() : trimmed;
  // Bỏ dấu ngoặc kép, dấu chấm, dấu phẩy thừa ở cuối
  result = result.replace(/^["'“”]+|["'“”]+$/g, '').replace(/[\.\:\;]+$/, '').trim();
  return result;
}

// =============================================================================
// 8. TIẾN TRÌNH GIẢI BÀI TỰ ĐỘNG (HỖ TRỢ AUTO NEXT TỪNG CÂU)
// =============================================================================

async function startAutoSolve(apiKey, mode = 'quiz', isFast = false) {
  if (isRunning) {
    console.warn('EduX AI Solver: Đang có tiến trình chạy, đang reset để bắt đầu lại...');
    isRunning = false;
    await sleep(200);
  }

  currentMode = mode === 'lecture' ? 'lecture' : 'quiz';
  fastMode = Boolean(isFast);
  isRunning = true;
  createHUD();

  if (!apiKey) {
    const errorMsg = 'Chưa có Gemini API Key! Vui lòng nhập trong Popup tiện ích.';
    alert('EduX AI Solver: ' + errorMsg);
    updateHUD('Lỗi cấu hình', errorMsg, 0);
    notifyPopup('SOLVE_FINISHED', '❌ ' + errorMsg, true);
    isRunning = false;
    return;
  }

  if (currentMode === 'lecture') {
    await loadLectureAnswerCache();
    notifyPopup(
      'UPDATE_STATUS',
      `🎓 Đang khởi chạy Bài giảng AI (${fastMode ? '⚡ Siêu tốc' : '🛡️ Tự nhiên'})...`
    );
    await runLectureMode(apiKey);
    return;
  }

  // === CHẾ ĐỘ BÀI TẬP AI (QUIZ / HOMEWORK) ===
  updateHUD('Đang quét cấu trúc bài thi...', 'Khởi động bộ phân tích', 5);
  notifyPopup('UPDATE_STATUS', 'Đang quét cấu trúc bài tập...');

  // 1. Kiểm tra xem là chế độ danh sách (List View) hay chế độ từng câu (Single Question Paginated)
  const listQuestions = extractAllQuestionsFromDOM();

  if (listQuestions.length > 1) {
    // === CHẾ ĐỘ 1: TẤT CẢ CÂU TRÊN 1 TRANG ===
    await runMultiQuestionsMode(apiKey, listQuestions);
  } else {
    // === CHẾ ĐỘ 2: TỪNG CÂU MỘT + AUTO-CLICK "CÂU TIẾP >" (GIAO DIỆN EDUX CMCU) ===
    await runSingleQuestionPaginationMode(apiKey);
  }
}

/**
 * Xử lý giải từng câu một và tự động bấm "Câu tiếp >" (Giao diện chuẩn của EduX CMCU)
 */
async function runSingleQuestionPaginationMode(apiKey) {
  const totalQuestions = getTotalQuestionsFromUI();
  updateHUD('Chế độ: Từng câu một', `Tổng cộng khoảng ${totalQuestions} câu`, 10);
  notifyPopup('UPDATE_STATUS', `Phát hiện đề thi từng câu. Đang giải qua ${totalQuestions} câu...`);

  let currentStep = 1;
  let domRetryCount = 0; // Đếm số lần retry khi không tìm thấy DOM
  const MAX_DOM_RETRIES = 5; // Tối đa 5 lần thử rồi bỏ qua

  while (isRunning && currentStep <= totalQuestions) {
    // Đợi 400ms để DOM câu mới ổn định
    await sleep(400);

    // Xóa sạch toàn bộ viền xanh cũ từ câu trước để ngăn ngừa dính nhiều thanh xanh do React tái sử dụng DOM
    clearHighlights();

    // 1. Bóc tách câu hỏi đang hiển thị trên màn hình
    const qData = extractCurrentSingleQuestion();

    // Đồng bộ ngay số câu thực tế từ giao diện nếu phát hiện được
    if (qData && qData.questionNumber) {
      currentStep = qData.questionNumber;
    }

    // Kiểm tra câu hỏi hợp lệ: trắc nghiệm (>= 2 options) HOẶC Đúng/Sai (>= 1 rows) HOẶC điền ô trống (có inputElement)
    const isQuestionValid =
      qData &&
      ((qData.questionType === 'fill_blank' && qData.inputElement !== null) ||
        (qData.questionType === 'true_false' && qData.trueFalseRows && qData.trueFalseRows.length > 0) ||
        (qData.options && qData.options.length >= 2));

    if (!isQuestionValid) {
      domRetryCount++;
      const currentDispNum = (qData && qData.questionNumber) ? qData.questionNumber : currentStep;
      if (domRetryCount >= MAX_DOM_RETRIES) {
        // Bỏ qua câu này sau khi thử nhiều lần - tự động chuyển tiếp
        console.warn(`[EduX AI Solver] Câu ${currentDispNum}: Không tìm thấy DOM sau ${MAX_DOM_RETRIES} lần, tự động bỏ qua.`);
        updateHUD(`Bỏ qua câu ${currentDispNum}`, 'Không tìm thấy câu hỏi hoặc đáp án, đang chuyển tiếp...', (currentStep / totalQuestions) * 100);
        notifyPopup('UPDATE_STATUS', `⚠️ Câu ${currentDispNum}: Không tìm thấy DOM, tự bỏ qua.`);
        // Thử bấm chuyển tiếp
        await advanceToNextQuestion(currentStep + 1);
        if (qData && qData.questionNumber) {
      currentStep = qData.questionNumber + 1;
    } else {
      currentStep++;
    }
        domRetryCount = 0;
      } else {
        updateHUD(`Đang chờ tải câu ${currentDispNum}...`, `Thử lần ${domRetryCount}/${MAX_DOM_RETRIES}...`, (currentStep / totalQuestions) * 100);
        await sleep(1000);
      }
      continue;
    }
    domRetryCount = 0; // Reset khi tìm thấy DOM thành công

    const qNum = qData.questionNumber || currentStep;
    const progressPercent = Math.round((currentStep / totalQuestions) * 100);

    // 2. PHÂN NHÁNH XỬ LÝ THEO LOẠI CÂU HỎI
    if (qData.questionType === 'fill_blank') {
      // === DẠNG 1: ĐIỀN TỪ VÀO Ô TRỐNG ===
      updateHUD(`Câu ${qNum}/${totalQuestions} [Điền từ]`, `Đang gửi tới Gemini AI...`, progressPercent);
      notifyPopup('UPDATE_STATUS', `Câu ${qNum}/${totalQuestions} [Điền từ]: Đang hỏi Gemini API...`);

      let answerWord = '';
      try {
        answerWord = await callGeminiFillBlank(apiKey, qData.questionText);
      } catch (err) {
        const errText = err.message || 'Lỗi gọi API.';

        if (errText.includes('quota') || errText.includes('Quota') || errText.includes('429') || errText.includes('rate-limit') || errText.includes('retry in')) {
          const retryMatch = errText.match(/retry in ([\d\.]+)\s*s/i);
          let waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 25;

          console.log(`[EduX AI Solver] Đang chờ Google nhả hạn mức Quota: ${waitSec} giây...`);
          for (let s = waitSec; s > 0; s--) {
            if (!isRunning) break;
            updateHUD(
              `⏳ Quota đầy: chờ ${s}s`,
              `Google Free giới hạn lượt gọi. Tự động tiếp tục sau ${s}s...`,
              progressPercent
            );
            notifyPopup('UPDATE_STATUS', `⏳ Quota đầy. Tự động đợi ${s}s để giải tiếp câu ${qNum}...`);
            await sleep(1000);
          }

          if (!isRunning) break;
          continue;
        }

        updateHUD(`Lỗi câu ${qNum}`, `Lỗi: ${errText}. Đang chuyển tiếp...`);
        notifyPopup('UPDATE_STATUS', `❌ Lỗi câu ${qNum}: ${errText}. Đang chuyển tiếp...`, true);

        if (errText.includes('API key not valid') || errText.includes('API_KEY_INVALID') || errText.includes('HTTP 403')) {
          alert('EduX AI Solver: ' + errText);
          isRunning = false;
          notifyPopup('SOLVE_FINISHED', '❌ ' + errText, true);
          break;
        }

        await sleep(1000);
        await advanceToNextQuestion(currentStep + 1);
        if (qData && qData.questionNumber) {
      currentStep = qData.questionNumber + 1;
    } else {
      currentStep++;
    }
        continue;
      }

      if (!isRunning) break;

      // Giả lập thời gian suy nghĩ: delay 1.5s - 3.5s
      const delayMs = getRandomDelay(CONFIG.minDelay, CONFIG.maxDelay);
      const delaySec = (delayMs / 1000).toFixed(1);

      updateHUD(
        `Câu ${qNum}/${totalQuestions}: Điền "${answerWord}"`,
        `Chờ ${delaySec}s để giả lập người dùng...`,
        progressPercent
      );
      notifyPopup('UPDATE_STATUS', `Câu ${qNum}/${totalQuestions}: Điền "${answerWord}" (Chờ ${delaySec}s...)`);

      await sleep(delayMs);

      if (!isRunning) break;

      // Điền câu trả lời vào ô text input và kích hoạt React synthetic event
      fillAnswerToInput(qData.inputElement, answerWord);

    } else if (qData.questionType === 'true_false') {
      // === DẠNG 2: ĐÚNG / SAI (ĐA MỆNH ĐỀ HOẶC ĐƠN MỆNH ĐỀ) ===
      const count = qData.trueFalseRows.length;
      updateHUD(`Câu ${qNum}/${totalQuestions} [Đúng/Sai: ${count} ý]`, `Đang gửi tới Gemini AI...`, progressPercent);
      notifyPopup('UPDATE_STATUS', `Câu ${qNum}/${totalQuestions} [Đúng/Sai: ${count} ý]: Đang hỏi Gemini API...`);

      let tfDecisions = {};
      try {
        tfDecisions = await callGeminiTrueFalse(apiKey, qData.questionText, qData.trueFalseRows);
      } catch (err) {
        const errText = err.message || 'Lỗi gọi API.';

        if (errText.includes('quota') || errText.includes('Quota') || errText.includes('429') || errText.includes('rate-limit') || errText.includes('retry in')) {
          const retryMatch = errText.match(/retry in ([\d\.]+)\s*s/i);
          let waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 25;

          console.log(`[EduX AI Solver] Đang chờ Google nhả hạn mức Quota: ${waitSec} giây...`);
          for (let s = waitSec; s > 0; s--) {
            if (!isRunning) break;
            updateHUD(
              `⏳ Quota đầy: chờ ${s}s`,
              `Google Free giới hạn lượt gọi. Tự động tiếp tục sau ${s}s...`,
              progressPercent
            );
            notifyPopup('UPDATE_STATUS', `⏳ Quota đầy. Tự động đợi ${s}s để giải tiếp câu ${qNum}...`);
            await sleep(1000);
          }

          if (!isRunning) break;
          continue;
        }

        updateHUD(`Lỗi câu ${qNum}`, `Lỗi: ${errText}. Đang chuyển tiếp...`);
        notifyPopup('UPDATE_STATUS', `❌ Lỗi câu ${qNum}: ${errText}. Đang chuyển tiếp...`, true);

        if (errText.includes('API key not valid') || errText.includes('API_KEY_INVALID') || errText.includes('HTTP 403')) {
          alert('EduX AI Solver: ' + errText);
          isRunning = false;
          notifyPopup('SOLVE_FINISHED', '❌ ' + errText, true);
          break;
        }

        await sleep(1000);
        await advanceToNextQuestion(currentStep + 1);
        if (qData && qData.questionNumber) {
      currentStep = qData.questionNumber + 1;
    } else {
      currentStep++;
    }
        continue;
      }

      if (!isRunning) break;

      // Giả lập thời gian suy nghĩ: delay 1.5s - 2.5s
      const delayMs = getRandomDelay(1500, 2500);
      const delaySec = (delayMs / 1000).toFixed(1);

      updateHUD(
        `Câu ${qNum}/${totalQuestions}: Đã phân tích ${count} ý`,
        `Chờ ${delaySec}s để giả lập người dùng...`,
        progressPercent
      );
      await sleep(delayMs);

      if (!isRunning) break;

      // Lần lượt click từng mệnh đề và highlight
      for (let i = 0; i < qData.trueFalseRows.length; i++) {
        if (!isRunning) break;
        const row = qData.trueFalseRows[i];
        const decision = tfDecisions[row.index] || tfDecisions[i + 1] || 'Đúng';
        const targetBtn = decision === 'Đúng' ? row.dungBtn : row.saiBtn;

        updateHUD(
          `Câu ${qNum}/${totalQuestions}: Mệnh đề ${i + 1} ➔ [${decision}]`,
          `Đang chọn [${decision}] cho ý ${i + 1}...`,
          progressPercent
        );
        notifyPopup('UPDATE_STATUS', `Câu ${qNum}: Ý ${i + 1} ➔ [${decision}]`);

        clickTrueFalseButton(targetBtn);

        // Giả lập thời gian đọc giữa các ý (400ms - 800ms)
        if (i < qData.trueFalseRows.length - 1) {
          await sleep(getRandomDelay(400, 800));
        }
      }

    } else {
      // === DẠNG 3: TRẮC NGHIỆM CHỌN A, B, C, D ===
      updateHUD(`Câu ${qNum}/${totalQuestions}`, `Đang gửi tới Gemini AI...`, progressPercent);
      notifyPopup('UPDATE_STATUS', `Câu ${qNum}/${totalQuestions}: Đang hỏi Gemini API...`);

      let targetLetter = null;
      try {
        targetLetter = await callGeminiAPI(apiKey, qData.questionText, qData.options);
      } catch (err) {
        const errText = err.message || 'Lỗi gọi API.';

        // Tự động xử lý khi gặp giới hạn Quota / Rate Limit (Google Free Tier 5-15 lượt/phút)
        if (errText.includes('quota') || errText.includes('Quota') || errText.includes('429') || errText.includes('rate-limit') || errText.includes('retry in')) {
          const retryMatch = errText.match(/retry in ([\d\.]+)\s*s/i);
          let waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 25;

          console.log(`[EduX AI Solver] Đang chờ Google nhả hạn mức Quota: ${waitSec} giây...`);
          for (let s = waitSec; s > 0; s--) {
            if (!isRunning) break;
            updateHUD(
              `⏳ Quota đầy: chờ ${s}s`,
              `Google Free giới hạn lượt gọi. Tự động tiếp tục sau ${s}s...`,
              progressPercent
            );
            notifyPopup('UPDATE_STATUS', `⏳ Quota đầy. Tự động đợi ${s}s để giải tiếp câu ${qNum}...`);
            await sleep(1000);
          }

          if (!isRunning) break;
          // Thử lại ngay câu hiện tại (không tăng currentStep)
          continue;
        }

        updateHUD(`Lỗi câu ${qNum}`, `Lỗi: ${errText}. Đang chuyển tiếp...`);
        notifyPopup('UPDATE_STATUS', `❌ Lỗi câu ${qNum}: ${errText}. Đang chuyển tiếp...`, true);

        if (errText.includes('API key not valid') || errText.includes('API_KEY_INVALID') || errText.includes('HTTP 403')) {
          alert('EduX AI Solver: ' + errText);
          isRunning = false;
          notifyPopup('SOLVE_FINISHED', '❌ ' + errText, true);
          break;
        }

        // Tự động chuyển câu để không bị đứng im
        await sleep(1000);
        await advanceToNextQuestion(currentStep + 1);
        if (qData && qData.questionNumber) {
      currentStep = qData.questionNumber + 1;
    } else {
      currentStep++;
    }
        continue;
      }

      if (!isRunning) break;

      // 3. Tìm lựa chọn khớp với đáp án Gemini trả về
      let chosenOption = qData.options.find(
        (opt) => opt.label.toUpperCase() === targetLetter.toUpperCase()
      );

      // Fallback: nếu không khớp theo nhãn, lấy theo thứ tự (A->0, B->1, C->2, D->3)
      if (!chosenOption) {
        const idx = targetLetter.charCodeAt(0) - 65;
        if (idx >= 0 && idx < qData.options.length) {
          chosenOption = qData.options[idx];
        }
      }

      if (chosenOption) {
        // Giả lập thời gian đọc đề (hoặc lướt nhanh nếu bật Siêu tốc)
        const delayMs = getSpeedDelay(CONFIG.minDelay, CONFIG.maxDelay, 200, 450);
        const delaySec = (delayMs / 1000).toFixed(1);

        updateHUD(
          `Câu ${qNum}/${totalQuestions}: Chọn [${targetLetter}]`,
          `Chờ ${delaySec}s để giả lập người dùng...`,
          progressPercent
        );
        notifyPopup('UPDATE_STATUS', `Câu ${qNum}/${totalQuestions}: Đáp án [${targetLetter}] (Chờ ${delaySec}s...)`);

        await sleep(delayMs);

        if (!isRunning) break;

        // Click chọn và viền xanh lá
        selectAndHighlightOption(chosenOption);
      } else {
        console.warn(`Không tìm thấy lựa chọn ${targetLetter} cho câu ${qNum}`);
      }
    }

    // 4. Bấm nút "Câu tiếp >" để chuyển sang câu tiếp theo
    if (currentStep < totalQuestions) {
      await sleep(fastMode ? 250 : 800);

      updateHUD(`Câu ${qNum} xong`, 'Đang chuyển sang câu tiếp theo...', progressPercent);
      await advanceToNextQuestion(currentStep + 1);

      // Chờ trang câu mới hiển thị (poll nhanh)
      await waitForCondition(() => {
        const checkQ = extractCurrentSingleQuestion();
        return checkQ && checkQ.questionText && checkQ.questionText !== qData.questionText;
      }, 1800, 150);
    }

    if (qData && qData.questionNumber) {
      currentStep = qData.questionNumber + 1;
    } else {
      currentStep++;
    }
  }

  // Kết thúc
  if (isRunning) {
    updateHUD('Hoàn thành! 🎉', `Đã hoàn thành toàn bộ bài tập EduX`, 100);
    notifyPopup('SOLVE_FINISHED', `🎉 Đã tự động giải xong bài tập!`);
    isRunning = false;
    setTimeout(removeHUD, 6000);
  }
}

/**
 * Xử lý giải bài dạng danh sách (áp dụng nếu toàn bộ đề nằm trên 1 trang dài)
 */
async function runMultiQuestionsMode(apiKey, questions) {
  const total = questions.length;
  updateHUD('Chế độ danh sách', `Tìm thấy ${total} câu hỏi`, 10);

  for (let i = 0; i < total; i++) {
    if (!isRunning) break;

    const q = questions[i];
    const currentNum = i + 1;
    const progressPercent = Math.round((currentNum / total) * 100);

    q.element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    updateHUD(`Câu ${currentNum}/${total}`, `Đang gửi tới Gemini...`, progressPercent);
    notifyPopup('UPDATE_STATUS', `Câu ${currentNum}/${total}: Đang hỏi Gemini API...`);

    let targetLetter = null;
    try {
      targetLetter = await callGeminiAPI(apiKey, q.questionText, q.options);
    } catch (err) {
      const errText = err.message || 'Lỗi gọi API.';
      updateHUD(`Lỗi câu ${currentNum}`, errText);
      await sleep(2000);
      continue;
    }

    if (!isRunning) break;

    const chosenOption = q.options.find(
      (opt) => opt.label.toUpperCase() === targetLetter.toUpperCase()
    );

    if (chosenOption) {
      const delayMs = getSpeedDelay(CONFIG.minDelay, CONFIG.maxDelay, 200, 450);
      const delaySec = (delayMs / 1000).toFixed(1);

      updateHUD(
        `Câu ${currentNum}/${total}: Chọn [${targetLetter}]`,
        `Chờ ${delaySec}s để giả lập người dùng...`,
        progressPercent
      );

      await sleep(delayMs);

      if (!isRunning) break;

      selectAndHighlightOption(chosenOption);
    }
  }

  if (isRunning) {
    updateHUD('Hoàn thành! 🎉', `Đã tự động giải xong ${total} câu hỏi`, 100);
    notifyPopup('SOLVE_FINISHED', `🎉 Đã hoàn thành tất cả ${total} câu hỏi!`);
    isRunning = false;
    setTimeout(removeHUD, 6000);
  }
}

function stopAutoSolve(reason = 'Đã dừng tiến trình.') {
  isRunning = false;
  updateHUD('Đã dừng ⏹', reason);
  notifyPopup('SOLVE_FINISHED', reason);
}

// =============================================================================
// 8B. CHẾ ĐỘ BÀI GIẢNG AI (SLIDE LECTURE + KIỂM TRA + ĐỔI CÂU HỎI + CÂU TIẾP)
// =============================================================================

function normalizeText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function isElementVisible(el) {
  if (!el) return false;
  if (el.closest('#edux-solver-hud')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isButtonEnabled(el) {
  if (!el || !isElementVisible(el)) return false;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const style = window.getComputedStyle(el);
  if (style.pointerEvents === 'none' || style.cursor === 'not-allowed') return false;
  // Kiểm tra chính xác class token (tránh khớp nhầm "disabled:cursor-not-allowed" của Tailwind)
  const tokens = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
  if (tokens.includes('cursor-not-allowed') || tokens.includes('pointer-events-none')) return false;
  return true;
}

function isQuotaErrorText(errText) {
  const t = (errText || '').toLowerCase();
  return t.includes('quota') || t.includes('429') || t.includes('rate-limit') || t.includes('retry in');
}

function isFatalApiKeyError(errText) {
  return (
    errText.includes('API key not valid') ||
    errText.includes('API_KEY_INVALID') ||
    errText.includes('HTTP 403')
  );
}

async function waitForQuotaReset(errText, contextLabel) {
  const retryMatch = (errText || '').match(/retry in ([\d\.]+)\s*s/i);
  const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 25;

  for (let s = waitSec; s > 0; s--) {
    if (!isRunning) return false;
    notifyPopup('UPDATE_STATUS', `⏳ Quota đầy (${contextLabel}). Tự động đợi ${s}s...`);
    await sleep(1000);
  }
  return isRunning;
}

/**
 * Tìm nút hiển thị trên trang khớp theo danh sách pattern
 * Ưu tiên:
 * 1. Khớp chính xác (exact match) trên button / [role="button"] / a
 * 2. Khớp chính xác (exact match) trên thẻ div / span sâu nhất (innermost), rồi nâng lên button cha nếu có
 * 3. Khớp một phần (partial match) trên button / [role="button"] / a
 * 4. Khớp một phần (partial match) trên thẻ div / span sâu nhất
 */
function findVisibleButtonByText(patterns, { requireEnabled = true, root = document.body } = {}) {
  const normalizedPatterns = patterns.map((p) => (p instanceof RegExp ? p : p.toLowerCase()));
  const checkEl = (el) => (requireEnabled ? isButtonEnabled(el) : isElementVisible(el));

  const promoteToButton = (el) => {
    if (!el) return null;
    const btn = el.closest('button, [role="button"], a');
    if (btn && checkEl(btn) && normalizeText(btn.innerText || btn.textContent).length <= 60) {
      return btn;
    }
    return el;
  };

  const primaryPool = Array.from(root.querySelectorAll('button, [role="button"], a')).filter(checkEl);
  // Chỉ xét div/span có cursor: pointer (tránh khớp nhầm đoạn văn bản câu hỏi / đáp án)
  const rawFallback = Array.from(root.querySelectorAll('div, span')).filter(
    (el) => el.children.length <= 3 && checkEl(el) && window.getComputedStyle(el).cursor === 'pointer'
  );
  const fallbackPool = rawFallback.reverse();

  // Bước 1: Tìm khớp chính xác (Exact Match) trên primaryPool rồi fallbackPool
  for (const pat of normalizedPatterns) {
    if (pat instanceof RegExp) continue;
    const exactPrimary = primaryPool.find(
      (el) => normalizeText(el.innerText || el.textContent).toLowerCase() === pat
    );
    if (exactPrimary) return exactPrimary;

    const exactFallback = fallbackPool.find(
      (el) => normalizeText(el.innerText || el.textContent).toLowerCase() === pat
    );
    if (exactFallback) return promoteToButton(exactFallback);
  }

  // Bước 2: Tìm khớp một phần (Partial / RegExp) CHỈ trên button / [role="button"] / a thật
  for (const pat of normalizedPatterns) {
    const matchFn = (el) => {
      const text = normalizeText(el.innerText || el.textContent).toLowerCase();
      if (!text || text.length > 60) return false;
      return pat instanceof RegExp ? pat.test(text) : text.includes(pat);
    };

    const partialPrimary = primaryPool.find(matchFn);
    if (partialPrimary) return partialPrimary;
  }

  return null;
}

/**
 * Đọc số trang hiện tại / tổng số trang trên màn hình slide bài giảng (vd: "1 / 51")
 */
function getLectureSlideInfo() {
  const candidates = Array.from(document.body.querySelectorAll('span, div, p'));
  for (const el of candidates) {
    if (!isElementVisible(el) || el.children.length > 2) continue;
    const text = normalizeText(el.innerText || el.textContent);
    if (text.length > 20 || /câu/i.test(text)) continue;

    const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (match) {
      const currentSlide = parseInt(match[1], 10);
      const totalSlides = parseInt(match[2], 10);
      if (totalSlides > 0 && totalSlides <= 500 && currentSlide >= 1 && currentSlide <= totalSlides) {
        return { currentSlide, totalSlides };
      }
    }
  }

  // Fallback quanh nút "Trang sau" / "Trang trước"
  const navAnchor = findVisibleButtonByText(['trang sau', 'trang trước'], { requireEnabled: false });
  if (navAnchor && navAnchor.parentElement) {
    const barText = normalizeText(navAnchor.parentElement.innerText);
    const match = barText.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) {
      const currentSlide = parseInt(match[1], 10);
      const totalSlides = parseInt(match[2], 10);
      if (totalSlides > 0 && currentSlide >= 1 && currentSlide <= totalSlides) {
        return { currentSlide, totalSlides };
      }
    }
  }

  return null;
}

/**
 * Đọc tiến độ ở màn hình câu hỏi bài giảng (vd: "Tiến độ: 0/2 câu đúng")
 */
function getLectureProgress() {
  const text = document.body.innerText || '';
  const match = text.match(/Tiến độ\s*:\s*(\d+)\s*\/\s*(\d+)/i);
  if (match) {
    return {
      done: parseInt(match[1], 10),
      total: parseInt(match[2], 10)
    };
  }
  return null;
}

/**
 * Nhận diện đang ở màn hình Slide ('slide') hay màn hình Câu hỏi bài giảng ('question')
 */
function detectLectureScreen() {
  const bodyText = document.body.innerText || '';

  // 1. Kiểm tra các dấu hiệu ĐẶC TRƯNG chỉ xuất hiện trên màn hình câu hỏi bài giảng
  // (Ưu tiên cao nhất vì DOM màn hình slide vẫn có thể nằm ẩn ở lớp nền phía dưới)
  const hasQuestionTitle = Array.from(document.body.querySelectorAll('span, p, div, h1, h2, h3, h4')).some(
    (el) =>
      isElementVisible(el) &&
      el.children.length <= 2 &&
      /^câu hỏi trắc nghiệm$/i.test(normalizeText(el.innerText || el.textContent))
  );

  const hasProgressText = /Tiến độ\s*:\s*\d+\s*\/\s*\d+\s*câu đúng/i.test(bodyText) &&
    Array.from(document.body.querySelectorAll('span, p, div')).some(
      (el) =>
        isElementVisible(el) &&
        el.children.length <= 3 &&
        /Tiến độ\s*:\s*\d+\s*\/\s*\d+\s*câu đúng/i.test(normalizeText(el.innerText || el.textContent))
    );

  const hasQuestionButtons = Boolean(
    findVisibleButtonByText(['kiểm tra', 'đổi câu hỏi', 'câu tiếp', 'câu tiếp theo'], {
      requireEnabled: false
    })
  );

  if (hasQuestionTitle || hasProgressText || hasQuestionButtons || extractLectureOptions().length >= 2) {
    return 'question';
  }

  // 2. Kiểm tra dấu hiệu màn hình Slide
  const hasSlideNav = Boolean(
    findVisibleButtonByText(['trang trước', 'trang sau', 'chưa hiểu', 'không có câu hỏi', 'trả lời trên lớp'], {
      requireEnabled: false
    })
  );
  const slideInfo = getLectureSlideInfo();

  if (hasSlideNav || slideInfo) {
    return 'slide';
  }
  return 'unknown';
}

/**
 * Tìm và phân loại nút câu hỏi ở thanh dưới màn hình slide bài giảng
 * Trả về: { status: 'available' | 'done' | 'none', button, label }
 */
function findSlideQuestionButton() {
  const nextBtn = findVisibleButtonByText(['trang sau'], { requireEnabled: false });
  const notUnderstandBtn = findVisibleButtonByText(['chưa hiểu', 'đã hiểu'], { requireEnabled: false });

  const allClickables = Array.from(
    document.body.querySelectorAll('button, [role="button"], a, div, span')
  ).filter((el) => {
    if (!isElementVisible(el)) return false;
    const tag = el.tagName;
    if ((tag === 'DIV' || tag === 'SPAN') && el.children.length > 4) return false;
    const text = normalizeText(el.innerText || el.textContent);
    return text.length > 0 && text.length <= 55;
  });

  const isExcludedLabel = (t) =>
    t.includes('trang trước') ||
    t.includes('trang sau') ||
    t.includes('chưa hiểu') ||
    t.includes('đã hiểu') ||
    t.includes('chat với ai') ||
    t.includes('tiến độ') ||
    t.includes('nội dung bài học') ||
    /^\d+\s*\/\s*\d+$/.test(t) ||
    /^\d+$/.test(t);

  const promoteClickable = (el) => {
    if (!el) return null;
    const realBtn = el.closest('button, [role="button"], a');
    if (realBtn && isElementVisible(realBtn) && normalizeText(realBtn.innerText || realBtn.textContent).length <= 55) {
      return realBtn;
    }
    return el;
  };

  // 1. Tìm trực tiếp theo từ khóa nút câu hỏi trên thanh dưới (ưu tiên "Trả lời trên lớp", "Làm câu hỏi", ...)
  let candidate = null;
  const keywordMatchers = [
    'trả lời trên lớp',
    'trả lời câu hỏi',
    'làm câu hỏi',
    'không có câu hỏi',
    'câu hỏi',
    'trả lời',
    'làm bài',
    'bài tập',
    'luyện tập'
  ];

  // Lấy tọa độ đáy màn hình (gần Trang sau / Chưa hiểu) để không khớp nhầm chữ trong slide
  const anchorY = nextBtn
    ? nextBtn.getBoundingClientRect().top
    : notUnderstandBtn
    ? notUnderstandBtn.getBoundingClientRect().top
    : window.innerHeight * 0.75;

  for (const kw of keywordMatchers) {
    const matched = allClickables.filter((el) => {
      const t = normalizeText(el.innerText || el.textContent).toLowerCase();
      if (isExcludedLabel(t)) return false;
      if (!t.includes(kw)) return false;
      const r = el.getBoundingClientRect();
      return Math.abs(r.top - anchorY) < 80 || r.top > window.innerHeight * 0.6;
    });

    if (matched.length > 0) {
      const real = matched.find(
        (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A'
      );
      candidate = promoteClickable(real || matched[0]);
      break;
    }
  }

  // 2. Fallback theo vị trí giữa "Trang sau" và "Chưa hiểu" trên cùng thanh đáy
  if (!candidate && nextBtn && notUnderstandBtn) {
    const nextRect = nextBtn.getBoundingClientRect();
    const nuRect = notUnderstandBtn.getBoundingClientRect();
    const midY = (nextRect.top + nuRect.top) / 2;

    const between = allClickables.filter((el) => {
      if (el === nextBtn || el === notUnderstandBtn || nextBtn.contains(el) || notUnderstandBtn.contains(el)) {
        return false;
      }
      const t = normalizeText(el.innerText || el.textContent).toLowerCase();
      if (isExcludedLabel(t)) return false;
      const r = el.getBoundingClientRect();
      return (
        Math.abs(r.top - midY) < 45 &&
        r.left >= nextRect.right - 15 &&
        r.right <= nuRect.left + 15
      );
    });

    const real = between.find(
      (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A'
    );
    candidate = promoteClickable(real || between[0] || null);
  }

  if (!candidate) {
    console.log('[EduX Lecture] Không tìm thấy nút câu hỏi trên thanh dưới.');
    return { status: 'none', button: null, label: '' };
  }

  const label = normalizeText(candidate.innerText || candidate.textContent);
  const text = label.toLowerCase();
  console.log('[EduX Lecture] Nút câu hỏi phát hiện:', label, candidate.tagName, candidate.className);

  if (text.includes('không có câu hỏi')) {
    return { status: 'none', button: candidate, label };
  }

  if (
    text.includes('đã hoàn thành') ||
    text.includes('đã trả lời') ||
    text.includes('đã làm') ||
    text.includes('hoàn thành') ||
    text.includes('đã xong')
  ) {
    return { status: 'done', button: candidate, label };
  }

  if (!isButtonEnabled(candidate)) {
    console.log('[EduX Lecture] Nút câu hỏi bị disable:', label);
    return { status: 'none', button: candidate, label };
  }

  return { status: 'available', button: candidate, label };
}

function findSlideNextButton() {
  return findVisibleButtonByText(['trang sau'], { requireEnabled: true });
}

function findSidebarSlideButton(slideNum) {
  const targetText = String(slideNum);
  const candidates = Array.from(document.body.querySelectorAll('button, [role="button"], div, span'));
  const sidebarLimitX = window.innerWidth * 0.25;

  return candidates.find((el) => {
    if (!isButtonEnabled(el) || el.children.length > 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.left > sidebarLimitX || rect.width > 80 || rect.height > 80) return false;
    return normalizeText(el.innerText || el.textContent) === targetText;
  });
}

/**
 * Tìm nút quay lại/sang phần bài giảng sau khi hoàn tất các câu hỏi
 */
function findLectureBackToSlideButton() {
  const progress = getLectureProgress();
  // Nếu tiến độ chưa hoàn thành (vd: 0/2 hoặc 1/2 câu đúng), tuyệt đối chưa thoát về slide
  if (progress && progress.total > 0 && progress.done < progress.total) {
    return null;
  }

  const directBtn = findVisibleButtonByText(
    [
      'sang phần bài giảng',
      'sang bài giảng',
      'tiếp tục bài giảng',
      'quay lại bài giảng',
      'về bài giảng',
      'trở về bài giảng',
      'xem bài giảng',
      'tiếp tục học'
    ],
    { requireEnabled: true }
  );
  if (directBtn) return directBtn;

  // Nếu tiến độ đã đạt đủ (vd 2/2, 3/3) và không còn nút Kiểm tra hay Câu tiếp
  const hasCheckOrNext = Boolean(
    findVisibleButtonByText(['kiểm tra', 'câu tiếp', 'câu tiếp theo', 'tiếp theo', 'tiếp tục'], {
      requireEnabled: true
    })
  );
  if (progress && progress.total > 0 && progress.done >= progress.total && !hasCheckOrNext) {
    return (
      findVisibleButtonByText(['hoàn thành', 'quay lại'], { requireEnabled: true }) ||
      findLectureHeaderBackButton()
    );
  }

  return null;
}

function findLectureHeaderBackButton() {
  const buttons = Array.from(document.body.querySelectorAll('button, [role="button"]'));
  return buttons.find((el) => {
    if (!isButtonEnabled(el)) return false;
    const r = el.getBoundingClientRect();
    const txt = normalizeText(el.innerText || el.textContent);
    return r.top < 140 && r.left < 160 && r.width <= 64 && r.height <= 64 && (txt === '<' || txt === '‹' || txt === '');
  });
}

/**
 * Bóc tách 4 phương án A, B, C, D ở màn hình câu hỏi Bài giảng AI
 * Hỗ trợ cả trường hợp React/Flexbox ghép "A." và nội dung không có dấu cách ("A.Chỉ có thể...")
 */
function extractLectureOptions() {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const options = [];

  // Đếm xem trong một container có bao nhiêu nhãn đáp án (A., B., C., D.) đứng ở đầu dòng
  const countOptionPrefixes = (text) => {
    const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const seen = new Set();
    for (const line of lines) {
      const m = line.match(/^([A-F])[\.\:\)](?:\s+|$)/i);
      if (m) seen.add(m[1].toUpperCase());
    }
    return seen.size;
  };

  const allNodes = Array.from(
    document.body.querySelectorAll('div, label, button, [role="radio"]')
  ).filter((el) => isElementVisible(el));

  // Chiến lược 1: Tìm theo thẻ chữ "A.", "B.", "C.", "D." rồi leo lên thẻ card bao ngoài của riêng đáp án đó
  const allLeafBadges = Array.from(
    document.body.querySelectorAll('span, div, p, strong, b')
  ).filter((el) => isElementVisible(el) && el.children.length === 0);

  const badgeByLetter = new Map();
  for (const letter of letters) {
    const badgeRegex = new RegExp(`^${letter}[\\.\\:\\)]$`, 'i');
    const found = allLeafBadges.find((el) => badgeRegex.test(normalizeText(el.innerText || el.textContent)));
    if (found) badgeByLetter.set(letter, found);
  }

  for (const letter of letters) {
    const badgeEl = badgeByLetter.get(letter);

    if (badgeEl) {
      let card = badgeEl.parentElement;
      let bestCard = card;

      while (card && card !== document.body) {
        const cardText = normalizeText(card.innerText || card.textContent);
        if (!cardText || cardText.length > 600) break;

        // Kiểm tra card này có chứa thẻ nhãn (badge) của đáp án KHÁC không
        let hasOtherBadge = false;
        for (const [otherLetter, otherBadgeEl] of badgeByLetter.entries()) {
          if (otherLetter !== letter && card.contains(otherBadgeEl)) {
            hasOtherBadge = true;
            break;
          }
        }

        if (hasOtherBadge) break;
        bestCard = card;

        // Nếu đã leo tới thẻ card có border + rounded (hoặc button/label/radio) thì dừng ngay tại card đó
        const cls = typeof card.className === 'string' ? card.className : '';
        if (
          card.tagName === 'BUTTON' ||
          card.tagName === 'LABEL' ||
          card.getAttribute('role') === 'radio' ||
          (cls.includes('border') && cls.includes('rounded'))
        ) {
          bestCard = card;
          break;
        }
        card = card.parentElement;
      }

      if (bestCard) {
        const rawText = normalizeText(bestCard.innerText || bestCard.textContent);
        const stripRe = new RegExp(`^${letter}[\\.\\:\\)]\\s*`, 'i');
        const cleanText = rawText.replace(stripRe, '').trim();
        if (cleanText.length > 0 && !options.some((o) => o.label === letter)) {
          options.push({
            label: letter,
            text: cleanText,
            element: bestCard
          });
          continue;
        }
      }
    }

    // Chiến lược 2 (Fallback): Quét container bắt đầu bằng "A." (cho phép có hoặc không có khoảng trắng sau dấu chấm)
    const regex = new RegExp(`^${letter}[\\.\\:\\)]\\s*(\\S[\\s\\S]*)`, 'i');
    const matches = allNodes.filter((el) => {
      const txt = normalizeText(el.innerText || el.textContent);
      if (!txt || txt.length < 3 || txt.length > 600) return false;
      if (!regex.test(txt)) return false;
      return countOptionPrefixes(el.innerText) <= 1;
    });

    if (matches.length > 0) {
      matches.sort((a, b) => a.innerText.length - b.innerText.length);
      const innerMost = matches[0];
      const cardEl =
        innerMost.closest('button, [role="radio"], label, div[class*="cursor-pointer"], div[class*="rounded"]') ||
        innerMost;

      const finalEl = countOptionPrefixes(cardEl.innerText) <= 1 ? cardEl : innerMost;
      const rawText = normalizeText(finalEl.innerText || finalEl.textContent);
      const textMatch = rawText.match(regex);
      const cleanText = textMatch ? normalizeText(textMatch[1]) : rawText;

      if (cleanText && !options.some((o) => o.label === letter)) {
        options.push({
          label: letter,
          text: cleanText,
          element: finalEl
        });
      }
    }
  }

  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

/**
 * Bóc tách nội dung câu hỏi & phương án trên màn hình câu hỏi Bài giảng AI
 */
function extractLectureQuestion() {
  const options = extractLectureOptions();
  const progress = getLectureProgress();
  let questionText = '';

  // Chiến lược 1: Tìm khung câu hỏi viền xanh bên trái / nền xanh nhạt (như giao diện EduX)
  const styledBoxes = Array.from(
    document.body.querySelectorAll('div[class*="border-l"], div[class*="bg-blue-50"], div[class*="bg-sky-50"]')
  ).filter((el) => {
    if (!isElementVisible(el)) return false;
    const txt = normalizeText(el.innerText);
    if (txt.length < 8 || txt.length > 1500) return false;
    if (/^[A-F][\.\:\)]\s/i.test(txt) || /Tiến độ\s*:/i.test(txt) || /Câu hỏi trắc nghiệm/i.test(txt)) return false;
    if (options.some((o) => el.contains(o.element))) return false;
    return true;
  });

  if (styledBoxes.length > 0) {
    // Ưu tiên box trong cùng (innermost) chứa nội dung câu hỏi sạch nhất
    const innermost = styledBoxes.filter(
      (box) => !styledBoxes.some((other) => other !== box && box.contains(other))
    );
    const pool = innermost.length > 0 ? innermost : styledBoxes;
    pool.sort((a, b) => b.innerText.length - a.innerText.length);
    questionText = normalizeText(pool[0].innerText);
  }

  // Chiến lược 2 (Fallback theo tọa độ): lấy khối text nằm giữa "Câu hỏi trắc nghiệm" và phương án A
  if (!questionText && options.length > 0) {
    const optionsTop = Math.min(...options.map((o) => o.element.getBoundingClientRect().top));
    const subHeader = Array.from(document.body.querySelectorAll('*')).find((el) => {
      if (!isElementVisible(el) || el.children.length > 1) return false;
      return /^câu hỏi/i.test(normalizeText(el.innerText));
    });
    const headerBottom = subHeader ? subHeader.getBoundingClientRect().bottom : 80;

    const textBlocks = Array.from(document.body.querySelectorAll('p, div, h1, h2, h3, h4, span')).filter((el) => {
      if (!isElementVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.top < headerBottom - 5 || r.bottom > optionsTop + 5) return false;
      if (options.some((o) => el.contains(o.element))) return false;
      const txt = normalizeText(el.innerText);
      return txt.length >= 8 && txt.length <= 1500 && !/^câu hỏi/i.test(txt);
    });

    if (textBlocks.length > 0) {
      textBlocks.sort((a, b) => b.innerText.length - a.innerText.length);
      questionText = normalizeText(textBlocks[0].innerText);
    }
  }

  return {
    questionText,
    options,
    progress
  };
}

/**
 * Click chọn đáp án dành riêng cho chế độ Bài giảng AI
 * (Luôn click trực tiếp mà không bỏ qua do class cũ từ câu trước vì React tái sử dụng DOM)
 */
function selectLectureOption(option) {
  if (!option || !option.element) return;
  const el = option.element;

  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  clearHighlights();

  el.setAttribute('data-edux-highlighted', 'true');
  el.style.border = '2px solid #10b981';
  el.style.borderRadius = '8px';
  el.style.backgroundColor = 'rgba(16, 185, 129, 0.12)';
  el.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.3)';
  el.style.transition = 'all 0.3s ease';

  clickElementSafely(el);

  const radio = el.querySelector('input[type="radio"]');
  if (radio) {
    radio.checked = true;
    radio.dispatchEvent(new Event('input', { bubbles: true }));
    radio.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * Tìm nút "Kiểm tra" ở góc dưới bên phải màn hình câu hỏi bài giảng
 */
function findLectureCheckButton({ requireEnabled = true } = {}) {
  const checkEl = (el) => (requireEnabled ? isButtonEnabled(el) : isElementVisible(el));
  const candidates = Array.from(
    document.body.querySelectorAll('button, [role="button"], a, div, span')
  ).filter((el) => {
    if (!checkEl(el)) return false;
    if ((el.tagName === 'DIV' || el.tagName === 'SPAN') && el.children.length > 2) return false;
    const txt = normalizeText(el.innerText || el.textContent).toLowerCase();
    if (txt !== 'kiểm tra') return false;
    const r = el.getBoundingClientRect();
    return r.top > window.innerHeight * 0.45;
  });

  if (candidates.length > 0) {
    const realBtn = candidates.find(
      (el) => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A'
    );
    if (realBtn) return realBtn;
    // Lấy phần tử con sâu nhất rồi nâng lên button cha nếu có
    const deepest = candidates[candidates.length - 1];
    return deepest.closest('button, [role="button"], a') || deepest;
  }

  return findVisibleButtonByText(['kiểm tra'], { requireEnabled });
}

/**
 * Tìm nút "Câu tiếp" ở thanh dưới cùng (tránh khớp nhầm chữ "tiếp theo / tiếp tục" trong đáp án)
 */
function findLectureNextQuestionButton() {
  const patterns = ['câu tiếp theo', 'câu tiếp', 'tiếp theo', 'tiếp tục'];
  const buttons = Array.from(document.body.querySelectorAll('button, [role="button"], a')).filter((el) => {
    if (!isButtonEnabled(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.55) return false;
    const txt = normalizeText(el.innerText || el.textContent).toLowerCase();
    if (!txt || txt.length > 30) return false;
    if (/^[a-f][\.\:\)]/i.test(txt)) return false;
    return patterns.some((p) => txt === p || txt.includes(p));
  });

  if (buttons.length > 0) {
    return buttons[buttons.length - 1];
  }
  return null;
}

let lastLectureFailReason = '';

/**
 * Giải toàn bộ các câu hỏi trong màn hình câu hỏi Bài giảng AI hiện tại
 * (Chọn đáp án -> Bấm Kiểm tra -> Nếu đúng bấm Câu tiếp / Sang bài giảng; Nếu sai bấm Đổi câu hỏi)
 */
async function solveCurrentLectureQuestions(apiKey) {
  lastLectureFailReason = '';
  let wrongRetries = 0;
  const MAX_WRONG_RETRIES = 6;
  const MAX_ITERATIONS = 40;
  let lastSolvedQuestionText = '';

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (!isRunning) return 'stopped';

    await sleep(fastMode ? 120 : 400);
    clearHighlights();

    if (detectLectureScreen() === 'slide') {
      return 'slide';
    }

    // 1. Nếu có nút quay lại/sang bài giảng đang hiện sẵn (khi đã hoàn thành đủ số câu) -> bấm về bài giảng
    const backToSlideBtn = findLectureBackToSlideButton();
    if (backToSlideBtn) {
      notifyPopup('UPDATE_STATUS', '🎓 Đã xong câu hỏi, đang quay lại bài giảng...');
      clickElementSafely(backToSlideBtn);
      await waitForCondition(() => detectLectureScreen() === 'slide', 2500, 120);
      return 'slide';
    }

    // 2. Nếu nút "Câu tiếp" đã hiện sẵn ở thanh đáy -> bấm chuyển tiếp
    const existingNextBtn = findLectureNextQuestionButton();
    if (existingNextBtn) {
      notifyPopup('UPDATE_STATUS', '🎓 Đang bấm chuyển sang câu hỏi tiếp theo...');
      clickElementSafely(existingNextBtn);
      await sleep(fastMode ? 200 : 600);
      continue;
    }

    // 3. Chờ và bóc tách câu hỏi hiện tại (poll nhanh mỗi 120ms, đảm bảo câu mới khác câu cũ)
    let qData = extractLectureQuestion();
    const isReadyQuestion = (q) =>
      q &&
      q.questionText &&
      q.options.length >= 2 &&
      (!lastSolvedQuestionText || q.questionText !== lastSolvedQuestionText);

    if (!isReadyQuestion(qData)) {
      const ready = await waitForCondition(() => {
        if (detectLectureScreen() === 'slide') return { slide: true };
        const nextBtnDuringWait = findLectureNextQuestionButton();
        if (nextBtnDuringWait) {
          clickElementSafely(nextBtnDuringWait);
          return null;
        }
        const lateBackBtn = findLectureBackToSlideButton();
        if (lateBackBtn) return { backBtn: lateBackBtn };
        const candidateQ = extractLectureQuestion();
        return isReadyQuestion(candidateQ) ? { qData: candidateQ } : null;
      }, 3200, 120);

      if (!isRunning) return 'stopped';
      if (ready?.slide) return 'slide';
      if (ready?.backBtn) {
        clickElementSafely(ready.backBtn);
        await waitForCondition(() => detectLectureScreen() === 'slide', 2500, 120);
        return 'slide';
      }
      qData = ready?.qData || extractLectureQuestion();
    }

    if (!isRunning) return 'stopped';

    if (!qData.questionText || qData.options.length < 2) {
      lastLectureFailReason = `Không đọc được câu hỏi/đáp án (đề=${qData.questionText ? qData.questionText.length : 0} ký tự, đáp án=${qData.options.length}).`;
      notifyPopup('UPDATE_STATUS', `⚠️ ${lastLectureFailReason}`, true);
      return 'failed';
    }

    const progLabel = qData.progress ? `${qData.progress.done}/${qData.progress.total}` : '?';
    const cacheKey = buildLectureCacheKey(qData.questionText, qData.options);
    let cachedHit = lectureAnswerCache.get(cacheKey);
    let targetLetter = null;

    if (cachedHit) {
      targetLetter = cachedHit;
      notifyPopup('UPDATE_STATUS', `⚡ Cache khớp [${targetLetter}] (Tiến độ ${progLabel})!`);
    } else {
      notifyPopup(
        'UPDATE_STATUS',
        `🎓 Tiến độ ${progLabel}: Đang hỏi Gemini${fastMode ? ' (Siêu tốc)' : ''}...`
      );

      // 4. Gọi Gemini AI phân tích
      try {
        targetLetter = await callGeminiAPI(apiKey, qData.questionText, qData.options, { fastMode });
      } catch (err) {
        const errText = err.message || 'Lỗi gọi API.';
        if (isQuotaErrorText(errText)) {
          const ok = await waitForQuotaReset(errText, `Bài giảng ${progLabel}`);
          if (!ok) return 'stopped';
          continue;
        }
        if (isFatalApiKeyError(errText)) {
          alert('EduX AI Solver: ' + errText);
          isRunning = false;
          notifyPopup('SOLVE_FINISHED', '❌ ' + errText, true);
          return 'error';
        }
        notifyPopup('UPDATE_STATUS', `❌ Lỗi Gemini: ${errText}. Đang thử lại...`, true);
        await sleep(900);
        continue;
      }
    }

    if (!isRunning) return 'stopped';

    // Bóc tách lại options mới nhất từ DOM ngay trước khi click (phòng trường hợp React vừa re-render)
    const freshQData = extractLectureQuestion();
    const activeOptions = freshQData.options.length >= 2 ? freshQData.options : qData.options;

    // 5. Chọn đáp án
    let chosenOption = activeOptions.find(
      (opt) => opt.label.toUpperCase() === targetLetter.toUpperCase()
    );
    if (!chosenOption) {
      const idx = targetLetter.charCodeAt(0) - 65;
      if (idx >= 0 && idx < activeOptions.length) {
        chosenOption = activeOptions[idx];
      }
    }

    if (!chosenOption) {
      notifyPopup('UPDATE_STATUS', `⚠️ Không khớp đáp án [${targetLetter}], đang thử đổi câu...`);
      const changeBtn = findVisibleButtonByText(['đổi câu hỏi'], { requireEnabled: true });
      if (changeBtn) {
        clickElementSafely(changeBtn);
        await sleep(fastMode ? 350 : 800);
      }
      continue;
    }

    const delayMs = cachedHit ? 50 : getSpeedDelay(1000, 1800, 60, 160);
    if (!fastMode) {
      notifyPopup(
        'UPDATE_STATUS',
        `🎓 Tiến độ ${progLabel}: Chọn [${chosenOption.label}] (Chờ ${(delayMs / 1000).toFixed(1)}s...)`
      );
    }
    await sleep(delayMs);

    if (!isRunning) return 'stopped';

    const prevDone = qData.progress ? qData.progress.done : 0;
    const solvedQText = freshQData.questionText || qData.questionText;
    lastSolvedQuestionText = solvedQText;

    selectLectureOption(chosenOption);

    // 6. Chờ nút "Kiểm tra" mở khóa (poll nhanh mỗi 80ms thay vì ngủ cứng)
    let checkBtn = await waitForCondition(
      () => findLectureCheckButton({ requireEnabled: true }),
      1400,
      80
    );

    if (!isRunning) return 'stopped';

    if (!checkBtn) {
      notifyPopup('UPDATE_STATUS', '⚠️ Chờ nút "Kiểm tra" mở khóa, thử click lại thẻ đáp án...');
      const innerTarget = chosenOption.element.querySelector('input, button, [role="radio"], label, span, div');
      if (innerTarget) clickElementSafely(innerTarget);
      else clickElementSafely(chosenOption.element);
      checkBtn =
        (await waitForCondition(() => findLectureCheckButton({ requireEnabled: true }), 800, 80)) ||
        findLectureCheckButton({ requireEnabled: false });
    }

    if (!checkBtn) {
      lastLectureFailReason = 'Không tìm thấy hoặc không bấm được nút "Kiểm tra".';
      notifyPopup('UPDATE_STATUS', `❌ ${lastLectureFailReason}`, true);
      return 'failed';
    }

    clickElementSafely(checkBtn);
    notifyPopup('UPDATE_STATUS', `🎓 Tiến độ ${progLabel}: Đã bấm Kiểm tra [${chosenOption.label}]...`);

    // 7. Poll nhanh mỗi 120ms sau khi bấm Kiểm tra
    let outcome = 'unknown';
    let postNextBtn = null;
    let postBackBtn = null;

    for (let poll = 0; poll < 35; poll++) {
      if (!isRunning) return 'stopped';
      await sleep(120);

      if (detectLectureScreen() === 'slide') {
        outcome = 'slide';
        break;
      }

      postNextBtn = findLectureNextQuestionButton();
      if (postNextBtn) {
        outcome = 'correct_next';
        break;
      }

      postBackBtn = findLectureBackToSlideButton();
      if (postBackBtn) {
        outcome = 'done_lecture';
        break;
      }

      const newProg = getLectureProgress();
      if (newProg && newProg.done > prevDone) {
        if (newProg.done >= newProg.total) {
          outcome = 'done_lecture';
          break;
        }
        const currQ = extractLectureQuestion();
        if (currQ.questionText && currQ.questionText !== lastSolvedQuestionText) {
          outcome = 'correct_auto';
          break;
        }
      }

      const activeCheckBtn = findLectureCheckButton({ requireEnabled: true });
      const changeBtn = findVisibleButtonByText(['đổi câu hỏi'], { requireEnabled: true });

      // Nếu nút Kiểm tra vẫn sáng sau ~0.7s hoặc ~1.4s -> click lại ngay
      if ((poll === 6 || poll === 12) && activeCheckBtn) {
        selectLectureOption(chosenOption);
        await sleep(120);
        const retryCheckBtn = findLectureCheckButton({ requireEnabled: true }) || activeCheckBtn;
        clickElementSafely(retryCheckBtn);
        continue;
      }

      if (poll >= 5 && !activeCheckBtn && changeBtn) {
        outcome = 'wrong';
        break;
      }
    }

    // Lưu cache nếu ĐÚNG; xóa cache nếu SAI
    if (outcome === 'correct_next' || outcome === 'done_lecture' || outcome === 'correct_auto' || outcome === 'slide') {
      if (!cachedHit) {
        lectureAnswerCache.set(cacheKey, chosenOption.label.toUpperCase());
        persistLectureAnswerCache();
      }
    } else if (cachedHit) {
      lectureAnswerCache.delete(cacheKey);
      persistLectureAnswerCache();
    }

    if (outcome === 'slide') {
      return 'slide';
    }

    if (outcome === 'correct_next' && postNextBtn) {
      wrongRetries = 0;
      notifyPopup('UPDATE_STATUS', '✅ ĐÚNG! Sang câu tiếp...');
      await sleep(fastMode ? 100 : 450);
      clickElementSafely(postNextBtn);

      const nextAction = await waitForCondition(() => {
        if (detectLectureScreen() === 'slide') return { slide: true };
        const afterNextBackBtn = findLectureBackToSlideButton();
        if (afterNextBackBtn) return { backBtn: afterNextBackBtn };
        const nextQ = extractLectureQuestion();
        if (nextQ.questionText && nextQ.questionText !== lastSolvedQuestionText) return { nextQ: true };
        return null;
      }, 2600, 120);

      if (nextAction?.slide) return 'slide';
      if (nextAction?.backBtn) {
        notifyPopup('UPDATE_STATUS', '🎉 Đã xong câu hỏi, quay lại bài giảng...');
        await sleep(fastMode ? 120 : 350);
        clickElementSafely(nextAction.backBtn);
        await waitForCondition(() => detectLectureScreen() === 'slide', 2500, 120);
        return 'slide';
      }
      continue;
    }

    if (outcome === 'done_lecture') {
      wrongRetries = 0;
      notifyPopup('UPDATE_STATUS', '🎉 Đã trả lời đúng toàn bộ câu hỏi của trang này!');
      await sleep(fastMode ? 120 : 400);
      const backBtnNow = postBackBtn || findLectureBackToSlideButton() || findLectureHeaderBackButton();
      if (backBtnNow) {
        clickElementSafely(backBtnNow);
        await waitForCondition(() => detectLectureScreen() === 'slide', 2500, 120);
      }
      return 'slide';
    }

    if (outcome === 'correct_auto') {
      wrongRetries = 0;
      continue;
    }

    // Trường hợp trả lời sai -> Bấm "Đổi câu hỏi" và làm lại
    wrongRetries++;
    if (wrongRetries > MAX_WRONG_RETRIES) {
      notifyPopup('UPDATE_STATUS', `❌ Đã thử đổi câu hỏi ${MAX_WRONG_RETRIES} lần nhưng chưa đạt, tạm dừng.`, true);
      return 'max_retries';
    }

    const changeBtn = findVisibleButtonByText(['đổi câu hỏi'], { requireEnabled: true });
    if (changeBtn) {
      notifyPopup('UPDATE_STATUS', `⚠️ Đáp án chưa đúng, bấm "Đổi câu hỏi" (${wrongRetries}/${MAX_WRONG_RETRIES})...`);
      clickElementSafely(changeBtn);

      await waitForCondition(() => {
        const refreshed = extractLectureQuestion();
        return refreshed.questionText && refreshed.questionText !== lastSolvedQuestionText;
      }, 2800, 120);
    } else {
      notifyPopup('UPDATE_STATUS', '⚠️ Không thấy nút Câu tiếp hoặc Đổi câu hỏi, đang chờ DOM...');
      await sleep(600);
    }
  }

  return 'finished';
}

/**
 * Luồng chính chế độ Bài giảng AI:
 * - Nếu đang ở màn hình câu hỏi -> giải xong rồi tự động quay lại slide và duyệt tiếp
 * - Nếu đang ở màn hình slide -> duyệt từ trang hiện tại đến hết (Trang sau >), trang nào có câu hỏi chưa làm thì vào giải
 */
async function runLectureMode(apiKey) {
  let screen = detectLectureScreen();
  for (let w = 0; w < 5 && screen === 'unknown' && isRunning; w++) {
    await sleep(500);
    screen = detectLectureScreen();
  }

  if (!isRunning) return;

  if (screen === 'unknown') {
    notifyPopup(
      'SOLVE_FINISHED',
      '❌ Không nhận diện được trang Bài giảng AI. Hãy mở trang bài giảng EduX (/subject?id=...).',
      true
    );
    isRunning = false;
    return;
  }

  // Nếu người dùng bấm chạy ngay trong màn hình Câu hỏi bài giảng
  if (screen === 'question') {
    const res = await solveCurrentLectureQuestions(apiKey);
    if (!isRunning || res === 'error' || res === 'max_retries') {
      if (isRunning) {
        notifyPopup('SOLVE_FINISHED', '⏹ Đã dừng ở màn hình câu hỏi bài giảng.', res !== 'stopped');
        isRunning = false;
      }
      return;
    }

    // Đợi quay lại màn hình slide để tiếp tục duyệt các trang còn lại
    for (let w = 0; w < 8 && detectLectureScreen() !== 'slide' && isRunning; w++) {
      await sleep(400);
    }
    if (detectLectureScreen() !== 'slide') {
      if (isRunning) {
        notifyPopup('SOLVE_FINISHED', '🎉 Đã hoàn thành phần câu hỏi bài giảng hiện tại!');
        isRunning = false;
      }
      return;
    }
  }

  // Duyệt qua từng trang bài giảng (Screen A)
  const MAX_SLIDES = 300;
  let reachedEnd = false;
  let stopReason = 'Không thể chuyển sang trang tiếp theo.';
  let lastSlideLabel = '?';

  for (let step = 0; step < MAX_SLIDES && isRunning; step++) {
    // Chờ DOM & trạng thái nút của trang mới ổn định (nhanh hơn nhiều ở chế độ Siêu tốc)
    await sleep(fastMode ? 220 : 800);
    if (!isRunning) break;

    const slideInfo = getLectureSlideInfo();
    const slideLabel = slideInfo ? `${slideInfo.currentSlide}/${slideInfo.totalSlides}` : `${step + 1}`;
    lastSlideLabel = slideLabel;

    let qBtnState = findSlideQuestionButton();
    // Nếu chưa thấy nút câu hỏi mà "Trang sau >" đang khóa, poll nhanh chờ trang tải xong trạng thái nút
    if (qBtnState.status === 'none' && !findSlideNextButton()) {
      const lateBtn = await waitForCondition(() => {
        const st = findSlideQuestionButton();
        return st.status !== 'none' || findSlideNextButton() ? st : null;
      }, 1800, 150);
      if (lateBtn && lateBtn.status) {
        qBtnState = lateBtn;
      } else {
        qBtnState = findSlideQuestionButton();
      }
    }

    let clickedQuestionBtnName = '';
    let enteredQuestionScreen = false;
    let triedQuestionThisSlide = false;

    const tryOpenAndSolveSlideQuestion = async (btnState) => {
      const btnName = btnState.label || 'câu hỏi';
      clickedQuestionBtnName = btnName;
      triedQuestionThisSlide = true;
      notifyPopup('UPDATE_STATUS', `🎓 Trang ${slideLabel}: Đang mở "${btnName}"...`);
      clickElementSafely(btnState.button);

      // Poll nhanh chuyển sang màn hình/modal câu hỏi (bấm nhắc lại sau ~1s nếu React chưa nhận click)
      let retriedOpen = false;
      const entered = await waitForCondition(() => {
        if (detectLectureScreen() === 'question') return true;
        if (!retriedOpen) {
          retriedOpen = true;
          return null;
        }
        return null;
      }, 900, 120);

      if (!entered && isRunning && detectLectureScreen() !== 'question') {
        const retryBtn = findSlideQuestionButton();
        if (retryBtn.status === 'available' && retryBtn.button) {
          clickElementSafely(retryBtn.button);
        }
        await waitForCondition(() => detectLectureScreen() === 'question', 3000, 120);
      }

      if (!isRunning) return 'stopped';

      if (detectLectureScreen() === 'question') {
        enteredQuestionScreen = true;
        const solveRes = await solveCurrentLectureQuestions(apiKey);
        if (!isRunning) return 'stopped';
        if (solveRes === 'error' || solveRes === 'max_retries' || solveRes === 'failed') {
          const reason = lastLectureFailReason || 'Gặp lỗi hoặc vượt quá số lần đổi câu hỏi.';
          notifyPopup('SOLVE_FINISHED', `❌ Trang ${slideLabel}: ${reason}`, true);
          isRunning = false;
          return 'abort';
        }

        // Chờ giao diện quay lại slide
        await waitForCondition(() => detectLectureScreen() === 'slide', 2600, 120);
        if (detectLectureScreen() !== 'slide') {
          const backArrow = findLectureHeaderBackButton();
          if (backArrow) {
            clickElementSafely(backArrow);
            await waitForCondition(() => detectLectureScreen() === 'slide', 1500, 120);
          }
        }
        return 'solved';
      }

      notifyPopup('UPDATE_STATUS', `🎓 Trang ${slideLabel}: Đã bấm "${btnName}" nhưng chưa thấy màn hình câu hỏi...`);
      return 'not_entered';
    };

    if (qBtnState.status === 'available' && qBtnState.button) {
      const actionRes = await tryOpenAndSolveSlideQuestion(qBtnState);
      if (actionRes === 'abort' || !isRunning) return;
    } else if (qBtnState.status === 'done') {
      notifyPopup('UPDATE_STATUS', `🎓 Trang ${slideLabel}: Đã hoàn thành ("${qBtnState.label}"), sang trang sau...`);
    } else {
      const detail = qBtnState.label ? `"${qBtnState.label}"` : 'Không có câu hỏi';
      notifyPopup('UPDATE_STATUS', `🎓 Trang ${slideLabel}: ${detail}, sang trang sau...`);
    }

    if (!isRunning) break;

    // Kiểm tra đã ở trang cuối chưa
    const latestSlideInfo = getLectureSlideInfo() || slideInfo;
    if (latestSlideInfo) {
      lastSlideLabel = `${latestSlideInfo.currentSlide}/${latestSlideInfo.totalSlides}`;
      if (latestSlideInfo.currentSlide >= latestSlideInfo.totalSlides) {
        reachedEnd = true;
        break;
      }
    }

    await sleep(getSpeedDelay(500, 900, 60, 140));
    if (!isRunning) break;

    const currentNum = latestSlideInfo ? latestSlideInfo.currentSlide : null;

    // Poll nhanh cho nút "Trang sau >" hoặc số trang kế tiếp mở khóa
    let nextSlideBtn = findSlideNextButton();
    let sidebarNext = currentNum ? findSidebarSlideButton(currentNum + 1) : null;
    if (!nextSlideBtn && !sidebarNext) {
      await waitForCondition(() => {
        nextSlideBtn = findSlideNextButton();
        if (currentNum) sidebarNext = findSidebarSlideButton(currentNum + 1);
        return Boolean(nextSlideBtn || sidebarNext);
      }, 4500, 180);
    }

    // Nếu "Trang sau >" vẫn khóa và phát hiện nút câu hỏi khả dụng chưa thử -> bấm vào giải ngay!
    if (!nextSlideBtn && !sidebarNext && !triedQuestionThisSlide && isRunning) {
      const lateQBtn = findSlideQuestionButton();
      if (lateQBtn.status === 'available' && lateQBtn.button) {
        const lateRes = await tryOpenAndSolveSlideQuestion(lateQBtn);
        if (lateRes === 'abort' || !isRunning) return;
        await waitForCondition(() => {
          nextSlideBtn = findSlideNextButton();
          if (currentNum) sidebarNext = findSidebarSlideButton(currentNum + 1);
          return Boolean(nextSlideBtn || sidebarNext);
        }, 3200, 150);
      }
    }

    if (!isRunning) break;

    if (nextSlideBtn) {
      clickElementSafely(nextSlideBtn);
    } else if (sidebarNext) {
      clickElementSafely(sidebarNext);
    } else {
      const btnInfo = findSlideQuestionButton();
      if (clickedQuestionBtnName && !enteredQuestionScreen) {
        stopReason = `Đã bấm "${clickedQuestionBtnName}" nhưng không mở được màn hình câu hỏi.`;
      } else {
        stopReason =
          btnInfo.status === 'available'
            ? `Nút "Trang sau >" đang khóa, cần hoàn thành "${btnInfo.label || 'câu hỏi'}" trên trang này trước.`
            : 'Nút "Trang sau >" đang bị khóa (disabled).';
      }
      break;
    }

    // Poll nhanh mỗi 120ms đợi số trang thay đổi sau khi bấm Trang sau
    let advanced = false;
    if (!currentNum) {
      await sleep(250);
      advanced = true;
    } else {
      advanced = Boolean(
        await waitForCondition(() => {
          const afterInfo = getLectureSlideInfo();
          return afterInfo && afterInfo.currentSlide !== currentNum;
        }, 3000, 120)
      );
    }

    // Fallback bấm thẳng vào số trang tiếp theo trên thanh bên trái nếu Trang sau chưa chuyển
    if (!advanced && currentNum && isRunning) {
      const fallbackSidebarNext = findSidebarSlideButton(currentNum + 1);
      if (fallbackSidebarNext) {
        clickElementSafely(fallbackSidebarNext);
        advanced = Boolean(
          await waitForCondition(() => {
            const afterSidebar = getLectureSlideInfo();
            return afterSidebar && afterSidebar.currentSlide !== currentNum;
          }, 1800, 120)
        );
      }
    }

    if (!advanced) {
      if (clickedQuestionBtnName && !enteredQuestionScreen) {
        stopReason = `Đã bấm "${clickedQuestionBtnName}" nhưng không vào được màn hình câu hỏi, và "Trang sau >" chưa mở khóa.`;
      } else if (qBtnState.status !== 'available') {
        stopReason = `Không phát hiện nút câu hỏi khả dụng (trạng thái: ${qBtnState.status}${qBtnState.label ? ` - "${qBtnState.label}"` : ''}) và "Trang sau >" không chuyển trang được.`;
      } else {
        stopReason = 'Đã bấm chuyển trang nhưng số trang không tăng.';
      }
      break;
    }
  }

  if (isRunning) {
    if (reachedEnd) {
      notifyPopup('SOLVE_FINISHED', `🎉 Đã duyệt và hoàn thành toàn bộ Bài giảng AI (${lastSlideLabel})!`);
    } else {
      notifyPopup('SOLVE_FINISHED', `⚠️ Dừng ở trang ${lastSlideLabel}: ${stopReason}`, true);
    }
    isRunning = false;
    setTimeout(removeHUD, 6000);
  }
}

// =============================================================================
// 9. LẮNG NGHE LỆNH TỪ POPUP / BACKGROUND
// =============================================================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse({ status: 'pong' });
    return true;
  }

  if (request.action === 'GET_SOLVER_STATE') {
    sendResponse({
      isRunning,
      mode: currentMode,
      fastMode,
      statusText: lastStatusText || (hudElement ? document.getElementById('hud-status')?.textContent : '')
    });
    return true;
  }

  if (request.action === 'START_AUTO_SOLVE') {
    startAutoSolve(request.apiKey, request.mode || 'quiz', Boolean(request.fastMode));
    sendResponse({ status: 'started', mode: request.mode || 'quiz', fastMode: Boolean(request.fastMode) });
    return true;
  }

  if (request.action === 'STOP_AUTO_SOLVE') {
    stopAutoSolve('Người dùng đã yêu cầu dừng từ Popup.');
    sendResponse({ status: 'stopped' });
    return true;
  }
});
