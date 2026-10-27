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
let hudElement = null;

// =============================================================================
// 3. TIỆN ÍCH HỖ TRỢ (HELPERS)
// =============================================================================

function getRandomDelay(min = CONFIG.minDelay, max = CONFIG.maxDelay) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyPopup(action, text, isError = false) {
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

function createHUD() {
  if (hudElement) return;

  hudElement = document.createElement('div');
  hudElement.id = 'edux-solver-hud';
  hudElement.innerHTML = `
    <div class="hud-container">
      <div class="hud-header">
        <div class="hud-title">⚡ EduX AI Solver</div>
        <button id="hud-close-btn" class="hud-btn-close" title="Dừng và đóng">✕</button>
      </div>
      <div id="hud-status" class="hud-status">Đang khởi tạo...</div>
      <div class="hud-progress-bar">
        <div id="hud-progress-fill" class="hud-progress-fill" style="width: 0%"></div>
      </div>
      <div id="hud-detail" class="hud-detail">Sẵn sàng phân tích câu hỏi</div>
    </div>
  `;

  const style = document.createElement('style');
  style.id = 'edux-solver-hud-style';
  style.textContent = `
    #edux-solver-hud {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      border-radius: 12px;
      overflow: hidden;
      width: 300px;
      background: #0f172a;
      border: 1px solid #334155;
      color: #f8fafc;
      font-size: 13px;
      transition: all 0.3s ease;
      user-select: none;
    }
    #edux-solver-hud .hud-container {
      padding: 14px;
    }
    #edux-solver-hud .hud-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    #edux-solver-hud .hud-title {
      font-weight: 700;
      font-size: 14px;
      color: #60a5fa;
    }
    #edux-solver-hud .hud-btn-close {
      background: transparent;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    #edux-solver-hud .hud-btn-close:hover {
      background: #1e293b;
      color: #ef4444;
    }
    #edux-solver-hud .hud-status {
      font-weight: 600;
      font-size: 12px;
      color: #e2e8f0;
      margin-bottom: 6px;
    }
    #edux-solver-hud .hud-progress-bar {
      height: 6px;
      background: #1e293b;
      border-radius: 999px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    #edux-solver-hud .hud-progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #3b82f6, #10b981);
      transition: width 0.3s ease;
    }
    #edux-solver-hud .hud-detail {
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(hudElement);

  document.getElementById('hud-close-btn').addEventListener('click', () => {
    stopAutoSolve('Người dùng đã bấm dừng từ bảng điều khiển.');
  });
}

function updateHUD(status, detail, progressPercent = null) {
  if (!hudElement) createHUD();

  const statusEl = document.getElementById('hud-status');
  const detailEl = document.getElementById('hud-detail');
  const progressEl = document.getElementById('hud-progress-fill');

  if (statusEl) statusEl.textContent = status;
  if (detailEl) detailEl.textContent = detail;
  if (progressEl && progressPercent !== null) {
    progressEl.style.width = `${Math.min(100, Math.max(0, progressPercent))}%`;
  }
}

function removeHUD() {
  if (hudElement) {
    hudElement.remove();
    hudElement = null;
  }
  const style = document.getElementById('edux-solver-hud-style');
  if (style) style.remove();
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
 * Kích hoạt đầy đủ sự kiện Pointer + Mouse + Click an toàn cho React 18 / Vue / Angular
 */
function clickElementSafely(el) {
  if (!el) return;
  const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
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
/**
 * Bóc tách câu hỏi và các lựa chọn ĐANG HIỂN THỊ trên màn hình hiện tại (EduX Single Question)
 */
function extractCurrentSingleQuestion() {
  const root = getQuizRoot();
  const allElements = Array.from(root.querySelectorAll('*'));

  // 1. Tìm tiêu đề câu hỏi: tìm phần tử chứa "Câu [0-9]+"
  let questionText = '';
  let questionNumber = 1;

  // Lọc các node chứa "Câu X"
  const qTitleNodes = allElements.filter((el) => {
    const text = el.innerText?.trim() || '';
    return /^Câu\s*\d+/i.test(text) && el.children.length <= 4;
  });

  if (qTitleNodes.length > 0) {
    const titleNode = qTitleNodes[0];
    const numMatch = (titleNode.innerText || '').match(/Câu\s*(\d+)/i);
    if (numMatch) {
      questionNumber = parseInt(numMatch[1], 10);
    }

    // Trên EduX, cấu trúc đề thi gồm hàng tiêu đề (Câu X [Trắc nghiệm] :) và nội dung câu hỏi nằm trong .flex.items-start
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

    // Dọn dẹp các nhãn giao diện thừa như "Trắc nghiệm", "Điền chỗ trống" để nội dung đề bài chuẩn xác nhất
    questionText = questionText
      .replace(/Trắc nghiệm\s*[:\-]?\s*/gi, '')
      .replace(/Điền chỗ trống\s*[:\-]?\s*/gi, '')
      .replace(/Điền từ hoặc cụm từ phù hợp vào chỗ trống\s*[:\-]?\s*/gi, '')
      .trim();
  } else {
    // Fallback: Tìm tiêu đề thông qua thẻ h1-h4 hoặc class questionText
    const heading = root.querySelector(SELECTORS.questionText);
    if (heading) {
      questionText = heading.innerText.trim();
    }
  }

  // 2. Tìm các lựa chọn A, B, C, D
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

  // 3. Kiểm tra xem có ô nhập liệu dạng điền từ (fill_blank) không
  const fillInput = Array.from(
    root.querySelectorAll(
      'input[placeholder*="Nhập câu trả lời"], input[placeholder*="câu trả lời"], input[placeholder*="trả lời"], textarea, input[type="text"]'
    )
  ).find((el) => !el.closest('#edux-solver-hud') && (el.offsetParent !== null || el.offsetWidth > 0));

  const isFillBlank = options.length < 2 && !!fillInput;
  const questionType = isFillBlank ? 'fill_blank' : 'multiple_choice';

  return {
    questionNumber,
    questionText,
    questionType,
    options,
    inputElement: isFillBlank ? fillInput : null
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

async function callGeminiAPI(apiKey, questionText, options) {
  const formattedOptions = options
    .map((opt) => `${opt.label}. ${opt.text}`)
    .join('\n');

  const prompt = `Bạn là một chuyên gia giải bài tập trắc nghiệm học thuật xuất sắc. Hãy đọc kỹ câu hỏi và các phương án sau:

[CÂU HỎI]:
${questionText}

[CÁC LỰA CHỌN]:
${formattedOptions}

YÊU CẦU:
1. Đọc và suy luận thật kỹ đề bài, đối chiếu các phương án để chọn DUY NHẤT một đáp án đúng nhất và chính xác nhất.
2. Bắt buộc trả lời ngay ở dòng đầu tiên theo đúng mẫu sau (không viết thêm chữ nào khác ở dòng đầu):
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
          { action: 'CALL_GEMINI_PROXY', apiKey, prompt },
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

  // 1. Bóc tách linh hoạt: "Đáp án: A", "A.", "**A**", hoặc chữ cái đơn lẻ
  const match =
    trimmed.match(/Đáp án\s*[:\-]?\s*([A-F])/i) ||
    trimmed.match(/\*\*([A-F])\*\*/i) ||
    trimmed.match(/^([A-F])[\.\:\)]/im) ||
    trimmed.match(/\b([A-F])\b/i);

  if (match) {
    return match[1].toUpperCase();
  }

  // 2. Fallback theo nội dung text nếu Gemini trả về tên đáp án thay vì chữ cái (ví dụ: "Hà Nội")
  for (const opt of options) {
    if (opt.text && opt.text.length >= 3 && trimmed.toLowerCase().includes(opt.text.toLowerCase())) {
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

  // Quét sạch mọi div option hoặc input có border inline style màu xanh lá sót lại từ các câu trước do React tái sử dụng DOM
  const allStyled = root.querySelectorAll('div[style*="border"], input[style*="border"], label[style*="border"]');
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
 * Gọi Gemini giải câu hỏi dạng ĐIỀN CHỖ TRỐNG (Fill in the blank)
 */
async function callGeminiFillBlank(apiKey, questionText) {
  const prompt = `Bạn là một chuyên gia môn Trí tuệ nhân tạo (AI) và Đạo đức nghề nghiệp CNTT.
Đây là câu hỏi dạng [ĐIỀN TỪ VÀO CHỖ TRỐNG] (hoàn toàn không có các lựa chọn A, B, C, D).

[CÂU HỎI]:
${questionText}

YÊU CẦU:
1. Đọc kỹ câu hỏi, tìm từ hoặc cụm từ chính xác nhất theo kiến thức chuẩn để điền vào vị trí dấu gạch dưới (______).
2. Bắt buộc trả lời ngay ở dòng đầu tiên theo đúng cú pháp sau:
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
  result = result.replace(/[\.\:\;]+$/, '').trim();
  return result;
}

// =============================================================================
// 8. TIẾN TRÌNH GIẢI BÀI TỰ ĐỘNG (HỖ TRỢ AUTO NEXT TỪNG CÂU)
// =============================================================================

async function startAutoSolve(apiKey) {
  if (isRunning) {
    console.warn('EduX AI Solver: Đang có tiến trình chạy, đang reset để bắt đầu lại...');
    isRunning = false;
    await sleep(300);
  }

  isRunning = true;
  createHUD();
  updateHUD('Đang quét cấu trúc bài thi...', 'Khởi động bộ phân tích', 5);
  notifyPopup('UPDATE_STATUS', 'Đang quét cấu trúc bài thi...');

  if (!apiKey) {
    const errorMsg = 'Chưa có Gemini API Key! Vui lòng nhập trong Popup tiện ích.';
    alert('EduX AI Solver: ' + errorMsg);
    updateHUD('Lỗi cấu hình', errorMsg, 0);
    notifyPopup('UPDATE_STATUS', '❌ ' + errorMsg, true);
    isRunning = false;
    return;
  }

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

    // Kiểm tra câu hỏi hợp lệ: trắc nghiệm (>= 2 options) HOẶC điền ô trống (có inputElement)
    const isQuestionValid =
      qData &&
      ((qData.questionType === 'fill_blank' && qData.inputElement !== null) ||
        (qData.options && qData.options.length >= 2));

    if (!isQuestionValid) {
      domRetryCount++;
      if (domRetryCount >= MAX_DOM_RETRIES) {
        // Bỏ qua câu này sau khi thử nhiều lần - tự động chuyển tiếp
        console.warn(`[EduX AI Solver] Câu ${currentStep}: Không tìm thấy DOM sau ${MAX_DOM_RETRIES} lần, tự động bỏ qua.`);
        updateHUD(`Bỏ qua câu ${currentStep}`, 'Không tìm thấy câu hỏi trên trang, đang chuyển tiếp...', (currentStep / totalQuestions) * 100);
        notifyPopup('UPDATE_STATUS', `⚠️ Câu ${currentStep}: Không tìm thấy DOM, tự bỏ qua.`);
        // Thử bấm chuyển tiếp
        await advanceToNextQuestion(currentStep + 1);
        currentStep++;
        domRetryCount = 0;
      } else {
        updateHUD(`Đang chờ tải câu ${currentStep}...`, `Thử lần ${domRetryCount}/${MAX_DOM_RETRIES}...`, (currentStep / totalQuestions) * 100);
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
        currentStep++;
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

    } else {
      // === DẠNG 2: TRẮC NGHIỆM CHỌN A, B, C, D ===
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
        currentStep++;
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
        // Giả lập thời gian đọc đề: delay 1.5s - 3.5s
        const delayMs = getRandomDelay(CONFIG.minDelay, CONFIG.maxDelay);
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
      await sleep(800); // Chờ 0.8s sau khi chọn/điền đáp án

      updateHUD(`Câu ${qNum} xong`, 'Đang chuyển sang câu tiếp theo...', progressPercent);
      await advanceToNextQuestion(currentStep + 1);

      // Chờ trang câu mới hiển thị
      for (let w = 0; w < 4; w++) {
        await sleep(400);
        const checkQ = extractCurrentSingleQuestion();
        if (checkQ && checkQ.questionText && checkQ.questionText !== qData.questionText) {
          break; // Đã sang câu mới
        }
      }
    }

    currentStep++;
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
      const delayMs = getRandomDelay(CONFIG.minDelay, CONFIG.maxDelay);
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
      statusText: hudElement ? document.getElementById('hud-status')?.textContent : ''
    });
    return true;
  }

  if (request.action === 'START_AUTO_SOLVE') {
    startAutoSolve(request.apiKey);
    sendResponse({ status: 'started' });
    return true;
  }

  if (request.action === 'STOP_AUTO_SOLVE') {
    stopAutoSolve('Người dùng đã yêu cầu dừng từ Popup.');
    sendResponse({ status: 'stopped' });
    return true;
  }
});
