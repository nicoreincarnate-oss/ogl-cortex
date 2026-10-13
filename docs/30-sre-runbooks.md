# 30. SRE runbooks

Twelve runbooks for the failures an OGL Cortex install meets most often. Each one follows the same shape: symptom, check, fix, verify, rollback, owner.

Related documents:
- `31-observability-alerting.md` lists every signal and who hears it.
- `32-security-red-team-log.md` covers attack surfaces and secret handling.
- `33-cookbook.md` holds the normal "how do I" recipes, including the ship path.
- `41-support-known-issues-faq.md` holds the triage flow and FAQ.
- `../TROUBLESHOOTING.md` is the one-page quick index into these runbooks.

## Conventions

### Paths

| Name | Meaning | Default |
|---|---|---|
| `$CORTEX_HOME` | The cortextOS framework checkout | wherever you cloned it |
| `<instance>` | Daemon instance id. Set by `CTX_INSTANCE_ID` | `default` unless you chose another at install |
| `$CTX_ROOT` | Runtime state for one instance | `~/.cortextos/<instance>` |
| `<org>`, `<seat>` | Organisation name and agent (seat) name | set by `cortextos init` and `cortextos add-agent` |
| `$SEAT_DIR` | A seat's working directory | `$CORTEX_HOME/orgs/<org>/agents/<seat>` |
| `$SENTINEL_DIR` | Directory that holds the launchd sentinel scripts, with `logs/` and `state/` below it | chosen at install |
| `$SHIP` | The `ship.sh` deploy wrapper | chosen at install |

Inside a seat, the shell already exports `CTX_INSTANCE_ID`, `CTX_ROOT` and `CTX_AGENT_NAME`. In your own terminal they are usually unset. Several lifecycle commands then fall back to the instance called `default` (see RB-03).

### Roles

OGL Cortex runs a small fleet of long-lived Claude Code sessions called seats. The runbooks name roles, not seats. Map them to your own seat names.

| Role | Does | Example seat name |
|---|---|---|
| Owner | The human. Pays bills, taps login screens, approves risky actions | n/a |
| Orchestrator | Talks to the owner, dispatches work, decides what the owner hears | `boss` |
| Ops | Daemon, pm2, launchd sentinels, guard installs | `ops` |
| Infra watch | Disk, swap, external sites, DNS | `watch` |
| Analyst | Usage meter, metrics, fleet health trends | `analyst` |
| Auditor | Re-runs claims and gates guard changes | `auditor` |

### Command safety

**Check** blocks hold read-only commands. **Fix** blocks change state. Run a fix only with the owning role's go.

## Summary table

| ID | Failure | First sign | First check |
|---|---|---|---|
| RB-01 | Claude weekly cap, outage or rate limit | Every seat stops mid-reply | `cortextos bus check-usage-api` |
| RB-02 | A seat is busy and messages go unanswered | Owner sends "?" and waits | inbound vs outbound log gap |
| RB-03 | Daemon down, or a seat needs a restart | CLI says "Daemon is not running" | `pm2 jlist`, `cortextos status --instance <instance>` |
| RB-04 | Telegram not delivering | Owner gets nothing, or a file never arrives | outbound log, pm2 daemon error log |
| RB-05 | Swap spike or low free disk | Disk or swap page | `df -m /`, `sysctl vm.swapusage` |
| RB-06 | Leaked or compromised key | A secret shows up in chat, git or a log | `git log --all -- <file>` |
| RB-07 | MCP server down | "failed to connect" at session start | `claude mcp list` |
| RB-08 | Vendor billing failure | Billing alert, site paused | `curl` the site |
| RB-09 | Google OAuth on the wrong account | 403 or 404 on docs that exist | credential identity state |
| RB-10 | Cron not firing | Expected artifact missing | `cortextos bus list-crons <seat>` |
| RB-11 | Bad deploy | Live site wrong, `ship.sh` exit 5 | `vercel inspect <domain>` |
| RB-12 | Seat context too full | Seat slow, repeats itself | `context_status.json` |

---

## RB-01 Claude weekly cap, outage or rate limit

**What it is.** Every Claude Code seat signed in to the same Claude account draws on one usage meter. The plan has a rolling 5-hour window and a 7-day window. When the 7-day window hits its cap, every seat on that account stops at once. Nothing local brings them back before the reset.

**Symptom**
- Every seat stops mid-reply at the same minute.
- The auth sentinel sends a "usage limit" alert, not a login alert.
- Heartbeats can stay fresh while the seats are mute, because shell sentinels also write liveness files.

**Check**
```bash
cortextos bus check-usage-api --json            # five_hour and seven_day utilisation plus resets_at
tail -3 $SENTINEL_DIR/state/quota-ledger.jsonl    # ledger history and pace, if the quota ledger is installed
tail -5 $CTX_ROOT/logs/auth-sentinel.log          # OK / ALERT kind=cap|auth|probe
```
Read the alert kind:
- `kind=cap`: usage cap. There is nothing to run. Wait for `resets_at`.
- `kind=auth`: the login broke. Go to Fix step 3.
- `kind=probe`: anything else, often a short 429 rate limit. The sentinel keeps a plain 429 out of `kind=cap` on purpose.

**Fix**
1. Cap hit: do not retry and do not restart. A seat that is still alive writes its state to daily memory and a handoff, then tells the owner once what is parked and when the cap resets.
2. Plan ahead. The pre-reset burn pattern in `33-cookbook.md` (Recipe 11) spends spare weekly quota on internal backlog before the reset, with a hard stop at 97%.
3. Login broken (`kind=auth` only): the owner runs `claude /login` in a terminal, then ops runs `pm2 restart cortextos-daemon`.
4. Provider outage: check the Claude status page. Tell the owner once, then wait.

**Verify.** After the reset, `cortextos bus check-usage-api --force` shows `seven_day` near zero, and each seat writes a new heartbeat (`cortextos bus read-all-heartbeats`).

**Rollback.** Nothing to roll back. A restart run by mistake during a cap does no harm; the seats come back at the reset.

**Owner.** Ops owns the auth sentinel and quota ledger. Analyst owns the usage meter. Orchestrator owns the handoff and the single message to the owner.

---

## RB-02 A seat is busy and messages go unanswered

**What it is.** A seat starts a long job inside its own session: a video render, a big build, a model download. Telegram messages queue while the tool call runs. The seat cannot reply until the call returns.

**Symptom**
- The owner sends short follow-ups like "?".
- The newest message in the chat is the owner's and is more than a few minutes old.

**Check.** This read-only script lists every inbound message that waited more than 8 minutes for the next outbound message.
```bash
cd $CTX_ROOT/logs/<seat> && python3 - <<'E'
import json; from datetime import datetime
p=lambda s: datetime.fromisoformat(str(s).replace('Z','+00:00')).timestamp()
I=[json.loads(l) for l in open('inbound-messages.jsonl') if l.strip()]
O=sorted(p(json.loads(l)['timestamp']) for l in open('outbound-messages.jsonl') if l.strip())
for d in I[-60:]:
    t=p(d['timestamp']); n=[o for o in O if o>=t]
    if n and (n[0]-t)/60>8: print(d['timestamp'], round((n[0]-t)/60,1),'min')
E
```
The next outbound message is a proxy for "answered". It may answer a different message.

Also useful:
```bash
tail -c 2000 $CTX_ROOT/logs/<seat>/stdout.log        # is the session inside a tool call?
ps aux | grep -E "ffmpeg|playwright|render" | grep -v grep
cat $CTX_ROOT/state/<seat>/heartbeat.json
```

**Fix**
1. Seat alive but busy: `cortextos notify-agent <seat> "<text>"` injects an urgent note through the fast-checker.
2. Prevention, inside the seat: move anything longer than a few minutes to a background subagent, a background shell, or a worker (`cortextos spawn-worker`). Keep the main session free for Telegram.
3. When a long job must stay in the session, send one line first: "parked until HH:MM".

**Verify.** Re-run the gap script after the next exchange. No new rows.

**Rollback.** None.

**Owner.** Orchestrator.

---

## RB-03 Daemon down, or a seat needs a restart

**What it is.** One process, the cortextOS daemon, runs every seat. It runs under pm2 as `cortextos-daemon`. State lives under `$CTX_ROOT`.

**The instance trap.** `cortextos restart`, `stop`, `start` and `doctor` take `--instance <id>` with a default of `default`. Run from a shell without `CTX_INSTANCE_ID`, they read the wrong state tree and print "Daemon is not running" while the daemon is fine.

**Symptom**
- Every seat silent, and no cap alert (rules out RB-01).
- The CLI says "Daemon is not running".
- One seat is wedged: its process is up, but its context meter and heartbeat stop moving.

**Check**
```bash
pm2 jlist | python3 -c "import json,sys;[print(p['name'],p['pm2_env']['status'],p['pm2_env'].get('restart_time')) for p in json.load(sys.stdin)]"
echo "$CTX_INSTANCE_ID"                              # empty in your own terminal
cortextos status --instance <instance>               # per-seat PID, uptime, model
cortextos bus read-all-heartbeats | grep -v STALE
tail -20 ~/.pm2/logs/cortextos-daemon-error.log
tail -5 $CTX_ROOT/logs/<seat>/restarts.log
```

**Fix**
1. One seat wedged: ask it to soft-restart at a clean point (`cortextos bus self-restart --reason "<why>"` from inside the seat). If it cannot, restart it from outside: `cortextos restart <seat> --instance <instance>`, or `cortextos bus soft-restart <seat> "<reason>"`.
2. Daemon down (pm2 shows `stopped` or `errored`): `pm2 restart cortextos-daemon`.
3. Never run `cortextos start` while pm2 shows the daemon `online`. A second daemon can orphan seats.
4. After a reboot, pm2 must bring the daemon back. Run `pm2 save` after any change to the process list, and make sure a login item or LaunchAgent runs `pm2 resurrect`.
5. Restarting the daemon does not restart side services (tunnels, local servers, sentinels). Check the LaunchAgents your work depends on.
6. When the owner asks for a restart of the orchestrator, ask first: fresh session, or keep history?

**Verify.** `cortextos status --instance <instance>` shows every enabled seat with a new PID and a short uptime. Each seat writes a fresh heartbeat within one heartbeat interval.

**Rollback.** A restart has no undo. A hard restart drops the conversation. Recover from `STATE.md`, daily memory and the newest handoff in `memory/handoffs/`.

**Owner.** Ops for the daemon and pm2. Orchestrator for asking seats to self-restart.

**Tip.** Export `CTX_INSTANCE_ID=<instance>` in your shell profile so the default stops biting.

---

## RB-04 Telegram not delivering

**What it is.** Telegram is the main channel to the owner. The daemon polls the Bot API for incoming messages. Seats send with `cortextos bus send-telegram <chat-id> '<msg>'`, which appends each successful send to `$CTX_ROOT/logs/<seat>/outbound-messages.jsonl`.

**Symptom**
- The owner says nothing arrived.
- The owner sent a file and the seat never saw it.
- A send returned an error, or a hook blocked it.

**Check**
```bash
tail -3 $CTX_ROOT/logs/<seat>/outbound-messages.jsonl    # timestamp, chat_id, message_id
tail -3 $CTX_ROOT/logs/<seat>/inbound-messages.jsonl
grep -c "fetch failed" ~/.pm2/logs/cortextos-daemon-out.log
grep -iE "telegram|409" ~/.pm2/logs/cortextos-daemon-error.log | tail -5
grep -n "ALLOWED_USER" $SEAT_DIR/.env | sed 's/=.*/=<set>/'   # present? value hidden
tail -5 ~/.claude/hooks/orwell-lint.log                      # did the send guard refuse it?
```

**Known causes, most common first**
1. **Network dips.** The poller logs `fetch failed` and retries on its own.
2. **No valid `ALLOWED_USER`.** The daemon refuses to enable Telegram for a seat whose `.env` has `BOT_TOKEN` but no numeric `ALLOWED_USER`. It logs a `SECURITY:` line at start.
3. **Files over 20 MB.** The Bot API cannot download them. The daemon injects a `DOWNLOAD_FAILED` marker. Ask for a cloud link instead.
4. **Photo caption over about 1,024 characters.** The send bounces. Shorten it, or send text and image separately.
5. **The send guard refused the text.** Reword it. Do not bypass.
6. **A `$` inside double quotes.** The shell expands it before the bus sees it, and the send still exits 0. Use single quotes or a quoted heredoc.
7. **Sends outside the bus.** A script that calls the Bot API with `curl` never reaches the outbound log. "Not in the log" does not prove "not sent".
8. **Two pollers on one token.** If any other process calls `getUpdates` with the daemon's token, Telegram answers 409 Conflict and one side loses messages. Give every consumer its own bot.

**Fix.** For a dead poller with a working network, ops runs `pm2 restart cortextos-daemon` (RB-03). For every other cause, fix the message or the config, not the daemon.

**Verify.** Send a short test with `cortextos bus send-telegram`, then find its `message_id` in the outbound log and confirm it on the phone.

**Rollback.** None.

**Owner.** Ops for the poller. Each seat for its own sends.

---

## RB-05 Swap spike or low free disk

**What it is.** A host running several Claude sessions, a browser, containers and local models fills disk and swap fast. On macOS, swap lives as 1 GB files on the data volume, so each new swap file takes disk. When free disk falls, swap cannot grow and the whole fleet stalls.

**Default thresholds (reference sentinels)**

| Sentinel | Pages at | Behaviour |
|---|---|---|
| Disk sentinel | state `warn` under 20 GiB, `critical` under 10, `emergency` under 5. Pages under 6 GiB, on a drop of 900 MiB inside about 1,000 s, or on a df parse failure | Pages on state change. Re-pings every 2 h while stuck |
| Floor guard | under 10 GiB once per 30 min; under 6 GiB every 20 min | Pages only. It does not prune by itself |
| Infra-watch disk and swap watch | disk at or below 7 GiB, swap file count at or above 17 | Tune per host |

Know which sentinel paged before you act. Their numbers differ on purpose.

**Check**
```bash
df -m /                                          # MiB free
sysctl -n vm.swapusage
ls /System/Volumes/VM | grep -c swapfile         # swap file count (macOS)
vm_stat | head -8
ps aux -m | head -15                             # biggest memory users (macOS)
cat $SENTINEL_DIR/state/*.state                  # sentinel state files
```

**Fix**
1. Stop whatever is growing. The seat that started it kills its own process and deletes its own download.
2. Do not clean shared caches under pressure. Pruning a package cache (for example `uv cache prune --force`) deletes files that running MCP servers import from and breaks tools on every seat. Name the consumers first with `lsof +D <dir>` and `pgrep -fl <name>`.
3. Expect the shared-surface guard to block broad deletes in home (`find ... -delete`, `rm -rf` on shared roots). That is the guard working.
4. Heavy swap from a container VM: restart the container runtime at a quiet moment, with readings before and after.
5. While swap is high: no deploys, close automation browsers, no local model loads.
6. Before any local model load, check free disk is at least twice the model size (see `40-finops-capacity.md`). Announce downloads over 1 GB to the infra-watch seat.

**Verify.** `df -m /` back above your warn line, swap file count stable or falling over 10 minutes, and the sentinel logs a return to `ok` or `warn`.

**Rollback.** Deleted model files can be downloaded again. Deleted user files cannot. That is why Fix step 2 exists.

**Owner.** Infra watch observes. The seat that caused the growth cleans up its own files.

---

## RB-06 Leaked or compromised key

**What it is.** A secret (API key, webhook secret, bot token, password) ends up somewhere it should not: a chat, a git commit, a log, a public deploy, a build cache.

**Symptom**
- Someone pastes a key into Telegram.
- The pentest gate's secret scan flags a build.
- A plaintext secrets file turns up inside a repo.

**Check**
```bash
git log --oneline --all -- <file>      # in any commit, even after untracking?
git remote -v                           # could it have been pushed?
stat -f '%Sm' <secret-file>             # changed after the leak? (macOS stat)
```
Never print the secret to check it. Compare hashes if you must.

**Fix, in order**
1. **Kill the old value first.** Rotate in the vendor's dashboard. Usually only the owner can.
2. Store the new value in a mode-600 file or the system keychain. Never in chat.
3. Update every consumer (for example `vercel env add`, then redeploy through `$SHIP`).
4. **Prove the old value is dead** with a negative test, and the new one live with a positive test. For a signed webhook: unsigned and forged requests get 401, a correctly signed one gets 200.
5. Untracking a file does not remove it from history. Rewrite history before adding any remote, or treat every secret in that file as leaked and rotate it.
6. Ask the auditor role to verify and close the item.

**Verify.** Step 4's negative and positive tests both pass, and the pentest gate's secret scan is clean on the affected tree.

**Rollback.** None. If the new value breaks a consumer, fix the consumer. Never restore the leaked value.

**Owner.** Owner rotates. Orchestrator wires the new value. Auditor verifies.

---

## RB-07 MCP server down

**What it is.** MCP servers give Claude extra tools (mail, drive, browsers, knowledge bases). Many run through `uvx` or `npx`. When one fails to start, its tools disappear from the session without an error in the conversation.

**Symptom**
- At session start Claude Code lists servers that "failed to connect" or "Connection closed".
- A tool the seat used yesterday is missing.

**Check**
```bash
claude mcp list                         # health-checks each configured server (starts each one briefly)
claude mcp get <name>                   # config for one server
pgrep -fl "uvx|mcp" | head -20          # servers running now
lsof +D ~/.cache/uv 2>/dev/null | head  # who reads the uv cache, before anyone touches it
```
`claude mcp list` starts each server for a moment. Avoid it for servers that open an OAuth window (see RB-09).

**Fix**
1. Read the cause. Common ones: a binary missing after a cache cleanup, an expired token, a remote endpoint that moved, a config path that points at a deleted file.
2. Fix the config with `claude mcp remove <name>` and `claude mcp add ...`, or repair the missing file.
3. Restart affected seats one at a time, never mid-task.
4. Pin versions in the server command (`uvx <pkg>==<version>`, `npx <pkg>@<version>`). Review pins on a schedule.
5. Keep a CLI fallback for any server the seats depend on.

**Verify.** `claude mcp get <name>` reports the server connected, and the seat can call one read-only tool from it.

**Rollback.** Restore the previous pinned version.

**Owner.** Ops.

---

## RB-08 Vendor billing failure

**What it is.** A card is declined. The vendor retries for some days, then pauses or downgrades the account. Sites go dark, or an API starts saying a product "is not enabled".

**Symptom**
- A billing alert about a failed charge.
- A site answers non-200 or shows the vendor's payment page.
- An API says "please enable X" on the account that owns X.

**Check**
```bash
curl -s -o /dev/null -w '%{http_code} %{url_effective}\n' -L https://<site>
tail -20 $SENTINEL_DIR/logs/<site-watch>.log       # if you run a site watcher
```
A billing hold can hide resources from the API while the dashboard still shows them. Read the account's billing page before concluding a resource "lives on another account".

**Fix**
1. The owner pays or swaps the card. Agents never pay.
2. If a product was dropped, re-enable it after payment. Data usually survives the hold.
3. Confirm with a real request. Stop any temporary watcher only after payment is confirmed.

**Verify.** The site returns 200 with real content, and the API call that failed now succeeds.

**Rollback.** None.

**Owner.** Owner pays. Infra watch watches. Orchestrator reports once per change.

---

## RB-09 Google OAuth on the wrong account

**What it is.** Many owners have more than one Google account (personal and business). A Google Workspace MCP server keeps one session bound to one account. Calling it with a different account's address can write the bound account's token into the other account's credential file. From then on, every reader of that file reads the wrong inbox and reports success.

**Symptom**
- Tools report "read ok" while the content belongs to the other account.
- Documents that exist answer 403 or 404.
- A seat says "Google logged out".

**Check**
```bash
ls ~/.google_workspace_mcp/credentials/                    # one file per account
tail -20 ~/.claude/hooks/gws-account-guard.log              # blocked calls
python3 -c "import json;print(json.dumps(json.load(open('$SENTINEL_DIR/state/cred-identity.json')),indent=1)[:1500])"
```
Do not run a credential identity check by hand just to look. It can refresh tokens and page. Its scheduled run already does this.

**Fix**
1. Use the MCP only for the account its session is bound to. For other accounts, use a direct token path that reads that account's credential file.
2. Install the Google Workspace account guard (`gws-account-guard.py`, PreToolUse). It blocks MCP calls for any account you list and any `start_google_auth` call.
3. If a credential file holds the wrong account, re-authorise that account with a script that checks the token's real identity before saving. The owner taps the consent screen.
4. On any access failure, retry with the other account before calling it a login problem.
5. Never start an OAuth flow unattended. Whoever is at the screen can finish it with the wrong account.

**Verify.** The identity check reports `MATCH` for every credential file, and a read from each account returns that account's data.

**Rollback.** Re-authorise again for the right account.

**Owner.** Ops runs the identity check and the guard. Owner taps consent.

---

## RB-10 Cron not firing

**What it is.** Persistent crons live in `$CTX_ROOT/.cortextOS/state/agents/<seat>/crons.json`. The daemon scheduler ticks every 30 seconds and injects each due cron's prompt into the seat's session. Fires are recorded in the cron execution log.

**Symptom**
- An artifact a cron should write is missing.
- An alarm the owner expects never comes.

**Check**
```bash
cortextos bus list-crons <seat>              # schedule, enabled, last fire, next fire
cortextos bus get-cron-log <seat> <name>     # daemon fire records
cat $CTX_ROOT/state/<seat>/cron-state.json
```
A `fired` record proves only that the daemon injected the prompt. It does not prove the seat did the job. Only the job's own artifact proves that.

**Known causes**
1. **Disabled.** `list-crons` shows `enabled: no`.
2. **Seat down or capped.** A fire into a dead session does nothing (RB-01, RB-03).
3. **Silent on success.** "Never ran" and "ran clean" look the same. Give every silent job a positive receipt (a log line or file mtime).
4. **Interval drift.** An interval schedule (`6h`) counts forward from a reference time. If that reference keeps moving (cron reloads, `update-cron-fire` calls), a long interval can slide past its slot again and again. This has been seen for intervals equal to or longer than the seat's heartbeat interval. Use a 5-field wall-clock schedule (`0 */6 * * *`) for anything important.
5. **Wrong time zone.** 5-field expressions run in the daemon host's local time. `list-crons` shows next fire in UTC.
6. **Dated one-shots.** `0 20 12 10 *` fires every year on that date. The prompt must remove the cron after it runs.
7. **launchd jobs are separate.** Sentinels run from `~/Library/LaunchAgents/*.plist`, not from the daemon. Check them with `launchctl list | grep <label>` and their own logs.

**Fix**
```bash
cortextos bus update-cron <seat> <name> --enabled true
cortextos bus update-cron <seat> <name> --interval "0 */6 * * *"
cortextos bus test-cron-fire <seat> <name>        # injects the prompt now
```
Never use in-session `/loop` or `CronCreate` for anything that must survive a restart. `cortextos bus upgrade-cron-teaching` scans seat files for that stale advice.

**Verify.** Wait for the next scheduled slot, then find the job's artifact with a timestamp after the slot.

**Rollback.** `cortextos bus remove-cron <seat> <name>`, or restore the seat's `crons.json` from backup.

**Owner.** The seat that owns the cron. Ops for the scheduler.

---

## RB-11 Bad deploy

**What it is.** Every website deploy goes through `$SHIP`: gate the static files, deploy a candidate with production env but without the domain, gate the candidate URL, then promote that exact build. A raw `vercel --prod` skips both gates.

**`ship.sh` exit codes**

| Exit | Meaning | Prod affected? | Action |
|---|---|---|---|
| 0 | Promoted, both gates passed, prod answers 200 | Yes, correctly | Verify live, then report |
| 2 | Usage error | No | Fix the command |
| 3 | Aborted before any deploy (static gate failed) | No | Read the gate report |
| 4 | Candidate deploy failed or gave no URL | No | Fix the build |
| 5 | **Live and wrong**: prod is on an ungated build, or not 200 | **Yes** | Roll back now |
| 6 | Candidate not 200, or its gate or indexing check failed; candidate removed | No | Fix; run the restore command it prints for any dangling alias |
| 7 | Promote did not take; prod still on the old build | No | Safe to retry |
| 8 | Shipped, but prod sends `X-Robots-Tag: noindex` | Yes | Find and fix the header |

An interrupted ship counts as not shipped. A scan report or a "Ready" deployment is evidence, not a verdict.

**Check**
```bash
cd <site-dir> && vercel ls | head -10               # recent deployments, newest first
vercel inspect <prod-domain>                         # which deployment the domain serves
curl -s -o /dev/null -w '%{http_code}\n' https://<prod-domain>/
ls -la security/                                     # gate report timestamps
```
Run `vercel` from the site directory in the same command. It acts on whatever directory it runs in.

**Fix**
1. Roll back: `vercel rollback <previous-good-url-or-id>`, or `vercel promote <previous-good-id>`. Both re-point the domain to an older build that already passed.
2. Old content can show for a few minutes from the edge cache. Check the `x-vercel-cache` header before calling the rollback broken.
3. Fix the source and ship again through `$SHIP` until it exits 0.
4. Pull production env to a directory outside the build tree. Env files inside the tree can end up in build caches and get shipped.

**Verify.** `vercel inspect <prod-domain>` names the good deployment, the site returns 200, and the rendered page (not the source) shows the expected content.

**Rollback of the rollback.** `vercel promote <bad-id>`. You should not need it.

**Owner.** Ops owns `ship.sh`. The seat that shipped runs the rollback and tells the orchestrator.

---

## RB-12 Seat context too full

**What it is.** Each seat has a fixed context window. The statusLine hook (`cortextos bus hook-context-status`) writes the current percent to `$CTX_ROOT/state/<seat>/context_status.json`. The daemon's fast-checker warns the seat at `ctx_warning_threshold` and triggers a handoff at `ctx_handoff_threshold` (defaults 30 and 60, set per seat in `config.json`; a handoff threshold of 0 or less opts out).

**Symptom.** The seat slows down, repeats itself, or loses earlier details.

**Check**
```bash
cat $CTX_ROOT/state/<seat>/context_status.json      # used_percentage
grep ctx_ $SEAT_DIR/config.json                     # per-seat overrides; absent means defaults
tail -5 $CTX_ROOT/logs/<seat>/restarts.log
```

**Fix.** Update `STATE.md`, write a handoff, then run `cortextos bus hard-restart --reason "<why>" --handoff-doc <path>`. Tell the owner first if a conversation is live.

**Verify.** `context_status.json` shows a low percentage, and the seat's first reply cites the handoff.

**Rollback.** None. The handoff is the recovery path.

**Owner.** Orchestrator.

---

## Rules that apply to every runbook

1. **Report what the machine said, then what it might mean.** One negative read is not a fact about cause or location.
2. **A lock or "in use" refusal is a stop sign.** Name the consumers with `lsof` and `pgrep` before you override anything.
3. **Every silent job needs a positive receipt.** No alert is not proof of health.
4. **Fix the cause, then add a test that fails without the fix.**
5. **Tell the owner once, in one plain line, with the reset or retry time.**

## Design notes

- A single disk threshold is easier to reason about than three sentinels with different floors. Pick one page line per host and set the others as warnings.
- An "oldest unanswered owner message" alarm would catch RB-02 mechanically. The gap script above is the starting point.
- Desktop Claude sessions on the same host should follow the same guards and the same send path as the seats.

## Source files

- `src/daemon/agent-manager.ts` (Telegram enablement and `ALLOWED_USER`)
- `src/daemon/fast-checker.ts` (context thresholds)
- `src/daemon/cron-scheduler.ts`, `src/bus/crons-schema.ts` (cron storage and catch-up)
- `src/telegram/poller.ts`, `src/telegram/media.ts`, `src/telegram/logging.ts`
- `src/cli/stop.ts`, `src/cli/start.ts` (`--instance` default)
- `src/bus/system.ts` (`restarts.log`)
