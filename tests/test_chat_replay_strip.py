from novelvideo.chat import service as chat_service


def test_merge_stream_text_keeps_repeated_delta_chunks():
    assert chat_service._merge_stream_text("done", "ne") == "donene"
    assert chat_service._merge_stream_text("Ok.", ".") == "Ok.."


def test_merge_stream_text_accepts_cumulative_updates():
    assert chat_service._merge_stream_text("First frame d", "First frame done") == "First frame done"


def test_suppresses_partial_labeled_transcript_replay_before_current_prompt():
    replay = "User: previous question\nAssistant: previous answer\nUser: another old question"

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=[],
            current_prompt="current question",
            suppress_partial_replay=True,
        )
        == ""
    )


def test_keeps_reply_after_current_prompt_in_replayed_transcript():
    replay = (
        "User: previous question\n"
        "Assistant: previous answer\n"
        "User: current question\n"
        "Assistant: this is the new reply"
    )

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=[],
            current_prompt="current question",
            suppress_partial_replay=True,
        )
        == "this is the new reply"
    )


def test_final_replay_strip_still_returns_unlabeled_content():
    assert (
        chat_service._strip_replayed_chat_response(
            "a normal new reply",
            previous_assistant=[],
            current_prompt="current question",
        )
        == "a normal new reply"
    )


def test_strips_unlabeled_assistant_history_sequence_before_new_reply():
    previous = [
        "Hello! How can I help you?",
        "Hello! I am Hermes Agent, your AI assistant.",
    ]
    replay = "".join(previous) + "The current task failed; I suggest retrying script generation first."

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=previous,
            current_prompt="continue",
            suppress_partial_replay=True,
        )
        == "The current task failed; I suggest retrying script generation first."
    )


def test_keeps_complete_repeated_short_reply_on_final_strip():
    assert (
        chat_service._strip_replayed_chat_response(
            "Hello! How can I help you?",
            previous_assistant=["Hello! How can I help you?"],
            current_prompt="hello",
            suppress_partial_replay=False,
        )
        == "Hello! How can I help you?"
    )


def test_suppresses_complete_repeated_short_reply_during_streaming():
    assert (
        chat_service._strip_replayed_chat_response(
            "Hello! How can I help you?",
            previous_assistant=["Hello! How can I help you?"],
            current_prompt="hello",
            suppress_partial_replay=True,
        )
        == ""
    )


def test_suppresses_truncated_unlabeled_assistant_replay():
    previous = [
        "The first frames of the previous batch (Beats 10, 11, 12) are all done."
        "Continued with the next batch of episode 3: the first frames of Beats 13, 14, 15 have entered the generation queue.\n\n"
        "I will continue with the remaining batches once the first frames finish. Just tell me when you want to move on."
    ]
    replay = (
        "The first frames of the previous batch (Beats 10, 11, 12) are all done."
        "Continued with the next batch of episode 3: the first frames of Beats 13, 14, 15 have entered the generation queue.\n\nI will cont"
    )

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=previous,
            current_prompt="continue to the next step",
        )
        == ""
    )
    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=previous,
            current_prompt="continue to the next step",
            suppress_partial_replay=True,
        )
        == ""
    )


def test_keeps_short_reply_that_matches_start_of_previous_assistant_text():
    assert (
        chat_service._strip_replayed_chat_response(
            "The previous batch's first frames are done",
            previous_assistant=["After the previous batch's first frames finish, I will keep generating the remaining batches."],
            current_prompt="progress",
        )
        == "The previous batch's first frames are done"
    )


def test_hermes_replay_history_is_bounded_to_latest_message_and_character_budget():
    contents = ["old", "latest" + "x" * chat_service._HERMES_REPLAY_HISTORY_MAX_CHARS]

    bounded = chat_service._bounded_replay_history(contents)

    assert len(bounded) == 1
    assert bounded[0].startswith("latest")
    assert len(bounded[0]) == chat_service._HERMES_REPLAY_HISTORY_MAX_CHARS


def test_replay_strip_accepts_precomputed_prefix_candidates():
    previous = ["previous reply"]
    candidates = chat_service._assistant_prefix_candidates(previous)

    assert (
        chat_service._strip_replayed_chat_response(
            "previous replythis turn's reply",
            previous,
            "continue",
            assistant_prefix_candidates=candidates,
        )
        == "this turn's reply"
    )


def test_hides_internal_skill_tool_events_from_chat_cards():
    assert chat_service._is_hidden_chat_tool_event(
        "skill",
        "→ skill view (dramaclaw)\nContent: Loading skill 'dramaclaw'",
    )
    assert not chat_service._is_hidden_chat_tool_event(
        "dramaclaw_pipeline_status",
        "→ dramaclaw_pipeline_status\ncompleted",
    )
