"""Round 8 roast regressions for hint parsing and durable enqueue."""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "hint",
    [
        "epoch: 2/4/10 about 2 months",
        "epoch: 2/4/10 roughly workdays total",
        "epoch: 2/4/10 roughly milliseconds per operation",
        "epoch: 2/4/10 roughly person-weeks",
        "epoch: 2/4/10 roughly quarters",
        "epoch: 2/4/10 ish working-days",
        "epoch: 2/4/10 ish man-days",
        "epoch: 2/4/10 ish dev-days",
        "epoch: 2/4/10 ish dayz",
        "epoch: 2/4/10 ish daysss",
        "epoch: 2/4/10 roughly yrs",
        "epoch: 2/4/10 roughly mo",
        "epoch: 2/4/10 roughly pts",
        "epoch: 2/4/10 roughly iterations",
        "epoch: 2/4/10 roughly s",
        "epoch: 2/4/10 maybe next week",
        "epoch: 2/4/10 about one day",
        "epoch: 2/4/10 about 3 days",
        "epoch: 2/4/10 roughly 2 blurgs",
        "epoch: 2/4/10 maybe +1 day",
        "epoch: 2/4/10 ish, another week for QA",
        "epoch: 2/4/10 roughly per day",
    ],
)
def test_r8_qualifier_and_quantity_or_unknown_unit_is_refused(plugin, hint):
    hint_out, problem = plugin.find_hint("", hint)

    assert hint_out is None
    assert problem and ("unit" in problem or "text after the estimate" in problem)


@pytest.mark.parametrize(
    ("unit", "expected"),
    [
        ("<b>days</b>", (16.0, 32.0, 80.0)),
        ("<em>weeks</em>", (80.0, 160.0, 400.0)),
        ("<i>d</i>", (16.0, 32.0, 80.0)),
    ],
)
def test_r8_html_wrapped_supported_unit_after_qualifier_is_recognized(
    plugin, unit, expected
):
    hint_out, problem = plugin.find_hint("", f"epoch: 2/4/10 roughly {unit}")

    assert problem is None
    assert tuple(hint_out.values()) == pytest.approx(expected)


@pytest.mark.parametrize(
    ("title", "body", "expected"),
    [
        ("", "cache_estimate: 300\nepoch: 2/4/10d", (16.0, 32.0, 80.0)),
        ("", "time_estimate: 4\nepoch: 1/2/3h", (1.0, 2.0, 3.0)),
        ("", "original_estimate: 3600 seconds\nepoch: 1/2/3h", (1.0, 2.0, 3.0)),
        ("", "legacy__epoch: 0\nepoch: 2/4/10", (2.0, 4.0, 10.0)),
        ("Bump max_estimate: 5 retries", "epoch: 1/2/3h", (1.0, 2.0, 3.0)),
        ("", "user_epoch: 1700000000\nepoch: 1/2/3h", (1.0, 2.0, 3.0)),
        ("", "start_epoch: 0\nepoch: 2/4/10", (2.0, 4.0, 10.0)),
        ("", "_epoch: 2/4/10_", (2.0, 4.0, 10.0)),
    ],
)
def test_r8_identifier_markers_do_not_hide_real_hints(plugin, title, body, expected):
    hint_out, problem = plugin.find_hint(title, body)

    assert problem is None
    assert tuple(hint_out.values()) == pytest.approx(expected)


@pytest.mark.parametrize(
    "hint",
    [
        "epoch: 2/4/10 roughly two weeks",
        "epoch: 2/4/10 roughly 2 weeks",
        "epoch: 2/4/10 roughly 2-3 days",
    ],
)
def test_r8_qualifier_quantity_and_unit_is_consistently_refused(plugin, hint):
    hint_out, problem = plugin.find_hint("", hint)

    assert hint_out is None
    assert problem and ("unit" in problem or "text after the estimate" in problem)


@pytest.mark.parametrize(
    "hint",
    [
        ('Use "epoch: 2/4/10". Then go.', (2.0, 4.0, 10.0)),
        ("<epoch: 2/4/10>.", (2.0, 4.0, 10.0)),
        ("<p>epoch: 2/4/10</p><p>next</p>", (2.0, 4.0, 10.0)),
        ("(epoch: 2/4/10), roughly", (2.0, 4.0, 10.0)),
        ("epoch: 2/4/10], roughly", (2.0, 4.0, 10.0)),
        ("(epoch: 2/4/10); maybe", (2.0, 4.0, 10.0)),
        ("| epoch: 2/4/10 | Ada |", (2.0, 4.0, 10.0)),
        ("| epoch: 2/4/10 | d |", (2.0, 4.0, 10.0)),
    ],
)
def test_r8_wrappers_and_table_cells_do_not_corrupt_hint(plugin, hint):
    text, expected = hint
    hint_out, problem = plugin.find_hint("", text)

    assert problem is None
    assert tuple(hint_out.values()) == pytest.approx(expected)


def test_e8_c1_does_not_start_job_when_outbox_enqueue_fails(
    plugin, make_ctx, monkeypatch
):
    ctx = make_ctx({"default": {}})
    executions = []

    class BrokenState:
        def update(self, *args, **kwargs):
            raise OSError("disk full")

        def get(self, *args, **kwargs):
            return {}

    ctx.state = BrokenState()
    monkeypatch.setattr(
        plugin,
        "_JOBS",
        {"claimed": lambda task_id, *args, **kwargs: executions.append(task_id)},
    )

    worker = plugin._enqueue("claimed", "task-1", None, 1)
    if worker is not None:
        worker.join(5)

    assert worker is None
    assert executions == []
