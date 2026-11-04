# Skit `who_has_it_worse` 9:16 (Victoria) trên RunPod L40S: thời gian và chi phí (2026-11-04)

Run: `runs/20261104T085001Z_8aa08e9fe6f8_skit_who_has_it_worse_916/` (video.mp4 không commit, `.gitignore`). Kết quả: 768×1344, 30,29 s, 24 fps, có audio AAC, 26,5 MB. Khung giây 4 xem bằng mắt: đúng 9:16, áo frock coat đen có băng tang, thánh giá Celtic, hàng rào sắt; chữ trên bia mộ là chữ giả không đọc được (không tránh được).

## Máy
RunPod pod `yfbz73qvc54ket`, L40S 48 GB, 125 GB RAM, US-MO-1, Secure, **$1,09/giờ**. Đã xoá sau khi tải kết quả. RTX 4090, RTX 6000 Ada và A40 hết hàng lúc thuê. Image `nvidia/cuda:12.8.1-devel-ubuntu24.04`, `setup_h3_box.sh`, code rsync từ máy local (không push git).

## Mốc thời gian (UTC)
| Mốc | Giờ | Ghi chú |
|---|---|---|
| Tạo pod | 08:22:24 | |
| Khởi động lại pod | 08:28:37 | khoá SSH của máy này chưa đăng ký ở RunPod, thêm `PUBLIC_KEY` cho riêng pod; cổng SSH đổi 16372 → 18278 |
| Bắt đầu cài | 08:36:31 | SSH vào được sau ~8 phút kể từ khởi động lại |
| Cài xong | 08:40:35 | 244 giây (venv + ComfyUI 170 s, apt 30 s, torch/sage 29 s, model tải nền song song) |
| ComfyUI sẵn sàng | 08:49:51 | 9,3 phút chờ thừa: vòng chờ của mình dùng `pgrep` tự khớp chính lệnh nên không nhận ra script đã xong |
| Bắt đầu sinh | 08:50:00 | |
| Sinh xong | ~09:20:30 | `wall_seconds` 1827,2 (30,5 phút) |
| Xoá pod | ~09:22 | |

## Thời gian từng pha (trung bình mỗi shot, 3 shot × 243 khung, PDD 8 bước)
| Pha | L40S (hôm nay) | RTX 4090 (3/11, cùng skit nhưng 16:9) |
|---|---|---|
| Init DiT | 47,1 s | 37,6 s |
| Encode text | 18,3 s | 15,0 s |
| Sampling 8 bước | 406,3 s (52,9 s/bước) | 276,0 s (35,8 s/bước) |
| Decode video | 133,7 s | 31,0 s |
| Decode audio | 15,3 s | không đo |
| Tổng mỗi shot | 589,7 s | ~340 s |
| Cả skit | **1827 s** | **1055 s** |

L40S chậm hơn 4090 khoảng 1,7 lần (sampling 1,5 lần, decode video 4,3 lần). Khác biệt khổ hình (9:16 và 16:9 cùng số điểm ảnh) không đủ giải thích.

## Chi phí
- Pod sống ~60 phút (08:22:24 → ~09:22:30) × $1,09/giờ ≈ **$1,09**. API billing chưa ghi nhận lúc xoá (trả 0 bản ghi), đây là ước tính theo thời gian.
- Phần sinh video thật: 30,5 phút ≈ $0,55. Phần còn lại ≈ $0,54 là cài đặt, chờ SSH và chờ thừa.
- 4090 thuê (na-01) ~22.500đ/giờ cho lần 3/11, chạy ~17,6 phút ≈ 6.600đ chỉ cho phần sinh.

## Lần sau
- Log lặp lại `cuda_utils.c: fatal error: Python.h` mỗi bước sampling; hai log 4090 có 0 dòng này. Nghi `python3.12-dev` thiếu nên Triton không biên dịch được, Sage attention có thể rơi về attention thường. **Chưa kiểm**, nên chưa kết luận phần chậm do GPU hay do Sage. Thử: `apt install python3.12-dev` trước khi chạy, so lại sampling.
- Đăng ký khoá SSH (`~/.ssh/id_ed25519.pub`) trong RunPod trước, tạo pod với `startSsh` để khỏi khởi động lại.
- Vòng chờ: kiểm file cờ (`/opt/setup_timing.csv` có dòng `TONG`), đừng dùng `pgrep -f` qua ssh.
