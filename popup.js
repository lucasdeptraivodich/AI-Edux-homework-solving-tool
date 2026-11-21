/**
 * popup.js - Quản lý giao diện Popup của Chrome Extension
 * Hỗ trợ 2 tính năng riêng biệt + chuyển tốc độ (Siêu tốc / Tự nhiên):
 * 1. Bài tập AI (mode: 'quiz', mặc định Tự nhiên)
 * 2. Bài giảng AI (mode: 'lecture', mặc định Siêu tốc)
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleKeyVisibilityBtn = document.getElementById('toggleKeyVisibility');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const testKeyBtn = document.getElementById('testKeyBtn');
  const startQuizBtn = document.getElementById('startQuizBtn');
  const startLectureBtn = document.getElementById('startLectureBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const logMessage = document.getElementById('logMessage');

  const tabQuizBtn = document.getElementById('tabQuizBtn');
  const tabLectureBtn = document.getElementById('tabLectureBtn');
  const panelQuiz = document.getElementById('panelQuiz');
  const panelLecture = document.getElementById('panelLecture');
  const quizSpeedHint = document.getElementById('quizSpeedHint');
  const lectureSpeedHint = document.getElementById('lectureSpeedHint');

  const speedFastBtn = document.getElementById('speedFastBtn');
  const speedNormalBtn = document.getElementById('speedNormalBtn');

  let activeMode = 'quiz';
  let speedByMode = { quiz: 'normal', lecture: 'fast' };
  let isCurrentlyRunning = false;

  /**
   * Cập nhật thông báo trên log box
   */
  function setLog(message, isError = false) {
    if (logMessage) {
      logMessage.textContent = message;
      logMessage.style.color = isError ? '#f87171' : '#e2e8f0';
    }
  }

  /**
   * Cập nhật trạng thái badge của API Key
   */
  function updateBadge(hasKey) {
    if (hasKey) {
      statusBadge.className = 'status-badge badge-success';
      statusText.textContent = 'Đã kết nối Gemini';
    } else {
      statusBadge.className = 'status-badge badge-warning';
      statusText.textContent = 'Chưa có API Key';
    }
  }

  /**
   * Đồng bộ giao diện tab, tốc độ & nút theo chế độ ('quiz' | 'lecture')
   */
  function renderModeUI() {
    const isQuiz = activeMode === 'quiz';
    const currentSpeed = speedByMode[activeMode] || (isQuiz ? 'normal' : 'fast');
    const isFast = currentSpeed === 'fast';

    tabQuizBtn.classList.toggle('active', isQuiz);
    tabLectureBtn.classList.toggle('active', !isQuiz);
    tabQuizBtn.setAttribute('aria-selected', String(isQuiz));
    tabLectureBtn.setAttribute('aria-selected', String(!isQuiz));

    tabQuizBtn.disabled = isCurrentlyRunning;
    tabLectureBtn.disabled = isCurrentlyRunning;
    speedFastBtn.disabled = isCurrentlyRunning;
    speedNormalBtn.disabled = isCurrentlyRunning;

    speedFastBtn.classList.toggle('active', isFast);
    speedNormalBtn.classList.toggle('active', !isFast);

    if (quizSpeedHint) {
      quizSpeedHint.textContent = speedByMode.quiz === 'fast' ? '⚡ Siêu tốc (~0.4s/câu)' : '1.5s - 3.5s / câu';
    }
    if (lectureSpeedHint) {
      lectureSpeedHint.textContent =
        speedByMode.lecture === 'fast' ? '⚡ Siêu tốc + Cache' : '🛡️ Chế độ Tự nhiên';
    }

    panelQuiz.style.display = isQuiz ? 'flex' : 'none';
    panelLecture.style.display = isQuiz ? 'none' : 'flex';

    if (isCurrentlyRunning) {
      startQuizBtn.style.display = 'none';
      startLectureBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    } else {
      stopBtn.style.display = 'none';
      startQuizBtn.style.display = isQuiz ? 'flex' : 'none';
      startLectureBtn.style.display = isQuiz ? 'none' : 'flex';
    }
  }

  function switchMode(mode) {
    if (isCurrentlyRunning) return;
    activeMode = mode === 'lecture' ? 'lecture' : 'quiz';
    chrome.storage.local.set({ activeMode });
    renderModeUI();
  }

  function setSpeed(speed) {
    if (isCurrentlyRunning) return;
    speedByMode[activeMode] = speed === 'fast' ? 'fast' : 'normal';
    chrome.storage.local.set({ speedByMode });
    renderModeUI();
  }

  tabQuizBtn.addEventListener('click', () => switchMode('quiz'));
  tabLectureBtn.addEventListener('click', () => switchMode('lecture'));
  speedFastBtn.addEventListener('click', () => setSpeed('fast'));
  speedNormalBtn.addEventListener('click', () => setSpeed('normal'));

  // 1. Tải API Key & cấu hình đã lưu từ chrome.storage.local khi mở Popup
  chrome.storage.local.get(['geminiApiKey', 'isSolving', 'activeMode', 'speedByMode'], (result) => {
    if (result.activeMode === 'lecture' || result.activeMode === 'quiz') {
      activeMode = result.activeMode;
    }
    if (result.speedByMode && typeof result.speedByMode === 'object') {
      speedByMode = {
        quiz: result.speedByMode.quiz === 'fast' ? 'fast' : 'normal',
        lecture: result.speedByMode.lecture === 'normal' ? 'normal' : 'fast'
      };
    }

    if (result.geminiApiKey) {
      apiKeyInput.value = result.geminiApiKey;
      updateBadge(true);
      setLog('Đã sẵn sàng. Chọn chế độ và bấm Bắt đầu để chạy.');
    } else {
      updateBadge(false);
      setLog('Vui lòng nhập Gemini API Key để tiếp tục.', true);
    }

    isCurrentlyRunning = Boolean(result.isSolving);
    renderModeUI();

    // Đồng bộ trạng thái thực tế với tab hiện tại
    getActiveTab().then((tab) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_SOLVER_STATE' }, (res) => {
          if (!chrome.runtime.lastError && res) {
            isCurrentlyRunning = Boolean(res.isRunning);
            if (res.isRunning && (res.mode === 'quiz' || res.mode === 'lecture')) {
              activeMode = res.mode;
              if (typeof res.fastMode === 'boolean') {
                speedByMode[activeMode] = res.fastMode ? 'fast' : 'normal';
              }
            }
            if (res.isRunning && res.statusText) {
              setLog(res.statusText);
            }
            chrome.storage.local.set({ isSolving: isCurrentlyRunning });
            renderModeUI();
          }
        });
      }
    });
  });

  // 2. Chức năng Ẩn/Hiện API Key
  toggleKeyVisibilityBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleKeyVisibilityBtn.textContent = isPassword ? '🔒' : '👁️';
  });

  // 3. Lưu API Key vào chrome.storage.local
  saveKeyBtn.addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      setLog('Vui lòng không để trống API Key!', true);
      return;
    }

    chrome.storage.local.set({ geminiApiKey: key }, () => {
      updateBadge(true);
      setLog('✅ Đã lưu API Key thành công vào bộ nhớ!');
    });
  });

  // 3.1. Nút Test Key kiểm tra kết nối API ngay lập tức
  if (testKeyBtn) {
    testKeyBtn.addEventListener('click', () => {
      const key = apiKeyInput.value.trim();
      if (!key) {
        setLog('❌ Vui lòng nhập hoặc dán API Key trước khi test!', true);
        return;
      }

      setLog('🔍 Đang kiểm tra kết nối tới Google Gemini...');
      testKeyBtn.disabled = true;

      chrome.runtime.sendMessage(
        { action: 'TEST_GEMINI_CONNECTION', apiKey: key },
        (res) => {
          testKeyBtn.disabled = false;
          if (chrome.runtime.lastError) {
            setLog('❌ Lỗi kết nối Extension: ' + chrome.runtime.lastError.message, true);
          } else if (res && res.success) {
            updateBadge(true);
            setLog(`✅ Key HOẠT ĐỘNG TỐT! Kết nối [${res.model}] thành công trong ${res.time}s.`);
          } else {
            setLog(`❌ Lỗi API: ${res?.error || 'Không kết nối được.'}`, true);
          }
        }
      );
    });
  }

  // 4. Lấy tab hiện tại đang active
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs.length > 0 ? tabs[0] : null;
  }

  // 5. Hàm khởi chạy dùng chung cho cả Bài tập AI ('quiz') và Bài giảng AI ('lecture')
  async function startMode(mode) {
    const key = apiKeyInput.value.trim();
    if (!key) {
      setLog('❌ Chưa có API Key! Hãy dán key và bấm "Lưu Key" trước.', true);
      return;
    }

    const tab = await getActiveTab();
    if (!tab) {
      setLog('❌ Không tìm thấy tab hoạt động!', true);
      return;
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      setLog('❌ Không thể chạy extension trên trang hệ thống của Chrome!', true);
      return;
    }

    activeMode = mode;
    const isFast = speedByMode[mode] === 'fast';
    chrome.storage.local.set({ activeMode: mode, speedByMode });

    const modeLabel = mode === 'lecture' ? 'Bài giảng AI' : 'Bài tập AI';
    const speedLabel = isFast ? '⚡ Siêu tốc' : '🛡️ Tự nhiên';
    setLog(`🚀 Đang kết nối ${modeLabel} (${speedLabel})...`);

    const sendMessageToTab = () => {
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'START_AUTO_SOLVE', apiKey: key, mode, fastMode: isFast },
        (response) => {
          if (chrome.runtime.lastError) {
            setLog('❌ Lỗi kết nối script: ' + chrome.runtime.lastError.message, true);
          } else if (response && response.status === 'started') {
            isCurrentlyRunning = true;
            chrome.storage.local.set({ isSolving: true, activeMode: mode });
            renderModeUI();
            setLog(`⚡ Đang chạy ${modeLabel} (${speedLabel})...`);
          }
        }
      );
    };

    try {
      chrome.tabs.sendMessage(tab.id, { action: 'PING' }, async (response) => {
        if (chrome.runtime.lastError || !response) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
            setTimeout(sendMessageToTab, 300);
          } catch (injectErr) {
            setLog('❌ Không thể chèn content script: ' + injectErr.message, true);
          }
        } else {
          sendMessageToTab();
        }
      });
    } catch (err) {
      setLog('❌ Lỗi: ' + err.message, true);
    }
  }

  startQuizBtn.addEventListener('click', () => startMode('quiz'));
  startLectureBtn.addEventListener('click', () => startMode('lecture'));

  // 6. Nút "Dừng lại"
  stopBtn.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'STOP_AUTO_SOLVE' }, () => {
        isCurrentlyRunning = false;
        chrome.storage.local.set({ isSolving: false });
        renderModeUI();
        setLog('⏹ Đã gửi lệnh dừng tiến trình.');
      });
    }
  });

  // 7. Lắng nghe cập nhật trạng thái từ content.js gửi về Popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'UPDATE_STATUS') {
      setLog(message.text, message.isError || false);
    } else if (message.action === 'SOLVE_FINISHED') {
      isCurrentlyRunning = false;
      chrome.storage.local.set({ isSolving: false });
      renderModeUI();
      setLog(message.text || '🎉 Đã hoàn thành!', message.isError || false);
    }
  });
});
