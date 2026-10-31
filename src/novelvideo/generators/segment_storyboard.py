"""Storyboard grid for a segment (multishot chain).

H3's own storyboard templates (`fal_otome_character_promo`,
`storyboard_character_pv`) pass a grid of panels as an `attribute_transfer`
reference: the model takes framing and pose from panel k for shot k, and the
grid itself never appears on screen. A segment already has one beat per shot,
so the grid is just those beats tiled in chain order — the beat's sketch, or its
rendered frame when there is no sketch. Pure PIL, no GPU, no LLM.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from novelvideo.utils.path_resolver import PathResolver

STORYBOARD_COLS = 3
# 9:16 cells; the grid is a layout reference, not a deliverable, so keep it small.
CELL_W, CELL_H = 384, 672
_PAD_COLOR = (128, 128, 128)


@dataclass(frozen=True)
class StoryboardPanel:
    beat_number: int
    source: str  # "sketch" | "frame"
    path: str


@dataclass(frozen=True)
class StoryboardRef:
    path: str
    panels: list[StoryboardPanel]

    @property
    def panel_count(self) -> int:
        return len(self.panels)


def _panel_sources(output_dir: str | Path, episode_num: int, chain_beats: list[dict]) -> list[StoryboardPanel] | None:
    """One panel per beat, in chain order. `None` when any beat has neither a
    sketch nor a frame — a grid with a hole would mislabel every later panel."""
    paths = PathResolver(str(output_dir), episode_num)
    panels: list[StoryboardPanel] = []
    for beat in chain_beats:
        n = int(beat["beat_number"])
        sketch, frame = paths.sketch(n), paths.frame(n)
        if sketch.is_file():
            panels.append(StoryboardPanel(n, "sketch", str(sketch)))
        elif frame.is_file():
            panels.append(StoryboardPanel(n, "frame", str(frame)))
        else:
            return None
    return panels


def _cache_key(panels: list[StoryboardPanel]) -> str:
    h = hashlib.sha1()
    h.update(f"{CELL_W}x{CELL_H}x{STORYBOARD_COLS}\n".encode())
    for p in panels:
        h.update(f"{p.beat_number}|{p.source}|{p.path}|{Path(p.path).stat().st_mtime_ns}\n".encode())
    return h.hexdigest()


def _fit_cell(img: Image.Image) -> Image.Image:
    """Letterbox into a 9:16 cell. Not stretched: a stretched panel would
    change the framing the model is supposed to copy."""
    img = img.convert("RGB")
    scale = min(CELL_W / img.width, CELL_H / img.height)
    w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    cell = Image.new("RGB", (CELL_W, CELL_H), _PAD_COLOR)
    cell.paste(img.resize((w, h), Image.Resampling.LANCZOS), ((CELL_W - w) // 2, (CELL_H - h) // 2))
    return cell


def build_segment_storyboard(
    output_dir: str | Path, episode_num: int, chain_id: str, chain_beats: list[dict]
) -> StoryboardRef | None:
    """Tile the chain's beats into `{output_dir}/segments/storyboards/epNNN/{chain_id}.png`.
    Rebuilt only when a source file's path or mtime changes. `None` when a beat
    has no image yet (the caller then runs the segment without a storyboard)."""
    if not chain_beats:
        return None
    panels = _panel_sources(output_dir, episode_num, chain_beats)
    if panels is None:
        return None

    out_dir = Path(output_dir) / "segments" / "storyboards" / f"ep{episode_num:03d}"
    out_path = out_dir / f"{chain_id}.png"
    key_path = out_dir / f"{chain_id}.json"
    key = _cache_key(panels)
    try:
        if out_path.is_file() and json.loads(key_path.read_text()).get("key") == key:
            return StoryboardRef(str(out_path), panels)
    except (OSError, ValueError):
        pass

    cols = min(len(panels), STORYBOARD_COLS)
    rows = math.ceil(len(panels) / cols)
    grid = Image.new("RGB", (cols * CELL_W, rows * CELL_H), _PAD_COLOR)
    for i, panel in enumerate(panels):
        with Image.open(panel.path) as img:
            grid.paste(_fit_cell(img), ((i % cols) * CELL_W, (i // cols) * CELL_H))
    out_dir.mkdir(parents=True, exist_ok=True)
    grid.save(out_path)
    key_path.write_text(json.dumps({"key": key}))
    return StoryboardRef(str(out_path), panels)
