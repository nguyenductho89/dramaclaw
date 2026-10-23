"""Unit tests for `agents/scene_staging_planner.py`'s deterministic
fallback and validate/repair logic — no LLM/network calls (those are
exercised in `plan_scene_staging`, not covered here per the project's
"free dry-run before GPU" pattern; see `.claude/CLAUDE.md`)."""

from __future__ import annotations

from novelvideo.agents.scene_staging_planner import (
    BlockingEntryProposal,
    SceneStagingProposal,
    SetDressingProposal,
    StagingBeatInput,
    StagingCharacterInput,
    StagingPlanLLMOutput,
    StagingPropInput,
    StagingSceneInput,
    _fallback_scene_staging,
    _mentions_cross_reference,
    validate_and_repair_staging_plan,
)


def _scene(beats, characters, props) -> StagingSceneInput:
    return StagingSceneInput(
        scene_id="PRESCHOOL PLAYGROUND",
        scene_prompt="a sunny preschool playground",
        beats=beats,
        characters=characters,
        props=props,
    )


def _two_char_scene() -> StagingSceneInput:
    return _scene(
        beats=[
            StagingBeatInput(
                beat_number=1,
                visual_description="Trump builds a toy wall.",
                identities=["Trump"],
                props=["toy wall"],
            ),
            StagingBeatInput(
                beat_number=3,
                visual_description="Kim raises a toy rocket beside the toy wall.",
                identities=["Kim"],
                props=["toy rocket", "toy wall"],
            ),
            StagingBeatInput(
                beat_number=5,
                visual_description="Trump stares at Kim's toy rocket.",
                identities=["Trump", "Kim"],
                props=["toy rocket"],
            ),
        ],
        characters=[
            StagingCharacterInput(identity_id="Trump", name="Trump", body_type="toddler"),
            StagingCharacterInput(identity_id="Kim", name="Kim", body_type="toddler"),
        ],
        props=[
            StagingPropInput(prop_id="toy wall", visual_prompt="low plastic brick wall"),
            StagingPropInput(prop_id="toy rocket", visual_prompt="silver tin rocket"),
        ],
    )


# ── fallback ─────────────────────────────────────────────────────────────


def test_fallback_places_identities_left_then_right_in_order_of_first_appearance():
    scene = _two_char_scene()
    staging = _fallback_scene_staging(scene)
    assert "left" in staging.blocking["Trump"].lower()
    assert "right" in staging.blocking["Kim"].lower()


def test_fallback_marks_prop_persistent_only_when_seen_in_2plus_beats():
    scene = _two_char_scene()
    staging = _fallback_scene_staging(scene)
    by_prop = {item.prop_id: item for item in staging.set_dressing}
    # toy wall appears in beats 1 and 3 -> persistent.
    assert "toy wall" in by_prop
    assert by_prop["toy wall"].persistent is True
    assert by_prop["toy wall"].from_beat == 1
    # toy rocket appears in beats 3 and 5 -> also persistent, from beat 3.
    assert "toy rocket" in by_prop
    assert by_prop["toy rocket"].from_beat == 3


def test_fallback_has_a_nonempty_camera_sentence():
    scene = _two_char_scene()
    staging = _fallback_scene_staging(scene)
    assert staging.camera.strip()
    assert staging.source == "fallback"


def test_fallback_skips_identities_not_in_scene_cast():
    # A beat referencing an identity not in `characters` (data drift) must
    # not crash and must not appear in blocking.
    scene = _scene(
        beats=[StagingBeatInput(beat_number=1, identities=["Ghost"], props=[])],
        characters=[StagingCharacterInput(identity_id="Trump", name="Trump")],
        props=[],
    )
    staging = _fallback_scene_staging(scene)
    assert "Ghost" not in staging.blocking


# ── validate_and_repair: happy path ─────────────────────────────────────


def test_llm_proposal_accepted_when_ids_are_real():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="low angle, child's eye level",
                blocking=[
                    BlockingEntryProposal(identity_id="Trump", placement="Trump stands left."),
                    BlockingEntryProposal(identity_id="Kim", placement="Kim stands right."),
                ],
                set_dressing=[
                    SetDressingProposal(
                        prop_id="toy wall",
                        placement_note="The toy wall sits center-left.",
                        persistent=True,
                        from_beat=1,
                    )
                ],
                scale_note="Both are toddler height.",
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    staging = result["PRESCHOOL PLAYGROUND"]
    assert staging.camera == "low angle, child's eye level"
    assert staging.blocking["Trump"] == "Trump stands left."
    assert staging.set_dressing[0].prop_id == "toy wall"
    assert staging.source == "llm_repaired"


# ── validate_and_repair: bad/partial LLM output is cleaned up ──────────


def test_unknown_identity_id_in_blocking_is_dropped():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="medium shot",
                blocking=[
                    BlockingEntryProposal(identity_id="Trump", placement="Trump stands left."),
                    BlockingEntryProposal(identity_id="Nonexistent", placement="ghost stands."),
                ],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    staging = result["PRESCHOOL PLAYGROUND"]
    assert "Trump" in staging.blocking
    assert "Nonexistent" not in staging.blocking


def test_unknown_prop_id_in_set_dressing_is_dropped():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="medium shot",
                set_dressing=[
                    SetDressingProposal(prop_id="toy wall", placement_note="ok", from_beat=1),
                    SetDressingProposal(prop_id="spaceship", placement_note="bad", from_beat=1),
                ],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    prop_ids = {item.prop_id for item in result["PRESCHOOL PLAYGROUND"].set_dressing}
    assert prop_ids == {"toy wall"}


def test_from_beat_clamped_into_scene_beat_range():
    scene = _two_char_scene()  # beats 1, 3, 5
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="medium shot",
                set_dressing=[
                    SetDressingProposal(prop_id="toy wall", placement_note="ok", from_beat=999),
                ],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    item = result["PRESCHOOL PLAYGROUND"].set_dressing[0]
    assert item.from_beat == 5  # clamped to the scene's own max beat number


def test_scene_with_no_matching_llm_proposal_falls_back():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[SceneStagingProposal(scene_id="SOME OTHER SCENE", camera="irrelevant")]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    assert result["PRESCHOOL PLAYGROUND"].source == "fallback"


def test_none_llm_output_falls_back_for_every_scene():
    scene = _two_char_scene()
    result = validate_and_repair_staging_plan([scene], None)
    assert result["PRESCHOOL PLAYGROUND"].source == "fallback"


def test_empty_proposal_with_no_usable_fields_falls_back_wholesale():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[SceneStagingProposal(scene_id="PRESCHOOL PLAYGROUND")]  # everything blank
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    assert result["PRESCHOOL PLAYGROUND"].source == "fallback"


def test_one_bad_scene_does_not_discard_another_good_scene():
    scene_a = _two_char_scene()
    scene_b = StagingSceneInput(
        scene_id="OTHER ROOM",
        beats=[StagingBeatInput(beat_number=10, identities=["Trump"], props=[])],
        characters=[StagingCharacterInput(identity_id="Trump", name="Trump")],
        props=[],
    )
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(scene_id="PRESCHOOL PLAYGROUND"),  # blank -> falls back
            SceneStagingProposal(
                scene_id="OTHER ROOM",
                camera="good camera line",
                blocking=[BlockingEntryProposal(identity_id="Trump", placement="Trump stands.")],
            ),
        ]
    )
    result = validate_and_repair_staging_plan([scene_a, scene_b], llm_output)
    assert result["PRESCHOOL PLAYGROUND"].source == "fallback"
    assert result["OTHER ROOM"].camera == "good camera line"
    assert result["OTHER ROOM"].source == "llm_repaired"


# ── cross-reference guard ────────────────────────────────────────────────
#
# Real bug caught on a real GPU render (`Parkun` beats 1 and 7, both
# single-character): dict-level filtering of `blocking` (done by the
# CALLER, `nanobanana_grid._compose_prompt_extras`, not here) is not
# enough — the staging bible's own SENTENCES, written with the whole
# scene's cast in view, named or implied a second person even in the one
# entry that survived filtering. These tests cover the Python-side guard
# that rejects that text before it ever reaches `SceneStaging`.


def test_mentions_cross_reference_catches_other_character_name():
    assert _mentions_cross_reference(
        "Little Trump stands on the left, facing right toward Little Kim.",
        {"Little Kim"},
    )


def test_mentions_cross_reference_catches_generic_phrases():
    for phrase in [
        "Camera shows both children in frame.",
        "The door faces the other child.",
        "They stand facing each other.",
        "Two kids stand near the wall.",
    ]:
        assert _mentions_cross_reference(phrase, set()), phrase


def test_mentions_cross_reference_allows_clean_self_contained_sentence():
    assert not _mentions_cross_reference(
        "Little Trump stands on the left side of frame, beside the toy wall.",
        {"Little Kim"},
    )


def test_blocking_sentence_naming_another_character_is_replaced_not_kept():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="eye-level medium-wide shot",
                blocking=[
                    BlockingEntryProposal(
                        identity_id="Trump",
                        placement="Trump stands left, facing right toward Kim.",
                    ),
                    BlockingEntryProposal(identity_id="Kim", placement="Kim stands right."),
                ],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    trump_placement = result["PRESCHOOL PLAYGROUND"].blocking["Trump"]
    assert "Kim" not in trump_placement
    # Kim's own entry, which doesn't cross-reference anyone, is kept verbatim.
    assert result["PRESCHOOL PLAYGROUND"].blocking["Kim"] == "Kim stands right."


def test_camera_asserting_both_characters_present_falls_back_to_safe_default():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="Medium-wide shot, both children and the toy wall fully in frame.",
                blocking=[BlockingEntryProposal(identity_id="Trump", placement="Trump stands.")],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    camera = result["PRESCHOOL PLAYGROUND"].camera
    assert "both children" not in camera.lower()


def test_set_dressing_generic_other_child_phrase_is_replaced():
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="eye-level medium-wide shot",
                set_dressing=[
                    SetDressingProposal(
                        prop_id="toy wall",
                        placement_note="Its gap door faces the other child.",
                        from_beat=1,
                    )
                ],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    note = result["PRESCHOOL PLAYGROUND"].set_dressing[0].placement_note
    assert "other child" not in note.lower()


def test_set_dressing_naming_the_character_it_belongs_to_is_kept():
    # A prop's placement legitimately naming ITS OWN character (e.g. "the
    # candy box Trump is clutching") is informative positioning text, not
    # a false claim that a second person is in frame — must not be
    # scrubbed the way generic cross-references are.
    scene = _two_char_scene()
    llm_output = StagingPlanLLMOutput(
        scenes=[
            SceneStagingProposal(
                scene_id="PRESCHOOL PLAYGROUND",
                camera="eye-level medium-wide shot",
                set_dressing=[
                    SetDressingProposal(
                        prop_id="toy wall",
                        placement_note="Sits on the ground beside Trump.",
                        from_beat=1,
                    )
                ],
            )
        ]
    )
    result = validate_and_repair_staging_plan([scene], llm_output)
    note = result["PRESCHOOL PLAYGROUND"].set_dressing[0].placement_note
    assert note == "Sits on the ground beside Trump."
