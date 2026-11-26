"""uv run python -m scripts.fake_media_gateway --port 8790"""
from __future__ import annotations

import argparse

import uvicorn

from .server import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--output-dir", default="output/fake_media_gateway")
    parser.add_argument("--comfy-url", default=None, help="default: $COMFY_URL or http://127.0.0.1:8188")
    args = parser.parse_args()
    uvicorn.run(create_app(comfy_url=args.comfy_url, output_dir=args.output_dir), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
