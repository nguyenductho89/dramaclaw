from novelvideo.freezone.audio_node import VoicePrerequisiteError
from novelvideo.task_backend.run_core import _project_task_failure_for_exception


def test_voice_prerequisite_is_a_handled_project_task_failure() -> None:
    exc = VoicePrerequisiteError("The project narrator voice is not configured")

    message, payload, handled = _project_task_failure_for_exception(exc)

    assert message == "The project narrator voice is not configured"
    assert payload == {"error_code": "voice_prereq_required"}
    assert handled is True
