# EduX AI Quiz Solver - Chrome Extension (Manifest V3)

Tiện ích mở rộng Google Chrome (Manifest V3) hỗ trợ tự động đọc câu hỏi trắc nghiệm trên website EduX, gửi yêu cầu phân tích tới Google Gemini API (`gemini-1.5-flash`), mô phỏng độ trễ người dùng và tự động click chọn đáp án đúng kèm hiệu ứng viền xanh lá.

---

## ✨ Tính Năng Nổi Bật

- **Trắc nghiệm 4 lựa chọn (A, B, C, D)**: Tự động trích xuất nội dung các câu hỏi trắc nghiệm truyền thống và chọn đáp án chính xác.
- **Trắc nghiệm Đúng / Sai (True/False - Chương trình GDPT mới)**: Hỗ trợ tự động phân tích và chọn Đúng hoặc Sai cho từng ý (a, b, c, d) trong mỗi câu hỏi.
- **Tự luận / Điền từ (Fill in the blank)**: Tối ưu prompt phân tích ngữ cảnh, đơn vị đo, quy chuẩn định dạng số thập phân/chữ viết để đạt độ chính xác cao nhất và tự động điền vào ô input.
- **Mô phỏng thao tác người dùng**: Có độ trễ ngẫu nhiên (1.5s - 3.5s) kèm hiệu ứng viền xanh trực quan, cuộn mượt (smooth scroll) đến từng câu hỏi.
- **Giao diện HUD nổi**: Theo dõi tiến trình làm bài theo thời gian thực trực tiếp trên trang.

---

```
toolEdux/
├── manifest.json         # File khai báo Manifest V3 (quyền, host_permissions, scripts)
├── popup.html            # Giao diện người dùng khi bấm vào icon extension
├── popup.css             # Định kiểu giao diện popup hiện đại, trực quan
├── popup.js              # Xử lý lưu trữ Gemini API Key và giao tiếp với Content Script
├── content.js            # Script chính tiêm vào trang: bóc tách DOM, gọi Gemini, click đáp án
├── icons/                # Icon cho extension
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── demo_edux_quiz.html   # Trang web mẫu trắc nghiệm EduX để kiểm tra ngay lập tức
└── README.md             # Hướng dẫn chi tiết cài đặt và sử dụng
```

---

## 🚀 Hướng Dẫn Cài Đặt Vào Google Chrome

1. **Mở trình quản lý tiện ích**:
   - Mở Google Chrome và truy cập vào đường dẫn: `chrome://extensions/`
2. **Bật chế độ nhà phát triển (Developer Mode)**:
   - Gạt công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** ở góc trên bên phải sang **Bật**.
3. **Tải tiện ích vào Chrome**:
   - Bấm vào nút **"Tải tiện ích đã giải nén" (Load unpacked)** ở góc trên bên trái.
   - Chọn thư mục dự án: `c:\Users\LucasTUF\.antigravity-ide\toolEdux`.
4. **Ghim tiện ích**:
   - Bấm vào biểu tượng mảnh ghép (Extensions) trên thanh công cụ của Chrome và ghim **EduX AI Solver** để tiện sử dụng.

---

## 🔑 Cách Lấy Google Gemini API Key Miễn Phí

1. Truy cập [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Đăng nhập bằng tài khoản Google.
3. Bấm **"Create API key"** (Tạo khóa API).
4. Sao chép chuỗi khóa (bắt đầu bằng `AIzaSy...`).
5. Bấm vào icon tiện ích **EduX AI Solver** trên Chrome, dán API Key vào ô và bấm **"Lưu API Key"**.

---

## 🧪 Cách Kiểm Tra Nhanh Bằng File Demo

Dự án đã có sẵn file `demo_edux_quiz.html` mô phỏng giao diện đề thi trắc nghiệm:
1. Mở file `demo_edux_quiz.html` bằng trình duyệt Google Chrome (kéo thả file vào Chrome hoặc mở đường dẫn file).
2. Nhấp vào icon **EduX AI Solver** trên thanh công cụ.
3. Bấm nút **"Bắt đầu tự động làm"**.
4. Bạn sẽ thấy:
   - Bảng điều khiển nổi (HUD) xuất hiện ở góc trên bên phải màn hình hiển thị tiến trình theo thời gian thực.
   - Tự động cuộn đến từng câu hỏi.
   - Gửi nội dung câu hỏi + 4 đáp án tới `gemini-1.5-flash`.
   - Giả lập đọc đề với thời gian ngẫu nhiên từ **1.5 đến 3.5 giây**.
   - Tự động click vào đáp án đúng và làm nổi bật bằng viền xanh lá tươi (`border: 2px solid #28a745`).

---

## ⚙️ Hướng Dẫn Tùy Chỉnh CSS Selector Trong `content.js`

Giao diện thực tế của EduX có thể sử dụng tên class khác. Bạn chỉ cần mở file `content.js`, ở đầu file có biến cấu hình `SELECTORS`:

```javascript
const SELECTORS = {
  // 1. Selector của khối bao quanh toàn bộ 1 câu hỏi (gồm cả đề và các đáp án)
  questionItem: '.question-item',

  // 2. Selector của phần chữ nội dung đề bài (nằm trong questionItem)
  questionText: '.question-title, .question-text, .question-content, h3, h4',

  // 3. Selector của từng lựa chọn A, B, C, D (nằm trong questionItem)
  optionItem: '.option-item, .answer-item, .choice-item, label',

  // 4. Thẻ nhãn chữ A, B, C, D (nếu có thẻ riêng)
  optionLabel: '.option-label, .option-key, .choice-key',

  // 5. Thẻ nội dung chữ của đáp án
  optionText: '.option-content, .option-text, .choice-content',

  // 6. Thẻ input chọn (radio/checkbox nếu có)
  optionInput: 'input[type="radio"], input[type="checkbox"]'
};
```

### Cách kiểm tra class trên trang EduX thực tế:
1. Mở trang bài tập EduX trên Chrome.
2. Nhấn phím `F12` (hoặc chuột phải chọn **Kiểm tra / Inspect**).
3. Dùng công cụ chọn phần tử (Ctrl + Shift + C) và nhấp vào một câu hỏi và đáp án để xem tên class thực tế (ví dụ: `.quiz-box`, `.answer-row`, v.v.).
4. Cập nhật lại các thuộc tính tương ứng trong `SELECTORS` ở `content.js`.
5. Vào lại `chrome://extensions/` và bấm nút **Tải lại (Reload)** ở card tiện ích EduX AI Solver.

---

## 🛡️ Lưu Ý Quan Trọng
- Tiện ích này được phát triển phục vụ mục đích nghiên cứu, học tập và hỗ trợ ôn luyện kiến thức.
- Hãy tuân thủ quy chế thi cử và điều khoản dịch vụ của cơ sở giáo dục.
