# Yui (結) xuyên không — Ep1: Edo, 1703 (Nihonbashi)

**Tiêu đề gợi ý:** "I time-traveled to Edo and I'm still in my school uniform" | **Định dạng:** 9:16, ~56s, handheld selfie POV | **Thoại:** tiếng Anh | **Âm thanh:** chỉ ambient (chợ, kênh, gió, chuông) — không nhạc nền

Pipeline sản xuất: **Qwen-Image 2.1** (character sheet + location, qua Freezone `runpod_qwen_image`) → **Qwen-Image-Edit-2511** (relight/chỉnh sửa first frame, qua Freezone `runpod_qwen_edit`) → **MiniMax H3** ref2va/fl2va (1-shot) + **H3 multishot** (ref2va, 2 shot/chain) để dựng video. Xem `.claude/CLAUDE.md` mục "Yui (結) xuyên không" / ADR liên quan cho chi tiết hạ tầng.

## Series bible (dùng chung mọi tập)

**Yui Takahashi (結)**, 17 tuổi, nữ sinh năm 2 cấp 3 Tokyo hiện đại. Tò mò, nói nhanh, hay lẩm bẩm với camera, hài kiểu khô; sợ nhất là "làm thay đổi lịch sử". Tên "結" (Kết — gắn kết, thắt nút, nối liền) là ẩn dụ cho vai trò nhân vật: nút thắt nối quá khứ và hiện tại.

- **Ngoại hình khoá cứng (character anchor, giữ nguyên mọi thời kỳ/mọi ảnh):** người Nhật, **17 tuổi, cao 158cm** (thấp hơn rõ rệt so với đàn ông trưởng thành xung quanh — nữ sinh cấp 3 trung bình, không phải người lớn), tóc đen thẳng ngang vai, mái thưa, mắt nâu đậm, nốt ruồi nhỏ dưới mắt trái. **Phải ghi rõ "17-year-old, 158cm tall, petite/average teenage build" trong MỌI prompt compositing** (không chỉ character sheet) — thiếu dòng này là nguyên nhân khiến vài lần sinh ảnh cô ấy bị lớn/cao bất thường so với người xung quanh trong cảnh.
- **Trang phục hiện đại:** sailor seifuku navy, khăn/nơ đỏ, tất đen, giày loafer, balo đeo vai.
- **Format cố định mỗi tập:** Hook đến nơi bằng đồ hiện đại → bị nhìn chằm chằm → đổi trang phục → hoà vào đời sống + 1 sự thật lịch sử → 1 tương tác với người địa phương → closing line trên cao nhìn toàn cảnh, dây đỏ sáng → cắt.
- **Danh sách tập dự kiến:** Ep1 Edo 1703 (tập này) · Ep2 Heian Kyoto ~1000 · Ep3 (để sau) · Ep4 Meiji Ginza 1880s · Ep5 Sengoku.

## Props bible (đạo cụ xuyên suốt — phải thống nhất pixel-level giữa mọi cảnh/mọi tập)

Trước đây dây đỏ/điện thoại chỉ được MÔ TẢ BẰNG CHỮ lặp lại trong từng prompt — không có ảnh neo nên mỗi lần sinh có thể ra khác nhau (màu dây, kiểu điện thoại). Từ giờ **mỗi prop có 1 ảnh reference riêng** (sinh qua `/freezone/gen`, lưu trong canvas), dùng làm `extra_reference_urls` bổ sung (cùng location + character sheet) cho MỌI first-frame compositing từ bước 4 trở đi — không chỉ mô tả bằng chữ nữa.

- **`prop_phone`** — điện thoại hiện đại Yui mang theo xuyên thời gian (cố tình lạc thời, là cốt lõi của concept). Mô tả chuẩn: *"A modern smartphone, matte graphite-black body, slim rectangular shape, no visible brand logo, plain back (no case pattern), screen showing a simple camera/selfie viewfinder UI."* — dùng đúng mô tả này ở mọi nơi, không đổi màu/kiểu dáng.
- **`prop_bracelet`** — vòng tay kumihimo dây đỏ, cổ tay TRÁI, cơ chế xuyên không. Mô tả chuẩn: *"A thin round braided kumihimo cord bracelet, deep vermillion-red color, approximately 1cm thick, tied with a small finishing knot (no metal clasp, no beads), worn snug on the left wrist."*
- **Trang phục** vẫn neo qua character sheet (`yui-modern`/`yui-edo`) như cũ — không cần ảnh prop riêng vì sheet đã là ảnh neo toàn thân.
- **Quy tắc viết prompt compositing từ giờ:** mỗi prompt ghép Yui vào location phải có đủ 4 thành phần: (1) câu tuổi/chiều cao ở trên, (2) trỏ rõ tới ảnh ref điện thoại + bracelet ("holding the exact phone shown in reference image N", "the exact bracelet shown in reference image N"), (3) trỏ rõ tới character sheet cho trang phục, (4) câu giữ nguyên bối cảnh location như cũ.

## Aesthetic block Ep1 (chép nguyên văn vào mọi prompt ảnh/video của tập này)

> Edo, Japan, 1703, Nihonbashi district. Wooden two-story merchant houses with dark tile roofs and noren curtains, the arched wooden Nihonbashi bridge over a busy canal with flat boats, earthen streets, townspeople in indigo and brown cotton kimono, porters with shoulder poles, samurai with two swords, paper lanterns, Mount Fuji faint on the horizon. Soft late-morning haze light. No modern elements. Photoreal, handheld phone footage look.

**Lưu ý ép ngoại hình (ghi rõ trong MỌI prompt ảnh của Yui, không chỉ dựa vào ngữ cảnh "Edo, Japan"):** model ảnh của máy này có style/ethnicity mặc định đã biết lệch về Trung Quốc khi không ép rõ (`chinese_period_drama`, xem `examples/tesla-character-assets/`) — mọi prompt character sheet/first frame phải viết tường minh **"Japanese ethnicity, Edo-period Japanese clothing — not Chinese"**, không chỉ nói "Edo, Japan" rồi suy luận ngầm.

## Scene breakdown

| # | Phân đoạn | Thời lượng | Loại video (H3) | Nội dung + thoại (EN) |
|---|---|---|---|---|
| 1 | Hook — cầu Nihonbashi | 6s | ref2va (first frame + character sheet modern) | Selfie đi giữa đám đông trên cầu gỗ, mặc seifuku. *"Okay. Edo. Seventeen-oh-three. And I'm wearing… my school uniform."* |
| 2 | B-roll Edo | 6s | fl2va (location = still `bridge` thuần cảnh — KHÔNG phải first frame cảnh 1 vì cảnh đó đã có Yui trong khung) | Không người trong focus: thuyền dưới kênh, noren bay trong gió, gánh hàng rong đi qua. Chỉ ambient. |
| 3 | The Stares | 6s | **multishot ref2va — shot 1/2** (first frame tại `merchant-street`; 1 ref: `yui-modern` — cô vẫn mặc seifuku) | Đi giữa phố thương nhân, người bán hàng dừng tay nhìn theo. *"Everyone's staring. Like, everyone."* |
| 4 | Né vào tiệm vải | 6s | **multishot ref2va — shot 2/2 (tiếp shot 3, không cần first frame riêng)** | Chui qua tấm noren vào một tiệm vải ở `cloth-shop-doorway`. *"Fine. Fine. Wardrobe change."* |
| 5 | The Outfit | 6s | ref2va (first frame + character sheet Edo) | Bước ra khỏi tiệm trong kosode chàm, obi đỏ, tóc búi gọn — dây kumihimo đỏ vẫn ở cổ tay. Lia điện thoại xuống khoe trang phục. *"Honestly? Kind of a vibe."* |
| 6 | Chợ cá — history fact | 6s | **multishot ref2va — shot 1/2** (first frame tại `fish-market`; 2 ref: `yui-edo` + `vendor-edo`) | Đi qua chợ cá đông đúc. *"Fun fact: Edo's about to be the biggest city on Earth. Like, a million people."* (ước lượng dân số phổ biến cho Edo đầu-giữa thế kỷ 18, không phải số liệu chính xác riêng năm 1703 — đọc như giọng vlog thường, không phải trích dẫn học thuật) |
| 7 | "Irasshai!" | 6s | **multishot ref2va — shot 2/2 (tiếp shot 6, không cần first frame riêng)** | Bà bán cá ngẩng lên gọi "Irasshai!" (tiếng Nhật, giữ nguyên — "Xin mời!"); Yui cúi chào, đáp lại một từ tiếng Nhật ngắn ("Arigatou" / "Sumimasen"), rồi quay lại camera nói tiếp bằng tiếng Anh. *"Did she just— I think I passed."* |
| 8 | B-roll trên cao | 6s | fl2va (location still only) | Mái ngói Edo trải dài, kênh nước, núi Phú Sĩ mờ xa. |
| 9 | Closing — đồi/gác chuông | 8s | ref2va (first frame + character sheet Edo) | Một samurai đi ngang qua sau lưng; Yui nhìn theo rồi quay lại camera. *"Nobody here knows what's coming. They're just… living."* Dây đỏ trên cổ tay phát sáng, flare trắng loé lên → cắt. |

Tổng ≈ 6+6+6+6+6+6+6+6+8 = **56 giây**. 7 lần gọi video: 3 ref2va 1-shot (cảnh 1, 5, 9), 2 fl2va (cảnh 2, 8), 2 chain multishot ref2va 2-shot (cảnh 3+4, cảnh 6+7).

## Quy trình sản xuất (Freezone canvas)

1. **Face anchor** — `/freezone/gen` `runpod_qwen_image`, 3:4, 2K: chân dung chính diện Yui theo anchor ở trên, nền xám studio.
2. **Character sheets** — `/freezone/edit` `runpod_qwen_image` (ref = face anchor), 16:9: (a) `yui-modern` 3-panel full-front/full-back/close-up; (b) `yui-edo` cùng bố cục, kosode chàm + obi đỏ + dây kumihimo; (c) `vendor-edo` (bà bán cá) 1 sheet.
3. **Locations** — `/freezone/gen` `runpod_qwen_image`, **9:16, 2K**, aesthetic block + mô tả riêng: `bridge`, `merchant-street`, `cloth-shop-doorway`, `fish-market`, `rooftops-high`, `hill-belltower`.
4. **~~First frames~~ (bỏ — xem bullet "Đổi pipeline" bên dưới)** — KHÔNG còn sinh ảnh tĩnh ghép Yui vào location nữa. First frame cho H3 ref2va giờ là thẳng ảnh **location sạch** (bước 3), không qua compositing.
5. **~~Relight~~ (bỏ, cùng lý do)** — không cần vì không còn first frame composite nào để relight; H3 tự xử lý ánh sáng khi sinh video.
6. **Video**:
   - 1-shot (cảnh 1, 5, 9): node video `runpod_minimax_h3`, `gen_mode="imageReference"`, `image_urls = [location sạch, character-sheet (yui-modern hoặc yui-edo tuỳ cảnh), prop_phone, prop_bracelet?]` → H3 tự đặt Yui vào cảnh, tự co giãn đúng tỉ lệ 158cm so với người lớn xung quanh, tự khớp ánh sáng. B-roll (cảnh 2, 8) vẫn fl2va, chỉ location, không cần Yui.
   - Multishot (chain 3+4, chain 6+7): node `runpod_minimax_h3_multishot` (ref2va), `start_image` = **location sạch** của shot đầu chain (không phải still đã ghép), ref ≤3 (character sheet + props), 2 shot × 6s → Review (miễn phí, LLM) → sửa prompt nếu cần → Generate.
   - Prompt phải tự viết theo đúng format H3 chính thức (route Freezone `/freezone/video/i2v` KHÔNG tự compile prompt — xem `assemble_minimax_h3_prompt` trong `agents/minimax_h3_prompt_builder.py` để chép đúng cấu trúc `subject_definitions`/`summary`/`retention_analysis`/`detailed_description`/`overall_soundscape`/`non_diegetic_music`, `<Picture N>` đánh số từ ảnh đầu tiên = first frame = Picture 1). Vì first frame giờ KHÔNG có Yui, phải mô tả rõ trong `detailed_description` rằng cô ấy **bước vào khung từ mép** trong ~0.3-1s đầu (verify thật: tự nhiên, không bị coi là bug).
   - Mọi prompt video thêm câu cố định: *"Handheld phone selfie, slightly unsteady, no stabilization. Ambient audio only: [market/canal/temple sounds]. No music. Red braided string bracelet stays on her left wrist."*
7. **Assembly** — tải mp4 theo thứ tự 1→9, `ffmpeg -f concat` straight cuts, `loudnorm` cân âm lượng, phụ đề EN burn-in tuỳ chọn.

**Đổi pipeline (2026-10-26/27, đã verify thật qua GPU)**: toàn bộ nỗ lực ghép Yui vào location bằng Qwen-Image 2.1/Edit-2511 (compose/edit/inpaint, cả scale-fix bằng SAM3 ground-plane) đều hoặc sai tỉ lệ (to gấp 1.4-2.7 lần) hoặc đúng tỉ lệ nhưng vỡ ở bước sửa/hoà sáng (xem `.claude/CLAUDE.md` các mục 2026-10-26/27 để biết chi tiết từng lần thử). **Pilot scene 6 bỏ hẳn bước ghép ảnh tĩnh — đưa thẳng location sạch (first frame) + character sheet + prop ảnh vào `runpod_minimax_h3` ref2va — cho kết quả đúng cả identity (mặt, trang phục, điện thoại, vòng tay) lẫn tỉ lệ cơ thể (rõ ràng nhỏ hơn người lớn xung quanh), chân chạm đất, không lỗi "ma mờ"/collage đã gặp trước đây với Qwen-Image.** Không rõ tại sao H3 (video model) làm tốt việc này hơn Qwen-Image (ảnh tĩnh) — có thể vì H3 học chuyển động/vật lý 3D nên có prior tốt hơn về tỉ lệ người trong không gian. Kết luận: **bỏ hẳn bước 4+5 cũ (sinh first frame ghép + relight) cho mọi cảnh cần Yui xuất hiện trong location** — đi thẳng từ Locations (bước 3) sang Video (bước 6). Job pilot mất ~29 phút (có cold start); job warm nhanh hơn nhiều (xem CLAUDE.md "Đo tốc độ H3"). Chưa chạy lại cho scene 1/3/5/9 — cần làm tiếp để xác nhận tổng quát hoá (đặc biệt scene 9, nơi mọi cách ghép ảnh tĩnh trước đó đều thất bại).

## Ghi chú

- Thoại tiếng Anh, chỉ có 2 từ tiếng Nhật giữ nguyên ở cảnh 7 (lời chào của người bán + 1 từ đáp lại của Yui).
- "H3 ref2va" tự sinh giọng nói + ambient trong clip — không có bước "voice unification" riêng như bản gốc Higgsfield; chấp nhận lệch giọng nhẹ giữa các clip ở v1.
- Dây đỏ kumihimo là chi tiết nhận diện bắt buộc — nhắc trong MỌI character-sheet prompt lẫn mọi video prompt để tránh model bỏ sót qua các lần generate độc lập.

## Rủi ro / điểm cần quyết định trước khi sinh asset

- **Cảnh 7 có 2 người nói trong cùng 1 shot** (người bán tiếng Nhật, Yui tiếng Anh) — đúng mẫu lỗi đã gặp với H3 ở dự án `BabyStories` (model tự dịch/gộp lời thoại khi 1 beat có nhiều người nói, xem `.claude/CLAUDE.md` mục "Bug thật thứ 2"). Khi viết prompt H3 thật cho shot này, phải tách rõ 2 dòng thoại theo người nói (dùng cơ chế multi-turn `<d>`/marker của `minimax_h3_prompt_builder.py`), không gộp chung một câu rồi hy vọng model tự phân biệt.
- **Continuity giữa cuối chain 3+4 (trong tiệm vải) và đầu cảnh 5 (bước ra từ tiệm vải)**: đây là 2 lần generate độc lập (H3 multishot không có cơ chế truyền frame cuối sang 1 lệnh gọi khác) — cùng dùng location `cloth-shop-doorway` làm tham chiếu cho cả 2 phía để giảm lệch, nhưng cửa tiệm ở 2 ảnh có thể không khớp pixel-for-pixel. Nếu lệch rõ sau khi sinh thử, cân nhắc gộp cảnh 4+5 lại thành 1 ảnh first-frame "bước ra khỏi tiệm" duy nhất thay vì 2 lần generate rời.
- **Claim lịch sử "~1 triệu dân"** ở cảnh 6 là ước lượng phổ biến cho Edo đầu–giữa thế kỷ 18 (không có trích dẫn nguồn cụ thể như kịch bản Tesla), chấp nhận được cho vlog giải trí nhưng không nên dùng làm fact-check nghiêm túc nếu sau này muốn làm bản "có nguồn".
- **Đường Edit-2511 trong Freezone mới verify tới bước dispatch, chưa verify ra ảnh thật** (xem ADR 0008) — nên chạy pilot đúng 1 cảnh (khuyến nghị cảnh 1, ref2va đơn giản nhất) trước khi chạy cả 9 cảnh, để bắt sớm nếu identity/ánh sáng không khớp.
