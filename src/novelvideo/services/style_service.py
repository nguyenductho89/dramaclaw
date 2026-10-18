"""Style configuration management service - Single Source of Truth.

Architecture:
- System presets (files, read-only): src/novelvideo/styles/presets/*.json
- Custom styles (project config file): project_config.json

Usage:
    from novelvideo.services import StyleService

    # Get a style config
    style = StyleService.get_style("chinese_period_drama", username="alice", project="demo")

    # List all styles
    styles = StyleService.list_all_styles(username="alice", project="demo")

    # Save a custom style
    StyleService.save_custom_style("my_style", config, username="alice", project="demo")
"""

import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from novelvideo.config import OUTPUT_DIR
from novelvideo.models import StyleConfig
from novelvideo.project_config import (
    load_project_config_file,
    load_project_config_file_from_state_dir,
    update_project_config_file,
    update_project_config_file_in_state_dir,
)


class StyleService:
    """Style configuration management service.

    Provides a unified access interface for style configs and supports:
    1. System preset styles (loaded from JSON files, read-only)
    2. Custom styles (loaded from the project config, read/write, project-isolated)

    All style access should go through this service to keep One Source of Truth.
    """

    # Presets directory
    PRESETS_DIR = Path(__file__).parent.parent / "styles" / "presets"

    # Preset style cache (avoids re-reading files)
    _preset_cache: dict[str, StyleConfig] = {}
    STYLE_FAMILY_LABELS = {
        "live_action": "Live action",
        "animation": "Animation",
    }
    ANIMATION_SUBTYPE_LABELS = {
        "2d": "2D",
        "3d": "3D",
        "hybrid": "Hybrid media",
    }
    STYLE_PREVIEW_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif")

    @classmethod
    def _style_preview_dir(cls, project_dir: str | Path, style_id: str) -> Path:
        project_root = Path(project_dir).resolve()
        if not style_id or Path(style_id).name != style_id:
            raise ValueError("Invalid style id")
        style_dir = (project_root / "assets" / "styles" / style_id).resolve()
        if not style_dir.is_relative_to(project_root):
            raise ValueError("Invalid style preview path")
        return style_dir

    @classmethod
    def remove_style_previews(cls, project_dir: str | Path, style_id: str) -> None:
        """Remove every supported reference image variant for a custom style."""
        style_dir = cls._style_preview_dir(project_dir, style_id)
        for extension in cls.STYLE_PREVIEW_EXTENSIONS:
            candidate = style_dir / f"reference{extension}"
            if candidate.is_file():
                candidate.unlink()

    @classmethod
    def stage_style_preview(
        cls,
        project_dir: str | Path,
        content: bytes,
        extension: str,
    ) -> str:
        """Store an uploaded reference image in the project staging area."""
        suffix = extension.lower()
        if not suffix.startswith("."):
            suffix = f".{suffix}"
        if suffix not in cls.STYLE_PREVIEW_EXTENSIONS:
            raise ValueError("Unsupported style preview image type")
        staging_dir = Path(project_dir) / "assets" / "styles" / ".staging"
        staging_dir.mkdir(parents=True, exist_ok=True)
        relative = Path("assets") / "styles" / ".staging" / f"{uuid.uuid4().hex}{suffix}"
        (Path(project_dir) / relative).write_bytes(content)
        return relative.as_posix()

    @classmethod
    def finalize_style_preview(
        cls,
        project_dir: str | Path,
        style_id: str,
        staged_path: str,
    ) -> str:
        """Move a staged reference image to its custom style directory."""
        project_root = Path(project_dir).resolve()
        target_dir = cls._style_preview_dir(project_root, style_id)
        staged = (project_root / staged_path).resolve()
        staging_root = (project_root / "assets" / "styles" / ".staging").resolve()
        if not staged.is_relative_to(staging_root) or not staged.is_file():
            raise ValueError("Invalid style preview token")
        if staged.suffix.lower() not in cls.STYLE_PREVIEW_EXTENSIONS:
            raise ValueError("Unsupported style preview image type")
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"reference{staged.suffix.lower()}"
        cls.remove_style_previews(project_root, style_id)
        shutil.move(str(staged), str(target))
        return target.relative_to(project_root).as_posix()

    @classmethod
    def find_style_preview(cls, project_dir: str | Path, style_id: str) -> str | None:
        """Return an already-uploaded reference image for a style, if present."""
        root = Path(project_dir).resolve()
        style_root = cls._style_preview_dir(root, style_id)
        for extension in cls.STYLE_PREVIEW_EXTENSIONS:
            candidate = style_root / f"reference{extension}"
            if candidate.is_file():
                return candidate.relative_to(root).as_posix()
        return None

    @classmethod
    def validate_style_preview_path(
        cls,
        project_dir: str | Path,
        style_id: str,
        preview_path: str,
    ) -> str:
        """Validate that a preview points at the style's published reference file."""
        root = Path(project_dir).resolve()
        style_root = cls._style_preview_dir(root, style_id)
        candidate = (root / preview_path).resolve()
        if candidate.parent != style_root:
            raise ValueError("Invalid style preview path")
        if candidate.name not in {
            f"reference{extension}" for extension in cls.STYLE_PREVIEW_EXTENSIONS
        }:
            raise ValueError("Invalid style preview path")
        if not candidate.is_file():
            raise ValueError("Custom style preview does not exist")
        return candidate.relative_to(root).as_posix()

    @staticmethod
    def _resolve_project_context(
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> tuple[str | None, str | None]:
        if username and project:
            return username, project
        inferred_username = None
        inferred_project = None
        if project_dir:
            try:
                rel_parts = Path(project_dir).resolve().relative_to(Path(OUTPUT_DIR).resolve()).parts
                if len(rel_parts) >= 2:
                    inferred_username, inferred_project = rel_parts[0], rel_parts[1]
            except Exception:
                pass
        return username or inferred_username, project or inferred_project

    @classmethod
    def _load_project_custom_style_map(
        cls,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> dict[str, dict]:
        if state_dir is not None:
            config = load_project_config_file_from_state_dir(state_dir)
            styles = config.get("custom_styles") or {}
            return styles if isinstance(styles, dict) else {}
        username, project = cls._resolve_project_context(username, project, project_dir)
        if not username or not project:
            return {}
        config = load_project_config_file(username, project)
        styles = config.get("custom_styles") or {}
        return styles if isinstance(styles, dict) else {}

    @classmethod
    def _save_project_custom_style_map(
        cls,
        styles: dict[str, dict],
        *,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> bool:
        def _apply(existing: dict) -> None:
            existing["custom_styles"] = styles

        if state_dir is not None:
            update_project_config_file_in_state_dir(state_dir, _apply)
            return True

        username, project = cls._resolve_project_context(username, project, project_dir)
        if not username or not project:
            print("[StyleService] Failed to save custom style: missing project context")
            return False
        update_project_config_file(username, project, _apply)
        return True

    @classmethod
    def get_preset(cls, style_id: str) -> Optional[StyleConfig]:
        """Get a system preset style (from file).

        Args:
            style_id: style ID, e.g. 'chinese_period_drama'

        Returns:
            A StyleConfig instance, or None if it does not exist
        """
        # Check the cache
        if style_id in cls._preset_cache:
            return cls._preset_cache[style_id]

        # Load from file
        preset_file = cls.PRESETS_DIR / f"{style_id}.json"
        if not preset_file.exists():
            return None

        try:
            data = json.loads(preset_file.read_text(encoding="utf-8"))
            data["is_preset"] = True
            config = StyleConfig(**data)
            cls._preset_cache[style_id] = config
            return config
        except Exception as e:
            print(f"[StyleService] Failed to load preset: {style_id}, {e}")
            return None

    @classmethod
    def get_custom_style(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> Optional[StyleConfig]:
        """Get a custom style (from the project config).

        Args:
            style_id: style ID

        Returns:
            A StyleConfig instance, or None if it does not exist
        """
        try:
            styles = cls._load_project_custom_style_map(
                username,
                project,
                project_dir,
                state_dir,
            )
            config_data = styles.get(style_id)
            if config_data:
                config_data["is_preset"] = False
                return StyleConfig(**config_data)
        except Exception as e:
            print(f"[StyleService] Failed to load custom style: {style_id}, {e}")

        return None

    @classmethod
    def save_custom_style(
        cls,
        style_id: str,
        config: StyleConfig,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> bool:
        """Save a custom style to the project config.

        Args:
            style_id: style ID
            config: style config

        Returns:
            Whether the save succeeded
        """
        try:
            # Ensure the ID is consistent
            config.id = style_id
            config.is_preset = False
            if not config.created_at:
                config.created_at = datetime.now()
            styles = cls._load_project_custom_style_map(
                username,
                project,
                project_dir,
                state_dir,
            )
            styles[style_id] = config.model_dump(mode="json")
            if not cls._save_project_custom_style_map(
                styles,
                username=username,
                project=project,
                project_dir=project_dir,
                state_dir=state_dir,
            ):
                return False

            print(f"[StyleService] Custom style saved: {style_id}")
            return True
        except Exception as e:
            print(f"[StyleService] Failed to save custom style: {style_id}, {e}")
            return False

    @classmethod
    def delete_custom_style(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> bool:
        """Delete a custom style.

        Args:
            style_id: style ID

        Returns:
            Whether the deletion succeeded
        """
        try:
            styles = cls._load_project_custom_style_map(
                username,
                project,
                project_dir,
                state_dir,
            )
            if style_id not in styles:
                return False
            styles.pop(style_id, None)
            if not cls._save_project_custom_style_map(
                styles,
                username=username,
                project=project,
                project_dir=project_dir,
                state_dir=state_dir,
            ):
                return False
            root = Path(project_dir) if project_dir else Path(OUTPUT_DIR) / str(username) / str(project)
            cls.remove_style_previews(root, style_id)
            print(f"[StyleService] Custom style deleted: {style_id}")
            return True
        except Exception as e:
            print(f"[StyleService] Failed to delete custom style: {style_id}, {e}")
            return False

    @classmethod
    def list_custom_styles(
        cls,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> list[str]:
        """List all custom style IDs.

        Returns:
            List of custom style IDs
        """
        try:
            styles = cls._load_project_custom_style_map(
                username,
                project,
                project_dir,
                state_dir,
            )
            return sorted(styles.keys())
        except Exception as e:
            print(f"[StyleService] Failed to list custom styles: {e}")

        return []

    @classmethod
    def get_style(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> Optional[StyleConfig]:
        """Get a style config (unified entry point).

        Lookup order:
        1. Custom styles first (Redis)
        2. Then system presets (files)

        This lets users override a system preset by creating a custom style with the same name.

        Args:
            style_id: style ID

        Returns:
            A StyleConfig instance, or None if it does not exist
        """
        # Look up custom styles first (allows overriding presets)
        custom = cls.get_custom_style(
            style_id,
            username=username,
            project=project,
            project_dir=project_dir,
            state_dir=state_dir,
        )
        if custom:
            return custom

        # Fall back to system presets
        preset = cls.get_preset(style_id)
        if preset:
            return preset

        return None

    @classmethod
    def get_style_or_default(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> StyleConfig:
        """Get a style config, returning the default style if it does not exist.

        Args:
            style_id: style ID

        Returns:
            A StyleConfig instance (guaranteed not None)
        """
        style = cls.get_style(
            style_id,
            username=username,
            project=project,
            project_dir=project_dir,
            state_dir=state_dir,
        )
        if style:
            return style

        # Return the default style
        default = cls.get_preset("chinese_period_drama")
        if default:
            return default

        # Fallback: return an empty config
        return StyleConfig(id="unknown", name="Unknown Style")

    @classmethod
    def list_preset_styles(cls) -> list[dict]:
        """List all system preset styles.

        Returns:
            List of preset styles, each containing {id, name, type}
        """
        styles = []
        if cls.PRESETS_DIR.exists():
            for f in sorted(cls.PRESETS_DIR.glob("*.json")):
                style_id = f.stem
                config = cls.get_preset(style_id)
                if config:
                    styles.append({
                        "id": style_id,
                        "name": config.name,
                        "label": config.label or config.name,
                        "type": "preset",
                        "style_family": config.style_family,
                        "animation_subtype": config.animation_subtype,
                    })
        return styles

    @classmethod
    def list_all_styles(
        cls,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> list[dict]:
        """List all available styles (presets + custom).

        Returns:
            List of styles, each containing {id, name, label, type}
        """
        styles = []

        # System presets
        styles.extend(cls.list_preset_styles())

        # Custom styles
        for style_id in cls.list_custom_styles(
            username=username,
            project=project,
            project_dir=project_dir,
            state_dir=state_dir,
        ):
            config = cls.get_custom_style(
                style_id,
                username=username,
                project=project,
                project_dir=project_dir,
                state_dir=state_dir,
            )
            if config:
                styles.append({
                    "id": style_id,
                    "name": config.name,
                    "label": config.label or config.name,
                    "type": "custom",
                    "preview_path": config.preview_path,
                    "style_family": config.style_family,
                    "animation_subtype": config.animation_subtype,
                })

        return styles

    @classmethod
    def get_style_family(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> str:
        config = cls.get_style_or_default(style_id, username=username, project=project, project_dir=project_dir)
        return config.style_family or "live_action"

    @classmethod
    def get_animation_subtype(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> str:
        config = cls.get_style_or_default(style_id, username=username, project=project, project_dir=project_dir)
        return (config.animation_subtype or "").lower()

    @classmethod
    def get_style_branch(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
        state_dir: str | Path | None = None,
    ) -> tuple[str, str]:
        config = cls.get_style_or_default(
            style_id,
            username=username,
            project=project,
            project_dir=project_dir,
            state_dir=state_dir,
        )
        return config.style_family or "live_action", (config.animation_subtype or "").lower()

    @classmethod
    def is_animation_style(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> bool:
        return cls.get_style_family(style_id, username=username, project=project, project_dir=project_dir) == "animation"

    @classmethod
    def is_live_action_style(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> bool:
        return not cls.is_animation_style(style_id, username=username, project=project, project_dir=project_dir)

    @classmethod
    def format_style_family_label(cls, family: str, subtype: str = "") -> str:
        base = cls.STYLE_FAMILY_LABELS.get(family or "live_action", "Live action")
        subtype = (subtype or "").lower()
        if family == "animation" and subtype:
            return f"{base} · {cls.ANIMATION_SUBTYPE_LABELS.get(subtype, subtype.upper())}"
        return base

    @classmethod
    def list_styles_by_family(
        cls,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> dict[str, list[dict]]:
        grouped = {
            "live_action": [],
            "animation": [],
        }
        for style in cls.list_all_styles(username=username, project=project, project_dir=project_dir):
            family = style.get("style_family") or "live_action"
            grouped.setdefault(family, []).append(style)
        return grouped

    @classmethod
    def get_default_style_for_family(
        cls,
        family: str,
        *,
        animation_subtype: str | None = None,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> str:
        grouped = cls.list_styles_by_family(username=username, project=project, project_dir=project_dir)
        styles = grouped.get(family or "live_action", [])
        subtype = (animation_subtype or "").lower()
        if family == "animation" and subtype:
            for preferred in ("guoman_fantasy", "anime"):
                if any(
                    style["id"] == preferred and (style.get("animation_subtype") or "").lower() == subtype
                    for style in styles
                ):
                    return preferred
            for style in styles:
                if (style.get("animation_subtype") or "").lower() == subtype:
                    return style["id"]
        if family == "animation":
            for preferred in ("guoman_fantasy", "anime"):
                if any(style["id"] == preferred for style in styles):
                    return preferred
        for preferred in ("chinese_period_drama", "realistic"):
            if any(style["id"] == preferred for style in styles):
                return preferred
        return styles[0]["id"] if styles else "chinese_period_drama"

    @classmethod
    def get_style_labels(
        cls,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> dict[str, str]:
        """Get the style ID -> display label mapping.

        For UI dropdowns and similar uses; compatible with the legacy STYLE_LABELS usage.

        Returns:
            {style_id: label} dict
        """
        labels = {}
        for style in cls.list_all_styles(username=username, project=project, project_dir=project_dir):
            labels[style["id"]] = style["label"]
        return labels

    @classmethod
    def clear_cache(cls):
        """Clear the preset cache (for hot reload)."""
        cls._preset_cache.clear()

    @classmethod
    def get_legacy_style_preset(
        cls,
        style_id: str,
        username: str | None = None,
        project: str | None = None,
        project_dir: str | Path | None = None,
    ) -> dict:
        """Get the legacy-format style preset (backward compatible).

        Keeps the same dict format as STYLE_PRESETS in config.py.

        Args:
            style_id: style ID

        Returns:
            A style config dict in the legacy format
        """
        config = cls.get_style_or_default(style_id, username=username, project=project, project_dir=project_dir)
        return config.to_legacy_dict()
