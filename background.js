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

// Bộ nhớ đệm lưu lại endpoint & model hoạt động thành công
let cachedTarget = null;

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

// Danh sách các model và version ưu tiên (Ưu tiên gemini-3.5-flash và 3.6-flash để độ chính xác tối đa)
const CANDIDATE_MODELS = [
  { version: 'v1beta', model: 'gemini-3.5-flash' },
  { version: 'v1beta', model: 'gemini-3.6-flash' },
  { version: 'v1beta', model: 'gemini-3.7-flash' },
  { version: 'v1beta', model: 'gemini-flash-latest' },
  { version: 'v1beta', model: 'gemini-flash-lite-latest' },
  { version: 'v1beta', model: 'gemini-3.8-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash' }
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
 * Thử gọi API với một target (version + model) cụ thể (Có timeout 8 giây chống treo)
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
 * Tự động tìm kiếm model khả dụng từ danh sách ListModels của Google AI Studio
 */
async function discoverAvailableModel(apiKey) {
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
          const name = (m.name || '').replace(/^models\//, '');
          const isDeprecated = DEPRECATED_MODELS.some((d) => name.includes(d));
          return m.supportedGenerationMethods?.includes('generateContent') && !isDeprecated;
        });

        // Tìm model flash ưu tiên theo thứ tự: 3.6-flash > 3.5-flash > 3.7-flash > flash khác
        const preferred =
          validModels.find((m) => (m.name || '').includes('3.6-flash')) ||
          validModels.find((m) => (m.name || '').includes('3.5-flash')) ||
          validModels.find((m) => (m.name || '').includes('3.7-flash')) ||
          validModels.find((m) => (m.name || '').includes('3.8-flash')) ||
          validModels.find((m) => (m.name || '').includes('flash-lite')) ||
          validModels.find((m) => (m.name || '').includes('flash'));

        if (preferred) {
          const cleanName = preferred.name.replace(/^models\//, '');
          console.log(`EduX AI Solver: Dò được model tối ưu: ${cleanName} (${ver})`);
          return { version: ver, model: cleanName };
        }

        // Fallback: lấy model đầu tiên hợp lệ (không deprecated)
        const fallbackModel = validModels[0];
        if (fallbackModel) {
          const cleanName = fallbackModel.name.replace(/^models\//, '');
          return { version: ver, model: cleanName };
        }
      }
    } catch (e) {
      // Bỏ qua lỗi để thử tiếp
    }
  }
  return null;
}

/**
 * Xử lý gọi Gemini với cơ chế tự động chuyển đổi model (Auto-Fallback)
 */
async function handleGeminiCallWithFallback(apiKey, prompt) {
  // 1. Thử dùng target đã lưu thành công trước đó (Nếu thất bại, tự động bỏ qua để thử lại danh sách mới)
  if (cachedTarget) {
    try {
      const res = await tryCallGemini(apiKey, cachedTarget.version, cachedTarget.model, prompt);
      if (res && res.trim().length > 0) return res.trim();
      cachedTarget = null;
    } catch (e) {
      console.warn(`Target cũ (${cachedTarget.model}) bị lỗi: ${e.message}. Tự động reset và thử model khác...`);
      cachedTarget = null;
    }
  }

  // 2. Thử lần lượt các candidate ưu tiên
  let lastError = null;

  for (const candidate of CANDIDATE_MODELS) {
    try {
      console.log(`EduX AI Solver: Thử kết nối model ${candidate.model} (${candidate.version})...`);
      const result = await tryCallGemini(apiKey, candidate.version, candidate.model, prompt);

      // Nếu trả về text hợp lệ -> Ghi nhớ và trả về ngay
      if (result && result.trim().length > 0) {
        cachedTarget = candidate;
        console.log(`✅ Đã kết nối thành công với: ${candidate.model} (${candidate.version})`);
        return result.trim();
      }
    } catch (err) {
      lastError = err;

      // Nếu sai API Key hoàn toàn -> Dừng ngay báo cho người dùng
      if (err.isKeyError) {
        throw err;
      }

      // Với bất kỳ lỗi nào khác (High Demand, Quota, 404, 503, Empty) -> TỰ ĐỘNG CHUYỂN SANG MODEL TIẾP THEO
      console.warn(`Model ${candidate.model} (${candidate.version}) không khả dụng: ${err.message}. Đang thử model kế tiếp...`);
      continue;
    }
  }

  // 3. Nếu các candidate trên đều bận, tự động quét API ListModels
  const discovered = await discoverAvailableModel(apiKey);
  if (discovered) {
    try {
      const result = await tryCallGemini(apiKey, discovered.version, discovered.model, prompt);
      if (result && result.trim().length > 0) {
        cachedTarget = discovered;
        return result.trim();
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Tất cả các model Gemini đều đang quá tải hoặc không phản hồi. Vui lòng thử lại.');
}
