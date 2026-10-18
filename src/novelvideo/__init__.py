"""NovelVideo - automatic novel-to-video generation system (Cognee edition).

Built on the SuperScript architecture; converts a novel into a 30-60 episode narrated video series.

Core features:
- Unified Cognee graph
- Volcano Engine Seedream image generation
- Character consistency (reference images + SeedEdit)
- Multi-agent collaboration
"""

import os as _os

# Dev-only model-call logging (Langfuse). Inert unless LLM_CALL_LOG_ENABLED is set.
if _os.environ.get("LLM_CALL_LOG_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
    import atexit as _atexit

    from novelvideo import llm_call_log as _llm_call_log

    if _llm_call_log.install():
        _atexit.register(_llm_call_log.flush)
