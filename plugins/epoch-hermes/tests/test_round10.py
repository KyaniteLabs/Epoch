"""Round 10 roast regressions for hint parsing and failed enqueue notifications."""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "phrase",
    [
        "roughly ideal days",
        "roughly dev days",
        "roughly man days",
        "roughly whole days",
        "roughly full-time days",
        "roughly few days",
        "roughly each day",
        "roughly this week",
        "roughly man weeks",
        "roughly engineering weeks",
        "about team days",
        "maybe pair days",
        "roughly, 2 weeks",
        "roughly, 3 days",
        "approx, 1 day",
        "roughly 2 caveats days",
        "roughly 2 PRs in days",
        "roughly 3 reviewers weeks",
    ],
)
def test_r10_qualifier_before_unit_or_ambiguous_count_is_refused(plugin, phrase):
    estimate, problem = plugin.find_hint("", f"epoch: 2/4/10 {phrase}")

    assert estimate is None
    assert problem


@pytest.mark.parametrize(
    "unit",
    [
        "mandays",
        "manhours",
        "workingdays",
        "weekdays",
        "businessdays",
        "storypoints",
        "halfdays",
        "devdays",
        "persondays",
        "manweeks",
        "man-days",
        "person-days",
        "story-points",
    ],
)
def test_r10_run_together_unit_stems_do_not_fall_back_to_hours(plugin, unit):
    estimate, problem = plugin.find_hint("", f"epoch: 2/4/10 roughly {unit}")

    assert estimate is None
    assert problem and "unit" in problem


@pytest.mark.parametrize(
    "unit",
    [
        "semanas",
        "dias",
        "Wochen",
        "heures",
        "Stunden",
        "horas",
        "Tagen",
        "giorni",
        "jornadas",
        "mnths",
        "semaines",
        "días",
        "dys",
        "日",
    ],
)
def test_r10_unknown_terminal_unit_is_refused_without_a_word_list(plugin, unit):
    estimate, problem = plugin.find_hint("", f"epoch: 2/4/10 roughly {unit}")

    assert estimate is None
    assert problem and "unit" in problem


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        ("maybe 2 reviewers needed", (2.0, 4.0, 10.0)),
        ("maybe 2 testers needed", (2.0, 4.0, 10.0)),
        ("roughly 3 files touched", (2.0, 4.0, 10.0)),
        ("maybe 2 PRs", (2.0, 4.0, 10.0)),
        ("about 3 endpoints", (2.0, 4.0, 10.0)),
        ("roughly Friday", (2.0, 4.0, 10.0)),
        ("roughly holidays", (2.0, 4.0, 10.0)),
        ("roughly blocked", (2.0, 4.0, 10.0)),
        ("ish, tentative", (2.0, 4.0, 10.0)),
        ("approx. Next week QA starts.", (2.0, 4.0, 10.0)),
        ("roughly, ship Friday", (2.0, 4.0, 10.0)),
        ("roughly holidays permitting", (2.0, 4.0, 10.0)),
        ("roughly, 5 days total", (2.0, 4.0, 10.0)),
        ("roughly days, pending review", (16.0, 32.0, 80.0)),
        ("roughly in working days", (16.0, 32.0, 80.0)),
        ("roughly in total", (2.0, 4.0, 10.0)),
        ("roughly, in total", (2.0, 4.0, 10.0)),
        ("roughly in my view", (2.0, 4.0, 10.0)),
        ("roughly in Q4", (2.0, 4.0, 10.0)),
    ],
)
def test_r10_commentary_and_supported_units_keep_their_meaning(
    plugin, phrase, expected
):
    estimate, problem = plugin.find_hint("", f"epoch: 2/4/10 {phrase}")

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("Re-estimate: 3/5/8 d", (24.0, 40.0, 64.0)),
        ("Done.epoch: 2/4/10 d", (16.0, 32.0, 80.0)),
        ("-epoch: 2/4/10 d", (16.0, 32.0, 80.0)),
    ],
)
def test_r10_reestimate_and_sentence_key_hints_are_found(plugin, body, expected):
    estimate, problem = plugin.find_hint("", body)

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx(expected)


@pytest.mark.parametrize(
    "body",
    [
        "cache-estimate: 300\nepoch: 2/4/10d",
        "time-estimate: 300\nepoch: 2/4/10d",
        "ttl.epoch: 1700000000\nepoch: 2/4/10d",
        "$epoch: 3 days\nepoch: 2/4/10d",
    ],
)
def test_r10_identifier_keys_still_leave_a_later_hint_visible(plugin, body):
    estimate, problem = plugin.find_hint("", body)

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx((16.0, 32.0, 80.0))


@pytest.mark.parametrize("hint", ["epoch: 2/4/10|d", "epoch: 2/4/10|weeks"])
def test_r10_unit_glued_after_table_bar_is_refused(plugin, hint):
    estimate, problem = plugin.find_hint("", hint)

    assert estimate is None
    assert problem


@pytest.mark.parametrize(
    "hint",
    [
        "| epoch: 2/4/10 | d |",
        "| epoch: 2/4/10 |weeks|",
        "epoch: 2/4/10 | weeks |",
    ],
)
def test_r10_spaced_table_cells_do_not_supply_a_unit(plugin, hint):
    estimate, problem = plugin.find_hint("", hint)

    assert problem is None
    assert tuple(estimate.values()) == pytest.approx((2.0, 4.0, 10.0))


@pytest.mark.parametrize("kind", ["claimed", "completed"])
def test_r10_corrupt_state_notifies_for_both_job_kinds_and_requires_repair(
    plugin, board, make_ctx, tmp_path, monkeypatch, kind
):
    ctx = make_ctx({"default": {"comment_on_claim": True, "record_actuals": True}})
    task_id = board.create("task", "epoch: 1/2/3h")
    run_id = board.claim(task_id)
    if kind == "completed":
        board.complete(task_id, run_id)
    state_path = tmp_path / "state.json"
    state_path.write_text("{not-json", encoding="utf-8")
    ctx.state = type("CorruptPluginState", (), {"path": state_path})()
    ran = []
    monkeypatch.setattr(
        plugin,
        "_JOBS",
        {
            "claimed": lambda *args, **kwargs: ran.append(args),
            "completed": lambda *args, **kwargs: ran.append(args),
        },
    )
    monkeypatch.setattr(plugin, "_maybe_reconcile", lambda: None)
    monkeypatch.setattr(plugin, "_maybe_replay", lambda: None)

    if kind == "claimed":
        plugin._on_claimed(task_id, None, run_id)
    else:
        plugin._on_completed(task_id, None, run_id)

    comments = board.bodies(task_id)
    assert not ran
    assert len(comments) == 1
    assert "wasn't queued" in comments[0]
    assert "state file" in comments[0].lower()
    assert "repair" in comments[0].lower()
    assert state_path.read_text(encoding="utf-8") == "{not-json"
