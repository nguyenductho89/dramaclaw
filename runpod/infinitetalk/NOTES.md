# InfiniteTalk trên RunPod: ghi chú dựng pod thử (2026-11-02, chưa commit, tạm thời)

Mục đích: ảnh Phật tổ + giọng đọc (VieNeu) -> video nói. Đây là bản ghi để dựng lại pod nhanh và làm khuôn cho
Dockerfile/serverless sau này. Trạng thái: pod test chạy được tới bước ComfyUI; kết quả video xem cuối file.

## Pod đã dùng
- GPU: A100 80GB SXM, US-MD-1, Secure, $1,79/giờ. RTX 6000 Ada (US-WA-1) và A100 PCIe (EU-RO-1) hết máy lúc tạo.
- Image: `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404`, disk 120 GB, port `8188/http`.
- Mount global volume `/runpod-volume` có tác dụng gì không: KHÔNG dùng để ghi mô hình (xem bẫy 1).
- Truy cập: `https://<podId>-8188.proxy.runpod.net`. Proxy trả 403 với User-Agent mặc định của Python,
  phải gửi `User-Agent: curl/8.7.1`.

## Bẫy đã gặp (đúng thứ tự)
1. Ghi 16 luồng song song vào global volume: aria2 báo 0 B sau >2 phút. Tải vào ổ container: 17 GB trong 60 giây.
2. `transformers` mới nhất: `MultiTalkWav2VecEmbeds` lỗi `'NoneType' object is not subscriptable` (hidden_states None).
3. Chỉ ghim `transformers==4.51.3`: kéo `huggingface_hub` cũ, `diffusers` mới lỗi `cannot import name 'resolve_revision'`,
   cả pack WanVideoWrapper IMPORT FAILED -> `WanVideoVAELoader not found`. Phải ghim đồng bộ cả ba (xem boot_pod.sh).
4. Workflow mẫu của kijai dùng GGUF Q8, bản này dùng `Wan2_1-I2V-14B-480P_fp8_e4m3fn` + `attention_mode=sdpa`
   (chưa cài sageattention); bỏ nhóm MelBandRoFormer (tách giọng) và TorchCompile.

## Thời gian đo được
- Cài ComfyUI + node + pip: ~1,5-3 phút. Tải 36 GB mô hình: ~2,5 phút (hf_transfer, ~280 MB/s). Khởi động ComfyUI: ~15 giây.
- Restart pod = ổ container bị xóa, phải cài lại từ đầu.

## Công cụ trong tools/
- `ui2api.py`: đổi workflow UI-format (có SetNode/GetNode/Reroute) sang API-format theo object_info của pod.
- `run_it.py`: upload ảnh/âm thanh, đặt tham số, gửi /prompt, chờ, tải mp4. Sửa `BASE` cho đúng pod.
- `wf03.json`: workflow mẫu `wanvideo_2_1_14B_I2V_InfiniteTalk_example_03`; `api_raw.json`: bản API đã chuyển.

## Kết quả chạy thử (2026-11-02)
- Chạy thành công: ảnh `buddha_3.png` + 8 giây giọng (VieNeu, Thiền Tâm Đức) -> 200 khung, 480x832, 25 fps, có âm thanh.
- Thời gian `/prompt` -> xong: **345 giây** trên A100 SXM (đã ấm: mô hình nạp ~13 giây, lấy mẫu 3 cửa sổ x 81 khung, 6 bước).
  Quy đổi thô: ~43 giây GPU cho mỗi giây video (chưa tính nạp mô hình lần đầu). 30 phút video ~ 21 giờ GPU ~ $38 trên A100.
- Chất lượng: danh tính, trang phục, nền giữ ổn; miệng cử động theo giọng (kiểm tay 3 khung). Chưa kiểm khớp khẩu hình chi tiết.
- Dấu sao Gemini vẫn nằm ở góc dưới phải (từ ảnh gốc), cần cắt/che khi dựng.
- Pod `zz2ez2la01xw7p` đã xóa sau khi tải video về; tổng thời gian sống ~30 phút (~$0,9).

## Việc còn lại (khi làm serverless)
Dockerfile `runpod/infinitetalk/` (khuôn: `runpod/h3`), thêm lựa chọn vào `.github/workflows/build-runpod-worker-image.yml`,
cần secret `GHCR_PAT`; mô hình để ngoài image (volume hoặc tải khi khởi động).

## Giọng đọc (2026-11-02)
Đã chốt giọng Thiền Tâm Đức + vang vừa, công thức ở `voice/README.md`. Lip-sync chạy trên giọng sạch, trộn mõ/chuông sau.
