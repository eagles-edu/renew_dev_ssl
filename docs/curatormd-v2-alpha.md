# CuratorMD V2 local alpha plugin

Latest local alpha verification (2026-10-26): wheel SHA-256
`c1c3eb614e0dc85f5c9ebe28842316c6db8c59a748b14f05eb720ebb3bf3cee9` is
installed in the isolated `renew-ssl-coding` profile environment; all 61
installed Python module hashes match source and `pip check` passes. A verified
117-entry rollback archive was made before replacement. The supported Hermes
profile read reports 29/29 processed receipts, 12 goals, eight facts, a
complete zero-file staging inventory, and seven healthy local dependencies.
The installed-package Vhost contract passes eight disposable tests, and the
Hermes-managed integration passes five bounded lifecycle events with replay,
retry, re-enrollment, projection, privacy, and denial checks. The six focused
standalone utility/queue/redaction tests pass; their source-to-artifact review
is bound to the current dirty Vhost snapshot in the Curator V2 coverage record.
This closes local standalone coverage for the approved scope. The alpha is
one repository at a time; shared multi-consumer runtime is out of scope.

The local reviewer is `eaglesvn` via OS UID 1000, with exact project read and
review grants. Hermes profile/session context is separate from human identity;
Hermes reports transport `Auth: none`, so no production human identity is
claimed. No gateway, web, or editor process was restarted during the latest
package refresh. Persistent-log retention, live certificate renewal, production
scheduling/identity, and release approval remain open.

Vhost Manager's repository-owned binding is `.curatormd-v2.toml`. It points to
the global Curator V2 service and keeps Vhost Manager staging and persistence
under `.curatormd-v2/` in this checkout.

## Vhost apply receipt bridge

After `/api/apply` succeeds, the app invokes
[`apply_bridge.py`](../vhost-manager/curatormd-v2/apply_bridge.py) through the
configured Curator V2 profile's MCP stdio launcher. It records a compact goal
keyed by the durable Vhost operation ID. Because the operation is already
complete, the goal starts active for human review. After the exact goal
receipt, the bridge records one deterministic, path-free `change` fact stating
the outcome and verifies that fact's matching receipt before returning. Exact
retries reuse both event IDs. The human-review criterion remains open. The app
returns the exact project/event goal receipt and stores its state in the Vhost
operation manifest. If Curator is unavailable, the operation remains pending
and Recent activity offers an idempotent retry using the same IDs.
`/api/rollback` records the rollback outcome the same way, linked to the
original operation by ID. The bridge does not capture configuration file
contents, credentials, manual DNS values, command output, or request
transcripts. Its profile is pinned by the operator and it supplies a bounded
app-session identifier to the private stdio server; this does not prove an
interactive Hermes session or authenticated human identity.

The root-run Vhost service receives these operator-owned values from
`/etc/systemd/system/renew-dev-ssl-vhost-manager.service.d/20-curatormd-v2.conf`.
Keep host paths in this root-owned systemd drop-in, not in
`.curatormd-v2.toml`:

```text
CURATOR_V2_BRIDGE_PYTHON=/absolute/path/to/curator-profile-python
CURATOR_V2_MCP_COMMAND=/absolute/path/to/curatormd-v2-mcp
CURATOR_V2_DATABASE=/absolute/path/to/global.sqlite3
CURATOR_V2_PROJECT_ROOT=/absolute/path/to/renew_ssl
CURATOR_V2_PROFILE_ID=renew-ssl-coding
CURATOR_V2_UID=1000
CURATOR_V2_GID=1000
CURATOR_V2_HOME=/home/eaglesvn
```

The bridge drops from the root app process to the configured non-root OS UID/GID
for the MCP call. A missing or invalid host setting leaves the route result
pending; it never reports an unverified receipt as saved. The test-mode route
integration covers apply, Curator outage/retry, rollback, and exact replay
using temporary fixture files and a temporary database; it also verifies that
generated file paths and database paths are absent from Curator goal text. The
live service has applied and rolled back two disposable `.test` sites with
processed V2 receipts. Their four exact operation goals have since been
projected to the configured Markdown target and reconciled as `synced` using
the local reviewer grant. The source-to-artifact inventory for the approved
development scope is recorded in the Curator V2 coverage matrix. Human SDE
disposition, persistent-log retention, and release gates remain open.

## SSL renewal receipt bridge

After the local SSL renewal process exits, Vhost Manager records a durable
`ssl-renew` operation with the domain, completed/failed/interrupted outcome,
and exit code, then sends an active Curator V2 review goal and its path-free
outcome fact. It sends no terminal output or certificate contents. A missing
receipt stays pending and can be retried from Operation history using the same
operation ID. The disposable HTTP/MCP
contract simulates successful, failed, and interrupted renewal outcomes, verifies outage
retry and processed receipts, and checks that goal text contains no fixture or
database path. This does not execute ACME or change a real certificate.

The root ACME cron at 01:52, 07:52, 13:52, and 19:52 now invokes the
root-owned `renew-dev-ssl-acme-cron-curator` bridge. It runs the same
`/root/.acme.sh/acme.sh --cron --home /root/.acme.sh` command, suppresses
terminal output, and records the exit result through the loopback Vhost API.
If Vhost Manager is unavailable, the bridge stores a mode-0600 result file in
`/var/lib/vhost-manager/curatormd-v2-pending-ssl-cron`; the next run retries
queued results before starting ACME. If Curator is unavailable while Vhost is
up, Vhost retains the operation as `pending` for retry by its exact operation
ID.

The root crontab now points to the installed bridge, and the local service was
restarted to load the result route. A disposable fake-ACME run through the
installed root bridge returned the fake exit code 19, recorded the exact
`vhost-ssl-cron-<operation-id>` receipt as `received`, and persisted a
`processed` receipt and planned goal in the alpha SQLite ledger. The fake
terminal canary did not appear in the goal. No real certificate renewal was
run. The authorized local reviewer projected the exact goal to the configured
`.curatormd-v2/persistence/HISTORY.md` target; read-only reconciliation reports
`synced` with matching SHA-256 `b8317444a8cf24b25122fb09eb38468b763d4670e11ea47094081c2d71d9f131`.
The projection excludes the transient canary and ledger path. The goal remains
planned pending a human decision; no SDE disposition or purge is claimed.

The four apply/rollback goals for the two earlier reserved `.test` site
exercises were also projected and reconciled to the same target. Each reported
`synced` with matching expected and actual hashes. Those five earlier goal
blocks contain no temporary path, ledger path, or fake ACME output canary; they
remain planned. The latest apply/rollback goals are active and await human
disposition. Projection does not decide operation outcomes or authorize
cleanup.

## Standalone utility outcome receipts

The current Vhost source now has a loopback receipt path for direct manual DNS
renewal, batch renewal, inventory refresh, and Nginx vhost setup. It sends only
a fixed producer ID, operation UUID, and exit code. A private queue retains
those fields during Vhost outages and removes them only after the app confirms
a Curator receipt. Domains, paths, logs, DNS values, credentials, and generated
files are not sent. Curator does not scan or delete the utility outputs; they
remain Vhost/OS-owned.

The six focused disposable queue, standalone-workflow, and log-redaction tests
pass against the reviewed dirty consumer snapshot. The source-to-artifact matrix
records all four approved utility workflows, their Vhost/OS-owned output
classes, no-verbatim handling for manual DNS values/passwords/keys/output, and
the bounded file-operation observations. This closes standalone source and
artifact coverage for the approved local alpha scope only. It does not claim a
real certificate renewal, provider/host behavior, persistent-log expiry, or
production release acceptance. See the linked V2 coverage matrix for its source
fingerprint and observation limits.

Run the consumer/backend contract test with the Python environment that has the
Curator V2 alpha package installed:

```sh
"${CURATORMD_V2_PYTHON:?set this to the alpha environment's python}" \
  -m unittest discover -s tests/vhost-manager \
  -p 'test_curatormd_v2_contract.py' -v
```

The tests read this repository's config and write only to disposable
databases. They check the shared typed goal event contract, exercise goal
start/exact replay/scoped status through the installed MCP stdio launcher with
test-only registration/grants, and verify the consumer-owned Hermes hook uses
managed MCP while forwarding only bounded lifecycle fields. The hook only
forwards Hermes' durable source ID and acknowledges `processed` or `duplicate`
receipts only when project and event IDs match the outbox event; a queued,
failed, or mismatched receipt stays pending in Hermes' durable outbox. Its
project ID must match this repository's config. A disposable Git clone of the
Vhost config also exercises
the installed `ProjectPlugin` Markdown adapter: it persists and reconciles only
the configured Vhost target, while the read/write-only MCP launcher rejects
`goal_persist` without a separate review grant. The new app-route test writes
only to a disposable Curator database and fixture root; no live Curator database
or Markdown target is modified by the contract tests.

The Hermes hook source lives in
[`vhost-manager/curatormd-v2/hermes_hook`](../vhost-manager/curatormd-v2/hermes_hook).
It is copied into the Vhost Manager's dedicated Hermes profile and enabled
through that profile's MCP allowlist. The alpha profile grants only project
`vhost-manager-alpha` read/write access; SDE review, purge, retention-hold
release, and event-retry actions remain unavailable. The local profile ID and
OS-user access administration are alpha controls, not cryptographic identity
or production authorization. This does not prove a live Codex event has been
delivered or establish production retention/recovery policy.

The `renew-ssl-coding` profile allowlist includes the read-only `goal_report`
tool alongside `goal_status` for concise lifecycle reporting. A real one-shot
Hermes request to `goal_report` was rejected by the profile's MCP call path,
even after the tool was selected; read-only Curator state showed no mutation.
The profile approval/runtime path remains unresolved, so tool discovery alone
does not establish that the model session can use this read tool.

Latest profile smoke attempt (2026-10-21): an unattended Hermes session
launched from this checkout reached the configured profile, but Curator V2
`goal_list` was rejected with `user rejected MCP tool call`. The attempt
created no goal, binding, or receipt. No MCP approval was bypassed; the
profile-mediated request workflow remains open.

Current installed alpha wheel recheck (2026-10-21): SHA-256
`2773a8e05fc28dc8e45c236b75e208428c276cfa201a98de96891c616cc2bb0e` matches
the latest Curator V2 source build. The seven installed consumer contracts
pass against this wheel and Hermes MCP discovery exposes 45 tools. These
checks do not clear the profile approval rejection or verify an application
request or canonical target write.

Latest Curator V2 package installed for the alpha profile (2026-10-21): wheel
SHA-256
`ed728e38b88ef208e47d6a48ae6ee2982531703cd6eedf51ceb82aca5f695d77`. The
seven installed consumer contracts pass, MCP discovery exposes 45 tools, and
the installed purge, Markdown persistence, and project-plugin modules match
the Curator source hashes. The interactive profile approval rejection and
Vhost application request workflow remain open.

Latest Curator V2 package installed for the alpha profile (2026-10-21): wheel
SHA-256
`f2c4ffa40bf33bb35d5925436911eabc9c93dcbeed149aa6212ef2bd275a5383`. All
seven installed consumer contracts pass, MCP discovery exposes 45 tools, and
installed store, purge, Markdown persistence, and project-plugin module hashes
match source. The profile approval rejection remains open; no application
request or canonical target write is verified.

In a Vhost Manager Hermes session, explicitly bind its current session to an
already-active Vhost goal by sending `curator-v2 bind <goal-id>`. The hook
forwards only the parsed goal ID and the host-provided session ID through
Hermes' allowlisted managed MCP call; the hook returns success only when the
goal is active and Hermes confirms that the session binding was persisted. For
durable Codex events, Hermes attaches the exact project ID and goal ID from
that persisted session binding. The Vhost hook accepts only the configured
`vhost-manager-alpha` project ID; it does not require a working directory,
because the durable outbox intentionally does not retain `cwd`. Prompt,
response, failure-detail text, and the working directory are not sent to
Curator. Project/profile values remain operator assertions rather than
cryptographic identity. A real session, successful binding, and processed
event still require live profile verification.

On 2026-10-21, the bounded Hermes Core lifecycle-hook/outbox files and the
Hermes-root Host Steward plugin were installed into the local runtime, with a
recoverable backup, and the system gateway restarted successfully. The
`renew-ssl-coding` profile endpoint returns `state=ready`, and Curator MCP
discovery connects with 45 tools. The live profile probe exposed that Hermes
returns the Curator binding object as JSON text; the consumer hook now parses
that bounded result and still requires the persisted `bound` status plus
`binding=validated`. All seven consumer contracts pass after the fix.

The earlier profile sessions left a durable outbox queue stalled at source
sequence 2 because the previous Vhost hook required `cwd`, which Hermes does
not persist. After installing the corrected hook and restarting the system
gateway, the profile MCP test connected with 45 tools. A fresh
`renew-ssl-coding` session replayed the queue: Hermes sequences 1 through 9 are
acknowledged, including the formerly stuck sequence 2, and the current session
has a matching persisted project/goal binding. Curator's Vhost inbox cursor is
at sequence 9; all 10 inbox rows are processed, including the initial goal
receipt. SQLite `quick_check` reports `ok`. The session response text said the
bind was rejected, but the persisted binding and processed receipts confirm the
write completed. The synthetic no-`cwd` contract test also passes all seven
consumer contracts.

The bounded lifecycle payload omits prompt, response, failure-detail text, and
working directory. This verifies the local Vhost alpha route, not cryptographic
human identity or production authorization. Keep identity, retention policy,
production backup/recovery, and release approval open. The runtime backup is
under
`/home/eaglesvn/.hermes/curator-v2-alpha-runtime-backup.0KzV1U`.

## Disposable Hermes managed-MCP integration

The Vhost-owned integration harness composes the actual Hermes Core
`HookRegistry` and `HookContext`, the installed Curator V2 stdio launcher, and
this repository's Vhost hook in temporary profile, database, checkout, and
Markdown state. Run it with the Hermes Core test interpreter and the installed
Curator profile interpreter:

```bash
/home/eaglesvn/.hermes/hermes-agent/.venv/bin/python \
  tests/vhost-manager/test_curatormd_v2_hermes_managed_integration.py \
  --hermes-root /home/eaglesvn/.hermes/hermes-agent \
  --curator-python /home/eaglesvn/.hermes/profiles/renew-ssl-coding/curator-v2-alpha-venv/bin/python
```

The latest check passed on 2026-10-22: Hermes persisted the exact profile/session/goal
binding, the Vhost `curator-v2 bind` command was denied for the still-planned
goal, and after activation the same command bound a second session through the
`agent:start` hook. Hermes dispatched and replayed three bounded lifecycle
events under that explicit binding through managed
MCP, received processed Curator receipts, wrote the configured Vhost projection
through `ProjectPlugin`, and reconciled it through MCP. The three events cover
turn start, normal completion, and interruption; the interrupted outcome is
reported as an open gate, not goal success. Private model/cwd markers were
absent and an out-of-scope target stayed unchanged. The harness
invokes Hermes Core's actual `GatewayTurnProgressMixin._event_callback_sync`
from a worker thread and awaits the scheduled gateway-loop delivery; exact
callback requeue does not create a second outbox row. A temporary MCP
allowlist denial leaves the interrupted event pending; restoring the grant
and draining the outbox retries and acknowledges it. It also confirms the
write-only profile is denied the reviewer-gated
`goal_persist` MCP tool without changing the target; the trusted Vhost plugin
adapter performs the ordinary progress projection. All test data was
temporary. This does not run the Hermes gateway service or exercise a real
Vhost application request, the production target, or authenticated identity.

## Request-bound static-site acceptance run (2026-10-27)

The loopback Vhost UI previewed and applied the disposable static site
`v2accept-20261027.test`, then rolled it back through the same UI. The review
preview showed the exact bounded problem and three open criteria:
`nginx_valid`, `site_reachable`, and `human_review`. The request digest is
`6b7de8ea5f743d6b7e5bf8dc03ec28c7298e99c8e1e745fd535e77f537de09bc` over the
problem and ordered criterion IDs. The consumer config SHA-256 is
`a37448f38683c864480d4f90db8fc6a6b694311679b598979f86ff574713f746`; relevant
working-source hashes are recorded below. TCP and UDP firewall changes were
zero.

Apply operation `00ec3e2f-5736-4b37-ab8d-beed07436e77` produced processed
Curator receipt `vhost-apply-00ec3e2f-5736-4b37-ab8d-beed07436e77` and goal
`vhost-op-00ec3e2f-5736-4b37-ab8d-beed07436e77` in project
`vhost-manager-alpha`. Rollback operation `eef7028b-a2c3-409b-92d3-dc1249f13a67`
produced processed receipt `vhost-rollback-eef7028b-a2c3-409b-92d3-dc1249f13a67`
and goal `vhost-rollback-eef7028b-a2c3-409b-92d3-dc1249f13a67`. After restarting
the Vhost service, its history still showed the create as `rolled-back` and the
rollback as `complete`; the domain, dedicated account, and site home were
absent. Nginx and OpenLiteSpeed were active and configuration-valid. A
read-only check of the created goal showed the exact problem and criteria, an
active state, and next action `Review this Vhost Manager operation outcome.`
No criterion was marked verified by the operation.

The static-mode criterion and summary corrections are in `core.cjs` and
`index.cjs`; their SHA-256 values are `4ea456dc01fa7c10111c434a1b46d174d391822bbe3419e6160c1737cf1731ca` and
`9c69f73822ab6b6397b5811772efb7e30b0220cdbdd558d27ed9756e15cb1f60`.
The focused `test_vhost_apply_route_persists_and_retries_exact_curator_receipt`
passed, including the static-mode criteria and summary assertions. The source
checkout was at `07a9fb8c45d66b521073118dd59dc3d00b8d4781` with pre-existing
dirty files preserved.

This advances the named local application-entrypoint run, but does not close
the broader acceptance gate: a bounded Hermes `goal_report`, same-event replay
of this live request, before/after hashes for out-of-scope targets, and the
owner-reviewed evidence packet are still missing. The Curator criteria remain
open pending their own evidence and human review.
