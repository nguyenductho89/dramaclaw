"""Qwen-Image 2.1 prompt composition for direct (sketch-free) beat renders.

The Qwen edit gateway builds ``image_1`` as a blank canvas of the target ratio, so
the reference images sent by dramaclaw are ``<image2>`` ... ``<image10>``. The
prompt is one continuous paragraph (no line breaks, no ratio/resolution text) that
names each reference by its ``<imageN>`` tag and states its role, following
``docs/nndaDocs/qwen-image-2.1/prompt_rewrite/prompts/system_prompt_edit.txt``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)

QWEN_CANVAS_OFFSET = 1
QWEN_MAX_REFERENCES = 9

_ROLE_ORDER = {"scene": 0, "identity": 1, "prop": 2}
_ROLE_TEXT = {
    "en": {
        "scene": "the location anchor that fixes the space, structure, materials and lighting",
        "identity": "the character identity that fixes face, hairstyle, build and outfit",
        "prop": "the prop that fixes its shape, material and details",
    },
    "zh": {
        "scene": "场景锚点，决定空间结构、材质与光线",
        "identity": "角色身份图，决定脸部、发型、体型与服装",
        "prop": "道具参考，决定造型、材质与细节",
    },
}

QWEN_RENDER_SYSTEM_PROMPT = """\
你是 Qwen-Image 2.1 的图像编辑提示词改写专家。任务：把一个分镜（beat）和一组编号参考图改写成一条可直接执行的出图指令。
输入 JSON 的 references 列出每张参考图的编号（tag，如 <image2>）、角色（role）和名称（label）；<image1> 是空白画布，只决定画幅，不要描述它。

规则：
1. 输出只有一段连续文字，不含换行，不含 JSON、Markdown 或解释。
2. 每张参考图都必须以其 tag 原样出现，并说明它的作用：scene=场景锚点（空间结构、材质、光线）；identity=角色身份（脸、发型、体型、服装，用“与 <imageN> 中的人物完全一致”指向参考图，不要重新描述其外貌）；prop=道具（造型、材质、细节）。
3. 只写 references 中存在的 tag，不得编造编号。
4. 这是“用参考图构建一张新画面”：按 beat 描述设计人物位置与动作、景别与机位、光线与氛围，描述要具体、可见、无歧义；没有出现在输入中的细节不要凭空添加。
5. 全部用肯定句表达（写“保持……一致”，不写“不要……”）。
6. 不得出现任何分辨率或画幅比例（如 16:9、1920x1080、2K、4K）。
7. 画面中需要出现的文字用英文双引号括起来，且同一处文字只用一种语言，不要中英混排。
8. 描述性文字的语言必须遵循 language_rule；人物名、地点名按输入原样保留。
"""


@dataclass(frozen=True)
class QwenReference:
    """One reference image as sent to Qwen; ``number`` is its ``<imageN>`` index."""

    number: int
    role: str
    label: str
    path: Path
    fallback_text: str = ""

    @property
    def tag(self) -> str:
        return f"<image{self.number}>"


def _asset_role(key: str) -> str:
    if key.startswith("identity:"):
        return "identity"
    if key.startswith("prop:"):
        return "prop"
    if key.startswith("scene:"):
        return "scene"
    return ""


def collect_qwen_references(assets: list[Any] | None) -> list[QwenReference]:
    """Scene, identity and prop images of a beat, numbered after the canvas."""

    picked: list[tuple[int, int, Any, str]] = []
    for index, asset in enumerate(assets or []):
        role = _asset_role(str(getattr(asset, "key", "") or ""))
        if (
            not role
            or getattr(asset, "media_type", "") != "image"
            or not getattr(asset, "selected", False)
            or not getattr(asset, "exists", False)
        ):
            continue
        picked.append((_ROLE_ORDER[role], index, asset, role))
    picked.sort(key=lambda item: (item[0], item[1]))
    return [
        QwenReference(
            number=QWEN_CANVAS_OFFSET + position,
            role=role,
            label=str(asset.label or ""),
            path=Path(asset.path),
            fallback_text=str(getattr(asset, "fallback_text", "") or ""),
        )
        for position, (_rank, _index, asset, role) in enumerate(
            picked[:QWEN_MAX_REFERENCES], start=1
        )
    ]


def _beat_source_text(beat: dict[str, Any]) -> str:
    return " ".join(
        str(beat.get(key) or "")
        for key in ("visual_description", "scene_description", "props_description")
    )


def qwen_prompt_language(beat: dict[str, Any]) -> AssetLanguage:
    return detect_asset_language(_beat_source_text(beat))


def build_qwen_render_draft(
    *,
    beat: dict[str, Any],
    references: list[QwenReference],
    style: str = "",
) -> str:
    """Rule-based single-paragraph prompt used when the model output is invalid."""

    language = qwen_prompt_language(beat)
    roles = _ROLE_TEXT[language]
    visual = re.sub(
        r"\{\{([^}]+)\}\}", r"\1", str(beat.get("visual_description") or "")
    ).strip().rstrip(".。")
    scene = str(beat.get("scene_description") or "").strip().rstrip(".。")
    parts: list[str] = []
    for ref in references:
        name = f"{ref.label} " if ref.label else ""
        if language == "en":
            parts.append(f"{ref.tag} is {name}{roles[ref.role]}.")
        else:
            parts.append(f"{ref.tag} 是{name}{roles[ref.role]}。")
    if language == "en":
        parts.append(f"Build a new cinematic frame: {visual or scene}.")
        if scene and visual:
            parts.append(f"Environment: {scene}.")
        parts.append("Keep every referenced character, location and prop consistent with its reference image.")
        if style:
            parts.append(f"Visual style: {style}.")
    else:
        parts.append(f"构建一张新的电影感画面：{visual or scene}")
        if scene and visual:
            parts.append(f"环境：{scene}")
        parts.append("保持所有参考的人物、场景与道具和参考图一致。")
        if style:
            parts.append(f"画面风格：{style}")
    return " ".join(part.strip() for part in parts if part.strip())


_TAG_RE = re.compile(r"<image(\d+)>")
_GEOMETRY_RE = re.compile(
    r"(?<![\d.])\d{1,2}\s*:\s*\d{1,2}(?![\d:])|\d{3,4}\s*[x×]\s*\d{3,4}|\b[1248]K\b",
    re.IGNORECASE,
)


def _one_paragraph(prompt: str) -> str:
    text = str(prompt or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
    return re.sub(r"\s*\n\s*", " ", text).strip()


def validate_qwen_render_prompt(prompt: str, references: list[QwenReference]) -> str:
    """Normalize to one paragraph and enforce the tag / geometry contract."""

    text = _one_paragraph(prompt)
    if not text:
        raise ValueError("Qwen render prompt is empty")
    allowed = {ref.number for ref in references}
    used = {int(value) for value in _TAG_RE.findall(text)}
    unknown = sorted(used - allowed)
    if unknown:
        raise ValueError(f"Qwen render prompt uses unknown tags: {unknown}")
    missing = sorted(allowed - used)
    if missing:
        raise ValueError(f"Qwen render prompt never mentions tags: {missing}")
    if _GEOMETRY_RE.search(text):
        raise ValueError("Qwen render prompt must not contain ratio or resolution")
    return text


def build_qwen_render_task(
    *,
    beat: dict[str, Any],
    references: list[QwenReference],
    style: str,
    draft_prompt: str,
) -> str:
    language = qwen_prompt_language(beat)
    payload = {
        "language_rule": asset_language_instruction(language),
        "style": style,
        "references": [
            {
                "tag": ref.tag,
                "role": ref.role,
                "label": ref.label,
                "fallback_text": ref.fallback_text,
            }
            for ref in references
        ],
        "beat": {
            "visual_description": beat.get("visual_description") or "",
            "scene_description": beat.get("scene_description") or "",
            "props_description": beat.get("props_description") or "",
            "shot_type": beat.get("shot_type") or "",
            "camera": beat.get("camera") or "",
            "keyframe_prompt": beat.get("keyframe_prompt") or "",
        },
        "rule_based_draft_prompt": draft_prompt,
    }
    return (
        "按系统规则改写出图指令，只输出最终的一段文字。\n\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2, default=str)}"
    )


def create_qwen_render_prompt_agent():
    from pydantic_ai import Agent

    from novelvideo.config import get_newapi_text_pydantic_model

    return Agent(
        get_newapi_text_pydantic_model(
            "QWEN_RENDER_PROMPT_MODEL",
            brainclaw_profile=BrainClawProfile.QWEN_RENDER_PROMPT_COMPOSITION,
            capability="text.generate.workflow",
        ),
        system_prompt=QWEN_RENDER_SYSTEM_PROMPT,
        output_type=str,
        name="Qwen Render Prompt Composer",
    )


async def compose_qwen_render_prompt(
    *,
    beat: dict[str, Any],
    references: list[QwenReference],
    style: str = "",
) -> tuple[str, bool]:
    """Return ``(prompt, used_ai)``; invalid or failed AI output yields the draft."""

    draft = build_qwen_render_draft(beat=beat, references=references, style=style)
    try:
        agent = create_qwen_render_prompt_agent()
        result = await agent.run(
            build_qwen_render_task(
                beat=beat, references=references, style=style, draft_prompt=draft
            )
        )
        return validate_qwen_render_prompt(str(result.output or ""), references), True
    except Exception:
        return _one_paragraph(draft), False
