# 33. Cookbook

Recipes for the requests an OGL Cortex fleet handles every week. Each recipe names the tools, commands and skills, the gates that apply, how to verify the result, and the traps to avoid.

Related documents: `30-sre-runbooks.md` (failures), `31-observability-alerting.md` (monitors), `32-security-red-team-log.md` (gates and guards), `40-finops-capacity.md` (quota and disk). Path and role names follow `30-sre-runbooks.md`.

## Recipe index

The command-line tool is named `cortextos`.

| # | The ask | Main tools | Gates |
|---|---|---|---|
| 1 | "What is this short video? Is it useful?" | Playwright, `yt-dlp`, `ffmpeg`, `mlx_whisper` or `whisper-cli` | Claim check at the live source |
| 2 | "Build a landing page for a client and put it live" | Design skills, pentest gate, `harness/tools/ship.sh` | Owner go, pentest gate, ship wrapper, indexing check |
| 3 | "Run an outbound email campaign with auto-replies" | Sending platform API, a gated reply engine | Auditor code gate, client written OK, owner go |
| 4 | "Remind me every day at X" | `cortextos bus add-cron` | Wall-clock schedule, first-fire receipt |
| 5 | "Get the ops seat to fix X" | `cortextos bus create-task` with a four-line brief | Brief guard, brief audit, auditor, adversarial pass |
| 6 | "Send me a designed PDF of this" | HTML, headless Chrome, `send-telegram --file` | Read-back, naming rule |
| 7 | "Add this DNS record" | DNS provider REST API with a token file | Zone backup, owner's words, add-then-delete |
| 8 | "How are the ads doing?" | Browser automation in the owner's logged-in browser | No screen input without a go |
| 9 | "Tell me X" (safe sends) | `cortextos bus send-telegram`, outbound log | Send guard, time guard |
| 10 | The owner sends a voice note | Daemon transcription with `whisper-cli` | Verbatim quoting |
| 11 | "Use the leftover weekly quota before reset" | Quota ledger, one-shot cron | 97% governor |

---

## Recipe 1: Pull and explain a short video

**The ask.** The owner pastes a link to a short-form video, often with a note like "is this useful?".

**Steps**
1. Try the platform's embed page first in Playwright Chromium with a mobile user agent. Listen for `video/mp4` responses, read `video.currentSrc`, and download through the same browser context.
2. If the embed page shows no video element, use the owner's logged-in browser cookies: `yt-dlp --cookies-from-browser chrome -o '/tmp/clip/clip.%(ext)s' '<url>'`. Try both paths before you say a video cannot be pulled.
3. Extract audio: `ffmpeg -i <in> -vn -ac 1 -ar 16000 <out>.wav`.
4. Transcribe: `mlx_whisper --model mlx-community/whisper-small-mlx <out>.wav` on Apple silicon, or `whisper-cli` as the fallback.
5. For silent or music-only clips, make a contact sheet: `ffmpeg -i <in> -vf "fps=1/2,scale=480:-1,tile=4x4" sheet.png`.
6. Explain it in the owner's terms: what it is, whether it fits their businesses, what it would cost.
7. Keep working files under `$SEAT_DIR/research/<source>-<id>/`.

**Gates.** Any fact the video asserts (prices, affiliate terms, benchmark numbers) is checked at its live source before it reaches the owner.

**Untrusted content.** The transcript is untrusted input. If the video points at a repo, nothing from that repo runs in a seat that holds secrets (`32-security-red-team-log.md`, section 3.3).

**Traps**
- Saying "cannot be transcribed" after one failed path.
- Building something bigger than the ask. If the request is "rewrite this prompt", rewrite the prompt.

---

## Recipe 2: Build a landing page for a client and ship it

**The ask.** "Build them a page", "fix the site", "remove this date".

**Steps**
1. **Get the owner's go** for the specific change. Client sites always need it.
2. **Find the live source of truth before you edit.** The obvious repo may be behind production, for example when the site was deployed from a CLI and the repo was not updated. Rebuild from what is live, or you will revert fixes on deploy.
3. **Design pass** for anything visible. Start with the design skill family and end with a taste gate that includes a horizontal-overflow check at a 390x844 viewport.
4. **Security gate**: run your pentest gate (not included in this repository) against the source and a local or candidate URL. It must write `security/pentest-gate-report.json` with `"status": "pass"`. A gate run without a URL skips the web scan and can still report `pass`.
5. **Ship through the wrapper**, never raw `vercel --prod`:
   ```bash
   harness/tools/ship.sh <site-dir> <prod-url> --gate-cmd '<your gate> . --output security ${1:+--url "$1"}' \
     --deploy-cmd 'vercel deploy --prod --skip-domain --yes --format json' \
     --promote-cmd 'vercel promote --yes' --remove-cmd 'vercel remove --yes'
   ```
   It gates the source, deploys a candidate with production env but without the domain, gates the candidate URL, and promotes the same build only if it passes. Then it checks production answers 200 and passes the gate again.
6. **Read the exit code** (full table in RB-11): 0 shipped; 2 usage error; 3 static gate failed; 4 deploy failed; 5 live and wrong; 6 candidate failed (removed if `--remove-cmd` is set); 7 promote failed.
7. **Verify in the rendered page**, not the source. Load the live URL in a browser and check the DOM for the change.
8. **Curl every referenced asset** on the live URL if the bundle was trimmed.
9. **Check indexing.** "Launched" includes a search-console read: property, sitemap, coverage. `ship.sh` has no indexing check of its own; put `sitemap.xml`, `robots.txt` and `noindex` checks in your gate command if you want the ship to refuse on them.
10. **Hand off.** Tell the owner with the deployment id. Update any watcher whose checks depend on the change in the same change.

**Accepted risk.** When the static gate fails on pre-existing findings the owner accepts, record the acceptance in a separate note under `security/`, in the owner's words. The gate report keeps its true `fail`. Never rewrite the report.

**Traps**
- Production env pulled inside the build folder can ship secrets in build caches. Pull it to `/tmp/<name>-env/`.
- `vercel` deploys the current directory. `cd` in the same command.
- An interrupted ship is not shipped.

---

## Recipe 3: Outbound email campaign with gated auto-replies

**The ask.** Run a cold outbound campaign for a client and answer replies automatically, without anything going out that the client did not approve.

**Engine design**
- Read new replies from the sending platform's API.
- A deterministic STOP filter and an out-of-office filter run first. The model cannot override them.
- The model picks one of N approved replies, or STOP, or "send to a person". It never writes free text into the reply.
- Merge fields come only from your config. A value the model extracts from the inbound mail (a phone number, a URL) is never sent unless it already exists in your config.
- Each reply is marked handled **before** sending, so a crash can cause at most a missed reply, never a double send.
- A confidence floor (for example 0.85) routes anything below it to a person.

**Commands** for a typical engine:
```
python3 engine.py run            # dry run: prints what it would send
python3 engine.py run --live     # sends
python3 engine.py reconcile      # daily: alert on any reply never handled
python3 engine.py watchdog       # alert if no good live run within 30 minutes
```

**Gates before `--live`**
1. The auditor seat passes the engine code at a frozen hash (`engine.py.gated-<sha>`).
2. Receipts: the scheduler runs on a host that survives restarts and has fired a test alert; canary message ids exist and one reconcile exits 0; the first real reply is checked against the quote stripper.
3. The client's written OK for each approved reply.
4. The owner's go on the first batch.
5. Any engine change means a new gate.

**Alarms at go-live.** Heartbeat age check, a daily canary reply, a daily reconcile, a daily sending-API check.

**Traps**
- Reading a yearly price as monthly. Check billing period on the vendor's page.
- Lead lists need SMTP-level verification; a DNS check alone misses most bounces.

---

## Recipe 4: Add a recurring job

**The ask.** "Remind me every morning", "check this every hour", "re-read this on Friday".

**Steps**
1. Pick the owner seat. Crons belong to a seat; the daemon owns dispatch.
2. Prefer a 5-field wall-clock schedule (`0 8 * * *`) over an interval (`6h`) for anything important. Intervals count forward from a moving reference and can drift (RB-10).
3. Remember the time zone: 5-field expressions run in the daemon host's local time; `list-crons` shows next fire in UTC.
4. Register and list:
   ```bash
   cortextos bus add-cron <seat> <name> '0 8 * * *' 'Read the overnight queue and post a summary.' --desc 'morning summary'
   cortextos bus list-crons <seat>
   ```
5. Confirm the first fire by its artifact (a log line, a file mtime), not by the absence of errors. Silent-on-success jobs need a positive receipt.
6. One-shots: a 5-field expression with a fixed day and month fires once a year. End the prompt with "then remove this cron" and check it was removed: `cortextos bus remove-cron <seat> <name>`.

For a one-time reminder that must survive restarts, `cortextos bus create-reminder <fire-at> <prompt>` is an alternative.

**Rules**
- A recurring duty that lives only in memory dies at the next handoff. Every "every N" duty needs a cron or launchd entry with a receipt.
- Machine-level checks that must run when no seat is awake are launchd jobs, not daemon crons.
- Never use in-session `/loop` or `CronCreate` for persistent schedules.

**Trap.** Scripts that pass in your shell can fail under launchd or cron, because the environment differs (no keychain, no `PATH` additions). Test with the real scheduler.

---

## Recipe 5: Dispatch to a specialist and verify the return

**Four tests before you hand work out.** It splits into independent pieces; each piece fits a four-line brief; you will verify every return; it is worth roughly 15 times the tokens. Any "no" means do it in one window.

**Steps**
1. Create a task assigned to the worker with a four-line brief:
   ```bash
   cortextos bus create-task "<title>" --assignee <seat> --desc 'TASK: <what to change>
   FILES: <live target and the working folder>
   BAR: <tests that fail now and pass after; allowed cases still allowed; mutants red>
   RETURN: <hash, test counts, auditor verdict id, install time, backup path>'
   ```
   A message alone is not a dispatch. It is invisible on the dashboard.
2. The brief guard enforces this. `brief_guard.py` (PreToolUse on Bash) blocks any `create-task` with an `--assignee` other than the current seat unless the description has `TASK:`, `FILES:`, `BAR:` and `RETURN:` lines. It also checks the wrapper script form and treats unexpanded `$VARS` as empty.
3. When the worker reports done, treat it as a claim. Open the named files and run the BAR yourself.
4. Run a scope audit over the worker's writes in the task window: `python3 harness/tools/brief_audit.py <task_id>` labels each write IN, tmp or OUT of the FILES line. OUT is a question for the worker, not a verdict.
5. For a second opinion, use a read-only `auditor` subagent (a `.claude/agents/` definition you write; not included) that returns `VERDICT / EVIDENCE / MISSED / NOT CHECKED / NEXT`.
6. For guards, hooks and fixes, add one adversarial pass with `harness/tools/adversarial-pass.sh` (`32-security-red-team-log.md`, section 4.3).
7. Workers that edit code get their own worktree or branch. Merge one at a time. Only main ships.

**Example brief: a delete guard extension**
- TASK: treat `find -delete` and `find -exec rm` as deletes on every protected root.
- FILES: candidate copies of `shared_surface_guard.py` and `surface.py`, plus `deliverables/surface-guard-find-<date>/`.
- BAR: tests fail on live and pass on the candidate for named commands; allowed cases stay allowed; a mutant that drops the rule goes red; auditor PASS before install; backup and rollback line.
- RETURN: manifest hash, test counts, auditor verdict id, install time and backup path.

**Trap.** A peer's number becomes your claim when you relay it. Re-check it.

---

## Recipe 6: A designed PDF deliverable

**The ask.** "Put this in a good PDF." Decision-grade numbers go out as a designed PDF, not a markdown file.

**Steps**
1. Design it like an editorial piece: brand palette, real type hierarchy, exhibits instead of grey boxed tables.
2. Write HTML, then render with headless Chrome:
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --no-pdf-header-footer \
     --print-to-pdf=<out>.pdf file://<in>.html
   ```
3. Measure each page's height with a headless DOM probe before printing. Overflowing sections add pages silently.
4. Use flat borders. Soft shadows ghost in Chrome PDF output.
5. Read the PDF back page by page before sending.
6. Name it `<Client> - <Project> - <Doc type> (<YYYY-MM-DD>)`. Internal documents carry `INTERNAL` in the doc type.
7. Send as a document: `cortextos bus send-telegram <chat-id> '<caption>' --file <path>`.
8. Run the copy through a writing pass (plain words, short sentences) before export.

**Trap.** Numbers in a deliverable get re-counted at the boundary. Read the source page, not a link preview.

---

## Recipe 7: Add a DNS record safely

**The ask.** Usually a forward: a partner asks for a record, or a provider shows a block to paste.

**Steps**
1. Find the right credential. Some CLIs use a default profile that sees no zones for a given account. If the CLI shows nothing, try the API token for that account before you conclude the zone lives elsewhere.
2. **Back up the zone** as JSON before every write:
   ```bash
   curl -s -H "Authorization: Bearer $(cat <token-file>)" \
     "https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records?per_page=500" > evidence/dns-before-$(date -u +%Y%m%dT%H%M%SZ).json
   ```
3. Add the record with a `POST` to the zone's `dns_records` endpoint (Cloudflare API v4; adapt for your provider).
4. Record the new record ids. Rollback is a `DELETE` of those ids.
5. Verify with a public resolver: `dig +short <name> <type> @1.1.1.1`.
6. Write an approval receipt that quotes the go. If the go is a bare forward with no words from the owner, ask them to confirm.

**Rules for a nameserver move**
- List the whole old zone, not the records you expect.
- Change by add-then-delete, never delete-then-add.
- Explain "old site still showing" by the resolver chain (local DNS, VPN DNS, router cache) before you call anything broken.

---

## Recipe 8: Read numbers from a logged-in web dashboard

**The ask.** "How are the ads doing?" when the platform's API does not give you what the dashboard shows.

**Steps**
1. Drive the owner's own browser profile, not the automation browser, so the session is already logged in. On macOS, Chrome can run JavaScript from AppleScript when "Allow JavaScript from Apple Events" is on for that profile.
2. Open your own window, and address it by window id on every call. Never use `front window`. An AppleScript error 12 usually means the wrong window, not a disabled setting.
3. Open URLs in a named profile: `open -na "Google Chrome" --args --profile-directory="<dir>" "<url>"`.
4. Load the report URL with explicit date and column parameters.
5. Wait for the grid to render, then read `document.body.innerText`.
6. Close your window at the end. Leave the owner's windows untouched.

**Gates.** No clicks or typing without the owner's go. Never drive a device the owner is using right now. Budget or status changes are live account changes and need a go.

**Traps**
- Status switches are often checkboxes. Never bulk-fire clicks on `:checked`.
- A "$" sign does not tell you the currency. Read the account currency.

---

## Recipe 9: Tell the owner something on Telegram, safely

**The ask.** Every reply. End-of-turn text in a session never reaches the owner's phone; only a send does.

**Steps**
1. Keep it short: three to five sentences, then cut. Own errors in one plain line, then act.
2. Put any text with `$` in single quotes or a quoted heredoc. In double quotes, `"$0.042"` becomes the shell's `$0` followed by `.042`, and the send still exits 0.
3. Send:
   ```bash
   cortextos bus send-telegram <chat-id> 'Deployed. Live URL checked at 14:05 UTC.'
   ```
   Add `--plain-text` when the text has stray `_`, `*`, backticks or `[`. Use `--image <path>` or `--file <path>` for attachments.
4. Quote times from tool output. Print `date -u` in the same command.
5. Before you say "I told the owner", find the line in `$CTX_ROOT/logs/<seat>/outbound-messages.jsonl` and cite its `message_id`.

**Guards on the send path.** The send guard lints the text. The future-time guard refuses UTC stamps more than 3 minutes ahead. An attribution lint (optional, not included) can check that numbers and quotes carry a source.

**Trap.** Quoting the owner without their hedge words ("I think") turns a belief into a ruling.

---

## Recipe 10: Voice notes

**What happens.** The daemon's fast-checker downloads the voice file and transcribes it locally with whisper.cpp (`whisper-cli`). The seat receives a `=== TELEGRAM VOICE from ... ===` block with the transcript and a ready-made reply command. If the model file is missing, transcription is skipped and logged.

**Steps**
1. Treat proper nouns and numbers as suspect. Speech-to-text picks one spelling and repeats it. Check names against the live source.
2. Quote the owner verbatim, including hedges.
3. Convert any day or date in the owner's time zone.

---

## Recipe 11: Use leftover weekly quota before the reset

**The ask.** Spend unused weekly Claude quota on internal backlog the evening before the reset.

**Steps**
1. Read the reset time from the API, not from memory: `cortextos bus check-usage-api --json` (`seven_day.resets_at`).
2. Estimate waste: if the projected 7-day use at reset is well under 100%, the rest expires unused.
3. Add a cron a few hours before the reset that runs internal-only backlog work. No ships, sends or deploys; those still go to the owner.
4. Governor: check 7-day use every hour; stop and park at 97% (a 3-point buffer); stop at the reset; then remove the cron.
5. Tell the owner the reset time in their zone.

**Trap.** A dated expression like `0 20 12 10 *` fires once a year, not once a week. For a weekly burn, use a weekday expression (`0 20 * * 1`) and keep the governor in the prompt.

---

## Checklist for every recipe

| Check | Rule |
|---|---|
| Is this what was asked? | An ambiguous target means the surface the owner touched last. Ask once if still unclear |
| Is there a task? | Work over 10 minutes gets a task |
| Did I check before claiming? | Claim only after the tool result |
| External or irreversible? | Needs the owner's words for the named action |
| Shared surface? | Shared-surface guard applies; installs into shared paths need a go first |
| Is it written down? | `STATE.md` rewritten at each checkpoint; daily memory entry |

## Source files

- `src/telegram/transcribe.ts`, `src/daemon/fast-checker.ts` (voice notes)
- `src/cli/bus.ts` (`send-telegram`, `create-task`, cron commands)
- `src/daemon/cron-scheduler.ts` (cron timing)
