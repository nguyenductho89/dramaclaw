"""General-purpose debugging helper for AI call context.

Records the full context of an AI call to make debugging and troubleshooting easier.
"""

import json
import re
from pathlib import Path
from datetime import datetime
from typing import Any, Optional

# Default debug output directory
DEBUG_OUTPUT_DIR = Path("/tmp/novelvideo_debug")

# Global switch
DEBUG_ENABLED = True


class DebugContext:
    """Records the full context of an AI call for debugging and troubleshooting.

    Usage example:
        debug = create_debug_context("video_prompt_builder")
        debug.add("episode_number", 5)
        debug.add("beat_number", 3)
        debug.add_section("input_params", {...})
        debug.save()
        debug.print_summary()
    """

    def __init__(self, name: str, enabled: bool = True):
        self.name = name
        self.enabled = enabled
        self.data: dict[str, Any] = {}
        self.timestamp = datetime.now().isoformat()
        self.warnings: list[str] = []

    def add(self, key: str, value: Any) -> "DebugContext":
        """Add context data."""
        if self.enabled:
            self.data[key] = value
        return self

    def add_section(self, section: str, data: dict) -> "DebugContext":
        """Add a data section."""
        if self.enabled:
            self.data[section] = data
        return self

    def add_warning(self, warning: str) -> "DebugContext":
        """Add a warning message."""
        if self.enabled:
            self.warnings.append(warning)
            print(f"[DebugContext] ⚠️ {warning}")
        return self

    def save(self, filename: Optional[str] = None) -> Optional[Path]:
        """Save the context to a file.

        Returns:
            Path of the saved file, or None (if disabled)
        """
        if not self.enabled:
            return None

        DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

        if filename is None:
            # Use a timestamp to generate a unique file name
            ts = self.timestamp.replace(":", "-").replace(".", "-")
            filename = f"{self.name}_{ts}.json"

        output_path = DEBUG_OUTPUT_DIR / filename

        # Also save under a fixed name (for quickly viewing the latest)
        latest_path = DEBUG_OUTPUT_DIR / f"{self.name}_latest.json"

        content = {
            "name": self.name,
            "timestamp": self.timestamp,
            "warnings": self.warnings,
            "data": self.data,
        }

        # Custom serializer handling Path and similar types
        def default_serializer(obj):
            if isinstance(obj, Path):
                return str(obj)
            return str(obj)

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, indent=2, default=default_serializer)

            with open(latest_path, "w", encoding="utf-8") as f:
                json.dump(content, f, ensure_ascii=False, indent=2, default=default_serializer)

            print(f"[DebugContext] {self.name} context saved to: {latest_path}")
            return latest_path
        except Exception as e:
            print(f"[DebugContext] save failed: {e}")
            return None

    def print_summary(self):
        """Print a summary of the key information."""
        if not self.enabled:
            return

        print(f"\n=== {self.name} Debug Summary ===")

        # Print warnings first
        if self.warnings:
            print("⚠️ WARNINGS:")
            for w in self.warnings:
                print(f"  - {w}")

        # Print a data summary
        for key, value in self.data.items():
            if isinstance(value, dict):
                print(f"{key}:")
                for k, v in value.items():
                    v_str = str(v)[:100] + "..." if len(str(v)) > 100 else str(v)
                    print(f"  {k}: {v_str}")
            else:
                v_str = str(value)[:100] + "..." if len(str(value)) > 100 else str(value)
                print(f"{key}: {v_str}")
        print("=" * 40)


def create_debug_context(name: str) -> DebugContext:
    """Create a debug context instance.

    Args:
        name: context name (e.g. "video_prompt_builder")

    Returns:
        DebugContext instance
    """
    return DebugContext(name, enabled=DEBUG_ENABLED)


def extract_episode_from_path(path: str) -> Optional[int]:
    """Extract the episode number from a path.

    Supported formats:
    - ep001, ep005, etc.
    - episode_1, episode_5, etc.

    Args:
        path: file path string

    Returns:
        Episode number, or None (if it cannot be extracted)
    """
    if not path:
        return None

    # Match formats such as ep001, ep005
    match = re.search(r'ep(\d{3})', path)
    if match:
        return int(match.group(1))

    # Match formats such as episode_1, episode_5
    match = re.search(r'episode[_-]?(\d+)', path, re.IGNORECASE)
    if match:
        return int(match.group(1))

    return None


def validate_episode_consistency(
    frame_image_path: str,
    episode_number: int,
    context_name: str = "unknown",
) -> tuple[bool, Optional[str]]:
    """Validate that the image path is consistent with the episode number.

    Args:
        frame_image_path: image file path
        episode_number: expected episode number
        context_name: name of the calling context (for logging)

    Returns:
        (is_valid, warning_message) tuple
        - is_valid: whether they are consistent
        - warning_message: warning text when inconsistent, None when consistent
    """
    if not frame_image_path or not episode_number:
        return True, None

    path_episode = extract_episode_from_path(frame_image_path)
    if path_episode is None:
        return True, None  # Episode cannot be extracted from the path; skip validation

    if path_episode != episode_number:
        warning = (
            f"EPISODE MISMATCH in {context_name}: "
            f"path contains ep{path_episode:03d} but episode_number={episode_number}"
        )
        return False, warning

    return True, None
