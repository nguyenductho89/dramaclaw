# Science humor, bài thử hai nhân vật "gravity" (2026-11-05): kết quả, lỗi, việc dở

Dừng tạm thời sau lượt chạy chain 01. Pod đã xoá, dữ liệu đã về máy. File này là bản ghi để làm tiếp.

## Đã làm

- Đổi format: Barnaby (hiện đại) và Ambrose (cổ điển, lấy cảm hứng Newton) đối thoại, bối cảnh minh hoạ lời nói. Bỏ minh hoạ thí nghiệm, Manim, Three.js, voiceover. Xem `examples/science-humor/series-bible.md`.
- Qwen-Image 2.1 chỉ tạo sheet nhân vật và ảnh nền trống; H3 tự đưa hai người vào cảnh, không ghép trước.
- Hai skill long-form viết lại cho format này và review hai lượt độc lập, rồi sửa. Prompt, kịch bản và chain do `previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py` sinh ra.
- Chạy trên pod RTX 4090 Secure EU-RO-1 (124 GB RAM, $0,89/giờ), từ 13:10 đến khoảng 15:07 UTC, khoảng **$1,75**. Khoảng 51 phút (khoảng $0,75) là chờ vô ích, xem mục lỗi.

## Số đo

| Bước | Thời gian |
|---|---|
| Kiểm mạng pod | 110 MB/s tải HF, tải lên 5 MB mất 12 s |
| Tải code, cài ComfyUI và model | khoảng 3 phút 5 giây |
| Giọng Ambrose + 12 ảnh Qwen (3 ứng viên mỗi ảnh) | 2 phút 13 giây |
| Mỗi shot H3 (192 khung, ref2va turbo 12 bước, 1344×768) | 397-422 s, 30-31,5 s/bước |
| Chain 4 shot (32 s video) | 1600 s (nền làm khung đầu), 1670 s (nền làm tham chiếu) |
| Đỉnh VRAM | 23,7 GB trên 24,5 GB, không OOM |

Dữ liệu thô: `runs/20261105T140843Z_f151cbce5638_science_humor_gravity_test_chain_01` và `runs/20261105T143532Z_f151cbce5638_science_humor_gravity_test_chain_01_refs_only` (video `.mp4` không commit, nằm trên máy), `runs/_box_science_humor_gravity`, `gravity_test/check_report.json`. Bản xem nhanh: `runs/gravity_chain_01_preview.mp4`, `runs/gravity_chain_01_refs_only_preview.mp4`.

## Kết quả

| | Nền làm khung đầu (`chain_NN.json`) | Nền làm ảnh tham chiếu (`chain_NN_refs_only.json`) |
|---|---|---|
| Danh tính (SFace với sheet) | Barnaby 0,58-0,73, Ambrose 0,71-0,81, không tráo | Barnaby 0,60-0,77, Ambrose 0,64-0,79, không tráo |
| Nền xuyên 4 shot | Đổi vườn ở shot 4, khung chồng hình ở đầu shot 4 | Giữ nguyên một vườn |
| Sheet lọt vào khung hình | **Có**, shot 3 từ giây 5,5: nền xám, hai Ambrose, Barnaby biến mất | Không |
| Hai người đi vào khung (shot 1) | Có, đúng ý | Không, đứng sẵn |
| Giọng khác nhau (Resemblyzer, cùng người / khác người) | 0,90 / 0,88 | 0,91 / 0,91 |

**Kết luận:** dùng nền làm ảnh tham chiếu. Số `<Picture N>` đúng ở cả hai: không bị tráo hai người khi có `start_image`.

Lời thoại (Whisper base.en, chỉ để so sánh, có thể nghe sai):
- Shot 4 sạch (khớp 0,92-0,96). Shot 1-3 có tiếng lầm bầm trước hoặc sau câu thoại, khớp 0,56-0,69.
- Ở bản tham chiếu, đuôi của shot 1 và 2 bắt đầu bằng "Exactly ..." ("Exactly as Wossie's the aepus...", "Exactly read of these courses..."). **Nghi H3 đọc to câu lip-close chính thức** ("Exactly as the voice stops..."). Chưa kiểm chứng bằng cách bỏ câu đó.
- Câu thoại kết thúc muộn hơn mốc 6,3 s trong prompt: H3 đọc khoảng 12 âm tiết trong khoảng 5,5 s, không nhanh như bài thử ep01.

Hình ảnh (xem bằng mắt qua contact sheet): bố cục, ánh sáng, cử chỉ và tư thế nối giữa các shot đúng kịch bản ở bản tham chiếu. Chất lượng điện ảnh tốt hơn bài thử trước (đã dùng ảnh nền Qwen, không ghép).

## Lỗi đã gặp và cách tránh

| Lỗi | Hậu quả | Cách tránh |
|---|---|---|
| zsh không tách `$VAR` thành nhiều từ (`$SSH`, `$SSHO`, `$P`) và báo lỗi khi glob không khớp (`rm -f x_*.png`) | Vòng chờ pod lỗi từ lần đầu nhưng vẫn lặp 90 lần: pod chờ khoảng 22 phút, mất khoảng $0,35. Lệnh `git add $P` lỗi pathspec | Lệnh có biến chứa nhiều đối số: chạy trong `bash -c` hoặc file `.sh`, hoặc dùng mảng. Chạy lệnh dò **một lần** ngoài vòng lặp rồi mới lặp; vòng lặp phải dừng khi lệnh dò lỗi (mã thoát ≠ 0), không dò tiếp im lặng |
| Khoá SSH của máy này (`~/.ssh/id_ed25519`) không có trong khoá tài khoản RunPod; `startSsh` chỉ chèn khoá tài khoản | "Permission denied", vòng chờ SSH trong `pod_up.sh` chạy tới 15 phút. Mất khoảng 27 phút (khoảng $0,4) | Trước khi tạo pod so `~/.ssh/*.pub` với `get-ssh-keys`. Hoặc truyền `env.PUBLIC_KEY` lúc tạo pod. Thử `ssh` một lần ngay khi có cổng. `update-pod` thay **toàn bộ** `env`, cần `restart` mới có hiệu lực |
| Sau `restart`, cổng SSH công khai đổi (16189 thành 15691) | 24 lần thử vào cổng cũ đều "Connection refused" | Đọc lại `get-pod` sau mỗi lần restart |
| `get-pod` trả `runtime: null` khoảng 90 giây đầu | Chưa có cổng SSH | Chờ nền (`run_in_background` với `sleep`), rồi gọi lại |
| `rsync` kéo cả thư mục từ pod về đè file cục bộ | Mất 11 dòng của `runs/index.csv`; bản `check_chains.py` cũ (còn lỗi) đè bản đã sửa chưa commit | Kéo riêng thư mục run mới, không kéo `scripts/` và `index.csv` về. Commit sửa chữa trước khi kéo. Nếu đã đè: `git checkout` rồi nối các dòng mới |
| `check_chains.py` gọi nhầm tên biến (`refs` thay `sheets`) | Chấm lần đầu lỗi sau khi chờ model tải | Chạy thử script chấm trên mẫu nhỏ trước khi cần dùng |
| `ffprobe` không nhận nhiều file đầu vào | Lệnh cắt ảnh báo lỗi (ảnh vẫn cắt xong) | Một file mỗi lần gọi |
| `sleep` đứng riêng bị chặn khi chạy foreground | Không chờ được | Chạy nền (`run_in_background`) rồi chờ thông báo |
| Hết 5090 Secure ("no longer any instances") | Không mở được pod 5090 | Thử lại bằng 4090 Secure cùng yêu cầu RAM, giá $0,89/giờ |
| Tool RunPod: `pod-action` cần `body`, `get-pod` dùng `id` không phải `podId` | Gọi lỗi lần đầu | Đọc `describe-tool` trước |

Lỗi của prompt và hình đã tìm ra:
- Sheet hai góc nhìn trên nền xám, dùng làm ảnh tham chiếu cùng lúc nền làm khung đầu: H3 vẽ lại chính sheet trong khung hình. Cách đúng: nền là ảnh tham chiếu. Chưa thử: cắt mỗi sheet thành một góc (`character/*_front.png`, `chain_NN_single.json`).
- Khi nền chỉ là `start_image` của shot 1, các shot 2-4 không còn ảnh nền: cảnh đổi sang vườn khác.
- Hai giọng cùng mô tả "giọng Anh" nghe như một: cosine giữa các shot cùng người nói 0,90, khác người 0,88.
- Skill review đã bỏ sót số khung sai lưới 17k+5 và shot thoại dưới 192 khung; đã thêm.
- Lệnh `git commit` không có pathspec kèm theo mọi file đã stage (bài thử ep01): dùng `git commit -- <paths>` và kiểm `git show --stat`.

## Việc còn dở

1. **Giọng (ưu tiên cao):** Barnaby giọng Mỹ, Ambrose giọng Anh (chốt theo bạn, 2026-11-05). Cấu hình đã sẵn: `voice/barnaby_us_config.json` (3 ứng viên Mỹ), `voice/ambrose_candidates.json` (3 ứng viên Anh: trầm sâu, khàn, cao the thé). Chạy `gravity_test/run_batch.sh voices` trên GPU, kéo ứng viên về, chọn cặp có cosine thấp nhất, bạn nghe thật rồi chép vào `voice/barnaby.wav`, `voice/ambrose.wav`. Mục tiêu: cosine khác người nói thấp hơn cùng người ít nhất 0,1 (hiện cách nhau 0,00-0,02). Prompt và lời của Barnaby đã đổi sang giọng Mỹ, các chain chưa chạy lại với giọng mới.
2. **Câu lip-close:** thử một shot không có câu "Exactly as the voice stops...", so sánh đuôi shot để biết H3 có đọc to không.
3. **Chạy chain 02 (Mặt Trăng)** bằng bản nền làm tham chiếu. Chưa thấy ảnh Mặt Trăng trong video: rủi ro chân trời và vị trí Trái Đất.
4. **Thử bản `single`** (sheet cắt một góc, nền làm khung đầu) nếu cần cảnh có người đi vào khung.
5. **Bạn chấm:** khớp môi, độ hài, giọng, cảnh cắt giữa hai bối cảnh. Chưa có người nghe tiếng và chưa có người bản ngữ đọc lời.
6. **Chưa thử:** nâng lên 1080p cho định dạng này (Lanczos hoặc SeedVR2), âm lượng giữa các chain.
7. **Giấy phép trước khi đăng:** H3 loại trừ EU, Anh, Hàn Quốc, Mỹ và pod chạy ở EU-RO-1; Qwen-Image 2.1 chỉ cho nghiên cứu, phải đổi model ảnh trước khi kiếm tiền (Qwen 3.0 API đang bị `Arrearage`). Xem `examples/science-humor/risks.md`.
8. **Chưa kiểm:** tên Ambrose Whitlock và tên kênh trùng hay không; 35% cuối trang nguồn S2; "to Einstein, gravity isn't a pull" là cách nói gọn.
