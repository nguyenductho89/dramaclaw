// Quick-start prompt templates for the RunPod MiniMax-H3 video backend
// (`runpod_minimax_h3`) in the Freezone video node.
//
// Adapted from the 20 example prompts in https://pixo.video/blog/minimax-h3-prompts
// and rewritten into the official H3 rewrite format
// (MiniMaxAI/MiniMax-H3 `docs/VIDEO_PROMPT_WRITING_GUIDE_{base,ref}_en.md`):
// six sections for reference generation, three for first-frame-only.
//
// Numbering convention (matches `generators/runpod_minimax_h3_video.py`):
// `<Picture 1>` is the first connected image (@image1, used as the first
// frame), `<Picture 2>`... are the following connected images in order, and
// `<Audio N>` is the Nth connected audio. Video references are not supported
// by this backend, so the pixo examples that edit or follow a source video
// are left out or reworked to use stills.
//
// Prompts stay in English (the language H3's guides are written in); only the
// picker's titles/descriptions are localized. `[BRACKETS]` mark the parts to
// replace. The backend accepts 5-12 s and 16:9 / 9:16.

import type { VideoGenMode } from "./canvasNodes";
import { FAL_H3_PROMPT_TEMPLATES } from "./falH3PromptTemplates";

export const RUNPOD_H3_VIDEO_MODEL_ID = "runpod_minimax_h3";

export function isRunpodH3VideoModel(modelId: string | null | undefined): boolean {
  return String(modelId ?? "").trim() === RUNPOD_H3_VIDEO_MODEL_ID;
}

export type H3TemplateCategory =
  | "cinematic"
  | "brand"
  | "ecommerce"
  | "drama"
  | "animation"
  | "motion"
  | "ui"
  | "audio";

export const H3_TEMPLATE_CATEGORIES: readonly H3TemplateCategory[] = [
  "cinematic",
  "brand",
  "ecommerce",
  "drama",
  "animation",
  "motion",
  "ui",
  "audio",
];

type Localized = { en: string; vi: string };

export interface H3TemplateInput {
  /** `<Picture N>` or `<Audio N>` exactly as written in the prompt. */
  label: string;
  role: Localized;
  /**
   * English prompt for generating this input with an image model. Only on
   * `<Picture N>` inputs; `<Audio N>` has to be uploaded.
   */
  imagePrompt?: string;
}

export type H3TemplateSource = "pixo" | "fal";
export type H3TemplateMode = "fl2va" | "flf2va" | "ref2va";

export interface H3PromptTemplate {
  id: string;
  source: H3TemplateSource;
  category: H3TemplateCategory;
  title: Localized;
  description: Localized;
  /**
   * fl2va = first frame only, flf2va = first + last frame,
   * ref2va = first frame + extra references.
   */
  mode: H3TemplateMode;
  aspectRatio: "9:16" | "16:9";
  durationSec: number;
  inputs: H3TemplateInput[];
  prompt: string;
}

const FIRST_FRAME: H3TemplateInput = {
  label: "<Picture 1>",
  role: {
    en: "First frame (connect as image 1)",
    vi: "Ảnh first frame (nối làm ảnh 1)",
  },
};

const NO_TEXT =
  "There are no subtitles, captions, logos or watermarks anywhere in frame.";

const PIXO_TEMPLATES: readonly Omit<H3PromptTemplate, "source">[] = [
  // ---------------------------------------------------------------- cinematic
  {
    id: "scifi_trailer_beat",
    category: "cinematic",
    title: { en: "Sci-fi trailer beat", vi: "Đoạn trailer khoa học viễn tưởng" },
    description: {
      en: "Two shots split by a black-frame cut, one spoken line, ends on a title card.",
      vi: "2 shot ngắt bằng khung đen, 1 câu thoại, kết bằng title card.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: [FIRST_FRAME],
    prompt: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description:
Cinematic sci-fi trailer look, anamorphic widescreen, cold teal shadows with a single warm practical light, fine film grain.
[Shot 1] A wide shot begins from <Picture 1>: [the astronaut] stands at the edge of [a frozen alien plateau] under a sky with two pale moons. The camera pushes in slowly. At 1.00 seconds, a low rumble rises and loose ice skitters across the ground toward the camera. At 2.50 seconds, [the astronaut] turns her helmeted head toward the horizon, visor catching a distant flash.
[Shot 2] At 00:04.500, after a hard cut through two black frames, a close-up holds on [the astronaut]'s face behind the visor, breath fogging the glass. (S1) She says quietly, <d>[English] [It was never a signal. It was a warning.]</d>
[Shot 3] At 00:08.000, the shot cuts to black and the title ECHO fades up in thin white letters at frame center, then holds until the final frame.
All motion happens at natural real-time speed. No logos or watermarks.

overall_soundscape:
Howling thin wind, ice crackling underfoot, a deep sub-bass rumble that drops to silence on the black frames, suit breathing inside the helmet.

non_diegetic_music:
A slow trailer score: sustained low strings and a single pulsing synth note, swelling into a heavy percussion hit exactly on the title card.`,
  },
  {
    id: "macro_match_morph",
    category: "cinematic",
    title: { en: "One-take macro match-morph", vi: "Morph macro một cú máy" },
    description: {
      en: "One continuous macro take that morphs texture A into landscape B.",
      vi: "Một cú máy macro liền mạch, chất liệu A biến thành phong cảnh B.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Texture A (e.g. coffee foam)", vi: "Chất liệu A (vd bọt cà phê)" } },
      { label: "<Picture 3>", role: { en: "Texture B (e.g. desert dunes)", vi: "Chất liệu B (vd đồi cát)" } },
    ],
    prompt: `subject_definitions:
<Picture 1> is the first frame of [Shot 1], showing an extreme macro close-up of [coffee foam] swirling in a cup.
<Subject 1> is [the coffee foam surface], on the texture sheet <Picture 2>, with fine milky bubbles and caramel streaks.
<Subject 2> is [the desert dunescape], on the texture sheet <Picture 3>, with wind-carved ridges and warm golden sand.

summary:
[keyframe completion + reference generation] An 8-second 16:9 single continuous macro take that begins from <Picture 1>, glides across <Subject 1>, and match-morphs its swirls into the ridges of <Subject 2> without a cut.

retention_analysis:
<Picture 1> ([Shot 1] first frame): fully_preserved - framing, lighting and foam pattern at the opening.
<Subject 1> (appears in [Shot 1]): fully_preserved - bubble texture and caramel streak colors.
<Subject 2> (appears in [Shot 1]): attribute_transfer - ridge shapes and sand color become the final landscape.

detailed_description:
Photorealistic macro cinematography, shallow depth of field, warm low-angle key light from the left kept consistent throughout.
[Shot 1] The shot begins from <Picture 1>: an extreme macro of <Subject 1>. The camera drifts forward and slightly down at a steady pace. At 1.50 seconds, the caramel streaks stretch into long curved lines. At 3.00 seconds, the bubbles flatten and their edges sharpen into wind-cut ridges as the scale silently grows. At 5.00 seconds, the foam has fully become <Subject 2>; tiny sand grains slide down a ridge in the same direction the foam was turning. At 6.50 seconds, the camera rises to reveal the dunes reaching a hazy horizon, then holds steady until the final frame. No cut anywhere. ${NO_TEXT}

overall_soundscape:
A soft liquid fizz and spoon-clink tail that blends into a gentle desert wind and faint sand hiss.

non_diegetic_music:
N/A`,
  },
  {
    id: "add_cast_member",
    category: "cinematic",
    title: { en: "Add a cast member to a scene", vi: "Thêm nhân vật vào cảnh có sẵn" },
    description: {
      en: "Keep the first frame's place and light; a new character from a sheet walks in.",
      vi: "Giữ nguyên bối cảnh và ánh sáng của first frame; nhân vật mới từ ảnh tham chiếu bước vào.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 6,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "New character sheet", vi: "Ảnh nhân vật mới" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the new character], on the character sheet <Picture 2>, with [short black hair and a beige trench coat].
<Picture 1> is the first frame of [Shot 1], showing [an empty rain-wet street corner at night under a yellow streetlight].

summary:
[keyframe completion + reference generation] A 6-second 9:16 medium shot that begins from <Picture 1>. <Subject 1> walks into the existing scene, matched to its light and rain, stops under the streetlight and looks back. Ends on a stable pose under the light.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair and coat exactly as on the sheet, consistent for the whole video.
<Picture 1> ([Shot 1] first frame): fully_preserved - the street, streetlight position, rain and color grade stay unchanged.
No costume change, no face change, no second person.

detailed_description:
Live-action film footage, naturalistic night lighting, the single yellow streetlight stays the key light from above right.
[Shot 1] The shot begins from <Picture 1>: a medium-wide shot at eye level. The camera holds still. At 0.60 seconds, <Subject 1> enters from frame left at a normal walking pace, coat shoulders darkening with rain. At 2.20 seconds, <Subject 1> steps into the pool of streetlight and the light falls on the face with the same warm tone as the street. At 3.60 seconds, <Subject 1> stops, glances at a wristwatch, then turns the head back toward the direction they came from. At 6.00 seconds, <Subject 1> stands still under the light, gaze over the shoulder, hands in coat pockets. Natural real-time speed, no slow motion. ${NO_TEXT}

overall_soundscape:
Steady rain on pavement, water dripping from an awning, footsteps on wet asphalt, distant traffic hiss.

non_diegetic_music:
N/A`,
  },

  // -------------------------------------------------------------------- brand
  {
    id: "product_trailer_spot",
    category: "brand",
    title: { en: "Trailer-style product spot", vi: "Quảng cáo sản phẩm kiểu trailer" },
    description: {
      en: "The product carries three dramatic shots; the logo closes the spot.",
      vi: "Sản phẩm dẫn dắt 3 shot kịch tính; logo đóng lại đoạn quảng cáo.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Product photo", vi: "Ảnh sản phẩm" } },
      { label: "<Picture 3>", role: { en: "Brand logo", vi: "Logo thương hiệu" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the product, a matte black wireless earbud case], on the product sheet <Picture 2>, with its exact shape, finish and button placement.
<Subject 2> is the AURORA logo, on the logo sheet <Picture 3>, with its exact shape and colors.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> resting on [a dark wet stone surface] in low light.

summary:
[keyframe completion + reference generation] A 10-second 16:9 trailer-style product spot that begins from <Picture 1>, follows <Subject 1> through three shots, and closes on <Subject 2>.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - shape, finish and details, consistent in every shot.
<Subject 2> (appears in [Shot 3]): fully_preserved - logo shape and colors, undistorted.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing and lighting at the opening.

detailed_description:
High-end commercial look, deep blacks, a single hard rim light from behind, fine water droplets.
[Shot 1] The shot begins from <Picture 1>: a low macro shot of <Subject 1>. The camera slides slowly right. At 1.20 seconds, a bead of water runs down the stone and the rim light traces the edge of the case. At 2.50 seconds, the lid of <Subject 1> clicks open on its own.
[Shot 2] At 00:04.000, the shot cuts to a top-down close-up: the open <Subject 1> rotates a quarter turn on the stone as the light sweeps across the glossy interior.
[Shot 3] At 00:07.000, the shot cuts to black and <Subject 2> fades up at frame center, sharp and undistorted, then holds until the final frame. No other text appears.

overall_soundscape:
A crisp magnetic click as the lid opens, water droplets ticking on stone, a deep whoosh on each cut.

non_diegetic_music:
A tense, minimal electronic pulse building with each shot, ending on a single bass hit when the logo appears.`,
  },
  {
    id: "fashion_campaign",
    category: "brand",
    title: { en: "Fashion campaign film", vi: "Phim chiến dịch thời trang" },
    description: {
      en: "Model, product, mood/grain and logo each locked from its own reference.",
      vi: "Người mẫu, sản phẩm, tông màu/grain và logo đều khoá theo ảnh tham chiếu riêng.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 10,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Model face", vi: "Khuôn mặt người mẫu" } },
      { label: "<Picture 3>", role: { en: "Product (e.g. bag)", vi: "Sản phẩm (vd túi)" } },
      { label: "<Picture 4>", role: { en: "Mood / film grain reference", vi: "Ảnh mood / grain" } },
      { label: "<Picture 5>", role: { en: "Brand logo", vi: "Logo thương hiệu" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the model], on the character sheet <Picture 2>, with [sleek dark bob haircut and a cream silk dress].
<Subject 2> is [the handbag], on the product sheet <Picture 3>, with its exact leather color, stitching and clasp.
<Subject 3> is the visual style, on the mood sheet <Picture 4>, with its color palette and fine film grain.
<Subject 4> is the AURORA logo, on the logo sheet <Picture 5>.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> holding <Subject 2> on [a sunlit marble staircase].

summary:
[keyframe completion + reference generation] A 10-second 9:16 fashion campaign film that begins from <Picture 1>, cuts between <Subject 1> and <Subject 2> in the look of <Subject 3>, and closes on <Subject 4>.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - face, hair and dress.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - leather, stitching and clasp.
<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): attribute_transfer - palette and grain only, no content.
<Subject 4> (appears in [Shot 3]): fully_preserved - logo shape and colors.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing and pose at the opening.

detailed_description:
Editorial fashion film in the palette and grain of <Subject 3>, soft directional sunlight from the right.
[Shot 1] The shot begins from <Picture 1>: a full-body shot of <Subject 1> on the stairs. The camera tracks slowly upward. At 1.00 seconds, <Subject 1> takes one step down, the dress catching the light. At 2.50 seconds, she swings <Subject 2> from her hand to her shoulder and looks straight into the lens.
[Shot 2] At 00:04.500, the shot cuts to a close-up of <Subject 2> on her shoulder, fingers sliding along the clasp; sunlight glints on the hardware.
[Shot 3] At 00:07.500, the shot cuts to a clean cream background and <Subject 4> appears at frame center, then holds until the final frame. No other text appears.

overall_soundscape:
Heels on marble, the soft rustle of silk, the click of the clasp.

non_diegetic_music:
A slow, confident French-house groove with a muted bassline and airy synth pads.`,
  },
  {
    id: "keyframe_brand_film",
    category: "brand",
    title: { en: "Keyframe brand film", vi: "Phim thương hiệu theo keyframe" },
    description: {
      en: "A fixed lens mask (e.g. binoculars) while the view travels through 4 keyframes.",
      vi: "Khung mặt nạ cố định (vd ống nhòm), góc nhìn đi qua 4 keyframe.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: [
      { label: "<Picture 1>", role: { en: "Keyframe 1 / first frame", vi: "Keyframe 1 / first frame" } },
      { label: "<Picture 2>", role: { en: "Keyframe 2", vi: "Keyframe 2" } },
      { label: "<Picture 3>", role: { en: "Keyframe 3", vi: "Keyframe 3" } },
      { label: "<Picture 4>", role: { en: "Keyframe 4", vi: "Keyframe 4" } },
    ],
    prompt: `subject_definitions:
<Picture 1> is the first frame of [Shot 1], showing [a mountain lake] seen through a black double-circle binocular mask.
<Picture 2> is the keyframe at 3.00 seconds, showing [a hawk on a pine branch].
<Picture 3> is the keyframe at 6.00 seconds, showing [a waterfall mist cloud].
<Picture 4> is the keyframe at 9.00 seconds, showing [a hiker waving on a ridge at sunrise].

summary:
[keyframe completion] A 12-second 16:9 single take through a fixed double-circle binocular mask that begins from <Picture 1> and travels through <Picture 2>, <Picture 3> and <Picture 4> in order.

retention_analysis:
<Picture 1> ([Shot 1] first frame): fully_preserved - view and mask at the opening.
<Picture 2> ([Shot 1] keyframe): fully_preserved - composition reached at 3.00 seconds.
<Picture 3> ([Shot 1] keyframe): fully_preserved - composition reached at 6.00 seconds.
<Picture 4> ([Shot 1] keyframe): fully_preserved - composition reached at 9.00 seconds.

detailed_description:
Natural documentary look, crisp morning light. The black double-circle binocular mask stays perfectly fixed at frame center the whole time; only the view inside it moves.
[Shot 1] The shot begins from <Picture 1>. The view pans slowly right across the lake. At 1.50 seconds, the view tilts up the shoreline pines. At 3.00 seconds, it settles exactly on <Picture 2>; the hawk turns its head. At 4.50 seconds, the view whips gently left with a short focus breath. At 6.00 seconds, it lands on <Picture 3>, mist rolling through the frame. At 7.50 seconds, the view tilts up the cliff. At 9.00 seconds, it reaches <Picture 4>; the hiker raises an arm and waves. The view holds on the hiker until the final frame. ${NO_TEXT}

overall_soundscape:
Lake lapping, a hawk cry at 3 seconds, the roar of the waterfall rising and fading, wind on the ridge.

non_diegetic_music:
A warm, hopeful acoustic guitar melody with soft strings joining at the final keyframe.`,
  },

  // --------------------------------------------------------------- ecommerce
  {
    id: "same_sku_three_scenes",
    category: "ecommerce",
    title: { en: "Same SKU, three scenes", vi: "Một sản phẩm, ba bối cảnh" },
    description: {
      en: "The product stays identical across three locations.",
      vi: "Sản phẩm giữ y nguyên qua 3 địa điểm khác nhau.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 9,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Product photo", vi: "Ảnh sản phẩm" } },
      { label: "<Picture 3>", role: { en: "Spec sheet / detail shot", vi: "Ảnh thông số / chi tiết" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the product, a stainless steel insulated bottle], on the product sheet <Picture 2>, with its exact color, cap and engraving; details on <Picture 3>.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> on [a kitchen counter in morning light].

summary:
[keyframe completion + reference generation] A 9-second 9:16 product video that begins from <Picture 1> and shows the identical <Subject 1> in three locations, one per shot.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - shape, color, cap and engraving identical in every scene, never redesigned.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing and lighting at the opening.

detailed_description:
Bright, clean e-commerce look, true-to-life product colors, the product always sharp at frame center.
[Shot 1] The shot begins from <Picture 1>: a close-up of <Subject 1> on the counter. The camera pushes in gently. At 1.00 seconds, a hand twists the cap open and steam rises.
[Shot 2] At 00:03.000, the shot cuts to <Subject 1> in the side pocket of [a hiking backpack] on a mountain trail; the camera slowly orbits a few degrees as sunlight flares on the steel.
[Shot 3] At 00:06.000, the shot cuts to <Subject 1> on [an office desk] next to a laptop; a hand lifts it and condensation beads on the surface. The camera holds on the product until the final frame. ${NO_TEXT}

overall_soundscape:
A cap twist and soft steam hiss, birdsong and trail wind, a quiet office hum and keyboard taps.

non_diegetic_music:
An upbeat, light pop beat with plucked guitar, changing feel slightly at each cut.`,
  },
  {
    id: "kitchen_action_moment",
    category: "ecommerce",
    title: { en: "Kitchen action moment", vi: "Khoảnh khắc nấu ăn" },
    description: {
      en: "A cast member performs one clean, choreographed product action.",
      vi: "Một diễn viên thực hiện một động tác dùng sản phẩm gọn, có biên đạo.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 7,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Cast member photo", vi: "Ảnh diễn viên" } },
      { label: "<Picture 3>", role: { en: "Product photo", vi: "Ảnh sản phẩm" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the home cook], on the character sheet <Picture 2>, with [curly hair tied up and a green apron].
<Subject 2> is [the product, a non-stick frying pan], on the product sheet <Picture 3>.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> at a stove holding <Subject 2>.

summary:
[keyframe completion + reference generation] A 7-second 9:16 medium shot that begins from <Picture 1>. <Subject 1> flips an omelette in <Subject 2> in one clean motion and smiles at the camera.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair and apron.
<Subject 2> (appears in [Shot 1]): fully_preserved - pan shape, color and handle.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing, kitchen and lighting.
No costume change, no face change, no second person.

detailed_description:
Warm lifestyle commercial look, soft window light from the left.
[Shot 1] The shot begins from <Picture 1>: a medium shot at eye level. The camera holds still. At 0.60 seconds, <Subject 1> tilts <Subject 2>, the omelette sliding freely on the surface. At 1.80 seconds, she flicks her wrist and the omelette lifts, turns over in the air and lands perfectly back in the pan. At 3.20 seconds, she exhales a small laugh, shoulders relaxing. At 4.80 seconds, she slides the omelette onto a plate and turns toward the camera. At 7.00 seconds, she holds the pan and plate still, smiling at the lens. Natural real-time speed, no slow motion. ${NO_TEXT}

overall_soundscape:
Butter sizzling, a soft whoosh and thump as the omelette lands, a plate clink.

non_diegetic_music:
A breezy, bright ukulele and hand-clap track at a medium tempo.`,
  },

  // -------------------------------------------------------------------- drama
  {
    id: "penthouse_contract",
    category: "drama",
    title: { en: "Penthouse contract scene", vi: "Cảnh ký hợp đồng ở penthouse" },
    description: {
      en: "Four vertical cuts between two leads, ending on a spoken cliffhanger.",
      vi: "4 cú cắt dọc giữa 2 nhân vật chính, kết bằng câu thoại cliffhanger.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 12,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Lead A (man)", vi: "Nhân vật A (nam)" } },
      { label: "<Picture 3>", role: { en: "Lead B (woman)", vi: "Nhân vật B (nữ)" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the CEO], on the character sheet <Picture 2>, with [slicked-back hair and a charcoal three-piece suit].
<Subject 2> is [the young woman], on the character sheet <Picture 3>, with [long straight hair and a white blouse].
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> and <Subject 2> on opposite sides of a glass desk in a night-time penthouse.

summary:
[keyframe completion + reference generation] A 12-second 9:16 short-drama scene that begins from <Picture 1> and cuts four times between <Subject 1> and <Subject 2> over a contract, ending on a cliffhanger line.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 4]): fully_preserved - face, hair and suit.
<Subject 2> (appears in [Shot 1], [Shot 3], [Shot 4]): fully_preserved - face, hair and blouse.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing, city lights and desk.

detailed_description:
Glossy short-drama look, cool city-light blue from the windows behind, warm desk lamp on the faces.
[Shot 1] The shot begins from <Picture 1>: a medium two-shot. The camera holds still. At 0.80 seconds, <Subject 1> slides a contract and a black pen across the glass toward <Subject 2>.
[Shot 2] At 00:02.500, the shot cuts to a close-up of <Subject 1> (S1), leaning back, jaw set. He says, <d>[English] [One year. Then you walk away with everything.]</d>
[Shot 3] At 00:06.000, the shot cuts to a close-up of <Subject 2>; her fingers hover over the pen, then close around it. She swallows once.
[Shot 4] At 00:08.500, the shot cuts to an over-the-shoulder shot from behind <Subject 1>; <Subject 2> (S2) signs, looks up and says, <d>[English] [You have no idea who I really am.]</d> She holds his gaze until the final frame. ${NO_TEXT}

overall_soundscape:
A quiet penthouse hum, paper sliding on glass, a pen scratch, distant city traffic far below.

non_diegetic_music:
A tense, low piano ostinato with a sustained string note rising under the final line.`,
  },
  {
    id: "gothic_corridor_confession",
    category: "drama",
    title: { en: "Gothic corridor confession", vi: "Lời thú nhận ở hành lang gothic" },
    description: {
      en: "Escalating shot sizes between two leads in a castle, cut to black.",
      vi: "Cỡ cảnh tăng dần giữa 2 nhân vật trong lâu đài, cắt sang màn đen.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 11,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Lead A", vi: "Nhân vật A" } },
      { label: "<Picture 3>", role: { en: "Lead B", vi: "Nhân vật B" } },
      { label: "<Picture 4>", role: { en: "Castle corridor scene", vi: "Bối cảnh hành lang lâu đài" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the knight], on the character sheet <Picture 2>, with [dark wavy hair and a worn leather doublet].
<Subject 2> is [the princess], on the character sheet <Picture 3>, with [braided silver hair and a deep crimson gown].
<Subject 3> is the castle corridor, on the scene sheet <Picture 4>, with stone arches and candle sconces.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> and <Subject 2> facing each other at the far end of <Subject 3>.

summary:
[keyframe completion + reference generation] An 11-second 9:16 confession that begins from <Picture 1>, moves from wide to medium to extreme close-up, and cuts to black on the final word.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - face, hair and doublet.
<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - face, hair and gown.
<Subject 3> (appears in [Shot 1], [Shot 2]): partially_preserved - architecture and candlelight.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing at the opening.

detailed_description:
Gothic period drama, flickering warm candlelight from the wall sconces on the left, deep blue shadows.
[Shot 1] The shot begins from <Picture 1>: a wide shot down <Subject 3>. The camera holds still. At 1.00 seconds, <Subject 2> takes one step toward <Subject 1>, the gown sweeping the stone.
[Shot 2] At 00:03.000, the shot cuts to a medium two-shot in profile; <Subject 1> (S1) lowers his eyes and says, <d>[English] [I was sent to watch you. Not to protect you.]</d>
[Shot 3] At 00:07.000, the shot cuts to an extreme close-up of <Subject 2>'s eyes; a tear catches the candlelight. She whispers (S2), <d>[English] [I know.]</d>
[Shot 4] At 00:10.000, the shot cuts to black and holds until the final frame. ${NO_TEXT}

overall_soundscape:
Candle flames guttering, a distant wind through the arches, the gown brushing stone, then total silence on black.

non_diegetic_music:
A mournful solo cello, swelling slightly before cutting out exactly at the black frame.`,
  },
  {
    id: "storyboard_character_pv",
    category: "drama",
    title: { en: "Storyboard-driven character PV", vi: "Character PV theo storyboard" },
    description: {
      en: "Follows a storyboard grid's shot flow with an identity locked by a turnaround sheet.",
      vi: "Bám thứ tự shot của storyboard, khoá nhân vật theo sheet xoay vòng.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 10,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Storyboard grid", vi: "Lưới storyboard" } },
      { label: "<Picture 3>", role: { en: "Character turnaround sheet", vi: "Sheet nhân vật xoay vòng" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the character], on the turnaround sheet <Picture 3>, with [ash-blonde hair, a navy school blazer and a red ribbon].
<Subject 2> is the shot flow, on the storyboard sheet <Picture 2>, with its panel order, framing and poses.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> under [a cherry blossom tree].

summary:
[keyframe completion + reference generation] A 10-second 9:16 romance character PV that begins from <Picture 1> and follows the panel order of <Subject 2>, with <Subject 1> identical in every shot.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - face, hair and uniform from every angle of the sheet.
<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3]): attribute_transfer - framing, pose and order only; the grid itself never appears on screen.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing at the opening.

detailed_description:
Soft romance-game look, pastel spring palette, backlit sun through petals.
[Shot 1] The shot begins from <Picture 1>, matching panel 1 of <Subject 2>: a medium shot. The camera slowly tracks left as petals drift. At 1.50 seconds, <Subject 1> tucks hair behind her ear.
[Shot 2] At 00:03.500, the shot cuts to panel 2: a close-up as <Subject 1> turns her head toward the lens and her eyes widen slightly.
[Shot 3] At 00:06.500, the shot cuts to panel 3: a low angle as <Subject 1> reaches toward the camera with an open hand, smiling. She holds the pose until the final frame. ${NO_TEXT}

overall_soundscape:
A light breeze, petals rustling, a distant school bell.

non_diegetic_music:
A gentle J-pop piano melody with a soft music-box counterline.`,
  },
  {
    id: "wuxia_handoff",
    category: "drama",
    title: { en: "Wuxia handoff", vi: "Trao thư kiếm hiệp" },
    description: {
      en: "A sealed letter passes between two leads in a misty bamboo forest.",
      vi: "Bức thư niêm phong được trao giữa 2 nhân vật trong rừng trúc sương mù.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Lead A", vi: "Nhân vật A" } },
      { label: "<Picture 3>", role: { en: "Lead B", vi: "Nhân vật B" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the swordswoman], on the character sheet <Picture 2>, with [a black topknot and a white hanfu with a sword at the hip].
<Subject 2> is [the masked courier], on the character sheet <Picture 3>, with [a bamboo hat and a dark grey cloak].
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> waiting on a path in a misty bamboo forest.

summary:
[keyframe completion + reference generation] A 10-second 16:9 wuxia scene that begins from <Picture 1>. <Subject 2> drops from the canopy, hands <Subject 1> a sealed letter and vanishes into the mist.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - face, hair, robe and sword.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - hat, mask and cloak.
<Picture 1> ([Shot 1] first frame): fully_preserved - forest, mist and framing.

detailed_description:
Classic wuxia cinema, soft green diffused light filtering through bamboo, drifting mist.
[Shot 1] The shot begins from <Picture 1>: a wide shot. The camera holds still. At 1.00 seconds, bamboo leaves shiver above. At 2.00 seconds, <Subject 2> lands lightly on the path facing <Subject 1>, cloak settling.
[Shot 2] At 00:03.500, the shot cuts to a medium two-shot; <Subject 2> holds out a letter sealed with red wax. <Subject 2> (S1) says in a low voice, <d>[English] [Burn it after you read it.]</d> At 6.50 seconds, <Subject 1> takes the letter and her hand tightens on her sword hilt.
[Shot 3] At 00:08.000, the shot cuts to a close-up of the red wax seal in <Subject 1>'s fingers while, out of focus behind it, <Subject 2> leaps back into the mist. Hold until the final frame. ${NO_TEXT}

overall_soundscape:
Bamboo creaking, leaves rustling, a soft thud of landing, cloth snapping in the wind.

non_diegetic_music:
A sparse guqin melody over a low, breathy xiao flute.`,
  },

  // ---------------------------------------------------------------- animation
  {
    id: "claymation_chase",
    category: "animation",
    title: { en: "Claymation chase", vi: "Rượt đuổi đất sét" },
    description: {
      en: "Stop-motion clay style with fingerprints and stepped frame cadence.",
      vi: "Phong cách stop-motion đất sét, có dấu vân tay và nhịp khung hình giật.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Clay style / character image", vi: "Ảnh phong cách / nhân vật đất sét" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the clay fox], on the style sheet <Picture 2>, with its orange plasticine body, visible fingerprints and button eyes.
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> crouched behind a cardboard hedge in a miniature garden set.

summary:
[keyframe completion + reference generation] An 8-second 16:9 stop-motion chase that begins from <Picture 1>; <Subject 1> bolts after a clay chicken across the miniature set.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - clay texture, fingerprints, colors and proportions.
<Picture 1> ([Shot 1] first frame): fully_preserved - the handmade set, framing and lighting.

detailed_description:
Handmade stop-motion animation at a stepped 12 frames per second cadence, slight frame-to-frame jitter, visible thumbprints on every clay surface, warm practical tabletop lighting.
[Shot 1] The shot begins from <Picture 1>: a low tabletop shot. The camera tracks right in small steps. At 0.70 seconds, a clay chicken waddles past the hedge. At 1.50 seconds, <Subject 1> leaps out, ears flattening, body squashing and stretching. At 3.00 seconds, the chicken flaps and runs; felt grass tufts bounce under both. At 5.00 seconds, <Subject 1> skids on a cotton-wool puddle and tumbles. At 6.50 seconds, <Subject 1> sits up dazed with a little clay feather stuck on its nose and blinks twice, then holds still until the final frame. ${NO_TEXT}

overall_soundscape:
Squishy clay footsteps, a squawking chicken, a soft cartoon thump on the tumble.

non_diegetic_music:
A bouncy pizzicato strings and xylophone chase tune at a fast tempo.`,
  },
  {
    id: "anime_title_sequence",
    category: "animation",
    title: { en: "Jazz-crime anime title sequence", vi: "Mở đầu anime jazz-noir" },
    description: {
      en: "On-beat transitions across style frames; avoids horror tone and repeated credits.",
      vi: "Chuyển cảnh theo nhịp qua các khung phong cách; tránh tông kinh dị và lặp credit.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Style frame 1", vi: "Khung phong cách 1" } },
      { label: "<Picture 3>", role: { en: "Style frame 2", vi: "Khung phong cách 2" } },
      { label: "<Picture 4>", role: { en: "Style frame 3", vi: "Khung phong cách 3" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is the art style, on the style sheets <Picture 2>, <Picture 3> and <Picture 4>, with flat bold color blocks, thick ink outlines and halftone shading.
<Subject 2> is [the detective], shown in <Picture 1>, with [a long coat and a loosened tie].
<Picture 1> is the first frame of [Shot 1], showing <Subject 2> silhouetted against a red-orange city skyline.

summary:
[keyframe completion + reference generation] A 12-second 16:9 jazz-crime anime title sequence that begins from <Picture 1>, in the style of <Subject 1>, with four transitions landing on the beat.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3], [Shot 4]): attribute_transfer - palette, outlines and halftone only.
<Subject 2> (appears in [Shot 1], [Shot 3], [Shot 4]): fully_preserved - silhouette, coat and tie.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing at the opening.

detailed_description:
Retro 1990s anime title-sequence look in the style of <Subject 1>; stylish and cool, never horror, no gore, no repeated credits.
[Shot 1] The shot begins from <Picture 1>. The silhouette of <Subject 2> lights a cigarette; the flame flares.
[Shot 2] At 00:03.000, on the beat, a hard graphic wipe reveals a bold color-block split screen of rain on a neon street.
[Shot 3] At 00:06.000, on the beat, <Subject 2> turns sharply in a three-quarter view, coat swinging, against a flat blue background.
[Shot 4] At 00:09.000, on the beat, the title ECHO slams in once in thick hand-painted letters over a freeze frame of <Subject 2>, and holds until the final frame. No watermarks.

overall_soundscape:
Rain hiss, a lighter flick, a short tire screech on the second wipe.

non_diegetic_music:
A fast, brassy big-band jazz riff with walking upright bass and a snare fill before every transition.`,
  },

  // -------------------------------------------------------------------- audio
  {
    id: "voice_cloned_narration",
    category: "audio",
    title: { en: "Voice-referenced talking shot", vi: "Nói theo giọng tham chiếu" },
    description: {
      en: "A speaker delivers a message in the timbre of a voice sample, lip-synced.",
      vi: "Nhân vật nói theo âm sắc của mẫu giọng, khớp khẩu hình.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 8,
    inputs: [
      FIRST_FRAME,
      { label: "<Picture 2>", role: { en: "Speaker portrait", vi: "Ảnh chân dung người nói" } },
      { label: "<Audio 1>", role: { en: "Voice sample (timbre)", vi: "Mẫu giọng (âm sắc)" } },
    ],
    prompt: `subject_definitions:
<Subject 1> is [the presenter], on the character sheet <Picture 2>, with [short grey hair, round glasses and a navy cardigan].
<Picture 1> is the first frame of [Shot 1], showing <Subject 1> seated at [a wooden desk in a cozy study].
<Audio 1> is the voice-timbre reference for <Subject 1> (S1), a spoken English vocal layer.

summary:
[keyframe completion + reference generation + audio reference] An 8-second 9:16 medium close-up that begins from <Picture 1>. <Subject 1> delivers a short message in the timbre of <Audio 1> with accurate lip-sync.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, glasses and cardigan.
<Picture 1> ([Shot 1] first frame): fully_preserved - framing, study and lighting.
<Audio 1>: reference - the timbre guides the voice without copying the original recording.
No costume change, no face change, no second person.

detailed_description:
Warm documentary interview look, soft lamp light from the right, shallow depth of field.
[Shot 1] The shot begins from <Picture 1>: a medium close-up at eye level. The camera holds still. At 0.60 seconds, <Subject 1> looks up from a notebook to the lens and lays the pen down. At 1.20 seconds, <Subject 1> (S1) leans in slightly and, in the warm timbre referenced from <Audio 1>, says, <d>[English] [Every story starts with one small decision. Here is mine.]</d> At 5.50 seconds, <Subject 1> gives a small nod and a faint smile. At 8.00 seconds, <Subject 1> rests both hands on the desk, holding eye contact. ${NO_TEXT}

overall_soundscape:
Quiet room tone, a pen set down on wood, a clock ticking softly.

non_diegetic_music:
N/A`,
  },
  {
    id: "sound_designed_silence",
    category: "audio",
    title: { en: "Sound-designed silence", vi: "Khoảnh khắc lặng, thiết kế âm thanh" },
    description: {
      en: "A near-silent scene built around precise, timed sound cues.",
      vi: "Cảnh gần như im lặng, dựng quanh các tiếng động căn đúng thời điểm.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: [FIRST_FRAME],
    prompt: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description:
Quiet, intimate live-action film look, last golden-hour light through tall windows, dust in the air.
[Shot 1] The shot begins from <Picture 1>: [a librarian] alone between tall shelves at closing time, a wide shot at eye level. The camera holds still. At 0.80 seconds, she slides one last book onto a shelf with a soft wooden knock. At 2.20 seconds, a desk lamp at the far end clicks off by itself and she pauses, head turning. At 3.80 seconds, the old wall clock begins to strike once, deep and slow. At 5.20 seconds, she exhales, picks up her keys with a small jingle and walks toward the door. At 8.00 seconds, she stands at the door, one hand on the light switch, looking back at the empty room. Natural real-time speed. ${NO_TEXT}

overall_soundscape:
Near silence with a faint room tone; a book knocking wood, a lamp switch click, one deep clock chime, a key jingle, footsteps on old floorboards.

non_diegetic_music:
N/A`,
  },
];

// Image-model prompts for the `<Picture N>` inputs of the pixo templates, in
// input order, so "Create & run" can generate the pictures instead of waiting
// for uploads.
const PIXO_IMAGE_PROMPTS: Record<string, readonly string[]> = {
  scifi_trailer_beat: [
    "Cinematic wide shot of an astronaut in a white suit and helmet standing at the edge of a frozen alien plateau under a sky with two pale moons, cold teal shadows, anamorphic widescreen, film grain",
  ],
  macro_match_morph: [
    "Extreme macro photograph of coffee foam swirling in a cup, caramel streaks, warm low-angle light, shallow depth of field",
    "Texture sheet photo of coffee foam with fine milky bubbles and caramel streaks",
    "Landscape photo of golden desert dunes with sharp wind-carved ridges and warm light",
  ],
  add_cast_member: [
    "Cinematic vertical photo of an empty rain-wet street corner at night under a single yellow streetlight",
    "Character sheet of a person with short black hair and a beige trench coat, front, side and back views, plain background",
  ],
  product_trailer_spot: [
    "Low macro photo of a matte black wireless earbud case resting on dark wet stone in low light with a hard rim light",
    "Product photo of a matte black wireless earbud case on a neutral background",
    "A simple geometric brand logo mark in white on a solid black background, no text",
  ],
  fashion_campaign: [
    "Full-body editorial photo of a woman with a sleek dark bob in a cream silk dress holding a leather handbag on a sunlit marble staircase, vertical",
    "Fashion portrait of a woman with a sleek dark bob and a cream silk dress, neutral background",
    "Product photo of a leather handbag with a gold clasp on a neutral background",
    "Soft warm editorial film photograph in a cream and gold palette with fine film grain, no subject",
    "A minimalist geometric brand mark in dark ink on a cream background, no text",
  ],
  keyframe_brand_film: [
    "Photo of a calm mountain lake seen through a black double-circle binocular mask, documentary look",
    "Photo of a hawk on a pine branch seen through a black double-circle binocular mask",
    "Photo of a waterfall mist cloud seen through a black double-circle binocular mask",
    "Photo of a hiker waving on a ridge at sunrise seen through a black double-circle binocular mask",
  ],
  same_sku_three_scenes: [
    "Vertical photo of a stainless steel insulated bottle on a kitchen counter in morning light",
    "Product photo of a brushed stainless steel insulated bottle with a black cap on a white background",
    "Macro detail photo of the cap and laser engraving of a stainless steel insulated bottle",
  ],
  kitchen_action_moment: [
    "Vertical photo of a home cook with curly hair tied up wearing a green apron at a stove holding a non-stick frying pan in a bright kitchen",
    "Portrait of a home cook with curly hair tied up and a green apron, neutral background",
    "Product photo of a non-stick frying pan on a white background",
  ],
  penthouse_contract: [
    "Vertical cinematic photo of a night-time penthouse with a glass desk, a CEO with slicked-back hair in a charcoal three-piece suit on one side and a young woman with long straight hair in a white blouse on the other, city lights behind",
    "Portrait of a man with slicked-back hair in a charcoal three-piece suit, neutral dark background",
    "Portrait of a young woman with long straight hair in a white blouse, neutral dark background",
  ],
  gothic_corridor_confession: [
    "Vertical cinematic photo of a knight with dark wavy hair in a worn leather doublet and a princess with braided silver hair in a deep crimson gown facing each other at the far end of a gothic stone corridor with candle sconces",
    "Portrait of a knight with dark wavy hair and a worn leather doublet, neutral background",
    "Portrait of a princess with braided silver hair and a deep crimson gown, neutral background",
    "Empty gothic castle corridor with stone arches and candle sconces, moody light, vertical",
  ],
  storyboard_character_pv: [
    "Vertical anime-style illustration of a girl with ash-blonde hair in a navy school blazer and a red ribbon standing under a cherry blossom tree",
    "Four-panel storyboard grid of an anime girl with ash-blonde hair and a navy blazer walking, turning, smiling and looking up, no text",
    "Character turnaround sheet of an anime girl with ash-blonde hair, a navy school blazer and a red ribbon, front, side and back views, plain background",
  ],
  wuxia_handoff: [
    "Cinematic photo of a swordswoman with a black topknot in a white hanfu with a sword at the hip waiting on a path in a misty bamboo forest",
    "Character sheet of a swordswoman with a black topknot in a white hanfu with a sword at the hip, plain background",
    "Character sheet of a masked courier in a bamboo hat and a dark grey cloak, plain background",
  ],
  claymation_chase: [
    "Stop-motion claymation scene of an orange plasticine fox with button eyes crouched behind a cardboard hedge in a miniature garden set",
    "Style sheet of an orange plasticine clay fox with visible fingerprints and button eyes, plain background",
  ],
  anime_title_sequence: [
    "Retro 1960s crime anime frame of a detective in a long coat and loosened tie silhouetted against a red-orange city skyline, flat color blocks, thick ink outlines, halftone shading",
    "Retro 1960s crime anime frame of a vintage car speeding through a rainy night street, flat color blocks, thick ink outlines, halftone shading",
    "Retro 1960s crime anime frame of a black-gloved hand sliding an envelope across a table, flat color blocks, thick ink outlines, halftone shading",
    "Retro 1960s crime anime frame of two figures on a rooftop under a giant yellow moon, flat color blocks, thick ink outlines, halftone shading",
  ],
  voice_cloned_narration: [
    "Vertical photo of a presenter with short grey hair, round glasses and a navy cardigan seated at a wooden desk in a cozy study",
    "Portrait of a presenter with short grey hair, round glasses and a navy cardigan, neutral background",
  ],
  sound_designed_silence: [
    "Wide cinematic photo of a librarian alone between tall wooden shelves at closing time, golden-hour light through tall windows, dust in the air",
  ],
};

function withImagePrompts(
  template: Omit<H3PromptTemplate, "source">,
): H3PromptTemplate {
  const prompts = PIXO_IMAGE_PROMPTS[template.id] ?? [];
  let pictureIndex = 0;
  return {
    ...template,
    source: "pixo",
    inputs: template.inputs.map((input) =>
      input.label.startsWith("<Picture")
        ? { ...input, imagePrompt: prompts[pictureIndex++] }
        : input,
    ),
  };
}

export const H3_PROMPT_TEMPLATES: readonly H3PromptTemplate[] = [
  ...FAL_H3_PROMPT_TEMPLATES,
  ...PIXO_TEMPLATES.map(withImagePrompts),
];

/** The frontend video gen mode a template runs in. */
export function h3TemplateGenMode(template: H3PromptTemplate): VideoGenMode {
  if (template.mode === "fl2va") return "firstFrame";
  if (template.mode === "flf2va") return "firstLastFrame";
  return "imageReference";
}

// Square brackets that are part of the official H3 format and must survive.
const KEEP_BRACKET = /^(Shot \d+|keyframe completion.*|reference generation|English|Vietnamese|Chinese|Japanese|Korean)$/;

/**
 * The prompt as it is sent when a template is applied: descriptive `[sample
 * values]` are unwrapped, while `[Shot N]`, `[keyframe completion + reference
 * generation]` and `<d>[Language] ...</d>` tags stay.
 */
export function h3TemplateRunnablePrompt(template: H3PromptTemplate): string {
  return template.prompt.replace(/\[([^\]\n]+)\]/g, (match, inner: string) =>
    KEEP_BRACKET.test(inner.trim()) ? match : inner,
  );
}

export function h3TemplateText(value: Localized, language: string | undefined): string {
  return String(language ?? "").toLowerCase().startsWith("vi") ? value.vi : value.en;
}

/** Image inputs (excluding `<Audio N>`) a template expects, first frame included. */
export function h3TemplateImageCount(template: H3PromptTemplate): number {
  return template.inputs.filter((input) => input.label.startsWith("<Picture")).length;
}
