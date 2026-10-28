from types import SimpleNamespace

from novelvideo.workflows.literal_script_writing import LiteralScriptWritingWorkflow


def _wf(scene_ids, aliases=None):
    wf = LiteralScriptWritingWorkflow.__new__(LiteralScriptWritingWorkflow)
    wf._valid_scene_ids = set(scene_ids)
    wf._scene_menu_split = {}
    wf._scene_aliases = aliases or {}
    return wf


EP = SimpleNamespace(scene_menu=[])
IDS = ["Nihonbashi Bridge", "Merchant Street", "Fish Market Alley", "Cloth Shop Doorway"]


def test_all_caps_heading_matches_title_case_scene_name():
    wf = _wf(IDS)
    assert wf._resolve_scene_id("EXT. NIHONBASHI BRIDGE - MORNING", EP) in ("", "Nihonbashi Bridge")
    assert wf._resolve_scene_id("NIHONBASHI BRIDGE", EP) == "Nihonbashi Bridge"
    assert wf._resolve_scene_id("MERCHANT STREET", EP) == "Merchant Street"
    assert wf._resolve_scene_id("CLOTH SHOP DOORWAY", EP) == "Cloth Shop Doorway"


def test_alias_still_matches_case_insensitively():
    wf = _wf(IDS, {"fish market": {"Fish Market Alley"}})
    assert wf._resolve_scene_id("FISH MARKET", EP) == "Fish Market Alley"


def test_unknown_heading_returns_empty():
    assert _wf(IDS)._resolve_scene_id("TEMPLE GATE", EP) == ""
