"""Global verification: cross-beat character/clothing consistency check."""

import logging
import time
from collections import defaultdict
from pathlib import Path

from pydantic_ai import Agent, BinaryContent

logger = logging.getLogger(__name__)

from .models import CharacterConsistencyReport, ConsistencyResult
from .prompts import CONSISTENCY_VERIFY_PROMPT
from .sanitize import sanitize_prompt_input
from .utils import (
    compress_image,
    find_frame_for_beat,
    find_sketch_for_beat,
    load_all_beats,
    safe_resolve_under,
)


class ConsistencyVerifier:
    def __init__(self):
        self._agent: Agent | None = None

    def _get_agent(self) -> Agent:
        if self._agent is None:
            from novelvideo.config import (
                get_newapi_structured_output_model_settings,
                get_pydantic_model,
            )

            self._agent = Agent(
                get_pydantic_model(),
                system_prompt=CONSISTENCY_VERIFY_PROMPT,
                output_type=ConsistencyResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="Character consistency reviewer",
            )
        return self._agent

    def _load_identity_appearances(
        self, project_dir: Path,
    ) -> dict[str, str]:
        """Load the appearance_details of Identities from the project config.

        Returns:
            {identity_id: appearance_details} mapping
        """
        import json

        identity_appearances: dict[str, str] = {}
        characters_dir = project_dir / "characters"
        if not characters_dir.exists():
            return identity_appearances

        for char_file in characters_dir.glob("*.json"):
            # Path safety check: make sure the file is inside project_dir
            if not char_file.resolve().is_relative_to(project_dir.resolve()):
                logger.warning("Skipping file outside project dir: %s", char_file)
                continue
            try:
                char_data = json.loads(char_file.read_text(encoding="utf-8"))
                for identity in char_data.get("identities", []):
                    iid = identity.get("identity_id", "")
                    appearance = identity.get("appearance_details", "")
                    if iid and appearance:
                        identity_appearances[iid] = appearance
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning("Skipping %s: %s", char_file, e)
                continue
        return identity_appearances

    async def verify_consistency(
        self,
        project_dir,
        episode_num: int,
        verify_type: str = "sketch",
        sqlite_store=None,
    ) -> dict:
        """Check the character/clothing consistency of the whole episode.

        Group by character identity and send multiple images of the same character to the LLM together.
        Return the enhanced result: scored by dimension, with face/clothing separated.
        """
        project_dir = Path(project_dir)
        beats = await load_all_beats(project_dir, episode_num, sqlite_store=sqlite_store)

        # Load the Identity appearance settings
        identity_appearances = self._load_identity_appearances(project_dir)

        # Group by identity_id: {identity_id: [(beat_num, image_path, char_name)]}
        identity_beats: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
        for beat in beats:
            beat_num = beat["beat_number"]
            identities = beat.get("character_identities", {})
            find_fn = find_sketch_for_beat if verify_type == "sketch" else find_frame_for_beat
            img = find_fn(project_dir, episode_num, beat_num)
            if not img:
                continue
            # Path safety check: make sure the image is inside project_dir
            safe_img = safe_resolve_under(project_dir, img)
            if not safe_img:
                logger.warning("Skipping image outside project dir: %s", img)
                continue
            for char_name, identity_id in identities.items():
                identity_beats[identity_id].append((beat_num, str(safe_img), char_name))

        # Only check characters that appear in 2+ beats
        agent = self._get_agent()
        all_reports: list[CharacterConsistencyReport] = []

        for identity_id, appearances in identity_beats.items():
            if len(appearances) < 2:
                continue

            # Take at most 6 images to avoid too many tokens
            sampled = appearances if len(appearances) <= 6 else [
                appearances[0],
                appearances[len(appearances) // 4],
                appearances[len(appearances) // 2],
                appearances[3 * len(appearances) // 4],
                appearances[-1],
                appearances[len(appearances) // 3],
            ]

            char_name = sampled[0][2]
            beat_nums = [s[0] for s in sampled]

            # Build the task text, including the Identity appearance setting
            appearance_ref = ""
            if identity_id in identity_appearances:
                safe_appearance = sanitize_prompt_input(identity_appearances[identity_id])
                appearance_ref = f"\n\nIdentity appearance setting reference:\n{safe_appearance}"

            safe_char_name = sanitize_prompt_input(char_name)
            safe_identity_id = sanitize_prompt_input(identity_id)
            task = (
                f"Check the appearance consistency of character \"{safe_char_name}\" (identity: {safe_identity_id}) in the following beats:\n"
                f"Beat numbers: {beat_nums}\n"
                f"The images below are arranged in beat order; compare whether the same character is consistent across the different pictures.\n"
                f"Score each dimension (face, hair, skin_tone, gender, clothing_style, clothing_color, accessories, body_type) one by one."
                f"{appearance_ref}"
            )

            prompt_parts: list = [task]
            for beat_num, img_path, _ in sampled:
                img_bytes = compress_image(img_path)
                prompt_parts.append(
                    BinaryContent(data=img_bytes, media_type="image/jpeg")
                )

            start = time.monotonic()
            result = await agent.run(prompt_parts)
            elapsed = time.monotonic() - start
            output = result.output
            logger.info(
                "Consistency verify [%s]: characters=%d passed=%s elapsed=%.1fs",
                identity_id, len(output.characters),
                all(r.passed for r in output.characters), elapsed,
            )

            # Collect each character report
            for report in output.characters:
                all_reports.append(report)

        overall_passed = all(r.passed for r in all_reports) if all_reports else True

        # Build the return dict
        summary = "No character consistency issues found"
        if all_reports:
            summary = getattr(output, "summary", "Character consistency check complete")
        return {
            "total_beats": len(beats),
            "characters": [r.model_dump() for r in all_reports],
            "summary": summary,
            "overall_passed": overall_passed,
            "needs_human_review": not overall_passed,
        }
