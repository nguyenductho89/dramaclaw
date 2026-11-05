#!/usr/bin/env python3
"""Generate ep01-script.md and the four test chains, and print measured word/layer/syllable counts."""
import json, re
from pathlib import Path

ROOT = Path("/Users/nguyenductho/XuongPhim/dramaclaw")
OUT = ROOT / "examples/science-humor/ep01-script.md"
CHAINS = ROOT / "previs_h3_test/scripts/skits/science_humor/ep01"

F, B, M, T = "H3 mặt", "H3 B-roll", "Manim", "Three.js"
# (layer, seconds, picture, speech, joke, sources)
rows = [
 (F, 8, "Chain 01 shot 1. Bếp, Barnaby nhìn ống kính", "Today, I defeat the most dangerous thing in my kitchen.", "Tự cao quá mức", ""),
 (F, 8, "Chain 01 shot 2. Ông chỉ vào đĩa bánh mì", "This. Buttered toast. It has ruined eleven breakfasts.", "Bánh mì là kẻ thù", ""),
 (B, 8, "Lát bánh trượt khỏi đĩa, rơi xuống sàn bếp, mặt bơ úp", "Everyone swears by the rule: drop your toast, and it lands butter-side down. Is that real, or are we all just bitter?", "Chơi chữ butter/bitter", ""),
 (F, 8, "Chain 02 shot 1", "Today: the physics, three fixes, one ruined cardigan.", "Báo trước cái áo", ""),
 (F, 8, "Chain 02 shot 2", "First, the evidence. Is this even true?", "", ""),
 (M, 8, "Đồng xu và số 300 lần tung, 50/50, gạch đi", "The BBC once threw buttered bread three hundred times. About fifty-fifty. Case closed? No. Who throws bread at breakfast? Toast slides off.", "Ai ném bánh mì lúc ăn sáng", "S1"),
 (B, 12, "Tấm ván ép trên bàn, hộp cát bên dưới", "Good news: somebody checked that too. In 2001, three researchers tipped a stand-in for toast off a table seventy-six centimeters high, about two and a half feet.", "", "S2"),
 (B, 8, "Tấm ván rơi vào cát, cát bắn lên", "It was a plywood board. No bread. No butter. Just three adults dropping wood into a sandbox, for science.", "Ba người lớn thả gỗ vào cát", "S2"),
 (M, 20, "Trục độ nhô từ 0 đến 5,1 cm: vùng úp 0-0,8 và 2,7-5,1, vùng ngửa ở giữa; hiện 63% và tên Bacon, Heald, James", "Bacon, Heald and James changed how far the board hung over the edge. By their numbers, about two thirds of that range ends with the pretend butter side down. So, not always. And you don't need butter for it.", "", "S2, C1"),
 (F, 8, "Chain 03 shot 1", "The butter is innocent. I owe it an apology.", "Xin lỗi miếng bơ", "S2"),
 (F, 8, "Chain 03 shot 2", "So who did it? Let's watch the crime in slow motion.", "Điều tra vụ án", ""),
 (T, 32, "Mô phỏng 3D lát bánh trượt qua mép bàn, nghiêng, rời bàn, có đồng hồ độ/giây; ghi rõ trường hợp giới hạn", "Toast doesn't fall flat. It slides until its middle has barely passed the table edge, by less than a millimeter. It has excellent balance, right up until it doesn't. Then gravity pulls the overhanging side down while the table holds up the other side. So it tips, and it starts to spin. In the most generous version of the model, it has turned ninety degrees when it leaves the table. In 1995, Robert Matthews worked out the spin. Using his numbers, I get about two hundred and forty degrees a second.", "Thăng bằng giỏi cho tới khi hết giỏi", "S1, C1"),
 (B, 12, "Lát bánh giữa không trung, sàn bếp lờ mờ phía dưới, chiếu chậm; thêm lúc dựng đồng hồ 0,36 s từ cảnh Three.js", "That sounds fast. It isn't. A normal table gives your toast only about a third of a second in the air. So it turns about ninety more degrees.", "", "S1, C1"),
 (T, 18, "Cùng mô phỏng, cộng dồn 90° + 88°, mặt bơ quay xuống đúng lúc chạm sàn", "Up to ninety from tipping. Ninety in the air. That's about half a turn. The butter started on top, so now it's roughly underneath, and the floor is arriving. The toast is simply halfway through a full flip at the worst possible moment.", "Sàn nhà đang lao tới", "S1, C1"),
 (F, 8, "Chain 04 shot 1", "So toast isn't cursed. It just runs out of time.", "", "S1"),
 (M, 18, "Sơ đồ phân biệt mô hình và đo thật, tốc độ quay 6,9-12,6 rad/s", "A warning, before anyone writes in. This is a simple model, and it ignores bouncing. Those plywood tests found faster spins, because boards slip at the edge. And any slice sliding off starts with a tiny overhang, in that first butter-down band. Tip it much less, though, and the model stops agreeing.", "Trước khi có người viết thư", "S1, S2"),
 (F, 8, "Chain 04 shot 2", "A time problem? Fine. I can fix time.", "Tự tin quá mức", ""),
 (F, 8, "Xưởng. Barnaby giơ một ngón tay", "Fix one. A taller table. About three meters.", "", "S1"),
 (M, 14, "Công thức thời gian rơi, chiều cao tăng tới 2,84 m", "The toast needs more falling to finish its flip. With Matthews's numbers, I get two point eight four meters, a little over nine feet. That buys it three quarters of a second, and the butter comes back around.", "", "S1, C1"),
 (F, 8, "Xưởng. Ông nhìn lên trên", "Nine feet. For one slice of toast.", "Phản ứng im lặng", "C1"),
 (B, 20, "Chiếc bàn chân rất dài trong xưởng cao, thang tựa vào bàn, tách cà phê trên bậc thang", "My kitchen ceiling is lower than that, which was the first problem. So I moved breakfast to the workshop. The second problem is that coffee doesn't enjoy ladders. According to the sums, the toast should now land butter-side up. Nobody has been brave enough to go up there and knock it off.", "Bữa sáng trên thang", "C1"),
 (F, 8, "Xưởng. Ông bám thang", "Breakfast is now a climbing sport. I don't recommend it.", "Leo núi để ăn sáng", ""),
 (F, 8, "Bếp", "Fix two. If the table can't grow, the toast can shrink.", "", "S1"),
 (T, 14, "So sánh lát bánh thường và lát 2,5 cm cùng rơi, lát nhỏ lật đủ vòng", "A smaller slice is far easier to turn, so it spins faster. Matthews says about two and a half centimeters across, roughly one inch. In that model it finishes the flip with just five degrees to spare.", "", "S1, C1"),
 (B, 10, "Lát bánh nhỏ xíu trên đĩa lớn", "So I made one. It's the size of a postage stamp, and it holds about one crumb of butter. It's a crouton with ambitions.", "Crouton có hoài bão", ""),
 (F, 8, "Bếp. Đĩa bánh nhỏ", "In theory, it works. I've eaten nine. I'm still hungry.", "", ""),
 (F, 8, "Xưởng", "Fix three. Don't let it tip at all. Launch it.", "", "S1"),
 (T, 14, "Lát bánh bay ngang ở tốc độ khác nhau, ngưỡng 1,6 m/s", "Tipping needs time on the edge. Matthews calculated that above about one point six meters per second, roughly a brisk walk, toast leaves before tumbling can take over. So a hard enough shove should save it.", "", "S1, C1"),
 (B, 20, "Máy bắn bằng dây chun lớn trên ray gỗ, lát bánh bay ngang qua xưởng", "And so, the Toast Cannon, which exists only in this video, so please don't build one. One big rubber band, one wooden rail, eleven imaginary hours. I set it well above the required speed. In my telling, the toast didn't tumble. It flew dead straight, edge first, across the workshop. It didn't land on the floor, either.", "Máy bắn bánh mì", "S1"),
 (F, 8, "Xưởng. Áo cardigan dính vệt bơ", "It works. It also found my cardigan.", "Trả cái áo đã báo trước", ""),
 (F, 8, "Xưởng. Áo dính bơ", "Butter side in. On wool.", "", ""),
 (M, 20, "Chuỗi bàn, chiều cao người, hằng số vật lý", "Matthews then went further, half in fun, building on an idea from William Press. He argued that human height, and so table height, traces back to the fundamental constants of nature. So your falling toast is, in his telling, built into the universe. A playful argument, not settled physics. It won him an Ig Nobel Prize in 1996.", "Vũ trụ chống bánh mì", "S1, S3, S4"),
 (B, 12, "Lát bánh trên đĩa, ánh sáng sớm, đẩy nhẹ về phía mép", "So there you have it. In Matthews's model, beating the universe takes a nine-foot table, a one-inch slice, or a cannon. Or you can keep your hand on the plate.", "", "S1, C1"),
 (F, 8, "Bếp. Đĩa ở mép bàn", "Final result. Experiment one: toast, three. Me, nil.", "", ""),
 (F, 8, "Bếp", "The most dangerous thing in my kitchen. Still undefeated.", "Quay lại câu mở đầu", ""),
 (F, 8, "Bếp. Ông chỉ tay vào ống kính, tìm bút chì", "Next time: why your voice sounds awful. Mine, I mean.", "Dẫn sang tập 2", ""),
 (F, 8, "Bếp. Không thoại: ông đưa tay ra khỏi khung, tiếng rơi nhẹ ngoài khung, ông đứng yên nhìn xuống. Chỉ một tiếng thịch nhỏ, không phải tiếng đổ vỡ", "", "Nhịp im lặng cuối", ""),
]

VOWELS = re.compile(r"[aeiouy]+")
def syllables(text):
    n = 0
    for w in re.findall(r"[a-zA-Z']+", text.lower()):
        c = len(VOWELS.findall(w))
        if w.endswith("e") and not w.endswith("le") and c > 1:
            c -= 1
        if w.endswith("ed") and not re.search(r"[td]ed$", w) and c > 1:
            c -= 1
        n += max(c, 1)
    return n

def stamp(s): return f"{s//60}:{s%60:02d}"
t = 0; lines = []; totals = {F:0,B:0,M:0,T:0}; words = {F:0,B:0,M:0,T:0}
for layer, sec, pic, speech, joke, src in rows:
    lines.append(f"| {stamp(t)}-{stamp(t+sec)} | {layer} | {pic} | {speech} | {joke} | {src} |")
    t += sec; totals[layer] += sec; words[layer] += len(speech.split())
    rate = len(speech.split())/sec
    if layer == F and syllables(speech) > 16: print("TOO LONG FACE", syllables(speech), speech)
    if layer != F and rate > 2.9: print("FAST VO", round(rate,2), sec, speech[:50])
    if layer == F: assert sec == 8
tw = sum(words.values())
pct = {k: round(v*100/t) for k,v in totals.items()}
ill = pct[M]+pct[T]
print("total", stamp(t), "words", tw, totals, words, pct)
gaps=0; last=0; x=0
for layer,sec,pic,speech,joke,src in rows:
    if joke: gaps=max(gaps,x-last); last=x
    x+=sec
print("max gap between jokes", gaps)

head = f"""# Ep 01: Why does toast land butter-side down?

Tổng: {stamp(t)}, {tw} từ. Mặt {pct[F]}%, B-roll {pct[B]}%, minh hoạ {ill}%.

Mạch tập: câu hỏi, bằng chứng, cơ chế, ba cách sửa đều thành công theo cách vô dụng, kết bằng thua cuộc. Đo bằng script, số từ và tỉ lệ có thể lệch vài đơn vị với cách đếm khác.

Chain 01-04 đã viết để thử 60 giây ở bước 3; các chain còn lại viết ở bước 4 sau khi cổng đạt.

| Mốc | Lớp | Hình | Lời | Trò đùa | Nguồn |
|---|---|---|---|---|---|
"""
tail = """
## Nguồn

- **S1:** R. A. J. Matthews, "Tumbling toast, Murphy's Law and the fundamental constants", Eur. J. Phys. 16:172 (1995). [DOI](https://iopscience.iop.org/article/10.1088/0143-0807/16/4/005). Đã đọc bản OCR trên [Fermat's Library](https://www.fermatslibrary.com/s/tumbling-toast-murphy-s-law-and-i-i-the-fundamental-constants); phải đối chiếu ký hiệu với PDF trước khi đăng. Dùng cho: cơ chế, số liệu mô hình, ngưỡng 3 m, 2,5 cm, 1,6 m/s, thử nghiệm BBC 300 lần (chương trình BBC-TV về Luật Murphy, Matthews trích lại; chưa xem bản gốc), lập luận hằng số cơ bản. 90° khi nghiêng là trường hợp giới hạn của mô hình, không phải giá trị đo.
- **S2:** Bacon, Heald & James, "A closer look at tumbling toast", Am. J. Phys. 69:38 (2001). [DOI](https://doi.org/10.1119/1.1289213). Đã đọc. Dùng cho: ván ép, 76 cm, hộp cát, các dải độ nhô, tốc độ quay thật, trượt ở mép. Bảng đo chỉ tới 3,7 cm; mốc 5,1 cm đến từ tính toán, nên lời nói "by their numbers". Tốc độ quay thật cao hơn mô hình của Matthews nên các ngưỡng đều ghi là "In Matthews's model".
- **S4:** W. H. Press, Am. J. Phys. 48:597-8 (1980). Chưa đọc; thông tin lấy từ danh mục tham khảo của Matthews, ông ghi lập luận của mình "similar to that of Press". Dùng cho: ghi công Press.
- **S3:** [Danh sách Ig Nobel](https://improbable.com/ig/winners/), Physics 1996. Đã đọc.

Không dùng thí nghiệm trường học tài trợ bởi hãng bơ (khoảng 62% úp): mới thấy qua đoạn trích của một bản đăng lại, chưa mở được và không có báo cáo bình duyệt.

## Tính lại

Lệnh: `python3 previs_h3_test/scripts/skits/science_humor/ep01/toast_calc.py` (C1)

```text
overhang past centre: 0.75 mm
spin: 4.20 rad/s = 241 deg/s
time in the air at 75 cm: 0.364 s
turn in the air: 88 deg; with 90 deg of tipping: 178 deg
minimum table height for butter-up: 2.84 m = 9.3 ft; time in the air 0.75 s
toast 2.5 cm across: 8.40 rad/s, 0.384 s, turn 185 deg in the air (needs > 180): butter up
1.6 m/s = 3.6 mph
plywood: butter-down share of overhang range 0-5.1 cm = 63%
76 cm = 2.5 ft
```

Thời gian rơi 0,364 s dùng đúng phương trình 6 của Matthews, τ = √(2(h − 2a)/g), nên quãng rơi là h − 2a = 65 cm, không phải 75 cm; rơi tự do cả 75 cm sẽ là 0,391 s. Mô hình dùng bàn 75 cm của Matthews; 76 cm trong lời là bàn thật của Bacon, Heald & James, hai số này không thay nhau được.

Các con số 240°/s, 88° và 2,84 m là tôi tính từ công thức của Matthews, nên lời thoại nói "I get", không gán cho ông. Riêng 1,6 m/s và 2,5 cm là con số của Matthews, 3,6 mph tương ứng đi bộ nhanh là nhận định của tôi.

## Cần người bản ngữ đọc

- "or are we all just bitter?": chơi chữ có tự nhiên không?
- "It's a crouton with ambitions."
- "Who throws bread at breakfast?"
- Barnaby có âm sắc Anh nên giữ "nil"; xem người Mỹ có hiểu không.
- "It has excellent balance, right up until it doesn't."
- "coffee doesn't enjoy ladders"

## Kiểm tra lại với hình

- Lát bánh H3 chỉ dùng cho hài và kết quả chung, chưa chắc khớp vật lý từng khung. Phần cần đúng số nằm ở Three.js và Manim.
- Bàn cao, lát bánh nhỏ và máy bắn là hư cấu của nhân vật, chưa ai đo. Lời nói rõ "according to the sums", "in theory" và "exists only in this video".
- Máy bắn dùng dây chun, không dùng lò xo mạnh, và có lời dặn đừng tự làm.
"""
OUT.write_text(head + "\n".join(lines) + "\n" + tail)

STYLE = "Live-action film footage, horizontal 16:9 framing, a modern home science vlog, soft morning daylight from the right, realistic detail, natural skin tones, cinematic comedy."
BODY = "Barnaby (S1), a cheerful 70-year-old man with messy curly silver-white hair, a clean-shaven round face, thick black square-rimmed glasses, a mustard-yellow wool cardigan over a blue checked shirt, and a stubby pencil tucked behind his right ear"
SET = "a small modern home kitchen with pale green cabinets on the back wall and a window on the right letting in soft morning daylight"
TABLE = "A plain wooden table runs across the bottom of the frame. A white ceramic plate holding one slice of golden buttered toast, butter side up, sits on the table in the left third of the frame."
VOICE = "in a warm, dry, amused voice with a light English accent, the voice in <Audio 1>"
END = "The camera holds this framing until the final frame. All motion happens at natural real-time speed, not slow motion. There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame."
SOUND = "A quiet kitchen with a faint refrigerator hum and soft birdsong outside the window."

def shot(n, before, line, after, final):
    return (f"integrated_multimodal_description:\n{STYLE}\n[Shot {n}] A static horizontal medium shot at eye level in {SET}. {BODY}, stands in the center of the frame behind the table and faces the lens, with clear space above his head. {TABLE} "
            f"{before} At 1.00 seconds Barnaby (S1) says {VOICE}: <d>[English] {line}</d> {after} At {5.00 if syllables(line) <= 10 else 6.50:.2f} seconds he finishes. {final} {END}\n\noverall_soundscape:\n{SOUND}\n\nnon_diegetic_music:\nN/A")

KEY = f"Photorealistic film still, horizontal 16:9. {BODY.replace(' (S1)','')}, stands in the center of the frame behind a table and faces the lens, with clear space above his head, in {SET}. {TABLE} Natural skin texture, shallow depth of field. No text, logos or watermarks."
EDIT = (f"In <image1>, change only the plain grey background to {SET}. Add a plain wooden table across the bottom of the frame in front of the man, with a white ceramic plate holding one slice of golden buttered toast, butter side up, in the left third of the frame. {{pose}} Keep the man's face, hair, glasses, cardigan, shirt and pencil exactly as they are.")
POSES = {1: "He faces the lens with his hands resting on the table and his chin lifted.", 2: "He faces the lens with his hands resting on the table.", 3: "He looks down at the plate with his hands resting on the table.", 4: "He faces the lens with his hands resting on the table."}
script = {
 1: [("At 0.00 seconds Barnaby faces the lens with his hands resting on the table and his chin lifted.", "Today, I defeat the most dangerous thing in my kitchen.", "At 4.00 seconds he narrows his eyes and raises his right index finger.", "He ends with his finger raised and his eyes narrowed at the lens."),
     ("At 0.00 seconds Barnaby faces the lens with his right index finger raised.", "This. Buttered toast. It has ruined eleven breakfasts.", "At 1.50 seconds he lowers his hand and points at the plate, and at 4.00 seconds he looks back at the lens and raises his eyebrows.", "He ends pointing at the plate, eyebrows raised, looking at the lens.")],
 2: [("At 0.00 seconds Barnaby faces the lens with his hands resting on the table.", "Today: the physics, three fixes, one ruined cardigan.", "At 3.50 seconds he glances down at his cardigan and brushes it with his left hand.", "He ends with his left hand resting on his cardigan, looking at the lens."),
     ("At 0.00 seconds Barnaby faces the lens with his left hand resting on his cardigan.", "First, the evidence. Is this even true?", "At 1.50 seconds he lowers his left hand to the table and at 3.00 seconds he tilts his head to one side and lifts one eyebrow.", "He ends with his head tilted and one eyebrow lifted, looking at the lens.")],
 3: [("At 0.00 seconds Barnaby looks down at the plate with his hands resting on the table.", "The butter is innocent. I owe it an apology.", "At 4.00 seconds he gives the plate one small solemn nod.", "He ends looking down at the plate with his lips pressed."),
     ("At 0.00 seconds Barnaby looks down at the plate with his hands resting on the table.", "So who did it? Let's watch the crime in slow motion.", "At 1.50 seconds he looks up at the lens and at 4.00 seconds he leans a little toward it and narrows his eyes.", "He ends leaning a little toward the lens with his eyes narrowed.")],
 4: [("At 0.00 seconds Barnaby faces the lens with his hands resting on the table.", "So toast isn't cursed. It just runs out of time.", "At 3.50 seconds he taps his left wrist twice with his right index finger.", "He ends with his right finger on his left wrist, looking at the lens."),
     ("At 0.00 seconds Barnaby faces the lens with his right finger on his left wrist.", "A time problem? Fine. I can fix time.", "At 2.00 seconds he drops his hands to the table and at 4.00 seconds he lifts his chin.", "At 7.00 seconds he smiles with his lips closed and holds that pose.")],
}
for c, shots in script.items():
    for s in shots:
        print(c, syllables(s[1]), s[1])
    d = {"name": f"science_humor_ep01_chain_{c:02d}", "scene": "kitchen", "aspect_ratio": "16:9", "frames": 192, "checkpoint": "ref2va",
         "voice_ref": "previs_h3_test/scripts/skits/science_humor/voice/voice_ref.wav",
         "turbo_lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "turbo_steps": 12,
         "start_image": f"previs_h3_test/scripts/skits/science_humor/ep01/keyframes/chain_{c:02d}.png",
         "keyframe_prompt": KEY, "keyframe_edit_prompt": EDIT.format(pose=POSES[c]), "shots": [shot(i+1, *s) for i, s in enumerate(shots)]}
    (CHAINS / f"chain_{c:02d}.json").write_text(json.dumps(d, indent=1, ensure_ascii=False) + "\n")
