# CuratorMD V2 local alpha plugin

Vhost Manager's repository-owned binding is `.curatormd-v2.toml`. It points to
the global Curator V2 service and keeps Vhost Manager staging and persistence
under `.curatormd-v2/` in this checkout.

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
acknowledges `processed` or `duplicate` receipts; a queued or failed delivery
stays pending in Hermes' durable outbox. Its project ID must match this
repository's config. A disposable Git clone of the Vhost config also exercises
the installed `ProjectPlugin` Markdown adapter: it persists and reconciles only
the configured Vhost target, while the read/write-only MCP launcher rejects
`goal_persist` without a separate review grant. No canonical Vhost records are
written by the contract tests.

The Hermes hook source lives in
[`vhost-manager/curatormd-v2/hermes_hook`](../vhost-manager/curatormd-v2/hermes_hook).
It is copied into the Vhost Manager's dedicated Hermes profile and enabled
through that profile's MCP allowlist. The alpha profile grants only project
`vhost-manager-alpha` read/write access; SDE review, purge, retention-hold
release, and event-retry actions remain unavailable. The local profile ID and
OS-user access administration are alpha controls, not cryptographic identity
or production authorization. This does not prove a live Codex event has been
delivered or establish production retention/recovery policy.

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
