import json

from novelvideo.models import CharacterIdentity, NovelCharacter


def test_character_identity_age_group_assignment_normalizes_none():
    identity = CharacterIdentity(
        identity_id="Jiang Yan_bookstore",
        character_name="Jiang Yan",
        identity_name="bookstore",
    )

    identity.age_group = None

    assert identity.age_group == ""


def test_novel_character_identities_tolerate_historical_null_age_group():
    char = NovelCharacter(name="Jiang Yan")
    char.identities_json = json.dumps(
        [
            {
                "identity_id": "Jiang Yan_bookstore",
                "character_name": "Jiang Yan",
                "identity_name": "bookstore",
                "age_group": None,
            }
        ],
        ensure_ascii=False,
    )

    identities = char.identities

    assert len(identities) == 1
    assert identities[0].age_group == ""


def test_novel_character_identities_setter_does_not_serialize_null_age_group():
    char = NovelCharacter(name="Meng Qiaosheng")
    identity = CharacterIdentity(
        identity_id="Meng Qiaosheng_antique_shop",
        character_name="Meng Qiaosheng",
        identity_name="antique_shop",
    )

    identity.age_group = None
    char.identities = [identity]

    payload = json.loads(char.identities_json)
    assert payload[0]["age_group"] == ""
