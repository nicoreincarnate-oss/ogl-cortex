# Troubleshooting

The 15 failures a new OGL Cortex operator meets first. Each entry gives the symptom, the cause in one line, the check command, the fix, and the full runbook.

Path names: `$CTX_ROOT` is `~/.cortextos/<instance>`; `<instance>` is your daemon instance id; `<seat>` is an agent name; `$SEAT_DIR` is `$CORTEX_HOME/orgs/<org>/agents/<seat>`. Full conventions are in [docs/30-sre-runbooks.md](docs/30-sre-runbooks.md#conventions).

| # | Symptom | Runbook |
|---|---|---|
| 1 | "Daemon is not running" but seats work | [RB-03](docs/30-sre-runbooks.md#rb-03-daemon-down-or-a-seat-needs-a-restart) |
| 2 | Seat ignores every Telegram message | [RB-04](docs/30-sre-runbooks.md#rb-04-telegram-not-delivering) |
| 3 | Owner gets nothing from a seat | [RB-04](docs/30-sre-runbooks.md#rb-04-telegram-not-delivering) |
| 4 | A file sent on Telegram never arrives | [RB-04](docs/30-sre-runbooks.md#rb-04-telegram-not-delivering) |
| 5 | A cron never fires | [RB-10](docs/30-sre-runbooks.md#rb-10-cron-not-firing) |
| 6 | MCP server fails to connect | [RB-07](docs/30-sre-runbooks.md#rb-07-mcp-server-down) |
| 7 | A hook blocks a command | [RB-05](docs/30-sre-runbooks.md#rb-05-swap-spike-or-low-free-disk), [FAQ](docs/41-support-known-issues-faq.md#4-faq) |
| 8 | Seat is slow and forgets things | [RB-12](docs/30-sre-runbooks.md#rb-12-seat-context-too-full) |
| 9 | Every seat stops at once | [RB-01](docs/30-sre-runbooks.md#rb-01-claude-weekly-cap-outage-or-rate-limit) |
| 10 | Disk or swap page | [RB-05](docs/30-sre-runbooks.md#rb-05-swap-spike-or-low-free-disk) |
| 11 | Google 403/404 or "logged out" | [RB-09](docs/30-sre-runbooks.md#rb-09-google-oauth-on-the-wrong-account) |
| 12 | Owner's messages wait with no reply | [RB-02](docs/30-sre-runbooks.md#rb-02-a-seat-is-busy-and-messages-go-unanswered) |
| 13 | Deploy blocked, or gate passed with no scan | [RB-11](docs/30-sre-runbooks.md#rb-11-bad-deploy) |
| 14 | Live site wrong after a deploy | [RB-11](docs/30-sre-runbooks.md#rb-11-bad-deploy) |
| 15 | A secret was pasted into chat or committed | [RB-06](docs/30-sre-runbooks.md#rb-06-leaked-or-compromised-key) |

---

## 1. "Daemon is not running", but the seats are working

The command-line tool is named `cortextos`.

**Cause.** `cortextos restart`, `stop`, `start` and `doctor` default to `--instance default`, and your shell does not set `CTX_INSTANCE_ID`.

**Check**
```bash
echo "$CTX_INSTANCE_ID"; pm2 jlist | python3 -c "import json,sys;[print(p['name'],p['pm2_env']['status']) for p in json.load(sys.stdin)]"
```

**Fix.** Pass the instance on every lifecycle command: `cortextos restart <seat> --instance <instance>`. Add `export CTX_INSTANCE_ID=<instance>` to your shell profile. Never run `cortextos start` while pm2 shows `cortextos-daemon` online.

**Runbook.** [RB-03](docs/30-sre-runbooks.md#rb-03-daemon-down-or-a-seat-needs-a-restart)

## 2. The seat ignores every Telegram message

**Cause.** The seat's `.env` has `BOT_TOKEN` but no valid numeric `ALLOWED_USER`, so the daemon refuses to enable Telegram.

**Check**
```bash
grep -E '^(BOT_TOKEN|CHAT_ID|ALLOWED_USER)=' $SEAT_DIR/.env | sed 's/=.*/=<set>/'
grep -i "SECURITY: ALLOWED_USER" ~/.pm2/logs/cortextos-daemon-out.log | tail -3
```

**Fix.** Set `ALLOWED_USER=<your numeric Telegram user id>` (comma-separated for more than one person), then `cortextos restart <seat> --instance <instance>`.

**Runbook.** [RB-04](docs/30-sre-runbooks.md#rb-04-telegram-not-delivering)

## 3. The owner gets nothing from a seat

**Cause.** Most often a network dip in the poller, a send the guard refused, or a `$` in double quotes that mangled the text.

**Check**
```bash
tail -3 $CTX_ROOT/logs/<seat>/outbound-messages.jsonl
grep -c "fetch failed" ~/.pm2/logs/cortextos-daemon-out.log
tail -5 ~/.ogl-cortex/state/orwell-lint.log
```

**Fix.** No line in the outbound log means the send never succeeded: read the guard log and reword. Network dips heal by themselves; if the poller stays dead with a working network, run `pm2 restart cortextos-daemon`. Put any text with `$` in single quotes.

**Runbook.** [RB-04](docs/30-sre-runbooks.md#rb-04-telegram-not-delivering)

## 4. A file sent on Telegram never arrives

**Cause.** Telegram bots cannot download files over 20 MB.

**Check**
```bash
grep -n "DOWNLOAD_FAILED" $CTX_ROOT/logs/<seat>/stdout.log | tail -3
```

**Fix.** Share a cloud link, or split the file below 20 MB.

**Runbook.** [RB-04](docs/30-sre-runbooks.md#rb-04-telegram-not-delivering)

## 5. A cron never fires

**Cause.** An interval schedule at or above the seat's heartbeat interval can drift past its slot again and again; other causes are a disabled cron, a dead seat, or the host time zone.

**Check**
```bash
cortextos bus list-crons <seat>
cortextos bus get-cron-log <seat> <name>
```

**Fix.** Switch to a 5-field wall-clock schedule: `cortextos bus update-cron <seat> <name> --interval "0 */6 * * *"`. Re-enable with `--enabled true`. Test once with `cortextos bus test-cron-fire <seat> <name>`, then confirm the next real fire by the job's own artifact.

**Runbook.** [RB-10](docs/30-sre-runbooks.md#rb-10-cron-not-firing)

## 6. An MCP server fails to connect

**Cause.** A missing binary after a cache cleanup, an expired token, a moved endpoint, or a config path that points at a deleted file.

**Check**
```bash
claude mcp list
claude mcp get <name>
```

**Fix.** Repair the path or token, or re-add the server with `claude mcp remove <name>` and `claude mcp add ...`. Pin versions (`uvx <pkg>==<version>`). Restart affected seats one at a time.

**Runbook.** [RB-07](docs/30-sre-runbooks.md#rb-07-mcp-server-down)

## 7. A hook blocks a command

**Cause.** A PreToolUse guard exited with code 2. The reason is in its stderr and its log. Common ones: the shared-surface guard (a delete or write on a shared path), the send guard (banned words in an outgoing message), the brief guard (dispatch without `TASK`, `FILES`, `BAR`, `RETURN`), the future-time guard (a UTC stamp in the future).

**Check**
```bash
tail -5 ~/.ogl-cortex/state/surface-guard.log     # $OGL_STATE_DIR when set
tail -5 ~/.ogl-cortex/state/orwell-lint.log
```

**Fix.** Read the reason and fix the command. For the shared-surface guard, check the consumers it names, take a backup, then release one command with `touch ~/.ogl-cortex/state/.surface-pass-once-$CTX_AGENT_NAME`. For the send guard, reword; the one-send escape is `touch ~/.ogl-cortex/state/.orwell-pass-once-$CTX_AGENT_NAME`. Never disable a guard to get past one block.

**Runbook.** [RB-05](docs/30-sre-runbooks.md#rb-05-swap-spike-or-low-free-disk) for cleanup blocks; [FAQ 4.1 to 4.3 and 4.10](docs/41-support-known-issues-faq.md#4-faq) for the others.

## 8. A seat is slow, repeats itself, or forgets earlier details

**Cause.** Its context window is nearly full.

**Check**
```bash
cat $CTX_ROOT/state/<seat>/context_status.json
```

**Fix.** Update `STATE.md`, write a handoff, then from inside the seat run `cortextos bus hard-restart --reason "context full" --handoff-doc <path>`. Tune `ctx_warning_threshold` and `ctx_handoff_threshold` in the seat's `config.json` (defaults 30 and 60).

**Runbook.** [RB-12](docs/30-sre-runbooks.md#rb-12-seat-context-too-full)

## 9. Every seat stops at the same moment

**Cause.** The Claude account hit its 7-day usage cap. All seats on one account share one meter.

**Check**
```bash
cortextos bus check-usage-api --json
tail -5 $CTX_ROOT/logs/auth-sentinel.log
```

**Fix.** Do not restart; a restart cannot run until quota resets. Wait for `seven_day.resets_at`. Only an alert of kind `auth` means a login problem: run `claude /login`, then `pm2 restart cortextos-daemon`.

**Runbook.** [RB-01](docs/30-sre-runbooks.md#rb-01-claude-weekly-cap-outage-or-rate-limit)

## 10. Disk or swap page

**Cause.** A download, a local model load, a container VM or a runaway scan filled disk; on macOS each new swap file takes about 1 GB of the same disk.

**Check**
```bash
df -m /; sysctl -n vm.swapusage; ls /System/Volumes/VM | grep -c swapfile
ps aux -m | head -10
```

**Fix.** Stop the process that is growing and delete its own download. Never prune shared caches that running MCP servers use. Before any local model load, keep free disk at least twice the model size.

**Runbook.** [RB-05](docs/30-sre-runbooks.md#rb-05-swap-spike-or-low-free-disk)

## 11. Google returns 403 or 404, or a seat says "logged out"

**Cause.** The call used the wrong Google account, or a Workspace MCP session bound to one account wrote its token into another account's credential file.

**Check**
```bash
ls ~/.google_workspace_mcp/credentials/
```

**Fix.** Retry with the other account before you call it a login problem. Use the MCP only for its bound account. Consider an account guard hook that blocks calls for other accounts (optional, not included in this repository). If a credential file holds the wrong account, re-authorise it with a script that checks the token's real identity; a human taps the consent screen.

**Runbook.** [RB-09](docs/30-sre-runbooks.md#rb-09-google-oauth-on-the-wrong-account)

## 12. The owner's messages wait with no reply

**Cause.** The seat is inside a long tool call (a render, a build, a download) and cannot read Telegram until it returns.

**Check**
```bash
tail -c 2000 $CTX_ROOT/logs/<seat>/stdout.log
tail -1 $CTX_ROOT/logs/<seat>/inbound-messages.jsonl; tail -1 $CTX_ROOT/logs/<seat>/outbound-messages.jsonl
```

**Fix.** `cortextos notify-agent <seat> "<text>"` to interrupt. Prevent it: long jobs go to a background subagent, a background shell, or `cortextos spawn-worker`. A seat that must stay busy sends "parked until HH:MM" first.

**Runbook.** [RB-02](docs/30-sre-runbooks.md#rb-02-a-seat-is-busy-and-messages-go-unanswered)

## 13. A deploy is blocked, or the gate passed with no scan

**Cause.** The ship gate hook found no passing pentest report; or the gate ran without `--url`, which skips the web scan and can still report `pass`.

**Check**
```bash
ls -la security/
python3 -c "import json;d=json.load(open('security/pentest-gate-report.json'));print(d.get('status'))"
```

**Fix.** Run the gate with `--url` against the candidate or local URL, then deploy through `ship.sh`, never raw `vercel --prod`. Owner-accepted findings go in a separate acceptance note under `security/`; the report keeps its true verdict.

**Runbook.** [RB-11](docs/30-sre-runbooks.md#rb-11-bad-deploy)

## 14. The live site is wrong after a deploy

**Cause.** `ship.sh` exited 5 (production on an ungated or broken build), or the deploy ran from the wrong directory or an out-of-date source.

**Check**
```bash
cd <site-dir> && vercel ls | head -5 && vercel inspect <prod-domain>
curl -s -o /dev/null -w '%{http_code}\n' https://<prod-domain>/
```

**Fix.** `vercel rollback <previous-good-url-or-id>`. Allow a few minutes for the edge cache. Then fix the source and ship again through `ship.sh` until it exits 0.

**Runbook.** [RB-11](docs/30-sre-runbooks.md#rb-11-bad-deploy)

## 15. A secret was pasted into chat or committed to git

**Cause.** Any secret that leaves its mode-600 file or keychain entry is leaked, including into git history after the file is untracked.

**Check**
```bash
git log --oneline --all -- <file>
git remote -v
```

**Fix.** Rotate the secret in the vendor's dashboard first. Store the new value in a mode-600 file or the keychain. Update every consumer. Prove the old value is dead and the new one works. Rewrite history before you add any remote.

**Runbook.** [RB-06](docs/30-sre-runbooks.md#rb-06-leaked-or-compromised-key)

---

More: [Known issues and FAQ](docs/41-support-known-issues-faq.md) · [Observability](docs/31-observability-alerting.md) · [Security model](docs/32-security-red-team-log.md)
