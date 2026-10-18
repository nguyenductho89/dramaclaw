"""Video composition module.

Generates video using FFmpeg + MoviePy.
"""

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

from novelvideo.config import get_video_config
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut
from novelvideo.task_backend.subprocesses import run_project_subprocess


def _run_video_subprocess(cmd: list[str], *, timeout: int = 30 * 60) -> subprocess.CompletedProcess:
    return run_project_subprocess(cmd, capture_output=True, text=True, timeout=timeout)


def normalize_video_title(title: str) -> str:
    """Collapse generated titles to one line for filenames and ffmpeg drawtext."""
    normalized = re.sub(r"\s+", " ", str(title or "")).strip()
    return normalized or "untitled"


def _drawtext_fontfile_arg() -> str:
    for path in (
        # Latin fonts with full Vietnamese diacritics coverage.
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        if os.path.exists(path):
            return f":fontfile={path}"
    return ""


class SceneAsset(BaseModel):
    """Scene asset."""

    scene_number: int
    image_path: str
    audio_path: str
    video_path: Optional[str] = None
    subtitle_path: Optional[str] = None
    duration_seconds: float = 0.0
    narration_text: str = ""


class VideoResult(BaseModel):
    """Video generation result."""

    success: bool
    video_path: Optional[str] = None
    duration_seconds: float = 0.0
    error: Optional[str] = None


class KenBurnsEffect:
    """Ken Burns effect configuration."""

    ZOOM_IN = "zoom_in"
    ZOOM_OUT = "zoom_out"
    PAN_LEFT = "pan_left"
    PAN_RIGHT = "pan_right"
    PAN_UP = "pan_up"
    PAN_DOWN = "pan_down"

    @staticmethod
    def get_ffmpeg_filter(effect: str, duration: float, width: int, height: int) -> str:
        """Get the FFmpeg filter string.

        Args:
            effect: effect type
            duration: duration (seconds)
            width: output width
            height: output height

        Returns:
            FFmpeg filter string
        """
        # Compute frame count
        fps = 30
        frames = int(duration * fps)

        if effect == KenBurnsEffect.ZOOM_IN:
            # Zoom from 100% to 120%
            return (
                f"scale=8000:-1,"
                f"zoompan=z='min(zoom+0.001,1.2)':d={frames}:x='iw/2-(iw/zoom/2)':"
                f"y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        elif effect == KenBurnsEffect.ZOOM_OUT:
            # Zoom from 120% to 100%
            return (
                f"scale=8000:-1,"
                f"zoompan=z='if(lte(zoom,1.0),1.2,max(1.001,zoom-0.001))':d={frames}:"
                f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        elif effect == KenBurnsEffect.PAN_LEFT:
            return (
                f"scale=8000:-1,"
                f"zoompan=z=1.1:d={frames}:x='iw/2-(iw/zoom/2)+{duration}*10':"
                f"y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        elif effect == KenBurnsEffect.PAN_RIGHT:
            return (
                f"scale=8000:-1,"
                f"zoompan=z=1.1:d={frames}:x='iw/2-(iw/zoom/2)-{duration}*10':"
                f"y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps}"
            )
        else:
            # Default: static display
            return f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"


class VideoComposer:
    """Video composer.

    Composes images, audio, and subtitles into a video.

    Example:
        >>> composer = VideoComposer()
        >>> result = await composer.compose_episode(
        ...     scenes=scenes,
        ...     output_path="output/ep01.mp4",
        ...     title="Episode 1"
        ... )
    """

    def __init__(
        self,
        width: Optional[int] = None,
        height: Optional[int] = None,
        fps: Optional[int] = None,
    ):
        """Initialize the composer.

        Args:
            width: video width
            height: video height
            fps: frame rate
        """
        config = get_video_config()
        self.width = width or config["width"]
        self.height = height or config["height"]
        self.fps = fps or config["fps"]
        self.codec = config["codec"]
        self.audio_codec = config["audio_codec"]
        self.bitrate = config["bitrate"]

    async def compose_episode(
        self,
        scenes: list[SceneAsset],
        output_path: str,
        title: Optional[str] = None,
        add_title_card: bool = True,
        add_end_card: bool = True,
        ken_burns: bool = True,
    ) -> VideoResult:
        """Compose a single-episode video.

        Args:
            scenes: list of scene assets
            output_path: output path
            title: title (used for the title card)
            add_title_card: whether to add a title card
            add_end_card: whether to add an end card
            ken_burns: whether to use the Ken Burns effect

        Returns:
            Composition result
        """
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)

            # Create a temporary directory
            with tempfile.TemporaryDirectory() as temp_dir:
                scene_videos = []

                # Create a video clip for each scene
                for i, scene in enumerate(scenes):
                    scene_video = os.path.join(temp_dir, f"scene_{i:03d}.mp4")

                    # Pick a Ken Burns effect
                    effect = None
                    if ken_burns:
                        effects = [
                            KenBurnsEffect.ZOOM_IN,
                            KenBurnsEffect.ZOOM_OUT,
                            KenBurnsEffect.PAN_LEFT,
                            KenBurnsEffect.PAN_RIGHT,
                        ]
                        effect = effects[i % len(effects)]

                    # Create the scene video
                    success = await self._create_scene_video(
                        scene=scene,
                        output_path=scene_video,
                        effect=effect,
                    )

                    if success:
                        scene_videos.append(scene_video)

                # Add the title card
                if add_title_card and title:
                    title_video = os.path.join(temp_dir, "title.mp4")
                    if not await self._create_title_card(normalize_video_title(title), title_video):
                        return VideoResult(success=False, error="failed to create title card")
                    scene_videos.insert(0, title_video)

                # Add the end card
                if add_end_card:
                    end_video = os.path.join(temp_dir, "end.mp4")
                    if not await self._create_end_card(end_video):
                        return VideoResult(success=False, error="failed to create end card")
                    scene_videos.append(end_video)

                # Merge all clips
                if not scene_videos:
                    return VideoResult(success=False, error="no scene videos were created")
                if not await self._concat_videos(scene_videos, output_path):
                    return VideoResult(success=False, error="failed to concatenate scene videos")
                if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
                    return VideoResult(success=False, error="output file was not created")

                # Compute total duration
                total_duration = sum(s.duration_seconds for s in scenes)
                if add_title_card:
                    total_duration += 3.0  # title card 3 seconds
                if add_end_card:
                    total_duration += 2.0  # end card 2 seconds

                return VideoResult(
                    success=True,
                    video_path=output_path,
                    duration_seconds=total_duration,
                )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return VideoResult(
                success=False,
                error=str(e),
            )

    async def _create_scene_video(
        self,
        scene: SceneAsset,
        output_path: str,
        effect: Optional[str] = None,
    ) -> bool:
        """Create the video for a single scene.

        Args:
            scene: scene asset
            output_path: output path
            effect: Ken Burns effect

        Returns:
            Whether it succeeded
        """
        try:
            # Build the FFmpeg command
            if effect:
                video_filter = KenBurnsEffect.get_ffmpeg_filter(
                    effect, scene.duration_seconds, self.width, self.height
                )
            else:
                video_filter = (
                    f"scale={self.width}:{self.height}:force_original_aspect_ratio=decrease,"
                    f"pad={self.width}:{self.height}:(ow-iw)/2:(oh-ih)/2"
                )

            cmd = [
                "ffmpeg",
                "-y",
                "-loop",
                "1",
                "-i",
                scene.image_path,
                "-i",
                scene.audio_path,
                "-vf",
                video_filter,
                "-c:v",
                self.codec,
                "-c:a",
                self.audio_codec,
                "-b:v",
                self.bitrate,
                "-pix_fmt",
                "yuv420p",
                "-shortest",
                output_path,
            ]

            result = _run_video_subprocess(cmd)
            return result.returncode == 0

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            print(f"Failed to create scene video: {e}")
            return False

    async def _create_title_card(self, title: str, output_path: str) -> bool:
        """Create the title card.

        Args:
            title: title text
            output_path: output path

        Returns:
            Whether it succeeded
        """
        try:
            # Use FFmpeg to create a title card with text
            duration = 3.0
            text_file = output_path + ".title.txt"
            Path(text_file).write_text(normalize_video_title(title), encoding="utf-8")

            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c=black:s={self.width}x{self.height}:d={duration}",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r=44100:cl=stereo:d={duration}",
                "-vf",
                f"drawtext=textfile={text_file}:fontcolor=white:fontsize=72:"
                f"x=(w-text_w)/2:y=(h-text_h)/2{_drawtext_fontfile_arg()}",
                "-c:v",
                self.codec,
                "-c:a",
                self.audio_codec,
                "-pix_fmt",
                "yuv420p",
                output_path,
            ]

            result = _run_video_subprocess(cmd)
            if result.returncode == 0:
                return True
            return self._create_blank_card(duration, output_path)

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return False
        finally:
            try:
                os.unlink(text_file)
            except Exception:
                pass

    async def _create_end_card(self, output_path: str) -> bool:
        """Create the end card.

        Args:
            output_path: output path

        Returns:
            Whether it succeeded
        """
        try:
            duration = 2.0
            text_file = output_path + ".end.txt"
            Path(text_file).write_text("To be continued", encoding="utf-8")

            cmd = [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c=black:s={self.width}x{self.height}:d={duration}",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r=44100:cl=stereo:d={duration}",
                "-vf",
                f"drawtext=textfile={text_file}:fontcolor=white:fontsize=48:"
                f"x=(w-text_w)/2:y=(h-text_h)/2{_drawtext_fontfile_arg()}",
                "-c:v",
                self.codec,
                "-c:a",
                self.audio_codec,
                "-pix_fmt",
                "yuv420p",
                output_path,
            ]

            result = _run_video_subprocess(cmd)
            if result.returncode == 0:
                return True
            return self._create_blank_card(duration, output_path)

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return False
        finally:
            try:
                os.unlink(text_file)
            except Exception:
                pass

    def _create_blank_card(self, duration: float, output_path: str) -> bool:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s={self.width}x{self.height}:d={duration}",
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r=44100:cl=stereo:d={duration}",
            "-c:v",
            self.codec,
            "-c:a",
            self.audio_codec,
            "-pix_fmt",
            "yuv420p",
            output_path,
        ]
        result = _run_video_subprocess(cmd)
        return result.returncode == 0

    async def _concat_videos(self, video_paths: list[str], output_path: str) -> bool:
        """Merge multiple videos.

        Args:
            video_paths: list of video paths
            output_path: output path

        Returns:
            Whether it succeeded
        """
        try:
            # Create the file list
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False
            ) as f:
                for path in video_paths:
                    f.write(f"file '{path}'\n")
                list_file = f.name

            try:
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    list_file,
                    "-c",
                    "copy",
                    output_path,
                ]

                result = _run_video_subprocess(cmd)
                return result.returncode == 0

            finally:
                os.unlink(list_file)

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            print(f"Failed to merge videos: {e}")
            return False

    async def add_subtitles(
        self,
        video_path: str,
        subtitle_path: str,
        output_path: str,
        style: str = "FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2",
    ) -> VideoResult:
        """Add subtitles to a video.

        Args:
            video_path: video path
            subtitle_path: subtitle path (.srt or .vtt)
            output_path: output path
            style: subtitle style

        Returns:
            Processing result
        """
        try:
            # Convert VTT to ASS format (if needed)
            if subtitle_path.endswith(".vtt"):
                ass_path = subtitle_path.rsplit(".", 1)[0] + ".ass"
                await self._vtt_to_ass(subtitle_path, ass_path)
                subtitle_path = ass_path

            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                video_path,
                "-vf",
                f"subtitles={subtitle_path}:force_style='{style}'",
                "-c:a",
                "copy",
                output_path,
            ]

            result = _run_video_subprocess(cmd)

            if result.returncode == 0:
                return VideoResult(
                    success=True,
                    video_path=output_path,
                )
            else:
                return VideoResult(
                    success=False,
                    error=result.stderr,
                )

        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception as e:
            return VideoResult(
                success=False,
                error=str(e),
            )

    async def _vtt_to_ass(self, vtt_path: str, ass_path: str) -> bool:
        """Convert VTT to ASS format."""
        try:
            cmd = [
                "ffmpeg",
                "-y",
                "-i",
                vtt_path,
                ass_path,
            ]
            result = _run_video_subprocess(cmd)
            return result.returncode == 0
        except (TaskCancelled, TaskTimedOut):
            raise
        except Exception:
            return False


class MoviePyComposer:
    """Video composer using MoviePy.

    Provides more flexible video editing capabilities.
    """

    def __init__(
        self,
        width: int = 1920,
        height: int = 1080,
        fps: int = 30,
    ):
        """Initialize the composer."""
        self.width = width
        self.height = height
        self.fps = fps

    async def compose_episode(
        self,
        scenes: list[SceneAsset],
        output_path: str,
        title: Optional[str] = None,
    ) -> VideoResult:
        """Compose a video using MoviePy."""
        try:
            from moviepy.editor import (
                AudioFileClip,
                CompositeVideoClip,
                ImageClip,
                TextClip,
                concatenate_videoclips,
            )
        except ImportError:
            return VideoResult(
                success=False,
                error="moviepy not installed. Run: pip install moviepy",
            )

        try:
            clips = []

            # Add the title card
            if title:
                title_clip = (
                    TextClip(
                        title,
                        fontsize=72,
                        color="white",
                        bg_color="black",
                        size=(self.width, self.height),
                        method="caption",
                    )
                    .set_duration(3)
                    .set_fps(self.fps)
                )
                clips.append(title_clip)

            # Process each scene
            for scene in scenes:
                # Load the image
                img_clip = (
                    ImageClip(scene.image_path)
                    .set_duration(scene.duration_seconds)
                    .resize((self.width, self.height))
                )

                # Load the audio
                audio_clip = AudioFileClip(scene.audio_path)

                # Combine
                video_clip = img_clip.set_audio(audio_clip)
                clips.append(video_clip)

            # Add the end card
            end_clip = (
                TextClip(
                    "To be continued",
                    fontsize=48,
                    color="white",
                    bg_color="black",
                    size=(self.width, self.height),
                    method="caption",
                )
                .set_duration(2)
                .set_fps(self.fps)
            )
            clips.append(end_clip)

            # Merge
            final_clip = concatenate_videoclips(clips, method="compose")

            # Export
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            final_clip.write_videofile(
                output_path,
                fps=self.fps,
                codec="libx264",
                audio_codec="aac",
            )

            # Clean up
            final_clip.close()
            for clip in clips:
                clip.close()

            return VideoResult(
                success=True,
                video_path=output_path,
                duration_seconds=final_clip.duration,
            )

        except Exception as e:
            return VideoResult(
                success=False,
                error=str(e),
            )


def create_video_composer(use_moviepy: bool = False):
    """Create a video composer.

    Args:
        use_moviepy: whether to use MoviePy (otherwise FFmpeg)

    Returns:
        Video composer instance
    """
    if use_moviepy:
        return MoviePyComposer()

    return VideoComposer()


async def adjust_video_duration(
    video_path: str,
    target_duration: float,
    output_path: Optional[str] = None,
    method: str = "auto",
) -> str:
    """Adjust the video duration to the target value.

    Used to fit the fixed 5-second video generated in first/last-frame mode to the actual TTS duration.

    Strategy:
    - target < source duration: trim the end
    - target > source duration:
        - Speed-stretch (at most 1.5x, to avoid visible distortion)
        - Beyond 1.5x, freeze the last frame to fill

    Args:
        video_path: source video path
        target_duration: target duration (seconds)
        output_path: output path (defaults to overwriting the source file)
        method: adjustment method
            - "auto": pick the best method automatically
            - "trim": trim only (when the target is shorter)
            - "speed": change speed only (when the target is longer)
            - "freeze": freeze the last frame to fill (when the target is longer)

    Returns:
        Output video path
    """
    if output_path is None:
        # Use a temporary file, then overwrite
        import tempfile
        temp_fd, temp_path = tempfile.mkstemp(suffix=".mp4")
        os.close(temp_fd)
        output_path = temp_path
        should_replace = True
    else:
        should_replace = False

    # Get the source video duration
    probe_cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    result = _run_video_subprocess(probe_cmd, timeout=60)
    try:
        source_duration = float(result.stdout.strip())
    except ValueError:
        source_duration = 5.0  # default 5 seconds

    print(f"[adjust_video_duration] Source duration: {source_duration:.2f}s, target: {target_duration:.2f}s")

    # Compute the duration difference
    duration_diff = abs(target_duration - source_duration)
    if duration_diff < 0.1:
        # Durations are close enough; no adjustment needed
        print("[adjust_video_duration] Durations are close enough, no adjustment needed")
        return video_path

    if target_duration < source_duration:
        # Target is shorter: trim the end
        print(f"[adjust_video_duration] Trimming video: {source_duration:.2f}s -> {target_duration:.2f}s")
        cmd = [
            "ffmpeg",
            "-y",
            "-i", video_path,
            "-t", str(target_duration),
            "-c:v", "copy",
            "-c:a", "copy",
            output_path,
        ]
    else:
        # Target is longer: needs stretching
        stretch_ratio = target_duration / source_duration
        print(f"[adjust_video_duration] Stretch ratio: {stretch_ratio:.2f}x")

        if stretch_ratio <= 1.5 or method == "speed":
            # Speed-stretch (slow down playback)
            # setpts: video timestamps, atempo: audio speed
            speed_factor = 1 / stretch_ratio  # 0.5 = 2x slower
            print(f"[adjust_video_duration] Speed stretch: {speed_factor:.2f}x speed")
            cmd = [
                "ffmpeg",
                "-y",
                "-i", video_path,
                "-filter_complex",
                f"[0:v]setpts={stretch_ratio}*PTS[v];[0:a]atempo={speed_factor}[a]",
                "-map", "[v]",
                "-map", "[a]",
                "-c:v", "libx264",
                "-preset", "fast",
                "-c:a", "aac",
                output_path,
            ]
        else:
            # Freeze the last frame to fill
            freeze_duration = target_duration - source_duration
            print(f"[adjust_video_duration] Freezing last frame: {freeze_duration:.2f}s")

            # Use the tpad filter to freeze the last frame
            freeze_frames = int(freeze_duration * 30)  # assume 30fps
            cmd = [
                "ffmpeg",
                "-y",
                "-i", video_path,
                "-vf", f"tpad=stop_mode=clone:stop_duration={freeze_duration}",
                "-c:v", "libx264",
                "-preset", "fast",
                "-c:a", "aac",
                output_path,
            ]

    # Run the command
    result = _run_video_subprocess(cmd)

    if result.returncode != 0:
        print(f"[adjust_video_duration] FFmpeg error: {result.stderr[:500]}")
        return video_path  # return the original video on failure

    # If the source file needs to be overwritten
    if should_replace:
        import shutil
        shutil.move(output_path, video_path)
        return video_path

    return output_path


def get_video_duration(video_path: str) -> float:
    """Get the video duration.

    Args:
        video_path: video file path

    Returns:
        Duration (seconds)
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path,
    ]
    result = _run_video_subprocess(cmd, timeout=60)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0
