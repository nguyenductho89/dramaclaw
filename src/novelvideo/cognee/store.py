"""NovelVideo unified storage layer - SQLite + Cognee.

Core idea:
- Structured data (Character, Episode, VisualBeat) is stored in SQLite
- The knowledge graph + vector retrieval are managed by Cognee (Kuzu)
- Each project = one directory on the filesystem, no remote dependencies
"""

import asyncio
import os
from pathlib import Path
from typing import Awaitable, Callable, Dict, List, Optional, Any, Iterable
import json
from datetime import date, datetime
from uuid import UUID

# Important: config must be imported first so env vars are set before cognee is imported
from .config import init_cognee  # noqa: F401
from novelvideo.i18n_message import MessageLike, lmsg
from novelvideo.config import get_newapi_structured_output_litellm_kwargs
from .concurrency import cognee_pipeline_concurrency
from .ladybug_access import cognee_project_context, ladybug_graph_access

from novelvideo.shared.env_guard import preserve_st_env

with preserve_st_env():
    import cognee
    from cognee.api.v1.search import SearchType
    from cognee.modules.engine.operations.setup import setup
from rich.console import Console
from novelvideo.embedding_models import (
    embedding_model_for_legacy_project,
    embedding_model_scope as project_embedding_model_scope,
)
from novelvideo.graph_preview import (
    delete_graph_preview,
    write_graph_preview,
)
from novelvideo.knowledge_pipeline import (
    KnowledgePipelineUnsupported,
    is_structured_pipeline,
)
from novelvideo.novel_source import require_imported_novel
from novelvideo.project_config import ensure_cognee_embedding_binding_in_state_dir
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.utils.document_parsers import load_novel_text

# Path helper functions - canonical implementation lives in utils.path_resolver.
from novelvideo.utils.path_resolver import (  # noqa: F401
    compute_portrait_path,
    compute_identity_path,
    compute_scene_reference_path,
    compute_prop_reference_path,
)

from novelvideo.models import (
    BeatAssetRefRow,
    CharacterIdentity,
    NovelCharacter,
    NovelEpisode,
    NovelEvent,
    NovelVisualBeat,
    NovelScene,
    SceneMenuItem,
    NovelProp,
    PropMenuItem,
    complete_detected_refs_from_visual_description,
    normalize_detected_identities,
    normalize_detected_props,
    sync_beat_asset_refs,
)

console = Console()

INGEST_PROGRESS_MILESTONES = {
    "read": 0.02,
    "prune": 0.06,
    "parse": 0.10,
    "parsed": 0.25,
    "graph": 0.30,
    "graph_validated": 0.65,
    "index": 0.70,
    "indexed": 0.85,
    "preview": 0.90,
    "preview_saved": 0.95,
    "save": 0.98,
    "complete": 1.0,
}


def _json_list_payload(values: list[str]) -> str:
    return json.dumps(list(values or []), ensure_ascii=False)


class CogneeStore:
    """Unified storage layer - SQLite + Cognee.

    Usage:
        store = CogneeStore("hongloumeng")
        await store.initialize()

        # Import the novel and extract characters
        await store.ingest_and_extract(novel_path)

        # Look up a character (aliases supported)
        char = await store.get_character("the Queen")  # returns the canonical character
        prompt = char.face_prompt  # get the face prompt directly
    """

    def __init__(
        self,
        project_name: str,
        output_dir: str | None = None,
        state_dir: str | None = None,
        sqlite_store: SQLiteStore | None = None,
    ):
        self.project_name = project_name
        self.dataset_name = f"novelvideo_{project_name}"
        self._owns_sqlite_store = sqlite_store is None

        # Cache (loaded from SQLite)
        self._characters: Dict[str, NovelCharacter] = {}
        self._episodes: Dict[int, NovelEpisode] = {}
        self._props: Dict[str, NovelProp] = {}
        self._alias_index: Dict[str, str] = {}  # alias -> primary_name

        # Project directory
        sqlite_project_dir = (
            str(getattr(sqlite_store, "project_dir", "") or "") if sqlite_store else ""
        )
        sqlite_state_dir = str(getattr(sqlite_store, "state_dir", "") or "") if sqlite_store else ""
        if output_dir:
            self.project_dir = output_dir
            if (
                sqlite_project_dir
                and Path(output_dir).resolve() != Path(sqlite_project_dir).resolve()
            ):
                raise ValueError(
                    "CogneeStore output_dir must match injected SQLiteStore project_dir: "
                    f"output_dir={output_dir}, sqlite_store.project_dir={sqlite_project_dir}"
                )
            os.makedirs(output_dir, exist_ok=True)
        elif sqlite_project_dir:
            self.project_dir = sqlite_project_dir
        else:
            from novelvideo.config import ensure_project_dirs

            self.project_dir = ensure_project_dirs(project_name)["base"]

        if state_dir:
            resolved_state_dir = Path(state_dir)
        elif sqlite_state_dir:
            resolved_state_dir = Path(sqlite_state_dir)
        elif "/" in project_name:
            from novelvideo.utils.project_paths import ProjectPaths

            parts = project_name.split("/", 1)
            paths = ProjectPaths(parts[0], parts[1])
            resolved_state_dir = paths.state_dir
        else:
            resolved_state_dir = Path(self.project_dir)

        if (
            state_dir
            and sqlite_state_dir
            and Path(state_dir).resolve() != Path(sqlite_state_dir).resolve()
        ):
            raise ValueError(
                "CogneeStore state_dir must match injected SQLiteStore state_dir: "
                f"state_dir={state_dir}, sqlite_store.state_dir={sqlite_state_dir}"
            )
        resolved_state_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir = str(resolved_state_dir)
        self.db_path = str(resolved_state_dir / "data.db")
        self.sqlite_store = sqlite_store or SQLiteStore(
            project_name,
            output_dir=str(self.project_dir),
            state_dir=self.state_dir,
        )
        self._share_sqlite_caches()
        self.cognee_embedding_model: str | None = None
        self.cognee_embedding_dimensions: int | None = None

    def __getattr__(self, name: str):
        """Lazily restore SQLiteStore for legacy/test objects built via __new__."""
        # TODO: remove this legacy __new__ compatibility path after old tests and
        # ad-hoc scripts construct CogneeStore through __init__ consistently.
        if name == "sqlite_store":
            return self._ensure_sqlite_store()
        raise AttributeError(f"{type(self).__name__!s} object has no attribute {name!r}")

    @property
    def _db(self):
        """Legacy read-only alias; the connection is owned by SQLiteStore."""
        return getattr(self._ensure_sqlite_store(), "_db", None)

    @_db.setter
    def _db(self, value) -> None:
        """Legacy assignment sink for tests/scripts that construct via __new__."""
        if value is not None:
            self._ensure_sqlite_store()._db = value

    def _ensure_sqlite_store(self) -> SQLiteStore:
        """Return the project SQLiteStore, creating it for legacy objects if needed."""
        if "_characters" not in self.__dict__:
            self._characters = {}
        if "_episodes" not in self.__dict__:
            self._episodes = {}
        if "_props" not in self.__dict__:
            self._props = {}
        if "_alias_index" not in self.__dict__:
            self._alias_index = {}
        if "_owns_sqlite_store" not in self.__dict__:
            self._owns_sqlite_store = True
        store = self.__dict__.get("sqlite_store")
        if store is not None:
            return store

        project_name = self.__dict__.get("project_name", "")
        project_dir = self.__dict__.get("project_dir", "")
        if not project_dir:
            from novelvideo.config import ensure_project_dirs

            project_dir = ensure_project_dirs(project_name)["base"]
            self.project_dir = project_dir

        state_dir = self.__dict__.get("state_dir")
        if not state_dir:
            db_path = self.__dict__.get("db_path")
            state_dir = str(Path(db_path).parent) if db_path else str(project_dir)
            self.state_dir = state_dir
        if "db_path" not in self.__dict__:
            self.db_path = str(Path(state_dir) / "data.db")

        store = SQLiteStore(project_name, output_dir=str(project_dir), state_dir=str(state_dir))
        self.__dict__["sqlite_store"] = store
        self._share_sqlite_caches()
        return store

    def _share_sqlite_caches(self) -> None:
        """Make SQLiteStore and the current store share the same in-memory caches."""
        store = self.__dict__.get("sqlite_store")
        if store is None:
            return
        store._characters = self._characters
        store._episodes = self._episodes
        store._props = self._props
        store._alias_index = self._alias_index

    def _sync_sqlite_caches(self) -> None:
        """Sync the current SQLiteStore cache back to the shared cache."""
        store = self._ensure_sqlite_store()
        character_cache = dict(store._characters)
        episode_cache = dict(store._episodes)
        alias_cache = dict(store._alias_index)
        prop_cache = dict(store._props)
        self._characters.clear()
        self._characters.update(character_cache)
        self._episodes.clear()
        self._episodes.update(episode_cache)
        self._props.clear()
        self._props.update(prop_cache)
        self._alias_index.clear()
        self._alias_index.update(alias_cache)
        self._share_sqlite_caches()

    # Known style prefixes (used to clean historical data)
    _STYLE_PREFIXES = [
        "anime style,",
        "realistic style,",
        "chinese period drama style,",
    ]

    def _clean_style_prefix(self, prompt: str) -> str:
        """Strip the style prefix from base_prompt."""
        if not prompt:
            return prompt
        for prefix in self._STYLE_PREFIXES:
            if prompt.lower().startswith(prefix.lower()):
                return prompt[len(prefix) :].strip()
        return prompt

    @staticmethod
    def _normalize_alias_lookup(value: str) -> str:
        """Unify the alias lookup key to reduce mismatches caused by whitespace/case differences."""
        return " ".join((value or "").replace("\u3000", " ").strip().lower().split())

    @property
    def _cognee_enabled(self) -> bool:
        """Whether this project may touch Cognee, embeddings or the graph.

        Resolved lazily from the project's recorded track so that stores built
        without ``initialize()`` (legacy tests, ad-hoc scripts) are gated too.
        ``initialize()`` overwrites the cached value once it has decided.
        """
        cached = self.__dict__.get("_cognee_enabled_flag")
        if cached is None:
            cached = not is_structured_pipeline(self.__dict__.get("state_dir"))
            self.__dict__["_cognee_enabled_flag"] = cached
        return cached

    def _require_cognee(self, operation: str) -> None:
        """Fail loudly instead of silently falling back to the Cognee path.

        A fallback here would bind a structured project to an embedding model,
        which is the one outcome the second track exists to prevent.
        """
        if not self._cognee_enabled:
            raise KnowledgePipelineUnsupported(
                f"{operation} is unavailable for structured_v1 projects"
            )

    def embedding_model_scope(self):
        # Guarded as well as the public graph methods: entering the scope is how
        # an embedding binding gets created, so a caller reaching past the public
        # API must not be able to bind a structured project by accident.
        self._require_cognee("embedding model scope")
        model = getattr(self, "cognee_embedding_model", None)
        dimensions = getattr(self, "cognee_embedding_dimensions", None)
        if not model or dimensions is None:
            state_dir = getattr(self, "state_dir", None)
            if state_dir:
                binding = ensure_cognee_embedding_binding_in_state_dir(state_dir)
                model = binding.internal_model
                dimensions = binding.dimensions
            else:
                model = embedding_model_for_legacy_project()
            self.cognee_embedding_model = model
            self.cognee_embedding_dimensions = dimensions
        return project_embedding_model_scope(model, dimensions=dimensions)

    @staticmethod
    def _ensure_pipeline_run_succeeded(result, stage_name: str) -> None:
        """Require every Cognee pipeline run to report a completed status."""

        def truncate(value: Any, limit: int = 400) -> str:
            detail = str(value or "").strip() or "unknown error"
            if len(detail) > limit:
                detail = detail[:limit] + "..."
            return detail

        def read_field(value: Any, field_name: str, default: Any = None) -> Any:
            if isinstance(value, dict):
                return value.get(field_name, default)
            return getattr(value, field_name, default)

        def pipeline_status_text(status: Any) -> str:
            return str(getattr(status, "value", status) or "").strip()

        def is_completed_status(status: Any) -> bool:
            normalized = "".join(
                character
                for character in pipeline_status_text(status).lower()
                if character.isalnum()
            )
            return normalized in {
                "completed",
                "alreadycompleted",
                "pipelineruncompleted",
                "pipelinerunalreadycompleted",
                "datasetprocessingcompleted",
            }

        def nested_pipeline_failures(run: Any) -> List[str]:
            nested_failures: List[str] = []
            data_ingestion_info = read_field(run, "data_ingestion_info") or []
            if not isinstance(data_ingestion_info, Iterable) or isinstance(
                data_ingestion_info, (str, bytes)
            ):
                return nested_failures

            for item in data_ingestion_info:
                run_info = read_field(item, "run_info")
                if run_info is None:
                    continue
                status = read_field(run_info, "status")
                if is_completed_status(status):
                    continue
                status_text = pipeline_status_text(status) or "unknown status"
                payload = read_field(run_info, "payload")
                nested_failures.append(
                    f"{status_text}: {truncate(payload, limit=600)}"
                )
            return nested_failures

        if isinstance(result, dict):
            runs = list(result.values())
        elif isinstance(result, (list, tuple, set)):
            runs = list(result)
        else:
            runs = [result]

        if not runs:
            raise RuntimeError(f"{stage_name} failed: Cognee returned an empty result")

        errors: List[str] = []
        for run in runs:
            if run is None:
                errors.append(f"{stage_name} failed: Cognee returned an empty result")
                continue

            status = read_field(run, "status")
            payload = read_field(run, "payload")
            status_text = pipeline_status_text(status)
            nested = nested_pipeline_failures(run)
            if nested:
                detail = truncate(payload)
                detail = f"{detail}; data item failures: " + " | ".join(nested[:3])
                errors.append(f"{stage_name} failed ({status_text}): {detail}")
                continue
            if not is_completed_status(status):
                detail = truncate(payload)
                errors.append(
                    f"{stage_name} failed ({status_text or 'unknown status'}): {detail}"
                )

        if errors:
            raise RuntimeError("; ".join(errors))

    async def _run_cognee_pipeline_with_retry(
        self,
        *,
        stage_name: str,
        operation: Callable[[], Awaitable[Any]],
        log: Callable[[str], None],
    ) -> Any:
        """Run a Cognee pipeline stage once, retrying one transient failure.

        The retry is skipped under organization egress. A second attempt runs
        in the same request scope, so every submit it makes is a fresh
        occurrence with its own operation key — the durable ledger cannot tell
        it from new work and the organization pays twice for the batches that
        had already succeeded. Failing closed matches what this codebase
        already does with every other retry knob it can reach under
        organization egress (model_gateway_runtime.py:53-57 forces zero output
        retries, cognee/config.py:807 forces max_retries=0).
        """
        from novelvideo.model_gateway_runtime import current_model_gateway_context

        gateway_context = current_model_gateway_context()
        attempts = (
            1
            if gateway_context is not None and gateway_context.is_organization
            else 2
        )
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                async with cognee_pipeline_concurrency():
                    with self.embedding_model_scope():
                        result = await operation()
                self._ensure_pipeline_run_succeeded(result, stage_name)
                return result
            except Exception as exc:
                last_error = exc
                if attempt + 1 < attempts:
                    log(f"{stage_name} failed, preparing to retry (1/1): {exc}")
                    await asyncio.sleep(0)
                    continue
                raise

        if last_error is not None:
            raise last_error
        raise RuntimeError(f"{stage_name} failed: unknown error")

    async def _ensure_db(self):
        """Make sure the database connection is established.

        SQLite lifecycle and project-fact schema are owned by SQLiteStore.
        CogneeStore does not hold a raw SQLite connection.
        """
        store = self._ensure_sqlite_store()
        return await store._ensure_db()

    async def initialize(self):
        """Initialize the SQLite database and the Cognee configuration.

        structured_v1 projects degrade to a pure SQLite facade instead of raising: in production many
        runners and APIs (portraits, reference images, scripts, storyboards, videos, Freezone, etc.) only use
        this class as a SQLite facade and do not need the graph at all. A hard failure here would make those paths
        500 across the board on new projects. The graph capability itself is guarded separately by ``_require_cognee``.
        """
        # The track must be decided first, before deciding whether to bind the embedding:
        # ensure_cognee_embedding_binding_in_state_dir() backfills the binding for projects missing the field
        # and writes it back to project_config.json; once called it cannot be undone.
        if is_structured_pipeline(self.state_dir):
            self.__dict__["_cognee_enabled_flag"] = False
            await self._ensure_db()
            console.print(
                f"[dim]Storage layer initialized (structured_v1, no graph, db: {self.db_path})[/dim]"
            )
            return

        self.__dict__["_cognee_enabled_flag"] = True
        embedding_binding = ensure_cognee_embedding_binding_in_state_dir(self.state_dir)
        self.cognee_embedding_model = embedding_binding.internal_model
        self.cognee_embedding_dimensions = embedding_binding.dimensions
        init_cognee()

        # Initialize the project SQLite; the Cognee graph context is set up independently.
        await self._ensure_db()

        # Cognee's graph/vector contexts are task-local, while DramaClaw adds
        # the missing project-local base/relational contexts for Cognee 1.0.5.
        # Different projects can therefore initialize safely in Celery threads.
        with cognee_project_context(self.state_dir):
            try:
                with self.embedding_model_scope():
                    await setup()
            except Exception as e:
                # cognee 0.5.3 bug: repeated initialization raises "CREATE TABLE data already exists"
                if "already exists" in str(e):
                    pass
                else:
                    raise

            # Make sure the current user owns the dataset
            with preserve_st_env():
                from cognee.modules.pipelines.layers.resolve_authorized_user_datasets import (
                    resolve_authorized_user_datasets,
                )

            try:
                with self.embedding_model_scope():
                    await resolve_authorized_user_datasets(datasets=self.dataset_name)
            except Exception as e:
                if "UNIQUE constraint failed: datasets.id" in str(e):
                    pass
                else:
                    console.print(
                        f"[yellow]⚠️ dataset permission registration failed (non-fatal): {e}[/yellow]"
                    )

        console.print(
            f"[dim]Storage layer initialized (dataset: {self.dataset_name}, db: {self.db_path})[/dim]"
        )

    async def close(self) -> None:
        """Release the project-scoped SQLite resource."""
        if self.__dict__.get("_owns_sqlite_store", True):
            await self._ensure_sqlite_store().close()

    # ============================================================
    # Content storage (replaces Redis)
    # ============================================================

    def save_novel_content(self, content: str) -> None:
        """Save the original novel text to a file."""
        self.sqlite_store.save_novel_content(content)
        novel_path = Path(self.project_dir) / "novel.txt"
        print(f"[store] Original text saved: {novel_path} ({len(content)} chars)")

    def load_novel_content(self) -> Optional[str]:
        """Load the original novel text from a file."""
        return self.sqlite_store.load_novel_content()

    async def save_episode_content(self, ep_num: int, content: str) -> None:
        """Save single-episode content to SQLite episodes.raw_content."""
        await self.sqlite_store.save_episode_content(ep_num, content)

    async def load_episode_content(self, ep_num: int) -> Optional[str]:
        """Load single-episode content from SQLite."""
        return await self.sqlite_store.load_episode_content(ep_num)

    async def get_episode_content_count(self) -> int:
        """Get the number of episodes that have original content."""
        return await self.sqlite_store.get_episode_content_count()

    async def clear_episode_contents(self) -> int:
        """Clear the original content of all episodes."""
        return await self.sqlite_store.clear_episode_contents()

    # ============================================================
    # Import and extraction
    # ============================================================

    async def ingest_novel_fast(
        self,
        novel_path: str,
        rebuild: bool = False,
        spine_template: str | None = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> dict:
        """Quick import, exclusively holding the Cognee/Ladybug graph of the current project."""
        self._require_cognee("Cognee graph ingest")
        async with ladybug_graph_access(self.state_dir, read_only=False):
            return await self._ingest_novel_fast_locked(
                novel_path,
                rebuild=rebuild,
                spine_template=spine_template,
                on_progress=on_progress,
                on_log=on_log,
            )

    async def _ingest_novel_fast_locked(
        self,
        novel_path: str,
        rebuild: bool = False,
        spine_template: str | None = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> dict:
        """Build the Cognee graph inside the project graph lock, without extracting characters/episodes."""

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        if not Path(novel_path).exists():
            raise FileNotFoundError(f"File not found: {novel_path}")

        from .config import init_cognee

        report(
            INGEST_PROGRESS_MILESTONES["read"],
            lmsg("tasks.progress.ingest.reading", "Reading and validating the original text..."),
        )
        log(
            lmsg(
                "tasks.log.ingest.readingFile",
                f"Reading file: {novel_path}",
                path=str(novel_path),
            )
        )
        content = load_novel_text(novel_path)
        if not content.strip():
            raise ValueError("The novel content is empty and cannot be imported")
        log(
            lmsg(
                "tasks.log.ingest.readComplete",
                f"File read complete: {len(content)} chars",
                charCount=len(content),
            )
        )
        self._novel_content = content

        if str(spine_template or "").strip() == "drama":
            from novelvideo.utils.screenplay_quality import (
                assess_screenplay_scene_headers,
            )

            if assess_screenplay_scene_headers(content).status == "missing":
                raise ValueError("A premium drama screenplay must include scene headings; add them and re-import")

        os.environ["COGNEE_TELEMETRY_ENABLED"] = "false"

        if not os.getenv("LLM_API_KEY") and not os.getenv("OPENAI_API_KEY"):
            raise ValueError(
                "LLM API key is not set. Add this to the .env file:\n" "  OPENAI_API_KEY=your_key_here"
            )

        if rebuild:
            report(INGEST_PROGRESS_MILESTONES["prune"], "Cleaning up the old graph...")
            # novel.txt is the persistent flag the frontend and later pipelines use to decide "already imported". The old graph is
            # about to be cleared, so the old flag must be invalidated first: even if cleanup fails midway, success must not keep being shown.
            imported_novel_path = Path(self.project_dir) / "novel.txt"
            imported_novel_path.unlink(missing_ok=True)
            delete_graph_preview(self.state_dir)
            log("Clearing cognee graph data...")
            await self._prune_cognee_only()

        # On rebuild, the old storage must be cleaned up before initializing the Cognee database connection.
        init_cognee()

        # Step 1: add the original text to Cognee
        report(INGEST_PROGRESS_MILESTONES["parse"], "Parsing the original text...")
        log("Step 1/3: importing the original text into Cognee...")
        await self._run_cognee_pipeline_with_retry(
            stage_name="Source import",
            operation=lambda: cognee.add(content, dataset_name=self.dataset_name),
            log=log,
        )
        log("Source import complete")
        report(INGEST_PROGRESS_MILESTONES["parsed"], "Original text parsed")
        await asyncio.sleep(0)

        # Step 2: build the knowledge graph
        report(INGEST_PROGRESS_MILESTONES["graph"], "Building the knowledge graph...")
        log("Step 2/3: building the knowledge graph (this may take a few minutes)...")
        await self._run_cognee_pipeline_with_retry(
            stage_name="Knowledge graph build",
            operation=lambda: cognee.cognify(datasets=[self.dataset_name]),
            log=log,
        )
        log("Knowledge graph build complete")

        if not await self._dataset_graph_has_nodes():
            raise RuntimeError("Knowledge graph build failed: no graph nodes were generated")
        log("Knowledge graph validation complete")
        report(INGEST_PROGRESS_MILESTONES["graph_validated"], "Knowledge graph validated")

        # Step 3: create the vector index (memify)
        report(INGEST_PROGRESS_MILESTONES["index"], "Creating the vector index...")
        log("Step 3/3: creating the vector index (used for triple retrieval)...")
        await self._run_cognee_pipeline_with_retry(
            stage_name="Vector index creation",
            operation=lambda: cognee.memify(dataset=self.dataset_name),
            log=log,
        )
        log("Vector index creation complete")
        report(INGEST_PROGRESS_MILESTONES["indexed"], "Vector index created")

        # API workers render this bounded sidecar and never open Ladybug merely
        # for graph visualization.  Persist it before novel.txt, because the
        # latter is the public "import succeeded" marker.
        report(INGEST_PROGRESS_MILESTONES["preview"], "Generating the graph preview...")
        await self.materialize_graph_preview()
        log("Knowledge graph preview saved")
        report(INGEST_PROGRESS_MILESTONES["preview_saved"], "Graph preview saved")

        # Persist the original text only after the graph build succeeds: on failure no "already imported" trace is left behind.
        # /chapters decides "import complete" purely from the stored original text; if it were persisted earlier, a cognify/memify failure
        # would still make the UI wrongly report a successful import and lock the re-upload entry.
        report(INGEST_PROGRESS_MILESTONES["save"], "Saving the import result...")
        self.save_novel_content(content)
        log("Original text saved to file")

        report(INGEST_PROGRESS_MILESTONES["complete"], "Import complete")

        return {
            "char_count": len(content),
            "dataset": self.dataset_name,
            "status": "graph_ready",
        }

    async def materialize_graph_preview(self, max_nodes: int = 48) -> dict:
        self._require_cognee("graph preview")
        async with ladybug_graph_access(self.state_dir, read_only=True):
            snapshot = await self.get_graph_snapshot(max_nodes=max_nodes)
            if not snapshot.get("nodes"):
                raise RuntimeError("Knowledge graph preview generation failed: no graph nodes were read")
            write_graph_preview(self.state_dir, snapshot)
            return snapshot

    async def get_graph_snapshot(self, max_nodes: int = 48) -> dict:
        """Return a bounded, JSON-safe snapshot for the project graph viewer.

        Cognee's graph may contain large chunk payloads and embedding metadata. The
        viewer needs topology and concise human-readable properties, not the raw
        storage representation, so this method ranks connected nodes and strips
        oversized or vector-shaped values before returning them to the browser.
        """

        self._require_cognee("graph snapshot")
        max_nodes = max(20, min(int(max_nodes), 80))
        max_edges = min(max_nodes * 3, 160)
        raw_nodes, raw_edges = await self._get_dataset_graph_data(
            max_nodes=max_nodes,
            max_edges=max_edges,
        )
        degree: Dict[str, int] = {}
        for source, target, _relation, _properties in raw_edges:
            source_id = str(source)
            target_id = str(target)
            degree[source_id] = degree.get(source_id, 0) + 1
            degree[target_id] = degree.get(target_id, 0) + 1

        type_priority = {
            "Entity": 6,
            "EntityType": 5,
            "TextSummary": 4,
            "Document": 3,
            "DocumentChunk": 1,
        }

        ranked_nodes = sorted(
            raw_nodes,
            key=lambda item: (
                degree.get(str(item[0]), 0) * 10
                + type_priority.get(str((item[1] or {}).get("type") or ""), 2) * 3
                + int(bool((item[1] or {}).get("name")))
            ),
            reverse=True,
        )[:max_nodes]
        selected_ids = {str(node_id) for node_id, _properties in ranked_nodes}

        def compact(value: Any, *, depth: int = 0) -> Any:
            if value is None or isinstance(value, (bool, int, float)):
                return value
            if isinstance(value, (UUID, date, datetime)):
                return str(value)
            if isinstance(value, str):
                return value if len(value) <= 500 else value[:497] + "..."
            if depth >= 2:
                return str(value)[:500]
            if isinstance(value, (list, tuple, set)):
                return [compact(item, depth=depth + 1) for item in list(value)[:12]]
            if isinstance(value, dict):
                result = {}
                for key, item in list(value.items())[:16]:
                    key_text = str(key)
                    if any(token in key_text.lower() for token in ("embedding", "vector")):
                        continue
                    result[key_text] = compact(item, depth=depth + 1)
                return result
            return str(value)[:500]

        nodes = []
        for node_id, properties in ranked_nodes:
            props = dict(properties or {})
            node_type = str(props.pop("type", "Unknown") or "Unknown")
            label = str(props.pop("name", "") or node_id)
            nodes.append(
                {
                    "id": str(node_id),
                    "label": label[:160],
                    "type": node_type[:80],
                    "degree": degree.get(str(node_id), 0),
                    "properties": compact(props),
                }
            )

        edges = []
        for index, (source, target, relation, properties) in enumerate(raw_edges):
            source_id = str(source)
            target_id = str(target)
            if source_id not in selected_ids or target_id not in selected_ids:
                continue
            edges.append(
                {
                    "id": f"{source_id}:{target_id}:{index}",
                    "source": source_id,
                    "target": target_id,
                    "relation": str(relation or "related_to")[:120],
                    "properties": compact(properties or {}),
                }
            )
            if len(edges) >= max_edges:
                break

        return {
            "nodes": nodes,
            "edges": edges,
            "total_nodes": len(raw_nodes),
            "total_edges": len(raw_edges),
            "truncated": len(raw_nodes) >= max_nodes or len(raw_edges) >= max_edges,
        }

    async def _get_dataset_graph_data(
        self,
        *,
        max_nodes: int = 48,
        max_edges: int = 144,
    ) -> tuple[list, list]:
        """Read a bounded preview through Cognee's project dataset context.

        With backend access control enabled, Cognee stores each dataset in its
        own graph database. Calling ``get_graph_engine()`` without first setting
        that dataset context opens the empty global graph instead of the graph
        populated by ``cognify()``. The ingest UI is only a visual preview, so
        querying the complete graph here would make large novels unnecessarily
        expensive and could block the API worker.
        """

        with preserve_st_env():
            from cognee.context_global_variables import (
                set_database_global_context_variables,
            )
            from cognee.infrastructure.databases.graph import get_graph_engine
            from cognee.modules.data.methods import get_datasets_by_name
            from cognee.modules.users.methods import get_default_user

        user = await get_default_user()
        datasets = await get_datasets_by_name(self.dataset_name, user.id)
        if not datasets:
            return [], []

        dataset = datasets[0]
        async with set_database_global_context_variables(dataset.id, dataset.owner_id):
            graph_engine = await get_graph_engine()
            query = getattr(graph_engine, "query", None)
            if not callable(query):
                # Compatibility fallback for graph adapters that only expose
                # Cognee's all-graph interface.
                nodes, edges = await graph_engine.get_graph_data()
                return nodes[:max_nodes], edges[:max_edges]

            max_nodes = max(1, min(int(max_nodes), 80))
            max_edges = max(1, min(int(max_edges), 160))
            edge_rows = await query(
                f"""
                    MATCH (n:Node)-[r]->(m:Node)
                    WHERE n.type <> 'DocumentChunk' AND m.type <> 'DocumentChunk'
                    RETURN n.id, n.name, n.type, n.properties,
                           m.id, m.name, m.type, m.properties,
                           r.relationship_name, r.properties
                    LIMIT {max_edges}
                """
            )
            node_rows = await query(
                f"""
                    MATCH (n:Node)
                    WHERE n.type <> 'DocumentChunk'
                    RETURN n.id, n.name, n.type, n.properties
                    LIMIT {max_nodes}
                """
            )

            def parse_properties(raw: Any) -> dict:
                if not raw:
                    return {}
                if isinstance(raw, dict):
                    return dict(raw)
                if isinstance(raw, str):
                    try:
                        parsed = json.loads(raw)
                        return parsed if isinstance(parsed, dict) else {}
                    except (TypeError, json.JSONDecodeError):
                        return {}
                return {}

            nodes_by_id: dict[str, dict] = {}

            def add_node(row: Any, offset: int = 0) -> None:
                if (
                    not row
                    or len(row) < offset + 4
                    or not row[offset]
                    or len(nodes_by_id) >= max_nodes
                ):
                    return
                node_id = str(row[offset])
                nodes_by_id.setdefault(
                    node_id,
                    {
                        "name": row[offset + 1],
                        "type": row[offset + 2],
                        **parse_properties(row[offset + 3]),
                    },
                )

            # Take connected endpoints first so the preview remains a useful
            # subgraph instead of a collection of unrelated nodes.
            for row in edge_rows:
                add_node(row)
                add_node(row, 4)
            for row in node_rows:
                add_node(row)

            selected_ids = set(nodes_by_id)
            edges = []
            for row in edge_rows:
                if not row or len(row) < 10:
                    continue
                source_id = str(row[0])
                target_id = str(row[4])
                if source_id not in selected_ids or target_id not in selected_ids:
                    continue
                edges.append(
                    (
                        source_id,
                        target_id,
                        str(row[8] or "related_to"),
                        parse_properties(row[9]),
                    )
                )
            nodes = list(nodes_by_id.items())
            return nodes, edges

    async def _dataset_graph_has_nodes(self) -> bool:
        """Check graph existence without loading every node and edge."""
        with preserve_st_env():
            from cognee.context_global_variables import (
                set_database_global_context_variables,
            )
            from cognee.infrastructure.databases.graph import get_graph_engine
            from cognee.modules.data.methods import get_datasets_by_name
            from cognee.modules.users.methods import get_default_user

        user = await get_default_user()
        datasets = await get_datasets_by_name(self.dataset_name, user.id)
        if not datasets:
            return False

        dataset = datasets[0]
        async with set_database_global_context_variables(dataset.id, dataset.owner_id):
            graph_engine = await get_graph_engine()
            return not await graph_engine.is_empty()

    async def build_characters_from_graph(
        self,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelCharacter]:
        """Supplement characters from the graph (step 2 of the staged architecture).

        The graph build is only responsible for discovering missing base characters. Existing characters may already have user edits,
        identity graphs, voices and asset configuration, and must not be overwritten by a single graph rescan.
        """
        self._require_cognee("graph character build")
        from .pipeline import extract_characters_from_graph

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        novel_text = require_imported_novel(self.project_dir)
        report(0.1, "Extracting character nodes from the graph...")
        log("Extracting character candidates from the graph...")
        with self.embedding_model_scope():
            characters = await extract_characters_from_graph(
                dataset_name=self.dataset_name,
                project_name=self.project_name,
                project_dir=str(self.project_dir),
                state_dir=self.state_dir,
                novel_text=novel_text,
                on_progress=lambda p, t: report(0.1 + p * 0.6, t),
            )

        if not characters:
            log("⚠️ Graph extraction returned nothing; keeping existing character data")
            report(1.0, "Extraction returned nothing")
            return []

        log(f"Extracted {len(characters)} characters from the graph")

        report(0.8, "Saving newly added characters...")
        log("Saving newly added characters to the database...")
        added: list[NovelCharacter] = []
        skipped = 0
        for char in characters:
            if self.get_character(char.name):
                skipped += 1
                continue
            await self.add_character(char)
            added.append(char)
        log(f"Added {len(added)} characters, skipped {skipped} existing")

        report(1.0, "Character extraction complete")
        log(f"Character extraction complete: {len(added)} added, {skipped} existing")

        return added

    async def _delete_old_characters(self) -> int:
        """Delete all characters."""
        await self._ensure_db()
        return await self.sqlite_store.delete_all_characters()

    async def build_episodes(
        self,
        target_episodes: int = 10,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelEpisode]:
        """Plan episodes (step 3 of the staged architecture)."""
        from .pipeline import extract_episodes_with_characters

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        # Get the original text
        log(lmsg("tasks.log.source.loading", "Loading the original text from file..."))
        novel_content = require_imported_novel(self.project_dir)
        log(
            lmsg(
                "tasks.log.source.loaded",
                f"Original text loaded: {len(novel_content)} chars",
                charCount=len(novel_content),
            )
        )

        # Get the confirmed character list
        character_names = list(self._characters.keys())
        log(f"Known characters: {len(character_names)}")

        # P1: planning
        report(0.1, "Planning episodes...")
        log(f"Planning {target_episodes} episodes...")

        episodes = await extract_episodes_with_characters(
            novel_content,
            target_episodes=target_episodes,
            known_characters=character_names,
            dataset_name=self.dataset_name,
            project_name=self.project_name,
        )

        log(f"LLM returned {len(episodes)} episodes")

        # P2: atomically replace the old plan. Deletion and writing must complete in the same transaction, to avoid
        # being left with an empty episodes table after a task cancellation or Worker exit.
        old_episode_count = len(self._episodes)
        report(0.85, "Saving new episodes...")
        log("Saving new episodes to the database...")
        await self.replace_episodes(episodes)
        log(f"Atomically replaced {old_episode_count} old episodes")

        if len(self._episodes) != len(episodes):
            log(f"⚠️ Warning: in-memory cache ({len(self._episodes)}) is inconsistent with the returned result ({len(episodes)})")

        report(1.0, "Episode planning complete")
        log(f"Episode planning complete: {len(episodes)} episodes, numbers: {list(self._episodes.keys())}")

        return episodes

    async def build_episodes_from_chapters(
        self,
        novel_text: str = None,
        generate_metadata: bool = False,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelEpisode]:
        """Create episodes from the novel chapter structure (chapter-mapping mode).

        Chapter mapping reads the source text and writes SQLite; it never
        touches the graph, so the implementation lives on SQLiteStore where
        both tracks can reach it. This stays as a delegate so legacy callers
        and the in-memory episode cache behave exactly as before.
        """
        episodes = await self.sqlite_store.build_episodes_from_chapters(
            novel_text=novel_text,
            generate_metadata=generate_metadata,
            on_progress=on_progress,
            on_log=on_log,
        )
        self._sync_sqlite_caches()
        return episodes

    async def build_episodes_from_events(
        self,
        target_episodes: int,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelEpisode]:
        """Event-based episode planning (supports chapter splitting)."""
        from novelvideo.cognee.chapter_detector import ChapterDetector
        from novelvideo.cognee.event_extractor import EventExtractor

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        # 1. Load the original text and detect chapters
        log(lmsg("tasks.log.source.loading", "Loading the original text from file..."))
        novel_text = require_imported_novel(self.project_dir)

        log(
            lmsg(
                "tasks.log.source.loaded",
                f"Original text loaded: {len(novel_text)} chars",
                charCount=len(novel_text),
            )
        )

        # Clean up episode content
        await self.clear_episode_contents()

        report(0.1, "Detecting chapter structure...")
        detector = ChapterDetector()
        chapters = detector.detect(novel_text)

        if not chapters:
            raise ValueError("No chapter markers detected; please use chapter-mapping mode")

        log(f"Detected {len(chapters)} chapters, target {target_episodes} episodes")

        # Extract all events
        extractor = EventExtractor()
        all_events: List[NovelEvent] = []

        for i, chapter in enumerate(chapters):
            progress = 0.1 + 0.3 * (i / len(chapters))
            report(progress, f"Extracting events of chapter {chapter.number}...")

            events = await extractor.extract_events(
                chapter_num=chapter.number,
                chapter_content=chapter.content,
                on_log=log,
            )
            all_events.extend(events)
            log(f"Chapter {chapter.number}: {len(events)} events")

        log(f"Extracted {len(all_events)} events in total")

        # Events are kept in memory (no longer written to Redis)
        report(0.45, "Storing events...")

        # AI assigns events to episodes
        report(0.5, "AI planning episode assignment...")
        log("AI assigning events to episodes...")
        episode_assignments = await self._assign_events_to_episodes(
            all_events, target_episodes, on_log=log
        )

        # Create NovelEpisode and merge the original text
        episodes = []
        for ep_num, event_ids in episode_assignments.items():
            progress = 0.7 + 0.1 * (ep_num / target_episodes)
            report(progress, f"Creating episode {ep_num}...")

            ep_events = [e for e in all_events if e.event_id in event_ids]

            if not ep_events:
                log(f"⚠️ Episode {ep_num} was assigned no events, skipping")
                continue

            combined_content = "\n\n---\n\n".join(e.content for e in ep_events if e.content)

            key_events = [e.description for e in ep_events]
            characters = list(set(c for e in ep_events for c in e.characters))

            chapter_nums = [e.chapter_num for e in ep_events]
            chapter_start = min(chapter_nums) if chapter_nums else 0
            chapter_end = max(chapter_nums) if chapter_nums else 0

            episode = NovelEpisode(
                number=ep_num,
                title=f"Episode {ep_num}",
                chapter_start=chapter_start,
                chapter_end=chapter_end,
                raw_content=combined_content,
                event_ids=event_ids,
                content_summary=(
                    combined_content[:2000] + "..."
                    if len(combined_content) > 2000
                    else combined_content
                ),
                key_events=key_events,
                character_names=characters,
                cliffhanger=ep_events[-1].description if ep_events else "",
            )
            episodes.append(episode)

        # P2: atomically replace episodes together with their corresponding original text.
        old_episode_count = len(self._episodes)
        report(0.88, "Saving to the database...")
        await self.replace_episodes(episodes)
        log(f"Atomically replaced {old_episode_count} old episodes")

        report(1.0, "Event-level planning complete")
        log(f"Event-level planning complete: {len(episodes)} episodes")

        return episodes

    async def _assign_events_to_episodes(
        self,
        events: List[NovelEvent],
        target_episodes: int,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> Dict[int, List[str]]:
        """AI assigns events to episodes."""
        import json
        import litellm

        def log(msg: MessageLike):
            if on_log:
                on_log(msg)

        event_summaries = []
        for e in events:
            event_summaries.append(
                {
                    "id": e.event_id,
                    "description": e.description,
                    "characters": e.characters,
                    "causes": e.causes[:3] if e.causes else [],
                }
            )

        prompt = f"""Assign the following {len(events)} events to {target_episodes} episodes.

Event list:
{json.dumps(event_summaries, ensure_ascii=False, indent=2)}

Assignment principles:
1. Preserve causality: events linked by causes should be in the same or adjacent episodes where possible
2. Narrative completeness: each episode should have a complete small narrative arc
3. Balanced distribution: each episode should have roughly the same number of events (about {len(events) // target_episodes} on average)
4. Suspense: the last event of each episode should work as a cliffhanger
5. Assign in order: the order of events must not be shuffled

Return JSON in this format:
{{
    "assignments": {{
        "1": ["ch1_e1", "ch1_e2"],
        "2": ["ch1_e3", "ch2_e1"],
        ...
    }}
}}

Return JSON only, with nothing else."""

        try:
            log("Calling LLM to assign events...")
            response = await litellm.acompletion(
                model=os.environ.get("LLM_MODEL", "gpt-4o"),
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                response_format={"type": "json_object"},
                **get_newapi_structured_output_litellm_kwargs(),
            )

            result = json.loads(response.choices[0].message.content)
            assignments = {int(k): v for k, v in result.get("assignments", {}).items()}

            log(f"LLM assignment complete: {len(assignments)} episodes")
            return assignments

        except Exception as e:
            log(f"LLM assignment failed: {e}, using even distribution")
            assignments = {}
            events_per_episode = max(1, len(events) // target_episodes)
            for i, event in enumerate(events):
                ep_num = min(i // events_per_episode + 1, target_episodes)
                if ep_num not in assignments:
                    assignments[ep_num] = []
                assignments[ep_num].append(event.event_id)
            return assignments

    async def add_episodes(self, episodes: List[NovelEpisode]) -> None:
        """Batch-add episodes to SQLite."""
        await self.sqlite_store.add_episodes(episodes)
        self._sync_sqlite_caches()

    async def replace_episodes(self, episodes: List[NovelEpisode]) -> None:
        """Replace planned episodes in SQLite without writing them to Cognee."""
        await self.sqlite_store.replace_episodes(episodes)
        self._sync_sqlite_caches()

    async def ingest_novel(
        self,
        novel_path: str,
        rebuild: bool = False,
        target_episodes: int = 10,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> dict:
        """Import the novel text + extract characters + plan episodes."""

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        if not Path(novel_path).exists():
            raise FileNotFoundError(f"File not found: {novel_path}")

        console.print("[bold]Step 1/3: importing the original text and building the Cognee graph...[/bold]")
        fast_result = await self.ingest_novel_fast(
            novel_path,
            rebuild=rebuild,
            on_progress=lambda p, t: report(p * 0.3, t),
        )

        report(0.3, "Extracting characters...")
        console.print("[bold]Step 2/3: extracting characters from the graph...[/bold]")
        characters = await self.build_characters_from_graph(
            on_progress=lambda p, t: report(0.3 + p * 0.3, t),
        )

        report(0.6, "Planning episodes...")
        console.print("[bold]Step 3/3: planning episodes...[/bold]")
        from novelvideo.agents.episode_planner import EpisodePlannerAgent

        planner = EpisodePlannerAgent(self)
        episodes = await planner.plan_episodes(
            target_episodes=target_episodes,
            on_progress=lambda p, t: report(0.6 + p * 0.4, t),
        )
        await self.replace_episodes(episodes)

        report(1.0, "Import complete")

        return {
            "char_count": fast_result["char_count"],
            "dataset": fast_result["dataset"],
            "characters": len(characters),
            "episodes": len(episodes),
        }

    # ============================================================
    # Queries
    # ============================================================

    def resolve_name(self, name: str) -> str:
        """Resolve an alias to the primary name."""
        return self._alias_index.get(name, name)

    def get_cached_prop(self, name: str) -> Optional[NovelProp]:
        """Get a prop from the current cache (alias lookup supported)."""
        raw_name = str(name or "").strip()
        if not raw_name:
            return None
        prop = self._props.get(raw_name)
        if prop:
            return prop

        lookup = self._normalize_alias_lookup(raw_name)
        for candidate in self._props.values():
            if self._normalize_alias_lookup(candidate.name) == lookup:
                return candidate
            aliases = getattr(candidate, "aliases", []) or []
            if any(self._normalize_alias_lookup(alias) == lookup for alias in aliases):
                return candidate
        return None


    async def _normalize_scene_menu_items(
        self, scene_menu: Iterable[Any] | None
    ) -> list[SceneMenuItem]:
        """Delegate to the shared normalizer owned by SQLiteStore."""
        return await self.sqlite_store._normalize_scene_menu_items(scene_menu)

    def _normalize_prop_menu_items(
        self, prop_menu: Iterable[Any] | None
    ) -> list[PropMenuItem]:
        """Delegate to the shared normalizer owned by SQLiteStore."""
        return self.sqlite_store._normalize_prop_menu_items(prop_menu)

    def get_character(self, name: str) -> Optional[NovelCharacter]:
        """Get a character (aliases supported)."""
        primary = self.resolve_name(name)
        return self._characters.get(primary)

    def get_character_prompt(self, name: str) -> Optional[str]:
        """Get a character's face prompt (aliases supported)."""
        char = self.get_character(name)
        return char.face_prompt if char else None

    def get_episode(self, number: int) -> Optional[NovelEpisode]:
        """Get an episode."""
        return self._episodes.get(number)

    def get_all_characters(self) -> List[NovelCharacter]:
        """Get all characters."""
        return list(self._characters.values())

    def get_all_episodes(self) -> List[NovelEpisode]:
        """Get all episodes."""
        return sorted(self._episodes.values(), key=lambda e: e.number)

    async def search(self, query: str, mode: str = "graph", top_k: int = 10) -> str:
        """Semantic search."""
        self._require_cognee("graph search")
        async with ladybug_graph_access(self.state_dir, read_only=True):
            with preserve_st_env():
                from cognee.modules.data.exceptions.exceptions import DatasetNotFoundError

            mode_map = {
                "graph": SearchType.GRAPH_COMPLETION,
                "chunks": SearchType.CHUNKS,
                "triplet": SearchType.TRIPLET_COMPLETION,
                "context_ext": SearchType.GRAPH_COMPLETION_CONTEXT_EXTENSION,
                "summaries": SearchType.SUMMARIES,
                "graph_cot": SearchType.GRAPH_COMPLETION_COT,
            }
            search_type = mode_map.get(mode, SearchType.GRAPH_COMPLETION)

            try:
                with self.embedding_model_scope():
                    result = await cognee.search(
                        query_type=search_type,
                        query_text=query,
                        top_k=top_k,
                    )
            except DatasetNotFoundError:
                return "No relevant data yet; run cognee-ingest to import the novel first"
            except Exception as e:
                return f"Search error: {str(e)}"

        if isinstance(result, list):
            parts = []
            for item in result:
                if isinstance(item, dict):
                    parts.append(self._stringify_search_fragment(item.get("search_result", item)))
                elif hasattr(item, "model_dump"):
                    parts.append(self._stringify_search_fragment(item.model_dump()))
                else:
                    parts.append(self._stringify_search_fragment(item))
            return "\n".join(parts)
        return str(result)

    @classmethod
    def _stringify_search_fragment(cls, value) -> str:
        """Normalize heterogeneous Cognee search payloads into plain text."""
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n".join(
                fragment
                for fragment in (cls._stringify_search_fragment(item) for item in value)
                if fragment
            )
        if isinstance(value, dict):
            return json.dumps(value, ensure_ascii=False)
        if hasattr(value, "model_dump"):
            return json.dumps(value.model_dump(), ensure_ascii=False)
        return str(value)

    async def load_graph_state(self) -> None:
        """Load characters and episodes from SQLite into the in-memory cache."""
        print("[load_graph_state] Loading from SQLite...")
        try:
            await self.sqlite_store.load_graph_state()
            self._sync_sqlite_caches()
            props = await self.sqlite_store.list_props()

            self._props = {prop.name: prop for prop in props}

            for episode in self._episodes.values():
                episode.scene_menu = await self._normalize_scene_menu_items(episode.scene_menu)
                episode.prop_menu = self._normalize_prop_menu_items(episode.prop_menu)

            print(
                f"[load_graph_state] Load complete: characters={len(self._characters)}, episodes={len(self._episodes)}, props={len(self._props)}"
            )
        except Exception as e:
            print(f"[load_graph_state] Load failed: {e}, using empty data")
            self._characters.clear()
            self._episodes.clear()
            self._props.clear()
            self._alias_index.clear()
            self._share_sqlite_caches()

    # ============================================================
    # Add/update
    # ============================================================

    async def add_character(self, character: NovelCharacter):
        """Add a character to SQLite."""
        await self.sqlite_store.add_character(character)
        self._sync_sqlite_caches()

    async def update_character(self, name: str, **updates) -> None:
        """Update character attributes."""
        char = self.get_character(name)
        if not char:
            raise ValueError(f"Character {name} does not exist")

        for key, value in updates.items():
            if hasattr(char, key):
                setattr(char, key, value)

        if "aliases" in updates:
            updated_alias_index = {k: v for k, v in self._alias_index.items() if v != name}
            self._alias_index.clear()
            self._alias_index.update(updated_alias_index)
            for alias in char.aliases:
                self._alias_index[alias] = name

        # Re-save entire character
        await self.add_character(char)
        console.print(f"[green]Character updated: {name}[/green]")

    async def rename_character(self, old_name: str, new_name: str) -> None:
        """Rename a character."""
        await self.sqlite_store.rename_character(old_name, new_name)
        self._sync_sqlite_caches()

    async def delete_character(self, name: str) -> None:
        """Delete a character."""
        await self.sqlite_store.delete_character(name)
        self._sync_sqlite_caches()

    # ============================================================
    # Identity management
    # ============================================================

    async def add_character_identity(
        self,
        character_name: str,
        identity: CharacterIdentity,
    ) -> None:
        """Add a new identity to a character."""
        await self.sqlite_store.add_character_identity(character_name, identity)
        self._sync_sqlite_caches()

    async def update_character_identity(
        self,
        character_name: str,
        identity_id: str,
        **updates,
    ) -> None:
        """Update an identity of a character."""
        await self.sqlite_store.update_character_identity(character_name, identity_id, **updates)
        self._sync_sqlite_caches()

    async def delete_character_identity(
        self,
        character_name: str,
        identity_id: str,
    ) -> None:
        """Delete an identity of a character."""
        await self.sqlite_store.delete_character_identity(character_name, identity_id)
        self._sync_sqlite_caches()

    async def _cascade_identity_change(self, old_id: str, new_id: str | None = None):
        """Cascade-update identity_ids of all episodes."""
        for ep in self._episodes.values():
            ids = ep.identity_ids
            if old_id in ids:
                if new_id:
                    ids = [new_id if x == old_id else x for x in ids]
                else:
                    ids = [x for x in ids if x != old_id]
                # Column-level: renaming or deleting an identity can happen
                # while planning is running, and a whole-row write here would
                # discard whatever menu landed in between.
                await self.patch_episode(ep.number, identity_ids=ids)

    async def delete_identity_image(
        self,
        character_name: str,
        identity_id: str,
    ) -> bool:
        """Delete the identity image, keeping the identity itself."""
        char = self.get_character(character_name)
        if not char:
            raise ValueError(f"Character {character_name} does not exist")

        identities = char.identities
        target_identity = None
        for identity in identities:
            if identity.identity_id == identity_id:
                target_identity = identity
                break

        if not target_identity:
            raise ValueError(f"Identity {identity_id} does not exist")

        image_path = compute_identity_path(
            Path(self.project_dir),
            character_name,
            target_identity.identity_name,
        )
        if not image_path:
            console.print(f"[yellow]Identity {identity_id} has no image[/yellow]")
            return False

        image_file = Path(image_path)
        if image_file.exists():
            image_file.unlink()
            console.print(f"[green]Image file deleted: {image_path}[/green]")
            return True

        console.print(f"[yellow]Image file does not exist: {image_path}[/yellow]")
        return False

    def get_identity_for_alias(
        self,
        alias: str,
    ) -> Optional[CharacterIdentity]:
        """Get the identity matching an alias.

        Without episode context, only returns when the character has a single identity; for multi-identity characters the upper layer must provide an episode-level constraint.
        """
        char = self.get_character(alias)
        if not char:
            return None
        if len(char.identities) != 1:
            return None
        return char.identities[0]

    async def add_episode(self, episode: NovelEpisode):
        """Add a single episode."""
        await self.add_episodes([episode])
        self._episodes[episode.number] = episode

    async def patch_episode(self, episode_number: int, **fields) -> None:
        """Column-level update, delegated to SQLiteStore.

        The facade offers this so its own methods — the identity cascade among
        them — can write a single column without re-serialising the row, and so
        the shared cache is refreshed the same way whichever store a caller
        holds.
        """
        await self.sqlite_store.patch_episode(episode_number, **fields)
        refreshed = await self.sqlite_store.get_episode_from_graph(episode_number)
        if refreshed is not None:
            self._episodes[episode_number] = refreshed

    async def update_episode(self, episode_number: int, **updates) -> None:
        """Update episode attributes."""
        episode = self.get_episode(episode_number)
        if not episode:
            print(
                f"[update_episode] Episode {episode_number} is not in the _episodes cache! cache keys={list(self._episodes.keys())}",
                flush=True,
            )
            raise ValueError(f"Episode {episode_number} does not exist")

        old_number = episode.number
        persisted = await self.sqlite_store.get_episode_from_graph(episode_number)
        if persisted is not None:
            protected_fields = set(updates)
            if "scene_menu" in protected_fields:
                protected_fields.add("scene_menu_json")
            if "prop_menu" in protected_fields:
                protected_fields.add("prop_menu_json")
            if "identity_default_map" in protected_fields:
                protected_fields.add("identity_default_map_json")
            for field_name in type(episode).model_fields:
                if field_name not in protected_fields:
                    setattr(episode, field_name, getattr(persisted, field_name))

        print(
            f"[update_episode] ep{episode_number} before update: identity_ids={episode.identity_ids}, updates={list(updates.keys())}",
            flush=True,
        )

        for key, value in updates.items():
            if key == "scene_menu":
                episode.scene_menu = await self._normalize_scene_menu_items(value or [])
            elif key == "prop_menu":
                episode.prop_menu = self._normalize_prop_menu_items(value or [])
            elif hasattr(episode, key):
                setattr(episode, key, value)
            else:
                print(f"[update_episode] Warning: ep{episode_number} has no attribute {key}", flush=True)

        print(
            f"[update_episode] ep{episode_number} after update: identity_ids={episode.identity_ids}",
            flush=True,
        )

        new_number = updates.get("number", old_number)
        if new_number != old_number:
            del self._episodes[old_number]
            self._episodes[new_number] = episode

        await self.add_episodes([episode])
        console.print(f"[green]Episode updated: Episode {episode.number}[/green]")

    def get_sketch_colors(self, episode_number: int) -> dict:
        """Read sketch_colors from the episode."""
        return self.sqlite_store.get_sketch_colors(episode_number)

    async def set_sketch_colors(self, episode_number: int, colors: dict) -> None:
        """Write sketch_colors into the episode."""
        await self.sqlite_store.set_sketch_colors(episode_number, colors)
        self._sync_sqlite_caches()

    async def set_beat_detected_identities(
        self, episode_number: int, detections: dict[int, list[str]]
    ) -> int:
        """Batch-write the per-beat detected identities."""
        count = await self.sqlite_store.set_beat_detected_identities(episode_number, detections)
        print(f"[store] set_beat_detected_identities: ep{episode_number} updated {count} beats")
        return count

    async def set_beat_detected_props(
        self, episode_number: int, detections: dict[int, list[str]]
    ) -> int:
        """Batch-write the per-beat detected props."""
        count = await self.sqlite_store.set_beat_detected_props(episode_number, detections)
        print(f"[store] set_beat_detected_props: ep{episode_number} updated {count} beats")
        return count

    async def add_visual_beats(self, beats: List[NovelVisualBeat]):
        """Add a visual beat to SQLite (delegates to SQLiteStore)."""
        await self._ensure_db()
        await self.sqlite_store.add_visual_beats(beats)

    async def delete_beats_for_episode(self, episode_number: int) -> int:
        """Delete all Beats of the specified episode."""
        return await self._delete_old_beats_for_episode(episode_number)

    async def _delete_old_beats_for_episode(self, episode_number: int) -> int:
        """Delete all Beats of the specified episode."""
        deleted = await self.sqlite_store.delete_beats_for_episode(episode_number)
        if deleted > 0:
            console.print(f"[dim]Deleted {deleted} old Beats of episode {episode_number}[/dim]")
        return deleted

    # ============================================================
    # Scene: build from the graph
    # ============================================================

    async def build_scenes_from_graph(
        self,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelScene]:
        """Supplement base scenes from the Cognee graph.

        This only fills in missing base scenes; existing base scenes and derived plates are asset facts
        and must not be cleared or overwritten by a single graph rescan.
        """
        self._require_cognee("graph scene build")
        from .pipeline import extract_scenes_from_graph

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        require_imported_novel(self.project_dir)
        report(0.1, "Extracting scene nodes from the graph...")
        log("Extracting base scene candidates from the graph...")
        with self.embedding_model_scope():
            scenes = await extract_scenes_from_graph(
                dataset_name=self.dataset_name,
                project_name=self.project_name,
                project_dir=str(self.project_dir),
                state_dir=self.state_dir,
                on_progress=lambda p, t: report(0.1 + p * 0.6, t),
                on_log=on_log,
            )

        if not scenes:
            log("⚠️ Graph extraction returned nothing; keeping existing scene data")
            report(1.0, "Extraction returned nothing")
            return []

        log(f"Extracted {len(scenes)} scenes from the graph")
        report(0.8, "Saving newly added scenes...")
        log("Saving newly added scenes to the database...")
        from .pipeline import should_repair_scene_placeholder

        added: list[NovelScene] = []
        skipped = 0
        repaired = 0
        for scene in scenes:
            existing = await self.sqlite_store.get_scene(scene.name)
            if existing:
                # The contract validator used to reject valid single-line model
                # output, so every scene built while that bug was live stored a
                # generated placeholder instead. Those are not asset facts, and
                # skipping them would leave existing projects on boilerplate
                # forever. Only the prompt is rewritten: images, plates and any
                # other stored field stay untouched, and a prompt a user wrote
                # never carries the fingerprint.
                if should_repair_scene_placeholder(
                    existing.environment_prompt, scene.environment_prompt
                ):
                    await self.sqlite_store.update_scene(
                        existing.name, environment_prompt=scene.environment_prompt
                    )
                    repaired += 1
                    continue
                skipped += 1
                continue
            await self.sqlite_store.add_scene(scene)
            added.append(scene)
        log(
            f"Added {len(added)} scenes, repaired {repaired} placeholder descriptions, "
            f"skipped {skipped} existing"
        )

        report(1.0, "Scene extraction complete")
        log(
            f"Scene extraction complete: {len(added)} added, {repaired} repaired, "
            f"{skipped} existing"
        )

        return added

    # ============================================================
    # Prop: build from the graph
    # ============================================================

    async def build_props_from_graph(
        self,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelProp]:
        """Build props from the graph (step 2 of the staged architecture)."""
        self._require_cognee("graph prop build")
        from .pipeline import extract_props_from_graph

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        report(0.05, "Collecting existing prop data...")
        existing_prop_aliases: dict[str, list[str]] = {}
        canonical_prop_hints: set[str] = set()
        canonical_prop_alias_targets: dict[str, set[str]] = {}
        for prop in await self.sqlite_store.list_props():
            alias_list = list(prop.aliases or [])
            existing_prop_aliases[prop.name] = alias_list
            canonical_prop_hints.add(prop.name)
            normalized_name = self._normalize_alias_lookup(prop.name)
            canonical_prop_alias_targets.setdefault(normalized_name, set()).add(prop.name)
            for alias in alias_list:
                normalized_alias = self._normalize_alias_lookup(alias)
                if normalized_alias:
                    canonical_prop_alias_targets.setdefault(normalized_alias, set()).add(prop.name)
        canonical_prop_hints.update(
            item.prop_id
            for episode in self._episodes.values()
            for item in (episode.prop_menu or [])
            if getattr(item, "prop_id", "")
        )
        prop_assets_dir = Path(self.project_dir) / "assets" / "props"
        if prop_assets_dir.exists():
            canonical_prop_hints.update(
                entry.name
                for entry in prop_assets_dir.iterdir()
                if entry.is_dir() and entry.name.strip()
            )
        log(f"Collected {len(canonical_prop_hints)} existing prop hints")

        # P1: extract new props
        report(0.1, "Extracting prop nodes from the graph...")
        log("Extracting prop candidates from the graph...")
        novel_text = self.load_novel_content()
        if novel_text:
            log(f"Loaded the full original text to assist prop extraction: {len(novel_text)} chars")
        with self.embedding_model_scope():
            props = await extract_props_from_graph(
                dataset_name=self.dataset_name,
                project_name=self.project_name,
                project_dir=self.project_dir,
                state_dir=self.state_dir,
                novel_text=novel_text,
                on_progress=lambda p, t: report(0.1 + p * 0.6, t),
            )

        if not props:
            log("⚠️ Graph extraction returned nothing; keeping existing prop data")
            report(1.0, "Extraction returned nothing")
            return []

        log(f"Extracted {len(props)} props from the graph")

        # P1.5: keep existing more specific prop names, to avoid regressing to a generic name on rebuild (e.g. "office carton" -> "carton")
        used_prop_names: set[str] = set()
        for prop in props:
            if not prop.name:
                continue

            candidate_names: set[str] = set()
            normalized_prop_name = self._normalize_alias_lookup(prop.name)
            candidate_names.update(canonical_prop_alias_targets.get(normalized_prop_name, set()))
            for alias in prop.aliases or []:
                normalized_alias = self._normalize_alias_lookup(alias)
                if normalized_alias:
                    candidate_names.update(
                        canonical_prop_alias_targets.get(normalized_alias, set())
                    )

            candidates = sorted(
                [
                    candidate
                    for candidate in candidate_names
                    if candidate and candidate != prop.name and candidate not in used_prop_names
                ],
                key=len,
            )
            if len(candidates) == 1:
                original_name = prop.name
                prop.name = candidates[0]
                prop.aliases = list(
                    dict.fromkeys(
                        [
                            original_name,
                            *[
                                alias
                                for alias in (prop.aliases or [])
                                if alias and alias != candidates[0]
                            ],
                        ]
                    )
                )
                log(f"Keeping the existing more specific prop name: {original_name} -> {prop.name}")
            if prop.name in existing_prop_aliases:
                prop.aliases = list(
                    dict.fromkeys(
                        [
                            *prop.aliases,
                            *[
                                alias
                                for alias in existing_prop_aliases[prop.name]
                                if alias and alias != prop.name
                            ],
                        ]
                    )
                )
            used_prop_names.add(prop.name)
        report(0.8, "Cleaning up old prop data...")
        try:
            deleted = await self.sqlite_store.delete_all_props()
            log(f"Deleted {deleted} old props")
        except Exception as e:
            log(f"Failed to delete old props: {e}")

        report(0.85, "Saving new props...")
        log("Saving new props to the database...")
        for prop in props:
            await self.sqlite_store.add_prop(prop)
        log(f"Saved {len(props)} props")

        report(1.0, "Prop extraction complete")
        log(f"Prop extraction complete: {len(props)} props")

        return props

    async def attach_beats_to_episode(self, episode_number: int, beats: List[NovelVisualBeat]):
        """Associate visual beats with the specified episode (automatically linked via episode_number in SQLite)."""
        pass  # the beats table already has an episode_number foreign key

    async def persist_beats_from_script(self, episode_number: int, beats_data: List[dict]):
        """Persist Beats from script data."""
        existing_rows = await self.get_beats_for_episode(episode_number)
        existing_by_num = {beat.beat_number: beat for beat in existing_rows}
        await self._do_persist_beats(episode_number, beats_data, existing_by_num=existing_by_num)

    async def _patch_beats_missing_fields(
        self,
        episode_number: int,
        beats_data: List[dict],
    ) -> int:
        """Only update the missing fields of beats."""
        return await self.sqlite_store.patch_beats_missing_fields(episode_number, beats_data)

    async def _episode_asset_ref_scope(self, episode_number: int) -> tuple[set[str], set[str]]:
        episode = await self.get_episode_from_graph(episode_number)
        allowed_identity_ids = {
            str(identity_id or "").strip()
            for identity_id in (getattr(episode, "identity_ids", []) or [])
            if str(identity_id or "").strip()
        }
        if not allowed_identity_ids:
            for character in await self.list_characters():
                for identity in getattr(character, "identities", []) or []:
                    identity_id = str(getattr(identity, "identity_id", "") or "").strip()
                    if identity_id:
                        allowed_identity_ids.add(identity_id)

        allowed_prop_ids = {
            str(getattr(prop, "name", "") or "").strip()
            for prop in await self.sqlite_store.list_props()
            if str(getattr(prop, "name", "") or "").strip()
            and str(getattr(prop, "marker_color", "") or "").strip()
        }
        return allowed_identity_ids, allowed_prop_ids

    def _complete_generated_beat_refs(
        self,
        beat_payload: dict,
        *,
        allowed_identity_ids: set[str],
        allowed_prop_ids: set[str],
    ) -> dict:
        detected_identities, detected_props = complete_detected_refs_from_visual_description(
            visual_description=str(beat_payload.get("visual_description", "") or ""),
            detected_identities=beat_payload.get("detected_identities"),
            detected_props=beat_payload.get("detected_props"),
            allowed_identity_ids=allowed_identity_ids,
            allowed_prop_ids=allowed_prop_ids,
        )
        beat_payload["detected_identities_json"] = _json_list_payload(
            normalize_detected_identities(detected_identities)
        )
        beat_payload["detected_props_json"] = _json_list_payload(
            normalize_detected_props(detected_props)
        )
        return beat_payload

    async def _do_persist_beats(
        self,
        episode_number: int,
        beats_data: List[dict],
        existing_by_num: Dict[int, NovelVisualBeat] | None = None,
    ):
        """Actually perform Beat persistence."""
        existing_by_num = existing_by_num or {}
        keep_numbers = {
            int(b.get("beat_number", 0)) for b in beats_data if int(b.get("beat_number", 0))
        }
        manual_keep_numbers = {
            int(beat_number)
            for beat_number, beat in existing_by_num.items()
            if getattr(beat, "is_manual_shot", False)
        }
        keep_numbers |= manual_keep_numbers
        if keep_numbers:
            await self.sqlite_store.delete_beats_except(episode_number, keep_numbers)
        else:
            await self._delete_old_beats_for_episode(episode_number)
            return

        allowed_identity_ids, allowed_prop_ids = await self._episode_asset_ref_scope(episode_number)
        beats = []
        for b in beats_data:
            beat_payload = sync_beat_asset_refs(dict(b))
            beat_payload = self._complete_generated_beat_refs(
                beat_payload,
                allowed_identity_ids=allowed_identity_ids,
                allowed_prop_ids=allowed_prop_ids,
            )
            beat_number = int(beat_payload.get("beat_number", 0))
            existing = existing_by_num.get(beat_number)
            beats.append(
                NovelVisualBeat(
                    beat_number=beat_number,
                    episode_number=episode_number,
                    narration=beat_payload.get(
                        "narration_segment", existing.narration if existing else ""
                    ),
                    visual_description=beat_payload.get(
                        "visual_description",
                        existing.visual_description if existing else "",
                    ),
                    time_of_day=beat_payload.get(
                        "time_of_day", existing.time_of_day if existing else ""
                    )
                    or "",
                    detected_identities_json=(
                        beat_payload.get("detected_identities_json") or '["__NO_CHARACTER__"]'
                    ),
                    detected_props_json=(
                        beat_payload.get("detected_props_json") or '["__NO_PROP__"]'
                    ),
                    scene_ref_json=(
                        json.dumps(beat_payload.get("scene_ref"), ensure_ascii=False)
                        if beat_payload.get("scene_ref")
                        else ""
                    ),
                    audio_type=beat_payload.get(
                        "audio_type", existing.audio_type if existing else "narration"
                    ),
                    speaker=beat_payload.get("speaker", existing.speaker if existing else ""),
                    speaker_kind=beat_payload.get(
                        "speaker_kind",
                        existing.speaker_kind if existing else "character",
                    ),
                    video_mode=beat_payload.get(
                        "video_mode", existing.video_mode if existing else "first_frame"
                    ),
                    video_prompt=beat_payload.get(
                        "video_prompt", existing.video_prompt if existing else ""
                    )
                    or "",
                    keyframe_prompt=beat_payload.get(
                        "keyframe_prompt",
                        existing.keyframe_prompt if existing else "",
                    )
                    or "",
                    shot_order=(
                        beat_payload.get("shot_order")
                        if beat_payload.get("shot_order") is not None
                        else (existing.shot_order if existing else None)
                    ),
                    duration_seconds=(
                        beat_payload.get("duration_seconds")
                        if beat_payload.get("duration_seconds") is not None
                        else (existing.duration_seconds if existing else None)
                    ),
                    is_manual_shot=bool(
                        beat_payload.get(
                            "is_manual_shot",
                            existing.is_manual_shot if existing else False,
                        )
                    ),
                )
            )

        if beats:
            await self.add_visual_beats(beats)

    # ============================================================
    # Phase 2: assemble dict / persist NarrationScript
    # ============================================================

    async def get_script_as_dict(self, episode_number: int) -> Optional[Dict]:
        """Assemble a JSON-compatible script dict from SQLite, replacing load_script()."""
        return await self.sqlite_store.get_script_as_dict(episode_number)

    async def persist_narration_script(self, script) -> None:
        """Accept a NarrationScript, map VisualBeat fields to SQLite, delete old and insert new.

        Args:
            script: NarrationScript instance (from novelvideo.models)
        """
        allowed_identity_ids, allowed_prop_ids = await self._episode_asset_ref_scope(
            script.episode_number
        )
        beats = []
        for beat in script.beats:
            detected_identities, detected_props = complete_detected_refs_from_visual_description(
                visual_description=str(getattr(beat, "visual_description", "") or ""),
                detected_identities=getattr(beat, "detected_identities", None),
                detected_props=getattr(beat, "detected_props", None),
                allowed_identity_ids=allowed_identity_ids,
                allowed_prop_ids=allowed_prop_ids,
            )
            beats.append(
                NovelVisualBeat(
                    beat_number=beat.beat_number,
                    episode_number=script.episode_number,
                    narration=beat.narration_segment,
                    visual_description=beat.visual_description,
                    source_text_sha256=getattr(beat, "source_text_sha256", "") or "",
                    time_of_day=getattr(beat, "time_of_day", "") or "",
                    detected_identities_json=_json_list_payload(
                        normalize_detected_identities(detected_identities)
                    ),
                    detected_props_json=_json_list_payload(
                        normalize_detected_props(detected_props)
                    ),
                    scene_ref_json=(
                        json.dumps(
                            getattr(beat, "scene_ref", None).model_dump(), ensure_ascii=False
                        )
                        if getattr(beat, "scene_ref", None)
                        else ""
                    ),
                    audio_type=beat.audio_type,
                    speaker=beat.speaker,
                    speaker_kind=getattr(beat, "speaker_kind", "character"),
                    video_mode=getattr(beat, "video_mode", "first_frame"),
                    video_prompt=getattr(beat, "video_prompt", "") or "",
                    keyframe_prompt=getattr(beat, "keyframe_prompt", "") or "",
                )
            )

        if not beats:
            return

        await self.delete_beats_for_episode(script.episode_number)
        await self.add_visual_beats(beats)

    # ============================================================
    # SQLite helper methods
    # ============================================================

    async def _update_character_field(self, name: str, field: str, value: Any) -> bool:
        """Update a single field of a character."""
        updated = await self.sqlite_store._update_character_field(name, field, value)
        self._sync_sqlite_caches()
        return updated

    async def list_characters(self) -> List[NovelCharacter]:
        """List all characters."""
        return await self.sqlite_store.list_characters()

    async def list_episodes(self) -> List[NovelEpisode]:
        """List all episodes."""
        return await self.sqlite_store.list_episodes()

    async def list_visual_beats(self) -> List[NovelVisualBeat]:
        """List all visual beats."""
        return await self.sqlite_store.list_visual_beats()

    async def list_beat_asset_refs(self) -> List[BeatAssetRefRow]:
        """Asset reference fields of each beat (only six columns, without constructing Beat objects)."""
        return await self.sqlite_store.list_beat_asset_refs()

    async def get_character_from_graph(self, name: str) -> Optional[NovelCharacter]:
        """Get a character from SQLite (compatible with the old interface name)."""
        return await self.sqlite_store.get_character_from_graph(name)

    async def get_episode_from_graph(self, number: int) -> Optional[NovelEpisode]:
        """Get an episode from SQLite (compatible with the old interface name)."""
        return await self.sqlite_store.get_episode_from_graph(number)

    async def count_beats_by_episode(self) -> Dict[int, int]:
        """Beat count of each episode (one grouped query, without constructing Beat objects)."""
        return await self.sqlite_store.count_beats_by_episode()

    async def get_beats_for_episode(self, number: int) -> List[NovelVisualBeat]:
        """Get all Beats of the specified episode."""
        return await self.sqlite_store.get_beats_for_episode(number)

    async def get_beats_as_dicts(self, episode_number: int) -> List[Dict[str, Any]]:
        """Get Beats from SQLite, returning a list of dicts compatible with the JSON format."""
        return await self.sqlite_store.get_beats_as_dicts(episode_number)

    async def get_beat_prompts(
        self,
        episode_number: int,
        beat_number: int | None = None,
    ) -> Dict[str, Optional[str]]:
        """Get the video prompt fields of a single Beat."""
        return await self.sqlite_store.get_beat_prompts(episode_number, beat_number)

    async def update_beat_asset(
        self,
        episode_number: int,
        beat_number: int = None,
        narration_segment: str = None,
        visual_description: str = None,
        audio_type: str = None,
        speaker: str = None,
        detected_identities: list = None,
        detected_props: list = None,
        scene_ref: dict = None,
        video_mode: str = None,
        video_prompt: str = None,
        keyframe_prompt: str = None,
        seedance2_config_json: str = None,
        time_of_day: str = None,
        shot_order: int | None = None,
        duration_seconds: float | None = None,
        is_manual_shot: bool | None = None,
        multishot_chain_id: str | None = None,
    ) -> bool:
        """Update the resource fields of a Beat."""
        return await self.sqlite_store.update_beat_asset(
            episode_number=episode_number,
            beat_number=beat_number,
            narration_segment=narration_segment,
            visual_description=visual_description,
            audio_type=audio_type,
            speaker=speaker,
            detected_identities=detected_identities,
            detected_props=detected_props,
            scene_ref=scene_ref,
            video_mode=video_mode,
            video_prompt=video_prompt,
            keyframe_prompt=keyframe_prompt,
            seedance2_config_json=seedance2_config_json,
            time_of_day=time_of_day,
            shot_order=shot_order,
            duration_seconds=duration_seconds,
            is_manual_shot=is_manual_shot,
            multishot_chain_id=multishot_chain_id,
        )

    async def delete_manual_beat(self, episode_number: int, beat_number: int) -> bool:
        """Delete a single manual storyboard beat (only deleted when is_manual_shot=1)."""
        return await self.sqlite_store.delete_manual_beat(episode_number, beat_number)

    def format_character_context(self, character: NovelCharacter) -> str:
        aliases = ", ".join(character.aliases) if character.aliases else "none"
        lines = [
            f"## {character.name}",
            f"- Role: {character.role or 'unknown'}",
            f"- Gender: {character.gender or 'unknown'}",
            f"- Aliases: {aliases}",
        ]
        if character.description:
            lines.append(f"- Description: {character.description}")
        if character.face_prompt:
            lines.append(f"- Face prompt: {character.face_prompt}")
        if character.identities:
            lines.append("- Available identities:")
            lines.append(f"  - character_name: {character.name}")
            lines.append("  - Selectable identity_id:")
            for identity in character.identities:
                desc = ""
                if identity.appearance_details:
                    desc = (
                        f" ({identity.appearance_details[:50]}...)"
                        if len(identity.appearance_details) > 50
                        else f" ({identity.appearance_details})"
                    )
                lines.append(f"    - {identity.identity_id}{desc}")

        return "\n".join(lines)

    def format_episode_context(self, episode: NovelEpisode) -> str:
        lines = [
            f"## Episode {episode.number}: {episode.title}",
            f"- Content summary: {episode.content_summary}",
            f"- Main conflict: {episode.main_conflict}",
            f"- Key events: {', '.join(episode.key_events) if episode.key_events else 'none'}",
            f"- Characters present: {', '.join(episode.character_names) if episode.character_names else 'unknown'}",
        ]
        if episode.cliffhanger:
            lines.append(f"- Cliffhanger: {episode.cliffhanger}")
        return "\n".join(lines)

    async def _prune_cognee_only(self):
        """Clear only the cognee graph data, keeping the SQLite data."""
        # Clean up cognee_system (contains LanceDB vectors, the Kuzu graph and cognee metadata)
        import shutil

        cognee_dir = os.path.join(self.state_dir, "cognee_system")
        if os.path.exists(cognee_dir):
            shutil.rmtree(cognee_dir)
            console.print(f"[green]Cleaned cognee data: {cognee_dir}[/green]")

    async def delete_project_data(self):
        """Delete all SQLite data of the current project."""
        try:
            await self.sqlite_store.delete_project_data()
            self._sync_sqlite_caches()

            console.print(f"[green]Deleted all data of project '{self.project_name}'[/green]")
        except Exception as e:
            console.print(f"[red]Failed to delete data: {e}[/red]")
            self._characters.clear()
            self._episodes.clear()
            self._props.clear()
            self._alias_index.clear()
            raise

    # ============================================================
    # Convenience properties
    # ============================================================

    @property
    def character_count(self) -> int:
        return len(self._characters)

    @property
    def episode_count(self) -> int:
        return len(self._episodes)


# ============================================================
# Factory function
# ============================================================


async def create_cognee_store(project_name: str) -> CogneeStore:
    """Create and initialize CogneeStore."""
    store = CogneeStore(project_name)
    await store.initialize()
    await store.load_graph_state()
    return store
