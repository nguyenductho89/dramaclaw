"""Unified path computation helpers.

All resource paths should be computed through this module and no longer stored in data.
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from novelvideo.task_identity import selection_scope
from novelvideo.utils.state_index_files import resolve_state_index_path


def _scene_dir(project_dir: Path, scene_name: str) -> Path:
    return project_dir / "assets" / "scenes" / scene_name


def canonical_portrait_path(project_dir: Path, char_name: str) -> Path:
    """Canonical portrait slot path. Does not require the file to exist."""
    return project_dir / "assets" / "characters" / char_name / "portrait.png"


def compute_portrait_path(project_dir: Path, char_name: str) -> str:
    """Dynamically compute the avatar path."""
    path = canonical_portrait_path(project_dir, char_name)
    return str(path) if path.exists() else ""


def compute_scene_reference_path(project_dir: Path, scene_name: str) -> str:
    """Dynamically compute the scene reference image path.

    The 2.0 mainline only maintains the master source image; 360/3GS/voxel are all derived from master or pano_360.
    """
    return compute_scene_master_path(project_dir, scene_name)


def compute_scene_master_path(project_dir: Path, scene_name: str) -> str:
    """Dynamically compute the scene master image path, used to create the DirectorWorld."""
    path = canonical_scene_master_path(project_dir, scene_name)
    return str(path) if path.exists() else ""


def canonical_scene_master_path(project_dir: Path, scene_name: str) -> Path:
    """Canonical scene master slot path. Does not require the file to exist."""
    return _scene_dir(project_dir, scene_name) / "master.png"


def canonical_scene_360_path(project_dir: Path, scene_name: str) -> Path:
    """Canonical scene 360 slot path for Freezone Commit."""
    return _scene_dir(project_dir, scene_name) / "scene_panorama_sketch_360.png"


def canonical_scene_render_anchors_dir(project_dir: Path, scene_name: str) -> Path:
    """Scene-level fixed background reference slots for render/colorization."""
    return _scene_dir(project_dir, scene_name) / "render_anchors"


def compute_scene_render_anchor_path(
    project_dir: Path, scene_name: str, anchor_id: str = "latest"
) -> str:
    """Resolve one selected perspective background reference for render.

    Scene-level fixed slots are intentionally small: latest is the 360 viewer
    screenshot and external is the user-uploaded override.
    """
    safe_id = re.sub(r'[/\\:*?"<>|]', "_", str(anchor_id or "latest").strip()) or "latest"
    path = canonical_scene_render_anchors_dir(project_dir, scene_name) / f"{safe_id}.png"
    return str(path) if path.exists() else ""


def canonical_beat_control_frame_dir(project_dir: Path, episode: int, beat_num: int) -> Path:
    """Canonical beat-level director/control-frame directory."""
    return project_dir / "director_control_frames" / f"ep{episode:03d}" / f"beat_{beat_num:02d}"


def canonical_beat_selected_background_path(project_dir: Path, episode: int, beat_num: int) -> Path:
    """Canonical beat-owned background selected from 360 viewer or upload."""
    return (
        canonical_beat_control_frame_dir(project_dir, episode, beat_num) / "selected_background.png"
    )


def compute_beat_selected_background_path(project_dir: Path, episode: int, beat_num: int) -> str:
    """Resolve the beat-owned selected background if it exists."""
    path = canonical_beat_selected_background_path(project_dir, episode, beat_num)
    return str(path) if path.exists() else ""


def canonical_beat_director_env_only_path(project_dir: Path, episode: int, beat_num: int) -> Path:
    """Canonical beat-owned Director/3GS environment-only plate."""
    return canonical_beat_control_frame_dir(project_dir, episode, beat_num) / "env_only.png"


def compute_beat_director_env_only_path(project_dir: Path, episode: int, beat_num: int) -> str:
    """Resolve the beat-owned Director/3GS environment-only plate if it exists."""
    path = canonical_beat_director_env_only_path(project_dir, episode, beat_num)
    return str(path) if path.exists() else ""


def canonical_scene_spatial_layout_path(project_dir: Path, scene_name: str) -> Path:
    """Canonical scene-level spatial layout slot path."""
    return _scene_dir(project_dir, scene_name) / "spatial_layout.png"


def compute_scene_spatial_layout_path(project_dir: Path, scene_name: str) -> str:
    """Dynamically compute the scene-level spatial layout image path, used for sketch generation and director correction."""
    path = canonical_scene_spatial_layout_path(project_dir, scene_name)
    return str(path) if path.exists() else ""


def _first_existing_scene_file(project_dir: Path, scene_name: str, candidates: list[str]) -> str:
    scene_dir = _scene_dir(project_dir, scene_name)
    for rel_path in candidates:
        path = scene_dir / rel_path
        if path.exists():
            return str(path)
    return ""


def canonical_scene_reverse_master_path(project_dir: Path, scene_name: str) -> Path:
    """Canonical scene-level reverse master image slot path."""
    return _scene_dir(project_dir, scene_name) / "reverse_master.png"


def compute_scene_reverse_master_path(project_dir: Path, scene_name: str) -> str:
    """Dynamically compute the scene reverse master path (BACK-FACING establishing view)."""
    path = canonical_scene_reverse_master_path(project_dir, scene_name)
    return str(path) if path.exists() else ""


def compute_scene_topdown_path(project_dir: Path, scene_name: str) -> str:
    """Dynamically compute the scene top-down / floor plan image path.

    It is still in an experimental migration period, so file names from the last few rounds of testing are tolerated; once stable it should converge to
    `top_down.png` or `floor_plan.png`.
    """
    return _first_existing_scene_file(
        project_dir,
        scene_name,
        [
            "top_down.png",
            "top_down_ref.png",
            "floor_plan.png",
            "top_down_openai_master_style_test_1k_square.png",
            "top_down_openai_master_style_test_1k.png",
            "blueprint_sheet_openai_master_test/floor_plan.png",
        ],
    )


def compute_scene_reverse_path(project_dir: Path, scene_name: str) -> str:
    """Dynamically compute the scene reverse/back reference image path."""
    return _first_existing_scene_file(
        project_dir,
        scene_name,
        [
            "reverse.png",
            "reverse_ref.png",
            "reverse_openai_master_topdown_preset_v2_1k.png",
            "reverse_openai_master_topdown_test_1k.png",
            "reverse_render_ref.png",
            "blueprint_sheet_openai_master_test/back_elevation.png",
        ],
    )


def compute_scene_world_model_pack_paths(project_dir: Path, scene_name: str) -> list[str]:
    """Return the scene reference bundle for the render stage.

    The official mainline no longer attaches the old top_down/reverse scene reference images; they are kept only as legacy
    debug files. When stable geometry is needed, use pano_360, the voxel world or the 3GS control frame.
    """
    paths = [compute_scene_master_path(project_dir, scene_name)]
    return [path for path in paths if path]


def compute_scene_style_reference_path(project_dir: Path, scene_name: str) -> str:
    """Legacy alias: return the master source image."""
    return compute_scene_master_path(project_dir, scene_name)


def compute_director_ref_dir(project_dir: Path, episode: int, beat_num: int) -> Path:
    """Beat-level director-mode reference directory."""
    return project_dir / "assets" / "director_refs" / f"ep{episode:03d}" / f"beat_{beat_num:02d}"


def compute_director_color_ref_path(project_dir: Path, episode: int, beat_num: int) -> str:
    """Dynamically compute the beat-level director color-image reference path."""
    path = compute_director_ref_dir(project_dir, episode, beat_num) / "director_color_ref.png"
    return str(path) if path.exists() else ""


def compute_director_sketch_ref_path(project_dir: Path, episode: int, beat_num: int) -> str:
    """Dynamically compute the beat-level director line-art reference path."""
    path = compute_director_ref_dir(project_dir, episode, beat_num) / "director_sketch_ref.png"
    return str(path) if path.exists() else ""


def compute_director_blocking_ref_path(project_dir: Path, episode: int, beat_num: int) -> str:
    """Dynamically compute the DirectorWorld control image path."""
    path = compute_director_ref_dir(project_dir, episode, beat_num) / "director_blocking_ref.png"
    return str(path) if path.exists() else ""


def compute_director_world_control_ref_path(project_dir: Path, episode: int, beat_num: int) -> str:
    """Dynamically compute the raw DirectorWorld control image path.

    This is the raw control exported by the editor / screenshot, used to lock the camera, position, occlusion and actor/prop
    markers; it must not be used as an art-style reference, nor overwritten by a second generation pass.
    """
    path = (
        compute_director_ref_dir(project_dir, episode, beat_num) / "director_world_control_ref.png"
    )
    return str(path) if path.exists() else ""


def compute_director_view_meta_path(project_dir: Path, episode: int, beat_num: int) -> Path:
    """Beat-level director camera-position metadata path."""
    return compute_director_ref_dir(project_dir, episode, beat_num) / "director_view.json"


def compute_prop_reference_path(project_dir: Path, prop_name: str) -> str:
    """Dynamically compute the prop three-view reference image path."""
    path = canonical_prop_reference_path(project_dir, prop_name)
    return str(path) if path.exists() else ""


def canonical_prop_reference_path(project_dir: Path, prop_name: str) -> Path:
    """Canonical prop reference slot path. Does not require the file to exist."""
    return project_dir / "assets" / "props" / prop_name / "reference_3view.png"


def compute_identity_path(project_dir: Path, char_name: str, identity_name: str) -> str:
    """Dynamically compute the identity reference image path."""
    path = canonical_identity_path(project_dir, char_name, identity_name)
    return str(path) if path.exists() else ""


def canonical_identity_path(project_dir: Path, char_name: str, identity_name: str) -> Path:
    """Canonical identity slot path. Does not require the file to exist."""
    prefix = f"{char_name}_"
    if identity_name.startswith(prefix):
        identity_name = identity_name[len(prefix) :]
    safe_name = re.sub(r'[/\\:*?"<>|]', "_", identity_name)
    return project_dir / "assets" / "characters" / char_name / "identities" / f"{safe_name}.png"


def compute_identity_portrait_path(project_dir: Path, char_name: str, identity_name: str) -> str:
    """Dynamically compute the identity-level portrait path (identities with very different faces, such as age variants)."""
    preferred = canonical_identity_portrait_path(project_dir, char_name, identity_name)
    if preferred.exists():
        return str(preferred)
    prefix = f"{char_name}_"
    if identity_name.startswith(prefix):
        identity_name = identity_name[len(prefix) :]
    safe_name = re.sub(r'[/\\:*?"<>|]', "_", identity_name)
    legacy = (
        project_dir
        / "assets"
        / "characters"
        / char_name
        / "identities"
        / f"{safe_name}_portrait.png"
    )
    return str(legacy) if legacy.exists() else ""


def canonical_identity_portrait_path(project_dir: Path, char_name: str, identity_name: str) -> Path:
    """Canonical identity portrait slot path. Does not require the file to exist."""
    prefix = f"{char_name}_"
    if identity_name.startswith(prefix):
        identity_name = identity_name[len(prefix) :]
    safe_name = re.sub(r'[/\\:*?"<>|]', "_", identity_name)
    return (
        project_dir
        / "assets"
        / "characters"
        / char_name
        / "identities"
        / f"{char_name}_{safe_name}_portrait.png"
    )


def compute_identity_costume_path(project_dir: Path, char_name: str, identity_name: str) -> str:
    """Dynamically compute the identity-level outfit reference image path."""
    path = canonical_identity_costume_path(project_dir, char_name, identity_name)
    return str(path) if path.exists() else ""


def canonical_identity_costume_path(project_dir: Path, char_name: str, identity_name: str) -> Path:
    """Canonical identity costume slot path. Does not require the file to exist."""
    prefix = f"{char_name}_"
    if identity_name.startswith(prefix):
        identity_name = identity_name[len(prefix) :]
    safe_name = re.sub(r'[/\\:*?"<>|]', "_", identity_name)
    return (
        project_dir
        / "assets"
        / "characters"
        / char_name
        / "identities"
        / f"{safe_name}_costume.png"
    )


def compute_scoped_grid_filename(
    mode_key: str,
    beat_numbers: list[int] | tuple[int, ...],
    *,
    prefix: str = "grid",
    ext: str = "png",
) -> str:
    """Generate a stable, unique whole-image file name from mode_key + beat_numbers."""
    normalized = [int(beat) for beat in beat_numbers if beat is not None]
    if not mode_key or not normalized:
        raise ValueError("scoped grid filename requires mode_key and beat_numbers")
    scope = selection_scope(mode_key, normalized)
    return f"{prefix}_{scope}.{ext.lstrip('.')}"


def resolve_render_grid_path(
    project_dir: Path,
    episode: int,
    mode_key: str,
    beat_numbers: list[int] | tuple[int, ...],
    *,
    grid_index: int | None = None,
) -> Path:
    """Prefer the scoped unique path; fall back to the old grid_XX.png if there is none."""
    mode_dir = project_dir / "grids" / f"ep{episode:03d}" / mode_key
    scoped_path = mode_dir / compute_scoped_grid_filename(
        mode_key,
        beat_numbers,
        prefix="grid",
        ext="png",
    )
    if scoped_path.exists():
        return scoped_path
    if grid_index is not None:
        legacy_path = mode_dir / f"grid_{grid_index + 1:02d}.png"
        if legacy_path.exists():
            return legacy_path
        return scoped_path
    return scoped_path


def resolve_sketch_grid_path(
    project_dir: Path,
    episode: int,
    mode_key: str | None,
    beat_numbers: list[int] | tuple[int, ...] | None,
    *,
    grid_index: int | None = None,
    rows: int | None = None,
    cols: int | None = None,
    beat_start: int | None = None,
    beat_end: int | None = None,
) -> Path:
    """Prefer the scoped sketch file; fall back to the old sketch_g / sketch_b if there is none."""
    sketch_base = project_dir / "grids" / f"ep{episode:03d}" / "sketch"
    normalized = [int(beat) for beat in (beat_numbers or []) if beat is not None]
    if mode_key and normalized:
        scoped_name = compute_scoped_grid_filename(
            mode_key,
            normalized,
            prefix="sketch",
            ext="jpg",
        )
        scoped_path = sketch_base / scoped_name
        if scoped_path.exists():
            return scoped_path
    if grid_index is not None and rows is not None and cols is not None:
        legacy_name = f"sketch_g{grid_index}_{rows}x{cols}.jpg"
        legacy_path = sketch_base / legacy_name
        if legacy_path.exists():
            return legacy_path
    if beat_start is not None and beat_end is not None and rows is not None and cols is not None:
        old_name = f"sketch_b{beat_start}-{beat_end}_{rows}x{cols}.jpg"
        old_path = sketch_base / old_name
        if old_path.exists():
            return old_path
    if sketch_base.exists():
        for ratio_dir in sketch_base.iterdir():
            if not ratio_dir.is_dir():
                continue
            if mode_key and normalized:
                candidate = ratio_dir / compute_scoped_grid_filename(
                    mode_key,
                    normalized,
                    prefix="sketch",
                    ext="jpg",
                )
                if candidate.exists():
                    return candidate
            if grid_index is not None and rows is not None and cols is not None:
                candidate = ratio_dir / f"sketch_g{grid_index}_{rows}x{cols}.jpg"
                if candidate.exists():
                    return candidate
            if (
                beat_start is not None
                and beat_end is not None
                and rows is not None
                and cols is not None
            ):
                candidate = ratio_dir / f"sketch_b{beat_start}-{beat_end}_{rows}x{cols}.jpg"
                if candidate.exists():
                    return candidate
    if mode_key and normalized:
        return sketch_base / compute_scoped_grid_filename(
            mode_key,
            normalized,
            prefix="sketch",
            ext="jpg",
        )
    if beat_start is not None and beat_end is not None and rows is not None and cols is not None:
        return sketch_base / f"sketch_b{beat_start}-{beat_end}_{rows}x{cols}.jpg"
    return sketch_base / "sketch_unknown.jpg"


class PathResolver:
    """Project resource path calculator."""

    def __init__(self, output_dir: str, episode: int):
        self.output_dir = Path(output_dir)
        self.episode = episode
        self._ep_str = f"ep{episode:03d}"

    # === Beat-level resources ===

    def frame(self, beat_num: int) -> Path:
        """First-frame image path (for display; may have gone through cropping)."""
        return self.output_dir / "frames" / self._ep_str / f"beat_{beat_num:02d}.png"

    def director_render(self, beat_num: int) -> Path:
        """Director Render combined.png -- the output of the Sprint C/D 3GS main chain.

        Path: `director_control_frames/ep<NNN>/beat_<MM>/combined.png`,
        captured directly by PlayCanvas from the live combined view, keeping the environment/actor occlusion in the viewport.
        """
        return (
            self.output_dir
            / "director_control_frames"
            / self._ep_str
            / f"beat_{beat_num:02d}"
            / "combined.png"
        )

    def video_input_frame(self, beat_num: int, *, slot: str = "first_frame") -> Path:
        """Video-input derived frame path.

        This holds the video-model input cropped from the selected render, and does not overwrite the `frames/...`
        source asset, keeping the asset ratio separate from the video input ratio.
        """
        safe_slot = "last_frame" if slot == "last_frame" else "first_frame"
        return (
            self.output_dir
            / "video_inputs"
            / self._ep_str
            / f"beat_{beat_num:02d}"
            / f"{safe_slot}.png"
        )

    def video_input_frame_meta(self, beat_num: int, *, slot: str = "first_frame") -> Path:
        frame_path = self.video_input_frame(beat_num, slot=slot)
        return frame_path.with_suffix(".json")

    @staticmethod
    def _source_signature(source_path: Path) -> dict[str, object] | None:
        try:
            stat = source_path.stat()
        except OSError:
            return None
        return {
            "source_path": str(source_path),
            "source_mtime_ns": int(stat.st_mtime_ns),
            "source_size": int(stat.st_size),
        }

    def write_video_input_frame_meta(
        self,
        beat_num: int,
        *,
        slot: str,
        source_path: Path,
    ) -> None:
        signature = self._source_signature(source_path)
        if signature is None:
            return
        meta_path = self.video_input_frame_meta(beat_num, slot=slot)
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(
            json.dumps({"version": 1, **signature}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def valid_video_input_frame(
        self,
        beat_num: int,
        *,
        slot: str = "first_frame",
        source_path: Path,
    ) -> Path | None:
        frame_path = self.video_input_frame(beat_num, slot=slot)
        if not frame_path.exists():
            return None
        expected = self._source_signature(source_path)
        if expected is None:
            return None
        meta_path = self.video_input_frame_meta(beat_num, slot=slot)
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if (
            str(meta.get("source_path") or "") == str(expected["source_path"])
            and int(meta.get("source_mtime_ns") or -1) == expected["source_mtime_ns"]
            and int(meta.get("source_size") or -1) == expected["source_size"]
        ):
            return frame_path
        return None

    def first_frame_for_video(self, beat_num: int, *, use_director_render: bool = False) -> Path:
        """First-frame path used for video generation.

        `director_control_frames/.../combined.png` is used only when
        `use_director_render=True`. By default the old
        `frames/.../beat_NN.png` is used, so that a stale Director Render does not silently overwrite a confirmed first frame.
        """
        director_render = self.director_render(beat_num)
        source = (
            director_render
            if use_director_render and director_render.exists()
            else self.frame(beat_num)
        )
        override = self.valid_video_input_frame(
            beat_num,
            slot="first_frame",
            source_path=source,
        )
        return override or source

    def sketch(self, beat_num: int) -> Path:
        """Sketch image path (for display, similar to frame)."""
        return self.output_dir / "sketches" / self._ep_str / f"beat_{beat_num:02d}.png"

    def sketches_dir(self) -> Path:
        return self.output_dir / "sketches" / self._ep_str

    def audio(self, beat_num: int) -> Path:
        """Audio path."""
        return self.output_dir / "audio" / self._ep_str / f"beat_{beat_num:02d}.mp3"

    def video(self, beat_num: int) -> Path:
        """Video path."""
        return self.output_dir / "videos" / "beats" / self._ep_str / f"beat_{beat_num:02d}.mp4"

    # === Video prompts ===

    def video_prompt(self, beat_num: int) -> Path:
        """Video prompt file path."""
        return self.output_dir / "prompts" / "videos" / self._ep_str / f"beat_{beat_num:02d}.txt"

    # === Grid-level resources ===

    def grid(self, mode: str, grid_idx: int) -> Path:
        """Grid image path. grid_idx starts from 1."""
        return self.output_dir / "grids" / self._ep_str / mode / f"grid_{grid_idx:02d}.png"

    def grid_prompt(self, mode: str, grid_idx: int) -> Path:
        """Grid prompt path."""
        return (
            self.output_dir
            / "grids"
            / self._ep_str
            / mode
            / "prompts"
            / f"grid_{grid_idx:02d}.prompt.txt"
        )

    # === Shot-level resources ===

    def shot_video(self, shot_id: int) -> Path:
        """Shot video path."""
        return self.output_dir / "videos" / "shots" / self._ep_str / f"shot_{shot_id:02d}.mp4"

    def shot_audio(self, shot_id: int) -> Path:
        """Shot merged TTS audio track path."""
        return self.output_dir / "audio" / "shots" / self._ep_str / f"shot_{shot_id:02d}.mp3"

    def shots_video_dir(self) -> Path:
        return self.output_dir / "videos" / "shots" / self._ep_str

    # === Episode-level resources ===

    def final_video(self, filename: Optional[str] = None) -> Path:
        """Final composed video path."""
        if filename:
            return self.output_dir / "videos" / "episodes" / filename
        return self.output_dir / "videos" / "episodes" / f"{self._ep_str}_final.mp4"

    def episodes_dir(self) -> Path:
        return self.output_dir / "videos" / "episodes"

    def script(self) -> Path:
        """Script JSON path."""
        return self.output_dir / "scripts" / f"{self._ep_str}_script.json"

    def script_mtime(self) -> Optional[datetime]:
        """Modification time of the script file; None if the file does not exist."""
        script_path = self.script()
        if not script_path.exists():
            return None
        try:
            return datetime.fromtimestamp(script_path.stat().st_mtime)
        except OSError:
            return None

    def clean_sketches(self) -> int:
        """Clean up the sketch display files of this episode (sketches/epXXX/).

        The grids directory is left untouched.

        Returns:
            Number of files deleted
        """
        import shutil

        sketch_dir = self.output_dir / "sketches" / self._ep_str
        if not sketch_dir.exists():
            return 0
        count = sum(1 for f in sketch_dir.rglob("*") if f.is_file())
        shutil.rmtree(sketch_dir)
        sketch_dir.mkdir(parents=True, exist_ok=True)
        return count

    # === Directories ===

    def frames_dir(self) -> Path:
        return self.output_dir / "frames" / self._ep_str

    def audio_dir(self) -> Path:
        return self.output_dir / "audio" / self._ep_str

    def videos_dir(self) -> Path:
        return self.output_dir / "videos" / "beats" / self._ep_str

    def video_pool_dir(self) -> Path:
        """Video pool directory."""
        return self.output_dir / "videos" / "beats" / self._ep_str / "pool"

    def video_pool_index(self) -> Path:
        """Video pool index file path."""
        return resolve_state_index_path(
            self.output_dir / "videos" / "beats" / self._ep_str,
            "video_pool_index.json",
        )

    def grids_dir(self, mode: str) -> Path:
        return self.output_dir / "grids" / self._ep_str / mode

    # === Action Beat resources (2.0 short-drama mode) ===

    def action_grid(self, beat_num: int) -> Path:
        """Action beat 5x5 grid image path."""
        return self.output_dir / "grids" / self._ep_str / "action" / f"beat_{beat_num:02d}_grid.png"

    def action_panels_dir(self, beat_num: int) -> Path:
        """Action beat cut panel directory."""
        return self.output_dir / "grids" / self._ep_str / "action" / f"beat_{beat_num:02d}_panels"

    def action_panel(self, beat_num: int, panel_index: int) -> Path:
        """Single panel path of an action beat (panel_index 1-25)."""
        return self.action_panels_dir(beat_num) / f"panel_{panel_index:02d}.png"

    def action_selected_frame(self, beat_num: int, order: int) -> Path:
        """Selected frame path of an action beat (order starts from 1, numbered in the order the user picked them).

        On selection it is copied from the action_panel() pool to here, consistent with the 1.0 pool→frame convention.
        """
        return (
            self.output_dir / "frames" / self._ep_str / f"beat_{beat_num:02d}_sel_{order:02d}.png"
        )

    def action_video(self, beat_num: int, order: int) -> Path:
        """Video path of an action beat selected frame (order corresponds to selected_frame)."""
        return (
            self.output_dir
            / "videos"
            / "beats"
            / self._ep_str
            / f"beat_{beat_num:02d}_sel_{order:02d}.mp4"
        )

    # === Non-Episode-level resources ===

    def character_assets_dir(self, char_name: str) -> Path:
        """Character resource directory (independent of episode)."""
        return self.output_dir / "assets" / "characters" / char_name

    def sketch_dir(self) -> Path:
        """Sketch directory (flat, not split into subdirectories by ratio).

        Returns:
            Sketch directory path, e.g. grids/ep001/sketch/
        """
        return self.output_dir / "grids" / self._ep_str / "sketch"

    def render_dir(self) -> Path:
        """Render output directory (beat-centered naming format)."""
        return self.output_dir / "grids" / self._ep_str / "render"

    def has_sketch(self) -> bool:
        """Check whether sketch files exist."""
        d = self.sketch_dir()
        if not d.exists():
            return False
        # New format (flat): beat_*_t*.*
        if list(d.glob("beat_*_t*.*")):
            return True
        # Whole-image format: sketch_g*_*x*.*
        if list(d.glob("sketch_g*_*x*.*")):
            return True
        # Old format: sketch_b*_*x*.*
        if list(d.glob("sketch_b*_*x*.*")):
            return True
        # Compatible with old ratio subdirectories (e.g. sketch/1-1/beat_*)
        for sub in d.iterdir():
            if sub.is_dir() and list(sub.glob("beat_*_t*.*")):
                return True
        return False

    # === Phase 2: Preset directories + Grid file names ===

    def episode_grids_dir(self) -> Path:
        """Episode grids root directory."""
        return self.output_dir / "grids" / self._ep_str

    def preset_dir(self, preset: str) -> Path:
        """Preset group directory.

        Args:
            preset: group name, scene / char / loc / custom

        Returns:
            e.g. grids/ep001/scene/
        """
        return self.output_dir / "grids" / self._ep_str / preset

    def grid_filename(self, grid_type: str, mode_key: str, beat_nums: list[int], ts: str) -> str:
        """Generate a whole-image file name.

        Args:
            grid_type: render | sketch
            mode_key: e.g. 3x3, 1x1_9-16
            beat_nums: list of beat numbers
            ts: timestamp string (YYYYMMDDHHmmss)

        Returns:
            e.g. render_3x3_1-2-3-4-5-6-7-8-9_grid_20260227143052.png
        """
        beats_str = "-".join(str(b) for b in beat_nums)
        return f"{grid_type}_{mode_key}_{beats_str}_grid_{ts}.png"

    def grid_prompt_filename(
        self, grid_type: str, mode_key: str, beat_nums: list[int], ts: str
    ) -> str:
        """Generate a whole-image prompt file name."""
        beats_str = "-".join(str(b) for b in beat_nums)
        return f"{grid_type}_{mode_key}_{beats_str}_prompt.txt"

    def cell_filename(self, beat_num: int, ts: str) -> str:
        """Generate a cell file name (beat-centered naming).

        Returns:
            e.g. beat_01_t20260227143052.png
        """
        return f"beat_{beat_num:02d}_t{ts}.png"

    def pool_index_path(self) -> Path:
        """Pool index file path."""
        return resolve_state_index_path(
            self.output_dir / "grids" / self._ep_str,
            "pool_index.json",
        )

    def find_grid_image(
        self,
        grid_type: str,
        mode_key: str,
        beat_nums: list[int],
    ) -> Optional[Path]:
        """Find the whole-image file (compatible with old and new paths).

        Search order:
        1. New preset directory: {preset}/{type}_{mode}_{beats}_grid_{ts}.png
        2. Old mode_key directory: {mode_key}/grid_*.png
        3. Old render/sketch directory: render/regen_*.png, sketch/regen_*.png

        Returns:
            The file path found, or None
        """
        ep_grids = self.episode_grids_dir()
        beats_str = "-".join(str(b) for b in beat_nums)

        # 1. Search the preset directory
        for preset in ("scene", "char", "loc", "custom"):
            preset_dir = ep_grids / preset
            if preset_dir.exists():
                pattern = f"{grid_type}_{mode_key}_{beats_str}_grid_*.png"
                matches = sorted(preset_dir.glob(pattern))
                if matches:
                    return matches[-1]  # the newest

        # 2. Old mode_key directory
        mode_dir = ep_grids / mode_key
        if mode_dir.exists():
            scoped_path = mode_dir / compute_scoped_grid_filename(
                mode_key,
                beat_nums,
                prefix="grid",
                ext="png",
            )
            if scoped_path.exists():
                return scoped_path
            for f in sorted(mode_dir.glob("grid_*.png")):
                return f

        # 3. Old render/sketch directory
        type_dir = ep_grids / ("sketch" if grid_type == "sketch" else "render")
        if type_dir.exists():
            for f in sorted(type_dir.glob(f"regen_{mode_key}_b*.png")):
                return f
            for f in sorted(type_dir.glob(f"regen_{mode_key}_g*.png")):
                return f

        return None
