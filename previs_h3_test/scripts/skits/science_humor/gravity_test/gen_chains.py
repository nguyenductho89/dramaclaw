#!/usr/bin/env python3
"""Generate the gravity test script, its two H3 chains, and the Qwen prompts.

  python3 previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py

Qwen-Image only makes the character sheets and the empty backgrounds; H3 puts the two men into the scene.
Two ways of using the background are written out for the first-shot test:
  chain_NN.json             background is the first frame (start_image), so the men walk in during shot 1
  chain_NN_refs_only.json   background is only a reference image, so the men can be there from frame 0
<Picture N> numbering is the same in both: 1 background, 2 Barnaby, 3 Ambrose. <Audio 1> is Barnaby, <Audio 2> is Ambrose.
The prompt layout follows the ref2va branch of assemble_minimax_h3_prompt (agents/minimax_h3_prompt_builder.py).
Syllable counts are hand-counted in LINES; the review skill recounts them.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
SKIT = "previs_h3_test/scripts/skits/science_humor"
OUT_DIR = ROOT / SKIT / "gravity_test"
SCRIPT = ROOT / "examples/science-humor/gravity-test-script.md"

BARNABY_ANCHOR = "messy curly silver-white hair, a clean-shaven round face, thick black square-rimmed glasses, a mustard-yellow cardigan and a pencil behind his right ear"
AMBROSE_ANCHOR = "a long wavy silver wig, a long dark brown coat and a white linen cravat"
SCENES = {
    "orchard": {
        "place": "an old English apple orchard at golden evening, rows of apple trees heavy with red apples in the background, soft low sunlight from behind the camera and slightly to the left",
        "light": "soft low evening sunlight from behind the camera and slightly to the left",
        "sound": "A quiet orchard in the evening with soft birdsong and a light breeze in the leaves.",
        "name": "Vườn táo",
        "plate": ("Photorealistic horizontal film still of an empty old English apple orchard at golden evening. Eye-level camera, with the horizon about two-thirds of the way up the frame. Untouched open grass "
                  "below it, rows of apple trees heavy with red apples in the background, slightly out of focus. "
                  "Soft low sunlight from behind the camera and slightly to the left, soft gentle contrast, natural colours, natural film look. "
                  "A calm, empty orchard."),
    },
    "moon": {
        "place": "the grey dusty surface of the Moon, a black starless sky above, the blue Earth small, just above the horizon near the center of the frame, low white sunlight from behind the camera and slightly to the left",
        "light": "low white sunlight from behind the camera and slightly to the left",
        "sound": "Complete, empty silence with no wind and no ambient sound, only the voice of whoever is speaking.",
        "name": "Mặt Trăng",
        "plate": ("Photorealistic horizontal film still of the empty grey dusty surface of the Moon. Eye-level camera, with the horizon about two-thirds of the way up the frame. An undisturbed expanse of flat grey dust "
                  "below it, a pure black sky, the blue Earth small, just above the horizon near the center of the frame. "
                  "Low white sunlight from behind the camera and slightly to the left, soft gentle contrast, natural film look. "
                  "A silent, empty lunar plain."),
    },
}
SHEETS = {
    "barnaby": ("Photorealistic horizontal character reference photograph of one fictional man, shown twice side by side at the same size from the waist up: "
                "facing the lens on the left half, and turned toward the right of the frame on the right half. A cheerful 70-year-old with messy curly silver-white hair, "
                "a clean-shaven round face and a clean-shaven upper lip, thick black square-rimmed glasses, a mustard-yellow wool cardigan over a blue checked shirt, and a stubby pencil tucked behind his "
                "right ear. Friendly closed-mouth expression. Plain light grey studio background with nothing else in the image, the two views separated only by empty grey space, soft even studio light, natural skin."),
    "ambrose": ("Photorealistic horizontal character reference photograph of one fictional man, shown twice side by side at the same size from the waist up: "
                "facing the lens on the right half, and turned toward the left of the frame on the left half. A lean, proud 65-year-old with a long narrow face, a long wavy silver "
                "wig falling past his shoulders, a long dark brown late-17th-century coat and a white linen cravat. Calm closed-mouth expression, chin slightly raised. "
                "Plain light grey studio background with nothing else in the image, the two views separated only by empty grey space, soft even studio light, natural skin."),
}
FRAMES = 192  # 17k+5 grid, 8 s. The generator notes that dialogue shots under 192 frames make the shot join clip audibly (runpod_minimax_h3_multishot_video.py).
SPEECH_END = 6.30  # in the ep01 test H3 said a 14-syllable line in about 3.3 s and spoke again in the empty tail, so every line is followed by the official lip-close sentence
VOICE = {
    "Barnaby": "a warm, dry, amused voice with a light English accent, the voice in <Audio 1>",
    "Ambrose": "a low-pitched, crisp, formal, proud voice with a refined English accent, the voice in <Audio 2>",
}
SUBJECT = {"Barnaby": "<Subject 1> (S1)", "Ambrose": "<Subject 2> (S2)"}
B, A = "<Subject 1>", "<Subject 2>"

# chain, scene, speaker, line, syllables, joke, sources, speech start, opening actions, mid action, listener action, end state, summary
LINES = [
    (1, "orchard", "Ambrose", "The Earth pulls the apple down. Newton settled this.", 12, "Ambrose tưởng đã xong chuyện", "S2", 1.75,
     f"At 0.00 seconds {B} walks into frame from the left edge, his hands in his cardigan pockets, and {A} walks into frame from the right edge, holding a red apple in his left hand. At 1.50 seconds they stop in their places",
     f"At 3.00 seconds {A} taps the apple with his right forefinger. At 4.30 seconds {A} lowers his right hand, lifts his chin and raises the apple to chest height", f"{B} stays silent with closed lips, his hands in his cardigan pockets, and nods politely",
     f"{A} with his chin raised and the apple held up at chest height, and {B} with his hands in his pockets", f"{A} explains the falling apple to {B}"),
    (1, "orchard", "Barnaby", "Lovely. But to Einstein, gravity isn't a pull.", 13, "Một câu làm hỏng cả vườn táo", "S2", 1.00,
     f"At 0.00 seconds {B} looks at {A}, his hands in his cardigan pockets",
     f"At 3.00 seconds {B} takes his right hand from his pocket and points at the apple", f"{A} stays silent with closed lips, holding the red apple at chest height in his left hand, and his eyebrows draw together",
     f"{B} pointing at the apple, and {A} staring at him with his eyebrows drawn together", f"{B} points at the apple and contradicts {A}"),
    (1, "orchard", "Ambrose", "Not a pull? Newton's laws still work for a great many things.", 14, "", "S3", 1.00,
     f"At 0.00 seconds {A} stares at {B}, holding the red apple at chest height in his left hand, and {B} lowers his right hand to his side",
     f"At 3.00 seconds {A} raises his right forefinger", f"{B} stays silent with closed lips and tilts his head",
     f"{A} with his right forefinger raised, and {B} with his head tilted", f"{A} raises one finger and objects"),
    (1, "orchard", "Barnaby", "Quite. But mass bends spacetime. The apple just takes the straightest path.", 15, "Nghe vô lý mà đúng trong lý thuyết", "S2", 1.00,
     f"At 0.00 seconds {B} nods once at {A}, his right hand at his side",
     f"At 3.00 seconds {B} raises his right hand, flat, and moves it down in a straight line from chest height to waist height, away from {A}", f"{A} stays silent with closed lips, lowers his right hand, and looks down at the red apple in his left hand",
     f"{B} with his right hand held flat at waist height, and {A} looking at the apple", f"{B} moves one flat hand straight down while {A} looks at his apple"),
    (2, "moon", "Ambrose", "Where is the orchard? And why am I on the Moon?", 12, "Cắt cảnh không báo trước", "", 1.75,
     f"At 0.00 seconds {B} walks into frame from the left edge, his hands in his cardigan pockets, and {A} walks into frame from the right edge, clutching a red apple to his chest with his left hand. At 1.50 seconds they stop in their places and {A} turns to {B}",
     f"At 3.00 seconds {A} lifts his right hand, palm up", f"{B} stays silent with closed lips, his hands in his cardigan pockets, and looks around at the small blue Earth in the distance",
     f"{A} with his right hand lifted, palm up, staring at {B}, and {B} looking at the small blue Earth in the distance with his hands in his pockets", f"{A} asks {B} why they are on the Moon"),
    (2, "moon", "Barnaby", "Better view. Also, there's no air, so talk fast.", 11, "Đùa về việc không có không khí, dựng sẵn cho câu sau", "S1", 1.00,
     f"At 0.00 seconds {B} turns to look at {A}, his hands in his cardigan pockets",
     f"At 3.00 seconds {B} takes both hands out and pats his cardigan pockets as if looking for something", f"{A} stays silent with closed lips, lowers his right hand, clutches the red apple to his chest with his left hand, glances at the small blue Earth in the distance, and looks back at {B} with wide eyes",
     f"{B} with both hands on his pockets, and {A} staring at him with wide eyes", f"{B} tells {A} there is no air while patting his pockets"),
    (2, "moon", "Barnaby", "Apollo Fifteen: hammer and feather, landed together.", 15, "", "S1", 1.00,
     f"At 0.00 seconds {B} looks at {A}, with both hands on his pockets",
     f"At 3.00 seconds {B} lifts his right hand and points down at the ground below the frame, and {A} looks down", f"{A} stays silent with closed lips, clutching the red apple to his chest with his left hand",
     f"{B} pointing at the ground, and {A} looking at the ground", f"{B} points down at the ground"),
    (2, "moon", "Ambrose", "Of course. Galileo told you so. You're welcome.", 12, "Ambrose giành công cho khoa học cổ điển", "S1", 1.00,
     f"At 0.00 seconds {A} lifts his chin and looks at {B}, clutching the red apple to his chest with his left hand, and {B} lowers his right hand to his side",
     f"At 4.30 seconds {A} lifts the apple away from his chest to shoulder height", f"{B} stays silent with closed lips and raises both eyebrows",
     f"{A} with his chin high and the apple raised, and {B} looking at him with raised eyebrows", f"{A} takes the credit with his chin high"),
]


def definitions(scene: str, first_shot: bool, first_frame: bool) -> tuple[str, str]:
    subjects = (f"<Subject 1> is Barnaby, shown in <Picture 2> (one man in two views, not two people), with {BARNABY_ANCHOR}.\n"
                f"<Subject 2> is Ambrose, shown in <Picture 3> (one man in two views, not two people), with {AMBROSE_ANCHOR}.")
    retention = (f"<Subject 1> (appears in [Shot 1]): fully_preserved - {BARNABY_ANCHOR}, consistent for the whole video.\n"
                 f"<Subject 2> (appears in [Shot 1]): fully_preserved - {AMBROSE_ANCHOR}, consistent for the whole video.")
    if first_frame and not first_shot:
        # The background only went in as shot 1's first frame: H3 carries on from the last frame, so no image stands for it here.
        return subjects, retention
    if first_frame and first_shot:
        return (f"<Picture 1> is the first frame of [Shot 1], showing {SCENES[scene]['place']}, with nobody in frame yet.\n{subjects}",
                f"<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from its framing and lighting, and the background stays the same when the men walk in.\n{retention}")
    return (f"<Picture 1> shows the setting: {SCENES[scene]['place']}.\n{subjects}",
            f"<Picture 1> (setting): partially_preserved - {SCENES[scene]['place']}, used as the location for the whole video.\n{retention}")


def shot(index: int, line: tuple, first_frame: bool) -> str:
    # Each shot's prompt stands alone and is labelled [Shot 1], as in the official layout and its lint.
    _, scene, speaker, text, _, _, _, start, opening, mid, listener, end, summary = line
    seconds = FRAMES / 24
    entering = index == 1 and first_frame
    if index == 1 and not first_frame:
        # Without a first frame the men are already standing there, so the walk-in sentence becomes a static opening.
        opening = opening.split(" At 1.50 seconds")[0]
        opening = re.sub(r"walks into frame from the (left|right) edge", "stands in place", opening).rstrip(".")
    defs, retention = definitions(scene, index == 1, first_frame)
    begins = " that begins from <Picture 1>" if entering else ""
    setting = f"in the setting of <Picture 1>, keeping its layout and light" if index == 1 or not first_frame else f"in this setting: {SCENES[scene]['place']}"
    return (
        f"subject_definitions:\n{defs}\n\n"
        f"summary:\nA {seconds:.0f}-second 16:9 static medium two-shot{begins}. {summary}. Ends with {end}.\n\n"
        f"retention_analysis:\n{retention}\n\n"
        "detailed_description:\n"
        f"Live-action film footage, horizontal 16:9 framing, a science comedy, {SCENES[scene]['light']}, soft gentle contrast, natural skin tones, natural film look.\n"
        f"[Shot 1] {'The shot begins from <Picture 1>: a' if entering else 'A'} static horizontal medium two-shot at eye level {setting}. "
        f"{'Once they have walked in, ' if entering else ''}<Subject 1> stands in the left third of the frame and <Subject 2> stands in the right third, each seen from the thighs up, the same size, the same distance from the camera, at life-size scale with the setting, "
        f"both turned three-quarters toward each other and toward the camera so both faces stay clearly visible, with clear space above their heads. "
        f"{opening}. At {start:.2f} seconds {SUBJECT[speaker]} says it in {VOICE[speaker]}: <d>[English] {text}</d> Exactly as the voice stops, the lips close and the jaw ceases all speaking motion. This single line is the only speech in the video. {listener}. {mid}. "
        f"At {SPEECH_END:.2f} seconds {SUBJECT[speaker][:11]} finishes, and both stay silent with closed lips until the final frame. "
        "Do not replace character action with camera movement, lighting changes, particles, fog, or environmental effects. "
        f"All motion happens at natural real-time speed, not slow motion. The camera holds this framing until the final frame. At {seconds:.2f} seconds, the shot ends on {end}. "
        "There are no subtitles, captions, on-screen text, logos or watermarks anywhere in frame.\n\n"
        f"overall_soundscape:\n{SCENES[scene]['sound']}\n\nnon_diegetic_music:\nN/A"
    )


def main() -> None:
    chains: dict[int, list[tuple]] = {}
    for line in LINES:
        chains.setdefault(line[0], []).append(line)
    plate = f"{SKIT}/gravity_test/backgrounds"
    sheets = [f"{SKIT}/character/barnaby_sheet.png", f"{SKIT}/character/ambrose_sheet.png"]
    for stale in OUT_DIR.glob("chain_*.json"):
        stale.unlink()
    for num, lines in chains.items():
        scene = lines[0][1]
        base = {
            "scene": scene,
            "aspect_ratio": "16:9",
            "frames": FRAMES,
            "checkpoint": "ref2va",
            "voice_refs": [f"{SKIT}/voice/barnaby.wav", f"{SKIT}/voice/ambrose.wav"],
            "turbo_lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
            "turbo_steps": 12,
        }
        first_frame = {**base, "name": f"science_humor_gravity_test_chain_{num:02d}", "start_image": f"{plate}/{scene}.png", "reference_images": sheets,
                       "shots": [shot(i, line, True) for i, line in enumerate(lines, start=1)]}
        refs_only = {**base, "name": f"science_humor_gravity_test_chain_{num:02d}_refs_only", "start_image": None, "reference_images": [f"{plate}/{scene}.png", *sheets],
                     "shots": [shot(i, line, False) for i, line in enumerate(lines, start=1)]}
        (OUT_DIR / f"chain_{num:02d}.json").write_text(json.dumps(first_frame, ensure_ascii=False, indent=1) + "\n")
        (OUT_DIR / f"chain_{num:02d}_refs_only.json").write_text(json.dumps(refs_only, ensure_ascii=False, indent=1) + "\n")
    (OUT_DIR / "qwen_prompts.json").write_text(json.dumps({
        "note": "Qwen-Image 2.1, text-to-image at 1344x768. Research and evaluation licence: test output only.",
        "sheets": SHEETS,
        "backgrounds": {k: v["plate"] for k, v in SCENES.items()},
    }, ensure_ascii=False, indent=1) + "\n")

    seconds = FRAMES / 24
    rows, words = [], {"Barnaby": 0, "Ambrose": 0}
    prev: dict[int, int] = {}
    rates: list[float] = []
    stamp = lambda t: f"{int(t // 60)}:{t % 60:04.1f}"
    for k, line in enumerate(LINES):
        num, scene, speaker, text, syl, joke, src, start, *_ = line
        prev[num] = prev.get(num, 0) + 1
        words[speaker] += len(re.findall(r"[\w']+", text))
        rows.append(f"| {stamp(k * seconds)}-{stamp((k + 1) * seconds)} | {num:02d}, {prev[num]} | {SCENES[scene]['name']} | {speaker} | {text} | {joke} | {src} |")
        rates.append(syl / (SPEECH_END - start))
        print(f"chain {num} {speaker}: {syl} syllables over {SPEECH_END - start:.2f} s = {syl / (SPEECH_END - start):.2f}/s")
    total = len(LINES) * seconds
    print(f"total {total:.1f} s, words {words}")

    SCRIPT.write_text(f"""# What is gravity, really? (bản thử)
Tổng: {int(total // 60)}:{total % 60:04.1f}, {sum(words.values())} từ. Barnaby {words['Barnaby']} từ, Ambrose {words['Ambrose']} từ.

Bản thử không có mở đầu và lời hứa theo khuôn tập dài: mục tiêu là kiểm hình, khớp môi, hai giọng, độ hài và cú cắt sang bối cảnh mới. Qwen-Image chỉ tạo sheet nhân vật và ảnh nền trống; H3 đưa hai người vào cảnh. File này do `previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py` tạo.

| Mốc | Chain, shot | Bối cảnh | Người nói | Lời | Trò đùa | Nguồn |
|---|---|---|---|---|---|---|
{chr(10).join(rows)}

## Nguồn

- S1: NASA, [The Apollo 15 Hammer-Feather Drop](https://science.nasa.gov/resource/the-apollo-15-hammer-feather-drop/); NSSDC, [Apollo 15 Hammer-Feather Drop](https://nssdc.gsfc.nasa.gov/planetary/lunar/apollo_15_feather_drop.html). Đã đọc. Dùng cho: David Scott của Apollo 15 thả búa và lông vũ gần như trong chân không, chạm đất cùng lúc, đúng như Galileo đã kết luận.
- S2: Einstein Online, [Gravity: from weightlessness to curvature](https://www.einstein-online.info/en/spotlight/geometry_force/). Đã đọc. Dùng cho: thuyết của Newton coi hấp dẫn là lực; trong thuyết của Einstein, khối lượng làm cong không-thời gian, vật rơi đi theo đường "as straight as possible", và lực hấp dẫn khi rơi tự do "in part, an illusion". Vì vậy lời thoại ghi rõ "in Einstein's theory".
- S3: NASA, [Orbits and Kepler's Laws](https://science.nasa.gov/solar-system/orbits-and-keplers-laws/). Đã đọc. Dùng cho: định luật Newton "still accurate enough for many applications". Trang này cũng nói bay vũ trụ chính xác cần tính thuyết tương đối, nên không dùng nó cho câu kiểu "Newton vẫn đủ để bay vũ trụ".

"Newton settled this" là lời tự hào của Ambrose, được Barnaby phản bác ngay sau đó, không phải kết luận của kênh. "To Einstein, gravity isn't a pull" là cách nói gọn: S2 nói lực hấp dẫn khi rơi tự do "in part, an illusion". "Hammer and feather, landed together" trên Mặt Trăng chỉ thể hiện kết quả; Ambrose không nêu kiến thức hiện đại.

## Tính lại

Không có con số tính ra. Tốc độ thoại theo prompt: cao nhất {max(rates):.2f} âm tiết/giây (câu kết thúc ở {SPEECH_END:.2f} s, shot dài 8 s). Ở bài thử ep01 H3 đọc một câu 14 âm tiết trong khoảng 3,3 s, nhanh hơn prompt, nên phải nghe lại sau khi sinh.

## Cần người bản ngữ đọc

- "Lovely. But to Einstein, gravity isn't a pull."
- "Not a pull? Newton's laws still work for a great many things."
- "Quite. But mass bends spacetime. The apple just takes the straightest path."
- "Better view. Also, there's no air, so talk fast."
- "Apollo Fifteen: hammer and feather, landed together."
- "Of course. Galileo told you so. You're welcome."
""")


if __name__ == "__main__":
    main()
