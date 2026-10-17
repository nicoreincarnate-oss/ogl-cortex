#!/usr/bin/env python3
"""Run every hook and tool test and print one summary line each. Exit 0 only if all pass.
Usage: python3 harness/tests/run_all.py"""
import importlib, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
TESTS = ["test_ship_gate", "test_shared_surface_guard", "test_orwell_lint", "test_brief_guard",
         "test_future_time_guard", "test_compaction", "test_tools"]
TESTS.append("test_pentest_gate")
TESTS += ["test_memory_hooks", "test_session_digest", "test_client_graph", "test_install_memory"]

ok = True
for name in TESTS:
    ok = importlib.import_module(name).main() and ok
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
