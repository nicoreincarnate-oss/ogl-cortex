# <org> knowledge base

<!-- OGL Cortex org template. Copy to $CORTEX_HOME/orgs/<org>/knowledge.md. Every seat reads this file at boot
(../../knowledge.md from a seat folder). It holds facts and rules every seat needs. It does not hold task detail
(use tasks), one seat's knowledge (use that seat's MEMORY.md) or secrets (use secrets.env). Facts here pass the
write gate in ENTITIES.md and carry a source and an as-of date. -->

## Business

<!-- What the org does, its products and services, who its customers are. -->

## People

<!-- The user, their team, how to reach them, who approves what. -->

## Technical

<!-- Repositories, hosting, deploy targets, shared services, where state lives. Use absolute paths. -->

## Key links

<!-- Dashboards, docs, tools. -->

## Cardinal rules (never violate)

<!-- One line each, with the date and who set it. These outrank everything below. -->
- <rule> (<who>, <YYYY-MM-DD>)

## Operational preferences

<!-- How the user wants to work: tone, approval thresholds, channels, quiet hours. -->

## Fleet conventions

<!-- Rules learned between two seats that every seat must know. A rule agreed between two seats is not a fleet rule
until it lands here. State each so a seat that was not there can apply it. Starting set: -->
- Use absolute paths in every claim, message and artifact pointer.
- Verify a peer's claim by a different method than the one they used.
- Capture a command's exit status directly, never `$?` after a pipe.
- A clean result counts only when the check measured something: "checked 0 items" is not "0 problems".
- Write the reason next to a threshold or magic number where it is used.

## Expected-dormant services

<!-- Services that are down on purpose, so a post-restart sweep does not raise an alarm. Each entry needs the reason
and the owner who can turn it back on. An entry without both does not suppress anything. -->

| Service | Why dormant | Owner and un-dormant gate |
|---|---|---|

## Decisions log

<!-- YYYY-MM-DD: decision. Why. -->
