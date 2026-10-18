"""Verification report formatting and persistence."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)


def format_verification_report(result: dict, beat_num: int, verify_type: str) -> str:
    """Format a VerificationResult as human-readable markdown text.

    Args:
        result: dict from VerificationResult.model_dump()
        beat_num: beat number
        verify_type: "sketch" or "frame"
    """
    passed = result.get("passed", False)
    score = result.get("score", 0.0)
    type_label = "Sketch verification" if verify_type == "sketch" else "First-frame verification"
    icon = "✅" if passed else "❌"
    status = "Passed" if passed else "Failed"

    lines = [f"{icon} Beat {beat_num} {type_label}{status} ({score:.1f}/10)"]

    issues = result.get("issues", [])
    if not issues:
        lines.append("No factual errors")
    else:
        for issue in issues:
            severity = issue.get("severity", "info")
            desc = issue.get("description", "")
            lines.append(f"- [{severity}] {desc}")

    action = result.get("suggested_action", "none")
    if action and action != "none":
        lines.append(f"Suggested action: {action}")

    return "\n".join(lines)


def format_consistency_report(data: dict, episode_num: int) -> str:
    """Format the consistency verify result as a markdown table.

    Args:
        data: dict returned by verify_consistency
        episode_num: episode number
    """
    characters = data.get("characters", [])
    if not characters:
        return f"## Character consistency report (EP{episode_num})\n\nNo characters to check"

    lines = [
        f"## Character consistency report (EP{episode_num})",
        "",
        "| Character | Face | Clothing | Beats checked | Result |",
        "|------|------|------|----------|------|",
    ]

    passed_count = 0
    for char in characters:
        name = char.get("character", "?")
        face = char.get("face_score", 0.0)
        clothing = char.get("clothing_score", 0.0)
        beats = char.get("beats_checked", [])
        beats_str = ",".join(str(b) for b in beats)
        char_passed = char.get("passed", False)
        icon = "✅" if char_passed else "❌"
        if char_passed:
            passed_count += 1
        lines.append(f"| {name} | {face:.1f} | {clothing:.1f} | {beats_str} | {icon} |")

    total = len(characters)
    lines.append("")
    lines.append(f"Summary: {passed_count}/{total} characters passed")

    return "\n".join(lines)


def format_color_verify_report(data: dict, episode_num: int) -> str:
    """Format the color verification result as a markdown table."""
    beat_results = data.get("beat_results", [])
    if not beat_results:
        return f"## Sketch color verification report (EP{episode_num})\n\nNo beats to check"

    lines = [
        f"## Sketch color verification report (EP{episode_num})",
        "",
        "| Beat | Status | Expected characters | Detected | Missing | Extra |",
        "|------|------|----------|--------|------|------|",
    ]
    status_icons = {"pass": "✅", "fail": "❌", "warn": "⚠️"}

    for br in beat_results:
        beat_num = br.get("beat_number", "?")
        status = br.get("status", "pass")
        icon = status_icons.get(status, "?")
        expected = ", ".join(br.get("expected", [])) or "-"
        detected = ", ".join(br.get("detected", [])) or "-"
        missing_names = ", ".join(m.get("identity_id", "") for m in br.get("missing", [])) or "-"
        extra_names = ", ".join(e.get("identity_id", "") for e in br.get("extra", [])) or "-"
        lines.append(
            f"| {beat_num} | {icon} | {expected} | {detected} | {missing_names} | {extra_names} |"
        )

    passed = data.get("passed_beats", 0)
    total = data.get("total_beats", 0)
    failed = data.get("failed_beats", 0)
    warned = data.get("warned_beats", 0)
    failed_nums = data.get("failed_beat_numbers", [])
    lines.append("")
    summary_parts = [f"{passed}/{total} beats passed"]
    if failed:
        summary_parts.append(f"{failed} beats failed {failed_nums}")
    if warned:
        summary_parts.append(f"{warned} beats with warnings")
    lines.append(f"Summary: {', '.join(summary_parts)}")
    return "\n".join(lines)


def format_episode_overview_report(data: dict, episode_num: int) -> str:
    """Format the whole-episode storyboard overview result as markdown."""
    passed = data.get("overall_passed", False)
    total = data.get("total", 0.0)
    icon = "✅" if passed else "❌"
    status = "Passed" if passed else "Failed"

    lines = [
        f"## Global storyboard review (EP{episode_num}) {icon} {status}",
        "",
        "| Dimension | Score |",
        "|------|------|",
        f"| Visual rhythm | {data.get('visual_rhythm', 0):.1f} |",
        f"| Composition diversity | {data.get('composition_diversity', 0):.1f} |",
        f"| Narrative arc | {data.get('narrative_arc', 0):.1f} |",
        f"| Style unity | {data.get('style_unity', 0):.1f} |",
        f"| **Total** | **{total:.1f}** |",
    ]

    issues = data.get("issues", [])
    if issues:
        lines.append("")
        lines.append("### Issues")
        for issue in issues:
            severity = issue.get("severity", "warning")
            beat = issue.get("beat_number", "?")
            desc = issue.get("description", "")
            action = issue.get("suggested_action", "info")
            related = issue.get("related_beats", [])
            related_str = f" (related: {related})" if related else ""
            lines.append(f"- [{severity}] Beat {beat}: {desc} → {action}{related_str}")
    else:
        lines.append("")
        lines.append("No global issues")

    scene_dist = data.get("scene_distribution", {})
    if scene_dist:
        lines.append("")
        lines.append("### Scene assignment")
        for scene, beat_nums in scene_dist.items():
            lines.append(f"- {scene}: beats {beat_nums} ({len(beat_nums)} total)")

    summary = data.get("summary", "")
    if summary:
        lines.append("")
        lines.append(f"Overall: {summary}")
    return "\n".join(lines)


def save_verify_report(
    project_dir: Path,
    episode_num: int,
    beat_num: int | None,
    verify_type: str,
    data: dict,
) -> Path:
    """Persist the report to the verify_reports/ directory and return the saved path.

    Only the latest file is kept and it is overwritten. A timestamp field is recorded inside.

    Args:
        project_dir: Project directory
        episode_num: Episode number
        beat_num: Beat number; None for consistency
        verify_type: "sketch" | "frame" | "consistency"
        data: Complete response data dict
    """
    reports_dir = project_dir / "verify_reports" / f"ep{episode_num:03d}"
    reports_dir.mkdir(parents=True, exist_ok=True)

    if verify_type == "consistency":
        filename = "consistency.json"
    elif verify_type == "frame_consistency":
        filename = "frame_consistency.json"
    elif verify_type == "sketch_colors":
        filename = "sketch_colors.json"
    elif verify_type == "episode_overview":
        filename = "episode_overview.json"
    elif verify_type in ("continuity", "similarity", "sketch_select"):
        filename = f"{verify_type}.json"
    else:
        filename = f"beat_{beat_num:02d}_{verify_type}.json"

    report_path = reports_dir / filename

    # Attach timestamp
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **data,
    }

    report_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Report saved: %s", report_path)
    return report_path
