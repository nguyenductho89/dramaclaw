"""Nano Banana Pro character reference image generation module.

Uses Google AI Studio (Gemini) to generate character reference images,
with the same model as grid generation, ensuring visual consistency of characters.

Core technique: Identity Locking
- The reference image is an "identity anchor", not a pose template
- Keep: facial structure, feature proportions, expression, overall likeness
- Change: clothing, background, pose, angle, lighting

References:
- https://github.com/aimikoda/nano-banana-pro-prompts
- https://replicate.com/blog/how-to-prompt-nano-banana-pro
"""

import asyncio
import base64
import mimetypes
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, Field

from novelvideo.config import (
    get_grid_generation_config,
    get_style_preset,
    IMAGE_DEFAULT_STYLE,
)
from novelvideo.shared.billing_errors import is_fatal_billing_error
from novelvideo.image_request_usage import (
    record_image_request,
    update_image_request_status,
)
from novelvideo.services.style_service import StyleService
from novelvideo.generators.nanobanana_grid import (
    _InlineImagePart,
    _call_huimeng_image_api,
    _call_newapi_image_api,
    _call_openai_image_api,
    _call_openrouter_image_api,
    _call_qwen_image_api,
    _call_runpod_qwen_image_api,
    _call_webai_chat_image_api,
    generate_reference_edit_image,
    generate_text_to_image,
    normalize_openai_quality,
    normalize_image_size,
)
from novelvideo.egress_context import (
    TrustedEgressContext,
    ambient_organization_egress_context,
)


def _default_ethnicity_instruction(ethnicity: str) -> str:
    value = (ethnicity or "").strip()
    if not value:
        return ""
    return (
        f"Default ethnicity for unspecified people: {value}. "
        f"Use this only when the character description and reference images do not specify ethnicity, "
        f"nationality, or regional appearance. If the character description says Western, Persian, Japanese, "
        f"mixed-race, foreign, or any other explicit origin, follow that explicit description."
    )


def create_composite_reference(
    portrait_path: str,
    fullbody_path: str,
    output_path: str,
) -> str:
    """Stitch the Portrait (face close-up) and the full-body image into a composite reference image.

    Composite layout:
    ┌─────────────┬─────────────┐
    │   LEFT      │   RIGHT     │
    │   PANEL     │   PANEL     │
    │             │             │
    │   FACE      │   FULL      │
    │   (Portrait)│   BODY      │
    └─────────────┴─────────────┘

    Args:
        portrait_path: path of the Portrait face close-up image
        fullbody_path: path of the full-body image
        output_path: output path of the composite image

    Returns:
        Output path
    """
    from PIL import Image

    portrait = Image.open(portrait_path)
    fullbody = Image.open(fullbody_path)

    # Unify the height (take the larger one)
    target_height = max(portrait.height, fullbody.height)

    # Resize while keeping proportions
    p_ratio = portrait.width / portrait.height
    portrait_resized = portrait.resize(
        (int(target_height * p_ratio), target_height), Image.Resampling.LANCZOS
    )

    f_ratio = fullbody.width / fullbody.height
    fullbody_resized = fullbody.resize(
        (int(target_height * f_ratio), target_height), Image.Resampling.LANCZOS
    )

    # Stitch: Portrait on the left, Fullbody on the right
    total_width = portrait_resized.width + fullbody_resized.width
    composite = Image.new("RGB", (total_width, target_height))
    composite.paste(portrait_resized, (0, 0))
    composite.paste(fullbody_resized, (portrait_resized.width, 0))

    # Save
    composite.save(output_path, "PNG")
    print(f"[NanoBanana Character] Composite image generated: {output_path} ({total_width}x{target_height})")

    return output_path


class CharacterReferenceResult(BaseModel):
    """Character reference image generation result."""

    success: bool
    character_name: str
    reference_paths: List[str] = Field(default_factory=list)
    primary_reference: str = Field(default="")
    error: Optional[str] = None
    generation_time: float = 0.0
    # Prompt info returned in Dry Run mode
    prompt: Optional[str] = None
    prompt_file: Optional[str] = None


class NanoBananaCharacterGenerator:
    """Nano Banana Pro character portrait generator.

    Uses the same model (Gemini) as the grid generator, ensuring visual consistency of characters.
    Currently only responsible for generating the portrait / identity anchor.
    The four-view reference sheet goes through generate_identity_with_reference().

    Example:
        >>> generator = NanoBananaCharacterGenerator()
        >>> result = await generator.generate_character_portrait(
        ...     character_name="Jiang Shangning",
        ...     character_prompt="Female, 20 years old, black hair in a bun, willow-leaf eyebrows, almond eyes, red lips, ancient-style Hanfu",
        ...     output_dir="output/characters/jiangsn"
        ... )
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        config: Optional[dict] = None,
        selection: Optional[str] = None,
        egress_context: TrustedEgressContext | None = None,
    ):
        """Initialize the generator.

        Args:
            api_key: API Key; read from the environment by default
        """
        if (
            egress_context is not None
            and type(egress_context) is not TrustedEgressContext
        ):
            raise TypeError("egress_context must be a TrustedEgressContext")
        if egress_context is None:
            egress_context = ambient_organization_egress_context()
        config = config or get_grid_generation_config(selection_override=selection)
        if egress_context is not None and egress_context.is_organization:
            config = dict(config)
            config.update(
                {
                    "provider": "newapi",
                    "api_key": "request-scoped",
                    "base_url": "https://request-scoped.invalid/v1",
                }
            )
        self.egress_context = egress_context
        self.provider = config.get(
            "provider", "google"
        )  # google / openrouter / openai / huimeng / newapi
        self.api_key = api_key or config["api_key"]
        self.model = config["model"]
        self.base_url = config.get("base_url", "")
        self.openai_image_quality = config.get("openai_image_quality", "medium")
        # Selection-level resolution override (e.g. "Google Gemini (2K)" in
        # the Image source picker) — wins over each method's own image_size
        # default/param. See IMAGE_GENERATION_SELECTIONS in config.py.
        self.force_image_size = config.get("force_image_size") or None

        if not self.api_key:
            if self.provider == "openrouter":
                key_name = "OPENROUTER_API_KEY"
            elif self.provider == "huimeng":
                key_name = "HUIMENGI_API_KEY"
            elif self.provider == "newapi":
                key_name = "NEWAPI_API_KEY"
            elif self.provider == "openai":
                key_name = "OPENAI_API_KEY"
            elif self.provider == "qwen":
                key_name = "QWEN_API_KEY"
            elif self.provider == "runpod_qwen":
                key_name = "RUNPOD_API_KEY"
            else:
                key_name = "GOOGLE_AI_API_KEY"
            raise ValueError(f"API key not set. " f"Set {key_name} environment variable.")

        print(f"[NanoBanana Character] Provider: {self.provider}, Model: {self.model}")

    async def generate_character_portrait(
        self,
        character_name: str,
        character_prompt: str,
        character_tag: str = "",
        style: str = None,
        output_dir: str = None,
        ethnicity: str = "Chinese",
        prompt_only: bool = False,  # Dry Run mode: only generate prompts, do not call the API
        project_dir: str = "",
        state_dir: str = "",
        usage_task_type: str = "character_portrait",
        usage_scope: str = "",
        identity_name: str = "",
    ) -> CharacterReferenceResult:
        """Generate the character portrait / identity anchor.

        Args:
            character_name: character name
            character_prompt: character appearance description prompt
            character_tag: unique short character tag (used as the identity marker in the prompt)
            style: style name; defaults to the global config
            output_dir: output directory
            ethnicity: character ethnicity (default "Chinese"), used to ensure correct facial features

        Returns:
            CharacterReferenceResult
        """
        start_time = time.time()

        # Use the global default style
        if style is None:
            style = IMAGE_DEFAULT_STYLE

        # Make sure the output directory exists
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        request_id = uuid.uuid4().hex
        project_output_dir = Path(project_dir).resolve() if project_dir else None
        usage_recorded = False

        try:
            client = None
            if self.provider == "google":
                from google import genai

                client = genai.Client(api_key=self.api_key)

            # Get the style preset
            style_preset = get_style_preset(
                style,
                project_dir=project_dir,
                state_dir=state_dir or None,
            )
            style_keywords = style_preset.get("style_instructions", "")
            negative_keywords = style_preset.get("avoid_instructions", "")

            # Generate the character tag (if not provided)
            if not character_tag:
                # Generate a short tag from the character name
                character_tag = self._generate_character_tag(character_name)

            print(f"[NanoBanana Character] Generating front base image for {character_name}...")

            front_prompt = self._build_character_prompt(
                character_name=character_name,
                character_prompt=character_prompt,
                character_tag=character_tag,
                style_name=style,
                project_dir=project_dir,
                style_keywords=style_keywords,
                negative_keywords=negative_keywords,
                state_dir=state_dir,
                ethnicity=ethnicity,
            )

            # Save the prompt to a file (for auditing)
            if output_dir:
                if project_dir:
                    prompts_dir = Path(project_dir) / "prompts" / "characters"
                else:
                    prompts_dir = Path(output_dir).parent.parent.parent / "prompts" / "characters"
                prompts_dir.mkdir(parents=True, exist_ok=True)
                prompt_file = prompts_dir / f"{character_name}_portrait.prompt.txt"
                prompt_file.write_text(front_prompt, encoding="utf-8")
                print(f"[NanoBanana Character] Prompt saved: {prompt_file}")

            # Prompt-Only mode: only generate the prompt, skip the API call
            if prompt_only:
                print(f"[NanoBanana Character] Prompt-Only mode, skipping API call")
                return CharacterReferenceResult(
                    success=True,
                    character_name=character_name,
                    reference_paths=[],
                    primary_reference="",
                    generation_time=time.time() - start_time,
                )

            if project_output_dir:
                record_image_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider=self.provider,
                    model_name=self.model,
                    task_type=usage_task_type,
                    scope=usage_scope or f"character:{character_name}:portrait",
                    character_name=character_name,
                    identity_name=identity_name or None,
                )
                usage_recorded = True

            portrait_ref_path = (
                os.path.join(output_dir, "reference_portrait.png") if output_dir else None
            )
            portrait_bytes = await self._generate_single_image(
                client=client,
                prompt=front_prompt,
                output_path=portrait_ref_path,
                image_size="0.5K",
            )

            if portrait_bytes and portrait_ref_path:
                print(f"[NanoBanana Character] Portrait generated: {portrait_ref_path}")
            else:
                if usage_recorded and project_output_dir:
                    update_image_request_status(
                        project_output_dir=project_output_dir,
                        request_id=request_id,
                        status="failed",
                        error_message="Failed to generate front base image",
                    )
                return CharacterReferenceResult(
                    success=False,
                    character_name=character_name,
                    error="Failed to generate front base image",
                    generation_time=time.time() - start_time,
                )

            generation_time = time.time() - start_time
            print(
                f"[NanoBanana Character] {character_name} portrait generation complete, took {generation_time:.1f}s"
            )
            if usage_recorded and project_output_dir:
                update_image_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status="completed",
                )

            return CharacterReferenceResult(
                success=True,
                character_name=character_name,
                reference_paths=[portrait_ref_path] if portrait_ref_path else [],
                primary_reference=portrait_ref_path or "",
                generation_time=generation_time,
            )

        except ImportError:
            if usage_recorded and project_output_dir:
                update_image_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status="failed",
                    error_message="Please install google-genai: pip install google-genai",
                )
            return CharacterReferenceResult(
                success=False,
                character_name=character_name,
                error="Please install google-genai: pip install google-genai",
                generation_time=time.time() - start_time,
            )
        except Exception as e:
            if is_fatal_billing_error(e):
                raise
            if usage_recorded and project_output_dir:
                update_image_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status="failed",
                    error_message=str(e),
                )
            return CharacterReferenceResult(
                success=False,
                character_name=character_name,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def generate_character_reference(
        self,
        character_name: str,
        character_prompt: str,
        character_tag: str = "",
        style: str = None,
        views: List[str] = None,
        output_dir: str = None,
        face_only: bool = False,
        ethnicity: str = "Chinese",
        prompt_only: bool = False,
        project_dir: str = "",
        state_dir: str = "",
        usage_task_type: str = "character_portrait",
        usage_scope: str = "",
        identity_name: str = "",
    ) -> CharacterReferenceResult:
        """Compatible with the old interface; internally unified to the portrait-first mechanism."""
        _ = views, face_only
        return await self.generate_character_portrait(
            character_name=character_name,
            character_prompt=character_prompt,
            character_tag=character_tag,
            style=style,
            output_dir=output_dir,
            ethnicity=ethnicity,
            prompt_only=prompt_only,
            project_dir=project_dir,
            state_dir=state_dir,
            usage_task_type=usage_task_type,
            usage_scope=usage_scope,
            identity_name=identity_name,
        )

    async def generate_identity_with_reference(
        self,
        character_name: str,
        identity_prompt: str,
        reference_image_path: str,
        output_path: str,
        character_tag: str = "",
        style: str = None,
        ethnicity: str = "Chinese",
        dry_run: bool = False,
        project_dir: str = "",
        state_dir: str = "",
        costume_image_path: str = "",
        usage_task_type: str = "identity_image",
        usage_scope: str = "",
        identity_name: str = "",
    ) -> CharacterReferenceResult:
        """Generate an identity reference image from the character base image (Identity Locking).

        Uses the character's front base image as the identity anchor to keep the face consistent,
        changing only identity-specific looks such as clothing and background.
        Always generates a 4-panel reference sheet (full face close-up + front full body + 45-degree three-quarter full body + back full body).

        Args:
            character_name: character name
            identity_prompt: identity appearance description (clothing, scene, etc.)
            reference_image_path: path of the character front base image
            output_path: output image path
            character_tag: unique short character tag
            style: style name
            ethnicity: character ethnicity (default "Chinese"), used to ensure correct facial features
            dry_run: whether to generate only the prompt without images (default False)

        Returns:
            CharacterReferenceResult
        """
        start_time = time.time()

        if style is None:
            style = IMAGE_DEFAULT_STYLE

        request_id = uuid.uuid4().hex
        project_output_dir = Path(project_dir).resolve() if project_dir else None
        resolved_identity_name = identity_name or (Path(output_path).stem if output_path else "")
        usage_recorded = False

        try:
            client = None
            if self.provider == "google":
                from google import genai

                client = genai.Client(api_key=self.api_key)

            # Get the style preset
            style_preset = get_style_preset(
                style,
                project_dir=project_dir,
                state_dir=state_dir or None,
            )
            style_keywords = style_preset.get("style_instructions", "")
            negative_keywords = style_preset.get("avoid_instructions", "")

            if not character_tag:
                character_tag = self._generate_character_tag(character_name)

            print(
                f"[NanoBanana Character] Generating identity image for {character_name} from the base image (4 panels: front + three-quarter + back)..."
            )

            # Build the Identity Locked Prompt (4 panels: full face + front + 45-degree three-quarter + back)
            has_costume_ref = bool(costume_image_path and os.path.exists(costume_image_path))
            prompt = self._build_identity_locked_prompt(
                character_name=character_name,
                character_prompt=identity_prompt,
                character_tag=character_tag,
                target_view="front",
                style_name=style,
                project_dir=project_dir,
                style_keywords=style_keywords,
                negative_keywords=negative_keywords,
                state_dir=state_dir,
                ethnicity=ethnicity,
                has_costume_reference=has_costume_ref,
            )

            # Save the prompt to a file (for auditing)
            prompt_file = None
            if output_path:
                if project_dir:
                    prompts_dir = Path(project_dir) / "prompts" / "characters"
                else:
                    # output_path: output/{username}/{project}/assets/characters/{character_name}/identities/{identity_name}.png
                    prompts_dir = (
                        Path(output_path).parent.parent.parent.parent.parent
                        / "prompts"
                        / "characters"
                    )
                prompts_dir.mkdir(parents=True, exist_ok=True)
                # Extract the identity name from output_path
                prompt_file = (
                    prompts_dir / f"{character_name}_identity_{resolved_identity_name}.prompt.txt"
                )
                prompt_file.write_text(prompt, encoding="utf-8")
                print(f"[NanoBanana Character] Identity Prompt saved: {prompt_file}")

            # Dry Run mode: only generate the prompt, no images
            if dry_run:
                print(f"[NanoBanana Character] Dry Run mode, skipping image generation")
                return CharacterReferenceResult(
                    success=True,
                    character_name=character_name,
                    prompt=prompt,
                    prompt_file=str(prompt_file) if prompt_file else None,
                    generation_time=time.time() - start_time,
                )

            if project_output_dir:
                record_image_request(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    provider=self.provider,
                    model_name=self.model,
                    task_type=usage_task_type,
                    scope=usage_scope
                    or f"character:{character_name}:identity:{resolved_identity_name}",
                    character_name=character_name,
                    identity_name=resolved_identity_name,
                )
                usage_recorded = True

            # Load the reference image (may be empty for scenarios without one, such as age variants)
            ref_image = None
            ref_image_bytes = None
            if reference_image_path and os.path.exists(reference_image_path):
                ref_image = self._load_image_as_part(reference_image_path)
                if not ref_image and self.provider == "google":
                    return CharacterReferenceResult(
                        success=False,
                        character_name=character_name,
                        error=f"Cannot load reference image: {reference_image_path}",
                        generation_time=time.time() - start_time,
                    )
                with open(reference_image_path, "rb") as f:
                    ref_image_bytes = f.read()
            else:
                print(f"[NanoBanana Character] No reference image, generating independently from the text description")

            # Load the costume reference image (if any)
            costume_image = None
            costume_image_bytes = None
            if costume_image_path and os.path.exists(costume_image_path):
                costume_image = self._load_image_as_part(costume_image_path)
                with open(costume_image_path, "rb") as f:
                    costume_image_bytes = f.read()
                print(f"[NanoBanana Character] Costume reference image loaded: {costume_image_path}")

            # Unified flow: generate the body to a temp file -> stitch the portrait -> delete temp
            aspect_ratio = "16:9"  # 4 panels: full face + front + three-quarter + back
            image_size = "1K"
            body_label = "4-panel reference sheet"

            temp_body_path = output_path.replace(".png", "_body_temp.png")
            print(f"[NanoBanana Character] Generating {body_label} to temp file: {temp_body_path}")

            image_bytes = await self._generate_with_reference(
                client=client,
                prompt=prompt,
                reference_image=ref_image,
                output_path=temp_body_path,
                reference_image_bytes=ref_image_bytes,
                reference_image_name=reference_image_path,
                aspect_ratio=aspect_ratio,
                image_size=image_size,
                additional_images=[costume_image] if costume_image else None,
                additional_image_bytes=[costume_image_bytes] if costume_image_bytes else None,
                additional_image_names=[costume_image_path] if costume_image_bytes else None,
            )

            if image_bytes:
                # Use the sheet directly as the identity reference image (zero stitching, naturally consistent)
                import shutil

                shutil.move(temp_body_path, output_path)
                print(f"[NanoBanana Character] {body_label} saved: {output_path}")

                generation_time = time.time() - start_time
                print(
                    f"[NanoBanana Character] Composite identity image generated: {output_path}, took {generation_time:.1f}s"
                )
                if usage_recorded and project_output_dir:
                    update_image_request_status(
                        project_output_dir=project_output_dir,
                        request_id=request_id,
                        status="completed",
                    )
                return CharacterReferenceResult(
                    success=True,
                    character_name=character_name,
                    reference_paths=[output_path],
                    primary_reference=output_path,
                    generation_time=generation_time,
                )
            else:
                if usage_recorded and project_output_dir:
                    update_image_request_status(
                        project_output_dir=project_output_dir,
                        request_id=request_id,
                        status="failed",
                        error_message=f"Failed to generate {body_label}",
                    )
                return CharacterReferenceResult(
                    success=False,
                    character_name=character_name,
                    error=f"Failed to generate {body_label}",
                    generation_time=time.time() - start_time,
                )

        except Exception as e:
            if is_fatal_billing_error(e):
                raise
            if usage_recorded and project_output_dir:
                update_image_request_status(
                    project_output_dir=project_output_dir,
                    request_id=request_id,
                    status="failed",
                    error_message=str(e),
                )
            return CharacterReferenceResult(
                success=False,
                character_name=character_name,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def generate_composite_reference(
        self,
        character_name: str,
        character_prompt: str,
        character_tag: str = "",
        style: str = None,
        output_dir: str = None,
        ethnicity: str = "Chinese",
        project_dir: str = "",
        state_dir: str = "",
    ) -> CharacterReferenceResult:
        """Generate a Face+Body composite reference image (C1 optimization).

        Generates a side-by-side image containing a face close-up and a full body, for stronger identity locking.
        This is the best practice officially recommended for Nano Banana Pro.

        References:
        - https://imaginewithrashid.com/how-to-create-consistent-characters-using-gemini-nano-banana-pro/
        - "Start by using Nano Banana Pro to generate a side-by-side image:
           a close-up face on the left and a full-body view on the right"

        Args:
            character_name: character name
            character_prompt: character appearance description prompt
            character_tag: unique short character tag
            style: style name; defaults to the global config
            output_dir: output directory
            ethnicity: character ethnicity (default "Chinese")

        Returns:
            CharacterReferenceResult, with primary_reference pointing to the composite image
        """
        start_time = time.time()

        if style is None:
            style = IMAGE_DEFAULT_STYLE

        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        try:
            client = None
            if self.provider == "google":
                from google import genai

                client = genai.Client(api_key=self.api_key)

            # Get the style preset
            style_preset = get_style_preset(
                style,
                project_dir=project_dir,
                state_dir=state_dir or None,
            )
            style_keywords = style_preset.get("style_instructions", "")
            negative_keywords = style_preset.get("avoid_instructions", "")

            if not character_tag:
                character_tag = self._generate_character_tag(character_name)

            print(f"[NanoBanana Character] Generating composite reference image (Face+Body) for {character_name}...")

            # Build the composite reference image prompt (core C1 optimization)
            prompt = f"""Generate a SIDE-BY-SIDE composite reference image for character identity locking.

CHARACTER: {character_tag} ({character_name})

⚠️ CRITICAL LAYOUT REQUIREMENTS ⚠️
Create a 1:2 aspect ratio image divided into TWO EQUAL halves:
LEFT HALF = Face close-up (identity source)
RIGHT HALF = Full body (proportions & costume source)

LEFT HALF (Face Close-up):
- Head and shoulders portrait
- Face fills 60-70% of this panel
- Neutral soft gradient background
- Focus on facial features: eyes, nose, lips, skin texture
- Well-lit face with clear details

RIGHT HALF (Full Body):
- Full-body shot of the SAME PERSON
- Standing pose, facing camera
- Neutral background
- Show complete figure from head to feet
- Same lighting style as left panel

DEFAULT ETHNICITY (FALLBACK ONLY):
{_default_ethnicity_instruction(ethnicity)}

CHARACTER DESCRIPTION:
{character_prompt}

IDENTITY CONSISTENCY (CRITICAL):
Both panels MUST show the EXACT SAME PERSON with IDENTICAL:
- Facial structure (bone structure, face shape, proportions)
- Facial features (eye shape/color, nose, lips)
- Skin tone and texture
- Hair color, style, length, texture
- Body proportions and build
- Clothing style (if described)

VISUAL STYLE:
{style_keywords}

STRICT REQUIREMENTS:
- Single character only (no other people)
- Clean, neutral backgrounds in both panels
- High quality, detailed rendering
- No text, watermarks, or labels
- This is a CHARACTER REFERENCE SHEET for video production

MUST AVOID:
{negative_keywords}
- Do NOT show different people in the two panels
- Do NOT add busy backgrounds
- Do NOT include multiple characters
"""

            # Save the prompt to a file (for auditing)
            if output_dir:
                if project_dir:
                    prompts_dir = Path(project_dir) / "prompts" / "characters"
                else:
                    prompts_dir = Path(output_dir).parent.parent.parent / "prompts" / "characters"
                prompts_dir.mkdir(parents=True, exist_ok=True)
                prompt_file = prompts_dir / f"{character_name}_composite.prompt.txt"
                prompt_file.write_text(prompt, encoding="utf-8")
                print(f"[NanoBanana Character] Composite Prompt saved: {prompt_file}")

            # Generate the composite image (using the 16:9 wide ratio)
            composite_path = (
                os.path.join(output_dir, "reference_composite.png") if output_dir else None
            )

            image_bytes = await self._generate_single_image(
                client=client,
                prompt=prompt,
                output_path=composite_path,
                aspect_ratio="16:9",
                image_size="1K",
            )
            if not image_bytes:
                return CharacterReferenceResult(
                    success=False,
                    character_name=character_name,
                    error="API returned no image data",
                    generation_time=time.time() - start_time,
                )

            generation_time = time.time() - start_time
            print(
                f"[NanoBanana Character] Composite reference image generated: {composite_path}, took {generation_time:.1f}s"
            )

            return CharacterReferenceResult(
                success=True,
                character_name=character_name,
                reference_paths=[composite_path] if composite_path else [],
                primary_reference=composite_path or "",
                generation_time=generation_time,
            )

        except ImportError:
            return CharacterReferenceResult(
                success=False,
                character_name=character_name,
                error="Please install google-genai: pip install google-genai",
                generation_time=time.time() - start_time,
            )
        except Exception as e:
            return CharacterReferenceResult(
                success=False,
                character_name=character_name,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    def _generate_character_tag(self, character_name: str) -> str:
        """Generate a unique tag from the character name.

        Uses the full character name + a hash of the full name to ensure uniqueness and readability.

        Args:
            character_name: full character name

        Returns:
            Tag, e.g. '[Narrator_a1b2]', '[NarratorMother_0305]'
        """
        import hashlib

        # Use the last 4 characters of the full-name hash as the unique suffix
        name_hash = hashlib.md5(character_name.encode("utf-8")).hexdigest()[:4]

        # Use the full character name so long names are not truncated
        return f"[{character_name}_{name_hash}]"

    @classmethod
    def _animation_medium_phrase(
        cls,
        style_name: Optional[str],
        project_dir: str = "",
        state_dir: str = "",
    ) -> str:
        _, subtype = StyleService.get_style_branch(
            style_name or IMAGE_DEFAULT_STYLE,
            project_dir=project_dir or None,
            state_dir=state_dir or None,
        )
        if subtype == "3d":
            return "stylized 3D animated character rendering"
        if subtype == "hybrid":
            return "stylized hybrid mixed-media animated character rendering"
        return "stylized 2D animated character rendering"

    def _build_character_prompt(
        self,
        character_name: str,
        character_prompt: str,
        character_tag: str,
        style_name: str,
        project_dir: str,
        style_keywords: str,
        negative_keywords: str,
        state_dir: str = "",
        ethnicity: str = "Chinese",
    ) -> str:
        """Build the portrait generation prompt.

        Args:
            character_name: character name
            character_prompt: character appearance description
            character_tag: unique character tag
            style_keywords: style keywords
            negative_keywords: negative keywords
            ethnicity: character ethnicity (default "Chinese")

        Returns:
            Complete generation prompt
        """
        family, _ = StyleService.get_style_branch(
            style_name or IMAGE_DEFAULT_STYLE,
            project_dir=project_dir or None,
            state_dir=state_dir or None,
        )
        if family == "animation":
            medium = self._animation_medium_phrase(
                style_name,
                project_dir=project_dir,
                state_dir=state_dir,
            )
            prompt = f"""Generate a face-only animated character identity portrait for production reference.

CHARACTER: {character_tag} ({character_name})

DEFAULT ETHNICITY (FALLBACK ONLY):
{_default_ethnicity_instruction(ethnicity)}

FRAMING & PRESENTATION (CRITICAL):
- PERFECT FRONT-FACING head-and-shoulders portrait, symmetrical composition
- Face fills 60-70% of frame
- Neutral expression, mouth closed
- Plain solid neutral background only
- Minimal visible clothing; keep attention on face, hair silhouette, and head shape
- This is a clean animation identity anchor, not a photographic actor portrait

FACIAL FEATURES TO CAPTURE (from character description):
{character_prompt}

VISUAL STYLE:
{style_keywords}

STRICT REQUIREMENTS:
- Final medium must be {medium}
- Preserve exact face shape, eye shape, nose, mouth, hairline, and silhouette
- Keep shape language and graphic readability consistent
- High-quality production reference image

MUST AVOID:
{negative_keywords}
- Do not turn the face away from camera
- Do not include elaborate costume staging or environment
- Do not add text, labels, watermarks, or signatures
- Do not include multiple characters
- Do not convert this into realistic photography or real-human actor rendering
"""
            return prompt.strip()

        prompt = f"""Generate a face-only character identity reference portrait for identity locking.

CHARACTER: {character_tag} ({character_name})

DEFAULT ETHNICITY (FALLBACK ONLY):
{_default_ethnicity_instruction(ethnicity)}

FRAMING & CAMERA (CRITICAL):
- FRONT-FACING: subject facing camera DIRECTLY, looking STRAIGHT at camera, symmetrical composition
- Head-and-shoulders close-up, face fills 60-70% of the frame
- Neutral expression, mouth closed
- Solid matte gray seamless studio background — NO environment, NO scenery, NO props
- Plain simple dark top (like a basic t-shirt), MINIMAL clothing visible
- Do NOT show elaborate costumes, accessories, or period clothing
- This should follow the project visual style while remaining clear enough for identity locking.

FACIAL FEATURES TO CAPTURE (from character description):
{character_prompt}

VISUAL STYLE:
{style_keywords}

STRICT REQUIREMENTS:
- This is a CHARACTER IDENTITY ANCHOR — face must be perfectly front-facing and clearly visible
- High-quality, 4K resolution
- Maintain strict facial fidelity to the character description
- Keep facial structure, hairstyle, skin tone, and expression readable for downstream identity matching

MUST AVOID:
{negative_keywords}
- Do NOT turn the face to any side — must be perfectly FRONTAL
- Do not include elaborate clothing or costumes
- Do not show full body or lower body
- Do NOT add ANY background: no rooms, no scenery, no furniture, no props — plain solid color only
- Do not add text, watermarks, or signatures
- Do not include multiple characters
- Do NOT create beauty-filter skin, glamor retouching, fashion-magazine polish, doll-like skin, or cosmetic-ad aesthetics
"""
        return prompt.strip()

    @staticmethod
    def _costume_reference_block(has_costume_reference: bool) -> str:
        """Return the costume reference instruction block if applicable."""
        if not has_costume_reference:
            return ""
        return """
COSTUME REFERENCE IMAGE (CRITICAL):
A second reference image is provided showing the target costume/clothing.
- MATCH the clothing, fabric, accessories, colors, and styling from the costume reference image EXACTLY
- The costume reference takes PRIORITY over the text description for visual details
- Combine the FACE from the identity anchor (first reference) with the CLOTHING from the costume reference (second reference)
"""

    def _build_identity_locked_prompt(
        self,
        character_name: str,
        character_prompt: str,
        character_tag: str,
        target_view: str,
        style_name: str,
        project_dir: str,
        style_keywords: str,
        negative_keywords: str,
        state_dir: str = "",
        ethnicity: str = "Chinese",
        has_costume_reference: bool = False,
    ) -> str:
        """Build the 4-panel reference sheet prompt (full face close-up + front full body + 45-degree three-quarter full body + back full body).

        Uses the reference image as the identity anchor to generate, in one pass, a sheet containing a face close-up, front full body, three-quarter full body, and back full body,
        with zero stitching and natural consistency.

        Args:
            character_name: character name
            character_prompt: character appearance description
            character_tag: unique character tag
            target_view: target view
            style_keywords: style keywords
            negative_keywords: negative keywords
            ethnicity: character ethnicity (default "Chinese")
            full_body: whether to generate a full-body shot (default True)

        Returns:
            4-panel reference sheet Prompt
        """
        family, _ = StyleService.get_style_branch(
            style_name or IMAGE_DEFAULT_STYLE,
            project_dir=project_dir or None,
            state_dir=state_dir or None,
        )
        if family == "animation":
            medium = self._animation_medium_phrase(
                style_name,
                project_dir=project_dir,
                state_dir=state_dir,
            )
            prompt = f"""Animated character turnaround / identity sheet. Neutral presentation setup.
PLAIN SOLID WHITE or LIGHT GRAY background ONLY — no environment, no scenery, no props. {style_keywords}

Using the reference image as IDENTITY ANCHOR for {character_tag} ({character_name}),
create a 4-panel animated character reference sheet arranged LEFT to RIGHT:

- Panel 1 (LEFT): FACE CLOSEUP — head and shoulders, filling the panel
- Panel 2 (CENTER-LEFT): FRONT full body — head to feet, standing pose, facing camera
- Panel 3 (CENTER-RIGHT): THREE-QUARTER VIEW full body — head to feet, body rotated about 45 degrees
- Panel 4 (RIGHT): BACK VIEW full body — head to feet, facing away from camera

IDENTITY LOCKING (CRITICAL):
Preserve the same character identity EXACTLY from the reference image:
- face shape and proportions
- eye shape and spacing
- nose and mouth shape
- hairline, hairstyle, and silhouette
- skin tone and age impression
- Preserve the reference identity exactly; do not change face structure, skin tone, hair identity, or silhouette.

CHARACTER DETAILS (CRITICAL - use this for clothing and appearance):
{character_prompt}
{self._costume_reference_block(has_costume_reference)}

PRESENTATION RULES:
- Final medium must be {medium}
- All 4 panels must keep the same character, same outfit, same hair, same proportions
- Panel 1 must visually match Panel 2's head area
- Panels 2-4 must show a complete figure from head to feet
- Plain neutral production-reference background only

STRICT REQUIREMENTS (MUST AVOID):
{negative_keywords}
- Do not allow facial feature drift from reference
- Do not mix rendering families or switch back to realistic actor rendering
- Do not include multiple characters
- No text, labels, or panel numbers on the image
- Do not add environment scenery, props, or poster composition
"""
            return prompt.strip()

        prompt = f"""Character identity reference sheet. Neutral studio setup.
PLAIN SOLID WHITE or LIGHT GRAY background ONLY — no environment, no scenery, no props. {style_keywords}

Using the reference image as IDENTITY ANCHOR for {character_tag} ({character_name}),
create a 4-panel character reference sheet arranged LEFT to RIGHT:

- Panel 1 (LEFT): FACE CLOSEUP — head and shoulders, filling the panel. This is a zoomed-in crop of Panel 2's head: SAME hairstyle, SAME visible clothing (neckline, collar, shoulders)
- Panel 2 (CENTER-LEFT): FRONT full body — head to feet, standing pose, facing camera
- Panel 3 (CENTER-RIGHT): THREE-QUARTER VIEW full body — head to feet, body rotated approximately 45 degrees from the left, both eyes still visible, standing pose
- Panel 4 (RIGHT): BACK VIEW full body — head to feet, facing away from camera, showing back of head and body

IDENTITY LOCKING (CRITICAL):
Preserve the facial structure, facial proportions, and overall likeness
of {character_tag} EXACTLY as in the reference image, allowing NO alteration,
stylization, or reinterpretation of the face under any circumstance.

MUST PRESERVE (from reference):
- Facial structure and bone structure
- Eye shape, size, spacing, color
- Nose shape and size
- Lip shape and fullness
- Skin tone
- Hair color, style, texture
- Preserve the reference identity exactly; do not change face structure, skin tone, hair identity, or silhouette.

DO NOT PRESERVE FROM REFERENCE:
- Beauty-filter smoothing or retouching
- Plastic / waxy / overly perfect skin treatment
- Any rendering finish that conflicts with the selected project style preset
- The final rendering medium should follow the project style preset, not the reference image

CHARACTER DETAILS (CRITICAL - use this for clothing and appearance):
{character_prompt}
{self._costume_reference_block(has_costume_reference)}
BACKGROUND (CRITICAL — STRICTLY ENFORCED):
- ALL 4 panels MUST have a PLAIN SOLID-COLOR background (white, light gray, or soft neutral gradient)
- Do NOT render ANY environment: no rooms, no furniture, no walls, no floors, no scenery
- This is a production character identity reference sheet, not a fashion catalog, not a glossy poster

FULL BODY FRAMING (Panels 2-4):
- MUST show COMPLETE figure from top of head to bottom of feet including shoes
- Standing in neutral pose on a visible ground line
- Ample space above head and below feet
- Do NOT crop any body part

CONSISTENCY:
- ALL 4 panels = SAME person, SAME outfit, SAME hair
- Panel 1 is a ZOOMED-IN CROP of Panel 2's head area — hairstyle, neckline, collar, and shoulder clothing MUST be identical
- Panel 1 face MUST match Panels 2-3 face exactly
- Panel 4 shows the SAME person from behind — SAME hair, SAME outfit, SAME body proportions
- Only viewing angle changes between Panel 2 (front), Panel 3 (three-quarter), and Panel 4 (back)

STRICT REQUIREMENTS (MUST AVOID):
{negative_keywords}
- Do not allow ANY facial feature drift from reference.
- Do not mix styles or reinterpret the character.
- Do not include multiple characters.
- No text, labels, or panel numbers on the image
- Do NOT create beauty-retouched, glamorized, cosmetic-ad, or fashion-editorial output
- Keep the project style consistent across all 4 panels
"""
        return prompt.strip()

    async def _generate_single_image(
        self,
        client,
        prompt: str,
        output_path: Optional[str] = None,
        aspect_ratio: str = "3:4",
        image_size: str = "1K",
    ) -> Optional[bytes]:
        """Generate a single image (no reference image).

        Args:
            client: Google AI client (may be None in OpenRouter mode)
            prompt: generation prompt
            output_path: output path
            aspect_ratio: image aspect ratio (default "3:4")
            image_size: image size (default "1K")

        Returns:
            Image byte data; None on failure
        """
        image_size = self.force_image_size or image_size
        if self.egress_context is not None and self.egress_context.is_organization:
            if not output_path:
                raise ValueError("organization character image requires an output path")
            await generate_text_to_image(
                prompt=prompt,
                output_path=output_path,
                aspect_ratio=aspect_ratio,
                image_size=image_size,
                config={
                    "provider": "newapi",
                    "api_key": "request-scoped",
                    "base_url": "https://request-scoped.invalid/v1",
                    "model": self.model,
                    "mode": "1x1",
                    "rows": 1,
                    "cols": 1,
                    "total_panels": 1,
                },
                egress_context=self.egress_context,
                egress_capability="image.asset.character",
            )
            return Path(output_path).read_bytes()

        try:
            image_bytes = None

            if self.provider == "openrouter":
                # OpenRouter mode
                print(f"[NanoBanana Character] Calling OpenRouter ({self.model}) to generate image...")
                openrouter_image_config = {
                    "aspect_ratio": aspect_ratio,
                    "image_size": normalize_image_size(image_size, provider="openrouter"),
                }
                result = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    image_config=openrouter_image_config,
                )
                print(
                    f"[NanoBanana Character] _generate_single_image OpenRouter returned type: {type(result)}, value: {str(result)[:200]}"
                )
                if isinstance(result, tuple):
                    image_bytes, _text_response, error_detail = result
                    if not image_bytes and error_detail:
                        print(f"[NanoBanana Character] OpenRouter failure details: {error_detail}")
                        raise RuntimeError(error_detail)
                else:
                    image_bytes = result
            elif self.provider == "huimeng":
                print(f"[NanoBanana Character] Calling HuiMeng ({self.model}) to generate image...")
                image_bytes, _text_response, error_detail = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                    },
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] HuiMeng failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "openai":
                print(f"[NanoBanana Character] Calling OpenAI Image API ({self.model}) to generate image...")
                image_bytes, _text_response, error_detail = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "quality": normalize_openai_quality(
                            self.openai_image_quality, default="medium"
                        ),
                        "output_format": "png",
                    },
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] OpenAI failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "newapi":
                print(f"[NanoBanana Character] Calling DramaClawAPI ({self.model}) to generate image...")
                image_bytes, _text_response, error_detail = await _call_newapi_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "quality": normalize_openai_quality(
                            self.openai_image_quality, default="medium"
                        ),
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] DramaClawAPI failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "gemini_webai":
                print(f"[NanoBanana Character] Calling Gemini WebAI ({self.model}) to generate image...")
                image_bytes, _text_response, error_detail = await _call_webai_chat_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    base_url=self.base_url,
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] Gemini WebAI failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "qwen":
                print(f"[NanoBanana Character] Calling Qwen Image ({self.model}) to generate image...")
                image_bytes, _text_response, error_detail = await _call_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                    },
                    base_url=self.base_url,
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] Qwen Image failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "runpod_qwen":
                print(f"[NanoBanana Character] Calling RunPod Qwen Image 2.1 to generate image...")
                image_bytes, _text_response, error_detail = await _call_runpod_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                    },
                    base_url=self.base_url,
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] RunPod Qwen Image failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            else:
                # Google direct mode
                from google.genai import types

                # gemini-3 supports image_size; gemini-2.5 does not
                is_gemini3 = "gemini-3" in self.model
                if is_gemini3:
                    image_config = types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                        image_size=normalize_image_size(image_size, provider="google"),
                    )
                else:
                    image_config = types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                    )

                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE", "TEXT"],
                        image_config=image_config,
                    ),
                )

                # Extract the image data
                if not response.candidates:
                    print(f"[NanoBanana Character] API response has no candidates: {response}")
                    return None

                candidate = response.candidates[0]
                if not candidate.content:
                    finish_reason = getattr(candidate, "finish_reason", "unknown")
                    print(
                        f"[NanoBanana Character] API response has no content, finish_reason={finish_reason}"
                    )
                    if hasattr(candidate, "safety_ratings") and candidate.safety_ratings:
                        for rating in candidate.safety_ratings:
                            print(f"[NanoBanana Character] safety_rating: {rating}")
                    return None

                if not candidate.content.parts:
                    print(
                        f"[NanoBanana Character] API response content.parts is empty: {candidate.content}"
                    )
                    return None

                for part in candidate.content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        image_bytes = part.inline_data.data
                        break
                    # Print the text response (if any)
                    if hasattr(part, "text") and part.text:
                        print(f"[NanoBanana Character] API text response: {part.text[:300]}")

            if not image_bytes:
                print(f"[NanoBanana Character] API returned no image data")
                return None

            # Save the file
            if output_path:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                if not (self.provider == "newapi" and image_delivery_state.get("copied")):
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)

            return image_bytes

        except Exception as e:
            if is_fatal_billing_error(e):
                raise
            if isinstance(e, RuntimeError):
                raise
            print(f"[NanoBanana Character] Generation failed: {e}")
            return None

    async def _generate_with_reference(
        self,
        client,
        prompt: str,
        reference_image,
        output_path: Optional[str] = None,
        reference_image_bytes: bytes = None,  # OpenRouter mode needs the raw bytes
        reference_image_name: str = "",
        aspect_ratio: str = "3:4",
        image_size: str = "1K",
        additional_images: list = None,  # list of extra reference image Part objects (Google mode)
        additional_image_bytes: list = None,  # list of extra reference image bytes (OpenRouter mode)
        additional_image_names: list[str] = None,
    ) -> Optional[bytes]:
        """Generate an image using a reference image (Identity Locking).

        Args:
            client: Google AI client (may be None in OpenRouter mode)
            prompt: generation prompt
            reference_image: reference image Part object (used in Google mode)
            output_path: output path
            reference_image_bytes: raw bytes of the reference image (used in OpenRouter mode)
            reference_image_name: reference image filename or path (used by OpenAI/newAPI to keep the extension/MIME)
            aspect_ratio: image aspect ratio (default "3:4")
            image_size: image size (default "1K")

        Returns:
            Image byte data; None on failure
        """
        image_size = self.force_image_size or image_size

        if self.egress_context is not None and self.egress_context.is_organization:
            if not output_path:
                raise ValueError("organization identity image requires an output path")
            with tempfile.TemporaryDirectory(prefix="dramaclaw-image-ref-") as temp_dir:
                reference_paths: list[str] = []
                for index, data in enumerate(
                    [reference_image_bytes, *(additional_image_bytes or [])]
                ):
                    if data:
                        path = Path(temp_dir) / f"reference-{index}.png"
                        path.write_bytes(data)
                        reference_paths.append(str(path))
                await generate_reference_edit_image(
                    prompt=prompt,
                    reference_images=reference_paths,
                    output_path=output_path,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                    config={
                        "provider": "newapi",
                        "api_key": "request-scoped",
                        "base_url": "https://request-scoped.invalid/v1",
                        "model": self.model,
                        "mode": "1x1",
                        "rows": 1,
                        "cols": 1,
                        "total_panels": 1,
                    },
                    egress_context=self.egress_context,
                    egress_capability="image.asset.character",
                )
            return Path(output_path).read_bytes()

        def _named_image_ref(data: bytes, name: str) -> tuple[str, bytes, str]:
            filename = Path(str(name or "")).name or "reference.png"
            mime_type = mimetypes.guess_type(filename)[0] or "image/png"
            if not mime_type.startswith("image/"):
                mime_type = "image/png"
            return filename, data, mime_type

        try:
            image_bytes = None

            if self.provider == "openrouter":
                # OpenRouter mode
                print(
                    f"[NanoBanana Character] Calling OpenRouter ({self.model}) to generate image (with reference image)..."
                )
                openrouter_image_config = {
                    "aspect_ratio": aspect_ratio,
                    "image_size": normalize_image_size(image_size, provider="openrouter"),
                }
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(reference_image_bytes)
                if additional_image_bytes:
                    ref_images.extend(additional_image_bytes)
                ref_images = ref_images if ref_images else None
                result = await _call_openrouter_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images,
                    image_config=openrouter_image_config,
                )
                print(
                    f"[NanoBanana Character] _generate_with_reference OpenRouter returned type: {type(result)}, value: {str(result)[:200]}"
                )
                if isinstance(result, tuple):
                    image_bytes, _text_response, error_detail = result
                    if not image_bytes and error_detail:
                        print(f"[NanoBanana Character] OpenRouter failure details: {error_detail}")
                        raise RuntimeError(error_detail)
                else:
                    image_bytes = result
            elif self.provider == "huimeng":
                print(f"[NanoBanana Character] Calling HuiMeng ({self.model}) to generate image (with reference image)...")
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(reference_image_bytes)
                if additional_image_bytes:
                    ref_images.extend(additional_image_bytes)
                image_bytes, _text_response, error_detail = await _call_huimeng_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                    },
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] HuiMeng failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "openai":
                print(
                    f"[NanoBanana Character] Calling OpenAI Image API ({self.model}) to generate image (with reference image)..."
                )
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(_named_image_ref(reference_image_bytes, reference_image_name))
                if additional_image_bytes:
                    additional_names = list(additional_image_names or [])
                    for idx, image_bytes_item in enumerate(additional_image_bytes):
                        ref_images.append(
                            _named_image_ref(
                                image_bytes_item,
                                additional_names[idx] if idx < len(additional_names) else "",
                            )
                        )
                image_bytes, _text_response, error_detail = await _call_openai_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "quality": normalize_openai_quality(
                            self.openai_image_quality, default="medium"
                        ),
                        "output_format": "png",
                    },
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] OpenAI failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "newapi":
                print(f"[NanoBanana Character] Calling DramaClawAPI ({self.model}) to generate image (with reference image)...")
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(_named_image_ref(reference_image_bytes, reference_image_name))
                if additional_image_bytes:
                    additional_names = list(additional_image_names or [])
                    for idx, image_bytes_item in enumerate(additional_image_bytes):
                        ref_images.append(
                            _named_image_ref(
                                image_bytes_item,
                                additional_names[idx] if idx < len(additional_names) else "",
                            )
                        )
                image_bytes, _text_response, error_detail = await _call_newapi_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                        "quality": normalize_openai_quality(
                            self.openai_image_quality, default="medium"
                        ),
                    },
                    base_url=self.base_url,
                    delivery_path=output_path,
                    delivery_state=(image_delivery_state := {}),
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] DramaClawAPI failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "gemini_webai":
                print(
                    f"[NanoBanana Character] Calling Gemini WebAI ({self.model}) to generate image (with reference image)..."
                )
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(_named_image_ref(reference_image_bytes, reference_image_name))
                if additional_image_bytes:
                    additional_names = list(additional_image_names or [])
                    for idx, image_bytes_item in enumerate(additional_image_bytes):
                        ref_images.append(
                            _named_image_ref(
                                image_bytes_item,
                                additional_names[idx] if idx < len(additional_names) else "",
                            )
                        )
                image_bytes, _text_response, error_detail = await _call_webai_chat_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images or None,
                    base_url=self.base_url,
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] Gemini WebAI failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "qwen":
                print(
                    f"[NanoBanana Character] Calling Qwen Image ({self.model}) to generate image (with reference image)..."
                )
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(_named_image_ref(reference_image_bytes, reference_image_name))
                if additional_image_bytes:
                    additional_names = list(additional_image_names or [])
                    for idx, image_bytes_item in enumerate(additional_image_bytes):
                        ref_images.append(
                            _named_image_ref(
                                image_bytes_item,
                                additional_names[idx] if idx < len(additional_names) else "",
                            )
                        )
                image_bytes, _text_response, error_detail = await _call_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                    },
                    base_url=self.base_url,
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] Qwen Image failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            elif self.provider == "runpod_qwen":
                print(
                    f"[NanoBanana Character] Calling RunPod Qwen Image 2.1 to generate image (with reference image)..."
                )
                ref_images = []
                if reference_image_bytes:
                    ref_images.append(_named_image_ref(reference_image_bytes, reference_image_name))
                if additional_image_bytes:
                    additional_names = list(additional_image_names or [])
                    for idx, image_bytes_item in enumerate(additional_image_bytes):
                        ref_images.append(
                            _named_image_ref(
                                image_bytes_item,
                                additional_names[idx] if idx < len(additional_names) else "",
                            )
                        )
                image_bytes, _text_response, error_detail = await _call_runpod_qwen_image_api(
                    api_key=self.api_key,
                    model=self.model,
                    prompt=prompt,
                    reference_images=ref_images or None,
                    image_config={
                        "aspect_ratio": aspect_ratio,
                        "image_size": image_size,
                    },
                    base_url=self.base_url,
                )
                if not image_bytes and error_detail:
                    print(f"[NanoBanana Character] RunPod Qwen Image failure details: {error_detail}")
                    raise RuntimeError(error_detail)
            else:
                # Google direct mode
                from google.genai import types

                # Always text first, then images, consistent with the official Google examples and the other generation chains
                contents = [prompt]
                if reference_image:
                    contents.append(reference_image)
                if additional_images:
                    contents.extend(additional_images)

                # gemini-3 supports image_size; gemini-2.5 does not
                is_gemini3 = "gemini-3" in self.model
                if is_gemini3:
                    image_config = types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                        image_size=normalize_image_size(image_size, provider="google"),
                    )
                else:
                    image_config = types.ImageConfig(
                        aspect_ratio=aspect_ratio,
                    )

                response = await asyncio.to_thread(
                    client.models.generate_content,
                    model=self.model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE", "TEXT"],
                        image_config=image_config,
                    ),
                )

                # Extract the image data
                if not response.candidates:
                    print(f"[NanoBanana Character] API response has no candidates: {response}")
                    return None

                candidate = response.candidates[0]
                if not candidate.content:
                    finish_reason = getattr(candidate, "finish_reason", "unknown")
                    print(
                        f"[NanoBanana Character] API response has no content, finish_reason={finish_reason}"
                    )
                    if hasattr(candidate, "safety_ratings") and candidate.safety_ratings:
                        for rating in candidate.safety_ratings:
                            print(f"[NanoBanana Character] safety_rating: {rating}")
                    return None

                if not candidate.content.parts:
                    print(
                        f"[NanoBanana Character] API response content.parts is empty: {candidate.content}"
                    )
                    return None

                for part in candidate.content.parts:
                    if hasattr(part, "inline_data") and part.inline_data:
                        image_bytes = part.inline_data.data
                        break
                    # Print the text response (if any)
                    if hasattr(part, "text") and part.text:
                        print(f"[NanoBanana Character] API text response: {part.text[:300]}")

            if not image_bytes:
                print(f"[NanoBanana Character] API returned no image data")
                return None

            # Save the file
            if output_path:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                if not (self.provider == "newapi" and image_delivery_state.get("copied")):
                    with open(output_path, "wb") as f:
                        f.write(image_bytes)

            return image_bytes

        except Exception as e:
            if is_fatal_billing_error(e):
                raise
            if isinstance(e, RuntimeError):
                raise
            print(f"[NanoBanana Character] Generation failed: {e}")
            return None

    def _load_image_as_part(self, image_path: str, compress_quality: int = 60):
        """Load an image as a Gemini API Part (with JPEG compression).

        Args:
            image_path: image path
            compress_quality: JPEG compression quality (1-100); set to 0 or None to disable compression

        Returns:
            Gemini Part object
        """
        try:
            from PIL import Image
            import io

            # Load the image
            img = Image.open(image_path)
            original_size = os.path.getsize(image_path)

            # Compress to JPEG (if enabled)
            if compress_quality and compress_quality > 0:
                # Convert to RGB (JPEG does not support alpha)
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")

                # Compress into memory
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=compress_quality, optimize=True)
                image_data = buffer.getvalue()
                mime_type = "image/jpeg"

                compressed_size = len(image_data)
                ratio = (1 - compressed_size / original_size) * 100
                print(
                    f"[compress] {os.path.basename(image_path)}: "
                    f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
                    f"({ratio:.0f}% compression)"
                )
            else:
                # No compression; read the original file directly
                with open(image_path, "rb") as f:
                    image_data = f.read()

                if image_path.lower().endswith(".png"):
                    mime_type = "image/png"
                elif image_path.lower().endswith(".webp"):
                    mime_type = "image/webp"
                else:
                    mime_type = "image/jpeg"

            if self.provider != "google":
                return _InlineImagePart(image_data, mime_type)

            from google.genai import types

            return types.Part.from_bytes(data=image_data, mime_type=mime_type)

        except Exception as e:
            print(f"[NanoBanana Character] Failed to load reference image: {image_path}, {e}")
            return None


def create_character_generator(api_key: Optional[str] = None) -> NanoBananaCharacterGenerator:
    """Create a character generator.

    Args:
        api_key: Google AI API Key

    Returns:
        NanoBananaCharacterGenerator instance
    """
    return NanoBananaCharacterGenerator(api_key=api_key)
