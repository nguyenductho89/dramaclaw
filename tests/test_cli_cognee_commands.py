"""Anchor: dead commands/branches in cli.py that depended on the removed filter_characters_simple are no longer exposed.

Background: after the EE side removed the character_filter module (filter_characters /
filter_characters_simple) in d5faed2a, cli.py still had two leftover call sites -- the whole
cognee-filter command and the --auto-filter branch of cognee-profile -- which raise NameError
(ruff F821) as soon as they are reached.
The tests below anchor the contract "dead interfaces are no longer exposed to users": red before the change
(still present), green after the removal.
"""
from typer.testing import CliRunner

from novelvideo.cli import app

runner = CliRunner()


def test_cognee_filter_command_removed():
    """Every path of cognee-filter called an undefined function; the command should no longer be registered."""
    result = runner.invoke(app, ["cognee-filter", "--help"])
    assert result.exit_code != 0
    assert "No such command" in result.output


def test_cognee_profile_drops_dead_auto_filter_options():
    """cognee-profile's --auto-filter/--dry-run depended on a dead branch and should be removed; the command itself stays available."""
    result = runner.invoke(app, ["cognee-profile", "--help"])
    assert result.exit_code == 0
    assert "--auto-filter" not in result.output
    assert "--dry-run" not in result.output
