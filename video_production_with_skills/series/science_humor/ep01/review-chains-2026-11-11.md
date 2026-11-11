# Review 19 chain H3 của tập 1 (What is gravity, really?) — 2026-11-11, bản kiểm lại sau khi sửa

Phạm vi: các mục cần file chain: #1-#25 và #52-#58. Các mục #26-#51 không xét lại ở đây (xem review-2026-11-11.md và review-2026-11-11-v2.md). Chỉ đọc, không sửa chain, script.md, skill hay tool.

Lần này: chạy lại `check_chain.py` (`ok: 19 chain(s)`), đọc lại cả 51 shot, đối chiếu từng dòng Bảng shot và Bảng chain trong Storyboard mới, K0 trong `qwen_keyframe_prompts.json`, và `longform-camera-angles` mới. Tự chạy thêm: so `<d>` với bảng script, so mốc giây, grep các từ cấm và từ cảm xúc.

## 1. Bảng số đo tự tính (tính lại sau khi sửa)

| Mục | Kết quả |
|---|---|
| Chain, shot | 19 chain, 51 shot; `frames` 192 (= 17×11+5 = 8 s), `aspect_ratio` 16:9 ở 19/19 |
| Thời lượng H3 | 51 × 8 s = 6:48.0; với 4 đoạn wormhole ~6:56 (số của script) |
| Số từ trong `<d>` | Einstein 219, Newton 261, tổng 480 (45,6% / 54,4%); không đổi |
| `<d>` so với bảng script | 51/51 giống từng chữ, đúng thứ tự, đúng người nói |
| Mốc giây | 51/51 đúng `0.00, 1.00, 3.00, 6.30, 8.00`; thoại 1.00 → 6.30 s (5,3 s), đuôi 1,7 s |
| Âm tiết mỗi shot (đếm tay, ±1) | 9 đến 15, trung bình 12,8; cao nhất 15/5,3 = 2,83 âm tiết/s (shot 03.3, 04.2, 05.3, 07.2, 09.4); thêm 1 âm tiết là 3,02 |
| Setup khác nhau | 13 (vườn 5, Mặt Trăng 4, vách núi 2, không gian sâu 2) |
| Kiểu chuyển động ngoài static | 3: pull-out ×4 (01.1, 08.1, 12.3, 15.1), arc ×1 (06.3), push-in ×1 (11.1, góc một người). Đúng ngưỡng 3; một kiểu bị loại sau lần chạy thử là xuống dưới |
| Shot có chuyển động | 6, cả 6 có câu "reaching that framing within the first five seconds of the shot and holding it until the final frame" |
| Hai chain liền nhau cùng góc và cỡ đầu | 0; quá 2 chain low/high liền nhau: 0 |
| Một người nói quá 2 shot liền | 0 |

## 2. Bảng nhân vật (không đổi)

| Tên | Nhãn, ảnh, giọng | Vị trí, hướng nhìn | Tay |
|---|---|---|---|
| Albert Einstein | S1, Subject 1, `<Picture 2>`, `<Audio 1>` giọng Mỹ | trái; nhìn sang phải; sau pull-out "just left of the centre" | cử chỉ tay phải; tay trong túi khi nghe |
| Isaac Newton | S2, Subject 2, `<Picture 3>`, `<Audio 2>` giọng Anh RP | phải; nhìn sang trái; sau pull-out "just right of the centre" | táo đỏ tay trái; cử chỉ tay phải |

Mô tả ngắn chép nguyên văn từ series-bible ở mọi shot có mặt; nhãn, `<Audio N>`, `voice_refs`, `reference_images`, `<Picture N>`/`<Subject N>` nhất quán 19/19 chain. Táo luôn ở tay trái Newton, không đổi tay, không biến mất.

## 3. Trạng thái các lỗi của lần review trước

| Lỗi cũ | Trạng thái | Kiểm chứng |
|---|---|---|
| CHẶN #54 chain 05 shot 2-3 (pan) | **ĐÃ SỬA** | 05.1-05.3 đều static, bố cục hai phần ba giữ nguyên; Storyboard và skill đã ghi pan, push-in hai người bị cấm |
| CHẶN #54 13.3 (push-in wide tới medium) | **ĐÃ SỬA** | 13.3 static wide; chain 13 không còn chuyển động; chuyển sang two-center ở chain 14 là cú cắt |
| CẢNH BÁO #6/#7 "begins to speak" (03.2, 04.2) | **ĐÃ SỬA** | grep sạch; 0.00 chỉ còn hành động không miệng |
| CẢNH BÁO #7 cười, thở dài, thở ra (14.2, 16.3, 18.4, 18.2) | **ĐÃ SỬA** | grep sạch `laugh`, `sighs`, `breathes`; thay bằng "smiles broadly", "lowers his shoulders", "lips curved in a closed smile" |
| CẢNH BÁO #24 người nói nhìn đi chỗ khác (12.3, 18.2, 13.1, 03.3, 07.1) | **ĐÃ SỬA** | 12.3 nhìn quanh ở 0.00 rồi "facing"; 13.1 nhìn trời ở 0.00 rồi quay lại; 18.2 "while facing"; 03.3 "while still facing"; 07.1 "keeping his eyes on <Subject 1>"; không còn cú nhìn đi giữa 1.00-6.30 |
| CẢNH BÁO #54/#24 người nghe và K0 (08, 13, 15) | **ĐÃ SỬA** | K0 08, 13, 15 ghi Einstein "looking toward the right at the other man"; người nghe nhìn xuống hoặc lên đều có "while his head stays turned toward <Subject 1>" (08.2, 09.1, 09.4, 13.1) |
| CẢNH BÁO #25 tính từ cảm xúc trần | **ĐÃ SỬA, còn tồn dư nhỏ** | "smug/satisfied/suspicion/puzzled/graciously/reluctant/confident/stunned/amused (end pose)" đã thay bằng hành vi; còn "his eyes light up" (13.3), "like an order" (18.1), và prompt K0 của chain 03, 07, 18, 19 (xem mục 4) |
| CẢNH BÁO #20 "draws ... in the air" | **ĐÃ SỬA** | còn "sweeps his hand" (11.1, 12.2, 14.1) và "turns his right hand in a small circle" (15.3); không còn "draws" |
| CẢNH BÁO #22 push-in 03.3 và 11.1 | **ĐÃ SỬA** | 03.3 static; 11.1 "framed from the waist upward and centred" |
| CẢNH BÁO #22 thiếu mốc kết thúc chuyển động, hướng arc | **ĐÃ SỬA** | 6/6 shot di chuyển có "within the first five seconds ... holding"; arc "to the camera's right ... both men fully in frame" |
| CẢNH BÁO #11/#13 "phần ba" sau pull-out (01.2, 08.2, 15.2, 15.3) | **ĐÃ SỬA** | cả bốn viết "just left of the centre ... just right of the centre, close together"; bốn shot pull-out đều viết "both men moving closer to the centre of the frame and staying fully in frame" |
| CẢNH BÁO #15 liền mạch tư thế và K0 | **ĐÃ SỬA** | 05.3 "lowers his right hand into his pocket"; 09.1 và 16.1 đưa tay vào túi, khớp K0 (tay thấp, tay giơ); 13.1 và K0 13 cùng "both hands in his pockets"; 08.2 "takes his right hand out of his pocket" |
| CẢNH BÁO #57 rò người vắng mặt (02, 11, 19) | **ĐÃ SỬA, còn một chữ** | không còn "the other man", "outside the frame"; còn "behind the man and towering over them" ở chain 11 (xem mục 4) |
| CẢNH BÁO #51 NASA, Apollo ngoài `<d>` | **ĐÃ SỬA** | grep sạch NASA, Apollo, Galileo, Einstein, Newton ngoài `<d>`; summary dùng "the space agency", "a later mission", "a Moon landing site in 1969" |
| CẢNH BÁO #20/#21 07.3 "adjusting something" | **ĐÃ SỬA, còn tồn dư nhỏ** | "small turning motion at his hip", Einstein "looking toward <Subject 2>"; xem GỢI Ý |
| GỢI Ý người nền không có trong `subject_definitions` | **ĐÃ SỬA** | câu "The small distant figures in the scenery are not subjects: they never speak and never look at the camera." có trong shot vườn và Mặt Trăng; vách núi và không gian sâu không có người nền |

## 4. Mục còn mở

### CHẶN (1)

**[CHẶN] #21 — Storyboard chưa theo kịp chain: Bảng shot 12,3, 13,2 và 18,2 còn tư thế cũ.**
- 12,3 Storyboard (tư thế cuối): "Newton đưa lòng bàn tay phải phẳng nằm ngang, nhìn quanh". Chain 12.3 kết: "<Subject 2> with his right palm flat and level, facing <Subject 1>" (cú nhìn quanh chỉ ở 0.00).
- 13,2 Storyboard: "Newton nhìn xuống táo rồi nhìn Einstein, lông mày cao". Chain 13.2 kết: "facing <Subject 1> with his eyebrows raised high" (không có bước nhìn táo).
- 18,2 Storyboard: "Einstein vỗ tay phải lên túi áo cardigan, nhìn quanh". Chain 18.2 kết: "patting his cardigan pocket" và "while facing <Subject 2>".
Hậu quả: luật #21 coi tư thế lệch dòng Storyboard là CHẶN; hai nguồn nói hai điều khác nhau, K0 và duyệt sau này sẽ theo bản sai.
Cách sửa: sửa ba dòng Storyboard cho khớp chain (nhìn về phía người kia; bỏ "nhìn quanh"/"nhìn xuống táo"). Chain đúng hơn bản cũ, không cần sửa chain. Làm xong là 0 CHẶN.

### CẢNH BÁO (2)

**[CẢNH BÁO] (mới) — hành động miệng của người đang nói ở giữa câu: 10.3 và 16.3.**
Trích 10.3: "At 3.00 seconds <Subject 2> nods once with a one-sided smile." (thoại tới 6.30). 16.3: "At 3.00 seconds <Subject 2> gives a short nod with his lips pressed together." Cả hai là cách sửa cho lỗi cảm xúc trần ở lần trước.
Hậu quả: skill ghi "smiles", "lips pressed" chỉ đặt sau mốc "finishes", nếu không dễ hỏng khớp môi; "lips pressed together" mâu thuẫn trực tiếp với đang nói.
Cách sửa: giữ cái gật và nhướn mày ở 3.00 ("nods once with one eyebrow lifted"), dời "one-sided smile" và "lips pressed together" sang sau 6.30 (đã có trong end pose của 16.3 và 02.1). Tương tự 19.1 ghi "his lips curved in a closed smile" ở 0.00 của người nói: nên bỏ hoặc dời.

**[CẢNH BÁO] (còn lại) — chain 11 vẫn có số nhiều trong tả cảnh: "behind the man and towering over them".**
Trích 11.1 (cả `subject_definitions` và `detailed_description`): "the lunar module standing close behind the man and towering over them".
Hậu quả: "them" gợi người thứ hai trong khung một người; đây là chữ rò cuối cùng của nhóm "the men" đã sửa ở nơi khác.
Cách sửa: đổi thành "towering over him" ở cả hai chỗ.

### GỢI Ý (còn mở hoặc mới)

- **08.1 (mới, do sửa):** Einstein "looking toward <Subject 2>" suốt shot nhưng end pose vẫn "turning his head toward him" (Storyboard 08,1 cũng vậy: đầu "nhìn sang phải về phía Newton", cuối "quay đầu nhìn Newton"). Đổi end pose thành "looking toward <Subject 2>".
- **Tay ra khỏi túi không có bước:** 06.1 (0.00 "holds his right palm flat" trong khi K0 06 có hai tay trong túi), 13.1 (3.00 "points his right index finger", tay đang trong túi), 15.1 (3.00 "waves his right hand"); "a hand" không nói tay nào ở 09.2 và 17.2. Viết "takes his right hand out of his pocket".
- **18.3:** Einstein người nghe "looking up" (cũng trong end pose); nên "raising his eyes toward his own ear while his head stays turned toward <Subject 2>", như đã làm ở 08.2 và 13.1.
- **07.3:** "small turning motion at his hip" chỉ có trong summary và end pose, không có mốc giây; "extends his right arm straight ahead" ở góc high-two chưa nói về phía nào (toward <Subject 1>?).
- **Pull-out ghi "wide" không giải thích (01.1, 08.1, 12.3, 15.1);** shot kế tiếp có định nghĩa "head to toe" nhưng 12.3 là shot cuối chain; thêm "from head to toe".
- **13.3:** "his eyes light up" vẫn là cảm xúc diễn đạt bằng ẩn dụ; 18.1 end pose "like an order".
- **End pose là động tác đang diễn ra:** "nodding" (03.1, 04.3, 09.3, 10.3, 16.3, 17.4), "patting" (18.2); 05.1 "lowers his head slightly, chin still high" tự mâu thuẫn; 05.2 "At 3.00 seconds ... holds his index finger up" không phải thay đổi; mốc 3.00 → 6.30 (3,3 s) trống ở mọi shot.
- **Chỉ đúng ngưỡng 3 kiểu chuyển động:** nếu một trong pull-out, arc, push-in hỏng khi chạy thử thì xuống dưới 3 và phải thêm kiểu khác, nhưng pan và push-in hai người đã bị loại; cân nhắc `arc` hoặc `pull-out` ở một shot nữa.
- **Prompt K0 (ngoài chain):** chain 02, 11, 19 vẫn truyền sheet người vắng mặt và viết "another man who stays outside the frame and is not drawn"; K0 03 "a smug expression", K0 18 "a confident expression", K0 07 "stunned", K0 19 "a proud smile" còn là tính từ trần.
- **Người nền vườn:** vẫn "a man and a woman modestly covered by leaves" (có thể chạm bộ lọc); "A 8-second" trong summary nên là "An 8-second".

## 5. Rủi ro đã biết, không tính là lỗi

- **#58 nhóm chưa chạy thử trên H3, còn lại 10 chain:** pull-out (01.1, 08.1, 12.3, 15.1), arc (06.3), push-in một người (11.1); góc `low-newton` (02, 19), `low-two` (09), `high-two` (07), `single-einstein` (11). Chín chain không có nhóm chưa thử: 03, 04, 05, 10, 13, 14, 16, 17, 18. Chuyển động hai người đã giảm từ 10 shot còn 5 shot (4 pull-out và 1 arc).
- **#57 phông chưa có ảnh:** `orchard_low` (02, 19), `orchard_high` (07), `moon_low` (09), `cliff` (13, 14), `space` (15, 16) = 8 chain; `start_image` của cả 19 chain chưa tồn tại và chưa qua `approve_keyframes.py`.
- **Thoại nhanh hơn mốc 6.30:** bài thử ghi H3 nói câu 14 âm tiết trong ~3,3 s; đoạn trống cuối shot dễ sinh lời thừa; lip-close chưa kiểm chứng.
- **Hình học pull-out là ước tính:** "closer to the centre" chưa đo trên ảnh thật; kiểm khi có K0 và chạy thử.

## 6. Những gì chưa kiểm được

- Hình: không có K0, 5 phông mới chưa dựng; không thấy được hướng nhìn, bóng đổ, người nền khi render.
- Hành vi thật của H3 với chuyển động, góc lạ, tên thật, câu lip-close.
- Số âm tiết là đếm tay (±1); không đo tốc độ thoại thật.
- Nguồn khoa học, hài, chính sách (#26-#51) không xét lại ở đây.
- Prompt K0 chỉ đối chiếu với chain, chưa chạy `qwen_prompt_gate.py`.

## 7. Kết luận

**KHÔNG ĐẠT** (1 lỗi CHẶN, 2 CẢNH BÁO còn mở). Cả hai CHẶN và 13 CẢNH BÁO cũ đã sửa, trừ dư lượng nêu trên; CHẶN còn lại là lệch Storyboard (ba dòng cần chỉnh theo chain). Sửa ba dòng đó là đạt 0 CHẶN.

Đã đạt ở cấp chain: 19 chain 192 khung, 16:9, đủ 6 mục và các câu giữ khung/real-time/cấm chữ ở 51 shot; `<d>` khớp bảng 51/51; một người nói mỗi shot; nhãn và giọng nhất quán; mô tả ngắn khớp bible; không "slowly", "as before"; mỗi shot đúng một chuyển động; mọi chuyển động có điểm cuối, mốc thời gian và người vẫn trong khung; không có shot nào chuyển cảnh trong chain; không còn tên NASA, Apollo, Galileo ngoài `<d>`.

## Xử lý sau lần xác nhận thứ hai (2026-11-11)

- **CHẶN còn mở (#21):** đã cập nhật tư thế cuối của các dòng Storyboard 12,3; 13,2; 18,2 và 08,1 cho khớp chain (mặt hướng về người kia, bỏ "nhìn quanh", "nhìn xuống táo rồi nhìn").
- **CẢNH BÁO:** bỏ nụ cười và mím môi khỏi cử chỉ lúc 3.00 s của người nói ở 10.3 và 16.3; bỏ nụ cười ở 0.00 s của chain 19; chain 11 "over them" thành "over him"; pull-out ghi rõ khung đích ("both men are framed from head to toe").
- **Gợi ý nhỏ đã xử lý:** "a hand" thành "his right hand" (09.2, 17.2); người nghe 18.3 giữ đầu hướng về người nói; bốn K0 (03, 07, 18, 19) thay tính từ cảm xúc trần bằng hành vi.
- **Chưa xử lý:** mốc giờ của động tác nhỏ ở hông (07.3), "straight ahead" chưa có hướng, một số tư thế cuối là hành động đang diễn ra, K0 chain 02, 11, 19 vẫn gửi sheet của người vắng mặt (đã chọn). **Các sửa ở mục này chỉ tự kiểm bằng `check_chain.py` và đọc lại, không có vòng review độc lập thứ ba.**
