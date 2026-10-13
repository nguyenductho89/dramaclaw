"""T4: 对比选择。"""

import logging
import time

from pydantic_ai import Agent, BinaryContent

from .models import CandidateRanking, CompareResult
from .prompts import verification_prompt, verifier_language
from .sanitize import sanitize_prompt_input
from .utils import compress_image

logger = logging.getLogger(__name__)


class SketchComparer:
    """对比 N 张候选草图，输出排序。"""

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
                system_prompt=verification_prompt("sketch_compare", language),
                output_type=CompareResult,
                model_settings=get_newapi_structured_output_model_settings(),
                output_retries=2,
                name="导演级分镜评审",
            )
            self._agents[language] = agent
        return agent

    async def compare_sketches(
        self,
        candidate_paths: list[tuple[str, str]],
        visual_description: str,
        reference_paths: list[str] | None = None,
    ) -> CompareResult:
        if len(candidate_paths) < 2:
            raise ValueError("At least 2 candidates required for comparison")

        lang = verifier_language(self._language, visual_description)
        vi = lang == "vi"
        safe_desc = sanitize_prompt_input(visual_description)

        ref_section = ""
        if reference_paths:
            ref_section = (
                f"\n\n以下先展示 {len(reference_paths)} 张已选定的参考图（用于风格一致性对比），然后是候选草图。"
            )

        if vi and reference_paths:
            ref_section = (
                f"\n\nTrước tiên là {len(reference_paths)} hình tham chiếu đã chọn (dùng để so sánh độ thống nhất phong cách), sau đó là các phác thảo ứng viên."
            )
        task = (
            f"对比以下候选草图，选择最适合此 beat 的一张。\n"
            f"画面描述: {safe_desc}\n"
            f"共 {len(candidate_paths)} 张候选。"
            f"{ref_section}"
        )

        if vi:
            task = (
                f"So sánh các phác thảo ứng viên sau và chọn phác thảo phù hợp nhất cho beat này.\n"
                f"Mô tả khung hình: {safe_desc}\n"
                f"Tổng cộng {len(candidate_paths)} ứng viên."
                f"{ref_section}"
            )

        prompt_parts: list = [task]

        if reference_paths:
            for i, ref_path in enumerate(reference_paths, 1):
                prompt_parts.append((f"\n--- Hình tham chiếu {i} ---" if vi else f"\n--- 参考图 {i} ---"))
                ref_bytes = compress_image(ref_path)
                prompt_parts.append(BinaryContent(data=ref_bytes, media_type="image/jpeg"))

        for i, (pool_id, img_path) in enumerate(candidate_paths, 1):
            prompt_parts.append((f"\n--- Ứng viên {i} (ID: {pool_id}) ---" if vi else f"\n--- 候选 {i} (ID: {pool_id}) ---"))
            img_bytes = compress_image(img_path)
            prompt_parts.append(BinaryContent(data=img_bytes, media_type="image/jpeg"))

        agent = self._get_agent(lang)
        start = time.monotonic()
        result = await agent.run(prompt_parts)
        elapsed = time.monotonic() - start

        output = result.output
        if output.ranking:
            for item in output.ranking:
                if not item.pool_id and 1 <= item.rank <= len(candidate_paths):
                    item.pool_id = candidate_paths[item.rank - 1][0]
        else:
            output.ranking = [
                CandidateRanking(
                    pool_id=candidate_paths[i][0],
                    rank=1 if (i + 1) == output.selected_index else i + 2,
                    reason="selected" if (i + 1) == output.selected_index else "",
                )
                for i in range(len(candidate_paths))
            ]

        logger.info(
            "Sketch compare: selected=%d/%d elapsed=%.1fs",
            output.selected_index,
            len(candidate_paths),
            elapsed,
        )
        return output
