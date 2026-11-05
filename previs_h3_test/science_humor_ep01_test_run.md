# Science humor ep01: bài thử 60 giây (2026-11-05)

Video thử: `runs/_science_humor_ep01_assembled/ep01_test_lanczos.mp4`, 1920×1080, 1:42 (4 chain H3, 1 đoạn Manim, 1 đoạn Three.js). Số liệu thô: các thư mục `runs/*science_humor_ep01_*` và `runs/_box_science_humor_ep01/`.

## Máy và chi phí

| Pod | Giờ UTC | Giá | Tiền (ước theo thời gian) | Ghi chú |
|---|---|---|---|---|
| `huwnhh8yj688yz`, 5090 community, 62 GB RAM | 08:06-08:52 | $0,69/giờ | $0,53 | Mạng rất chậm: tải lên 29 KB/s, `git clone` hơn 12 phút chưa xong. Không tạo được gì |
| `tynnxv04fxmedi`, 5090 Secure, EU-RO-1 | 08:55-khoảng 10:05 | $1,19/giờ | $1,4 | Tải model 117 MB/s |

Tổng khoảng $1,9. API billing chưa đối chiếu. Máy thật báo 123 GB RAM, dù API ghi 60 GB.

## Thời gian trên pod thứ hai

| Bước | Thời gian |
|---|---|
| Tải code 38 MB lên | khoảng 1 phút |
| Cài đặt và tải model | khoảng 3 phút |
| Thiết kế giọng + 2 đoạn voiceover | 1,5 phút |
| Mỗi ảnh chân dung (25 bước) | 3,4 giây sau lần nạp đầu |
| Mỗi keyframe ở resolution 1536 (40 bước) | 24 giây |
| Mỗi chain H3 (2 shot × 192 khung, turbo 12) | 537-541 giây, tức khoảng 33,7 giây tính cho mỗi giây video |
| Pha trung bình mỗi shot | encode 5 s, init 18 s, sampling 240 s (20,2 s/bước), decode video 16 s |
| SeedVR2 7B 1,5x (383 khung) | 554 s, 1,4 s/khung |

Đỉnh VRAM 31,9/32,6 GB, không OOM. RAM ComfyUI đỉnh khoảng 53 GB.

Cả tập cần khoảng 260 s video H3: 2,4 giờ một lượt, tức $1,7 ở $0,69/giờ hoặc $2,9 ở $1,19/giờ, chưa tính sinh lại.

## Lỗi keyframe: vệt loang và viền sáng

**Nguyên nhân:** chạy đường edit của Qwen-Image 2.1 ở khoảng 1 megapixel (`resolution` 0 hoặc 1024). Lỗi này chỉ thấy ở đường edit; ảnh t2i cùng cỡ vẫn sạch.

| Thử | Kết quả | Thư mục trong `ep01/keyframes/` |
|---|---|---|
| 25, 40, 60 bước | Không đổi | `artifact_test` |
| Bỏ `QwenImage21Cache` | Không đổi | `artifact_test` |
| Tắt Sage attention | Không đổi | `artifact_test_nosage` |
| Model bf16 thay int8 | Không đổi | `artifact_test_bf16` |
| Prompt ngắn | Bố cục tốt hơn, vẫn lỗi | `artifact_test` |
| Sampler dpmpp_2m + beta; shift 1 và 5 | Nhiễu nặng hơn | `artifact_test_round2` |
| cfg 2 và 3 + negative prompt | Nền đỡ hơn, mặt và áo bị gắt | `artifact_test_round2` |
| **`resolution` 1536 và 2048** | **Sạch** | `artifact_test_round2` |

**Đã sửa:** `qwen21_character_local.py` chạy edit ở 1536 rồi thu về 1344×768, kèm prompt ngắn. Độ giống mặt so với ảnh chân dung: 0,73-0,89. 4 chain đã sinh vẫn dùng keyframe cũ, lưu ở `keyframes/v1_about_1mp`.

**Còn lại:** đĩa bánh nằm giữa khung, trong khi chain ghi "left third"; căn bếp khác nhau giữa các keyframe.

## Sáu cổng

| Cổng | Kết quả | Căn cứ |
|---|---|---|
| 1. Mặt ổn định | Đạt | SFace 0,59-0,84 trên 16 khung so với chân dung (ngưỡng 0,363) và xem 8 khung. Chỉ đo độ giống, không phân biệt được chi tiết |
| 2. Khớp môi | Chưa chấm | Chưa xem liền mạch |
| 2b. Lời thoại | **Có lỗi** | Xem dưới |
| 3. Giọng voiceover và H3 | Đạt sơ bộ | Cosine Resemblyzer 0,87-0,92. Chưa có người nghe |
| 4. 1080p | Cần xem toàn màn hình | SeedVR2 và Lanczos gần như giống nhau trên một khung, nên chưa thấy lý do trả thêm SeedVR2 |
| 5. Hài | Chưa chấm | Cần người xem |
| 6. Cắt giữa các lớp | Chưa chấm | Chưa xem liền mạch; `manim` và H3 chênh âm lượng khoảng 3 dB |

## Lỗi lời thoại

H3 tự nói thêm trong đoạn cuối shot, nơi kịch bản không có lời. Chain 02 có tiếng ở cả hai đoạn cuối, chain 03 và chain 01 ở đoạn cuối của shot 2, chain 04 không có. Whisper nghe được các cụm vô nghĩa như "I could detonate Matt"; có thể nó nghe sai, nên chỉ tin rằng có tiếng nói (mức -24 đến -28 dB, so với khoảng -66 dB ở đoạn im lặng).

Khả năng cao do shot 8 s có lời ngắn, để trống 1,5-3 s. Chưa thử cách sửa. Hướng đầu tiên: ghi rõ ông im lặng và ngậm miệng sau khi nói xong.

Các lỗi nhỏ khác: nhẫn và đồng hồ tự xuất hiện trên tay; viền sắc quanh tóc.
