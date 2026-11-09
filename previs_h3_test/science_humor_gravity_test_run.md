# Science humor, bài thử hai nhân vật "gravity" (2026-11-05 → 2026-11-06): kết quả, lỗi, việc dở

Lượt chạy chain 01 đầu tiên (2026-11-05) dừng tạm thời; lượt tiếp theo (2026-11-06) đã làm xong giọng mới, câu lip-close, chain 02 (Mặt Trăng) và bản `_single` — xem mục "Giọng mới + chain 02 + lip-close + bản single (2026-11-06)" bên dưới. Pod cả hai lượt đều đã xoá, dữ liệu đã về máy. File này là bản ghi để làm tiếp.

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

## Giọng mới + chain 02 + lip-close + bản single (2026-11-06)

Pod RTX 4090 Secure (EUR-IS-2, 200 GB disk, 100 GB RAM cgroup dù host có 503 GB — xem mục lỗi), từ 03:25 đến khoảng 05:45 UTC (~2h20, **≈ $2,07**). Làm đúng 4 việc còn dở ưu tiên cao nhất trong danh sách cũ: chọn giọng mới, test câu lip-close, chain 02 (Mặt Trăng), bản `_single`.

### Số đo

| Bước | Thời gian |
|---|---|
| Cài ComfyUI + tải model (ref2va + fl2va + Qwen, ~85 GB) | 384 s (6 phút 24 giây); mỗi file tải 161-238 MB/s, không file nào chậm bất thường |
| Sinh 6 ứng viên giọng (Qwen3-TTS VoiceDesign, 3 Mỹ cho Barnaby + 3 Anh cho Ambrose) | model nạp 14 s; mỗi ứng viên 29-39 s audio-gen cho 12-16 s audio |
| Chấm + chọn cặp giọng (Resemblyzer, 9 cặp) | vài giây (CPU) |
| Shot lip-close test (1 shot, 192 khung) | 440,7 s |
| Chain 01 refs_only lại (4 shot, giọng mới) | 1761,4 s (~29 phút 21 giây), ~440s/shot |
| Chain 02 refs_only (Mặt Trăng, 4 shot) | ~1779 s (~29 phút 39 giây) |
| Chain `_single` (sheet 1 góc, nền = khung đầu, 4 shot) | ~1659 s (~27 phút 39 giây) |

Dữ liệu thô: `runs/20261106T034239Z_a0722bf62ac3_science_humor_gravity_test_chain_01_refs_only_nolip`, `runs/20261106T035010Z_a0722bf62ac3_science_humor_gravity_test_chain_01_refs_only`, `runs/20261106T041954Z_a0722bf62ac3_science_humor_gravity_test_chain_02_refs_only`, `runs/20261106T044933Z_a0722bf62ac3_science_humor_gravity_test_chain_01_single` (video `.mp4` không commit). Script chọn giọng mới: `gravity_test/pick_voices.py`. Chain lip-close test: `gravity_test/chain_01_refs_only_nolip.json` (shot 1 của chain_01_refs_only, bỏ đúng câu "Exactly as the voice stops, the lips close and the jaw ceases all speaking motion. This single line is the only speech in the video.").

### Giọng mới

Chọn tự động bằng cross-cosine Resemblyzer thấp nhất trong 9 cặp (3 ứng viên Mỹ × 3 ứng viên Anh), không nghe bằng tai (theo yêu cầu "tự động làm hết"):

| | deepbass | gravelly | fussy |
|---|---|---|---|
| us_bright | 0,702 | 0,732 | 0,839 |
| us_raspy | 0,717 | 0,728 | 0,82 |
| us_warm | 0,711 | 0,775 | **0,662** |

Chọn: **Barnaby = us_warm** (ấm, khàn nhẹ, giọng Mỹ bình dân ~70 tuổi), **Ambrose = fussy** (mỏng, cao, mũi, kiểu thư lại Anh khó tính) — cross-cosine **0,662**, giảm hẳn so với cặp cũ (0,88-0,91). Cả 2 nhân vật đều hợp tính cách đã viết (Barnaby ấm áp kể chuyện; Ambrose khó tính chỉn chu). File ứng viên còn giữ nguyên ở `voice/barnaby_us_cands/`, `voice/ambrose_cands/` + `voice/voice_pick_report.json` (ma trận đầy đủ) — **bạn nghe thật và đổi tay nếu muốn**, cosine chỉ là proxy không đảm bảo nghe hay/đúng.

**Phát hiện quan trọng, cần người nghe xác nhận:** chỉ số `voice_ok` tự động của `check_chains.py` (so cosine cả đoạn 8s với 2 giọng gốc) **không đáng tin với cặp giọng mới** — trên tổng 13 shot đã chấm (1 lip-close + 4+4+4 của 3 chain), máy luôn đoán "Barnaby" 12/13 lần bất kể người nói thật là ai: đúng 5/13 (toàn bộ 7 shot Ambrose nói đều bị đoán nhầm thành Barnaby, 5/6 shot Barnaby nói đoán đúng). Cùng hiện tượng này từng xảy ra ở lượt test đầu (2026-11-05) nhưng lệch về phía ngược lại (máy luôn đoán "Ambrose"). Kết luận: đây là thiên lệch của phép đo whole-clip cosine với cặp giọng cụ thể, không phải bằng chứng video gán nhầm giọng cho nhân vật — **phải nghe thật để biết đúng/sai**, không dùng `voice_ok` một mình.

### Câu lip-close

Bỏ câu "Exactly as the voice stops..." khỏi 1 shot test: hết hẳn câu rác "Exactly as Wossie's the aepus..." của lượt trước, **nhưng xuất hiện câu rác khác** ("...his drishdom seed of", vô nghĩa) — tức **không phải H3 đọc đúng nguyên văn câu lip-close**, giả thuyết gốc trong doc cũ bị bác một phần. Soát kỹ `extra_speech` của cả 12 shot còn lại (3 chain đủ, vẫn giữ câu lip-close nguyên bản): phần lớn (9/12) chỉ là **chữ cuối của chính câu thoại kịch bản** rơi muộn hơn mốc đo (`line_end + 0,4s`) một chút — không phải hallucination, chỉ là H3 nói hơi chậm hơn mốc giây ghi trong prompt. Còn lại 3/12 là câu rác vô nghĩa ngắn tương tự lượt lip-close test ("optimum elation.", "of a berry.", "is of the beauty.") — có vẻ là hiện tượng garble đuôi câu ngẫu nhiên của H3 (hoặc ảo giác Whisper ở biên lặng/tiếng chim), **độc lập với câu lip-close**, xảy ra ở tần suất thấp (~1 lần/chain) dù có hay không có câu đó trong prompt.

### Chain 02 (Mặt Trăng)

Render đúng: mặt đất Mặt Trăng (đá xám, không khí quyển), bầu trời đen, **Trái Đất hiện rõ dạng viên bi xanh-trắng nhỏ ở xa** — giải quyết đúng rủi ro đã ghi trong "Việc còn dở" cũ ("chưa thấy ảnh Mặt Trăng, rủi ro chân trời/vị trí Trái Đất"). Cả hai nhân vật đúng trang phục/đặc điểm, đứng đúng bố cục hai-shot. Xem khung hình đã trích tại giây 2 của shot 1 (không lưu vào repo, chỉ kiểm bằng mắt lúc làm).

### Bản `_single`

Dùng sheet cắt một góc (`character/barnaby_front.png`, `ambrose_front.png`) + nền làm khung đầu (`start_image`), thay vì sheet hai góc + nền làm ảnh tham chiếu của bản gốc. Kiểm bằng mắt 3 khung hình (shot 1 giây 0,3 và giây 2; shot 3 giây 6): **đạt cả hai mục tiêu cùng lúc** — hai người bước vào khung từ mép (giây 0,3 còn cắt mép, giây 2 đã đứng giữa khung đầy đủ), **và không còn lỗi "sheet lọt vào khung hình"** đã gặp ở bản chain_01 gốc (shot 3 giây 5,5, nền xám hai Ambrose). Đây là bản tốt nhất trong 3 biến thể chain 01 đã thử (`chain_01`, `chain_01_refs_only`, `chain_01_single`) nếu cần cảnh có người đi vào khung mà không muốn mất ảnh nền.

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
| `check_chains.py` import `face_similarity` từ `ROOT/"scripts"` (`ROOT` = gốc repo, parents[5] tính từ file), tức `scripts/face_similarity.py` ở **gốc repo**, không phải `previs_h3_test/scripts/` | Tar upload theo `pod_up.sh` cũ (`src pyproject.toml previs_h3_test/scripts`) không kéo thư mục `scripts/` gốc repo → `ModuleNotFoundError: face_similarity` lần chạy check đầu tiên | `scp` riêng đúng 1 file `scripts/face_similarity.py` lên `/opt/dramaclaw/scripts/` thay vì tar cả thư mục `scripts/` gốc (repo có rất nhiều file khác không cần) |
| `uv run qwen_voice_design.py` in cảnh báo "SoX could not be found!" lúc cài xong deps | Trông như lỗi nhưng model vẫn nạp và chạy bình thường ngay sau đó (không cần `sox`) | Bỏ qua cảnh báo này, hoặc cài `apt-get install sox` cho chắc (không bắt buộc) |
| Vòng lặp bash kiểu `for i in ...; do sleep N; ...; grep ... && break; done` chạy hết số lần lặp mà chưa thấy marker `done`/`failed` thì `bash -c` trả exit code 1 (do lệnh cuối là `grep` không khớp) | Harness báo task "failed" dù thực chất job trên pod vẫn đang chạy bình thường, không phải lỗi thật | Đọc nội dung log output trước khi kết luận thất bại; `grep` không khớp ở cuối vòng lặp polling là bình thường, không phải tín hiệu lỗi |
| `create-pod` yêu cầu `gpu.minRamPerGpu` chỉ là **bộ lọc đặt chỗ**, không phải RAM cấp thật: đặt `minRamPerGpu:100` nhưng container chỉ thấy `ram_total` ~93 GiB (cgroup) dù `free -g` trong SSH session thấy **503 GB RAM thật của host** | Dễ hiểu nhầm máy có RAM ít hơn thực tế nếu chỉ đọc `/system_stats` của ComfyUI (cgroup-limited) thay vì `free -g` qua SSH trực tiếp | Khi cần biết RAM thật của pod, đọc `free -g`/`free -h` qua SSH trực tiếp, không chỉ tin con số `ram_total` trong `GET /system_stats` của ComfyUI |

Lỗi của prompt và hình đã tìm ra:
- Sheet hai góc nhìn trên nền xám, dùng làm ảnh tham chiếu cùng lúc nền làm khung đầu: H3 vẽ lại chính sheet trong khung hình. Cách đúng: nền là ảnh tham chiếu. Chưa thử: cắt mỗi sheet thành một góc (`character/*_front.png`, `chain_NN_single.json`).
- Khi nền chỉ là `start_image` của shot 1, các shot 2-4 không còn ảnh nền: cảnh đổi sang vườn khác.
- Hai giọng cùng mô tả "giọng Anh" nghe như một: cosine giữa các shot cùng người nói 0,90, khác người 0,88.
- Skill review đã bỏ sót số khung sai lưới 17k+5 và shot thoại dưới 192 khung; đã thêm.
- Lệnh `git commit` không có pathspec kèm theo mọi file đã stage (bài thử ep01): dùng `git commit -- <paths>` và kiểm `git show --stat`.

## Chuyển cảnh giữa 2 background (Ken Burns, 2026-11-06)

Hỏi "bay từ vườn táo lên trời rồi hạ xuống Mặt Trăng" — cân nhắc 2 hướng: sinh 1 clip AI-video riêng làm cầu nối (tốn GPU, rủi ro, và phá luật "camera cố định, ngang mắt" trong series bible), hay giả lập bằng dựng phim thuần trên 2 ảnh nền tĩnh đã có sẵn (miễn phí). Đã chọn **hướng dựng phim thuần**, không cần GPU:

- Script tái dùng được: `previs_h3_test/scripts/skits/science_humor/make_ken_burns_transition.py` — nhận 2 video chain + 2 ảnh nền tĩnh, tự sinh bầu trời sao (PIL, có chấm nhỏ Trái Đất), zoom/pan lên từ nền A → bầu trời sao → zoom xuống nền B, crossfade cả 2 đầu nối với video chain thật. Toàn bộ bằng ffmpeg `zoompan`/`xfade`, không gọi model nào.
- Kết quả: `runs/_science_humor_gravity_full_preview/full_preview_kenburns.mp4` (66s, chain_01_single + chuyển cảnh ~2,8s + chain_02_refs_only). Đã xác nhận bằng mắt + chạy lại script để kiểm tái lập (cùng thời lượng 65,79s cả 2 lần).
- **Vẫn cần thêm nội dung**: đoạn chuyển hiện chỉ có hình, chưa có câu thoại cầu nối. Series bible đã có sẵn trò đùa đúng chỗ này cho Barnaby ("bị lạc giữa các bối cảnh và không thấy có gì lạ") — nên viết 1 câu ngắn mở đầu shot Mặt Trăng tận dụng trò đùa đó, chưa làm (cần `gen_chains.py` viết lại dòng thoại, rồi render lại — tốn GPU).
- Không làm: sinh clip chuyển cảnh bằng H3 (rủi ro cao, phá luật camera tĩnh, chưa test).

## Gemini WebAI storyboard: sheet + plate + storyboard frame, bỏ Qwen khỏi đường ảnh (2026-11-09)

Thay thế toàn bộ bước ảnh (sheet nhân vật, nền trống) đang chạy bằng Qwen-Image 2.1 **trên pod GPU thuê** sang **Gemini qua WebAI-to-API, chạy cục bộ trên máy này, không GPU, không tốn tiền** — lý do: Qwen-Image 2.1 chỉ cấp phép nghiên cứu/đánh giá (xem `examples/science-humor/risks.md`), và việc sửa một ảnh trước đây bắt buộc phải thuê pod. Thêm lớp ảnh mới: **storyboard frame** — Gemini ghép sẵn hai người vào đúng bố cục cảnh (thay vì chỉ sinh nền trống để H3 tự đặt người vào), dùng làm `start_image` cho H3 thay vì nền trống.

**Việc đã làm (chỉ ở mức script, đúng phạm vi đã chốt — không đụng `src/novelvideo/**`, không thêm route/UI):**

- `previs_h3_test/scripts/gemini_webai_images.py` (mới): gọi thẳng `http://127.0.0.1:6969/v1/chat/completions` (bỏ qua NewAPI, channel `DC-custom` chưa dựng trên máy này), chép lại logic đã chạy được trong app (`nanobanana_grid.py:_call_webai_chat_image_api`/`_download_webai_artifact`/`_webai_ref_filename`) để không phụ thuộc `novelvideo.*`. 3 mode: `sheet`, `plate`, `storyboard`. Dùng `conversation_id` của WebAI để giữ một hội thoại xuyên suốt mỗi lượt chạy (nhất quán nhân vật/ánh sáng hơn mỗi ảnh một request), lưu lại vào `session.json` để chạy tiếp được. Không có tham số tỉ lệ khung ở WebAI-to-API nên ép 16:9 bằng prompt + plate làm ref + crop/resize Pillow về đúng `1344×768`.
- `gravity_test/gen_chains.py`: thêm `storyboard_prompt()` (prompt compose kiểu "Image 1/2/3", dùng pose mở đầu của chính shot đó qua hàm share `_static_opening()` để storyboard và prompt H3 không mâu thuẫn), và `shot()`/`definitions()` nhận thêm `storyboard`/`force_first`. Sinh thêm 2 kiểu chain mới, cả hai dùng storyboard làm `start_image` thay nền trống:
  - `chain_NN_sb.json` (V1): giữ chain 4 shot như `chain_NN.json`, chỉ đổi `start_image` sang storyboard shot 1.
  - `shot_NN_M_sb.json` (V2, 8 file): mỗi shot một chain H3 riêng (`shot_count: 1`), `start_image` là storyboard của chính shot đó — đúng mô hình storyboard→video (duyệt từng khung trước khi render), đánh đổi mất nối latent giữa các shot.
  - Refactor đã verify behavior-preserving 100% cho 3 variant cũ (`chain_NN`/`_refs_only`/`_single`) bằng so sánh chương trình (0 sai khác trên 24 tổ hợp).
- **Lỗi tìm thấy khi chạy skill review** (CHẶN, đã sửa trước khi commit): bản đầu của `chain_NN_sb.json`/`shot_NN_M_sb.json` dùng sheet 2 góc trên nền xám làm `reference_images` cùng lúc có `start_image` — đúng tổ hợp đã gây lỗi "sheet lọt vào khung hình" ở `chain_01.json` gốc (xem mục Kết quả ở trên, shot 3 giây 5,5). Đã đổi sang `barnaby_front.png`/`ambrose_front.png` (ảnh 1 góc, giống `_single.json` đã verify không bị lỗi này).
- `run_batch.sh`: bỏ hẳn stage `images` (Qwen); danh sách file kiểm trước khi render thêm `*_front.png`. `pod_up.sh`: bỏ cờ `--with-qwen` (bớt ~25 GB tải model), bỏ tmux tự chạy stage ảnh (giờ chạy tay `voices` rồi `videos` qua SSH).
- `check_chains.py`: thêm mode `--storyboard <image.png> ...` — chấm SFace của từng ảnh storyboard so với 2 sheet **trước khi** tốn GPU render, tách khỏi phần voice/whisper nặng của mode video.
- Xoá `qwen_prompts.json` (thay bằng `image_prompts.json`, cùng nội dung sheets/backgrounds nhưng ghi chú nguồn Gemini WebAI).

**Đã verify (local, không GPU, theo đúng phạm vi đã chốt — chưa thuê pod render lần này):**

- `web_ai_server` (project `~/XuongPhim/WebAI-to-API`) đã tắt ở đầu phiên, bật lại bằng `docker compose up -d --build`, cookie (`runtime/auth/gemini.json`, từ 28-10) vẫn còn sống — xác nhận qua gọi thật, không cần `verify_login.py`.
- Sinh thật cả 3 mode qua `uv run gemini_webai_images.py`: `sheet` (Barnaby/Ambrose, 2 góc, ~17-22s/ảnh), `plate` (orchard/moon, ~17s/ảnh), `storyboard` (8 ảnh — 4 shot × 2 chain, ~20-36s/ảnh) — xem bằng mắt, chất lượng tốt, đúng bố cục series bible (Barnaby trái, Ambrose phải, pencil/apple đúng chỗ, Trái Đất nhỏ ở xa trên nền Mặt Trăng). Ảnh có watermark SynthID.
- `check_chains.py --storyboard` trên cả 8 ảnh: đúng 2 mặt mỗi ảnh, đúng thứ tự trái-phải, SFace đúng người (0.52-0.84) rõ ràng cao hơn SFace sai người (0.14-0.34) — ngưỡng cùng người 0.363, không ảnh nào mập mờ.
- Dry-run `build_h3_multishot_graph()` (không gọi ComfyUI) cho cả 10 file `_sb`: build graph sạch, không lỗi.
- Kiểm chương trình: số `<Picture N>` khớp đúng thứ tự `reference_images`, `frames=192` đúng lưới 17k+5, không file nào thiếu check.
- Chạy skill `longform-minimax-h3-script-review` trên cả 10 file: ĐẠT sau khi sửa lỗi sheet-2-góc nêu trên; thoại/khoa học/hài/nhân vật không đổi so với bản gốc đã duyệt trước đó (diff chương trình xác nhận chỉ có mô tả `<Picture 1>` và câu mở shot 1 thay đổi).

**Chưa làm (để lần sau, cần thuê pod):** render thật `chain_01_sb`/`shot_01_*_sb` trên 4090/5090 (tránh `EUR-IS-2`), so với `chain_01_single` đã có — kiểm nền có trôi, sheet có lọt khung, SFace video so với sheet, và mối nối giữa các shot của V2 có thấy rõ không. Dự kiến ~440 s/shot, ~1 giờ GPU cho cả V1+V2 (≈ $0,9 trên 4090 Secure).

### Đổi sang ảnh thật Einstein/Newton (2026-11-09, cùng ngày, theo yêu cầu user)

User yêu cầu đổi từ "chỉ gợi không khí" sang **cố tình giống hẳn** Einstein/Newton — ngược hẳn quyết định giảm rủi ro đã ghi trong `risks.md` trước đó. Đã hỏi lại một lần (nêu rõ rủi ro quyền hình ảnh Hebrew University/GreenLight với Einstein), user xác nhận muốn tiếp tục — đã làm theo, ghi quyết định và rủi ro đã chấp nhận vào `risks.md` và `series-bible.md`.

- **Ảnh nguồn:** tải 2 ảnh public domain từ Wikimedia Commons — Einstein 1921 (Ferdinand Schmutzer, National Library of Austria) và Newton 1689 (chân dung Godfrey Kneller, 46 tuổi). Lưu kèm nguồn ở `character/real_refs/SOURCES.md`.
- **Đổi mô tả ngoại hình** trong `series-bible.md` và `gen_chains.py` (`BARNABY_ANCHOR`/`AMBROSE_ANCHOR`, `SHEETS`): Barnaby thêm ria mép trắng rậm, tóc xù bạc, kính tròn dây mảnh (bỏ "cạo sạch"/"kính vuông" vốn là điểm *cố tình khác* Einstein ở luật cũ); Ambrose giữ gần như nguyên (vốn đã khá giống Newton), chỉnh "tóc bạc" → "tóc xám", thêm "mắt sâu".
- `gemini_webai_images.py` **sheet** mode: thêm hỗ trợ ảnh identity reference (`image_prompts.json["sheets"][name]` giờ là `{"prompt", "ref"}` thay vì chuỗi đơn; `gen_chains.py` tự ghi `ref` từ `SHEET_REFS`). Đã sinh lại `barnaby_sheet.png`/`ambrose_sheet.png` kèm ảnh thật làm reference — kết quả giống rõ rệt (xem contact sheet), cắt lại `barnaby_front.png`/`ambrose_front.png` từ đúng nửa "facing the lens" của mỗi sheet (**sửa 1 lỗi nhỏ lúc làm**: `ambrose_front.png` ban đầu cắt nhầm nửa trái — nửa *turned*, không phải nửa *facing lens* bên phải, do SHEETS["ambrose"] đặt thứ tự ngược với barnaby; đã cắt lại đúng).
- Chạy lại `gen_chains.py`: toàn bộ 10+ file chain tự cập nhật mô tả ngoại hình mới (chung 1 anchor, không cần sửa tay từng file).
- Sinh lại storyboard: **chỉ xong 1/8 ảnh** (`chain_01_shot1_s1.png`) thì tài khoản Gemini dùng cho WebAI-to-API **hết quota ảnh miễn phí trong ngày** ("come back tomorrow"/"I can still find images from the web"). Ảnh đã sinh: SFace đúng người rõ ràng (Barnaby 0,77 vs Ambrose 0,08 ở mặt trái; Ambrose 0,6 vs Barnaby 0,23 ở mặt phải), bố cục đúng series bible. **7 ảnh storyboard còn lại (`chain_01_shot2-4`, `chain_02_shot1-4`) cần sinh lại khi quota reset** (thử lại sau, chưa rõ giờ reset chính xác).
- Review skill **chưa chạy lại** cho mô tả ngoại hình mới (mục A-G của skill, đặc biệt mục G Einstein/Newton) — nên chạy trước khi thuê pod render thật.

## Việc còn dở

-2. **Render `chain_02_single.json` — THÀNH CÔNG qua Vast.ai (2026-11-09), cả 2 câu hỏi gốc đều có kết quả tốt.** Sau 3 lượt thử RunPod thất bại liên tiếp (chi tiết đầy đủ giữ lại bên dưới làm tham khảo nếu quay lại RunPod), chuyển hẳn sang **Vast.ai** — lần đầu dự án dùng provider này.
   - **Hạ tầng Vast.ai (quy trình mới, ghi lại để lần sau không phải mò lại)**: CLI `vastai` đã cài sẵn ở `~/.local/bin/vastai`, cần đăng nhập 2FA 1 lần (`vastai tfa login --method-type totp -c <mã>`, chỉ người dùng tự làm được) trước khi bất kỳ lệnh account-sensitive nào chạy được (`vastai search offers` không cần 2FA, `vastai show user`/`create instance` thì cần). Giá rẻ hơn RunPod Secure ~2,3 lần (RTX 4090 ~$0,37-0,49/giờ gồm cả ổ đĩa, so với $0,89/giờ RunPod). Khoá SSH máy này cũng **chưa đăng ký** trên Vast.ai (tài khoản riêng, không liên quan khoá RunPod) — đăng ký bằng `vastai create ssh-key "$(cat ~/.ssh/id_ed25519.pub)" -y` (khác hẳn cú pháp RunPod `update-ssh-keys`).
   - **Chọn offer**: `vastai search offers 'gpu_name=RTX_4090 rentable=true cpu_ram>=60 disk_space>=250 geolocation=VN' -o 'dph_total' --raw` — lọc theo RAM/ổ/vùng mong muốn trực tiếp trong query, trả JSON sạch (field `dph_total`=giá/giờ tổng, `cpu_ram` đơn vị MB, `disk_space` đơn vị GB, `reliability2`=độ tin cậy lịch sử 0-1). Offer ID chỉ dùng được 1 lần, có thể bị người khác thuê mất giữa lúc tra cứu và tạo — tra lại trước khi tạo nếu cách nhau vài phút.
   - **Tạo instance**: `vastai create instance <id> --image nvidia/cuda:12.4.1-devel-ubuntu22.04 --disk 250 --ssh --direct` — **bắt buộc image `-devel`** (không phải `-runtime`), lý do y hệt RunPod: `setup_h3_box.sh` cần `gcc` để Triton/Sage biên dịch lúc chạy. `--direct` cho kết nối SSH trực tiếp (nhanh hơn qua proxy `ssh5.vast.ai`). Instance lên rất nhanh (~15s tới khi SSH vào được, khác hẳn RunPod có thể mất 8+ phút hoặc chết hẳn).
   - **Thông số thật của instance đã dùng**: RTX 4090, Việt Nam (geolocation VN, ping thấp), 251GB RAM (hiển thị ban đầu trên catalog chỉ 64GB — con số catalog không phải trần thật, container thấy đủ cả RAM host), 250GB đĩa, driver 580.142, CUDA 13.0, $0,486/giờ (gồm GPU $0,371/giờ + đĩa $0,116/giờ) — tính đúng theo giá quảng cáo ban đầu ($0,373/giờ chưa gồm đĩa).
   - **Quy trình upload/setup giống hệt RunPod** (tar qua SSH, `setup_h3_box.sh --with-ref2va --with-qwen`, `tmux new -d -s comfy /opt/run_comfy.sh`) — script `pod_up.sh` viết cho RunPod dùng được gần như nguyên vẹn, chỉ cần tự thay host/port (Vast.ai không có script `pod_up.sh` tương đương, nhưng logic bash/SSH/tar bên trong portable). Setup mất ~11-12 phút (tải model ~85GB tốc độ 96MB/s từ Việt Nam tới HuggingFace — nhanh hơn hẳn benchmark RunPod EU).
   - **Bẫy nhỏ gặp khi chạy**: `tmux new -d -s render "bash -c '...'"` lồng quote 3 lớp (zsh ngoài → bash -c trong local → bash -c trong tmux trên remote) làm redirect `> render.log` không hoạt động đúng — **không ảnh hưởng tiến trình thật** (vẫn chạy bình thường, tmux session vẫn tồn tại), chỉ cần theo dõi qua `tail -f /opt/bench/comfy_server.log` trực tiếp (ComfyUI tự ghi log riêng, không phụ thuộc redirect bị lỗi) thay vì tin vào file log rỗng. `tmux capture-pane -t <session> -p` cũng trả rỗng trong tình huống này (bình thường, vì output đã redirect đi chỗ khác ngay từ đầu dòng lệnh) — đừng coi "capture-pane rỗng" là dấu hiệu session đã chết, kiểm `tmux ls` + `ps aux` trước.
   - **Thời gian render thật**: 29 phút 19 giây cho 4 shot (~7,3 phút/shot, khớp đúng số liệu RunPod trước đó cho cùng file). Tổng thời gian phiên (tạo instance → setup → render → kéo về → huỷ instance): ~56 phút.
   - **CẢNH BÁO QUAN TRỌNG VỀ CHI PHÍ THẬT — Vast.ai tính phí băng thông riêng, không chỉ GPU/giờ**: `vastai show invoices` sau khi huỷ instance cho thấy tổng chi phí thật **$4,25**, KHÔNG PHẢI ~$0,45 như tính riêng GPU×giờ+ổ×giờ (0,935 giờ × ($0,371+$0,116)/giờ ≈ $0,46 — đúng phần này). Khoản phát sinh lớn: **tải xuống (download charge) 95,8 GB × $0,039/GB ≈ $3,74** — đây là lưu lượng tải model từ HuggingFace về đĩa tạm của instance qua `setup_h3_box.sh` (không có cache bền giữa các lần thuê như network/global volume của RunPod, mỗi instance Vast.ai mới đều phải tải lại từ đầu ~85GB model). Cộng cả upload nhỏ (1,22GB ≈ $0,05). **Tổng thật: GPU $0,35 + ổ $0,11 + tải xuống $3,74 + tải lên $0,05 = $4,25** — đắt hơn hẳn cả 3 lượt RunPod thất bại cộng lại ($1,17), dù RunPod không ra được video nào.
   - **Kết luận sửa lại cho lần sau**: Vast.ai **không hề rẻ hơn RunPod** khi tính đủ chi phí cho use-case "mỗi lần thuê là máy trống, phải tải lại toàn bộ model" — ngược lại đắt hơn vì phí băng thông egress $0,039/GB (RunPod dùng network/global volume bền giữa các lần thuê nên không tốn phí tải lại model mỗi lần, project này đã đầu tư sẵn `dramaclaw-models-global`). Muốn dùng Vast.ai tiết kiệm thật sự, phải dùng **volume bền của Vast.ai** (`--create-volume`/`--link-volume`, thấy trong `vastai create instance --help`, chưa thử) để chỉ tải model 1 lần rồi tái sử dụng — chưa làm trong lần này, cần thử ở lần sau nếu còn dùng Vast.ai. Nếu không dùng volume bền, chỉ nên chọn Vast.ai cho các tác vụ dùng RAM hệ thống/CPU nhiều mà không cần tải nhiều model, hoặc khi RunPod thật sự không còn cách nào khác (như tình huống hôm nay).
   - **KẾT QUẢ (xem bằng mắt qua khung hình trích từ video, không chỉ tin số `check_chains.py`)**:
     1. **Nền hoàn toàn KHÔNG trôi** qua cả 4 shot — bề mặt Mặt Trăng, vị trí/kích thước Trái Đất, góc chân trời, ánh sáng đều giữ y hệt từ shot 1 tới shot 4. Khác hẳn lỗi trôi vườn của chain_01 bản gốc (không-`_single`). Giả thuyết hợp lý nhất: lỗi trôi nền trước đây không phải do cơ chế `start_image` tự nó, mà do sheet 2 góc ghép 2-up (đã bỏ trong `_single`, dùng crop 1 góc riêng) gây nhiễu/bất ổn cho cả continuity của background — chưa kiểm chứng trực tiếp, chỉ là suy luận từ việc cùng 1 cơ chế `start_image` giờ không còn lỗi khi đổi mỗi biến sheet.
     2. **Hiệu ứng "Ambrose hạ từ từ xuống Mặt Trăng" ra đúng như kịch bản, chất lượng điện ảnh**: giây ~0,3s thấy rõ ủng/chân Ambrose rơi vào khung từ mép trên (Barnaby đã đứng sẵn bên trái, đúng ý "thản nhiên"); giây 1,5s Ambrose hạ cánh, đúng tư thế cầm táo; từ giây ~2s cả hai đứng đúng blocking (trái/phải, quay 3/4 về máy) xuyên suốt phần còn lại. Không có khung hình nào trông lỗi/giả.
   - **1 điểm cần lưu ý, không phải lỗi thật**: `check_chains.py` báo cosine khuôn mặt Barnaby thấp bất thường (0,08-0,25, dưới ngưỡng 0,363) ở cả 4 shot, trong khi Ambrose đạt ngưỡng tốt (0,4-0,53) — nhưng **kiểm bằng mắt qua khung hình thật thì khuôn mặt/trang phục Barnaby khớp đúng mô tả nhân vật ở mọi khung** (tóc xoăn bạc, kính đen vuông, bút chì sau tai, áo cardigan vàng mù tạt). Nhiều khả năng là hạn chế của detector YuNet/SFace với góc mặt/ánh sáng cụ thể của Barnaby trong cảnh này, không phải lỗi render — tài liệu script đã ghi rõ "cosine chỉ là proxy, không phân biệt được 2 góc nhìn của cùng 1 người". Không cần hành động thêm, nhưng nếu dùng `voice_ok`/face check tự động cho QA sau này, đừng tin tuyệt đối số này mà không xem lại bằng mắt.
   - Dữ liệu thô: `runs/20261109T044928Z_a2de37635fc8_science_humor_gravity_test_chain_02_single` (video `.mp4` không commit).

   <details><summary>Lịch sử 3 lượt thử RunPod thất bại trước đó (2026-11-06, giữ lại tham khảo nếu quay lại RunPod)</summary>

-1. **Render `chain_02_single.json` (hiệu ứng Ambrose hạ từ từ xuống Mặt Trăng, đã qua review lint sạch) — VẪN CHƯA render được sau 2 lượt thử trong ngày 2026-11-06.**
   - **Lượt 1**: khoá SSH máy này chưa đăng ký tài khoản RunPod — xem bẫy đã sửa ở dưới. Đã sửa, nhưng RunPod hết sạch 4090/5090/RTX PRO 5000 Blackwell kéo dài, dừng giữa chừng không tốn thêm phí.
   - **Lượt 2 (sau khi 4090/5090 có lại "LOW" availability)**: tạo được pod (`startSsh: true`, khoá đã đăng ký hoạt động đúng — xác nhận cả 4 khoá được inject vào `env.PUBLIC_KEY`), nhưng **2 pod liên tiếp đều "chết" ở bước container runtime**, không liên quan SSH key nữa:
     - Pod 1 (RTX 4090, EUR-IS-2, `vq94ypg4wl4r19`): `get-pod` báo `runtime: null` suốt >8 phút; proxy SSH (`ssh <id>-<hash>@ssh.runpod.io`, qua `script -q /dev/null ssh -tt ...` theo đúng cách né lỗi PTY đã ghi ở trên) báo `"container not found"` rồi sau đó `"Error response from daemon: container ... is not running"` — container Docker thật sự không chạy được, không phải do chờ chưa đủ. Đã huỷ (~9 phút × $0,89/giờ ≈ $0,13).
     - Pod 2 (RTX 4090, EUR-IS-2, `2ndatdsvvydpny`): y hệt pod 1 — `runtime: null` kéo dài, proxy báo `"container not found"` suốt ~6 phút không đổi. Đã huỷ (~6 phút ≈ $0,09).
     - Thử tạo pod 3 ở EU-RO-1 (cả 4090 lẫn 5090) ngay sau đó: **hết chỗ lại** ("no longer any instances available") — capacity RunPod biến động theo phút, đúng như đã ghi nhận trước đó trong ngày.
   - **Lượt 3 (2026-11-09, sau khi 4090 trở lại MEDIUM ở nhiều datacenter)**: tạo pod mới (`uemxkxdlm32n6j`, RTX 4090, EUR-IS-2, 100GB RAM, `startSsh: true`) — **y hệt lỗi lượt 2 lần thứ 3 liên tiếp**: `runtime: null` kéo dài dù `status: RUNNING`, rồi `runtime` xuất hiện (uptime 0, không tăng), proxy SSH báo thẳng `"Error response from daemon: container ... is not running"`. Đã huỷ (~7 phút ≈ $0,10). **Kết luận nâng từ "nghi vấn" lên gần như chắc chắn: EUR-IS-2 + image `ezycloudx/ubuntu22.04-devel:cuda126` có vấn đề riêng** (3/3 lần tạo pod ở đúng datacenter này đều kẹt y hệt ở bước container runtime, trong khi API luôn báo `RUNNING` bình thường) — không phải lỗi cấu hình phía mình. Thử ngay 4 datacenter/loại GPU khác để né EUR-IS-2 (US-IL-1 4090, US-CA-2 4090, EU-RO-1 5090, US-NC-1 4090, đều từng báo MEDIUM/LOW vài phút trước đó): **cả 4 đều hết chỗ ngay lúc thử** ("no longer any instances available") — capacity RunPod biến động cực nhanh, window vài phút là đủ để một catalog "MEDIUM" tụt về rỗng.
   - Tổng chi phí 3 lượt thử trong ngày: ~$0,85 (lượt 1, lỗi SSH) + ~$0,22 (lượt 2, 2 pod container-lỗi) + ~$0,10 (lượt 3, 1 pod container-lỗi, 4 lần thử thuê tiếp theo đều hết chỗ nên không tốn thêm) ≈ **$1,17**. `list-pods` xác nhận rỗng sau mỗi lần dừng.
   - **Việc cần làm tiếp**: tránh hẳn datacenter `EUR-IS-2` cho đến khi có dấu hiệu nó đã ổn (thử datacenter khác trước, ví dụ `EU-RO-1`/`US-IL-1`/`US-CA-2`/`US-NC-1`/`EUR-NO-1` cho 4090, hoặc tương đương cho 5090) VÀ container khởi động bình thường (kiểm proxy SSH trả lời được trong vài phút đầu, không phải `runtime: null`/`"container not running"` kéo dài) VÀ capacity catalog đang MEDIUM/HIGH (không chỉ LOW, vì LOW/MEDIUM có thể tụt về 0 trong vài phút). Sau đó `run_batch.sh videos chain_02_single`, kiểm nền có trôi ở shot 3-4 không (câu hỏi gốc: `_single` dùng `start_image` giống bản chain_01 gốc từng bị trôi vườn) và hiệu ứng hạ cánh có mượt không.
   - **Bẫy thật đã gặp và sửa (miễn phí, không liên quan GPU)**: pod đầu tiên tạo thành công (RTX 5090 Secure EUR-NO-1) nhưng **SSH không bao giờ vào được** — kiểm log container (8795 dòng, ~43 phút, không phải crash-loop) thấy không có dòng nào về sshd/authorized_keys. Nguyên nhân: khoá SSH của máy này (`thond02@ominext.com`) **chưa đăng ký trong tài khoản RunPod** — `env.PUBLIC_KEY` truyền lúc tạo pod không được image cộng đồng `ezycloudx/ubuntu22.04-devel:cuda126` xử lý (không phải template RunPod chính chủ). Cách đúng (đã làm, xác nhận qua `get-ssh-keys`): đăng ký khoá máy này vào tài khoản bằng `update-ssh-keys` (giữ nguyên các khoá cũ, chỉ thêm), rồi tạo pod với `startSsh: true` — đây là cơ chế chuẩn RunPod inject khoá ĐÃ ĐĂNG KÝ vào `authorized_keys`, hoạt động với mọi image, không phụ thuộc `env.PUBLIC_KEY`. **Đã xác nhận cơ chế này hoạt động đúng ở lượt 2** (cả 4 khoá, kể cả khoá mới đăng ký, đều xuất hiện trong `env.PUBLIC_KEY` của pod) — vấn đề lượt 2 là container runtime, không phải SSH key nữa.
   - **Bẫy kỹ thuật mới**: proxy SSH (`ssh <podid>-<hash>@ssh.runpod.io`) có thể trả lỗi khác nhau theo trạng thái container: `"container not found"` (container chưa tồn tại/chưa khởi tạo) vs `"container ... is not running"` (container tồn tại nhưng đã dừng/crash) — 2 thông điệp khác nhau, cả hai đều là dấu hiệu không nên tiếp tục chờ trên pod đó.

   </details>

0. **`PLAN_h3_memory_sampler_antidrift.md` (chưa bắt đầu, chờ xác nhận):** đổi sang `H3MultishotMemorySampler` (`continuity=latent_handoff`/`first_frame`, không cần cài thêm gì) + `reference_subjects` (nhiều ảnh góc mặt riêng biệt thay vì sheet ghép 2-up) để thử giải triệt để lỗi trôi vườn và lỗi sheet lọt khung tận gốc, thay vì các cách né hiện tại (`_refs_only`/`_single`). Đã viết xong Giai đoạn 1 trong plan, **chưa viết code** (`build_h3_multishot_memory_graph()` mới) và **chưa thuê pod test**.
1. **Bạn chấm (ưu tiên cao):** nghe thật `voice/barnaby.wav`/`voice/ambrose.wav` (+ ứng viên trong `voice/barnaby_us_cands/`, `voice/ambrose_cands/`) để xác nhận cặp giọng máy chọn (us_warm/fussy) có ổn không — máy chỉ chọn bằng cosine, chưa ai nghe. Đồng thời chấm khớp môi, độ hài, giọng, cảnh cắt giữa hai bối cảnh trên 4 video mới (`chain_01_refs_only`, `chain_02_refs_only`, `chain_01_single`, lip-close test) — chưa có người nghe tiếng/người bản ngữ đọc lời.
2. **Voice_ok tự động chưa đáng tin:** cả 2 lượt test (giọng cũ lẫn giọng mới) chỉ số `voice_ok` của `check_chains.py` đều thiên lệch nặng về 1 giọng cố định (lượt cũ thiên Ambrose, lượt mới thiên Barnaby), đúng ngẫu nhiên ~5/13 shot. Nếu muốn dùng được chỉ số này cho QA tự động về sau, cần tìm cách đo tốt hơn (vd cắt đúng đoạn có tiếng nói trước khi embed, hoặc dùng mô hình phân tách giọng nói mạnh hơn Resemblyzer) — chưa làm.
3. **Garble đuôi câu ngẫu nhiên (~1 lần/chain):** không phải do câu lip-close (đã loại trừ phần lớn bằng thử nghiệm 2026-11-06), nguyên nhân thật chưa rõ (H3 tự thêm âm thanh, hay ảo giác Whisper ở đoạn lặng có tiếng chim/gió). Chưa thử: tắt hẳn `overall_soundscape` để xem garble có giảm không; so với bản without ambient audio.
4. **Chưa thử:** nâng lên 1080p cho định dạng này (Lanczos hoặc SeedVR2), âm lượng giữa các chain.
5. **Giấy phép trước khi đăng:** H3 loại trừ EU, Anh, Hàn Quốc, Mỹ và cả 2 pod đã chạy ở vùng EU (EU-RO-1, EUR-IS-2). **Đã giải quyết một phần (2026-11-09):** Qwen-Image 2.1 (nghiên cứu/đánh giá) đã bỏ khỏi đường ảnh, thay bằng Gemini WebAI — nhưng đó cũng chỉ là previs (tài khoản cá nhân qua trình duyệt, không phải API có hợp đồng); trước khi kiếm tiền phải đổi sang Google AI Studio API trả phí. Xem `examples/science-humor/risks.md`.
6. **Chưa kiểm:** tên Ambrose Whitlock và tên kênh trùng hay không; 35% cuối trang nguồn S2; "to Einstein, gravity isn't a pull" là cách nói gọn.
7. **Render thật `chain_01_sb`/`shot_01_*_sb` trên GPU (2026-11-09):** đã sinh và duyệt xong sheet/plate/storyboard bằng Gemini WebAI, lint sạch, dry-run graph sạch (xem mục trên) — chỉ còn thiếu bước thuê pod render thật để so với `chain_01_single` đã có.
