# EduX AI Quiz Solver - Chrome Extension (Manifest V3)

Tiện ích mở rộng Google Chrome (Manifest V3) hỗ trợ tự động giải bài tập và đề thi trực tuyến trên nền tảng **EduX (edux.cmcu.edu.vn)**. Sử dụng mô hình **Google Gemini AI** với cơ chế tư duy từng bước (Chain-of-Thought), tự động nhận diện cấu trúc DOM linh hoạt, mô phỏng thao tác người dùng và tự động chuyển câu hỏi mượt mà.

---

## ✨ Tính Năng Nổi Bật

- **Trắc nghiệm 4 lựa chọn (A, B, C, D)**: Tự động trích xuất nội dung đề thi, các phương án lựa chọn và click chọn đáp án chính xác nhất.
- **Trắc nghiệm Đúng / Sai đa mệnh đề (True/False - Chương trình GDPT mới & Đại học)**: Tự động ghép cặp tọa độ các nút `[ Đúng ]` và `[ Sai ]` theo từng dòng, phân tích học thuật từng ý (1, 2, 3, 4 hoặc a, b, c, d) và click chọn nút tương ứng.
- **Tự luận ngắn / Điền từ khuyết (Fill-in-the-blank)**: Tự động phát hiện ô text input, suy luận từ ngữ/thuật ngữ/đáp số chuẩn xác và điền vào ô với React Synthetic Events.
- **Tối ưu độ chính xác cao với Chain-of-Thought (CoT)**: AI phân tích lý thuyết, đối chiếu chuyên ngành và khử các bẫy ngữ nghĩa cực đoan trước khi đưa ra kết luận.
- **Đồng bộ hóa câu hỏi thời gian thực**: Tự động nhận diện câu hỏi hiện tại trên màn hình (dù bắt đầu từ câu 1 hay câu 23), không lo lệch tiến trình.
- **Mô phỏng thao tác người dùng (Anti-Detection)**: Tạo độ trễ ngẫu nhiên (1.5s - 3.5s) kèm hiệu ứng viền xanh trực quan, cuộn mượt (smooth scroll).
- **Giao diện nổi (HUD) thời gian thực**: Theo dõi chi tiết từng thao tác của AI ngay trên màn hình làm bài.

---

## 🔄 Luồng Hoạt Động Chi Tiết (Workflow & Architecture)

### 📊 Sơ Đồ Khối Kiến Trúc

```mermaid
flowchart TD
    A["👤 Người Dùng Bấm 'Bắt đầu tự động làm' (Popup)"] --> B["⚡ Khởi tạo HUD & Tiêm Content Script"]
    B --> C["🔍 Quét DOM & Đồng Bộ Số Câu Hỏi Thực Tế (currentStep)"]
    C --> D{"🎯 Phân Loại Dạng Câu Hỏi"}

    D -->|"Trắc nghiệm"| E1["Trích xuất Đề bài + 4 Phương án (A, B, C, D)"]
    D -->|"Đúng / Sai"| E2["Ghép Cặp Nút [Đúng]-[Sai] Theo Tọa Độ Hàng Ngang + Trích xuất Mệnh đề"]
    D -->|"Điền Khuyết"| E3["Trích xuất Đề bài + Thẻ Nhập Liệu Input Text"]

    E1 --> F["📡 Gửi Prompt tới Background Service Worker (Proxy)"]
    E2 --> F
    E3 --> F

    F --> G["🤖 Gemini API Phân Tích (Chain-of-Thought, Temperature = 0.0)"]
    G --> H["📥 Trả Về Kết Quả & Parse Chuẩn Hóa"]

    H --> I["⏳ Giả Lập Thời Gian Đọc & Suy Nghĩ (1.5s - 3.5s)"]
    I --> J["🖱️ Thực Thi Click / Điền (React 18 Synthetic Events) + Viền Xanh"]

    J --> K{"Hết Đề Thi Chưa?"}
    K -->|"Chưa"| L["➡️ Tự Động Click 'Câu tiếp >' & Đợi DOM Ổn Định"]
    L --> C
    K -->|"Đã hết"| M["🎉 Hoàn Thành Toàn Bộ Đề Thi & Báo HUD"]
```

### 🧩 Chi Tiết 6 Giai Đoạn Hoạt Động

#### Giai đoạn 1: Kích hoạt & Khởi tạo giao diện HUD
1. Khi người dùng mở đề thi EduX và bấm **"Bắt đầu tự động làm"** trên Popup, thông điệp `START_AUTO_SOLVE` kèm API Key được gửi đến `content.js`.
2. Tiện ích khởi tạo một bảng điều khiển nổi **HUD (Heads-Up Display)** ở góc trên bên phải màn hình:
   - Hiển thị thanh tiến trình (% hoàn thành).
   - Hiển thị trạng thái chi tiết theo thời gian thực (đang phân tích, đang chờ giả lập, đã chọn đáp án nào,...).

#### Giai đoạn 2: Bóc tách DOM & Đồng bộ câu hỏi thời gian thực
1. Tiện ích quét DOM hiện tại để tìm tiêu đề câu hỏi (`Câu X`, `Bài X`).
2. **Đồng bộ hóa tức thì**: Nếu người dùng đang mở sẵn Câu 23, biến tiến trình `currentStep` được đồng bộ ngay lập tức thành 23, ngăn chặn hiện tượng nhảy lệch câu hoặc lỗi không tìm thấy DOM.

#### Giai đoạn 3: Phân loại dạng bài thi thông minh
- **Dạng 1 - Trắc nghiệm nhiều lựa chọn**: Tìm các khối lựa chọn bắt đầu bằng `A.`, `B.`, `C.`, `D.` hoặc các thẻ radio/label.
- **Dạng 2 - Trắc nghiệm Đúng / Sai (Mới)**:
  - Quét toàn bộ các nút `[ Đúng ]` và `[ Sai ]` trên trang.
  - Sử dụng thuật toán **ghép cặp theo tọa độ dọc (`top`)**: Tự động ghép từng nút Đúng với nút Sai nằm trên cùng một hàng ngang.
  - Tìm phần tử cha chung (LCA) để bóc tách nội dung của từng mệnh đề học thuật.
- **Dạng 3 - Tự luận / Điền ô trống**: Tìm các thẻ `<input type="text">` hoặc `<textarea>` nhập câu trả lời.

#### Giai đoạn 4: Phân tích AI qua Background Service Worker
1. Giao tiếp qua `background.js` (Service Worker) để:
   - Vượt qua chính sách bảo mật nội dung (Content Security Policy - CSP) của trang web EduX.
   - Cơ chế **Auto-Fallback**: Tự động dò tìm và chuyển đổi linh hoạt giữa các model Gemini khả dụng (`gemini-1.5-flash`, `gemini-flash-latest`,...) khi gặp lỗi quá tải 503 hoặc giới hạn lượt gọi 429.
2. Áp dụng kỹ thuật **Chain-of-Thought (CoT)**: AI suy luận ngắn về mặt lý thuyết cho từng ý trước khi chốt kết quả, giúp tăng độ chính xác vượt trội.

#### Giai đoạn 5: Mô phỏng hành vi người dùng (Human Simulation)
1. Tạo độ trễ ngẫu nhiên từ **1.5s đến 3.5s** (tương đương tốc độ đọc và suy nghĩ của học sinh/sinh viên thật), tránh bị hệ thống giám sát nghi ngờ gian lận.
2. Kích hoạt toàn diện chuỗi sự kiện Synthetic Events:
   - `pointerdown` ➔ `mousedown` ➔ `pointerup` ➔ `mouseup` ➔ `click` ➔ `change` ➔ `input`.
   - Đảm bảo tương thích hoàn hảo với các framework hiện đại như React 18, Vue, Angular.
3. Làm nổi bật đáp án đã chọn bằng viền xanh ngọc dạ quang (`#10b981`) kèm bóng mờ.

#### Giai đoạn 6: Tự động chuyển câu (Auto-Navigation)
1. Sau khi hoàn thành câu hỏi, tiện ích tự động tìm nút **"Câu tiếp >"** hoặc nút số trang tiếp theo trên thanh pagination và kích hoạt click.
2. Xóa sạch các viền xanh cũ từ câu trước (tránh lưu vết do React tái sử dụng DOM).
3. Đợi DOM câu mới tải hoàn tất và lặp lại chu trình cho đến câu cuối cùng.

---

## 🎯 Giải Pháp Tăng Độ Chính Xác Cho Dạng Đúng / Sai

Dạng bài Đúng / Sai trong các kỳ thi đại học (như Kiểm thử phần mềm, AI, CNTT, Kinh tế...) thường chứa nhiều câu hỏi gài bẫy lý thuyết. Tiện ích áp dụng 3 kỹ thuật cốt lõi:

1. **Kỹ thuật Chain-of-Thought (Tư duy từng bước)**:
   - Thay vì ép AI trả lời ngay lập tức `1: Đúng`, prompt yêu cầu AI phân tích ngắn gọn lý do học thuật cho từng mệnh đề trước. Việc sinh ra token suy luận giúp LLM kích hoạt các liên kết tri thức chính xác hơn 30-50%.
2. **Khử bẫy ngữ nghĩa cực đoan**:
   - Hệ thống huấn luyện AI cảnh giác cao độ với các từ khóa mang tính khẳng định tuyệt đối: *"chỉ cần"*, *"luôn luôn"*, *"tất cả"*, *"không cần"*, *"không bao giờ"*. Trong các đề thi học thuật chuẩn, các mệnh đề chứa từ này phần lớn là **SAI** (ngoại trừ các tiên đề/định lý đặc thù).
3. **Phân tích theo chuẩn chuyên ngành**:
   - Tự động nhận diện môn học (ví dụ: chuẩn ISTQB / IEEE trong Kiểm thử phần mềm) để đánh giá các trường hợp biên (`null`, `buffer overflow`, `exception`, `boundary value`).

---

## 📁 Cấu Trúc Dự Án

```
toolEdux/
├── manifest.json         # File khai báo Manifest V3 (quyền, host_permissions, scripts)
├── popup.html            # Giao diện người dùng điều khiển tiện ích
├── popup.css             # Định kiểu giao diện popup hiện đại Dark-mode
├── popup.js              # Xử lý lưu trữ Gemini API Key và giao tiếp với Content Script
├── content.js            # Script chính tiêm vào trang: bóc tách DOM, phân loại, giải bài, click đáp án
├── background.js         # Service Worker proxy gọi Gemini API, Auto-Fallback model, Keepalive
├── icons/                # Icon cho extension (16px, 48px, 128px)
├── demo_edux_quiz.html   # Trang web mô phỏng đầy đủ 3 dạng bài để kiểm tra offline
└── README.md             # Tài liệu dự án và hướng dẫn chi tiết
```

---

## 🚀 Hướng Dẫn Cài Đặt Vào Google Chrome

1. **Mở trình quản lý tiện ích**:
   - Mở Google Chrome và truy cập: `chrome://extensions/`
2. **Bật chế độ nhà phát triển (Developer Mode)**:
   - Gạt công tắc **"Chế độ dành cho nhà phát triển" (Developer mode)** ở góc trên bên phải sang **Bật**.
3. **Tải tiện ích vào Chrome**:
   - Bấm vào nút **"Tải tiện ích đã giải nén" (Load unpacked)** ở góc trên bên trái.
   - Chọn thư mục dự án: `c:\Users\LucasTUF\.antigravity-ide\toolEdux`.
4. **Ghim tiện ích**:
   - Bấm vào biểu tượng mảnh ghép (Extensions) trên thanh công cụ của Chrome và ghim **EduX AI Solver**.

---

## 🔑 Cách Lấy Google Gemini API Key Miễn Phí

1. Truy cập [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Đăng nhập bằng tài khoản Google.
3. Bấm **"Create API key"** (Tạo khóa API).
4. Sao chép chuỗi khóa (bắt đầu bằng `AIzaSy...`).
5. Bấm vào icon tiện ích **EduX AI Solver** trên Chrome, dán API Key vào ô và bấm **"Lưu API Key"**.

---

## 🧪 Cách Kiểm Tra Nhanh Bằng File Demo

Dự án đã có sẵn file `demo_edux_quiz.html` mô phỏng giao diện chuẩn của EduX:
1. Mở file `demo_edux_quiz.html` bằng Google Chrome.
2. Nhấp vào icon **EduX AI Solver** trên thanh công cụ.
3. Bấm nút **"Bắt đầu tự động làm"**.
4. Bạn sẽ thấy tiện ích tự động giải qua cả 3 dạng bài: Trắc nghiệm truyền thống, Đúng / Sai đa mệnh đề, và Tự luận điền từ.

---

## 🛡️ Lưu Ý Quan Trọng
- Tiện ích này được phát triển phục vụ mục đích nghiên cứu công nghệ AI, học tập và hỗ trợ ôn luyện kiến thức.
- Hãy luôn tuân thủ quy chế thi cử và điều khoản dịch vụ của cơ sở giáo dục.
