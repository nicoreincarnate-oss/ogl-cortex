"""Behavioral tests for embed pacing + retry in mmrag.

Run from knowledge-base/scripts:

    ../venv/bin/python3 -m _test_clients.test_embed_pacing

Exits 0 on all-pass, 1 on any failure.

Covers rick's three acceptance criteria for the free-tier quota fix:
  (a) pacing keeps embeds under the per-minute cap on a 200+ chunk workload
  (b) the embed retry path handles 429/500/503 with bounded backoff, and
      fails fast on non-transient errors — same predicate as generate_content
  (c) resume-after-kill picks up where it died WITHOUT --force

Clocks are injected, so the 200-chunk pacing test runs in milliseconds rather
than the ~2.2 real minutes the pacing would otherwise impose.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)

import mmrag  # noqa: E402
from _test_clients.fault_injection import make_client, _InjectedAPIError  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


class FakeClock:
    """Monotonic clock that only advances when the code under test sleeps."""
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s

    def tick(self, s):
        self.t += s


# --- (a) pacing ------------------------------------------------------------

def test_pacing_under_cap():
    """200 embeds must never exceed the cap within any 60s window."""
    mmrag._embed_call_times.clear()
    clock = FakeClock()
    cap = mmrag.EMBED_RATE_LIMIT_PER_MIN
    issued = []
    for _ in range(200):
        mmrag._pace_embed_call(now_fn=clock.now, sleep_fn=clock.sleep)
        issued.append(clock.now())

    worst = 0
    for i, t in enumerate(issued):
        in_window = sum(1 for u in issued if t - 60.0 < u <= t)
        worst = max(worst, in_window)
    check("(a) 200 embeds never exceed cap in any 60s window",
          worst <= cap, f"(worst window held {worst}, cap {cap})")
    check("(a) pacing actually engaged on a 200-chunk load",
          len(clock.slept) > 0, "(no sleeps recorded)")
    check("(a) total elapsed is bounded and sane",
          clock.now() >= 60.0, f"(elapsed {clock.now():.1f}s)")


def test_small_ingest_pays_nothing():
    """The common case — a small memory file — must not sleep at all."""
    mmrag._embed_call_times.clear()
    clock = FakeClock()
    for _ in range(mmrag.EMBED_RATE_LIMIT_PER_MIN - 1):
        mmrag._pace_embed_call(now_fn=clock.now, sleep_fn=clock.sleep)
    check("(a) under-cap ingest never sleeps",
          clock.slept == [], f"(slept {clock.slept})")


def test_window_slides():
    """Calls aging out of the window free capacity without sleeping."""
    mmrag._embed_call_times.clear()
    clock = FakeClock()
    for _ in range(mmrag.EMBED_RATE_LIMIT_PER_MIN):
        mmrag._pace_embed_call(now_fn=clock.now, sleep_fn=clock.sleep)
    clock.tick(61.0)                      # whole window ages out
    mmrag._pace_embed_call(now_fn=clock.now, sleep_fn=clock.sleep)
    check("(a) sliding window frees capacity as calls age out",
          clock.slept == [], f"(slept {clock.slept})")


# --- (b) retry -------------------------------------------------------------

def test_retry_transient_then_success():
    calls = {"n": 0}

    def call():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _InjectedAPIError(429, "RESOURCE_EXHAUSTED", "injected quota")
        return "ok"

    out = mmrag._retry_embed_content(call, backoffs=(0, 0, 0))
    check("(b) 429 then success -> returns, no raise", out == "ok", f"(got {out!r})")
    check("(b) retried exactly once", calls["n"] == 2, f"(calls {calls['n']})")


def test_retry_exhausts():
    def call():
        raise _InjectedAPIError(503, "UNAVAILABLE", "injected")
    try:
        mmrag._retry_embed_content(call, backoffs=(0, 0, 0))
        check("(b) exhausted retries re-raise", False, "(no raise)")
    except _InjectedAPIError as e:
        check("(b) exhausted retries re-raise last error", e.code == 503)


def test_retry_fail_fast_nontransient():
    """403 must raise immediately — predicate is structural, not textual."""
    calls = {"n": 0}

    def call():
        calls["n"] += 1
        raise _InjectedAPIError(403, "PERMISSION_DENIED", "mentions 429 in body")

    try:
        mmrag._retry_embed_content(call, backoffs=(0, 0, 0))
        check("(b) non-transient fails fast", False, "(no raise)")
    except _InjectedAPIError:
        check("(b) non-transient fails fast without retrying", calls["n"] == 1,
              f"(calls {calls['n']})")


# --- (c) resumability ------------------------------------------------------

def test_resume_without_force():
    """already_exists must skip previously-ingested chunks when --force is off,
    which is what makes a quota-killed ingest resume instead of restart."""
    class Coll:
        def __init__(self, have):
            self.have = set(have)

        def get(self, ids=None):
            found = [i for i in (ids or []) if i in self.have]
            return {"ids": found}

    coll = Coll({"doc-0", "doc-1"})
    prev_force = getattr(mmrag, "args_force", False)
    try:
        mmrag.args_force = False
        skipped = mmrag.already_exists(coll, "doc-0")
        fresh = mmrag.already_exists(coll, "doc-9")
        check("(c) resume: prior chunk is skipped without --force", skipped is True)
        check("(c) resume: unseen chunk is not skipped", fresh is False)
        mmrag.args_force = True
        check("(c) --force still re-embeds everything (semantics unchanged)",
              mmrag.already_exists(coll, "doc-0") is False)
    finally:
        mmrag.args_force = prev_force


def test_per_day_quota_fails_fast():
    """A PER-DAY 429 must not be retried — it cannot clear inside the backoff
    window, so retrying only burns 65s and more tokens before failing anyway.
    A PER-MINUTE 429 must still be retried. Same HTTP code, opposite handling."""
    per_day_msg = ("429 RESOURCE_EXHAUSTED. quotaId: "
                   "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier, quotaValue: 1000")
    per_min_msg = ("429 RESOURCE_EXHAUSTED. quotaId: "
                   "EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier, limit: 100")

    calls = {"n": 0}

    def day_call():
        calls["n"] += 1
        raise _InjectedAPIError(429, "RESOURCE_EXHAUSTED", per_day_msg)

    try:
        mmrag._retry_embed_content(day_call, backoffs=(0, 0, 0))
        check("(d) per-day 429 fails fast", False, "(no raise)")
    except _InjectedAPIError:
        check("(d) per-day 429 raises WITHOUT retrying", calls["n"] == 1,
              f"(calls {calls['n']}, expected 1)")

    calls2 = {"n": 0}

    def min_call():
        calls2["n"] += 1
        if calls2["n"] == 1:
            raise _InjectedAPIError(429, "RESOURCE_EXHAUSTED", per_min_msg)
        return "ok"

    out = mmrag._retry_embed_content(min_call, backoffs=(0, 0, 0))
    check("(d) per-minute 429 IS still retried", out == "ok" and calls2["n"] == 2,
          f"(out {out!r}, calls {calls2['n']})")


def main():
    print("mmrag embed pacing + retry")
    for fn in (test_pacing_under_cap, test_small_ingest_pays_nothing, test_window_slides,
               test_retry_transient_then_success, test_retry_exhausts,
               test_retry_fail_fast_nontransient, test_per_day_quota_fails_fast,
               test_resume_without_force):
        fn()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} -> {', '.join(FAILURES)}")
        return 1
    print("All embed pacing/retry tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
