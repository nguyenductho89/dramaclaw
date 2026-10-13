"""T3: 内容匹配评分。"""

import logging
import time

from pydantic_ai import Agent, BinaryContent

from novelvideo.utils.source_language import select_by_language

from .models import ObjectiveScore
from .prompts import verification_prompt, verifier_language
from .sanitize import sanitize_prompt_input
from .utils import compress_image

logger = logging.getLogger(__name__)


class SketchScorer:
    """对单张草图进行内容匹配评分。"""

    def __init__(self, language: str | None = None):
        # ``_agent`` is an override slot (tests inject fakes here); real agents are
        # built lazily per language in ``_agents``.
        self._agent: Agent | None = None
        self._agents: dict[str, Agent] = {}
        self._language = language

    def _get_agent(self, language: str = "zh") -> Agent:
        if self._agent is not None:
            return self._agent
        agent = self._agents.get(language)
        if agent is None:
            from novelvideo.config import (
                get_newapi_structured_output_model_settings,
                get_pydantic_model,
            )

            agent = Agent(
                get_pydantic_model(),
                system_prompt=verification_prompt("sketch_score", language),
                output_type=ObjectiveScore,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="内容匹配评分员",
            )
            self._agents[language] = agent
        return agent

    async def score_sketch(
        self,
        image_path: str,
        visual_description: str,
        color_mapping: dict[str, str] | None = None,
    ) -> ObjectiveScore:
        lang = verifier_language(self._language, visual_description)
        safe_desc = sanitize_prompt_input(visual_description)

        color_section = ""
        if color_mapping:
            color_lines = []
            for identity_id, color_str in sorted(color_mapping.items()):
                parts = color_str.split(" ", 1)
                hex_code = parts[0]
                color_name = parts[1] if len(parts) > 1 else ""
                color_lines.append(f"- {color_name} ({hex_code}) = {identity_id}")
            if color_lines:
                color_section = (
                    select_by_language(
                        lang, zh="\n\n角色颜色标记:\n", vi="\n\nDấu màu nhân vật:\n"
                    )
                    + "\n".join(color_lines)
                )

        if lang == "vi":
            task = (
                f"Đánh giá mức độ phác thảo tái hiện mô tả sau:\n"
                f"Mô tả khung hình: {safe_desc}"
                f"{color_section}"
            )
        else:
            task = (
                f"评估草图对以下描述的还原程度:\n"
                f"画面描述: {safe_desc}"
                f"{color_section}"
            )

        image_bytes = compress_image(image_path)
        agent = self._get_agent(lang)
        start = time.monotonic()
        result = await agent.run(
            [task, BinaryContent(data=image_bytes, media_type="image/jpeg")]
        )
        elapsed = time.monotonic() - start
        logger.info(
            "Sketch score: script_match=%.1f identity_clarity=%.1f total=%.1f elapsed=%.1fs",
            result.output.script_match,
            result.output.identity_clarity,
            result.output.total,
            elapsed,
        )
        return result.output
