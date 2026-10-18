"""TTS speech synthesis module.

Uses Edge TTS to generate speech.
"""

import asyncio
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, Field

from novelvideo.config import get_tts_config
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import AdmissionContext
from novelvideo.ports.egress_operations import (
    HandleKind,
    OperationSpec,
    canonical_request_digest,
)
from novelvideo.ports.model_credentials import ModelCredentialError, RequestCredential
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
from novelvideo.task_backend.subprocesses import run_project_subprocess

_AUDIO_EGRESS_MESSAGES = {
    "ORG_EGRESS_DENIED": "organization audio egress is denied",
    "ORG_SERVICE_EGRESS_DENIED": "audio service egress is denied",
    "TASK_ENVELOPE_INVALID": "trusted audio egress context is invalid",
}


class AudioEgressError(RuntimeError):
    """Stable audio policy failure without credential or provider details."""

    def __init__(self, code: str) -> None:
        super().__init__(_AUDIO_EGRESS_MESSAGES.get(code, "audio egress is denied"))
        self.code = code


@dataclass(frozen=True, slots=True)
class AudioOperationLease:
    port: Any
    claim: Any

    @property
    def replay_error(self) -> str | None:
        if self.claim.won:
            return None
        return "audio operation already handled"


def _trusted_admission(context: TrustedEgressContext) -> AdmissionContext:
    return AdmissionContext(
        requester_user_id=context.requester_user_id,
        billing_principal=context.billing_principal,
        credential=context.credential,
        admission_id=context.admission_id,
        root_task_id=context.root_task_id,
        admitted_at="verified-task-delivery",
        membership_id=context.membership_id,
        authz_version=context.authz_version,
    )


async def resolve_audio_gateway_credential(
    context: TrustedEgressContext,
) -> RequestCredential:
    """Resolve only the exact credential reference carried by trusted context."""

    if type(context) is not TrustedEgressContext or not context.is_organization:
        raise AudioEgressError("ORG_EGRESS_DENIED")
    if (
        context.credential.source != "organization"
        or context.credential.org_id != context.billing_principal.id
    ):
        raise ModelCredentialError("ORG_CREDENTIAL_MISSING")
    import novelvideo.ports as ports

    credential = await ports.get_model_credentials().resolve(
        _trusted_admission(context)
    )
    if credential.reference != context.credential:
        raise ModelCredentialError("ORG_CREDENTIAL_VERSION_MISMATCH")
    return credential


async def claim_audio_operation(
    context: TrustedEgressContext,
    *,
    capability: str,
    business_task_id: str,
    request: dict[str, Any],
) -> AudioOperationLease:
    """Claim the single submit right for a canonical audio request."""

    if type(context) is not TrustedEgressContext:
        raise AudioEgressError("TASK_ENVELOPE_INVALID")
    import novelvideo.ports as ports

    spec = OperationSpec(
        organization_id=context.billing_principal.id,
        project_id=context.project_id,
        root_task_id=context.root_task_id,
        business_task_id=business_task_id,
        capability=capability,
        credential_id=context.credential.credential_id,
        credential_version=context.credential.key_version,
        request_digest=canonical_request_digest(request),
        handle_kind=HandleKind.LOCAL_RESULT,
    )
    port = ports.get_egress_operation_port()
    return AudioOperationLease(port=port, claim=await port.claim(spec=spec))


async def reject_audio_operation(lease: AudioOperationLease) -> None:
    if not lease.claim.won:
        return
    await lease.port.mark_rejected_before_submit(
        operation_id=lease.claim.operation.operation_id,
        transition_token=lease.claim.transition_token,
        expected_version=lease.claim.operation.version,
    )


async def mark_audio_operation_unknown(lease: AudioOperationLease) -> None:
    if not lease.claim.won:
        return
    await lease.port.mark_unknown(
        operation_id=lease.claim.operation.operation_id,
        transition_token=lease.claim.transition_token,
        expected_version=lease.claim.operation.version,
    )


async def complete_audio_operation(
    lease: AudioOperationLease, *, result_ref: str
) -> None:
    if not lease.claim.won:
        return
    # Synchronous audio has no upstream job id (HandleKind.LOCAL_RESULT), so this is None here -- the placeholder
    # string used before was just a literal that fooled the "non-empty" check. The real result reference is result_ref below.
    accepted = await lease.port.mark_accepted(
        operation_id=lease.claim.operation.operation_id,
        transition_token=lease.claim.transition_token,
        expected_version=lease.claim.operation.version,
        provider_job_id=None,
    )
    await lease.port.mark_completed(
        operation_id=accepted.operation_id,
        transition_token=lease.claim.transition_token,
        expected_version=accepted.version,
        result_ref=result_ref,
    )


class TTSParams(BaseModel):
    """TTS parameters."""

    text: str
    voice: str = "en-US-AriaNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"
    volume: str = "+0%"


class TTSResult(BaseModel):
    """TTS generation result."""

    success: bool
    audio_path: Optional[str] = None
    subtitle_path: Optional[str] = None
    duration_seconds: float = 0.0
    error: Optional[str] = None


class VoiceInfo(BaseModel):
    """Voice information."""

    name: str
    short_name: str
    gender: str
    locale: str


# Recommended Edge TTS voices per supported language (English / Vietnamese).
# Edge only ships two vi-VN voices (one female, one male).
DEFAULT_EDGE_VOICES = {"en": "en-US-AriaNeural", "vi": "vi-VN-HoaiMyNeural"}

EDGE_VOICE_LOCALES = {"en": "en-US", "vi": "vi-VN"}

RECOMMENDED_VOICES = {
    "en": {
        # female
        "aria": "en-US-AriaNeural",  # default, lively
        "jenny": "en-US-JennyNeural",  # friendly
        "michelle": "en-US-MichelleNeural",  # warm
        "ana": "en-US-AnaNeural",  # child
        # male
        "guy": "en-US-GuyNeural",  # mature
        "davis": "en-US-DavisNeural",  # calm
        "christopher": "en-US-ChristopherNeural",  # narrator
        "eric": "en-US-EricNeural",  # news
    },
    "vi": {
        "hoaimy": "vi-VN-HoaiMyNeural",  # female
        "namminh": "vi-VN-NamMinhNeural",  # male
    },
}


class EdgeTTSGenerator:
    """Edge TTS voice generator.

    Uses the Microsoft Edge TTS service to generate high-quality speech.

    Example:
        >>> generator = EdgeTTSGenerator()
        >>> result = await generator.generate(
        ...     text="This is a test text",
        ...     output_path="output/audio.mp3"
        ... )
    """

    def __init__(
        self,
        voice: Optional[str] = None,
        rate: Optional[str] = None,
        pitch: Optional[str] = None,
        egress_context: TrustedEgressContext | None = None,
    ):
        """Initialize the generator.

        Args:
            voice: voice name; defaults to the configured value
            rate: speaking-rate adjustment (e.g. "+10%", "-5%")
            pitch: pitch adjustment (e.g. "+5Hz", "-10Hz")
        """
        self.egress_context = egress_context
        if egress_context is None:
            config = get_tts_config()
            self.voice = voice or config["default_voice"]
            self.rate = rate or config["rate"]
            self.pitch = pitch or config["pitch"]
        else:
            self.voice = voice or DEFAULT_EDGE_VOICES["en"]
            self.rate = rate or "+0%"
            self.pitch = pitch or "+0Hz"

    async def generate(
        self,
        text: str,
        output_path: str,
        voice: Optional[str] = None,
        rate: Optional[str] = None,
        pitch: Optional[str] = None,
        generate_subtitle: bool = True,
        **kwargs,
    ) -> TTSResult:
        """Generate speech.

        Args:
            text: text to synthesize
            output_path: output audio path (.mp3)
            voice: voice name (overrides the default)
            rate: speaking-rate adjustment
            pitch: pitch adjustment
            generate_subtitle: whether to generate a subtitle file

        Returns:
            Generation result
        """
        context = self.egress_context
        if (
            type(context) is not TrustedEgressContext
            or context.billing_principal.kind != "local"
            or context.credential.source != "local"
        ):
            return TTSResult(success=False, error="ORG_SERVICE_EGRESS_DENIED")

        request = {
            "text": str(text or ""),
            "voice": voice or self.voice,
            "rate": rate or self.rate,
            "pitch": pitch or self.pitch,
            "generate_subtitle": bool(generate_subtitle),
        }
        lease = await claim_audio_operation(
            context,
            capability="audio.tts.edge.service",
            business_task_id=f"{context.task_type}:edge:{Path(output_path).name}",
            request=request,
        )
        if lease.replay_error:
            return TTSResult(success=False, error=lease.replay_error)
        try:
            import edge_tts
        except ImportError:
            await reject_audio_operation(lease)
            return TTSResult(
                success=False,
                error="edge-tts not installed. Run: pip install edge-tts",
            )

        transport_started = False
        try:
            # Make sure the output directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Use the argument or the default
            use_voice = voice or self.voice
            use_rate = rate or self.rate
            use_pitch = pitch or self.pitch

            # Create the communicate object
            communicate = edge_tts.Communicate(
                text,
                use_voice,
                rate=use_rate,
                pitch=use_pitch,
            )

            # Generate the audio
            subtitle_path = None
            if generate_subtitle:
                subtitle_path = output_path.rsplit(".", 1)[0] + ".srt"
                submaker = edge_tts.SubMaker()

                with open(output_path, "wb") as audio_file:
                    transport_started = True
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            audio_file.write(chunk["data"])
                        elif chunk["type"] == "SentenceBoundary":
                            # edge-tts 7.x uses SentenceBoundary and feed()
                            submaker.feed(chunk)

                # Save subtitles (SRT format)
                srt_content = submaker.get_srt()
                if srt_content:
                    with open(subtitle_path, "w", encoding="utf-8") as sub_file:
                        sub_file.write(srt_content)
            else:
                transport_started = True
                await communicate.save(output_path)

            # Get the audio duration
            duration = await self._get_audio_duration(output_path)

            result = TTSResult(
                success=True,
                audio_path=output_path,
                subtitle_path=subtitle_path,
                duration_seconds=duration,
            )
            await complete_audio_operation(lease, result_ref="audio:edge:completed")
            return result

        except (TaskCancelled, TaskTimedOut):
            if transport_started:
                await mark_audio_operation_unknown(lease)
            else:
                await reject_audio_operation(lease)
            raise
        except Exception:
            if transport_started:
                await mark_audio_operation_unknown(lease)
            else:
                await reject_audio_operation(lease)
            return TTSResult(
                success=False,
                error="Edge TTS generation failed",
            )

    async def _get_audio_duration(self, audio_path: str) -> float:
        """Get the audio duration."""
        try:
            result = run_project_subprocess(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    audio_path,
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            return float(result.stdout.strip())
        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            # Unknown duration: callers fall back to a words-per-second estimate.
            return 0.0

    async def generate_batch(
        self,
        texts: list[str],
        output_dir: str,
        filename_prefix: str = "audio",
    ) -> list[TTSResult]:
        """Generate speech in batch.

        Args:
            texts: list of texts
            output_dir: output directory
            filename_prefix: filename prefix

        Returns:
            List of generation results
        """
        os.makedirs(output_dir, exist_ok=True)
        results = []

        for i, text in enumerate(texts):
            output_path = os.path.join(output_dir, f"{filename_prefix}_{i + 1:03d}.mp3")
            result = await self.generate(text, output_path)
            results.append(result)

        return results

    async def list_voices(self, locale: str = "en-US") -> list[VoiceInfo]:
        """List available voices.

        Args:
            locale: locale code

        Returns:
            List of voice information
        """
        try:
            import edge_tts

            voices = await edge_tts.list_voices()
            result = []

            for voice in voices:
                if voice["Locale"].startswith(locale):
                    result.append(
                        VoiceInfo(
                            name=voice["FriendlyName"],
                            short_name=voice["ShortName"],
                            gender=voice["Gender"],
                            locale=voice["Locale"],
                        )
                    )

            return result
        except Exception:
            return []


class CosyVoiceTTSGenerator:
    """Alibaba Cloud CosyVoice TTS generator.

    Uses the DashScope SDK to call the CosyVoice model to generate high-quality speech.

    Example:
        >>> generator = CosyVoiceTTSGenerator()
        >>> result = await generator.generate(
        ...     text="This is a test text",
        ...     output_path="output/audio.mp3"
        ... )
    """

    def __init__(
        self,
        model: Optional[str] = None,
        voice: Optional[str] = None,
        api_key: Optional[str] = None,
        speech_rate: Optional[float] = None,
        egress_context: TrustedEgressContext | None = None,
    ):
        """Initialize the generator.

        Args:
            model: model name; defaults to the configured value
            voice: voice name; defaults to the configured value
            api_key: DashScope API Key; defaults to the configured value
            speech_rate: speech-rate multiplier [0.5, 2.0]; defaults to the configured value
        """
        self.egress_context = egress_context
        if egress_context is None:
            config = get_tts_config()
            self.model = model or config.get("cosyvoice_model", "cosyvoice-v3-plus")
            self.voice = voice or config.get("cosyvoice_voice", "longxiaoxia_v3")
            self.api_key = api_key or config.get("dashscope_api_key")
            self.speech_rate = speech_rate or float(
                config.get("cosyvoice_speech_rate", 1.2)
            )
        else:
            self.model = model or "cosyvoice-v3-plus"
            self.voice = voice or "longxiaoxia_v3"
            self.api_key = ""
            self.speech_rate = speech_rate or 1.2

    async def generate(
        self,
        text: str,
        output_path: str,
        voice: Optional[str] = None,
        generate_subtitle: bool = True,
        speech_rate: Optional[float] = None,
        **kwargs,
    ) -> TTSResult:
        """Generate speech.

        Args:
            text: text to synthesize
            output_path: output audio path (.mp3)
            voice: voice name (overrides the default)
            generate_subtitle: whether to generate a subtitle file (not yet supported by CosyVoice)
            speech_rate: speech-rate multiplier (overrides the default, used for dialogue beats)

        Returns:
            Generation result
        """
        if self.egress_context is not None:
            code = (
                "ORG_EGRESS_DENIED"
                if type(self.egress_context) is TrustedEgressContext
                and self.egress_context.is_organization
                else "ORG_SERVICE_EGRESS_DENIED"
            )
            return TTSResult(success=False, error=code)
        try:
            from dashscope.audio.tts_v2 import SpeechSynthesizer, ResultCallback
        except ImportError:
            return TTSResult(
                success=False,
                error="dashscope not installed. Run: pip install dashscope",
            )

        # Check the API Key
        if not self.api_key:
            return TTSResult(
                success=False,
                error="DASHSCOPE_API_KEY not set. Please set it or use TTS_PROVIDER=edge",
            )

        import dashscope

        dashscope.api_key = self.api_key

        try:
            # Make sure the output directory exists
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            use_voice = voice or self.voice
            use_speech_rate = (
                speech_rate if speech_rate is not None else self.speech_rate
            )

            # Create the callback handler (with a completion signal)
            import threading

            class FileCallback(ResultCallback):
                def __init__(self, path):
                    self.path = path
                    self.file = None
                    self.error_msg = None
                    self.completed = threading.Event()

                def on_open(self):
                    self.file = open(self.path, "wb")

                def on_data(self, data: bytes):
                    if self.file:
                        self.file.write(data)

                def on_complete(self):
                    pass

                def on_error(self, message: str):
                    self.error_msg = message

                def on_close(self):
                    if self.file:
                        self.file.close()
                    self.completed.set()  # signal completion

            callback = FileCallback(output_path)
            synthesizer = SpeechSynthesizer(
                model=self.model,
                voice=use_voice,
                speech_rate=use_speech_rate,
                callback=callback,
            )

            # Call the API (the callback runs in a background thread)
            synthesizer.call(text)

            # Wait asynchronously for the callback to finish (without blocking the event loop)
            loop = asyncio.get_event_loop()
            completed = await loop.run_in_executor(
                None, lambda: callback.completed.wait(timeout=60)
            )
            if not completed:
                return TTSResult(
                    success=False,
                    error="TTS timeout: callback did not complete within 60 seconds",
                )

            if callback.error_msg:
                return TTSResult(
                    success=False,
                    error="CosyVoice provider failed",
                )

            # Verify the file was generated and is non-empty
            if not os.path.exists(output_path):
                return TTSResult(
                    success=False,
                    error="Audio file was not created",
                )
            file_size = os.path.getsize(output_path)
            if file_size == 0:
                return TTSResult(
                    success=False,
                    error="Audio file is empty (0 bytes)",
                )

            # Get the audio duration
            duration = await self._get_audio_duration(output_path)
            if duration == 0.0:
                return TTSResult(
                    success=False,
                    error=f"Could not determine audio duration (file size: {file_size} bytes)",
                )

            return TTSResult(
                success=True,
                audio_path=output_path,
                duration_seconds=duration,
            )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return TTSResult(
                success=False,
                error="CosyVoice generation failed",
            )

    async def _get_audio_duration(self, audio_path: str) -> float:
        """Get the audio duration."""
        try:
            result = run_project_subprocess(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    audio_path,
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            return float(result.stdout.strip())
        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return 0.0

    async def generate_batch(
        self,
        texts: list[str],
        output_dir: str,
        filename_prefix: str = "audio",
    ) -> list[TTSResult]:
        """Generate speech in batch.

        Args:
            texts: list of texts
            output_dir: output directory
            filename_prefix: filename prefix

        Returns:
            List of generation results
        """
        os.makedirs(output_dir, exist_ok=True)
        results = []

        for i, text in enumerate(texts):
            output_path = os.path.join(output_dir, f"{filename_prefix}_{i + 1:03d}.mp3")
            result = await self.generate(text, output_path)
            results.append(result)

        return results


class MockTTSGenerator:
    """Mock TTS generator (for testing).

    Does not call a real API; generates empty audio files.
    """

    def __init__(self):
        self.voice = "mock-voice"

    async def generate(
        self,
        text: str,
        output_path: str,
        **kwargs,
    ) -> TTSResult:
        """Generate mock audio."""
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Estimated duration (~2.6 spoken words per second).
            duration = max(len(text.split()), 1) / 2.6

            # Create a simple silent MP3 (using ffmpeg)
            try:
                import subprocess

                run_project_subprocess(
                    [
                        "ffmpeg",
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        f"anullsrc=r=44100:cl=stereo",
                        "-t",
                        str(duration),
                        "-acodec",
                        "libmp3lame",
                        output_path,
                    ],
                    capture_output=True,
                    check=True,
                    timeout=30 * 60,
                )
            except (TaskCancelled, TaskTimedOut):
                raise
            except Exception:
                # If ffmpeg is unavailable, create an empty file
                with open(output_path, "wb") as f:
                    f.write(b"")

            # Create a subtitle file (SRT format)
            subtitle_path = output_path.rsplit(".", 1)[0] + ".srt"
            with open(subtitle_path, "w", encoding="utf-8") as f:
                f.write("1\n")
                f.write(f"00:00:00,000 --> 00:00:{int(duration):02d},000\n")
                f.write(text[:100] + ("..." if len(text) > 100 else "") + "\n")

            return TTSResult(
                success=True,
                audio_path=output_path,
                subtitle_path=subtitle_path,
                duration_seconds=duration,
            )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return TTSResult(
                success=False,
                error=str(e),
            )

    async def generate_batch(
        self,
        texts: list[str],
        output_dir: str,
        filename_prefix: str = "audio",
    ) -> list[TTSResult]:
        """Generate mock speech in batch."""
        os.makedirs(output_dir, exist_ok=True)
        results = []

        for i, text in enumerate(texts):
            output_path = os.path.join(output_dir, f"{filename_prefix}_{i + 1:03d}.mp3")
            result = await self.generate(text, output_path)
            results.append(result)

        return results


def create_tts_generator(
    provider: Optional[str] = None,
    use_mock: bool = False,
    model: Optional[str] = None,
    voice: Optional[str] = None,
    egress_context: TrustedEgressContext | None = None,
):
    """Create a TTS generator.

    Args:
        provider: TTS provider (cosyvoice, edge, ...); defaults to the configured value
        use_mock: whether to use the mock generator
        model: custom model name (supported by some providers only)
        voice: custom voice name

    Returns:
        TTS generator instance
    """
    if use_mock:
        return MockTTSGenerator()

    if provider is None:
        if egress_context is not None:
            provider = "edge"
        else:
            provider = get_tts_config().get("provider", "cosyvoice")

    if egress_context is not None and (
        type(egress_context) is not TrustedEgressContext
        or egress_context.billing_principal.kind == "local"
        and provider != "edge"
    ):
        raise AudioEgressError("ORG_SERVICE_EGRESS_DENIED")

    if provider == "cosyvoice":
        return CosyVoiceTTSGenerator(
            model=model,
            voice=voice,
            egress_context=egress_context,
        )
    elif provider == "edge":
        return EdgeTTSGenerator(voice=voice, egress_context=egress_context)
    else:
        if egress_context is not None:
            raise AudioEgressError("ORG_SERVICE_EGRESS_DENIED")
        return CosyVoiceTTSGenerator(model=model, voice=voice)


def get_voice_by_style(style: str, language: str = "en") -> str:
    """Return the recommended Edge voice for a style in the given language.

    Args:
        style: narrator, storyteller, news, child, gentle, mature_female, mature_male
        language: "en" or "vi"
    """
    if language == "vi":
        style_mapping = {
            "narrator": "vi-VN-NamMinhNeural",
            "news": "vi-VN-NamMinhNeural",
            "mature_male": "vi-VN-NamMinhNeural",
        }
        return style_mapping.get(style, DEFAULT_EDGE_VOICES["vi"])
    style_mapping = {
        "narrator": "en-US-ChristopherNeural",
        "storyteller": "en-US-AriaNeural",
        "news": "en-US-EricNeural",
        "child": "en-US-AnaNeural",
        "gentle": "en-US-JennyNeural",
        "mature_female": "en-US-MichelleNeural",
        "mature_male": "en-US-GuyNeural",
    }
    return style_mapping.get(style, DEFAULT_EDGE_VOICES["en"])
