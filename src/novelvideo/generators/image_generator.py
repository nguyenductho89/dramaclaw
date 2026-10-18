"""Volcengine image generation module.

Uses Seedream 4.0 to generate images and SeedEdit 3.0 to edit them.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
from datetime import datetime
from typing import Any, Optional
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field

from novelvideo.config import (
    IMAGE_GENERATION_SELECTIONS,
    get_character_image_selection,
    get_image_config,
    get_style_preset,
    normalize_character_image_selection,
)
from novelvideo.ports import get_usage_meter
from novelvideo.shared.billing_errors import (
    is_fatal_billing_error,
    is_insufficient_credits_error,
)


def _provider_request_id_from_response(response: httpx.Response, result: dict[str, Any]) -> str:
    return (
        response.headers.get("x-request-id")
        or response.headers.get("x-newapi-request-id")
        or response.headers.get("x-oneapi-request-id")
        or str(result.get("request_id") or result.get("requestId") or "").strip()
    )


async def _reserve_image_model_call(
    model: str,
    *,
    source: str,
    billing_params: Optional[dict[str, Any]] = None,
    billing_quantity: int | float | str | None = 1,
) -> str:
    return await get_usage_meter().reserve_current_model_call_credit(
        model=model,
        billing_kind="image",
        billing_params=billing_params,
        billing_quantity=billing_quantity,
        metadata={"source": source},
    )


async def _refund_image_model_call(
    reservation_id: str,
    *,
    source: str,
    error: str,
) -> None:
    try:
        await get_usage_meter().refund_model_call_credit_reservation(
            reservation_id,
            metadata={"source": source, "error": error[:200]},
        )
    except Exception:
        pass


async def _confirm_image_model_call(
    *,
    model: str,
    reservation_id: str,
    provider_request_id: str = "",
    response_id: str = "",
) -> None:
    try:
        await get_usage_meter().bump_model_call(
            user_id=None,
            model=model,
            provider_request_id=provider_request_id,
            credit_reservation_id=reservation_id,
            metadata={"response_id": response_id} if response_id else None,
        )
    except Exception:
        pass


async def _mark_image_model_call_accepted(
    *,
    provider_request_id: str = "",
    response_id: str = "",
) -> None:
    try:
        await get_usage_meter().mark_current_paid_execution_attempt(
            status="accepted",
            provider_request_id=provider_request_id,
            provider_response_id=response_id,
        )
    except Exception:
        pass


class ImageGenParams(BaseModel):
    """Image generation parameters (legacy, kept for compatibility)."""

    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1024
    style: str = "chinese_period_drama"  # default: photoreal period-drama style
    project_dir: str = ""  # project directory, used to read project-level custom styles

    # Reference image (for character consistency)
    reference_image: Optional[str] = None
    reference_strength: float = 0.7  # follows industry best practice 70-85%

    # Other parameters
    seed: Optional[int] = None
    steps: int = 30
    cfg_scale: float = 7.0


class ImageGenerationRequest(BaseModel):
    """Image generation request (supports multiple reference images).

    Adapted to the Jimeng 4.0 API; supports up to 10 reference images.
    """

    prompt: str = Field(description="Prompt text")
    negative_prompt: str = Field(default="", description="Negative prompt")
    width: int = Field(default=720, description="Image width")
    height: int = Field(default=1280, description="Image height (portrait)")

    # Multi-reference-image support (up to 10)
    reference_images: list[str] = Field(
        default_factory=list,
        description="List of reference image paths (up to 10)",
    )
    reference_prompts: list[str] = Field(
        default_factory=list,
        description="Character description for each reference image (one-to-one with reference_images)",
    )
    reference_scale: float = Field(
        default=0.7,  # follows industry best practice 70-85%
        ge=0,
        le=1,
        description="Reference image weight 0-1",
    )

    # Previous frame (for continuity)
    previous_frame: Optional[str] = Field(
        default=None,
        description="Previous frame image path (for frame-to-frame continuity)",
    )

    # Other parameters
    seed: Optional[int] = None

    # Prompt control
    skip_prompt_enhancement: bool = Field(
        default=False,
        description="Skip prompt enhancement and use the passed prompt as-is",
    )

    # Sketch render mode flag
    is_sketch_render: bool = Field(
        default=False,
        description="Whether this is sketch render mode (adjusts negative_prompt, removing sketch-related words to avoid semantic conflicts)",
    )


class ImageGenResult(BaseModel):
    """Image generation result."""

    success: bool
    image_path: Optional[str] = None
    image_base64: Optional[str] = None
    error: Optional[str] = None
    generation_time: float = 0.0


class VolcengineImageGenerator:
    """Volcengine image generator.

    Wraps the Seedream 4.0 and SeedEdit 3.0 APIs.

    Example:
        >>> generator = VolcengineImageGenerator()
        >>> result = await generator.generate(
        ...     prompt="anime girl with black hair",
        ...     output_path="output/image.png"
        ... )
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
    ):
        """Initialize the generator.

        Args:
            api_key: API Key; read from the environment by default
            endpoint: API endpoint; read from the config by default
        """
        config = get_image_config()
        self.api_key = api_key or config["api_key"]
        self.endpoint = endpoint or config["endpoint"]
        self.seedream_model = config["seedream_model"]
        self.seededit_model = config["seededit_model"]
        self.default_width = config["default_width"]
        self.default_height = config["default_height"]
        self.default_style = config["default_style"]

        if not self.api_key:
            raise ValueError(
                "API key not set. "
                "Set VOLCENGINE_VISUAL_API_KEY or ARK_API_KEY environment variable."
            )

    def _compress_image(
        self,
        image_path: str,
        quality: int = 60,
        max_size: tuple = None,
    ) -> tuple[str, str]:
        """Compress a reference image and return base64 and mime_type.

        Args:
            image_path: image path
            quality: JPEG compression quality (1-100)
            max_size: optional maximum size limit (width, height)

        Returns:
            (base64_data, mime_type)
        """
        from PIL import Image
        import io

        img = Image.open(image_path)
        original_size = os.path.getsize(image_path)

        # Optional: scale down to the maximum size
        if max_size:
            img.thumbnail(max_size, Image.Resampling.LANCZOS)

        # Convert to RGB (JPEG does not support alpha)
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')

        # Compress into memory
        buffer = io.BytesIO()
        img.save(buffer, format='JPEG', quality=quality, optimize=True)
        image_data = buffer.getvalue()

        compressed_size = len(image_data)
        ratio = (1 - compressed_size / original_size) * 100
        print(f"[Seedream compress] {os.path.basename(image_path)}: "
              f"{original_size/1024:.0f}KB → {compressed_size/1024:.0f}KB "
              f"({ratio:.0f}% compression)", flush=True)

        return base64.b64encode(image_data).decode(), "image/jpeg"

    async def generate(
        self,
        prompt: str,
        output_path: Optional[str] = None,
        negative_prompt: str = "",
        width: Optional[int] = None,
        height: Optional[int] = None,
        style: Optional[str] = None,
        project_dir: str = "",
        reference_image: Optional[str] = None,
        reference_strength: float = 0.7,  # follows industry best practice 70-85%
        egress_context=None,
    ) -> ImageGenResult:
        """Generate an image.

        Args:
            prompt: positive prompt
            output_path: output path; the file is saved if provided
            negative_prompt: negative prompt
            width: width
            height: height
            style: style
            reference_image: reference image path (for character consistency)
            reference_strength: reference image strength

        Returns:
            Generation result
        """
        if egress_context is None:
            from novelvideo.egress_context import (
                ambient_organization_egress_context,
            )

            egress_context = ambient_organization_egress_context()
        if egress_context is not None:
            from novelvideo.egress_context import TrustedEgressContext
            from novelvideo.ports.egress import EgressError

            if type(egress_context) is not TrustedEgressContext:
                raise TypeError("egress_context must be a TrustedEgressContext")
            if egress_context.is_organization:
                raise EgressError("ORG_EGRESS_DENIED")

        start_time = time.time()

        params = ImageGenParams(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width or self.default_width,
            height=height or self.default_height,
            style=style or self.default_style,
            project_dir=project_dir,
            reference_image=reference_image,
            reference_strength=reference_strength,
        )

        try:
            # Call the API
            image_base64 = await self._call_seedream_api(params)

            # Save the file
            if output_path and image_base64:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(image_base64))

            generation_time = time.time() - start_time

            return ImageGenResult(
                success=True,
                image_path=output_path,
                image_base64=image_base64,
                generation_time=generation_time,
            )

        except Exception as e:
            if is_fatal_billing_error(e):
                raise
            return ImageGenResult(
                success=False,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def _call_seedream_api(self, params: ImageGenParams) -> str:
        """Call the Volcengine Ark Seedream API.

        API docs: https://www.volcengine.com/docs/82379/1541523
        """
        # Get the style preset
        style_preset = get_style_preset(params.style, project_dir=params.project_dir)

        # Enhance the prompt: prepend style keywords
        enhanced_prompt = f"{style_preset['style_instructions']}, {params.prompt}"

        # Build the request body (Volcengine Ark format)
        request_body = {
            "model": self.seedream_model,
            "prompt": enhanced_prompt,
            "size": f"{params.width}x{params.height}",
            "n": 1,
            "response_format": "b64_json",
        }

        # Add the style-specific negative prompt
        style_negative = style_preset.get("avoid_instructions", "")
        if params.negative_prompt and style_negative:
            request_body["negative_prompt"] = f"{style_negative}, {params.negative_prompt}"
        elif style_negative:
            request_body["negative_prompt"] = style_negative
        elif params.negative_prompt:
            request_body["negative_prompt"] = params.negative_prompt

        if params.seed:
            request_body["seed"] = params.seed

        # If there are reference images (use the image_urls parameter, in data URL format)
        if params.reference_image and os.path.exists(params.reference_image):
            ref_base64, mime_type = self._compress_image(params.reference_image, quality=60)
            data_url = f"data:{mime_type};base64,{ref_base64}"
            request_body["image_urls"] = [data_url]
            request_body["strength"] = params.reference_strength

        reservation_id = ""
        try:
            reservation_id = await _reserve_image_model_call(
                self.seedream_model,
                source="seedream_image_api",
            )
            # Send the request
            async with httpx.AsyncClient(timeout=120.0) as client:
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                }

                # Volcengine Ark API endpoint
                api_url = f"{self.endpoint}/images/generations"

                response = await client.post(
                    api_url,
                    headers=headers,
                    json=request_body,
                )

                if response.status_code != 200:
                    raise Exception(f"API error: {response.status_code} - {response.text}")

                result = response.json()
                provider_request_id = _provider_request_id_from_response(response, result)
                response_id = str(result.get("id") or "").strip()
                await _mark_image_model_call_accepted(
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )

                # Extract the image data
                if "data" in result and len(result["data"]) > 0:
                    image_base64 = result["data"][0].get("b64_json", "")
                    if not image_base64:
                        raise Exception(f"No image data in response: {result}")
                    await _confirm_image_model_call(
                        model=self.seedream_model,
                        reservation_id=reservation_id,
                        provider_request_id=provider_request_id,
                        response_id=response_id,
                    )
                    return image_base64

                raise Exception(f"No image data in response: {result}")
        except Exception as exc:
            await _refund_image_model_call(
                reservation_id,
                source="seedream_image_api",
                error=str(exc),
            )
            raise

    async def generate_with_request(
        self,
        request: ImageGenerationRequest,
        output_path: str,
    ) -> ImageGenResult:
        """Generate an image using the new request format (supports multiple reference images).

        Args:
            request: image generation request (supports multiple reference images)
            output_path: output path

        Returns:
            Generation result
        """
        start_time = time.time()
        reservation_id = ""

        try:
            # Collect all reference images (character references + previous frame)
            all_refs = list(request.reference_images[:9])  # at most 9 character reference images
            if request.previous_frame and os.path.exists(request.previous_frame):
                all_refs.append(request.previous_frame)  # previous frame goes last

            # Build the image_urls array
            image_urls = []
            for ref_path in all_refs[:10]:  # at most 10
                if ref_path and os.path.exists(ref_path):
                    ref_base64, mime_type = self._compress_image(ref_path, quality=60)
                    data_url = f"data:{mime_type};base64,{ref_base64}"
                    image_urls.append(data_url)
                    print(f"[Seedream] Added reference image: {ref_path}", flush=True)

            # Get the style preset
            style_preset = get_style_preset(self.default_style)
            style_keywords = style_preset.get("style_instructions", "")

            # Build the enhanced prompt
            if request.skip_prompt_enhancement:
                # Skip prompt enhancement and use the passed prompt as-is
                enhanced_prompt = request.prompt
                print(f"[Seedream] Using the original prompt (skip_prompt_enhancement=True)", flush=True)
                if image_urls:
                    print(f"[Seedream] Reference image count: {len(image_urls)}, strength={request.reference_scale}", flush=True)
            elif image_urls and request.reference_prompts:
                # With reference images and character descriptions: explicitly map each reference image to its character
                ref_mapping = "\n".join([
                    f"The person in reference image {i+1} is: {prompt}"
                    for i, prompt in enumerate(request.reference_prompts)
                ])
                enhanced_prompt = (
                    f"Keep the character appearance consistent with the reference images; generate strictly according to the age and appearance of the people in the reference images.\n"
                    f"{ref_mapping}\n\n"
                    f"Scene description: {style_keywords}, {request.prompt}"
                )
                print(f"[Seedream] Using {len(image_urls)} reference images (with character descriptions), strength={request.reference_scale}", flush=True)
                print(f"[Seedream] Character mapping:\n{ref_mapping}", flush=True)
            elif image_urls:
                # Reference images but no descriptions (backward compatible)
                enhanced_prompt = (
                    f"Keep the character appearance consistent with the reference images; use the character looks from the reference images."
                    f"{style_keywords}, {request.prompt}"
                )
                print(f"[Seedream] Using {len(image_urls)} reference images, strength={request.reference_scale}", flush=True)
            else:
                enhanced_prompt = f"{style_keywords}, {request.prompt}"

            # Build the request body
            request_body = {
                "model": self.seedream_model,
                "prompt": enhanced_prompt,
                "size": f"{request.width}x{request.height}",
                "n": 1,
                "response_format": "b64_json",
            }

            # Add the negative prompt
            # Seedream sketch render mode: fully disable negative_prompt
            # to avoid any word conflicting semantically with the sketch reference (this strategy applies to Seedream models only)
            if request.is_sketch_render:
                print(f"[Seedream] Sketch render mode: negative_prompt fully disabled (Seedream-specific)", flush=True)
                # Do not set negative_prompt
            else:
                style_negative = style_preset.get("avoid_instructions", "")
                if request.negative_prompt and style_negative:
                    request_body["negative_prompt"] = f"{style_negative}, {request.negative_prompt}"
                elif style_negative:
                    request_body["negative_prompt"] = style_negative
                elif request.negative_prompt:
                    request_body["negative_prompt"] = request.negative_prompt

            if request.seed:
                request_body["seed"] = request.seed

            if image_urls:
                request_body["image_urls"] = image_urls
                request_body["strength"] = request.reference_scale

            # === DEBUG: print the full request parameters ===
            print("=" * 60, flush=True)
            print("[Seedream DEBUG] Full API request parameters:", flush=True)
            print(f"  model: {request_body.get('model')}", flush=True)
            print(f"  size: {request_body.get('size')}", flush=True)
            print(f"  strength: {request_body.get('strength', 'N/A')}", flush=True)
            print(f"  image_urls count: {len(request_body.get('image_urls', []))}", flush=True)
            print(f"  negative_prompt: {request_body.get('negative_prompt', 'N/A')[:100]}...", flush=True)
            print("-" * 60, flush=True)
            print(f"[Seedream DEBUG] Full prompt:\n{request_body.get('prompt')}", flush=True)
            print("=" * 60, flush=True)

            reservation_id = await _reserve_image_model_call(
                self.seedream_model,
                source="seedream_image_request_api",
            )

            # Send the request
            async with httpx.AsyncClient(timeout=120.0) as client:
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                }
                api_url = f"{self.endpoint}/images/generations"

                response = await client.post(
                    api_url,
                    headers=headers,
                    json=request_body,
                )

                if response.status_code != 200:
                    print(f"[Seedream] API error: {response.status_code}", flush=True)
                    print(f"[Seedream] Error response: {response.text[:500]}", flush=True)
                    raise Exception(f"API error: {response.status_code} - {response.text}")

                result = response.json()
                provider_request_id = _provider_request_id_from_response(response, result)
                response_id = str(result.get("id") or "").strip()
                await _mark_image_model_call_accepted(
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )

                # Diagnostic log: print the response structure
                print(f"[Seedream] API response fields: {list(result.keys())}", flush=True)

                if "data" in result and len(result["data"]) > 0:
                    image_data = result["data"][0]
                    print(f"[Seedream] data[0] fields: {list(image_data.keys())}", flush=True)

                    # Try several possible field names
                    image_base64 = (
                        image_data.get("b64_json") or
                        image_data.get("b64") or
                        image_data.get("image") or
                        ""
                    )

                    # Verify image_base64 is not empty
                    if not image_base64:
                        print(f"[Seedream] Warning: API response is missing image data!", flush=True)
                        print(f"[Seedream] Full response: {result}", flush=True)
                        await _refund_image_model_call(
                            reservation_id,
                            source="seedream_image_request_api",
                            error="missing_image_data",
                        )
                        return ImageGenResult(
                            success=False,
                            error="No image data in the API response (b64_json/b64/image fields are empty)",
                            image_path=output_path,
                            generation_time=time.time() - start_time,
                        )
                else:
                    raise Exception(f"No image data in response: {result}")

            # Save the file
            if output_path and image_base64:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(image_base64))

                # Verify the file was created and is valid
                if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
                    print(f"[Seedream] Error: file save failed or file is empty: {output_path}", flush=True)
                    await _refund_image_model_call(
                        reservation_id,
                        source="seedream_image_request_api",
                        error="empty_output_file",
                    )
                    return ImageGenResult(
                        success=False,
                        error="Image save failed or file is empty",
                        image_path=output_path,
                        generation_time=time.time() - start_time,
                    )

                print(f"[Seedream] Image saved: {output_path} ({os.path.getsize(output_path)} bytes)", flush=True)

            generation_time = time.time() - start_time
            await _confirm_image_model_call(
                model=self.seedream_model,
                reservation_id=reservation_id,
                provider_request_id=provider_request_id,
                response_id=response_id,
            )

            return ImageGenResult(
                success=True,
                image_path=output_path,
                image_base64=image_base64,
                generation_time=generation_time,
            )

        except Exception as e:
            await _refund_image_model_call(
                reservation_id,
                source="seedream_image_request_api",
                error=str(e),
            )
            if is_fatal_billing_error(e):
                raise
            return ImageGenResult(
                success=False,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def upscale_with_img2img(
        self,
        input_path: str,
        output_path: str,
        target_width: int = 720,
        target_height: int = 1280,
        strength: float = 0.9,
        enhancement_prompt: str = None,
    ) -> ImageGenResult:
        """Use Seedream image-to-image for high-resolution restoration.

        Principle: use a low-resolution image as the reference to generate a high-resolution version.

        Note: in the Seedream API, strength means "similarity to the reference image"!
        - strength=0.9 means 90% similarity to the original (suitable for high-resolution restoration)
        - strength=0.5 means only 50% similarity, with larger changes
        - For high-resolution restoration, 0.85-0.95 is recommended

        Args:
            input_path: input image path (low resolution)
            output_path: output path (high resolution)
            target_width: target width
            target_height: target height
            strength: similarity (0.85-0.95 suits high-resolution restoration, preserving the original content)
            enhancement_prompt: enhancement prompt (optional)

        Returns:
            ImageGenResult
        """
        start_time = time.time()
        reservation_id = ""

        if not os.path.exists(input_path):
            return ImageGenResult(
                success=False,
                error=f"Input file does not exist: {input_path}",
                generation_time=time.time() - start_time,
            )

        try:
            # Build the enhancement prompt
            if enhancement_prompt:
                prompt = enhancement_prompt
            else:
                prompt = (
                    "high definition, sharp, rich in detail, preserve the original content and composition, "
                    "8K resolution, professional photography, cinematic quality"
                )

            # Get the style preset
            style_preset = get_style_preset(self.default_style)
            style_keywords = style_preset.get("style_instructions", "")
            enhanced_prompt = f"{style_keywords}, {prompt}"

            # Read the input image as the reference
            with open(input_path, "rb") as f:
                ref_base64 = base64.b64encode(f.read()).decode()

            mime_type = "image/png" if input_path.lower().endswith(".png") else "image/jpeg"
            data_url = f"data:{mime_type};base64,{ref_base64}"

            # Build the request body
            request_body = {
                "model": self.seedream_model,
                "prompt": enhanced_prompt,
                "size": f"{target_width}x{target_height}",
                "n": 1,
                "response_format": "b64_json",
                "image_urls": [data_url],
                "strength": strength,  # high strength = high similarity = preserve the original content
            }

            # Add the negative prompt
            style_negative = style_preset.get("avoid_instructions", "")
            if style_negative:
                request_body["negative_prompt"] = style_negative

            print(f"[Seedream] High-resolution restoration: {input_path} -> {target_width}x{target_height}, strength={strength}")

            reservation_id = await _reserve_image_model_call(
                self.seedream_model,
                source="seedream_upscale_api",
            )

            # Send the request
            async with httpx.AsyncClient(timeout=120.0) as client:
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                }
                api_url = f"{self.endpoint}/images/generations"

                response = await client.post(
                    api_url,
                    headers=headers,
                    json=request_body,
                )

                if response.status_code != 200:
                    raise Exception(f"API error: {response.status_code} - {response.text}")

                result = response.json()
                provider_request_id = _provider_request_id_from_response(response, result)
                response_id = str(result.get("id") or "").strip()
                await _mark_image_model_call_accepted(
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )

                if "data" in result and len(result["data"]) > 0:
                    image_base64 = result["data"][0].get("b64_json", "")
                    if not image_base64:
                        raise Exception(f"No image data in response: {result}")
                else:
                    raise Exception(f"No image data in response: {result}")

            # Save the file
            if output_path and image_base64:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(image_base64))

            generation_time = time.time() - start_time
            print(f"[Seedream] High-resolution restoration complete: {output_path}, took {generation_time:.1f}s")
            await _confirm_image_model_call(
                model=self.seedream_model,
                reservation_id=reservation_id,
                provider_request_id=provider_request_id,
                response_id=response_id,
            )

            return ImageGenResult(
                success=True,
                image_path=output_path,
                image_base64=image_base64,
                generation_time=generation_time,
            )

        except Exception as e:
            await _refund_image_model_call(
                reservation_id,
                source="seedream_upscale_api",
                error=str(e),
            )
            if is_fatal_billing_error(e):
                raise
            return ImageGenResult(
                success=False,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def edit_with_seededit(
        self,
        input_path: str,
        output_path: str,
        prompt: str,
        guidance_scale: float = 5.5,
        seed: Optional[int] = None,
    ) -> ImageGenResult:
        """Edit an image with SeedEdit 3.0.

        Note: the SeedEdit model is currently unavailable (404); this method is kept for later use.

        Args:
            input_path: input image path
            output_path: output path
            prompt: edit instruction (describes what to change)
            guidance_scale: edit strength (higher follows the prompt more closely, 3-7 recommended)
            seed: random seed (optional)
        """
        start_time = time.time()
        reservation_id = ""

        if not os.path.exists(input_path):
            return ImageGenResult(
                success=False,
                error=f"Input file does not exist: {input_path}",
                generation_time=time.time() - start_time,
            )

        try:
            # Read the image as a base64 data URL
            with open(input_path, "rb") as f:
                ref_base64 = base64.b64encode(f.read()).decode()
            mime_type = "image/png" if input_path.lower().endswith(".png") else "image/jpeg"
            data_url = f"data:{mime_type};base64,{ref_base64}"

            # SeedEdit API request body (unlike Seedream: image rather than image_urls)
            request_body = {
                "model": self.seededit_model,
                "prompt": prompt,
                "image": data_url,           # a single image, not an image_urls array
                "size": "adaptive",          # adapt to the original image size
                "guidance_scale": guidance_scale,
                "response_format": "url",    # the official example uses the url format
                "n": 1,
            }
            if seed:
                request_body["seed"] = seed

            print(f"[SeedEdit] Image edit: {input_path}, prompt={prompt[:50]}...", flush=True)
            print(f"[SeedEdit] model={self.seededit_model}, guidance_scale={guidance_scale}", flush=True)

            reservation_id = await _reserve_image_model_call(
                self.seededit_model,
                source="seededit_image_api",
            )

            async with httpx.AsyncClient(timeout=180.0) as client:
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                }
                api_url = f"{self.endpoint}/images/generations"
                response = await client.post(api_url, headers=headers, json=request_body)

                if response.status_code != 200:
                    error_text = response.text[:500]
                    print(f"[SeedEdit] API error: {response.status_code} - {error_text}", flush=True)
                    raise Exception(f"API error: {response.status_code} - {error_text}")

                result = response.json()
                provider_request_id = _provider_request_id_from_response(response, result)
                response_id = str(result.get("id") or "").strip()
                await _mark_image_model_call_accepted(
                    provider_request_id=provider_request_id,
                    response_id=response_id,
                )
                print(f"[SeedEdit] API response fields: {list(result.keys())}", flush=True)

                if "data" not in result or len(result["data"]) == 0:
                    raise Exception(f"No image data in response: {result}")

                image_data = result["data"][0]
                print(f"[SeedEdit] data[0] fields: {list(image_data.keys())}", flush=True)

                # Prefer b64_json, otherwise download from the URL
                image_base64 = image_data.get("b64_json") or image_data.get("b64") or ""
                image_url = image_data.get("url", "")

                if not image_base64 and image_url:
                    print(f"[SeedEdit] Downloading the result image from the URL...", flush=True)
                    dl_response = await client.get(image_url, timeout=60.0)
                    if dl_response.status_code != 200:
                        raise Exception(f"Failed to download the result image: {dl_response.status_code}")
                    image_bytes = dl_response.content
                    image_base64 = base64.b64encode(image_bytes).decode()
                elif not image_base64:
                    raise Exception(f"No image data in the API response (no b64_json/url): {list(image_data.keys())}")

            # Save the file
            if output_path and image_base64:
                output_dir = os.path.dirname(output_path)
                if output_dir:
                    os.makedirs(output_dir, exist_ok=True)
                with open(output_path, "wb") as f:
                    f.write(base64.b64decode(image_base64))
                print(f"[SeedEdit] Image saved: {output_path} ({os.path.getsize(output_path)} bytes)", flush=True)

            generation_time = time.time() - start_time
            print(f"[SeedEdit] Edit complete, took {generation_time:.1f}s", flush=True)
            await _confirm_image_model_call(
                model=self.seededit_model,
                reservation_id=reservation_id,
                provider_request_id=provider_request_id,
                response_id=response_id,
            )

            return ImageGenResult(
                success=True,
                image_path=output_path,
                image_base64=image_base64,
                generation_time=generation_time,
            )

        except Exception as e:
            print(f"[SeedEdit] Exception: {e}", flush=True)
            await _refund_image_model_call(
                reservation_id,
                source="seededit_image_api",
                error=str(e),
            )
            if is_fatal_billing_error(e):
                raise
            return ImageGenResult(
                success=False,
                error=str(e),
                generation_time=time.time() - start_time,
            )

    async def generate_character_reference(
        self,
        character_name: str,
        appearance_prompt: str,
        output_dir: str,
        count: int = 3,
        style: str = None,
        project_dir: str = "",
        state_dir: str = "",
    ) -> list[str]:
        """Generate character reference images.

        Generates several reference images for manual selection.

        Args:
            character_name: character name
            appearance_prompt: appearance prompt
            output_dir: output directory
            count: number to generate
            style: style name (used to inject the project style preset)

        Returns:
            List of generated image paths
        """
        os.makedirs(output_dir, exist_ok=True)

        style = style or self.default_style
        style_preset = get_style_preset(
            style,
            project_dir=project_dir,
            state_dir=state_dir or None,
        )
        style_keywords = style_preset.get("style_instructions", "")
        negative_prompt = style_preset.get("avoid_instructions", "")

        paths = []
        views = ["full body front", "full body side", "full body back"]

        # Single-subject qualifier, to avoid generating multiple subjects
        solo_prefix = "solo, single subject, only one character"

        for i in range(count):
            view = views[i] if i < len(views) else f"full body pose {i + 1}"
            prompt = (
                f"{solo_prefix}, {style_keywords}, {appearance_prompt}, {view}, character reference image, "
                "only lock the character identity and appearance, no skin smoothing, no CG look, no illustration look, "
                "keep realistic skin texture and natural facial proportions"
            )

            output_path = os.path.join(output_dir, f"reference_{i + 1:02d}.png")

            result = await self.generate(
                prompt=prompt,
                output_path=output_path,
                negative_prompt=negative_prompt,
                style=style,
                project_dir=project_dir,
            )

            if result.success and result.image_path:
                paths.append(result.image_path)

        return paths


class MockImageGenerator:
    """Mock image generator (for testing).

    Does not call a real API; generates placeholder images.
    """

    def __init__(self):
        self.default_width = 1024
        self.default_height = 1024

    async def generate(
        self,
        prompt: str,
        output_path: Optional[str] = None,
        **kwargs,
    ) -> ImageGenResult:
        """Generate a mock image."""
        try:
            from PIL import Image, ImageDraw, ImageFont
        except ImportError:
            return ImageGenResult(
                success=False,
                error="Pillow not installed",
            )

        # Create a placeholder image
        width = kwargs.get("width", self.default_width)
        height = kwargs.get("height", self.default_height)

        img = Image.new("RGB", (width, height), color=(50, 50, 80))
        draw = ImageDraw.Draw(img)

        # Add text
        text = f"Mock Image\n{prompt[:50]}..."
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 24)
        except Exception:
            font = ImageFont.load_default()

        draw.multiline_text(
            (width // 4, height // 3),
            text,
            fill=(200, 200, 200),
            font=font,
        )

        # Save
        if output_path:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            img.save(output_path)

        return ImageGenResult(
            success=True,
            image_path=output_path,
        )

    async def generate_with_request(
        self,
        request: ImageGenerationRequest,
        output_path: str,
    ) -> ImageGenResult:
        """Generate a mock image using the new request format."""
        return await self.generate(
            prompt=f"[{len(request.reference_images)} refs] {request.prompt}",
            output_path=output_path,
            width=request.width,
            height=request.height,
        )

    async def generate_character_reference(
        self,
        character_name: str,
        appearance_prompt: str,
        output_dir: str,
        count: int = 3,
        style: str = None,
        project_dir: str = "",
    ) -> list[str]:
        """Generate character reference images."""
        os.makedirs(output_dir, exist_ok=True)
        paths = []

        for i in range(count):
            path = os.path.join(output_dir, f"reference_{i + 1:02d}.png")
            result = await self.generate(
                prompt=f"{character_name} - {appearance_prompt}",
                output_path=path,
            )
            if result.success:
                paths.append(path)

        return paths


def create_image_generator(use_mock: bool = False):
    """Create an image generator.

    Args:
        use_mock: whether to use the mock generator

    Returns:
        Image generator instance
    """
    if use_mock:
        return MockImageGenerator()

    try:
        return VolcengineImageGenerator()
    except ValueError:
        # API key not set; fall back to the mock
        print("Warning: Image API key not set, using mock generator")
        return MockImageGenerator()


async def generate_character_reference_unified(
    character_name: str,
    appearance_prompt: str,
    output_dir: str,
    character_tag: str = "",
    count: int = 3,
    use_mock: bool = False,
    style: str = None,
    ethnicity: str = "Chinese",
    prompt_only: bool = False,  # Dry Run mode: only generate prompts, do not call the API
    model: str = None,  # model choice: nanobanana or seedream; read from the config by default
    project_dir: str = "",  # project root directory, used to locate the prompts directory
    state_dir: str = "",  # project state directory, used to read the scoped project config
    usage_task_type: str = "character_portrait",
    usage_scope: str = "",
    identity_name: str = "",
    raise_on_error: bool = False,
    egress_context=None,
) -> list[str]:
    """Unified character reference image generation interface.

    Pick the generator based on the model parameter or the CHARACTER_IMAGE_MODEL config:
    - "nanobanana": use Nano Banana Pro (Gemini), the same model as grid generation
    - "seedream": use Seedream 4.0 (Volcengine)

    Args:
        character_name: character name
        appearance_prompt: appearance prompt
        output_dir: output directory
        character_tag: unique short character tag (for identity locking in Nano Banana Pro)
        count: number to generate (used in Seedream mode; kept for compatibility on the NanoBanana portrait path)
        use_mock: whether to use the mock generator
        style: style name (e.g. "post_apocalyptic"); defaults to the global config
        ethnicity: character ethnicity (default "Chinese"), used to ensure correct facial features
        prompt_only: Dry Run mode; only generate the prompt file, do not call the API
        model: model choice, "nanobanana" or "seedream"; read from the CHARACTER_IMAGE_MODEL environment variable by default

    Returns:
        List of generated image paths
    """
    if egress_context is not None:
        from novelvideo.egress_context import TrustedEgressContext
        from novelvideo.ports.egress import EgressError

        if type(egress_context) is not TrustedEgressContext:
            raise TypeError("egress_context must be a TrustedEgressContext")
        if egress_context.is_organization and model == "seedream":
            raise EgressError("ORG_EGRESS_DENIED")

    # The model parameter takes precedence, otherwise read from the config; supports the legacy values nanobanana/seedream and unified selection keys.
    model = normalize_character_image_selection(model or get_character_image_selection())

    if use_mock:
        generator = MockImageGenerator()
        return await generator.generate_character_reference(
            character_name=character_name,
            appearance_prompt=appearance_prompt,
            output_dir=output_dir,
            count=count,
            project_dir=project_dir,
        )

    if model == "nanobanana":
        # Use Nano Banana Pro (Gemini)
        try:
            from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

            generator = NanoBananaCharacterGenerator(egress_context=egress_context)

            result = await generator.generate_character_portrait(
                character_name=character_name,
                character_prompt=appearance_prompt,
                character_tag=character_tag,
                output_dir=output_dir,
                style=style,
                ethnicity=ethnicity,
                prompt_only=prompt_only,
                project_dir=project_dir,
                state_dir=state_dir,
                usage_task_type=usage_task_type,
                usage_scope=usage_scope,
                identity_name=identity_name,
            )

            if result.success:
                return result.reference_paths
            else:
                print(f"[Character] NanoBanana generation failed: {result.error}")
                if is_insufficient_credits_error(message=result.error or ""):
                    raise RuntimeError("INSUFFICIENT_CREDITS")
                if raise_on_error:
                    raise RuntimeError(result.error or "NanoBanana generation failed")
                return []  # a failure is a failure; no fallback
        except ImportError as e:
            print(f"[Character] Cannot import the NanoBanana generator: {e}")
            return []
        except ValueError as e:
            print(f"[Character] NanoBanana configuration error: {e}")
            return []

    if model in IMAGE_GENERATION_SELECTIONS:
        try:
            from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

            generator = NanoBananaCharacterGenerator(
                selection=model,
                egress_context=egress_context,
            )

            result = await generator.generate_character_portrait(
                character_name=character_name,
                character_prompt=appearance_prompt,
                character_tag=character_tag,
                output_dir=output_dir,
                style=style,
                ethnicity=ethnicity,
                prompt_only=prompt_only,
                project_dir=project_dir,
                state_dir=state_dir,
                usage_task_type=usage_task_type,
                usage_scope=usage_scope,
                identity_name=identity_name,
            )

            if result.success:
                return result.reference_paths
            print(f"[Character] {model} generation failed: {result.error}")
            if is_insufficient_credits_error(message=result.error or ""):
                raise RuntimeError("INSUFFICIENT_CREDITS")
            if raise_on_error:
                raise RuntimeError(result.error or f"{model} generation failed")
            return []
        except ImportError as e:
            print(f"[Character] Cannot import the unified character generator: {e}")
            return []
        except ValueError as e:
            print(f"[Character] {model} configuration error: {e}")
            return []

    if model == "seedream":
        # Use Seedream 4.0 (Volcengine)
        try:
            generator = VolcengineImageGenerator()
            return await generator.generate_character_reference(
                character_name=character_name,
                appearance_prompt=appearance_prompt,
                output_dir=output_dir,
                count=count,
                style=style,
                project_dir=project_dir,
                state_dir=state_dir,
            )
        except ValueError as e:
            print(f"[Character] Seedream configuration error: {e}, using Mock")
            generator = MockImageGenerator()
            return await generator.generate_character_reference(
                character_name=character_name,
                appearance_prompt=appearance_prompt,
                output_dir=output_dir,
                count=count,
                style=style,
                project_dir=project_dir,
            )

    # Default fallback
    generator = MockImageGenerator()
    return await generator.generate_character_reference(
        character_name=character_name,
        appearance_prompt=appearance_prompt,
        output_dir=output_dir,
        count=count,
        style=style,
        project_dir=project_dir,
    )


async def generate_identity_image_unified(
    character_name: str,
    identity_prompt: str,
    reference_image_path: str,
    output_path: str,
    character_tag: str = "",
    ethnicity: str = "Chinese",
    style: str = None,
    dry_run: bool = False,
    model: str = None,  # model choice: nanobanana or seedream; read from the config by default
    project_dir: str = "",  # project root directory, used to locate the prompts directory
    state_dir: str = "",  # project state directory, used to read the scoped project config
    costume_image_path: str = "",  # costume reference image path
    usage_task_type: str = "identity_image",
    usage_scope: str = "",
    identity_name: str = "",
    raise_on_error: bool = False,
    egress_context=None,
) -> dict:
    """Generate an identity reference image from the character base image (Identity Locking).

    Uses the character's front-facing base image as the identity anchor to keep the face consistent,
    changing only identity-specific looks such as costume and background.

    Args:
        character_name: character name
        identity_prompt: identity appearance description (costume, scene, etc.)
        reference_image_path: path of the character front-facing base image
        output_path: output image path
        character_tag: unique short character tag
        ethnicity: character ethnicity (default "Chinese"), used to ensure correct facial features
        style: style name (e.g. "post_apocalyptic"); defaults to the global config
        dry_run: whether to generate only the prompt without images (default False)
        model: model choice, "nanobanana" or "seedream"; read from the CHARACTER_IMAGE_MODEL environment variable by default

    Returns:
        dict: {"success": bool, "prompt": str, "prompt_file": str} (dry_run mode returns the prompt)
              or bool (compatible with legacy code)
    """
    if egress_context is not None:
        from novelvideo.egress_context import TrustedEgressContext
        from novelvideo.ports.egress import EgressError

        if type(egress_context) is not TrustedEgressContext:
            raise TypeError("egress_context must be a TrustedEgressContext")
        if egress_context.is_organization and model == "seedream":
            raise EgressError("ORG_EGRESS_DENIED")

    # The model parameter takes precedence, otherwise read from the config; supports the legacy values nanobanana/seedream and unified selection keys.
    model = normalize_character_image_selection(model or get_character_image_selection())

    if model == "nanobanana":
        try:
            from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

            generator = NanoBananaCharacterGenerator(egress_context=egress_context)
            result = await generator.generate_identity_with_reference(
                character_name=character_name,
                identity_prompt=identity_prompt,
                reference_image_path=reference_image_path,
                output_path=output_path,
                character_tag=character_tag,
                ethnicity=ethnicity,
                style=style,
                dry_run=dry_run,
                project_dir=project_dir,
                state_dir=state_dir,
                costume_image_path=costume_image_path,
                usage_task_type=usage_task_type,
                usage_scope=usage_scope,
                identity_name=identity_name,
            )
            if dry_run:
                return {
                    "success": result.success,
                    "prompt": result.prompt,
                    "prompt_file": result.prompt_file,
                }
            if not result.success:
                if is_insufficient_credits_error(message=result.error or ""):
                    raise RuntimeError("INSUFFICIENT_CREDITS")
                if raise_on_error:
                    raise RuntimeError(result.error or "Identity image generation failed")
            return result.success

        except ImportError as e:
            print(f"[Identity] Cannot import the NanoBanana generator: {e}")
            return False
        except ValueError as e:
            print(f"[Identity] NanoBanana configuration error: {e}")
            return False

    if model in IMAGE_GENERATION_SELECTIONS:
        try:
            from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator

            generator = NanoBananaCharacterGenerator(
                selection=model,
                egress_context=egress_context,
            )
            result = await generator.generate_identity_with_reference(
                character_name=character_name,
                identity_prompt=identity_prompt,
                reference_image_path=reference_image_path,
                output_path=output_path,
                character_tag=character_tag,
                ethnicity=ethnicity,
                style=style,
                dry_run=dry_run,
                project_dir=project_dir,
                state_dir=state_dir,
                costume_image_path=costume_image_path,
                usage_task_type=usage_task_type,
                usage_scope=usage_scope,
                identity_name=identity_name,
            )
            if dry_run:
                return {
                    "success": result.success,
                    "prompt": result.prompt,
                    "prompt_file": result.prompt_file,
                }
            if not result.success:
                if is_insufficient_credits_error(message=result.error or ""):
                    raise RuntimeError("INSUFFICIENT_CREDITS")
                if raise_on_error:
                    raise RuntimeError(result.error or f"{model} identity image generation failed")
            return result.success
        except ImportError as e:
            print(f"[Identity] Cannot import the unified character generator: {e}")
            return False
        except ValueError as e:
            print(f"[Identity] {model} configuration error: {e}")
            return False

    # Seedream or other models: fall back to the original logic (Identity Locking not supported)
    print(f"[Identity] {model} does not support Identity Locking, generating independently")
    import os
    output_dir = os.path.dirname(output_path)
    paths = await generate_character_reference_unified(
        character_name=character_name,
        appearance_prompt=identity_prompt,
        output_dir=output_dir,
        character_tag=character_tag,
        count=1,
        style=style,
        model=model,
        project_dir=project_dir,
        state_dir=state_dir,
        usage_task_type=usage_task_type,
        usage_scope=usage_scope,
        identity_name=identity_name,
        egress_context=egress_context,
    )
    if paths:
        import shutil
        from pathlib import Path
        first = Path(paths[0])
        if first.exists() and str(first) != output_path:
            shutil.copy(first, output_path)
        return True
    if raise_on_error:
        raise RuntimeError("Identity image generation failed")
    return False
