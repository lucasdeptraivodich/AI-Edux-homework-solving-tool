/**
 * background.js - Service Worker (Manifest V3)
 * Proxy gọi Google Gemini API với cơ chế tự động dò tìm model (Auto-Fallback)
 * Tự động chuyển model khi gặp lỗi High Demand (503), Quota hoặc Model Deprecated.
 */

// ============================================================
// KEEPALIVE: Ngăn Chrome kill Service Worker giữa chừng
// ============================================================
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Ping nhẹ để giữ service worker sống
    console.log('[EduX] Keepalive ping...');
  }
});

// ============================================================
// DANH SÁCH MODEL VÀ CƠ CHẾ POOL QUOTA TỰ ĐỘNG
// ============================================================

// Bộ nhớ đệm lưu lại endpoint & model hoạt động thành công
let cachedTarget = null;

// Map ghi nhận các model đã cạn Quota (429) để tự động nhảy sang model khác ngay lập tức
const quotaExhaustedMap = new Map();

// Cache danh sách model đã quét từ Google AI Studio
let cachedDiscoveredModels = null;
let lastDiscoveryTime = 0;

// Danh sách model bị deprecated / không phù hợp giải trắc nghiệm - sẽ bị bỏ qua khi dò tìm tự động
const DEPRECATED_MODELS = [
  'gemini-1.0',
  'tts',
  'image',
  'embedding',
  'aqa',
  'robotics',
  'computer-use'
];

// Danh sách dự phòng toàn diện tất cả các model của Google AI Studio (Flash Lite, Flash, Pro)
const FALLBACK_CANDIDATE_MODELS = [
  // Nhóm 1: Các model Flash Lite / Flash 8B (Quota cực lớn: 500 - 1500 RPD)
  { version: 'v1beta', model: 'gemini-1.5-flash-8b' },
  { version: 'v1beta', model: 'gemini-1.5-flash-8b-latest' },
  { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.0-flash-lite-preview' },
  { version: 'v1beta', model: 'gemini-2.0-flash-lite-preview-02-05' },
  { version: 'v1beta', model: 'gemini-flash-lite-latest' },

  // Nhóm 2: Các model Flash chuẩn
  { version: 'v1beta', model: 'gemini-1.5-flash' },
  { version: 'v1beta', model: 'gemini-1.5-flash-latest' },
  { version: 'v1beta', model: 'gemini-2.0-flash' },
  { version: 'v1beta', model: 'gemini-2.0-flash-exp' },
  { version: 'v1beta', model: 'gemini-flash-latest' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  { version: 'v1beta', model: 'gemini-3.5-flash' },
  { version: 'v1beta', model: 'gemini-3.1-flash' },
  { version: 'v1beta', model: 'gemini-3.8-flash' },

  // Nhóm 3: Các model Pro thông minh cao cấp
  { version: 'v1beta', model: 'gemini-1.5-pro' },
  { version: 'v1beta', model: 'gemini-1.5-pro-latest' },
  { version: 'v1beta', model: 'gemini-2.0-pro-exp-02-05' },
  { version: 'v1beta', model: 'gemini-pro-latest' }
];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. Kiểm tra kết nối nhanh (Test Key)
  if (request.action === 'TEST_GEMINI_CONNECTION') {
    const startTime = Date.now();
    handleGeminiCallWithFallback(request.apiKey, 'Trả lời duy nhất chữ OK:')
      .then((data) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        sendResponse({
          success: true,
          model: cachedTarget ? `${cachedTarget.model}` : 'Gemini AI',
          time: elapsed,
          text: data
        });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // 2. Gọi API giải câu hỏi
  if (request.action === 'CALL_GEMINI_PROXY') {
    handleGeminiCallWithFallback(request.apiKey, request.prompt)
      .then((data) => sendResponse({ success: true, data, model: cachedTarget?.model }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true; // Giữ kênh kết nối bất đồng bộ
  }
});

/**
 * Thử gọi API với một target (version + model) cụ thể (Có timeout 7 giây chống treo)
 */
async function tryCallGemini(apiKey, version, model, prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.0, // Nhiệt độ 0 để AI trả về câu trả lời chính xác, kiên định nhất
      maxOutputTokens: 1024
    }
  };

  // Tạo tín hiệu timeout 7 giây để chuyển fallback nhanh chóng nếu model bận
  let signal;
  try {
    signal = AbortSignal.timeout(7000);
  } catch (e) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 7000);
    signal = controller.signal;
  }

  let response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody),
    signal
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = data.error?.message || `HTTP ${response.status}`;
    const err = new Error(errorMsg);
    err.status = response.status;

    // Chỉ dừng khi sai cú pháp API Key hoàn toàn:
    err.isKeyError =
      response.status === 400 &&
      (errorMsg.includes('API key not valid') || errorMsg.includes('API_KEY_INVALID'));

    err.isQuotaError =
      response.status === 429 ||
      errorMsg.includes('quota') ||
      errorMsg.includes('Quota') ||
      errorMsg.includes('RESOURCE_EXHAUSTED') ||
      errorMsg.includes('Rate limit') ||
      errorMsg.includes('rate limit') ||
      errorMsg.includes('limit reached');

    throw err;
  }

  // Trích xuất text từ candidates, hỗ trợ cả thinking parts của Gemini 2.0
  const candidate = data?.candidates?.[0];
  let candidateText = '';
  if (candidate?.content?.parts) {
    const textParts = candidate.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text);
    if (textParts.length > 0) {
      candidateText = textParts.join(' ').trim();
    } else {
      candidateText = candidate.content.parts.map((p) => p.text || '').join(' ').trim();
    }
  }

  // Làm sạch các ký tự vô hình / zero-width spaces (\u200B, \uFEFF...)
  candidateText = candidateText.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

  // Bắt buộc phải có text phản hồi, nếu rỗng thì ném lỗi để Fallback sang model khác
  if (!candidateText || candidateText.length === 0) {
    const reason = data?.promptFeedback?.blockReason || candidate?.finishReason || 'Không có nội dung trả về';
    throw new Error(`Model ${model} không sinh nội dung phản hồi (${reason}).`);
  }

  return candidateText;
}

/**
 * Tự động tìm kiếm TOÀN BỘ model khả dụng từ danh sách ListModels của Google AI Studio
 */
async function discoverAllAvailableModels(apiKey) {
  if (cachedDiscoveredModels && (Date.now() - lastDiscoveryTime < 5 * 60 * 1000)) {
    return cachedDiscoveredModels;
  }

  for (const ver of ['v1beta', 'v1']) {
    try {
      let signal;
      try {
        signal = AbortSignal.timeout(6000);
      } catch (e) {
        signal = undefined;
      }

      const res = await fetch(`https://generativelanguage.googleapis.com/${ver}/models?key=${apiKey}`, { signal });
      if (res.ok) {
        const json = await res.json();
        const models = json.models || [];

        // Lọc các model hỗ trợ generateContent và không bị deprecated
        const validModels = models.filter((m) => {
          const name = (m.name || '').replace(/^models\//, '').toLowerCase();
          const isDeprecated = DEPRECATED_MODELS.some((d) => name.includes(d));
          return m.supportedGenerationMethods?.includes('generateContent') && !isDeprecated;
        });

        // Sắp xếp ưu tiên:
        // 1. Flash Lite / 8b / 3.5 / 3.1 (quota lớn 500 RPD)
        // 2. Flash khác (1.5-flash, 2.0-flash...)
        // 3. Pro (1.5-pro, 2.0-pro...)
        // 4. Các model còn lại
        const sorted = validModels.sort((a, b) => {
          const nameA = a.name.toLowerCase();
          const nameB = b.name.toLowerCase();

          const scoreA =
            (nameA.includes('lite') || nameA.includes('8b') || nameA.includes('3.5') || nameA.includes('3.1')) ? 10 :
            nameA.includes('flash') ? 8 :
            nameA.includes('pro') ? 5 : 1;

          const scoreB =
            (nameB.includes('lite') || nameB.includes('8b') || nameB.includes('3.5') || nameB.includes('3.1')) ? 10 :
            nameB.includes('flash') ? 8 :
            nameB.includes('pro') ? 5 : 1;

          return scoreB - scoreA;
        });

        const resultList = sorted.map((m) => ({
          version: ver,
          model: m.name.replace(/^models\//, '')
        }));

        if (resultList.length > 0) {
          cachedDiscoveredModels = resultList;
          lastDiscoveryTime = Date.now();
          console.log(`[EduX AI Solver] Đã quét được ${resultList.length} model khả dụng từ tài khoản:`, resultList.map(m => m.model));
          return resultList;
        }
      }
    } catch (e) {
      console.warn(`Lỗi khi quét danh sách model (${ver}):`, e.message);
    }
  }

  return FALLBACK_CANDIDATE_MODELS;
}

/**
 * Xử lý gọi Gemini với BỂ QUOTA ĐA MODEL TỰ ĐỘNG (Multi-Model Quota Pool)
 * Khi bất kỳ model nào hết Quota (429), lập tức chuyển sang model tiếp theo trong tài khoản
 */
async function handleGeminiCallWithFallback(apiKey, prompt) {
  // 1. Thử dùng target đã lưu thành công trước đó (nếu chưa bị cạn quota)
  if (cachedTarget) {
    const isExhausted = quotaExhaustedMap.has(cachedTarget.model) && quotaExhaustedMap.get(cachedTarget.model) > Date.now();
    if (!isExhausted) {
      try {
        const res = await tryCallGemini(apiKey, cachedTarget.version, cachedTarget.model, prompt);
        if (res && res.trim().length > 0) return res.trim();
      } catch (e) {
        console.warn(`Model đang dùng (${cachedTarget.model}) gặp lỗi: ${e.message}. Tự động đổi model khác...`);
        if (e.isQuotaError) {
          quotaExhaustedMap.set(cachedTarget.model, Date.now() + 20 * 60 * 1000); // Đánh dấu cạn quota 20 phút
        }
        cachedTarget = null;
      }
    } else {
      cachedTarget = null;
    }
  }

  // 2. Lấy toàn bộ danh sách model từ tài khoản Google AI Studio
  const discoveredModels = await discoverAllAvailableModels(apiKey);

  // Gộp danh sách quét được và fallback list (khử trùng lặp)
  const pool = [];
  const seen = new Set();
  for (const item of [...discoveredModels, ...FALLBACK_CANDIDATE_MODELS]) {
    const key = `${item.version}/${item.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      pool.push(item);
    }
  }

  // Sắp xếp: Ưu tiên các model CHƯA bị cạn quota lên đầu
  const prioritizedPool = pool.sort((a, b) => {
    const aEx = quotaExhaustedMap.has(a.model) && quotaExhaustedMap.get(a.model) > Date.now();
    const bEx = quotaExhaustedMap.has(b.model) && quotaExhaustedMap.get(b.model) > Date.now();
    if (aEx && !bEx) return 1;
    if (!aEx && bEx) return -1;
    return 0;
  });

  let lastError = null;
  let triedCount = 0;

  for (const candidate of prioritizedPool) {
    // Nếu model đã cạn quota trong phiên này, bỏ qua để nhảy ngay sang model khác
    if (quotaExhaustedMap.has(candidate.model) && quotaExhaustedMap.get(candidate.model) > Date.now()) {
      continue;
    }

    triedCount++;
    try {
      console.log(`[EduX AI Solver] Đang kích hoạt model dự phòng: ${candidate.model} (${candidate.version})...`);
      const result = await tryCallGemini(apiKey, candidate.version, candidate.model, prompt);

      if (result && result.trim().length > 0) {
        cachedTarget = candidate;
        console.log(`✅ Kết nối thành công với model: ${candidate.model} (${candidate.version})`);
        return result.trim();
      }
    } catch (err) {
      lastError = err;

      // Nếu sai API Key hoàn toàn -> Dừng ngay báo cho người dùng
      if (err.isKeyError) {
        throw err;
      }

      // Nếu hết quota (429) -> Ghi nhận và nhảy ngay sang model tiếp theo trong gói
      if (err.isQuotaError) {
        quotaExhaustedMap.set(candidate.model, Date.now() + 20 * 60 * 1000);
        console.warn(`⚠️ Model ${candidate.model} đã hết hạn mức Quota (429). Tự động kích hoạt model tiếp theo trong tài khoản...`);
        continue;
      }

      // Các lỗi khác (503 High demand, 404...) -> Thử model kế tiếp
      console.warn(`Model ${candidate.model} không phản hồi (${err.message}). Đang chuyển model...`);
      continue;
    }
  }

  throw lastError || new Error(`Đã thử qua ${triedCount} model khả dụng nhưng tất cả gói đều đang cạn Quota. Vui lòng thử lại sau.`);
}
