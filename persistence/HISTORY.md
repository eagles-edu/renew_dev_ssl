# Decision history

## 2026-10-27 — Match live Vhost static-site intent to Curator criteria

**Intent:** Verify that a request-bound local Vhost operation preserves its
selected mode, problem, and criteria through the Curator bridge and rollback.

**Changed fact:** Static-site previews now omit OpenLiteSpeed validation and
describe only the Nginx static-file changes. The loopback UI applied and rolled
back one reserved `.test` site; both Curator receipts processed, the created
goal stayed active with every criterion open, and restart recovery preserved
the operation history.

**Verification:** The focused Curator consumer contract passed. After rollback
and a Vhost service restart, the site, account, and home were absent and both
web services remained active with valid configuration. The content-free
acceptance record is in `docs/curatormd-v2-alpha.md`.

**Open:** Same-event replay, out-of-scope before/after hashes, bounded
`goal_report`, human review, and release evidence remain open.

**Outcome:** Record local request-bound workflow evidence without marking any
Curator criterion verified or closing the release gate.

## 2026-10-27 — Match Vhost acceptance criteria to request mode

**Intent:** Keep the Curator V2 goal preview tied to checks the selected
Vhost routing mode actually performs.

**Changed fact:** Site-plan previews require OpenLiteSpeed validation only for
the `ols` request mode; static and proxy plans require Nginx validation and the
site response check. The operation summary now describes only the web server
and PHP changes selected by that mode. Every plan still includes human review.

**Verification:** The focused Vhost Curator contract asserts that a static
plan omits `ols_valid` while the existing OpenLiteSpeed plan keeps it.

**Open:** This source-level contract does not establish a live accepted
criterion, human disposition, or deployment release gate.

**Outcome:** Prevent the preview from asking reviewers to accept a validation
that the selected site mode does not use.

## 2026-10-25 — Verify installed Curator V2 plugin route

**Changed fact:** The local Vhost Manager service is active. Through the
supported `renew-ssl-coding` Hermes profile, `curator_v2` connects and discovers
48 tools. The profile-bound read at 19:21 +07 reports 25 processed receipts,
10 goals (five active and five planned), and six facts. Its separate health
snapshot is `healthy`, with a complete zero-file staging inventory and no
operational gate codes. Direct MCP calls without Hermes profile context still
return `unauthenticated`; the configured local profile route succeeds.

**Verification:** Read-only `systemctl show` confirmed the service is active and
running. `/home/eaglesvn/.hermes/hermes-agent/hermes -p renew-ssl-coding mcp
test curator_v2 --probe-curator-status` connected and returned the counts above.

**Open:** This verifies local profile routing and ledger visibility only. Five
active goals still need human disposition; complete producer/artifact coverage,
including standalone utilities, and release evidence remain open.

## 2026-10-25 — Draft Vhost and certificate producer coverage matrix

**Intent:** Inventory the current `renew_ssl` producers and their output
classes so Curator V2 cannot mistake Vhost-owned operational files for
Curator staging artifacts.

**Changed fact:** Static source review found these producer paths and output
classes:

| Producer | Output classes and destination class | Curator V2 path | Current disposition/evidence |
| --- | --- | --- | --- |
| Vhost `/api/apply`, `/api/archive/examples`, `/api/rollback` | `VHOST_CONFIG_DATA` (Nginx/OpenLiteSpeed config, site files, optional DB/firewall state), `VHOST_BACKUP_ARCHIVE` (snapshots), and operation manifest; system config/site, backup, and state locations | Compact success and durable-failure goals; failed apply/rollback receipts can be retried by exact operation ID | A disposable apply failure after fixture writes is restored, recorded, and sent to Curator without its raw error or paths. App-owned; retention and complete filesystem observation are unreviewed. |
| Vhost `/api/ssl-renew` | `ACME_PRIVATE_STATE` (certificate/account/key state), `ACME_OUTPUT_LOGS`, `TEMP_ACME_TEXT`, Nginx staging links, installed certificate files; ACME, log, temp, and system config locations | Persists `running` before launch, records terminal outcomes, and recovers a leftover `running` record to `interrupted` at app startup; exact receipt retry | The local HTTP/MCP contract covers completed, failed, simulated interruption, Curator outage/retry, and route-started renewal recovery after app restart. Curator receives only bounded operation metadata, never the manual script source, key/password values, challenge token, or raw command output. The manual DNS script keeps full output on the operator terminal and redacts recognized `TXT value:` / `TXT:` lines from its persistent log. `issue_out`, `renew_out`, and served-certificate temp files are removed by the EXIT trap; cleanup failure exits nonzero. Other ACME output formats, actual active-job restart, and real issuance remain unobserved. Persistent-log retention and disposition remain open. |
| Root scheduled ACME cron | `ACME_PRIVATE_STATE` plus `ACME_CRON_QUEUE` containing only operation UUID and exit code; ACME and root-owned queue locations | Exact compact scheduled result goal, with durable retry across Vhost outage | Bridge and receipt path are tested with fake ACME; no real renewal destination/write trace is available. Queue file is mode 0600 and removed after Vhost accepts it. |
| `update_domain_inventory.sh` | `INVENTORY_TMP` under a temporary directory and generated certificate metadata Markdown in the checkout | None | Source has EXIT cleanup for the temp directory; abrupt-kill residue and filesystem observation are unverified. Inventory output is Vhost-owned. |
| `renew_all_domains.sh` direct batch invocation | `BATCH_PROGRESS` domain/expiry state and sibling temp replacement under local state; lock under runtime lock directory; delegates to manual DNS script | None for direct terminal use; the Vhost interactive route invokes the one-domain path | Progress and lock are producer state, not Curator staging. Direct terminal batches bypass Vhost receipt routing. |
| `setup_nginx_vhost.sh` | `VHOST_CONFIG_DATA` and ACME HTTP-01 webroot directories under Nginx/site locations; temporary config is created beside its destination | None | Standalone utility; output is Vhost-owned and outside Curator staging. Workflow filesystem observation is absent. |
| Vhost security collector | Reads Nginx logs, SSH journal, CrowdSec state, and permanent-ban files; writes `SECURITY_COUNTERS` to manager state | None | Aggregate counts are manager-owned; source logs are read-only inputs. Retention/disposition is not a Curator cleanup action. |
| Hermes Vhost lifecycle hook | Bounded lifecycle metadata in Hermes outbox and Curator V2 inbox; no prompt, response, or cwd | `hermes_codex_event` through managed MCP | Disposable integration covers the hook path. No Vhost file artifact is copied into Curator staging. |

Source binding for this draft: checkout HEAD
`7d2b10f5433cfe566fc560741bbc9401265176f4`; repository config SHA-256
`4f3a34e84832b7e8ccfe4e91a68b0664c6aa603409318197f0b44e6454ece44a`; adapter
`apply_bridge.py` SHA-256
`0ac54742965e95a4e1166b733150cc8529971979791cfe2dd664c7a6c96b3fa0`; and
working-tree producer matrix SHA-256
`89aabd5ac2a745aac0c467deb85dc051ab68c05d6aa273bc666de2c3ca5bd8fa` over
`.curatormd-v2.toml`, the Vhost server/core/security/UI and operation source,
Curator adapters, certificate inventory/renewal/setup scripts, and the focused
consumer contract. The root Vhost service drop-in SHA-256 is
`ee1012bbac482a91eb811584f9cddec948d16dc0a059731dedefc6fed1239330`; the
installed cron bridge matches its source SHA-256
`28afc265f2a0193d443bd90569865f3bf5c1d00620930f41caab150d8c2a6f25`. The
checkout is dirty; any included-source or config change invalidates this draft.

**Open gate:** This is a source-derived draft, not owner approval or a complete
filesystem observation. Confirm producer scope and destination classes;
decide retention/deletion treatment for persistent manual ACME logs; confirm
whether standalone inventory, batch, and Nginx setup utilities belong in the
approved Vhost pilot; and provide one disposable filesystem-observation run
for each approved workflow. Unknown ACME install hooks or other host/provider
writes remain outside the observed boundary. No scan root was expanded and no
files were deleted.

**Outcome:** Static source coverage now identifies the main Vhost, certificate,
inventory, security, and Hermes producers and the raw-output cleanup gap. The
owner-reviewed source/artifact gate remains open pending the decisions above.

## 2026-10-25 — Remove manual ACME scratch files on exit

**Decision:** Delete the manual DNS renewal script's temporary ACME output and
served-certificate files when the process exits, including normal, failed, and
signal-driven exits. Preserve full challenge output for the operator while
redacting recognized challenge-value lines from the persistent log.

**Change:** The script tracks each temporary path as soon as it is created and
removes the tracked files from an EXIT trap. If removal fails, it reports a
content-free error and exits nonzero. Its persistent log writer now redacts
`TXT value:` and `TXT:` line contents, keeps the full stream on the operator's
terminal, and flushes the log before exit.

**Verification:** `bash -n` and `git diff --check` passed. Disposable shell
harnesses verified that a tracked file is removed and exit status preserved for
success and nonzero exits, and that recognized challenge lines remain visible
on the operator output but are redacted and flushed in the saved log. This did
not run acme.sh, contact DNS, change a certificate, or verify a real signal
delivery to the full script.

**Open:** Other ACME output formats were not observed; persistent-log inventory,
human-approved deletion, standalone utility scope, and full workflow filesystem
observations remain open. No retention timer was pointed outside the Curator
staging root.

## 2026-10-25 — Refresh source fingerprint after log redaction

**Changed fact:** The preceding producer-source fingerprint was superseded after
the manual DNS utility's persistent logger changed. Current HEAD remains
`7d2b10f5433cfe566fc560741bbc9401265176f4`; config SHA-256 remains
`4f3a34e84832b7e8ccfe4e91a68b0664c6aa603409318197f0b44e6454ece44a`; current
source-manifest SHA-256 is
`0cce3a0fad9bac7767d0f9be6cdc8963a4caaab3c46148a8e610cc47d5afd091`. It covers
the same explicitly listed source set and sorted per-file-hash algorithm.

**Open:** This remains a working-tree fingerprint, not a clean revision or
owner-approved source map. Any subsequent change to a listed source invalidates
the digest.

## 2026-10-25 — Recover interrupted Vhost SSL renewals

**Change:** Vhost now saves an operation record in `running` state before
starting a renewal. On startup, any unfinished renewal record is changed to
`interrupted` and submitted through the existing Curator bridge. If Curator is
unavailable, the interrupted record remains retryable by the exact operation
ID.

**Verification:** The focused disposable HTTP/MCP contract seeded an unfinished
operation, started the app with Curator unavailable, verified the recovered
interrupted operation remained pending, restarted with Curator available, and
retried the exact ID. Curator processed the matching event and stored a
path-free planned goal. The test passed. The active service unit is configured
with `KillMode=control-group`; no real renewal was stopped and no certificate
changed.

**Open:** Failed-apply reporting and an actual systemd stop during an active
renewal remain unverified. The updated source-manifest SHA-256 is
`6b6d43ff52774e8120bf19baeaeb9ad878468de0f5f0a93381f603e1f89ae8d0`; it
supersedes the prior fingerprint after server and contract-test changes.

## 2026-10-25 — Test renewal interruption from the Vhost route

**Verification update:** The focused contract no longer creates a synthetic
unfinished renewal record by hand. It starts a test-mode renewal through the
actual HTTP route, verifies `running` is durable, terminates the Vhost test
server, starts a new process, and confirms startup changes the operation to
`interrupted` and delivers the exact Curator receipt. It does not start ACME or
modify a certificate; this remains a process-restart simulation, not an actual
systemd interruption during a real renewal.

**Source fingerprint:** The current working-tree manifest SHA-256 is
`76285c00b311000fd5a10282d14f3ab4c26a5965a7fdd7145b3367d78eb379c3`, replacing
the earlier hash after this test change.

## 2026-10-25 — Keep manual DNS credentials out of Curator records

**Owner clarification:** Curator V2 is a documentation system, not a security
product. Its Vhost records should contain concise operation facts, not manual
DNS script source, keys, passwords, challenge values, or raw command output.

**Verification:** The current Vhost adapter sends only operation ID, kind,
title, domain, state, and exit code to Curator. No script source, credential,
challenge token, or captured output field is included.

**Open:** This content boundary describes the Curator record. It is not a
security certification for the Vhost host logs or any other runtime output.

## 2026-10-25 — Send failed Vhost applies to Curator

**Change:** When an apply operation has already written a durable failed
operation record after restoring its snapshot, the route now submits that
outcome to Curator. The event summary says `apply failed`; it excludes the raw
error and generated paths. The UI retry endpoint accepts failed apply records
by exact operation ID. Apply attempts that fail before a durable operation
record continue to return their error without inventing a completed operation.

**Verification:** The focused disposable HTTP/MCP contract injects a failure
after writing fixture files, checks restoration and a durable `failed` record,
simulates Curator outage, retries the exact ID, and verifies the processed
path-free goal. The test passed.

**Open:** This covers a rollback-restored apply failure. It does not exercise
failed recovery during rollback, a live site failure, or the complete
producer/artifact inventory. Current source-manifest SHA-256:
`7506ec8b84063b875f04e9524b9a03aca334ad4a1a32824a76a35c4b84cf6d40`.

## 2026-10-25 — Refresh the Vhost producer source fingerprint

**Intent:** Bind the current draft producer map to the post-change Vhost source,
including failed rollback reporting and manual ACME scratch cleanup.

**Changed fact:** The current checkout remains at HEAD
`7d2b10f5433cfe566fc560741bbc9401265176f4`, with config SHA-256
`4f3a34e84832b7e8ccfe4e91a68b0664c6aa603409318197f0b44e6454ece44a`.
The source manifest SHA-256 is
`4a5390ac6f2c7b096327dd2c0a4e6f9550188c28a59c7b742e998c27a0091684`, computed
from sorted per-file SHA-256 lines for the config, Vhost server/core/operations/
security and UI sources, Curator Vhost adapters, ACME bridge, manual DNS,
inventory, batch and setup scripts, and focused contract test. This is a
working-tree fingerprint, not a clean commit.

**Verification:** Confirmed the new manual DNS EXIT cleanup and failed-rollback
producer changes are included in the fingerprinted source set. The fingerprint
does not change or upgrade the earlier filesystem observation boundary.

**Open:** Owner review of producer scope/out-of-root disposition, persistent
ACME log policy, and per-workflow filesystem observations remains outstanding.
Any change to a fingerprinted file invalidates this draft binding.

## 2026-10-25 — Trace the disposable Vhost-to-Curator workflow

**Intent:** Add process-bounded filesystem evidence to the source matrix without
using production paths or retaining a raw syscall trace.

**Changed fact:** The existing focused HTTP/MCP integration was rerun under
`strace -f -e trace=%file` with the Vhost server in fixture mode and a temporary
Curator database. It passed. The trace observed 409 filesystem mutation/open-
for-write operations; the path summary was dominated by the temporary Vhost
fixture and database tree, with console endpoints and temporary/runtime paths.
No recent object remained under `/var/tmp` afterward. The trace file was
deleted after summarization.

**Verification:** The observed process boundary included the unittest process,
test Vhost server, child bridge, and Curator launcher. It did not include the
systemd Vhost process, root cron, ACME service, or any provider process. The
bounded parser left relative/file-descriptor paths and two `/var/tmp` path
operands unclassified, so this run cannot prove a complete destination set.
The fixture-mode test does not observe the separate manual-DNS utility or a
real certificate renewal.

**Open gate:** Owner approval of producer scope and out-of-root dispositions,
classification of the unbounded path operands, and filesystem observations for
each approved real utility workflow remain open. No production file was
captured or deleted.

**Outcome:** One disposable HTTP-to-MCP workflow now has process-tree filesystem
evidence; it narrows the observed test boundary but does not close the source
coverage gate.

## 2026-10-25 — Route scheduled ACME results through Curator V2

**Intent:** Bring the existing root-run scheduled renewal producer into the
local Vhost-to-Curator V2 path while preserving its schedule and renewal
command.

**Changed fact:** The root crontab now calls the installed root-owned bridge at
the same four daily times. The bridge records only operation ID and ACME exit
code, suppresses ACME output, and queues a mode-0600 result if the local Vhost
service is unavailable. Its next invocation drains queued results before
starting ACME. When Curator is unavailable but Vhost is running, the operation
remains pending in the Vhost manifest for exact-ID retry.

**Verification:** The focused disposable HTTP/MCP contract passes with a fake
ACME program: it verifies the outage queue is drained on the next run, both
results remain retryable by exact ID, the Curator events are processed, and a
transient-output canary is absent from the goal. The installed root-owned
bridge was also exercised against the restarted local root service with fake
ACME exit code 19; the Vhost manifest contained the exact received receipt and
the alpha ledger contained the matching processed receipt and planned goal.
The original 01:52, 07:52, 13:52, and 19:52 schedule is preserved. No real
certificate renewal was run.

**Open gate:** Canonical Markdown projection and reviewer disposition for this
operation, full producer/artifact inventory, and release evidence remain open.
The live smoke goal is `planned`; no review, hold release, or purge is claimed.

**Outcome:** The scheduled local ACME producer now records path-free Curator
V2 review goals while retaining an outage-recoverable result path.

## 2026-10-25 — Project and reconcile the scheduled-renewal smoke goal

**Intent:** Verify the installed local reviewer path can canonically project
the exact fake-ACME operation without leaking transient output or ledger paths.

**Changed fact:** The `eaglesvn` review grant projected goal
`vhost-ssl-cron-eeb1cddc-b8c3-4745-99b1-794217a07dbc` to the configured
`.curatormd-v2/persistence/HISTORY.md` target. SQLite records the projection
hash as `b8317444a8cf24b25122fb09eb38468b763d4670e11ea47094081c2d71d9f131`.

**Verification:** `goal_reconcile` returned `synced` with matching expected and
actual SHA-256. The 783-byte target includes the compact planned goal and
excludes the fake terminal canary and SQLite path. A read-only preflight found
no cleanup receipts attached to the goal; the access-denied write-only attempt
created no target. No real certificate renewal was run.

**Open gate:** The goal remains planned pending a human operation decision. No
SDE disposition, hold release, or artifact purge is claimed; full producer and
artifact coverage and release evidence remain open.

**Outcome:** One scheduled fake-renewal result is durably projected and
reconciled under the configured single-user alpha reviewer grant.

## 2026-10-25 — Project and reconcile live Vhost apply/rollback goals

**Intent:** Verify canonical persistence for the two disposable local site
operations already applied and rolled back through the running Vhost service.

**Changed fact:** The authorized `eaglesvn` reviewer projected the exact four
operation goals for the two apply/rollback pairs to
`.curatormd-v2/persistence/HISTORY.md`. The preflight found no cleanup receipts
attached to these goals.

**Verification:** Each goal reconciled as `synced` with matching expected and
actual SHA-256: `fe9828aaa383478e11bec76c0795f3ba458efa44b16e35579a311f709916e069`,
`54a1f7d89417017a4ca3ad1d05f6b96e896307c2f2da3131d8c5f8a9744bc062`,
`126e4f11c59bf17c214d3cc3457998e4a459c1970105f9d0f108db46d66f775c`, and
`34c217c405caa431d71440e41e3cbcb501047e669722ba4a32dd8fa7e2d6ab18`. The
5-goal projection contains no temporary paths, database path, or ACME output
canary.

**Open gate:** These records remain planned pending human disposition. No SDE
review, cleanup authorization, artifact purge, or complete producer inventory
is claimed.

**Outcome:** Canonical projection and read-only reconciliation now cover the
four live local apply/rollback goals as well as the scheduled fake-ACME smoke
goal.

## 2026-10-25 — Record local SSL renewal outcomes in Curator V2

**Decision:** When a Vhost Manager SSL renewal process ends, first save a compact
operation record, then send its domain, completed/failed/interrupted status, and exit code as
a planned goal through the configured Curator V2 MCP. Never forward terminal
output or certificate contents. Keep a missing receipt pending and retry by the
same operation ID from Operation history.

**Verification:** The disposable HTTP/MCP contract simulates completed, failed,
and interrupted renewal results, verifies the exact `vhost-ssl-renew-<operation-id>` event,
confirms a Curator outage can be retried, and checks that the goal excludes
fixture/database paths and terminal output. The focused contract and all 22
Vhost Node tests pass; ESLint, Prettier, Python syntax validation, and
`git diff --check` pass. No real certificate renewal was run.

**Open:** Background producers, cancellation/interrupted-job recovery, source
revision and artifact inventory review, out-of-root artifact dispositions, and
the full release gates remain open. A read-only root crontab check also found a
separate `acme.sh --cron` producer at 01:52, 07:52, 13:52, and 19:52; it bypasses
the Vhost route and discards output. The cron was not changed.

## 2026-10-25 — Route Vhost example archives through Curator V2

**Decision:** After Vhost Manager durably archives discovered example configs, record a compact planned review goal through the configured Curator V2 MCP and keep retryable pending state when no matching receipt is returned.

**Verification:** The disposable HTTP/MCP integration now archives the fixture config, confirms the app manifest stores a pending receipt during simulated MCP outage, retries the same operation ID, and confirms a matching `processed` V2 receipt and planned goal. The goal summary excludes archive/database paths. The Vhost Node suite passes 22 tests; ESLint, Prettier on the changed JavaScript, `git diff --check`, and the Vhost UI build pass. The active root service restarted and reports valid active Nginx/OpenLiteSpeed configuration; no real configuration archive was performed.

**Open:** Certificate-renewal and background producers, failure/cancellation coverage, and owner review of source and out-of-root artifact dispositions remain open. No release gate is closed by the disposable test.

## 2026-10-25 — Verify the installed Curator V2 apply and rollback bridge

**Decision:** Verify the configured root-run local Vhost service with one reserved `.test` site, then roll it back and remove the disposable site account and files.

**Verification:** The actual HTTP apply route returned `received` for `vhost-apply-bae475b4-1dba-47ab-9251-43fe8758ff79`; the rollback route returned `received` for `vhost-rollback-75781ca2-87f2-4942-afce-14b6d7644c3c`. Read-only SQLite queries of the configured global V2 database confirmed both rows as `processed` with `applied` disposition. The operation manifest retained both exact receipts. After rollback, the site was absent from inventory and its account, group, and webroot were removed. Nginx and OpenLiteSpeed remained active with valid configuration. No public DNS or hosted endpoint was used.

**Change:** The first exercise found that rollback could report success while an `lsphp` worker prevented deletion of a newly created site account. Rollback now sends `TERM` to that exact site's processes, waits for them to exit, and checks that account removal succeeded before completing. The second root-service exercise verified account cleanup. OpenLiteSpeed left versioned copies of the disposable configuration; those exact test files were removed after confirming the active configuration had been rolled back.

**Open:** This verifies one local site apply/rollback producer path. Certificate renewal, background producers, reviewed Curator Markdown projection, complete artifact inventory, and release approvals remain open.

## 2026-10-25 — Add the Vhost apply-to-Curator V2 receipt bridge

**Decision:** Keep the application-to-Curator producer in the Vhost repository. After a confirmed Vhost apply or rollback is durably recorded, send a compact operation-specific planned goal through the configured local Curator V2 MCP, and retain a retryable pending state if no matching receipt is returned.

**Rationale:** Curator V2 must not change consumer application source. Vhost owns its apply route, durable operation manifest, and retry UI; Curator owns the scoped event ledger.

**Verification:** A focused integration test applied a disposable Vhost site through the actual HTTP route, checked generated fixture files, simulated Curator being unavailable, retried with the installed alpha MCP launcher, rolled back the site, and verified both processed event receipts and planned goals in a temporary V2 database. Exact event replay returned the same receipt. Generated file paths and database paths were absent from Curator goal text. The root-run local service received the operator-owned MCP/profile/UID settings, restarted, and its read-only status route reported root execution with active, valid Nginx and OpenLiteSpeed configurations. The focused test and Vhost UI build passed.

**Open:** No apply was run through the installed root service because that would alter live Vhost files. A receipt from that service, reviewer-approved Markdown projection, full artifact inventory, and rollback/recovery evidence remain open. No public hosting was used.

## 2026-10-25 — Record failed rollback attempts for Curator V2

**Change:** The Vhost rollback route now records a linked failed-attempt entry when restoring a snapshot fails, then sends that outcome through the existing Curator V2 bridge. The existing retry route accepts the exact failed rollback operation ID.

**Verification:** The focused disposable HTTP/MCP integration test corrupts only the temporary test site's snapshot manifest, invokes rollback, and confirms a `received` receipt followed by a processed Curator event and planned goal. The goal summary identifies the failed rollback and contains no fixture, backup, database, or temporary path. The focused test passed.

**Open:** The test verifies reporting, not recovery from damaged backups. Full producer/artifact review and release approval remain open.

## 2026-10-10 — Enable Hermes profile

**Decision:** Use `renew-ssl-coding` as the isolated Hermes/Codex profile for this repository.

**Rationale:** Keep profile memory, sessions, scheduler state, and CuratorMD state separate from other repositories.

## 2026-10-25 — Redact sensitive manual DNS values from persistent logs

**Decision:** Manual DNS challenge values, passwords, and keys must not be recorded verbatim. Keep the manual script's Curator producer coverage out of scope.

**Change:** The manual ACME script now streams terminal output through a line-by-line filter before appending to its persistent log. It removes labeled TXT/expected values, common credential assignments, long token-like values, and complete PEM private-key blocks. Existing transient ACME output files are removed on exit.

**Verification:** A synthetic canary test confirms DNS values in ACME labels, parsed summaries, DNS answers, and expected-value diagnostics, as well as password assignments and PEM bodies, do not appear in filtered output. Ordinary status text remains. The focused Python test, `bash -n acme_dns_manual_nginx_swap.sh`, and `git diff --check` pass.

**Open:** This changes only persistent logging for the manual script. It does not send manual-script events to Curator, close standalone-script producer coverage, set a log-expiry policy, or prove other logging boundaries. Changes remain uncommitted for review.

## 2026-10-25 — Rebind the source matrix after the log-filter change

**Changed fact:** The prior Vhost producer-source fingerprint is stale after adding the streaming log filter and its canary test. At checkout HEAD `7d2b10f5433cfe566fc560741bbc9401265176f4`, the config SHA-256 remains `4f3a34e84832b7e8ccfe4e91a68b0664c6aa603409318197f0b44e6454ece44a`; the refreshed listed-source manifest SHA-256 is `e8ac71eace1104b71d0be2cfabe4287e75b2537774c1b7ecf506bd9ed87bf581`.

**Method:** Hash sorted `<file-sha256>  <relative-path>\n` rows for the repository config, Vhost server/UI, Curator adapters, ACME bridge, manual renewal, inventory, batch and setup scripts, and focused integration/privacy tests.

**Open:** This binds only the listed dirty working-tree files. It is not a clean revision, a complete producer inventory, or owner approval. Standalone utility scope, filesystem observations, and out-of-root dispositions remain open.

## 2026-10-25 — Reverify the disposable Hermes managed integration

**Changed fact:** The repository-owned disposable harness passes against the current Hermes Core checkout, the installed Curator V2 stdio server, and the Vhost consumer hook.

**Verification:** Five bounded lifecycle events reached the isolated project. The run checked exact replay, queued-delivery retry, lost-ack recovery after re-enrollment, source-epoch advancement, explicit goal binding, planned-goal denial, canonical projection reconciliation, reviewer-write denial, privacy canaries, and preservation of an out-of-scope file. The focused Vhost HTTP route contract also passed for apply/archive/rollback and SSL/cron receipt retry/recovery with a temporary server, database, and filesystem. No real Codex app-server turn, certificate renewal, or live Vhost operation ran.

**Open:** The worktrees are dirty, so this is not release-revision evidence. The run does not close producer/source coverage, standalone-script scope, workflow filesystem observation, or out-of-root disposition review.

## 2026-10-25 — Verify the current Vhost route against Curator V2

**Intent:** Verify the current local Vhost service publishes and reverses one owner-authorized disposable site operation through the installed V2 plugin.

**Changed fact:** Restarted `renew-dev-ssl-vhost-manager.service` from the current checkout, then applied and rolled back the previously absent `curator-v2-smoke-20261025.test` site.

**Verification:** Apply operation `b335561e-8417-4f76-9cff-5da7ba903e90` and rollback operation `06ccae0b-ac13-4a96-aa30-db79f99ed045` returned exact V2 event receipts; the installed ledger reports both as `processed` for `vhost-manager-alpha`. The Vhost API reports the site absent after rollback. Nginx and OpenLiteSpeed are active and their configs validate. No certificate was renewed.

**Open:** The service runs from the dirty checkout, so this is local workflow evidence rather than release-revision evidence. Full producer/artifact coverage, standalone-script scope, human disposition, and release approval remain open.

## 2026-10-25 — Route standalone utility outcomes through Curator V2

**Intent:** Close the direct-script gap without sending utility input or output to Curator.

**Changed fact:** Manual DNS renewal, interactive batch renewal, domain inventory refresh, and Nginx vhost setup now submit only a fixed producer ID, UUID, and exit code to the loopback Vhost API. A mode-0700 queue with mode-0600 atomic files retains the same bounded payload during Vhost outages; accepted results are removed only after the app confirms a `received` Curator receipt. The operation manifest preserves exact-ID retry. The adapter excludes domains, paths, logs, DNS values, credentials, and generated contents.

**Verification:** The installed-package disposable HTTP/MCP contract exercises all four producer IDs, queues and retries the first result through a simulated outage, and confirms processed receipts, one active goal/fact per operation, and canary/path absence. It also runs `update_domain_inventory.sh` against a temporary source, output, Nginx directory, and fake OpenSSL/timeout binaries; generated inventory remains in fixture state and the corresponding result reaches the configured V2 project. The focused integration test passes. Shell syntax, Python compilation, Node syntax, ESLint, Prettier, and `git diff --check` pass.

**Source binding:** Dirty checkout HEAD `7d2b10f5433cfe566fc560741bbc9401265176f4`; repository config SHA-256 `4f3a34e84832b7e8ccfe4e91a68b0664c6aa603409318197f0b44e6454ece44a`; apply adapter SHA-256 `354e3158eb3927d1167724dc4fee1a254be885d2b9199abadeee0a88e4568f63`; standalone result adapter SHA-256 `bffbb1666a289f236c70f9e3a9e8b4ab19ce29becaa5cbb15ba084ab02a0a077`; listed-source manifest SHA-256 `9600785c44ad75dc8fac76a42c261f379e858302c87a198d8918c4df8fe578b8` across 16 producer, adapter, config, and contract files.

**Open:** This proves the adapter path and one actual fixture-driven utility, not a full workflow/artifact observation. No real DNS challenge, certificate renewal, batch run, or Nginx apply ran; no host/provider destinations were observed. The working tree is dirty. Owner review of each producer's artifact classes and out-of-root disposition, process-bounded observations for the remaining workflows, and source/config re-review remain open. No Curator staging or project data was deleted.

## 2026-10-25 — Keep standalone receipt saturation truthful

**Intent:** Ensure a full offline retry queue cannot claim that a new operation was retained.

**Changed fact:** The 100-entry private result queue now distinguishes a stored retry from a result rejected because capacity is exhausted. The four producer wrappers report only that the receipt is unconfirmed and direct the operator to the Vhost result queue.

**Verification:** The focused queue-cap regression passes and confirms a 101st result is not written or reported as queued. The result adapter and regression file pass Pylint at 10.00/10; Python compilation, shell syntax, and Vhost `git diff --check` pass. The disposable route integration separately passes all four producer IDs, offline retry, and fixture inventory refresh.

**Source binding:** Dirty checkout HEAD `7d2b10f5433cfe566fc560741bbc9401265176f4`; result adapter SHA-256 `ee1fef9af77c759002f3657b727ea7544712bdc568457bdda81820d09e69bde6`; listed-source manifest SHA-256 `54965f5ce5b072d3892e4a63a9c61672b27ec2d5567d6750827a774391d9edff` across 17 consumer config, producer, adapter, and test files.

**Open:** Manual DNS renewal, batch execution, and Nginx apply remain unexercised; the Vhost service has not been restarted with this source, and full workflow filesystem observations and owner dispositions remain open.

## 2026-10-25 — Exercise disposable batch and Nginx setup scripts

**Changed fact:** Added rootless user/mount-namespace tests for the actual renew_all_domains.sh confirmation, progress, lock, and bounded-result path, and for the actual setup_nginx_vhost.sh --apply fixture write/reload path. Both use disposable mounted state and stub external side effects. The manual DNS log-redaction canary test also passes; it verifies filtering, not a complete manual DNS renewal.

**Verification:** The focused queue-cap, batch, and Nginx setup tests pass (3 tests); the manual DNS log-redaction test passes (1 test). The batch fixture confirms one explicit batch and per-domain approval, a mode-0600 progress file, and a result containing only domain_batch_renewal, operation UUID, and exit code. The setup fixture verifies config and symlink writes inside the private Nginx mounts, stubbed validation/reload, and a bounded outcome. Neither test contacts DNS, renews a certificate, nor changes host Nginx state.

**Source binding:** Dirty checkout HEAD 7d2b10f5433cfe566fc560741bbc9401265176f4; Curator V2 config SHA-256 4f3a34e84832b7e8ccfe4e91a68b0664c6aa603409318197f0b44e6454ece44a; result adapter SHA-256 ee1fef9af77c759002f3657b727ea7544712bdc568457bdda81820d09e69bde6; sorted 23-file source/config/test manifest SHA-256 9b0b9865652f14f2d6e9f5416bca8d91a06ad9c98bdc7ce9d52e7f70fa8251b8.

**Open:** The root ACME cron still bypasses Vhost and Curator; the manual DNS issue/renew workflow has only redaction-canary evidence, not bounded end-to-end artifact observations. The namespace tests do not establish production destinations or owner dispositions for out-of-root artifacts. The source is dirty, and the Vhost service was not restarted with it. Keep the full producer/artifact checklist item open.


## 2026-10-26 — Close standalone producer coverage for the V2 alpha

**Intent:** Close the four standalone utility workflows within the approved one-repository Vhost development alpha, keeping manual DNS challenge values, passwords, keys, and raw command output out of Curator records.

**Changed fact:** The Vhost source-to-artifact matrix and the Curator V2 plan now record the reviewed scope, Vhost/OS-owned destinations, content-free receipt fields, and bounded disposable observations. Shared multi-consumer runtime is outside the one-repository-at-a-time alpha scope.

**Verification:** The six focused disposable tests for the bounded queue, batch renewal, inventory refresh, manual DNS cleanup/redaction, and Nginx setup pass against this checkout. The 24-file source/config/adapter/test manifest SHA-256 is `390823695cf388aa91dda1003ae3d5b18f131f42990f0a09bc38b4e31f7d51f2`; checkout HEAD is `7d2b10f5433cfe566fc560741bbc9401265176f4`.

**Open:** Persistent-log retention, actual certificate renewal, external provider/host behavior, human disposition, and production/release evidence remain open. Multi-consumer generalization reopens only if the owner expands scope.

**Outcome:** Closed standalone source/artifact coverage for the approved dirty local alpha snapshot; no live certificate or staging artifact was deleted.

## 2026-10-26 — Enforce approved manual-DNS log expiry

**Intent:** Enforce the owner's 72-hour maximum age for manual-DNS status logs without routing log contents through Curator.

**Changed fact:** Added a root-owned service and persistent six-hour timer. The cleanup selects only regular files directly under `/var/log` named `acme-dns-manual-*.log`, reports a deletion count only, and deletes at 65 hours 44 minutes 59 seconds to allow for the timer interval and 15-minute randomized spread. It does not modify the manual renewal utility or its redaction filter.

**Verification:** Two focused tests pass for age/name/type and symlink boundaries. `systemd-analyze verify` accepts both units; its only warnings concern the pre-existing `lshttpd.service`. The installed timer is enabled and active; the service exited successfully and journaled a count of two removed logs. A path-only count found zero matching regular logs afterward. Installed script and unit hashes match source. The sorted six-path implementation/test manifest SHA-256 is `a3b07fadb8a08b50557b20f7008f86bcc0c90906d2991c2c7b2f46f65121da3f`. No log contents were opened or sent to Curator.

**Open:** Real ACME behavior and cleanup while the host is powered off are not established. The timer cannot run while the host is stopped.

**Outcome:** Applied the approved local Vhost/OS retention rule; no application source, certificate, or Nginx state changed.

## 2026-10-27 — Set the Vhost Curator staging warning threshold

**Intent:** Keep the local Vhost utility's Curator staging signal useful without imposing an arbitrary file-count limit or stopping writes at 250 MiB.

**Changed fact:** The consumer `.curatormd-v2.toml` now sets only `max_project_bytes = 262144000`. Curator treats it as a warning threshold; there is no project file-count setting. Normal Vhost writes and renewal remain outside this staging signal.

**Verification:** Config SHA-256 is `a37448f38683c864480d4f90db8fc6a6b694311679b598979f86ff574713f746`; its project ID, root, read scope, adapters, and persistence targets are unchanged. Curator's 18 staging tests prove new staged files are accepted above the threshold. The attended Curator registration is active at revision 3 with the same config hash. The profile-scoped Hermes status probe reports healthy status, complete empty staging inventory, 35 processed receipts, 15 goals, and 11 facts. Both repository diff checks pass.

**Open:** The real profile has not crossed 250 MiB, so threshold warning behavior is verified only by local tests. External alerts, real certificate renewal, production retention, and release evidence remain open.

**Outcome:** Applied the warning-only staging policy to the local alpha config without restarting a service or changing Vhost application behavior.

## 2026-10-27 — Preserve Vhost apply intent across Curator retries

**Intent:** Keep the Vhost apply preview's bounded problem and criteria attached to its Curator goal when the Curator bridge is unavailable and the receipt must be retried.

**Changed fact:** The plan response now includes the compact Curator V2 problem and fixed criterion descriptions. The Vhost review modal shows those criteria as open before apply, and `/api/apply` sends the same problem and IDs. The operation manifest stores only that bounded request while the Curator receipt is pending. Retries and replays reuse it; a durable receipt removes the temporary request from the operation record. The outcome fact remains separate from the original problem.

**Verification:** The focused Vhost browser preview test passes against a temporary UI build and isolated test server. The `test_vhost_apply_route_persists_and_retries_exact_curator_receipt` integration passes; it checks request persistence across an unavailable-bridge restart, the stored problem and criteria, failure facts without raw errors, request cleanup after receipt, and exact-payload replay. Node syntax checks and Python compilation pass. The production asset directory and root Vhost process were left untouched.

**Open:** This is a disposable test fixture, not the named owner-reviewed real-consumer acceptance run or evidence packet required by the Curator V2 plan. No checklist item was closed.

**Outcome:** Make local apply retries preserve the original bounded Vhost intent without retaining raw form data or falsely closing the real-run gate.
