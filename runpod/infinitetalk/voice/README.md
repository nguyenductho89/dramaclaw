# Giọng đọc Chú Đại Bi (VieNeu-TTS v3 Turbo, có vang)

Giọng đã chốt (2026-11-02): **Thiền Tâm Đức**, chậm 25%, ngữ điệu giữ nguyên, **vang vừa**. Audio dùng để lip-sync
phải là giọng SẠCH này; mõ/chuông trộn bằng ffmpeg SAU khi có video (tiếng gõ làm nhiễu mô hình âm thanh của InfiniteTalk).

## Lệnh tạo lại (3 phút 37 giây, 217 giây tổng hợp CPU)
```bash
uv venv --python 3.12 venv
uv pip install --python venv/bin/python vieneu pedalboard soundfile numpy pyworld "setuptools<81"
# chép model từ cache HF ra thư mục thật (onnxruntime không đọc symlink):
#   real/model  <- models--pnnbao-ump--VieNeu-TTS-v3-Turbo/snapshots/*/   (dùng thư mục con onnx_update, xem vn_load.py)
#   real/codec  <- models--OpenMOSS-Team--MOSS-Audio-Tokenizer-Nano-ONNX/snapshots/*/
venv/bin/python chant.py dai_bi.txt dai_bi_v1.wav --alpha 1 --semi 0 --stretch 0.8 --temp 0.7 --pause 0.7 --wet 0.3 --room 0.6
```

## Tham số đã chốt
| Tham số | Giá trị | Ý nghĩa |
|---|---|---|
| voice | Thiền Tâm Đức | giọng nam preset |
| stretch | 0.8 | chậm 25%, giữ formant |
| alpha | 1 | giữ nguyên ngữ điệu (0 = đơn âm) |
| semi | 0 | không hạ cao độ |
| temp | 0.7 | nhiệt độ lấy mẫu |
| pause | 0.7 s | nghỉ giữa các dòng |
| wet / room | 0.3 / 0.6 | độ vang / cỡ phòng |

Đã thử và không chọn: `--alpha 0.25 --semi -1.5 --stretch 0.75` (tụng vừa), `--alpha 0.1 --semi -2 --stretch 0.7`
(tụng mạnh), vang nhiều `--wet 0.45 --room 0.8`.

## Bẫy
- `pyworld` cần `pkg_resources`: ghim `setuptools<81`.
- `vn_load.py` trỏ codec sang thư mục thật vì onnxruntime từ chối dữ liệu ngoài là symlink của cache HF.
- File mp3 không lưu trong repo (tái tạo bằng lệnh trên); dùng lặp ~8 lần để đủ 30 phút thì lip-sync một lượt rồi lặp video, chuyển mờ ở chỗ nối.
