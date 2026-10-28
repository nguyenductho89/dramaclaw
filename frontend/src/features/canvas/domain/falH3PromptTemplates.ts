// MiniMax-H3 templates adapted from the example prompts in the fal.ai H3
// prompting guide (https://fal.ai/learn/devs/minimax-h3-prompting-guide).
//
// Only the guide's image-only / no-media examples are included: the RunPod H3
// backend takes no reference video. Prompts are re-written in our own words
// in the official H3 layout, with fixed sample values instead of placeholders
// so a template can run as-is, 5-12 s, 16:9 or 9:16. Each `<Picture N>` input
// carries an `imagePrompt` so the canvas can generate it with an image model
// (or the user can upload a picture instead).
import type { H3PromptTemplate } from "./h3PromptTemplates";
import {
  buildFramePrompt,
  buildRefPrompt,
  picInputs,
} from "./falH3PromptBuilders";

export const FAL_H3_PROMPT_TEMPLATES: readonly H3PromptTemplate[] = [
  // ---------------------------------------------------------------- cinematic
  {
    id: "fal_space_opera",
    source: "fal",
    category: "cinematic",
    title: { en: "Space opera teaser", vi: "Teaser space opera" },
    description: {
      en: "Fast hard cuts, white flashes and a warp jump ending on an animated title.",
      vi: "Cắt nhanh, chớp trắng, nhảy warp và kết bằng tiêu đề động.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: starship command deck",
        vi: "First frame: buồng chỉ huy tàu vũ trụ",
        image:
          "Cinematic wide shot inside a starship command deck, crew silhouettes at glowing consoles, red warning lights, a huge window showing a gas giant and stars, anamorphic widescreen, high contrast",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Epic space opera teaser, anamorphic widescreen, high contrast, hard cuts only, no slow pacing.",
      shots: [
        "A wide shot begins from <Picture 1>: the command deck shakes, consoles flicker and sparks fall. The handheld camera shakes with it. At 1.20 seconds, a white flash fills the frame for two frames.",
        "At 00:03.000, a hard cut to a close-up of the captain's face lit red, eyes locked on the window, then a second white flash.",
        "At 00:05.000, a hard cut through one black frame to the exterior: the starship stretches into streaks of light in a warp jump, a ring shockwave expanding behind it.",
        "At 00:07.500, the shot cuts to black. Wide-tracked metallic title letters reading ASCEND emerge from shadow, catch starlight, widen their spacing, leave a faint afterimage and flash once against black, then hold until the final frame.",
      ],
      sound:
        "Alarm klaxons, a metal groan, deep impact booms on every flash, a rising warp whine cut dead by silence on the black frame.",
      music:
        "A fast percussive orchestral build with brass stabs and a choir, landing on one massive final chord as the title flashes.",
    }),
  },
  {
    id: "fal_gateway_mystery",
    source: "fal",
    category: "cinematic",
    title: { en: "Sci-fi mystery teaser", vi: "Teaser bí ẩn khoa học viễn tưởng" },
    description: {
      en: "Ultra-wide cosmic gateway, slow push-in, title resolving out of blur.",
      vi: "Cổng vũ trụ siêu rộng, đẩy máy chậm, tiêu đề hiện ra từ mờ.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: gateway establishing shot",
        vi: "First frame: cảnh toàn cổng vũ trụ",
        image:
          "Ultra-wide cinematic shot of a gigantic circular cosmic gateway with a black center, a tiny figure seen from behind low and slightly right of center, wet reflective ground, dark crimson and rust palette, mist",
      },
      {
        en: "Protagonist",
        vi: "Nhân vật chính",
        image:
          "Full-body character sheet of a lone explorer in a weathered rust-colored coat and hood, seen from the back and three-quarter view, plain grey background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the explorer], on the character sheet <Picture 2>, with a weathered rust-colored hooded coat.",
        "<Picture 1> is the first frame of [Shot 1], showing the gateway and <Subject 1> small in the lower right.",
      ],
      summary:
        "A 10-second 16:9 mystery teaser that begins from <Picture 1>, pushes slowly toward the gateway, and ends on a title card.",
      retention: [
        "<Subject 1> (appears in [Shot 1]): fully_preserved - coat, hood and silhouette, seen only from behind.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - gateway scale, wet ground and color palette.",
      ],
      look: "Dark, restrained sci-fi mystery look, heavy mist, crimson and rust tones, fine grain, no handheld shake.",
      shots: [
        "The shot begins from <Picture 1>: an ultra-wide view of the gateway with <Subject 1> tiny at the lower right. The camera pushes forward very slowly. At 2.50 seconds, the black center of the gateway ripples once like water. At 5.00 seconds, a thin ring of pale light traces the gateway's edge and reflects across the wet ground.",
        "At 00:07.000, a hard cut to black. A condensed, heavy all-caps title reading THRESHOLD resolves out of blur in dark crimson and rust, mist softening its edges, and holds until the final frame.",
      ],
      sound:
        "A deep sub-bass pulse, a distant metallic resonance, one heavy hit exactly as the title locks, then silence.",
      music: "N/A",
    }),
  },
  {
    id: "fal_fps_gameplay",
    source: "fal",
    category: "cinematic",
    title: { en: "First-person tactical gameplay", vi: "Gameplay chiến thuật góc nhìn thứ nhất" },
    description: {
      en: "Handheld first-person advance along a base perimeter, quick checks, shots with light recoil.",
      vi: "Góc nhìn thứ nhất cầm tay tiến dọc hàng rào căn cứ, kiểm tra nhanh, bắn có giật nhẹ.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: first-person view on the perimeter road",
        vi: "First frame: góc nhìn thứ nhất trên đường quanh căn cứ",
        image:
          "Photorealistic first-person view of a soldier's gloved hands holding a rifle, standing on a military base perimeter road beside concrete barriers, cool daylight, haze and a little smoke in the distance",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Photorealistic first-person tactical shooter footage, eye-level handheld camera, crisp cool daylight mixed with drifting smoke and distant firelight, dust and haze in the air.",
      shots: [
        "The shot begins from <Picture 1>: the player advances slowly along the perimeter road, keeping close to the concrete cover on the left, the rifle bobbing with each step. At 2.00 seconds, a quick look right, then left, checking the corners. At 4.00 seconds, the player raises the rifle and fires three controlled shots at a distant target; light recoil kicks the view up slightly each time and brass casings flick past. At 6.50 seconds, the view settles and the player keeps moving forward, steady and unhurried, until the final frame.",
      ],
      sound:
        "Boots on gravel, gear rattling, distinct rifle shots with a short distant echo, a faint ringing, wind and far-off engine noise.",
      music: "N/A",
    }),
  },
  {
    id: "fal_macro_coffee_dunes",
    source: "fal",
    category: "cinematic",
    title: { en: "Macro coffee to desert dunes", vi: "Macro cà phê thành đồi cát" },
    description: {
      en: "One continuous push-in: coffee foam becomes desert dunes with no cut.",
      vi: "Một cú đẩy máy liền mạch: bọt cà phê biến thành đồi cát, không cắt.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: coffee macro",
        vi: "First frame: macro cà phê",
        image:
          "Extreme macro photograph of coffee foam with cocoa powder particles, swirling milky bubbles and caramel streaks, shallow depth of field, backlit powder in the air",
      },
      {
        en: "Desert dunes",
        vi: "Đồi cát sa mạc",
        image:
          "Wide landscape photograph of golden desert dunes with sharp wind-carved ridges, soft low sun, hazy horizon",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the coffee foam surface], on <Picture 1>, with milky bubbles, cocoa particles and caramel streaks.",
        "<Subject 2> is [the desert dunescape], on the landscape sheet <Picture 2>, with wind-carved ridges and warm golden sand.",
        "<Picture 1> is the first frame of [Shot 1], an extreme macro of <Subject 1>.",
      ],
      summary:
        "An 8-second 16:9 single continuous take that begins from <Picture 1>, rushes in on <Subject 1>, and morphs seamlessly into <Subject 2>, finishing on a wide view of the dunes.",
      retention: [
        "<Subject 1> (appears in [Shot 1]): fully_preserved - bubble texture and cocoa particles at the opening.",
        "<Subject 2> (appears in [Shot 1]): attribute_transfer - ridge shapes and sand color become the closing landscape.",
        "No tearing, no black frames, no hard cuts, no visible seams or obvious VFX.",
      ],
      look: "Photorealistic macro cinematography, shallow focus, backlit powder drifting through the light, one unbroken shot.",
      shots: [
        "The shot begins from <Picture 1>. The camera rushes forward fast over <Subject 1>. At 2.00 seconds, the foam ridges stretch and the surface begins to look like dunes. At 3.50 seconds, the bubbles dissolve into sharp sand ridges as the scale silently grows. At 5.00 seconds, the camera pushes on and reveals the full dunes under a low sun. At 7.00 seconds, the camera settles on the wide landscape and holds until the final frame. There is no cut anywhere.",
      ],
      sound:
        "A soft liquid fizz and spoon-clink tail that blends into a gentle desert wind and a faint hiss of sand.",
      music: "N/A",
    }),
  },
  {
    id: "fal_costume_swap",
    source: "fal",
    category: "cinematic",
    title: { en: "Stage illusion costume swap", vi: "Ảo thuật đổi trang phục trên sân khấu" },
    description: {
      en: "Two magicians' suit colors swap in the smoke; they bow and the curtain changes color.",
      vi: "Hai nhà ảo thuật đổi màu vest trong làn khói; cúi chào và rèm đổi màu.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: two magicians on stage",
        vi: "First frame: hai nhà ảo thuật trên sân khấu",
        image:
          "Two stage magicians side by side in a spotlight, the left wearing a black tuxedo with white gloves and the right wearing a white tuxedo with black gloves, red velvet curtain behind them, theatre stage",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Live theatre footage, warm spotlights, red velvet curtain, a little stage haze.",
      shots: [
        "A medium-wide shot begins from <Picture 1>: the two magicians face the audience, the one on the left in a black tuxedo and the one on the right in a white tuxedo, both with gloves in the opposite color. The camera holds steady. At 1.50 seconds, they raise their arms and thick white smoke bursts around them. At 3.50 seconds, the smoke thins and the suits have swapped: the left magician now wears white, the right now wears black, while the glove colors stay exactly the same. At 6.00 seconds, they bow together. At 8.00 seconds, the red curtain drawn closed behind them shifts from deep red to dark blue, and the shot holds until the final frame.",
      ],
      sound:
        "A drum roll, a soft burst of smoke, a short chime when the colors change, applause rising as they bow.",
      music: "Light playful stage-magic jazz with a muted trumpet and a walking bass.",
    }),
  },

  // -------------------------------------------------------------------- brand
  {
    id: "fal_binocular_film",
    source: "fal",
    category: "brand",
    title: { en: "Vintage binocular brand film", vi: "Phim thương hiệu qua ống nhòm cổ" },
    description: {
      en: "A fixed binocular lens mask while the view whip-scans through 4 keyframes with red typography.",
      vi: "Khung ống nhòm cố định, góc nhìn lướt nhanh qua 4 keyframe với chữ đỏ.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "Keyframe 1 / first frame: main installation",
        vi: "Keyframe 1 / first frame: tác phẩm sắp đặt chính",
        image:
          "Photograph of a large red fabric art installation in an old plaza, seen through a black double-circle binocular mask, 35mm film grain",
      },
      {
        en: "Keyframe 2: fabric in the wind",
        vi: "Keyframe 2: vải bay trong gió",
        image:
          "Photograph of red fabric billowing in the wind with hand-painted lettering following the folds, seen through a black double-circle binocular mask, 35mm film grain",
      },
      {
        en: "Keyframe 3: passerby walking",
        vi: "Keyframe 3: người qua đường",
        image:
          "Photograph of a passerby in a beige coat walking and swinging their arms in an old plaza, seen through a black double-circle binocular mask, 35mm film grain",
      },
      {
        en: "Keyframe 4: person adjusting glasses",
        vi: "Keyframe 4: người chỉnh kính",
        image:
          "Photograph of a person adjusting their glasses and lifting their chin, seen through a black double-circle binocular mask, 35mm film grain",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Picture 1> is the first frame of [Shot 1], showing the main installation through a black double-circle binocular mask.",
        "<Picture 2> is the keyframe at 3.00 seconds, showing red fabric in the wind with lettering following its folds.",
        "<Picture 3> is the keyframe at 6.00 seconds, showing a passerby walking and swinging their arms.",
        "<Picture 4> is the keyframe at 9.00 seconds, showing a person adjusting their glasses and lifting their chin.",
      ],
      summary:
        "A 12-second 16:9 voyeuristic brand film seen through a fixed binocular mask, beginning from <Picture 1> and whip-scanning through <Picture 2>, <Picture 3> and <Picture 4> in order.",
      retention: [
        "<Picture 1> ([Shot 1] first frame): fully_preserved - composition at the opening.",
        "<Picture 2> ([Shot 1] keyframe): fully_preserved - composition reached at 3.00 seconds.",
        "<Picture 3> ([Shot 1] keyframe): fully_preserved - composition reached at 6.00 seconds.",
        "<Picture 4> ([Shot 1] keyframe): fully_preserved - composition reached at 9.00 seconds.",
        "No added people, vehicles, buildings or logos; each composition is kept.",
      ],
      look: "Wes Anderson-inspired voyeuristic 35mm look with fine grain and halation. The black double-circle binocular mask stays perfectly fixed at frame center; only the view inside it moves.",
      shots: [
        "The shot begins from <Picture 1>, blurred at first with a slight handheld shake. The view pushes in and the focus racks sharp. At 1.50 seconds, a short exposure flicker. At 3.00 seconds, a fast whip-scan lands on <Picture 2> and snaps into focus, the fabric rippling. At 4.50 seconds, a flicker and a hard cut at peak blur. At 6.00 seconds, the view snaps into focus on <Picture 3>. At 7.50 seconds, another whip-scan. At 9.00 seconds, the view locks on <Picture 4>. Short red sans-serif words fade in from blur over about half a second, slide only slightly, and fade out before the next scan. The final view holds until the end. No spinning or large fly-in text.",
      ],
      sound: "A soft binocular focus-ring click, whooshes on each whip-scan, wind, faint plaza chatter.",
      music: "A quirky pizzicato-and-harpsichord waltz with light percussion.",
    }),
  },
  {
    id: "fal_desert_fashion",
    source: "fal",
    category: "brand",
    title: { en: "Desert fashion campaign", vi: "Chiến dịch thời trang sa mạc" },
    description: {
      en: "A woman takes a bag from a car trunk on a desert highway; closes on the brand mark.",
      vi: "Người phụ nữ lấy túi từ cốp xe trên đường cao tốc sa mạc; kết bằng logo.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: location and film texture",
        vi: "First frame: bối cảnh và chất phim",
        image:
          "Cinematic photo of a vintage cream car parked on an empty desert highway at golden hour, open trunk, film grain, muted warm palette",
      },
      {
        en: "Talent",
        vi: "Người mẫu",
        image:
          "Fashion portrait of a tall woman with a sleek low ponytail in a minimal olive linen set and thin sunglasses, neutral studio background",
      },
      {
        en: "Product: black bag",
        vi: "Sản phẩm: túi đen",
        image: "Product photo of a structured black leather handbag with a gold clasp on a neutral background",
      },
      {
        en: "Closing brand mark",
        vi: "Logo kết phim",
        image: "A minimalist geometric brand mark in white on a solid sand-colored background, no text",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the woman], on the portrait sheet <Picture 2>, with a sleek low ponytail, an olive linen set and thin sunglasses.",
        "<Subject 2> is [the black handbag], on the product sheet <Picture 3>, with its exact leather, shape and gold clasp.",
        "<Subject 3> is the brand mark, on <Picture 4>.",
        "<Picture 1> is the first frame of [Shot 1], showing the vintage car on the desert highway with the trunk open.",
      ],
      summary:
        "A 12-second 16:9 fashion campaign film that begins from <Picture 1>: <Subject 1> takes <Subject 2> from the trunk, shares a quiet moment with a man beside the car, walks away with the bag, and the film closes on <Subject 3>.",
      retention: [
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - face, hair and outfit.",
        "<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - leather, shape and clasp.",
        "<Subject 3> (appears in [Shot 3]): fully_preserved - mark shape and colors.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - location, car and film texture.",
      ],
      look: "Elevated, cool and restrained but lively fashion film, muted warm palette, film grain, low desert sun. The clothing and bag feel part of the character, not an ad insert.",
      shots: [
        "The shot begins from <Picture 1>: a wide frame of the car on the empty highway. <Subject 1> walks into the frame to the back of the car. At 2.00 seconds, she lifts the trunk lid further and takes out <Subject 2>.",
        "At 00:05.000, the shot cuts to a medium two-shot: a man in a white shirt leans on the car beside her; they exchange a quiet look and a small smile, no words.",
        "At 00:08.000, a wide shot from behind: <Subject 1> walks away down the center line with <Subject 2> in her hand, heat shimmer rising.",
        "At 00:10.500, the shot cuts to a plain sand-colored background and <Subject 3> fades in at frame center, then holds until the final frame.",
      ],
      sound: "Wind across empty road, a trunk lid thunk, footsteps on asphalt, distant cicadas.",
      music: "A cool, minimal downtempo groove with a warm bassline and sparse guitar.",
    }),
  },
  {
    id: "fal_cybergrunge_fashion",
    source: "fal",
    category: "brand",
    title: { en: "Cyber-grunge fashion film", vi: "Phim thời trang cyber-grunge" },
    description: {
      en: "Fast-cut VHS/CCTV style short in front of a night blaze.",
      vi: "Phim ngắn cắt nhanh kiểu VHS/CCTV trước đám cháy ban đêm.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: texture and mood",
        vi: "First frame: chất liệu và không khí",
        image:
          "Grainy VHS-style frame of a figure silhouetted in front of a night blaze, orange-red flames and black smoke, scanlines, chromatic aberration",
      },
      {
        en: "Subject's appearance",
        vi: "Ngoại hình nhân vật",
        image:
          "Fashion portrait of a person with platinum-blonde hair, narrow black vintage sunglasses and a glossy black patent trench coat, calm expression, dark background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the model], on the portrait sheet <Picture 2>, with platinum-blonde hair, narrow black vintage sunglasses, a glossy black patent trench coat and a calm expression.",
        "<Picture 1> is the first frame of [Shot 1], showing the silhouette in front of a night blaze with the analog texture to keep.",
      ],
      summary:
        "A 12-second 16:9 fast-cut fashion short that begins from <Picture 1> and cuts between wide, medium and detail views of <Subject 1> against a night fire.",
      retention: [
        "<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - hair, sunglasses, trench coat and calm expression, with orange firelight across the coat.",
        "<Picture 1> ([Shot 1] first frame): attribute_transfer - analog texture and flame colors.",
      ],
      look: "Analog video look: VHS glitches, CCTV interruptions, heavy grain, scanlines, chromatic aberration, light leaks, flash-to-white transitions and frame jitter.",
      shots: [
        "The shot begins from <Picture 1>: <Subject 1> stands calm in front of the blaze, black smoke rolling behind. The frame jitters. At 1.50 seconds, a flash to white.",
        "At 00:02.500, a hard cut to a CCTV-style high angle: <Subject 1> walks toward camera, the timestamp glitching and the image dropping out for a few frames.",
        "At 00:05.500, a close-up of the sunglasses reflecting flames, then a light-leak flash.",
        "At 00:08.000, a low-angle medium shot: the glossy coat catches orange light as <Subject 1> turns away from the fire, VHS tracking lines rolling up the frame, and the shot holds until the final frame.",
      ],
      sound: "Crackling fire, VHS tape hiss, digital glitch bursts on each cut, a low distorted bass pulse.",
      music: "A dark, distorted industrial beat with a repeating detuned synth line.",
    }),
  },
  {
    id: "fal_eyewear_campaign",
    source: "fal",
    category: "brand",
    title: { en: "Futuristic eyewear campaign", vi: "Chiến dịch kính mắt tương lai" },
    description: {
      en: "Luxury vertical eyewear commercial on a seamless white studio set.",
      vi: "Quảng cáo kính mắt cao cấp dọc trên phông trắng liền.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: both models",
        vi: "First frame: cả hai người mẫu",
        image:
          "Full-body fashion photo of two female models standing together on a seamless white studio cyclorama wearing futuristic wraparound mirrored sunglasses and sleek silver-grey outfits, runway attitude",
      },
      {
        en: "Facial detail",
        vi: "Chi tiết khuôn mặt",
        image:
          "Close-up beauty portrait of a woman wearing futuristic wraparound mirrored sunglasses on a seamless white background, sharp studio light",
      },
      {
        en: "Eyewear design",
        vi: "Thiết kế kính",
        image:
          "Product photo of futuristic wraparound curved-lens cat-eye goggle sunglasses with mirrored lenses and streamlined temples on a white background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the two models], on <Picture 1> and the detail sheet <Picture 2>, in sleek silver-grey outfits with a cool runway attitude.",
        "<Subject 2> is [the eyewear], on the product sheet <Picture 3>, with wraparound curved mirrored lenses, a cat-eye goggle silhouette and streamlined temples.",
        "<Picture 1> is the first frame of [Shot 1], showing both models on a seamless white studio set.",
      ],
      summary:
        "A 10-second 9:16 premium eyewear commercial that begins from <Picture 1> and cuts rhythmically between full-body walks, a face detail and the product on a seamless white set.",
      retention: [
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - faces, hair and outfits.",
        "<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - lens curve, silhouette and mirror finish.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - set, pose and lighting at the opening.",
      ],
      look: "Premium fashion-commercial look on a seamless white cyclorama, crisp even studio light, mirrored lenses reflecting soft highlights.",
      shots: [
        "The shot begins from <Picture 1>: both models stand side by side, then walk toward camera in step. The camera tracks backward at the same pace. At 2.00 seconds, they stop and tilt their heads in unison.",
        "At 00:03.500, a hard cut to a tight close-up of one model: the mirrored lens catches a white highlight that slides across it as she turns slightly.",
        "At 00:06.000, a hard cut to <Subject 2> alone, rotating slowly on the white set with the light gliding over the curved lenses.",
        "At 00:08.000, a final wide shot of both models holding a confident pose, held until the final frame.",
      ],
      sound: "Soft footsteps on a studio floor, light whooshes on the cuts, a faint glassy shimmer on the highlight.",
      music: "A sleek, bass-forward electronic fashion beat at a steady, confident tempo.",
    }),
  },
  {
    id: "fal_cybergrunge_rapmv",
    source: "fal",
    category: "brand",
    title: { en: "Cyber-grunge rap music video", vi: "MV rap cyber-grunge" },
    description: {
      en: "Scanned-zine texture, halftone dots, hard cuts and matching typography.",
      vi: "Chất liệu zine scan, chấm halftone, cắt cứng và chữ đồng bộ.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: performer in zine style",
        vi: "First frame: rapper kiểu zine",
        image:
          "Photocopied zine-style portrait of a rapper in a black hoodie and silver chains, coarse grain, halftone dots, rough print edges, scan misregistration, dark-pop high-fashion look",
      },
      {
        en: "Typography / texture reference",
        vi: "Ảnh tham chiếu chữ / chất liệu",
        image:
          "Scanned punk poster texture with bold distressed typography fragments, torn paper edges, halftone dots and photocopy noise on gray paper",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the rapper], shown in <Picture 1>, with a black hoodie and silver chains.",
        "<Subject 2> is the print style and typography, on the texture sheet <Picture 2>, with distressed type, halftone dots and photocopy noise.",
        "<Picture 1> is the first frame of [Shot 1].",
      ],
      summary:
        "A 10-second 16:9 dark-pop rap music video clip that begins from <Picture 1> and uses only hard cuts, with typography matched to <Subject 2>.",
      retention: [
        "<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - face, hoodie and chains.",
        "<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3]): attribute_transfer - treatment and surface of the type only.",
      ],
      look: "A scanned-magazine look with coarse grain, gate weave, halftone dots, rough print edges and scan misregistration, inspired by 1990s and early-2000s zines and underground posters. Fast hard cuts only, never fades.",
      shots: [
        "The shot begins from <Picture 1>: <Subject 1> raps straight to camera, the frame stuttering with gate weave. Distressed type slams in at the lower third in the style of <Subject 2>.",
        "At 00:03.000, a hard cut to a low-angle shot of <Subject 1> pointing at the lens, halftone dots pulsing with the beat.",
        "At 00:05.500, a hard cut to a tight close-up of the silver chains swinging, torn-paper edges flashing at the frame border.",
        "At 00:08.000, a hard cut to a wide shot of <Subject 1> walking away, the print edges misregistering and the shot holding to the end.",
      ],
      sound: "Crisp bass-heavy vocals, vinyl crackle, a snare crack on each cut.",
      music: "A hard-hitting dark trap beat with a detuned bell loop, 140 BPM.",
    }),
  },

  // --------------------------------------------------------------- ecommerce
  {
    id: "fal_ergonomic_chair",
    source: "fal",
    category: "ecommerce",
    title: { en: "Ergonomic chair product film", vi: "Phim sản phẩm ghế công thái học" },
    description: {
      en: "360 reveal, mesh and lumbar macros, armrest adjustments, closing tagline.",
      vi: "Xoay 360, macro lưới và lưng, chỉnh tay vịn, kết bằng slogan.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: chair in a premium office",
        vi: "First frame: ghế trong văn phòng cao cấp",
        image:
          "Product photograph of a black ergonomic office chair in a minimal premium office with cool tones and soft daylight",
      },
      {
        en: "Feature details",
        vi: "Chi tiết tính năng",
        image:
          "Detail collage photo of an ergonomic chair: breathable black mesh back, lumbar support curve and adjustable armrest, studio light",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the black ergonomic chair], on <Picture 1>, with its exact frame, mesh and armrests.",
        "<Subject 2> is the feature details, on the detail sheet <Picture 2>, with the mesh weave, lumbar curve and adjustable armrest.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 1> in a premium minimal office.",
      ],
      summary:
        "A 12-second 16:9 product film that begins from <Picture 1>, orbits <Subject 1>, shows its mesh, lumbar support and armrest adjustments in close-ups, and ends on a tagline.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 4]): fully_preserved - shape, color and proportions in every shot.",
        "<Subject 2> (appears in [Shot 2], [Shot 3]): fully_preserved - mesh weave, lumbar curve and armrest.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - office, light and tone.",
      ],
      look: "Minimal, cool-toned and slow-paced premium product film, soft daylight, clean reflections.",
      shots: [
        "The shot begins from <Picture 1>: the camera orbits <Subject 1> slowly through 360 degrees; a designer in a grey sweater sits down and settles comfortably.",
        "At 00:04.000, a macro shot of the breathable mesh: faint animated airflow lines pass through the weave.",
        "At 00:06.500, a side view as a soft glowing 3D skeleton of a spine appears over the seat, showing the lumbar curve supporting the back.",
        "At 00:09.000, a close-up of a hand raising the armrest and adjusting the seat height with a smooth motion.",
        "At 00:11.000, a clean white frame shows the closing line Comfort that keeps you inspired in thin dark type, held until the final frame.",
      ],
      sound: "Soft office room tone, a gentle pneumatic lift, fabric rustle, a quiet airy whoosh on the airflow graphic.",
      music: "A calm, modern minimal piano and soft synth bed with a light pulse.",
    }),
  },
  {
    id: "fal_rotating_product_page",
    source: "fal",
    category: "ecommerce",
    title: { en: "Rotating product page reveal", vi: "Trang sản phẩm xoay" },
    description: {
      en: "A poster-style layout reveals top to bottom, then the central product rotates.",
      vi: "Bố cục áp phích hiện từ trên xuống, rồi sản phẩm ở giữa xoay nhẹ.",
    },
    mode: "fl2va",
    aspectRatio: "9:16",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: product page layout",
        vi: "First frame: bố cục trang sản phẩm",
        image:
          "Vertical product landing page layout in a flat design: big pale headline at the top, a glossy white sneaker centered on a soft gradient background, small captions at the bottom, clean modern typography",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Clean motion-design UI animation, soft gradient background, crisp modern typography, smooth easing.",
      shots: [
        "The layout of <Picture 1> reveals from top to bottom. At 0.50 seconds, the top headline slides down into place. At 1.50 seconds, the center text slides down just behind it. At 2.50 seconds, the lower captions slide up from below. At 4.00 seconds, the central sneaker begins a subtle slow rotation, light sliding across its glossy surface, and the rotation continues gently until the final frame. The layout, colors and typography stay exactly as in the picture.",
      ],
      sound: "Soft UI swish sounds as each block settles, a faint glassy shimmer on the rotation.",
      music: "A light, upbeat minimal electronic loop.",
    }),
  },
  {
    id: "fal_sneaker_landing",
    source: "fal",
    category: "ecommerce",
    title: { en: "Sneaker landing page demo", vi: "Demo landing page giày" },
    description: {
      en: "Bold italic type, speed streaks, scroll and hover interactions around one product.",
      vi: "Chữ nghiêng đậm, vệt tốc độ, cuộn và hover quanh một sản phẩm.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: product on landing page",
        vi: "First frame: sản phẩm trên landing page",
        image:
          "Website hero section in a sports-brand style: a bold red running shoe tilted dynamically over a dark carbon-fiber texture with light speed streaks, oversized italic sans-serif headline, minimal navigation bar",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the red running shoe], on <Picture 1>, with its exact shape, color and sole.",
        "<Picture 1> is the first frame of [Shot 1], showing the hero section of the landing page.",
      ],
      summary:
        "An 8-second 16:9 product-page UI demo that begins from <Picture 1> and shows fast, smooth scrolling and hover effects around <Subject 1>.",
      retention: [
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - shape, color and sole.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - layout, typography and carbon-fiber background.",
      ],
      look: "Dynamic sports-brand web design: oversized bold italic sans-serif type, speed-driven light streaks over a carbon-fiber or performance-mesh background.",
      shots: [
        "The shot begins from <Picture 1>: the page scrolls up quickly and smoothly, the headline sliding out and the next section sliding in with light streaks trailing. At 2.00 seconds, a cursor hovers over <Subject 1>, which scales up slightly.",
        "At 00:03.500, the page scrolls to a feature section with a large number counting up in bold italic type; a second hover inverts a card's colors with a quick flash.",
        "At 00:06.000, the page scrolls back to the hero as <Subject 1> tilts back to its starting angle and the layout holds until the final frame.",
      ],
      sound: "Quick UI swishes, a soft click on each hover, a fast air whoosh on the scrolls.",
      music: "A driving high-energy electronic beat with a tight kick.",
    }),
  },

  // ------------------------------------------------------------------- drama
  {
    id: "fal_bamboo_wuxia",
    source: "fal",
    category: "drama",
    title: { en: "Snowy bamboo wuxia mystery", vi: "Kiếm hiệp rừng trúc tuyết" },
    description: {
      en: "Night bamboo grove, falling snow, close-ups and shot/reverse-shot.",
      vi: "Rừng trúc ban đêm, tuyết rơi, cận mặt và đối thoại shot/reverse-shot.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: bamboo grove at night",
        vi: "First frame: rừng trúc ban đêm",
        image:
          "Cinematic night scene in a misty bamboo grove with falling snow, a young swordsman in dark robes facing an older sect elder in grey robes, cold blue and ink green palette, shallow depth of field",
      },
      {
        en: "Characters",
        vi: "Nhân vật",
        image:
          "Character sheet of two period martial-arts characters: a young swordsman with a topknot in dark robes and an older elder with a grey beard in grey robes, plain background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the young swordsman], on the character sheet <Picture 2>, with a topknot and dark robes.",
        "<Subject 2> is [the sect elder], on the character sheet <Picture 2>, with a grey beard and grey robes.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 1> and <Subject 2> facing each other in the snowy bamboo grove.",
      ],
      summary:
        "A 12-second 16:9 period mystery scene that begins from <Picture 1> and plays out as a tense conversation in restrained shot/reverse-shot about a sect investigation.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 3]): fully_preserved - face, topknot and robes.",
        "<Subject 2> (appears in [Shot 1] to [Shot 3]): fully_preserved - beard and robes.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - grove, snow and palette.",
        "No text, watermarks, modern elements, animation styling, over-smoothed skin, daylight or exaggerated acting.",
      ],
      look: "Austere, tense period drama in cold blue, ink green, charcoal and grey. Soft front key on the faces, backlight for depth, shallow focus with bokeh, falling snow.",
      shots: [
        "The shot begins from <Picture 1>: a medium two-shot as snow drifts between the bamboo. The camera pushes in slightly. At 1.50 seconds, <Subject 2> lowers his voice and speaks. (S2) He says, <d>[English] Someone in the sect opened the sealed hall.</d>",
        "At 00:04.500, a close-up on <Subject 1>: his eyes narrow and he answers calmly. (S1) He says, <d>[English] Then we should ask who held the key.</d>",
        "At 00:08.000, a close-up on <Subject 2>: a long silence, snow settling on his shoulder, his gaze drops to the ground. The shot holds until the final frame.",
      ],
      sound: "Faint wind in bamboo leaves, snow falling softly, a distant temple bell, breath fogging in cold air.",
      music: "A sparse guqin and low string drone, tense and restrained.",
    }),
  },
  {
    id: "fal_family_confrontation",
    source: "fal",
    category: "drama",
    title: { en: "Vertical family confrontation", vi: "Cãi vã gia đình khung dọc" },
    description: {
      en: "Grounded short-form drama, medium close shots, frequent shot/reverse-shot.",
      vi: "Phim ngắn dọc đời thường, cận trung, đối thoại shot/reverse-shot dày.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: family home",
        vi: "First frame: nhà gia đình",
        image:
          "Realistic vertical photo of a warm family living room with red decorations, a young man standing angrily facing an older woman seated at a dining table, natural indoor light",
      },
      {
        en: "Characters",
        vi: "Nhân vật",
        image:
          "Character sheet of two realistic everyday characters: a man in his late twenties in a casual jacket and a woman in her sixties in a cardigan, plain background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the son], on the character sheet <Picture 2>, with a casual jacket.",
        "<Subject 2> is [the mother], on the character sheet <Picture 2>, with grey-streaked hair and a cardigan.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 1> and <Subject 2> in a warm home with red decorations.",
      ],
      summary:
        "A 10-second 9:16 grounded family argument that begins from <Picture 1> and alternates medium-close shots between <Subject 1> and <Subject 2>.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 3]): fully_preserved - face and jacket.",
        "<Subject 2> (appears in [Shot 1] to [Shot 3]): fully_preserved - face, hair and cardigan.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - room and warm light.",
        "No subtitles, stickers, sci-fi elements, period costume or animation.",
      ],
      look: "Natural, grounded short-form drama look, warm practical light, handheld medium-close framing.",
      shots: [
        "The shot begins from <Picture 1>: a medium-close shot of <Subject 1>, angry and urgent. (S1) He says, <d>[English] You never asked what I wanted!</d>",
        "At 00:03.500, a reverse medium-close shot on <Subject 2>, who stands up slowly and fires back. (S2) She says, <d>[English] And you never asked what it cost us.</d>",
        "At 00:07.000, back on <Subject 1>, who clenches his jaw and looks away, unable to answer. The shot holds until the final frame.",
      ],
      sound: "Room tone, a chair scraping the floor, a muffled neighbor TV, voices rising.",
      music: "N/A",
    }),
  },
  {
    id: "fal_vampire_romance",
    source: "fal",
    category: "drama",
    title: { en: "Vampire romance short drama", vi: "Phim ngắn tình yêu ma cà rồng" },
    description: {
      en: "Heroine wakes a sleeping vampire noble; possessive close-ups with a strong hook.",
      vi: "Nữ chính đánh thức quý tộc ma cà rồng; cận cảnh chiếm hữu với cú twist.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: forbidden castle wing",
        vi: "First frame: cánh cấm của lâu đài",
        image:
          "Dark romantic vertical cinematic photo of a candle-lit forbidden castle wing with a pale vampire noble sleeping on a stone throne and a young woman in a simple cream dress standing at the doorway",
      },
      {
        en: "Leads",
        vi: "Hai nhân vật chính",
        image:
          "Character sheet of two leads: a pale vampire noble with dark hair in a black velvet coat and a young woman with brown wavy hair in a simple cream dress, plain background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the vampire noble], on the character sheet <Picture 2>, with pale skin, dark hair and a black velvet coat.",
        "<Subject 2> is [the young woman], on the character sheet <Picture 2>, with brown wavy hair and a simple cream dress.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 2> at the doorway and <Subject 1> asleep in the candle-lit hall.",
      ],
      summary:
        "A 12-second 9:16 short-drama teaser that begins from <Picture 1>: <Subject 2> wakes <Subject 1>, who senses an ancient trace in her and becomes possessive while she fears him yet pushes back.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 3]): fully_preserved - face, hair and coat.",
        "<Subject 2> (appears in [Shot 1] to [Shot 3]): fully_preserved - face, hair and dress.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - hall and candle light.",
        "No gore, cheap horror, Halloween styling or modern street look.",
      ],
      look: "Darkly romantic and restrained, deep shadows with warm candle highlights, medium-close shots, close-ups and extreme close-ups that stress eye contact and tension.",
      shots: [
        "The shot begins from <Picture 1>: <Subject 2> steps in quietly and touches the arm of the throne. At 2.00 seconds, <Subject 1> opens his eyes in an extreme close-up, pupils narrowing.",
        "At 00:05.000, a medium-close shot: <Subject 1> rises, his hand catches her wrist, and he studies her face. (S1) He says in a low voice, <d>[English] You carry something very old.</d>",
        "At 00:09.000, a close-up on <Subject 2>: she is afraid but lifts her chin and pulls her wrist free. (S2) She says, <d>[English] Then let go of me.</d> The shot holds until the final frame.",
      ],
      sound: "Candle flames fluttering, a low stone-hall echo, a soft heartbeat that quickens when he wakes, fabric rustle.",
      music: "A dark, romantic cello and piano theme with a slow, ominous swell.",
    }),
  },
  {
    id: "fal_red_lounge_scene",
    source: "fal",
    category: "drama",
    title: { en: "Romantic scene in a red lounge", vi: "Cảnh lãng mạn trong phòng đỏ" },
    description: {
      en: "Frontal upper-body close shot, melting ice and quiet ambient detail.",
      vi: "Cận cảnh nửa người chính diện, đá tan và âm thanh môi trường.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 10,
    inputs: picInputs([
      {
        en: "First frame: lounge interior",
        vi: "First frame: nội thất phòng",
        image:
          "Photorealistic intimate lounge with a red velvet sofa, a marble side table, red and black walls and warm low light, a man in a tailored black shirt lounging with a whiskey tumbler, the woman's face just out of frame",
      },
      {
        en: "Male lead",
        vi: "Nam chính",
        image:
          "Photorealistic portrait of a man in his thirties with short dark hair and light stubble wearing a tailored black shirt, plain dark background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the man], on the portrait sheet <Picture 2>, with short dark hair, light stubble and a tailored black shirt.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 1> lounging on a red velvet sofa in a red-and-black lounge with a woman beside him whose face stays mostly out of frame.",
      ],
      summary:
        "A 10-second 16:9 photoreal intimate scene that begins from <Picture 1>, framed frontally on the upper bodies, with small details of ice, condensation and fabric.",
      retention: [
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - face, hair and shirt.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - lounge, sofa, marble table and warm low light.",
      ],
      look: "Photorealistic, warm low light, deep reds and blacks, shallow depth of field, frontal upper-body framing. The woman's face stays mostly out of frame, with only her neck, shoulders, hands and hem visible.",
      shots: [
        "The shot begins from <Picture 1>: a frontal close shot of <Subject 1> lounging with a whiskey tumbler. The camera drifts in a few centimeters. At 2.00 seconds, the ice in the glass shifts and slowly melts, condensation beading on the crystal.",
        "At 00:05.000, a closer detail shot: the woman's hand brushes the sofa velvet, her shoulder moving with slow breaths, while <Subject 1> lifts the glass and takes a measured sip. The shot holds until the final frame.",
      ],
      sound: "Ice tapping crystal, the faint crackle of a burning cigar, soft room air, clothing movement, controlled breathing.",
      music: "N/A",
    }),
  },
  {
    id: "fal_otome_transition",
    source: "fal",
    category: "drama",
    title: { en: "Otome game choice transition", vi: "Chuyển cảnh lựa chọn game otome" },
    description: {
      en: "First+last frame: from a player-choice moment to a character's intrigued reaction.",
      vi: "First+last frame: từ lựa chọn của người chơi tới phản ứng thích thú của nhân vật.",
    },
    mode: "flf2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: backstage choice moment",
        vi: "First frame: khoảnh khắc lựa chọn ở hậu trường",
        image:
          "Polished otome visual-novel CG of a backstage corridor where the heroine in a stage costume watches a performance through a curtain gap, with two glowing dialogue choice boxes at the bottom, soft pink and gold lighting",
      },
      {
        en: "Last frame: his reaction",
        vi: "Last frame: phản ứng của anh ấy",
        image:
          "Polished otome visual-novel CG of a handsome man in a white performance coat in the same backstage corridor, intrigued half-smile looking toward the viewer, a dialogue box at the bottom, soft pink and gold lighting",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Polished otome-game CG with soft pink and gold lighting, refined UI motion design, an intimate backstage mood with restrained, suggestive tension.",
      lastFrameShot: 2,
      lastFrameAtSec: 8,
      shots: [
        "The shot begins from <Picture 1>: the heroine watches the performance through the curtain gap as the two choice boxes shimmer. At 2.00 seconds, one choice box brightens and is selected with a soft glow, the other fades away.",
        "At 00:04.000, the camera glides around the corridor and the man in the white coat turns toward her, intrigued by her words. At 5.50 seconds, a new dialogue box slides in with a refined fade. The shot settles into the composition of <Picture 2> and holds to the end.",
      ],
      sound: "Muffled stage music from beyond the curtain, a soft chime on selection, a gentle rustle of fabric.",
      music: "A soft romantic piano melody with light strings.",
    }),
  },

  // --------------------------------------------------------------- animation
  {
    id: "fal_clay_fox_leap",
    source: "fal",
    category: "animation",
    title: { en: "Claymation fox lava leap", vi: "Cáo đất sét nhảy qua dung nham" },
    description: {
      en: "Slow-motion leap over a lava canyon, camera racing under the fox mid-air.",
      vi: "Nhảy chậm qua hẻm dung nham, máy lướt dưới bụng cáo giữa không trung.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: clay fox at the cliff edge",
        vi: "First frame: cáo đất sét ở mép vách đá",
        image:
          "Stop-motion claymation scene of an orange plasticine fox with button eyes crouched at the edge of a cliff above a glowing lava canyon, visible fingerprints on the clay, miniature set lighting",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Handmade stop-motion claymation look with visible fingerprints and slightly uneven frame rates, warm miniature set lighting, glowing lava below.",
      shots: [
        "The shot begins from <Picture 1>: the clay fox sprints toward the cliff edge in short stop-motion steps. At 1.50 seconds, it launches into the air and the motion drops into slow motion. At 2.50 seconds, the camera races low beneath the fox's belly and reveals the huge depth of the lava canyon. At 5.00 seconds, the fox stretches out in mid-air, ears flat, lava bubbling below. At 6.50 seconds, the far cliff edge rushes into view and the fox lands in a soft squash, then holds to the end.",
      ],
      sound: "Rhythmic soft clay footsteps, bubbling lava, a long whoosh of air in slow motion, a soft thud on landing.",
      music: "An adventurous, playful brass-and-percussion score.",
    }),
  },
  {
    id: "fal_xianxia_character",
    source: "fal",
    category: "animation",
    title: { en: "Fantasy xianxia character film", vi: "Phim nhân vật tiên hiệp" },
    description: {
      en: "3D xianxia short that follows a storyboard and locks the character's costume.",
      vi: "Phim 3D tiên hiệp bám storyboard và khoá trang phục nhân vật.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame / storyboard order",
        vi: "First frame / thứ tự storyboard",
        image:
          "Chinese-inspired 3D xianxia render of a lone cultivator seen from behind on a stone path among floating mountains and clouds, solemn mood, soft rim light",
      },
      {
        en: "Locked character reference",
        vi: "Ảnh khoá nhân vật",
        image:
          "3D character turnaround of a xianxia cultivator with long black hair, a silver crown, an indigo ribbon, layered white hanfu, a translucent blue robe, a sash with a jade fastener and tassels, plain background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the cultivator], on the character sheet <Picture 2>, with long black hair, a silver crown, an indigo ribbon, a layered white hanfu, a translucent blue robe, a sash with a jade fastener and tassels.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 1> from behind on a stone path among floating mountains.",
      ],
      summary:
        "A 12-second 16:9 solemn, destiny-driven xianxia short that begins from <Picture 1> and follows three storyboard beats with smooth transitions.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 3]): fully_preserved - hair, crown, ribbon, hanfu layers, robe, sash, fastener and tassels. Face visible only in close-ups; wide shots use back or rear three-quarter views.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - path, mountains and soft lighting.",
      ],
      look: "4K-quality Chinese-inspired 3D xianxia film, solemn and fated, drifting clouds, soft rim light, smooth transitions.",
      shots: [
        "The shot begins from <Picture 1>: a wide rear view as the robe and tassels sway in the wind. The camera rises slowly behind <Subject 1>. At 2.50 seconds, <Subject 1> lifts one hand and the clouds part.",
        "At 00:05.000, a smooth match-move into a rear three-quarter medium shot as <Subject 1> steps onto a floating stone bridge, the ribbon trailing.",
        "At 00:08.500, a close-up on the face of <Subject 1>, calm and resolute with eyes lifted to the sky, a pale light crossing the silver crown. The shot holds until the final frame.",
      ],
      sound: "Deep wind, soft cloth movement, a distant temple bell, a faint crystalline chime on the sky opening.",
      music: "A solemn guqin and flute theme over low strings.",
    }),
  },
  {
    id: "fal_otome_character_promo",
    source: "fal",
    category: "animation",
    title: { en: "Otome male lead promo", vi: "Quảng bá nam chính game otome" },
    description: {
      en: "Character promo with strict identity and costume preservation.",
      vi: "Quảng bá nhân vật với bảo toàn nghiêm ngặt khuôn mặt và trang phục.",
    },
    mode: "ref2va",
    aspectRatio: "9:16",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: promo pose",
        vi: "First frame: tạo dáng quảng bá",
        image:
          "Polished otome-game CG of a handsome young man with silver hair, violet eyes and a navy-and-gold royal uniform with a cape, standing in a sparkling rose-garden courtyard, vertical composition",
      },
      {
        en: "Identity reference",
        vi: "Ảnh khoá danh tính",
        image:
          "Otome-game character turnaround sheet of a handsome young man with silver hair, violet eyes and a navy-and-gold royal uniform with a cape, front, side and back views, plain background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the prince], on the character sheet <Picture 2>, with silver hair, violet eyes and a navy-and-gold royal uniform with a cape.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 1> in a rose-garden courtyard.",
      ],
      summary:
        "An 8-second 9:16 character promo that begins from <Picture 1> and presents <Subject 1> with three elegant poses while keeping his design identical.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 3]): fully_preserved - face, hair, proportions, costume, material details and the polished otome-CG look, consistent throughout.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - courtyard and lighting.",
      ],
      look: "Polished otome-game CG, glossy highlights, drifting rose petals and sparkles, soft pastel bloom.",
      shots: [
        "The shot begins from <Picture 1>: the camera arcs slightly around <Subject 1> as the cape flutters and rose petals drift past. At 1.50 seconds, he smiles gently and glances at the viewer.",
        "At 00:03.500, a closer medium shot: <Subject 1> places a hand on his chest and bows slightly, light glinting on the gold trim.",
        "At 00:06.000, a close-up on his face, violet eyes catching sparkles as he gives a confident, warm look, held until the final frame.",
      ],
      sound: "A soft magical chime, rose petals rustling, a gentle breath of wind.",
      music: "An elegant waltz with harp, strings and a soft celesta.",
    }),
  },
  {
    id: "fal_kitchen_creature",
    source: "fal",
    category: "animation",
    title: { en: "Hand-drawn kitchen creature", vi: "Sinh vật vẽ tay trong bếp" },
    description: {
      en: "Phone-style live-action kitchen with a tiny luminous hand-drawn creature.",
      vi: "Bếp quay như bằng điện thoại, có sinh vật phát sáng vẽ tay nhỏ xíu.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: dusk kitchen",
        vi: "First frame: nhà bếp lúc hoàng hôn",
        image:
          "Realistic photo of a small home kitchen at dusk, sunset light at the window, a wooden table with a half-washed mug, a fogged glass bottle and a hanging towel, phone-camera look",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Live-action footage shot one-handed on a phone: slight hand tremor, hesitant focus pulls, exposure breathing and coarse shadow noise, blended with soft luminous hand-drawn 2D animation.",
      shots: [
        "The shot begins from <Picture 1>: the camera drifts across the table in the last sunset light. At 2.50 seconds, a faint scribbled glow shimmers inside the fogged glass bottle. At 4.50 seconds, a tiny hand-drawn creature, small and soft with a round body, peeks out from behind the mug and tilts its head. At 7.00 seconds, the creature taps the mug with a little paw and the camera lurches closer, focus hunting before it locks. At 9.50 seconds, it scurries along the table edge, trailing a faint line of light, and hides behind the hanging towel. The camera lingers on the towel until the final frame. The creature is cute, with no giant eyes, split mouths, fangs, threatening moves, lunges or jump scares.",
      ],
      sound: "Room tone, cloth friction, a soft mug clink, faucet drips, the operator's footsteps and breathing, gentle electronic tones, tiny creature chirps.",
      music: "N/A",
    }),
  },
  {
    id: "fal_laundromat_apparition",
    source: "fal",
    category: "animation",
    title: { en: "Neon laundromat encounter", vi: "Chạm trán trong tiệm giặt neon" },
    description: {
      en: "Late-night laundromat, phone-style camera following a hand-drawn apparition.",
      vi: "Tiệm giặt đêm khuya, camera điện thoại bám theo bóng ma vẽ tay.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: empty laundromat",
        vi: "First frame: tiệm giặt vắng",
        image:
          "Realistic photo of a late-night self-service laundromat with flickering fluorescent lights, running washing machines, plastic baskets, a worn bench and a single sock on the floor, quiet and nostalgic",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Live-action footage shot one-handed on a phone: visible shake, exposure shifts under fluorescent light, glass reflections and delayed autofocus, blended with a luminous hand-drawn apparition.",
      shots: [
        "The shot begins from <Picture 1>: the camera drifts past the humming machines. At 2.00 seconds, a pale hand-drawn shape of light slips behind a washer door and its reflection slides across the glass. At 4.50 seconds, the camera turns to follow it; the focus lags, then catches the apparition floating above the bench, soft and sad-looking. At 7.50 seconds, it lifts the lone sock from the floor and drifts it gently into an open washer. At 10.00 seconds, the fluorescent lights flicker once and the apparition fades into a faint trail of sparkles, the camera lingering on the humming machine until the end.",
      ],
      sound: "Fluorescent hum, tumbling laundry, water sloshing, soft footsteps and breathing from the operator, faint wind-chime sparkles.",
      music: "N/A",
    }),
  },

  // ------------------------------------------------------------------ motion
  {
    id: "fal_anime_crime_titles",
    source: "fal",
    category: "motion",
    title: { en: "Retro anime crime title sequence", vi: "Title sequence anime trinh thám retro" },
    description: {
      en: "Linework, split-screen snaps, vinyl wipes and timed jazz cues, hard cuts only.",
      vi: "Nét vẽ, chia màn hình, vuốt vinyl và nhạc jazz theo mốc, chỉ cắt cứng.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: detective silhouette",
        vi: "First frame: bóng thám tử",
        image:
          "Retro 1960s crime anime title frame: a detective silhouette in a long coat against a red-orange city skyline, flat bold color blocks, thick ink outlines, halftone shading",
      },
      {
        en: "Style frame: car at night",
        vi: "Khung phong cách: xe ban đêm",
        image:
          "Retro 1960s crime anime frame of a vintage car speeding through a rainy night street, flat color blocks, thick ink outlines, halftone shading",
      },
      {
        en: "Style frame: gloved hand and envelope",
        vi: "Khung phong cách: bàn tay đeo găng và phong bì",
        image:
          "Retro 1960s crime anime frame of a black-gloved hand sliding a red-sealed envelope across a table, flat color blocks, thick ink outlines, halftone shading",
      },
      {
        en: "Style frame: rooftop",
        vi: "Khung phong cách: mái nhà",
        image:
          "Retro 1960s crime anime frame of two figures on a rooftop under a giant yellow moon, flat color blocks, thick ink outlines, halftone shading",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is the art style, on the style sheets <Picture 2>, <Picture 3> and <Picture 4>, with flat bold color blocks, thick ink outlines and halftone shading.",
        "<Subject 2> is [the detective], shown in <Picture 1>, with a long coat and a loosened tie.",
        "<Picture 1> is the first frame of [Shot 1], showing <Subject 2> silhouetted against a red-orange city skyline.",
      ],
      summary:
        "A 12-second 16:9 crime-mystery opening title sequence that begins from <Picture 1> and builds a collage of split-screen frames in the style of <Subject 1>, with credits popping in on the beat.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 3]): attribute_transfer - line weight, color blocks and halftone only.",
        "<Subject 2> (appears in [Shot 1] to [Shot 3]): fully_preserved - silhouette, long coat and loosened tie.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - skyline colors at the opening.",
        "Hard cuts only, no soft dissolves. Credits are clean and legible, each name and role appears once, with no garbled letters.",
      ],
      look: "About 60% suspense and 40% jazz: mysterious and urban, not horror or cheerful. Linework draws on over black, split-screen boundaries snap into place and color blocks build the frame.",
      shots: [
        "The shot begins from <Picture 1>: ink linework draws the skyline over black, then <Subject 2> snaps in. At 2.00 seconds, a vinyl-record wipe cuts to the split-screen and the car frame from <Picture 2> slams into the left half.",
        "At 00:04.000, a car-door cut and a red-line slice reveal the envelope frame from <Picture 3>; the credit line DIRECTED BY JUNE WALLACE pops in on the beat.",
        "At 00:07.000, a shadow wipe and tiled snaps assemble the rooftop frame from <Picture 4>; the credit line MUSIC BY THE BLUE QUARTET pops in.",
        "At 00:10.000, a letter-mask cut to the red-orange skyline with the title NIGHT LEDGER in thick ink letters, held until the final frame.",
      ],
      sound: "Needle drop on vinyl, snare snaps on the wipes, a low hum under the tension.",
      music: "An original cue: hi-hat and low frequencies in the first 2 seconds, a low beat from 3 seconds, a jazz bass line from 6 seconds, a sax riff from 10 seconds, ending on a frozen tense chord and a drum hit over the final 2 seconds.",
    }),
  },
  {
    id: "fal_gallery_poster",
    source: "fal",
    category: "motion",
    title: { en: "Animated gallery poster", vi: "Áp phích triển lãm chuyển động" },
    description: {
      en: "Animates a poster while keeping its border, palette and layout.",
      vi: "Làm chuyển động áp phích nhưng giữ viền, bảng màu và bố cục.",
    },
    mode: "fl2va",
    aspectRatio: "9:16",
    durationSec: 8,
    inputs: picInputs([
      {
        en: "First frame: poster artwork",
        vi: "First frame: ảnh áp phích",
        image:
          "Vertical gallery poster with a white gallery border and an inner frame, a 3D glossy collectible vinyl figure of a small red-and-white robot in the center, red white and black palette, bold title text area at the bottom",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Playful motion-poster animation. The white gallery border, inner frame, red/white/black palette, 3D collectible-figure look and layout of <Picture 1> stay exactly the same.",
      shots: [
        "The shot begins from <Picture 1>: the vinyl robot gives a small bounce and its head tilts. At 1.50 seconds, the title types itself onto the bottom area one letter at a time with a light playful tick. At 3.50 seconds, the robot waves one arm and a glossy highlight sweeps across its body. At 5.50 seconds, small red stars pop out of the frame edge and settle, and the poster holds still until the final frame.",
      ],
      sound: "A light, playful type-on tick for every letter that appears, soft toy squeaks, a tiny sparkle on the highlight.",
      music: "A cheerful, bouncy chiptune-style loop.",
    }),
  },

  // ---------------------------------------------------------------------- ui
  {
    id: "fal_game_equipment_ui",
    source: "fal",
    category: "ui",
    title: { en: "Game equipment UI sequence", vi: "Chuỗi UI trang bị trong game" },
    description: {
      en: "Menu, arm customization, loading bar and open-world load-in, timed in seconds.",
      vi: "Menu, tùy biến cánh tay, thanh nạp và vào thế giới mở, chia theo giây.",
    },
    mode: "ref2va",
    aspectRatio: "16:9",
    durationSec: 12,
    inputs: picInputs([
      {
        en: "First frame: character on a purple floor",
        vi: "First frame: nhân vật trên nền tím",
        image:
          "Overhead view of a cyberpunk heroine with a mechanical right arm standing on a glossy purple floor in an empty void, game-menu mood, soft neon rim light",
      },
      {
        en: "UI style reference",
        vi: "Ảnh phong cách UI",
        image:
          "Futuristic video game UI style sheet with neon cyan and purple panels, hexagon buttons, thin outline icons and loading bars on a dark background",
      },
    ]),
    prompt: buildRefPrompt({
      subjects: [
        "<Subject 1> is [the heroine], shown in <Picture 1>, with a mechanical right arm and a cyberpunk outfit.",
        "<Subject 2> is the UI style, on the style sheet <Picture 2>, with neon cyan and purple panels, hexagon buttons and thin outline icons.",
        "<Picture 1> is the first frame of [Shot 1], a high overhead view of <Subject 1> on a glossy purple floor.",
      ],
      summary:
        "A 12-second 16:9 game-interface sequence that begins from <Picture 1>, moves through an equipment menu and arm customization, a loading bar, and loads into an open-world city street.",
      retention: [
        "<Subject 1> (appears in [Shot 1] to [Shot 4]): fully_preserved - face, hair, outfit and mechanical arm design.",
        "<Subject 2> (appears in [Shot 1], [Shot 2], [Shot 3], [Shot 4]): attribute_transfer - panel look, buttons and icon style only.",
        "<Picture 1> ([Shot 1] first frame): fully_preserved - floor color and overhead framing.",
      ],
      look: "Slick cyberpunk game-UI cinematography with neon cyan and purple accents, crisp holographic panels and smooth easing.",
      shots: [
        "The shot begins from <Picture 1>: a game menu appears in the style of <Subject 2> and the cursor selects Continue. At 2.00 seconds, the camera pushes in to the right arm and an equipment panel slides in, the mechanical hand reconfiguring with glowing LEDs.",
        "At 00:04.000, the camera arcs to the left: an armament grid appears and the left arm disassembles and reassembles section by section.",
        "At 00:07.000, the camera pulls back as she confirms, the panels vanish and she relaxes her shoulders.",
        "At 00:08.500, a loading bar fills along the bottom while the purple world darkens into golden light. At 10.00 seconds, a cyberpunk city street loads around her, the third-person camera settles, the HUD fades in, and she steps forward onto the street until the final frame.",
      ],
      sound: "Soft UI blips on each selection, servo whirs and clicks as the arm reconfigures, a rising electronic swell on the loading bar, city ambience as it loads.",
      music: "A synthwave track with an arpeggiated bass that opens up into a melodic lead at the city reveal.",
    }),
  },
  {
    id: "fal_car_website_ui",
    source: "fal",
    category: "ui",
    title: { en: "Automotive website animation", vi: "Animation website ô tô" },
    description: {
      en: "Headline and copy panels slide in; the car's lights shift from dark to red.",
      vi: "Tiêu đề và đoạn chữ trượt vào; đèn xe chuyển từ tối sang đỏ.",
    },
    mode: "fl2va",
    aspectRatio: "16:9",
    durationSec: 6,
    inputs: picInputs([
      {
        en: "First frame: website hero with a dark car",
        vi: "First frame: hero website có xe tối",
        image:
          "Automotive website hero section: a sleek black sports car in a dark showroom with its lights off, empty space above and beside it for text, minimal modern layout, subtle reflections",
      },
    ]),
    prompt: buildFramePrompt({
      look: "Premium automotive web motion design, dark showroom, smooth easing, crisp white typography.",
      shots: [
        "The shot begins from <Picture 1>: a large headline reading DRIVE THE NIGHT slides down from the top into place. At 1.20 seconds, a short copy panel slides up from the bottom beside the car. At 2.80 seconds, the car's headlights and taillights come on, shifting from dark to a deep red glow that washes softly across the showroom floor. The layout then holds still and the red glow breathes gently until the final frame.",
      ],
      sound: "Soft UI swishes as the panels settle, a low electric hum when the lights come on.",
      music: "A deep, minimal electronic bass drone with a slow pulse.",
    }),
  },
];
