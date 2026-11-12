"""Round 9 roast regressions for hint boundaries and failed claim enqueue."""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "hint",
    [
        "epoch: 2/4/10 about 2.5 months",
        "epoch: 2/4/10 about 0.5 days",
        "epoch: 2/4/10 roughly .5 weeks",
        "epoch: 2/4/10 roughly 1.5d",
    ],
)
def test_r9_decimal_quantity_after_qualifier_is_not_silently_hours(plugin, hint):
    estimate, problem = plugin.find_hint("", hint)

    assert estimate is None
    assert problem and ("unit" in problem or "malformed" in problem)


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        ("roughly in working days", (16.0, 32.0, 80.0)),
        ("roughly, in working days", (16.0, 32.0, 80.0)),
        ("about, in calendar days", (16.0, 32.0, 80.0)),
        ("roughly in work weeks", (80.0, 160.0, 400.0)),
        ("roughly, ship Friday", (2.0, 4.0, 10.0)),
        ("ish, 20 min standup after", (2.0, 4.0, 10.0)),
        ("maybe 3 PRs", (2.0, 4.0, 10.0)),
        ("about 3 endpoints", (2.0, 4.0, 10.0)),
        ("roughly holidays", (2.0, 4.0, 10.0)),
        ("roughly, holidays permitting", (2.0, 4.0, 10.0)),
        ("roughly (checkpoints included)", (2.0, 4.0, 10.0)),
        ("maybe, a reviewer is out", (2.0, 4.0, 10.0)),
        ("ish, one caveat below", (2.0, 4.0, 10.0)),
        ("roughly days, pending review", (16.0, 32.0, 80.0)),
        ("roughly full-time days", (2.0, 4.0, 10.0)),
        ("roughly ideal days", (2.0, 4.0, 10.0)),
        ("roughly few days", (2.0, 4.0, 10.0)),
        ("maybe 2 reviewers needed", (2.0, 4.0, 10.0)),
    ],
)
def test_r9_qualifier_commentary_remains_valid(plugin, phrase, expected):
    estimate, problem = plugin.find_hint("", f"epoch: 2/4/10 {phrase}")

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx(expected)


@pytest.mark.parametrize(
    "hint",
    [
        "epoch: 2/4/10 roughly in dev days",
        "epoch: 2/4/10 ish in person days",
        "epoch: 2/4/10 ish, in person days",
        "epoch: 2/4/10 maybe in dev days",
        "epoch: 2/4/10 roughly in man days",
        "epoch: 2/4/10 roughly in ideal days",
        "epoch: 2/4/10 roughly in story points",
        "epoch: 2/4/10 approx in dev days",
    ],
)
def test_r9_unsupported_multiword_unit_after_in_is_refused(plugin, hint):
    estimate, problem = plugin.find_hint("", hint)

    assert estimate is None
    assert problem


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("cache-estimate: 300\nepoch: 2/4/10d", (16.0, 32.0, 80.0)),
        ("max-estimate: 5 retries\nepoch: 2/4/10d", (16.0, 32.0, 80.0)),
        ("ttl.epoch: 1700000000\nepoch: 2/4/10d", (16.0, 32.0, 80.0)),
        ("$epoch: 3 days\nepoch: 2/4/10d", (16.0, 32.0, 80.0)),
    ],
)
def test_r9_glued_identifier_keys_do_not_hide_later_hint(plugin, body, expected):
    estimate, problem = plugin.find_hint("", body)

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx(expected)


@pytest.mark.parametrize(
    "hint",
    [
        "| epoch: 2/4/10 | d |",
        "| epoch: 2/4/10 |d|",
        "| epoch: 2/4/10 |weeks|",
        "|epoch: 2/4/10|d|",
        "epoch: 2/4/10 |weeks|",
    ],
)
def test_r9_table_cells_do_not_supply_a_hint_unit(plugin, hint):
    estimate, problem = plugin.find_hint("", hint)

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx((2.0, 4.0, 10.0))


@pytest.mark.parametrize(
    "hint",
    [
        "epoch: 2/4/10<br>Weeks ago we agreed on scope",
        "epoch: 2/4/10<br>days of work",
        "epoch: 2/4/10<li>days of work",
        "epoch: 2/4/10<p>weeks of work",
    ],
)
def test_r9_html_boundaries_stop_unit_parsing(plugin, hint):
    estimate, problem = plugin.find_hint("", hint)

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx((2.0, 4.0, 10.0))


@pytest.mark.parametrize(
    "unit",
    ["días", "Tage", "jours", "«days»", "「days」", "mths", "sprnts", "millis", "3dys"],
)
def test_r9_unknown_unit_after_qualifier_is_refused(plugin, unit):
    estimate, problem = plugin.find_hint("", f"epoch: 2/4/10 roughly {unit}")

    assert estimate is None
    assert problem and "unit" in problem


def test_r9_corrupt_state_notifies_claim_without_claiming_retry(
    plugin, board, make_ctx, tmp_path, monkeypatch
):
    ctx = make_ctx({"default": {"comment_on_claim": True}})
    task_id = board.create("task", "epoch: 1/2/3h")
    run_id = board.claim(task_id)
    state_path = tmp_path / "state.json"
    state_path.write_text("{not-json", encoding="utf-8")
    ctx.state = type("CorruptPluginState", (), {"path": state_path})()
    ran = []
    monkeypatch.setattr(
        plugin, "_JOBS", {"claimed": lambda *args, **kwargs: ran.append(args)}
    )
    monkeypatch.setattr(plugin, "_maybe_reconcile", lambda: None)

    plugin._on_claimed(task_id, None, run_id)

    comments = board.bodies(task_id)
    assert not ran
    assert len(comments) == 1
    assert "wasn't queued" in comments[0]
    assert "will not retry automatically" in comments[0]
