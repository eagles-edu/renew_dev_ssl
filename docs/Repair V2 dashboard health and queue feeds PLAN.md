# Repair V2 dashboard health and queue feeds

## Summary

The configured Hermes profile currently returns a fresh, healthy snapshot for this project, and the installed VS Code extension matches source at 0.9.38. The visible error isn’t reproduced by that read. Fix the dashboard so a Hermes readiness problem cannot hide valid Curator queue data, and repeated refreshes don’t keep rewriting unchanged queue files.

## Implementation

- In the V2 VS Code extension, keep Hermes as the readiness source. Read Curator’s existing `project_health` tool separately for queue counts, using the same authorized project and MCP session.
- Validate each feed independently. Require the expected project ID and a complete, fresh database observation for queue counts. Host-dependency `unknown` status must not invalidate complete database counts. Missing, stale, malformed, or mismatched data stays unknown; never display zero as a fallback.
- Show source-specific failure reasons and check times. Distinguish a project mismatch from incomplete or stale data without exposing raw command output.
- Coalesce overlapping refreshes for the same workspace and settings. After three identical failures, pause automatic retries; an explicit refresh or workspace/profile-setting change makes one fresh attempt.
- Write generated inbox and SDE queue files only when their actual contents change. Keep the last-check time in the dashboard so it can update without rewriting unchanged files.

## Tests and acceptance

- Cover each feed succeeding or failing independently, including project mismatch, stale and incomplete responses, and complete queue data when Hermes readiness is unknown.
- Verify repeated identical queue snapshots leave generated files unchanged, overlapping refresh triggers don’t launch duplicate reads, and three identical failures pause automatic retries.
- Run the focused extension checks and inspect the reloaded dashboard: health must reflect Hermes, queues must match Curator’s project-scoped counts, and each panel must show its own failure state.

## Assumptions

- Keep the change within the Curator V2 VS Code extension; the existing Curator `project_health` read is sufficient, so no backend schema change is planned.
- Use the recommended feed split and three-identical-failure retry pause. No profile database initialization or settings changes are planned because the current configured read is healthy.
- Preserve the existing worktree changes. This plan makes no repository, service, or checklist changes.
