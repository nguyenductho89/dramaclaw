#!/usr/bin/env python3
"""Generate the gravity test script, its H3 chains, and the Gemini/image prompts.

  python3 previs_h3_test/scripts/skits/science_humor/gravity_test/gen_chains.py

Gemini WebAI (gemini_webai_images.py) makes the character sheets, the empty backgrounds, and (new) composed
storyboard frames that already show both men in place; H3 animates and voices them. Several ways of using the
background are written out:
  chain_NN.json             background is the first frame (start_image), so the men walk in during shot 1
  chain_NN_refs_only.json   background is only a reference image, so the men can be there from frame 0
  chain_NN_single.json      like chain_NN.json, but each sheet ref is one cropped front view, not a two-up sheet
  chain_NN_sb.json          like chain_NN.json, but start_image is Gemini's storyboard frame for shot 1 (both men
                             already composed into the scene) instead of the bare plate
  shot_NN_M_sb.json         one isolated shot as its own 1-shot H3 chain, start_image is that shot's own
                             storyboard frame — meant to be rendered individually and joined by ffmpeg afterwards
<Picture N> numbering is the same across variants: 1 background/storyboard, 2 Barnaby, 3 Ambrose. <Audio 1> is
Barnaby, <Audio 2> is Ambrose. The prompt layout follows the ref2va branch of assemble_minimax_h3_prompt
(agents/minimax_h3_prompt_builder.py). Syllable counts are hand-counted in LINES; the review skill recounts them.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
SKIT = "previs_h3_test/scripts/skits/science_humor"
OUT_DIR = ROOT / SKIT / "gravity_test"
SCRIPT = ROOT / "examples/science-humor/gravity-test-script.md"

# 2026-11-09: changed from "only suggests the air of Einstein/Newton, keeps deliberate differences" to "closely
# resembles" per an explicit user request, with the real-likeness legal risk flagged and accepted — see the
# "Luật ngoại hình và danh tính" sections of series-bible.md and the Einstein/Newton entries in risks.md.
BARNABY_ANCHOR = "a wild halo of frizzy white hair, a thick white moustache, a weathered round face, round wire-rimmed glasses, a mustard-yellow cardigan and a pencil behind his right ear"
AMBROSE_ANCHOR = "a long wavy grey wig, a long narrow face with deep-set eyes, a long dark brown coat and a white linen cravat"
# Identity references for the Gemini sheet (gemini_webai_images.py sheet mode) — public-domain real photographs,
# sourced and licensed in character/real_refs/SOURCES.md.
SHEET_REFS = {
    "barnaby": f"{SKIT}/character/real_refs/einstein_1921_schmutzer.jpg",
    "ambrose": f"{SKIT}/character/real_refs/newton_1689_kneller.jpg",
}
# 2026-11-09: both backdrops changed from a plain empty plate to an elaborate themed scene per an explicit user
# request, then revised again same day: the extra figures must show plausible continuous background motion (the
# serpent coiling, the astronaut walking, Adam and Eve reaching for/sharing the fruit), not stand frozen. Each
# scene's `motion` field is a separate sentence folded into every shot's detailed_description (shot(), below) —
# worded as an unhurried, perpetual loop, since it has no per-shot start/end state to track like Barnaby/Ambrose's
# own actions do, and stays small/distant so it never competes with the two-shot in front of it. They are still
# described as non-speaking background elements — part of "the setting", not a third/fourth <Subject> — so they
# stay out of the way of the two-speaker prompt structure (subject_definitions/retention_analysis still only
# define Barnaby and Ambrose). Adam and Eve are kept modestly covered and mostly facing away, for a family-friendly
# channel; the fruit-sharing gesture is readable without needing nudity.
SCENES = {
    "orchard": {
        "place": ("the Garden of Eden at golden evening: a lush orchard around the Tree of Knowledge, heavy with red apples, a serpent coiled in its branches, and far in the background two small distant figures, "
                  "a man and a woman modestly covered by leaves and drapery, standing together near the tree, soft low sunlight from behind the camera and slightly to the left"),
        "light": "soft low evening sunlight from behind the camera and slightly to the left",
        "motion": ("Far in the background and out of focus, the serpent coils slowly around a low branch of the Tree of Knowledge, and the woman reaches up, picks an apple, and offers it to the man beside her, "
                   "who takes a slow bite — an unhurried loop of the same small gesture, repeating throughout the shot, too far away for any detail or expression to read"),
        "sound": "A quiet garden in the evening with soft birdsong and a light breeze in the leaves.",
        "name": "Vườn Địa Đàng",
        "plate": ("Photorealistic horizontal film still of the Garden of Eden at golden evening. Eye-level camera, with the horizon about two-thirds of the way up the frame. Lush untouched grass below it, the Tree "
                  "of Knowledge at the center background, heavy with red apples, a serpent coiled around one of its branches. Far in the background, small and out of focus, a man and a woman, modestly covered by "
                  "leaves and drapery, stand together near the foot of the tree — she reaches up toward an apple on a low branch, offering it to him. No one else in the frame. "
                  "Soft low sunlight from behind the camera and slightly to the left, soft gentle contrast, natural colours, natural film look. A calm, empty foreground."),
    },
    "moon": {
        "place": ("the Apollo 11 Moon landing site, 1969: the grey dusty lunar surface, a black starless sky, the blue Earth small near the horizon, the lunar module standing "
                  "right behind where the men stand, towering over them and rising out of the top of the frame, a tiny flag and a tiny distant astronaut in a bulky white spacesuit far away on the horizon, low white sunlight from behind the camera and slightly to the left"),
        "light": "low white sunlight from behind the camera and slightly to the left",
        "motion": ("Far in the background and out of focus, the tiny astronaut walks slowly along the horizon in bouncing, low-gravity strides, pausing now and then to crouch and pick up a rock — an unhurried loop of "
                   "the same small routine, repeating throughout the shot, too far away for any detail to read"),
        "sound": "Complete, empty silence with no wind and no ambient sound, only the voice of whoever is speaking.",
        "name": "Mặt Trăng (bãi đáp Apollo 11)",
        # 2026-11-09 (evening): measured ~0.33x background scale in the wide full-length framing (the module was
        # drawn ~870 px too small for the men's depth). New composition, per an explicit user request: the two men
        # stand right under the module, shown from the knees up, so the module visibly towers over them.
        # Numbers: camera 1.5 m high, module 6 m away (7 m tall -> top cut off by the frame, ~170 px/m at its depth),
        # men 4 m from the camera (~255 px/m, faces ~59 px), feet below the frame edge.
        "plate": ("Photorealistic horizontal film still at the Apollo 11 Moon landing site, 1969. The camera is a normal eye-level view, 1.5 metres (5 feet) above the ground, about 6 metres in front of the "
                  "lunar excursion module. The module is a real spacecraft 7 metres/23 feet tall, four times the height of a standing man, and is drawn at that true scale: it fills the centre and the whole upper part "
                  "of the frame and rises beyond the top edge, so its top is not visible. Its gold-foil descent stage, its ladder with rungs about 40 cm apart, its leg struts and its round footpads each look huge "
                  "next to a person; its footpads rest on the ground at the very bottom edge of the frame. The grey dusty lunar surface fills the lower third; the horizon lies about two-thirds of the way down the frame, "
                  "with a pure black sky above it and the small blue Earth in the upper right. Far away on the horizon at the left, tiny, an American flag stands in the dust, and a single astronaut in a bulky white "
                  "spacesuit walks very far in the distance, only a few pixels tall, with no visor or suit detail readable. No one else in the frame. A clear, empty foreground of dust in the bottom centre of the frame. "
                  "Low white sunlight from behind the camera and slightly to the left, soft gentle contrast, natural film look."),
        "men": ("each seen from the knees up with his head, torso and hands fully in frame, standing side by side about 2 metres in front of the lunar module's legs and ladder and about 4 metres from the camera, "
                "the same size, the same distance from the camera, with the lunar module towering behind and above them — its footpads, ladder, struts and descent stage are each larger than a man and its body rises beyond the top of the frame — "
                "and with clear space above their heads"),
        "men_h3": ("each seen from the knees up with his head, torso and hands fully in frame, standing side by side directly in front of the lunar module's legs and ladder, the same size, the same distance from the camera, "
                   "with the lunar module towering behind and above them, several times taller than either man, its body rising beyond the top of the frame"),
        "shadow": "Each man's long soft shadow falls on the ground beside him in the same direction as the lunar module's shadow already in Image 1, so each man reads as standing inside the scene, not cut out and pasted on top of it. ",
    },
}
SHEETS = {
    "barnaby": ("Photorealistic horizontal character reference photograph of one man, shown twice side by side at the same size, full length from head to foot with both feet visible: "
                "facing the lens on the left half, and turned toward the right of the frame on the right half. The man in the reference image, closely resembling him: "
                "a cheerful 70-year-old with a wild halo of frizzy white hair, a thick white moustache, a weathered round face with deep smile-lines, round wire-rimmed glasses, "
                "a mustard-yellow wool cardigan over a blue checked shirt, brown trousers, and a stubby pencil tucked behind his right ear. Friendly closed-mouth expression. "
                "Plain light grey studio background with nothing else in the image, the two views separated only by empty grey space, soft even studio light, natural skin."),
    "ambrose": ("Photorealistic horizontal character reference photograph of one man, shown twice side by side at the same size, full length from head to foot with both feet visible: "
                "facing the lens on the right half, and turned toward the left of the frame on the left half. The man in the reference image, closely resembling him: "
                "a lean, intent 65-year-old with a long narrow face with deep-set eyes, a long wavy grey wig falling past his shoulders, a long dark brown late-17th-century coat, breeches and stockings, and a "
                "white linen cravat. Calm closed-mouth expression, chin slightly raised. Plain light grey studio background with nothing else in the image, the two views separated only by empty grey space, soft even studio light, natural skin."),
}
FRAMES = 192  # 17k+5 grid, 8 s. The generator notes that dialogue shots under 192 frames make the shot join clip audibly (runpod_minimax_h3_multishot_video.py).
SPEECH_END = 6.30  # in the ep01 test H3 said a 14-syllable line in about 3.3 s and spoke again in the empty tail, so every line is followed by the official lip-close sentence
VOICE = {
    "Barnaby": "a warm, dry, amused voice with a relaxed American accent, the voice in <Audio 1>",
    "Ambrose": "a low-pitched, crisp, formal, proud voice with a refined English accent, the voice in <Audio 2>",
}
SUBJECT = {"Barnaby": "<Subject 1> (S1)", "Ambrose": "<Subject 2> (S2)"}
B, A = "<Subject 1>", "<Subject 2>"

# 2026-11-09: per-shot camera direction, gravity test only — explicit user request ("camera thay đổi phù hợp kịch
# bản để nhấn mạnh nội dung"), NOT a series-wide change to series-bible.md's "camera cố định" rule. Only a slow
# push-in is used, never a pull-back/reveal or a pan: a pull-back on a chain's shot 1 would have to start tighter
# than the plate/storyboard frame already pinned as <Picture 1>/frame 0, contradicting it; a pan risks the
# carefully pinned left-third/right-third blocking (series-bible.md's "Bối cảnh" positioning). Shot 1 of each
# chain (already carrying the walk-in/drift-down entrance) and one punchline beat are static by design, not by
# omission, to avoid compounding two kinds of novel motion in one shot on this pipeline's first attempt at any
# camera movement. Keyed by (chain_num, 1-based shot position within the chain) — matches `index` in shot(), not
# `prompt_index`, so a V2 one-shot file still gets the camera move for the line's real position.
CAMERA = {
    (1, 1): None,
    (1, 2): ("push_one", "Barnaby", "his surprising rebuttal"),
    (1, 3): ("push_one", "Ambrose", "his comeback"),
    (1, 4): ("push_both", None, "the strange idea landing"),
    (2, 1): None,
    (2, 2): None,
    (2, 3): ("push_one", "Barnaby", "the historical detail"),
    (2, 4): ("push_one", "Ambrose", "his victory line"),
}


def _camera_text(chain_num: int, line_pos: int) -> dict:
    """Text fragments for shot()'s camera-related sentences, keyed by move type. Returns the exact original
    static-camera text when there is no move for this shot, so every other (chain_num, line_pos) is byte-for-byte
    unchanged from before this feature.

    For a moving shot, `position_prefix` scopes the whole "full-length head to foot ... life-size scale ...
    clear space" framing sentence to the shot's START only (a flaw caught by the review skill on the first
    draft: stating that framing unconditionally, then also saying the shot tightens to a medium two-shot by the
    end, contradicted itself — a medium shot cannot also be full-length). The actual push is then its own
    sentence in `framing_tail`, not folded into the same clause as the end-state framing."""
    move = CAMERA.get((chain_num, line_pos))
    if move is None:
        return {
            "summary_kind": "static",
            "shot_open": "static horizontal wide two-shot at eye level",
            "position_prefix": "",
            "framing_tail": "with clear space above their heads and below their feet.",
            "no_replace": "Do not replace character action with camera movement, lighting changes, particles, fog, or environmental effects.",
            "hold": "The camera holds this framing until the final frame.",
        }
    kind, target, reason = move
    end_desc = (f"a medium two-shot centered slightly on {SUBJECT[target][:11]}" if kind == "push_one"
                else "a closer two-shot still showing both men from the waist up")
    return {
        "summary_kind": "slow push-in",
        "shot_open": "horizontal wide two-shot at eye level",
        "position_prefix": "At the start of the shot, ",
        "framing_tail": (f"with clear space above their heads and below their feet. The camera then slowly and smoothly pushes in "
                         f"throughout the rest of the shot, tightening toward {end_desc} by the end, to emphasize {reason}."),
        "no_replace": "The camera's own slow push-in is the only camera movement in this shot; it does not replace any character action or dialogue below.",
        "hold": "The push-in is smooth, slow and continuous, with no sudden movement or cut, completing by the final frame.",
    }

# chain, scene, speaker, line, syllables, joke, sources, speech start, opening actions, mid action, listener action, end state, summary
LINES = [
    (1, "orchard", "Ambrose", "The Earth pulls the apple down. Newton settled this.", 12, "Ambrose tưởng đã xong chuyện", "S2", 1.75,
     f"At 0.00 seconds {B} walks into frame from the left edge, his hands in his cardigan pockets, and {A} walks into frame from the right edge, holding a red apple in his left hand. At 1.50 seconds they stop in their places",
     f"At 3.00 seconds {A} taps the apple with his right forefinger. At 4.30 seconds {A} lowers his right hand, lifts his chin and raises the apple to chest height", f"{B} stays silent with closed lips, his hands in his cardigan pockets, and nods politely",
     f"{A} with his chin raised and the apple held up at chest height, and {B} with his hands in his pockets", f"{A} explains the falling apple to {B}"),
    (1, "orchard", "Barnaby", "Nice. But to Einstein, gravity isn't a pull.", 12, "Một câu làm hỏng cả vườn táo", "S2", 1.00,
     f"At 0.00 seconds {B} looks at {A}, his hands in his cardigan pockets",
     f"At 3.00 seconds {B} takes his right hand from his pocket and points at the apple", f"{A} stays silent with closed lips, holding the red apple at chest height in his left hand, and his eyebrows draw together",
     f"{B} pointing at the apple, and {A} staring at him with his eyebrows drawn together", f"{B} points at the apple and contradicts {A}"),
    (1, "orchard", "Ambrose", "Not a pull? Newton's laws still work for a great many things.", 14, "", "S3", 1.00,
     f"At 0.00 seconds {A} stares at {B}, holding the red apple at chest height in his left hand, and {B} lowers his right hand to his side",
     f"At 3.00 seconds {A} raises his right forefinger", f"{B} stays silent with closed lips and tilts his head",
     f"{A} with his right forefinger raised, and {B} with his head tilted", f"{A} raises one finger and objects"),
    (1, "orchard", "Barnaby", "Sure. But mass bends spacetime. The apple just takes the straightest path.", 15, "Nghe vô lý mà đúng trong lý thuyết", "S2", 1.00,
     f"At 0.00 seconds {B} nods once at {A}, his right hand at his side",
     f"At 3.00 seconds {B} raises his right hand, flat, and moves it down in a straight line from chest height to waist height, away from {A}", f"{A} stays silent with closed lips, lowers his right hand, and looks down at the red apple in his left hand",
     f"{B} with his right hand held flat at waist height, and {A} looking at the apple", f"{B} moves one flat hand straight down while {A} looks at his apple"),
    (2, "moon", "Ambrose", "Where is the orchard? And why am I on the Moon?", 12, "Ambrose rơi xuống Mặt Trăng từ từ vì trọng lực yếu, Barnaby thấy bình thường (đúng tính cách lạc giữa bối cảnh)", "", 1.75,
     f"At 0.00 seconds {B} walks into frame from the left edge, his hands in his cardigan pockets, and settles in place within half a second, looking around with mild interest. {A} drifts down from above the top edge of frame at the same time, clutching a red apple to his chest with his left hand, his long coat and silver wig floating upward in the Moon's weak gravity. At 1.50 seconds {A} lands softly on his feet in the right third of the frame with a gentle bounce, and turns to {B}",
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


def definitions(scene: str, first_shot: bool, first_frame: bool, single: bool = False, storyboard: bool = False) -> tuple[str, str]:
    note = "" if single else " (one man in two views, not two people)"
    subjects = (f"<Subject 1> is Barnaby, shown in <Picture 2>{note}, with {BARNABY_ANCHOR}.\n"
                f"<Subject 2> is Ambrose, shown in <Picture 3>{note}, with {AMBROSE_ANCHOR}.")
    retention = (f"<Subject 1> (appears in [Shot 1]): fully_preserved - {BARNABY_ANCHOR}, consistent for the whole video.\n"
                 f"<Subject 2> (appears in [Shot 1]): fully_preserved - {AMBROSE_ANCHOR}, consistent for the whole video.")
    if first_frame and not first_shot:
        # The background only went in as shot 1's first frame: H3 carries on from the last frame, so no image stands for it here.
        return subjects, retention
    if first_frame and first_shot and storyboard:
        # The start_image is a Gemini storyboard frame: both men are already in it, not just the bare plate.
        return (f"<Picture 1> is the first frame of [Shot 1], showing {SCENES[scene]['place']}, with <Subject 1> and <Subject 2> already standing in place as described below.\n{subjects}",
                f"<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from its framing, lighting and the two men's starting positions, and the background stays the same for the rest of the video.\n{retention}")
    if first_frame and first_shot:
        # "with neither of them in it yet" (not "nobody") since 2026-11-09: the themed backgrounds now describe
        # their own small background figures (Adam/Eve, the astronaut) — saying "nobody" would read as self-
        # contradicting the place description one clause earlier.
        return (f"<Picture 1> is the first frame of [Shot 1], showing {SCENES[scene]['place']}, with neither of the two men below in it yet.\n{subjects}",
                f"<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from its framing and lighting, and the background stays the same when the men walk in.\n{retention}")
    return (f"<Picture 1> shows the setting: {SCENES[scene]['place']}.\n{subjects}",
            f"<Picture 1> (setting): partially_preserved - {SCENES[scene]['place']}, used as the location for the whole video.\n{retention}")


def _static_opening(index: int, opening: str) -> str:
    """Rewrite a shot-1 entrance ("walks into frame...") into an already-standing-there opening. Identical to the
    transform `shot()` always applied inline for its `index == 1 and not first_frame` branch, now shared with the
    storyboard-locked variants (where the start frame already shows both men in place, so nobody walks in).
    A no-op on any shot whose opening text does not match the entrance patterns (index != 1, or index == 1 of a
    chain that is not shot 1 of the original 8-line script — see `shot_single`)."""
    if index != 1:
        return opening
    if "drifts down" in opening:
        return (f"At 0.00 seconds {B} stands in place in the left third of the frame, his hands in his cardigan pockets, "
                 f"and {A} stands in place in the right third of the frame, clutching a red apple to his chest with his left hand, and turns to {B}")
    opening = opening.split(" At 1.50 seconds")[0]
    return re.sub(r"walks into frame from the (left|right) edge", "stands in place", opening).rstrip(".")


def storyboard_prompt(index: int, line: tuple) -> str:
    """Gemini image-compose prompt for a shot's opening frame: Image 1 = the empty plate, Image 2/3 = the two
    character sheets. Pose text reuses `_static_opening` so the frame matches the pose `shot()` describes for the
    same shot (so the storyboard and the H3 prompt never contradict each other).

    2026-11-09: added the relight/shadow/grounding sentence after a real render (`chain_01_sb`, see
    science_humor_gravity_test_run.md) showed the men looking "cut out and pasted" onto the background — traced to
    this prompt back then only saying to keep Image 2/3's face/hair/clothing unchanged, which Gemini read as
    keeping their flat, even studio lighting too, instead of relighting them to the scene. Worded scene-agnostically
    ("foreground terrain", not "grass") since this prompt is shared by every SCENES entry, present and future."""
    _, scene, speaker, text, _, _, _, start, opening, mid, listener, end, summary = line
    pose = _static_opening(index, opening).replace(B, "Barnaby").replace(A, "Ambrose")
    men = SCENES[scene].get("men", "each seen full-length from head to foot with both feet clearly on the ground, the same size, the same distance from the camera, at life-size scale with the location")
    shadow = SCENES[scene].get("shadow", "Each man casts a soft, visible contact shadow on the ground directly beneath his own feet, matching the shadows already in Image 1. A little of the nearest foreground terrain overlaps the lowest part of his legs or feet, so each man reads as standing inside the scene, not cut out and pasted on top of it. ")
    return (
        "Compose a new photorealistic horizontal 16:9 film still, the opening frame of one shot in a two-man science-comedy series. "
        "Image 1 is the location and camera: keep its background, framing and lighting exactly, static eye-level camera, keep any small distant background figures in it exactly as they are, with neither Barnaby nor Ambrose in it yet. "
        "One camera, one ground plane: the camera is about 1.6 metres (5.3 feet) above the ground, so the horizon line of Image 1 passes through both men's chests, and both men stand on that same ground plane, in front of the background objects, not floating above them. "
        "Both men are about 1.75 metres (5.7 feet) tall, so every background object keeps its real size relative to them: anything several metres tall (a tree, a lander, a building) stays several times taller than a standing man and must not shrink to fit the frame. "
        "Image 2 shows Barnaby, one man in two views, not two people: keep his face, hair, glasses, cardigan and pencil unchanged. "
        "Image 3 shows Ambrose, one man in two views, not two people: keep his face, wig, coat and cravat unchanged. "
        f"Barnaby stands in the left third of the frame and Ambrose stands in the right third, {men}, "
        "both turned three-quarters toward each other and toward the camera so both faces stay clearly visible"
        f"{'. ' if 'men' in SCENES[scene] else ', with clear space above their heads and below their feet. '}"
        "Relight both men to match Image 1's own sunlight exactly — its direction, warm colour temperature and contrast — not the flat, even studio lighting of Image 2/3; their clothing, hair and face keep their own colours, only the lighting on them changes. "
        f"{shadow}"
        f"{pose}. "
        "Natural skin texture, soft gentle contrast, natural film look, photorealistic. Show each man once. No text, logos or watermarks."
    )


def storyboard_prompt_qwen(index: int, line: tuple) -> str:
    """Qwen-Image 2.1 compose twin of `storyboard_prompt`, for qwen_images.py storyboard mode (image_1 = the empty
    plate = the edit target, image_2/3 = the two sheets). Follows the layout of `build_qwen21_compose_prompt`
    (generators/prompt_builder.py), the form verified on a real GPU: <imageN> tags, one paragraph, no double quotes,
    the word "photorealistic", no aspect-ratio token (the output size comes from image_1), identity sheets described
    as views of ONE person. The relight / contact-shadow / foreground-overlap sentences are the same fix as in
    `storyboard_prompt`, worded as instructions to do something rather than a list of things to avoid."""
    _, scene, speaker, text, _, _, _, start, opening, mid, listener, end, summary = line
    pose = _static_opening(index, opening).replace(B, "Barnaby").replace(A, "Ambrose").replace('"', "")
    return (
        "<image1> is a reference photo of the location and camera; keep its background, framing, static eye-level camera, lighting and any small distant background figures exactly as they are. "
        "<image2> is one or more reference views of Barnaby (the same single person, not different people); match Barnaby's face, hair, glasses, cardigan and pencil exactly as shown, and render Barnaby as one person in the scene, not a copy of the reference sheet itself. "
        "<image3> is one or more reference views of Ambrose (the same single person, not different people); match Ambrose's face, wig, coat and cravat exactly as shown, and render Ambrose as one person in the scene, not a copy of the reference sheet itself. "
        "Compose a new photorealistic photograph, the opening frame of one shot in a two-man science-comedy series, set in the location from <image1>, matching its lighting and background elements. "
        "Barnaby (matching <image2> exactly) stands in the left third of the frame and Ambrose (matching <image3> exactly) stands in the right third, each seen full-length from head to foot with both feet on the ground, at the same distance from the camera, at life-size scale with the location, "
        "both turned three-quarters toward each other and toward the camera so both faces are clearly visible, with clear space above their heads and below their feet. "
        "Relight both men to the sunlight of <image1>: its direction, warm colour temperature and contrast replace the even studio lighting of <image2> and <image3>, while their clothing, hair and face keep their own colours. "
        "Each man casts a soft, visible contact shadow on the ground directly beneath his own feet, matching the shadows already in <image1>, and a little of the nearest foreground terrain overlaps the lowest part of his legs or feet, so each man stands inside the scene. "
        f"{pose}. "
        "Show exactly 2 people, Barnaby and Ambrose, each appearing once. "
        "Render the people and the scene as a real photograph with natural skin texture, soft gentle contrast and a natural film look, not as a sketch, illustration, painting or 3D render. "
        "Do not add any object, furniture or prop that is not already visible in <image1>."
    )


def shot(index: int, line: tuple, first_frame: bool, single: bool = False, storyboard: bool = False, force_first: bool = False) -> str:
    """Each shot's prompt stands alone and is labelled [Shot 1], as in the official layout and its lint.
    `storyboard`: start_image is a Gemini storyboard frame that already shows both men in place (chain_NN_sb), so
    the shot-1 opening must be static too, but "begins from <Picture 1>" still holds literally (frame 0 = Picture 1).
    `force_first`: treat this shot as [Shot 1]/<Picture 1> of its own one-shot H3 chain regardless of `index` (used
    by `shot_single` for the per-shot storyboard variant); the pose transform still keys off the real `index`."""
    chain_num, scene, speaker, text, _, _, _, start, opening, mid, listener, end, summary = line
    seconds = FRAMES / 24
    prompt_index = 1 if force_first else index
    cam = _camera_text(chain_num, index)
    if index == 1 and (not first_frame or storyboard):
        # Without a first frame, or with a storyboard frame that already has both men positioned, the men are
        # already standing there: the entrance sentence becomes a static opening.
        opening = _static_opening(index, opening)
    defs, retention = definitions(scene, prompt_index == 1, first_frame, single, storyboard)
    entering = prompt_index == 1 and first_frame
    men = SCENES[scene].get("men_h3", "each seen full-length from head to foot with both feet clearly on the ground, the same size, the same distance from the camera, at life-size scale with the setting")
    tail = cam["framing_tail"]
    if "men_h3" in SCENES[scene]:
        tail = tail.replace("with clear space above their heads and below their feet.", "with clear space above their heads.")
    walked_in = entering and not storyboard  # storyboard already shows them in place, so nobody "walks in"
    begins = " that begins from <Picture 1>" if entering else ""
    setting = f"in the setting of <Picture 1>, keeping its layout and light" if prompt_index == 1 or not first_frame else f"in this setting: {SCENES[scene]['place']}"
    return (
        f"subject_definitions:\n{defs}\n\n"
        f"summary:\nA {seconds:.0f}-second 16:9 {cam['summary_kind']} wide two-shot{begins}. {summary}. Ends with {end}.\n\n"
        f"retention_analysis:\n{retention}\n\n"
        "detailed_description:\n"
        f"Live-action film footage, horizontal 16:9 framing, a science comedy, {SCENES[scene]['light']}, soft gentle contrast, natural skin tones, natural film look.\n"
        f"[Shot 1] {'The shot begins from <Picture 1>: a' if entering else 'A'} {cam['shot_open']} {setting}. "
        f"{cam['position_prefix']}{'Once they have walked in, ' if walked_in else ''}<Subject 1> stands in the left third of the frame and <Subject 2> stands in the right third, {men}, "
        f"both turned three-quarters toward each other and toward the camera so both faces stay clearly visible, {tail} "
        f"{SCENES[scene]['motion']}, unrelated to and unaffected by what <Subject 1> and <Subject 2> do or say in the foreground. "
        f"{opening}. At {start:.2f} seconds {SUBJECT[speaker]} says it in {VOICE[speaker]}: <d>[English] {text}</d> Exactly as the voice stops, the lips close and the jaw ceases all speaking motion. This single line is the only speech in the video. {listener}. {mid}. "
        f"At {SPEECH_END:.2f} seconds {SUBJECT[speaker][:11]} finishes, and both stay silent with closed lips until the final frame. "
        f"{cam['no_replace']} "
        f"All motion happens at natural real-time speed, not slow motion. {cam['hold']} At {seconds:.2f} seconds, the shot ends on {end}. "
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
    for stale in OUT_DIR.glob("shot_*.json"):
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
            # Gemini WebAI compose prompt for each shot's opening frame (gemini_webai_images.py storyboard mode).
            # Kept on every variant below (bench_multishot30_local.py ignores keys it does not read) so one
            # gen_chains.py run keeps the H3 prompt and the storyboard prompt in sync.
            "storyboard_prompts": [storyboard_prompt(i, line) for i, line in enumerate(lines, start=1)],
            "storyboard_prompts_qwen": [storyboard_prompt_qwen(i, line) for i, line in enumerate(lines, start=1)],
        }
        storyboard = f"{SKIT}/gravity_test/storyboard"
        # Each reference is ONE view cropped from the sheet (front views), so the reference can never be read as a
        # two-up layout. A `start_image` combined with the full two-up sheets as `reference_images` is the exact
        # combination that caused "sheet lọt vào khung hình" in chain_NN.json's own earlier test run (H3 redrew
        # the reference sheet into frame) — `_single.json` fixed it by cropping to one view each, and the two new
        # storyboard variants below reuse that same fix, since they also pair a `start_image` with references.
        singles = [f"{SKIT}/character/barnaby_front.png", f"{SKIT}/character/ambrose_front.png"]
        first_frame = {**base, "name": f"science_humor_gravity_test_chain_{num:02d}", "start_image": f"{plate}/{scene}.png", "reference_images": sheets,
                       "shots": [shot(i, line, True) for i, line in enumerate(lines, start=1)]}
        refs_only = {**base, "name": f"science_humor_gravity_test_chain_{num:02d}_refs_only", "start_image": None, "reference_images": [f"{plate}/{scene}.png", *sheets],
                     "shots": [shot(i, line, False) for i, line in enumerate(lines, start=1)]}
        # V1: same 4-shot chain, but start_image is Gemini's composed storyboard frame for shot 1 (both men already
        # in place, correct scale/blocking) instead of the bare plate — H3 only has to animate and voice it.
        storyboard_chain = {**base, "name": f"science_humor_gravity_test_chain_{num:02d}_sb", "start_image": f"{storyboard}/chain_{num:02d}_shot1.png", "reference_images": singles,
                            "shots": [shot(i, line, True, single=True, storyboard=True) for i, line in enumerate(lines, start=1)]}
        (OUT_DIR / f"chain_{num:02d}_sb.json").write_text(json.dumps(storyboard_chain, ensure_ascii=False, indent=1) + "\n")
        # V2: each shot is its own 1-shot H3 chain, start_image is that shot's own storyboard frame, joined by
        # ffmpeg afterwards — every frame is reviewed before render, trading the latent hand-off between shots.
        for i, line in enumerate(lines, start=1):
            # name clash note: this is NOT the `_single.json` variant above — "one_shot" here means a 1-shot H3
            # chain, one per line of the script (it does reuse the same cropped-front-view `singles` references).
            one_shot = {**base, "name": f"science_humor_gravity_test_shot_{num:02d}_{i}_sb",
                        "start_image": f"{storyboard}/chain_{num:02d}_shot{i}.png", "reference_images": singles,
                        "storyboard_prompts": [base["storyboard_prompts"][i - 1]],
                        "storyboard_prompts_qwen": [base["storyboard_prompts_qwen"][i - 1]],
                        "shots": [shot(i, line, True, single=True, storyboard=True, force_first=True)]}
            (OUT_DIR / f"shot_{num:02d}_{i}_sb.json").write_text(json.dumps(one_shot, ensure_ascii=False, indent=1) + "\n")
        # Same as the first-frame variant, but with the `singles` references defined above.
        single = {**first_frame, "name": f"science_humor_gravity_test_chain_{num:02d}_single", "reference_images": singles,
                  "shots": [shot(i, line, True, True) for i, line in enumerate(lines, start=1)]}
        (OUT_DIR / f"chain_{num:02d}_single.json").write_text(json.dumps(single, ensure_ascii=False, indent=1) + "\n")
        (OUT_DIR / f"chain_{num:02d}.json").write_text(json.dumps(first_frame, ensure_ascii=False, indent=1) + "\n")
        (OUT_DIR / f"chain_{num:02d}_refs_only.json").write_text(json.dumps(refs_only, ensure_ascii=False, indent=1) + "\n")
    # Gemini WebAI (gemini_webai_images.py sheet/plate) now generates these, not Qwen-Image — renamed from
    # qwen_prompts.json. Qwen-Image 2.1 is research/evaluation-licensed only and is no longer in this pipeline.
    # Each sheet carries a `ref` (real-photo identity reference, see SHEET_REFS/character/real_refs/SOURCES.md) —
    # gemini_webai_images.py's sheet mode attaches it as a reference image alongside the text prompt.
    (OUT_DIR / "image_prompts.json").write_text(json.dumps({
        "note": "Gemini WebAI (gemini_webai_images.py), text-to-image composed to 1344x768.",
        "sheets": {k: {"prompt": v, "ref": SHEET_REFS[k]} for k, v in SHEETS.items()},
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

- "Nice. But to Einstein, gravity isn't a pull."
- "Not a pull? Newton's laws still work for a great many things."
- "Sure. But mass bends spacetime. The apple just takes the straightest path."
- "Better view. Also, there's no air, so talk fast."
- "Apollo Fifteen: hammer and feather, landed together."
- "Of course. Galileo told you so. You're welcome."
""")


if __name__ == "__main__":
    main()
