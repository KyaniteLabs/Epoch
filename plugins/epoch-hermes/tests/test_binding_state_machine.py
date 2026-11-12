"""Run-binding state machines: ledger outcome + per-kind comment delivery.

Covers the derived state tables, every legal transition, every illegal transition refused,
legacy on-disk values still read, exhaustiveness over the enums, and a Hypothesis
RuleBasedStateMachine that drives random transition sequences against the real persisted
bindings file and checks the invariants after every step.
"""
from __future__ import annotations

import json
import os
import threading
import time

import pytest
pytest.importorskip("hypothesis")
from hypothesis import HealthCheck, settings as hsettings, strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule

from conftest import load_plugin

P = load_plugin()
KINDS = list(P.CommentKind)
OUTCOMES = list(P.LedgerOutcome)
PERSISTED_KEYS = {
    "ref", "recorded", "status",
    "estimate_commented", "actual_commented",
    "estimate_comment_body", "actual_comment_body",
    "estimate_delivery_in_flight", "actual_delivery_in_flight", "run_ended",
    "created_at",
}


def _live_claim(**over):
    claim = {"pid": os.getpid(), "tid": threading.get_ident(), "until": time.time() + 600}
    claim.update(over)
    return claim


def _foreign_live_claim():
    return _live_claim(tid=-1)


# --------------------------------------------------------------------------- enums


def test_enum_values_are_the_persisted_strings():
    assert {o.value for o in P.LedgerOutcome} == {"recorded", "duplicate", "rejected"}
    assert {k.value for k in P.CommentKind} == {"estimate", "actual"}
    assert {d.value for d in P.Delivery} == {"none", "pending", "in_flight", "delivered"}


# --------------------------------------------------------------------------- derived tables


@pytest.mark.parametrize("kind", KINDS)
def test_delivery_state_table(kind):
    k = kind.value
    body, claim, done = f"{k}_comment_body", f"{k}_delivery_in_flight", f"{k}_commented"
    expired = _live_claim(until=time.time() - 1)
    rows = [
        (None, P.Delivery.NONE),
        ({}, P.Delivery.NONE),
        ({body: None, done: False}, P.Delivery.NONE),
        ({body: "b", done: False}, P.Delivery.PENDING),
        ({body: "b", claim: expired}, P.Delivery.PENDING),
        ({body: "b", claim: "garbage"}, P.Delivery.PENDING),
        ({body: "b", claim: _live_claim()}, P.Delivery.IN_FLIGHT),
        ({body: "b", claim: _live_claim(pid=2 ** 22 + 12345)}, P.Delivery.PENDING),  # dead owner
        ({body: "b", done: True}, P.Delivery.DELIVERED),
        ({body: None, done: True}, P.Delivery.DELIVERED),  # legacy: flag set without body
    ]
    seen = set()
    for binding, expected in rows:
        assert P.delivery_state(binding, kind) is expected, binding
        seen.add(expected)
    assert seen == set(P.Delivery), "every Delivery stage must appear in the table"


def test_ledger_outcome_table_and_legacy_reads():
    assert P.ledger_outcome(None) is None
    assert P.ledger_outcome({"ref": "r"}) is None
    assert P.ledger_outcome({"ref": "r", "recorded": False, "status": "recorded"}) is None
    for o in OUTCOMES:
        assert P.ledger_outcome({"recorded": True, "status": o.value}) is o
    # Legacy rows: ``recorded`` is the authority; missing/unknown status reads as RECORDED.
    assert P.ledger_outcome({"recorded": True}) is P.LedgerOutcome.RECORDED
    assert P.ledger_outcome({"recorded": True, "status": "ok"}) is P.LedgerOutcome.RECORDED


def test_unknown_kind_is_refused():
    with pytest.raises(P.IllegalBindingTransition):
        P.delivery_state({}, "comment")


# --------------------------------------------------------------------------- transitions


@pytest.mark.parametrize("prior", [None, *OUTCOMES])
@pytest.mark.parametrize("outcome", OUTCOMES)
def test_record_transition_matrix(prior, outcome):
    cur = {"ref": "r", "recorded": False}
    if prior is not None:
        cur = {"ref": "r", "recorded": True, "status": prior.value, "actual_comment_body": "first"}
    # Plain mark: UNRECORDED → any; same outcome idempotent; DUPLICATE → RECORDED is the one
    # allowed upgrade (racing recorders); any other different terminal is refused.
    upgrade = prior is P.LedgerOutcome.DUPLICATE and outcome is P.LedgerOutcome.RECORDED
    if prior is None or prior is outcome or upgrade:
        out = P._transition_record(cur, outcome, "body", keep_existing=False)
        assert P.ledger_outcome(out) is outcome
        assert out["actual_commented"] is False
    else:
        with pytest.raises(P.IllegalBindingTransition):
            P._transition_record(cur, outcome, "body", keep_existing=False)
    # keep_existing (duplicate path): never overwrites a stored outcome or body.
    out = P._transition_record(cur, outcome, "late", keep_existing=True)
    if prior is None:
        assert P.ledger_outcome(out) is outcome and out["actual_comment_body"] == "late"
    else:
        assert P.ledger_outcome(out) is prior and out["actual_comment_body"] == "first"


def test_racing_loser_duplicate_then_winner_recorded(tmp_path):
    """Two recorders race: the loser marks ``duplicate`` first, then the winner marks
    ``recorded``. The winner's outcome must land, not raise IllegalBindingTransition."""
    s = {"epoch_data_dir": str(tmp_path)}
    P._binding_put_ref(s, "t", None, 1, "ref-1")
    P._binding_mark_recorded(s, "t", None, 1, status="duplicate", keep_existing=True)
    P._binding_mark_recorded(s, "t", None, 1, status="recorded", actual_comment_body="ok")
    b = P._binding_get(s, "t", None, 1)
    assert b["status"] == "recorded" and b["actual_comment_body"] == "ok"
    # And the upgrade is one-way: recorded never drops back to duplicate.
    with pytest.raises(P.IllegalBindingTransition):
        P._binding_mark_recorded(s, "t", None, 1, status="duplicate")


def test_record_refuses_unknown_status(tmp_path):
    s = {"epoch_data_dir": str(tmp_path)}
    P._binding_put_ref(s, "t", None, 1, "ref-1")
    with pytest.raises(P.IllegalBindingTransition):
        P._binding_mark_recorded(s, "t", None, 1, status="done")
    assert P._binding_get(s, "t", None, 1)["recorded"] is False


def test_different_terminal_outcome_is_refused_and_not_persisted(tmp_path):
    """Old code silently overwrote ``status`` (e.g. recorded → rejected) on a second mark."""
    s = {"epoch_data_dir": str(tmp_path)}
    P._binding_put_ref(s, "t", None, 1, "ref-1")
    P._binding_mark_recorded(s, "t", None, 1, status="recorded", actual_comment_body="ok")
    with pytest.raises(P.IllegalBindingTransition):
        P._binding_mark_recorded(s, "t", None, 1, status="rejected", actual_comment_body="nope")
    b = P._binding_get(s, "t", None, 1)
    assert b["status"] == "recorded" and b["actual_comment_body"] == "ok"


@pytest.mark.parametrize("kind", KINDS)
def test_mark_commented_matrix(kind):
    k = kind.value
    body, claim, done = f"{k}_comment_body", f"{k}_delivery_in_flight", f"{k}_commented"
    for start in ({body: "b"}, {body: "b", claim: _live_claim()}, {body: "b", done: True}):
        out = P._transition_mark_commented(start, kind)
        assert P.delivery_state(out, kind) is P.Delivery.DELIVERED
        assert claim not in out
    with pytest.raises(P.IllegalBindingTransition):
        P._transition_mark_commented({}, kind)


@pytest.mark.parametrize("kind", KINDS)
def test_claim_release_complete_cycle(tmp_path, kind):
    s = {"epoch_data_dir": str(tmp_path)}
    P._binding_put_ref(s, "t", None, 1, "ref-1", estimate_comment_body="est")
    if kind is P.CommentKind.ACTUAL:
        P._binding_mark_recorded(s, "t", None, 1, status="recorded", actual_comment_body="act")
    get = lambda: P._binding_get(s, "t", None, 1)  # noqa: E731
    assert P.delivery_state(get(), kind) is P.Delivery.PENDING
    body, status = P._claim_comment_delivery(s, "t", None, 1, kind=kind)
    assert status == P._DELIVERY_CLAIMED and body
    assert P.delivery_state(get(), kind) is P.Delivery.IN_FLIGHT
    P._release_comment_delivery(s, "t", None, 1, kind=kind)
    assert P.delivery_state(get(), kind) is P.Delivery.PENDING
    P._claim_comment_delivery(s, "t", None, 1, kind=kind)
    P._complete_comment_delivery(s, "t", None, 1, kind=kind)
    assert P.delivery_state(get(), kind) is P.Delivery.DELIVERED
    assert P._claim_comment_delivery(s, "t", None, 1, kind=kind) == (None, P._DELIVERY_TERMINAL)


def test_foreign_live_claim_is_contested(tmp_path):
    s = {"epoch_data_dir": str(tmp_path)}
    P._binding_put_ref(s, "t", None, 1, "ref-1", estimate_comment_body="est")
    key = P._binding_key("t", None, 1)
    P._bindings_update(s, lambda d: d[key].__setitem__("estimate_delivery_in_flight", _foreign_live_claim()))
    assert P._claim_comment_delivery(s, "t", None, 1, kind="estimate") == (None, P._DELIVERY_CONTESTED)
    P._release_comment_delivery(s, "t", None, 1, kind="estimate")  # not ours, live → kept
    assert P.delivery_state(P._binding_get(s, "t", None, 1), "estimate") is P.Delivery.IN_FLIGHT


def test_legacy_binding_file_still_reads(tmp_path):
    """A bindings file written by the previous plugin version (no ``status`` key)."""
    s = {"epoch_data_dir": str(tmp_path)}
    key = P._binding_key("t", None, 7)
    (tmp_path / P.BINDINGS_FILE).write_text(json.dumps({key: {
        "ref": "r", "recorded": True, "estimate_commented": True, "actual_commented": False,
        "estimate_comment_body": "e", "actual_comment_body": "a"}}))
    b = P._binding_get(s, "t", None, 7)
    assert P.ledger_outcome(b) is P.LedgerOutcome.RECORDED
    assert P.delivery_state(b, "estimate") is P.Delivery.DELIVERED
    assert P.delivery_state(b, "actual") is P.Delivery.PENDING


# --------------------------------------------------------------------------- stateful property


class BindingMachine(RuleBasedStateMachine):
    """Drive random transitions on one persisted binding; check invariants after every step."""

    def __init__(self):
        super().__init__()
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="epoch-binding-sm-")
        self.s = {"epoch_data_dir": self.dir}
        self.bound = False
        self.outcome = None
        self.ever_delivered = {k: False for k in KINDS}

    def get(self):
        return P._binding_get(self.s, "t", None, 1)

    @rule(body=st.one_of(st.none(), st.text(min_size=1, max_size=5)))
    def bind(self, body):
        P._binding_put_ref(self.s, "t", None, 1, "ref-1", estimate_comment_body=body)
        self.bound = True

    @precondition(lambda self: self.bound)
    @rule(outcome=st.sampled_from(OUTCOMES), keep=st.booleans())
    def record(self, outcome, keep):
        prior = self.outcome
        try:
            P._binding_mark_recorded(self.s, "t", None, 1, status=outcome.value,
                                     actual_comment_body="b-" + outcome.value, keep_existing=keep)
        except P.IllegalBindingTransition:
            assert prior is not None and prior is not outcome and not keep
            assert not (prior is P.LedgerOutcome.DUPLICATE and outcome is P.LedgerOutcome.RECORDED)
            return
        if prior is None:
            self.outcome = outcome
        elif (not keep and prior is P.LedgerOutcome.DUPLICATE
              and outcome is P.LedgerOutcome.RECORDED):
            self.outcome = outcome  # the one allowed upgrade: a racing loser marked first

    @precondition(lambda self: self.bound)
    @rule(kind=st.sampled_from(KINDS))
    def claim(self, kind):
        before = P.delivery_state(self.get(), kind)
        _, status = P._claim_comment_delivery(self.s, "t", None, 1, kind=kind)
        if before in (P.Delivery.NONE, P.Delivery.DELIVERED):
            assert status == P._DELIVERY_TERMINAL
        else:
            assert status in (P._DELIVERY_CLAIMED, P._DELIVERY_CONTESTED)

    @precondition(lambda self: self.bound)
    @rule(kind=st.sampled_from(KINDS))
    def foreign_claim(self, kind):
        key = P._binding_key("t", None, 1)
        if P.delivery_state(self.get(), kind) is P.Delivery.PENDING:
            P._bindings_update(self.s, lambda d: d[key].__setitem__(
                f"{kind.value}_delivery_in_flight", _foreign_live_claim()))

    @precondition(lambda self: self.bound)
    @rule(kind=st.sampled_from(KINDS))
    def expire_claims(self, kind):
        key = P._binding_key("t", None, 1)

        def mutate(d):
            c = d[key].get(f"{kind.value}_delivery_in_flight")
            if isinstance(c, dict):
                c["until"] = 0
        P._bindings_update(self.s, mutate)

    @precondition(lambda self: self.bound)
    @rule(kind=st.sampled_from(KINDS))
    def release(self, kind):
        P._release_comment_delivery(self.s, "t", None, 1, kind=kind)

    @precondition(lambda self: self.bound)
    @rule(kind=st.sampled_from(KINDS))
    def complete(self, kind):
        before = P.delivery_state(self.get(), kind)
        try:
            P._complete_comment_delivery(self.s, "t", None, 1, kind=kind)
        except P.IllegalBindingTransition:
            assert before is P.Delivery.NONE
            return
        self.ever_delivered[kind] = True

    @invariant()
    def check_binding_invariants(self):
        b = self.get()
        if not self.bound:
            assert b is None
            return
        assert set(b) <= PERSISTED_KEYS, set(b) - PERSISTED_KEYS
        assert b["ref"] == "ref-1"  # first writer wins, never redirected
        assert P.ledger_outcome(b) is self.outcome  # terminal outcome is absorbing (bar duplicate→recorded)
        if self.outcome is not None:
            assert b["status"] in {o.value for o in OUTCOMES}
        for kind in KINDS:
            state = P.delivery_state(b, kind)
            if self.ever_delivered[kind]:
                assert state is P.Delivery.DELIVERED  # delivered is absorbing
            if state is P.Delivery.DELIVERED:
                assert f"{kind.value}_delivery_in_flight" not in b


BindingMachine.TestCase.settings = hsettings(
    max_examples=60, stateful_step_count=25, deadline=None, database=None,
    suppress_health_check=[HealthCheck.too_slow])
TestBindingMachine = BindingMachine.TestCase
