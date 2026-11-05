"""Find what causes the painterly texture and halo in Qwen-Image 2.1 keyframes. One image per variant, same seed.

  python previs_h3_test/scripts/keyframe_artifact_test.py <portrait.png> <out_dir> [--dry-run]

Baseline: image_1 = studio portrait, instruction to replace its background. Each variant changes one thing, except
`compose`, which uses the project's earlier compose recipe: image_1 = a generated background plate, image_2 = the portrait.
Writes <variant>.png and results.json with seconds and prompts.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qwen21_character_local import edit_graph, loaders, render, sampler, t2i_graph, upload  # noqa: E402

SEED = 1000
SET = "a small modern home kitchen with pale green cabinets on the back wall and a window on the right letting in soft morning daylight"
TABLE = ("A plain wooden table runs across the bottom of the frame. A white ceramic plate holding one slice of golden buttered toast, "
         "butter side up, sits on the table in the left third of the frame.")
LONG = ("Edit <image1> into a new photorealistic horizontal film still. Keep this exact man from <image1> unchanged: same face, same messy "
        "curly silver-white hair, same clean-shaven round face, same thick black square-rimmed glasses, same mustard-yellow wool cardigan, "
        "same blue checked shirt, same pencil behind his right ear. "
        f"Replace the plain background with {SET}. He stands in the center of the frame behind a table, shown once, from the waist up, with "
        f"clear space above his head. {TABLE} He faces the lens with his hands resting on the table and his chin lifted. Natural skin texture, "
        "shallow depth of field, soft morning daylight from the right. No text, logos or watermarks.")
SHORT = (f"In <image1>, change only the plain grey background to {SET}. Add a plain wooden table in front of the man and a white plate with "
         "one slice of buttered toast on it. Keep the man exactly as he is.")
PLATE = (f"Photorealistic horizontal film still of an empty room: {SET}. {TABLE} The room is empty, with no people. Shallow depth of field, "
         "soft morning daylight from the right, realistic detail. No text, logos or watermarks.")
COMPOSE = ("Compose a new photorealistic photograph. <image1> is the room and camera angle: keep its room, table, plate, toast and lighting. "
           "<image2> shows the man to place in it: same face, hair, glasses, cardigan, shirt and pencil. He stands behind the table in the center "
           "of the frame, seen from the waist up, facing the lens, with his hands resting on the table and clear space above his head. "
           "Match the room's soft daylight from the right on his face and clothes, with natural skin texture. Show him once. "
           "No text, logos or watermarks.")


def edit_variant(prompt: str, name: str, steps: int = 40, cache: bool = True, resolution: int = 0) -> dict:
    g = edit_graph(prompt, name, SEED)
    g["6"]["inputs"]["steps"] = steps
    g["4"]["inputs"]["resolution"] = resolution
    if not cache:
        del g["9"]
        g["6"]["inputs"]["model"] = ["1", 0]
    return g


def compose_graph(prompt: str, plate: str, portrait: str, steps: int = 40) -> dict:
    return {**loaders(),
            "9": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
            "10": {"class_type": "LoadImage", "inputs": {"image": plate}},
            "11": {"class_type": "LoadImage", "inputs": {"image": portrait}},
            "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["2", 0], "vae": ["3", 0], "prompt": prompt, "negative_prompt": "",
                                                                    "resolution": 0, "images.image_1": ["10", 0], "images.image_2": ["11", 0]}},
            **sampler(["9", 0], ["4", 2], SEED, steps)}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("portrait")
    p.add_argument("out")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    name = "dry.png" if a.dry_run else upload(Path(a.portrait))
    variants = {
        "a_baseline": edit_variant(LONG, name),
        "b_short_prompt": edit_variant(SHORT, name),
        "c_steps_25": edit_variant(LONG, name, steps=25),
        "d_steps_60": edit_variant(LONG, name, steps=60),
        "e_no_cache_node": edit_variant(LONG, name, cache=False),
        "f_resolution_1024": edit_variant(LONG, name, resolution=1024),
    }
    results = []
    for key, g in variants.items():
        if a.dry_run:
            print(key, g["6"]["inputs"]["steps"], g["6"]["inputs"]["model"], g["4"]["inputs"]["resolution"])
            continue
        t0 = time.time()
        (out / f"{key}.png").write_bytes(render(g))
        results.append({"variant": key, "seconds": round(time.time() - t0, 1)})
        print(results[-1], flush=True)
    plate_graph = t2i_graph(PLATE, SEED)
    if a.dry_run:
        print("g_plate", sorted(plate_graph), "h_compose", sorted(compose_graph(COMPOSE, "p.png", name)))
        return
    t0 = time.time()
    (out / "g_plate.png").write_bytes(render(plate_graph))
    results.append({"variant": "g_plate", "seconds": round(time.time() - t0, 1)})
    t0 = time.time()
    (out / "h_compose.png").write_bytes(render(compose_graph(COMPOSE, upload(out / "g_plate.png"), name)))
    results.append({"variant": "h_compose", "seconds": round(time.time() - t0, 1)})
    print(results[-1], flush=True)
    (out / "results.json").write_text(json.dumps({"seed": SEED, "results": results, "long": LONG, "short": SHORT, "plate": PLATE, "compose": COMPOSE}, indent=1) + "\n")


main()
