"""Re-download the video of a finished RunPod H3 job from its id.

    python scripts/recover_runpod_h3_video.py <job_id> <output.mp4>

Use after "Failed to download video from R2": the job already ran, its mp4 is
still in the R2 bucket under jobs/<job_id>/.
"""

from __future__ import annotations

import asyncio
import sys

from novelvideo.generators.runpod_minimax_h3_video import recover_runpod_h3_video


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    result = asyncio.run(recover_runpod_h3_video(argv[1], argv[2]))
    if result.error:
        print(f"FAILED: {result.error}")
        return 1
    print(f"saved {result.video_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
