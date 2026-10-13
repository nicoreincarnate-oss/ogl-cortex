#!/usr/bin/env python3
"""Tests for the gate's trufflehog step: no raw secret value may land in any gate output,
and unverified candidates need a recorded disposition.

Run: python3 test_secret_redaction.py            (tests cortex_pentest_gate.py next to this file)
     GATE_PATH=<other copy> python3 test_secret_redaction.py   (point it at another gate build)
"""

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

GATE = Path(os.environ.get("GATE_PATH", Path(__file__).with_name("cortex_pentest_gate.py")))
# Fake values shaped like real ones; never real credentials. Built at runtime so this file itself
# does not match a secret scanner when the gate scans the repository that contains it.
# str.join is not constant-folded, so the full value is not in the .pyc either.
RAW_GOOGLE = "".join(["AI", "za", "FAKEfakeFAKEfakeFAKEfakeFAKEfake123"])
RAW_DOCKER = "".join(["dckr", "_pat_", "FAKEfakeFAKEfakeFAKEfake0001"])
RAW_VERIFIED = "".join(["gh", "p_", "FAKEfakeFAKEfakeFAKEfakeFAKEfake0002"])


def row(detector, raw, verified, file, line):
    return {
        "SourceMetadata": {"Data": {"Filesystem": {"file": file, "line": line}}},
        "DetectorName": detector,
        "Verified": verified,
        "Raw": raw,
        "Redacted": raw[:6],
    }


def fake_stdout(include_verified):
    rows = [
        row("GoogleGeminiAPIKey", RAW_GOOGLE, False, "/scan/contact/index.html", 74),
        row("GoogleGeminiAPIKey", RAW_GOOGLE, False, "/scan/.git/objects/77/abc", 74),
        row("Dockerhub", RAW_DOCKER, False, "/scan/_nuxt/x.js", 3),
    ]
    if include_verified:
        rows.append(row("Github", RAW_VERIFIED, True, "/scan/.env", 1))
    return "\n".join(json.dumps(r) for r in rows) + "\n"


def sha12(raw):
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


class SecretRedactionTest(unittest.TestCase):
    def run_gate(self, include_verified=False, dispositions=None):
        spec = importlib.util.spec_from_file_location("gate_under_test", GATE)
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        stdout = fake_stdout(include_verified)
        gate.which = lambda name: "/fake/trufflehog" if name == "trufflehog" else None
        gate.docker_ready = lambda: False
        gate.run_cmd = lambda cmd, cwd=None, timeout=900: {
            "cmd": cmd, "startedAt": "", "returncode": 183, "stdout": stdout,
            "stderr": f"warn: candidate {RAW_DOCKER} found", "timedOut": False,
        }
        root = Path(tempfile.mkdtemp(prefix="gate-redact-"))
        out = root / "security"
        out.mkdir()
        if dispositions:
            (out / "secret-dispositions.json").write_text(json.dumps(dispositions))
        sys.argv = ["gate", str(root), "--output", "security"]
        rc = gate.main()
        report = json.loads((out / "pentest-gate-report.json").read_text())
        return rc, out, report

    def test_no_raw_secret_value_in_any_gate_output(self):
        _, out, _ = self.run_gate(include_verified=True)
        for path in out.rglob("*"):
            if path.is_file() and path.name != "secret-dispositions.json":
                text = path.read_text(errors="replace")
                for raw in (RAW_GOOGLE, RAW_DOCKER, RAW_VERIFIED):
                    self.assertNotIn(raw, text, f"raw value landed in {path.name}")

    def test_findings_keep_detector_file_sha12(self):
        _, out, _ = self.run_gate()
        rows = [json.loads(l) for l in (out / "trufflehog.jsonl").read_text().splitlines() if l.strip()]
        self.assertEqual(len(rows), 3)
        self.assertEqual({r["sha12"] for r in rows}, {sha12(RAW_GOOGLE), sha12(RAW_DOCKER)})
        self.assertTrue(all(r.get("detector") and r.get("file") for r in rows))

    def test_undispositioned_unverified_hit_blocks(self):
        rc, _, report = self.run_gate()
        titles = [i["title"] for i in report["issues"] if i["severity"] == "blocker"]
        self.assertTrue(any("without a recorded disposition" in t for t in titles), titles)
        self.assertEqual(rc, 1)

    def test_recorded_dispositions_clear_unverified_hits(self):
        rc, _, report = self.run_gate(dispositions={
            sha12(RAW_GOOGLE): {"disposition": "accepted_risk", "note": "referrer-restricted browser key"},
            sha12(RAW_DOCKER): {"disposition": "false_positive", "note": "minified js"},
        })
        self.assertFalse([i for i in report["issues"] if i["severity"] == "blocker" and i["tool"] == "trufflehog"])
        disp = {g["sha12"]: g["disposition"] for g in report["scans"]["secrets-trufflehog"]["dispositions"]}
        self.assertEqual(disp, {sha12(RAW_GOOGLE): "accepted_risk", sha12(RAW_DOCKER): "false_positive"})
        self.assertEqual(rc, 0)

    def test_verified_hit_still_blocks_even_with_a_disposition(self):
        _, _, report = self.run_gate(include_verified=True, dispositions={
            sha12(RAW_VERIFIED): {"disposition": "accepted_risk"},
        })
        titles = [i["title"] for i in report["issues"] if i["severity"] == "blocker"]
        self.assertTrue(any(t.startswith("Verified secrets detected") for t in titles), titles)


class SharedFixtureTest(SecretRedactionTest):
    """Shared test_fixture list: clears matching UNVERIFIED hits only, and only valid entries."""

    def with_shared(self, entries, **kw):
        path = Path(tempfile.mkdtemp(prefix="gate-shared-")) / "shared-test-fixtures.json"
        path.write_text(json.dumps(entries))
        os.environ["OGL_GATE_SHARED_FIXTURES"] = str(path)
        try:
            return self.run_gate(**kw)
        finally:
            del os.environ["OGL_GATE_SHARED_FIXTURES"]

    def entry(self, detector, evidence="pkg README example", expires="2099-01-01"):
        return {"detector": detector, "evidence": evidence, "expires": expires}

    def test_shared_entry_clears_matching_unverified_hits(self):
        rc, _, report = self.with_shared({
            sha12(RAW_GOOGLE): self.entry("GoogleGeminiAPIKey"),
            sha12(RAW_DOCKER): self.entry("Dockerhub"),
        })
        disp = {g["sha12"]: (g["disposition"], g.get("dispositionSource")) for g in report["scans"]["secrets-trufflehog"]["dispositions"]}
        self.assertEqual(disp[sha12(RAW_GOOGLE)], ("test_fixture", "shared"))
        self.assertEqual(rc, 0)

    def test_shared_entry_never_clears_a_verified_hit(self):
        _, _, report = self.with_shared({sha12(RAW_VERIFIED): self.entry("Github")}, include_verified=True)
        titles = [i["title"] for i in report["issues"] if i["severity"] == "blocker"]
        self.assertTrue(any(t.startswith("Verified secrets detected") for t in titles), titles)
        disp = {g["sha12"]: g["disposition"] for g in report["scans"]["secrets-trufflehog"]["dispositions"]}
        self.assertEqual(disp[sha12(RAW_VERIFIED)], "UNDISPOSITIONED", "a live credential must never be labelled test_fixture")

    def test_invalid_shared_entries_are_ignored(self):
        for bad in (self.entry("Dockerhub"), self.entry("GoogleGeminiAPIKey", evidence="  "),
                    self.entry("GoogleGeminiAPIKey", expires="2000-01-01")):
            rc, _, report = self.with_shared({sha12(RAW_GOOGLE): bad, sha12(RAW_DOCKER): self.entry("Dockerhub")})
            disp = {g["sha12"]: g["disposition"] for g in report["scans"]["secrets-trufflehog"]["dispositions"]}
            self.assertEqual(disp[sha12(RAW_GOOGLE)], "UNDISPOSITIONED", bad)
            self.assertEqual(rc, 1)

    def test_site_disposition_wins_over_shared(self):
        _, _, report = self.with_shared(
            {sha12(RAW_GOOGLE): self.entry("GoogleGeminiAPIKey")},
            dispositions={sha12(RAW_GOOGLE): {"disposition": "rotated", "note": "rotated"}},
        )
        disp = {g["sha12"]: g["disposition"] for g in report["scans"]["secrets-trufflehog"]["dispositions"]}
        self.assertEqual(disp[sha12(RAW_GOOGLE)], "rotated")


if __name__ == "__main__":
    unittest.main(verbosity=2)
