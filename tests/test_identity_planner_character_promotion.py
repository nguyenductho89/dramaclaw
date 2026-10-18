import pytest

from novelvideo.agents.identity_planner import (
    DefaultIdentityRequirement,
    EpisodeDefaultIdentities,
    EpisodeIdentityRequirements,
    IdentityPlanner,
)
from novelvideo.models import NovelCharacter, NovelEpisode


class FakeIdentityStore:
    def __init__(self, content, working_content=""):
        self.content = content
        self.working_content = working_content
        self.sqlite_store = self
        self._characters = {}
        self.updated_episode = None

    def get_all_characters(self):
        return list(self._characters.values())

    async def load_working_content(self, episode_number):
        return self.working_content

    async def load_episode_content(self, episode_number):
        return self.content

    def resolve_name(self, name):
        return name

    def get_character(self, name):
        return self._characters.get(name)

    async def add_character(self, character):
        self._characters[character.name] = character

    async def update_episode(self, episode_number, **updates):
        self.updated_episode = (episode_number, updates)

    async def patch_episode(self, episode_number, **updates):
        # The real store offers both; identity writes take the column-level one
        # so they cannot clobber a menu written by concurrent planning.
        self.updated_episode = (episode_number, updates)


class ExistingCharacterIdentityPlanner(IdentityPlanner):
    async def _filter_cast(self, all_names, content_text, episode, on_log=None):
        assert "Luke" in all_names
        self.filtered_content_text = content_text
        return ["Luke"], ""

    async def _analyze_default_identities(
        self,
        episode,
        on_log=None,
        cast_names=None,
        content_text=None,
        graph_context="",
    ):
        return EpisodeDefaultIdentities(
            defaults=[
                DefaultIdentityRequirement(
                    character_name="Luke",
                    visual_state="default",
                    reason="The graph already has the character and the scene header clearly lists the cast",
                )
            ]
        )

    async def _resolve_requirements(
        self, episode_number, requirements, on_log=None, output_language=None
    ):
        return 0, ["Luke_default"], {("Luke", "default"): "Luke_default"}

    async def _analyze_special_identities(
        self,
        episode,
        on_log=None,
        cast_names=None,
        content_text=None,
        graph_context="",
        already_resolved=None,
    ):
        return EpisodeIdentityRequirements()


class MissingCharacterIdentityPlanner(IdentityPlanner):
    async def _filter_cast(self, all_names, content_text, episode, on_log=None):
        assert all_names == []
        assert self.cognee_store.get_character("Luke") is None
        return [], ""


@pytest.mark.asyncio
async def test_identity_planner_uses_existing_characters_without_auto_creation():
    store = FakeIdentityStore(
        """
Scene 1. INT. BASEMENT - NIGHT; Characters: Luke
Luke pushes open a rotting empty bookshelf.
"""
    )
    await store.add_character(
        NovelCharacter(
            name="Luke",
            aliases=["Mr. Luke"],
            gender="male",
            description="Manually confirmed global character",
        )
    )
    planner = ExistingCharacterIdentityPlanner(store)

    new_count, resolved_count = await planner.plan_single_episode(
        NovelEpisode(number=1, title="The Book of Fate")
    )

    assert new_count == 0
    assert resolved_count == 1
    assert sorted(store._characters) == ["Luke"]
    assert planner.auto_promoted_characters == []
    assert store.updated_episode == (
        1,
        {
            "identity_ids": ["Luke_default"],
            "character_names": ["Luke"],
            "identity_default_map": {"Luke": "Luke_default"},
        },
    )


@pytest.mark.asyncio
async def test_identity_planner_prefers_current_production_text():
    store = FakeIdentityStore(
        "Luke in the original script.",
        working_content="Luke in the rewritten working draft.",
    )
    await store.add_character(NovelCharacter(name="Luke"))
    planner = ExistingCharacterIdentityPlanner(store)

    await planner.plan_single_episode(
        NovelEpisode(
            number=1,
            title="The Book of Fate",
            beat_source_text="Luke in the final production draft.",
        )
    )

    assert planner.filtered_content_text == "Luke in the final production draft."


@pytest.mark.asyncio
async def test_identity_planner_does_not_auto_create_missing_characters():
    store = FakeIdentityStore(
        """
Scene 1. INT. BASEMENT - NIGHT; Characters: Luke
Luke pushes open a rotting empty bookshelf.
"""
    )
    planner = MissingCharacterIdentityPlanner(store)

    with pytest.raises(ValueError, match="Pass 0"):
        await planner.plan_single_episode(NovelEpisode(number=1, title="The Book of Fate"))

    assert store.get_character("Luke") is None
    assert planner.auto_promoted_characters == []
    assert store.updated_episode is None
