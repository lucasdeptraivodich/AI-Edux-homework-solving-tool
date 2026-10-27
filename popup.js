/**
 * popup.js - Quản lý giao diện Popup của Chrome Extension
 * Xử lý lưu trữ Gemini API Key và điều khiển quá trình tự động giải bài.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const apiKeyInput = document.getElementById('apiKeyInput');
  const toggleKeyVisibilityBtn = document.getElementById('toggleKeyVisibility');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const logMessage = document.getElementById('logMessage');

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

  // 1. Tải API Key đã lưu từ chrome.storage.local khi mở Popup
  chrome.storage.local.get(['geminiApiKey', 'isSolving'], (result) => {
    if (result.geminiApiKey) {
      apiKeyInput.value = result.geminiApiKey;
      updateBadge(true);
      setLog('Đã sẵn sàng. Bấm "Bắt đầu tự động làm" để chạy.');
    } else {
      updateBadge(false);
      setLog('Vui lòng nhập Gemini API Key để tiếp tục.', true);
    }

    if (result.isSolving) {
      startBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
    }
    // Đồng bộ trạng thái với tab hiện tại
    getActiveTab().then((tab) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { action: 'GET_SOLVER_STATE' }, (res) => {
          if (!chrome.runtime.lastError && res) {
            if (res.isRunning) {
              startBtn.style.display = 'none';
              stopBtn.style.display = 'flex';
              if (res.statusText) setLog(res.statusText);
            } else {
              startBtn.style.display = 'flex';
              stopBtn.style.display = 'none';
            }
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
  const testKeyBtn = document.getElementById('testKeyBtn');
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

  // 5. Nút "Bắt đầu tự động làm"
  startBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      setLog('❌ Chưa có API Key! Hãy dán key và bấm "Lưu API Key" trước.', true);
      return;
    }

    const tab = await getActiveTab();
    if (!tab) {
      setLog('❌ Không tìm thấy tab hoạt động!', true);
      return;
    }

    // Không cho phép inject vào các trang đặc biệt của Chrome
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      setLog('❌ Không thể chạy extension trên trang hệ thống của Chrome!', true);
      return;
    }

    setLog('🚀 Đang kết nối với trang bài tập...');

    // Hàm gửi tin nhắn tới content.js
    const sendMessageToTab = () => {
      chrome.tabs.sendMessage(
        tab.id,
        { action: 'START_AUTO_SOLVE', apiKey: key },
        (response) => {
          if (chrome.runtime.lastError) {
            setLog('❌ Lỗi kết nối script: ' + chrome.runtime.lastError.message, true);
          } else if (response && response.status === 'started') {
            startBtn.style.display = 'none';
            stopBtn.style.display = 'flex';
            chrome.storage.local.set({ isSolving: true });
            setLog('⚡ Đang tự động giải câu hỏi trên trang...');
          }
        }
      );
    };

    // Kiểm tra và tiêm content.js nếu chưa có sẵn trong tab
    try {
      chrome.tabs.sendMessage(tab.id, { action: 'PING' }, async (response) => {
        if (chrome.runtime.lastError || !response) {
          // Chưa có content.js trong trang -> dùng chrome.scripting.executeScript để inject
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
            // Đợi script khởi tạo rồi gửi lệnh
            setTimeout(sendMessageToTab, 300);
          } catch (injectErr) {
            setLog('❌ Không thể chèn content script: ' + injectErr.message, true);
          }
        } else {
          // Đã có sẵn content.js
          sendMessageToTab();
        }
      });
    } catch (err) {
      setLog('❌ Lỗi: ' + err.message, true);
    }
  });

  // 6. Nút "Dừng lại"
  stopBtn.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'STOP_AUTO_SOLVE' }, () => {
        startBtn.style.display = 'flex';
        stopBtn.style.display = 'none';
        chrome.storage.local.set({ isSolving: false });
        setLog('⏹ Đã gửi lệnh dừng tiến trình.');
      });
    }
  });

  // 7. Lắng nghe cập nhật trạng thái từ content.js gửi về Popup
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'UPDATE_STATUS') {
      setLog(message.text, message.isError || false);
    } else if (message.action === 'SOLVE_FINISHED') {
      startBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      chrome.storage.local.set({ isSolving: false });
      setLog(message.text || '🎉 Đã hoàn thành toàn bộ bài tập!', message.isError || false);
    }
  });
});
