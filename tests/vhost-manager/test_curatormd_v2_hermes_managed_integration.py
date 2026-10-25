"""Disposable integration of Hermes Core's managed MCP path and the Vhost V2 hook.

Run this with Hermes Core's test interpreter and pass the installed Curator V2
profile interpreter. All profile, database, repository, and Markdown state is
created under one temporary directory.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import nullcontext
import json
import os
from pathlib import Path
import shutil
import subprocess
import os, sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch


def _provision_project(
    curator_python: Path,
    project_root: Path,
    database: Path,
    profile_id: str,
) -> None:
    """Create an exact disposable registration and project grant."""

    source = r"""
import os, sys
from pathlib import Path
from curatormd_v2 import (
    AuthenticatedCaller, CuratorStore, ProjectAccessManager, ProjectAction,
    ProjectAdministrationAction, ProjectConfig, ProjectRegistrationRequest,
)

class Administrator:
    def authorize_project_administration(self, caller, project_id, action):
        return (
            caller.subject_id == "integration-admin"
            and project_id == "vhost-manager-alpha"
            and action in {
                ProjectAdministrationAction.REGISTER,
                ProjectAdministrationAction.GRANT,
            }
        )

root, database, profile = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
subject_id = f"local-uid:{os.geteuid()}"
config = ProjectConfig.load(root)
store = CuratorStore(database)
try:
    admin = ProjectAccessManager(store, Administrator())
    operator = AuthenticatedCaller("integration-admin")
    admin.register_project(
        operator,
        ProjectRegistrationRequest.from_project_config(
            config, "Disposable Hermes managed-MCP integration"
        ),
    )
    for action in (ProjectAction.READ, ProjectAction.WRITE):
        admin.grant(
            operator, config.project_id, subject_id, action,
            "Disposable integration grant",
        )
finally:
    store.close()
"""
    subprocess.run(
        [
            str(curator_python),
            "-c",
            source,
            str(project_root),
            str(database),
            profile_id,
        ],
        check=True,
        capture_output=True,
        timeout=20,
        env=os.environ.copy(),
    )


def _persist_with_consumer_plugin(
    curator_python: Path,
    project_root: Path,
    database: Path,
    goal_id: str,
) -> None:
    """Use the Vhost-owned trusted plugin adapter for a disposable projection."""

    source = r"""
import sys
from pathlib import Path
from curatormd_v2 import CuratorStore, ProjectConfig, ProjectPlugin

root, database, goal_id = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
config = ProjectConfig.load(root)
store = CuratorStore(database)
try:
    ProjectPlugin.bind(config, store).persist_goal(
        goal_id, ".curatormd-v2/persistence/HISTORY.md"
    )
finally:
    store.close()
"""
    subprocess.run(
        [str(curator_python), "-c", source, str(project_root), str(database), goal_id],
        check=True,
        capture_output=True,
        timeout=20,
        env=os.environ.copy(),
    )


def _assert_processed_receipts(
    curator_python: Path,
    database: Path,
    event_ids: list[str],
) -> None:
    """Confirm both hook receipts reached the disposable V2 project store."""

    source = r"""
import json, sys
from pathlib import Path
from curatormd_v2 import CuratorStore, EventInboxStatus

database, event_ids = Path(sys.argv[1]), json.loads(sys.argv[2])
store = CuratorStore(database)
try:
    statuses = [
        store.event_receipt("vhost-manager-alpha", event_id).status
        for event_id in event_ids
    ]
    assert statuses == [EventInboxStatus.PROCESSED] * len(event_ids), statuses
finally:
    store.close()
"""
    subprocess.run(
        [str(curator_python), "-c", source, str(database), json.dumps(event_ids)],
        check=True,
        capture_output=True,
        timeout=20,
        env=os.environ.copy(),
    )


def _reenroll_consumer(
    curator_python: Path, database: Path, project_root: Path, profile_id: str
) -> None:
    """Advance the disposable Vhost binding to a fresh source epoch."""

    source = r"""
import sys
import os
from pathlib import Path
from curatormd_v2 import (
    AuthenticatedCaller,
    ConsumerBindingTransitionRequest,
    CuratorStore,
    ProjectAccessManager,
    ProjectAction,
    ProjectAdministrationAction,
)

class Administrator:
    def authorize_project_administration(self, caller, project_id, action):
        return (
            caller.subject_id == "integration-admin"
            and project_id == "vhost-manager-alpha"
            and action == ProjectAdministrationAction.GRANT
        )

store = CuratorStore(Path(sys.argv[1]))
try:
    for revision, status, transition_id in (
        (1, "deregistration_pending", "integration-cutover-pending"),
        (2, "deregistered", "integration-cutover-done"),
    ):
        store.transition_consumer_binding(
            ConsumerBindingTransitionRequest(
                project_id="vhost-manager-alpha",
                status=status,
                rationale="Verify exact Hermes outbox recovery after cutover",
                expected_revision=revision,
                transition_id=transition_id,
            ),
            actor_id="integration-admin",
        )
    registration = store.get_project_registration("vhost-manager-alpha")
    result = store.transition_consumer_binding(
        ConsumerBindingTransitionRequest(
            project_id="vhost-manager-alpha",
            status="active",
            rationale="Verify exact Hermes outbox recovery after cutover",
            expected_revision=3,
            transition_id="integration-cutover-reenroll",
            expected_source_epoch=1,
            expected_project_revision=registration.revision,
            repository_fingerprint=registration.repository_fingerprint,
            config_sha256=registration.config_sha256,
            backend_api_version=registration.backend_api_version,
        ),
        actor_id="integration-admin",
    )
    assert result.binding.source_epoch == 2, result
    access = ProjectAccessManager(store, Administrator())
    for action in (ProjectAction.READ, ProjectAction.WRITE):
        access.grant(
            AuthenticatedCaller("integration-admin"),
            "vhost-manager-alpha",
            f"local-uid:{os.geteuid()}",
            action,
            "Regrant the new source epoch after cutover",
        )
    from curatormd_v2.hosted_mcp import build_local_profile_mcp
    runtime = build_local_profile_mcp(
        project_root=Path(sys.argv[2]),
        database=Path(sys.argv[1]),
        profile_id=sys.argv[3],
        allow_write=True,
    )
    runtime.close()
finally:
    store.close()
"""
    completed = subprocess.run(
        [
            str(curator_python),
            "-c",
            source,
            str(database),
            str(project_root),
            profile_id,
        ],
        check=False,
        capture_output=True,
        timeout=20,
        env=os.environ.copy(),
    )
    if completed.returncode:
        raise AssertionError(
            "re-enrollment validation failed: "
            f"{completed.stderr.decode(errors='replace')}"
        )


def run(hermes_root: Path, curator_python: Path) -> None:
    """Run the actual Hermes HookContext and installed Curator stdio process."""

    hermes_root = hermes_root.resolve(strict=True)
    curator_python = curator_python.absolute()
    sys.path.insert(0, str(hermes_root))

    consumer_root = Path(__file__).resolve().parents[2]
    hook_source = consumer_root / "vhost-manager/curatormd-v2/hermes_hook/handler.py"
    config_source = consumer_root / ".curatormd-v2.toml"
    curator_launcher = curator_python.with_name("curatormd-v2-mcp")
    if not curator_launcher.is_file():
        raise FileNotFoundError(
            f"installed Curator V2 launcher not found: {curator_launcher}"
        )

    with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-hermes-mcp-") as raw_temp:
        base = Path(raw_temp)
        hermes_home = base / ".hermes" / "profiles" / "vhost-v2-integration"
        hermes_home.mkdir(parents=True)
        os.environ["HERMES_HOME"] = str(hermes_home)
        project_root = base / "vhost-consumer"
        for relative in (
            "docs",
            "vhost-manager",
            ".curatormd-v2/persistence",
            ".curatormd-v2/staging",
        ):
            (project_root / relative).mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "init", "--quiet", str(project_root)],
            check=True,
            capture_output=True,
            timeout=10,
        )
        config_path = project_root / ".curatormd-v2.toml"
        shutil.copyfile(config_source, config_path)
        config_path.chmod(0o600)
        target = project_root / ".curatormd-v2/persistence/HISTORY.md"
        target.write_text("# Disposable Vhost consumer history\n", encoding="utf-8")
        out_of_scope = project_root / "persistence/HISTORY.md"
        out_of_scope.parent.mkdir(parents=True)
        out_of_scope.write_text("# Must remain unchanged\n", encoding="utf-8")

        database = base / "curator-v2.sqlite3"
        profile_id = hermes_home.name
        project_id = "vhost-manager-alpha"
        session_id = "vhost-hermes-managed-mcp-session"
        event_session_id = "vhost-hermes-explicit-bind-session"
        goal_id = "vhost-hermes-managed-mcp-goal"
        _provision_project(curator_python, project_root, database, profile_id)

        server_config = {
            "command": str(curator_launcher),
            "args": [
                "--project-root",
                str(project_root),
                "--database",
                str(database),
                "--profile-id",
                profile_id,
                "--allow-write",
            ],
            "hermes_context": True,
            "hermes_project_id": project_id,
        }
        profile_config = {
            "mcp_servers": {"curator_v2": server_config},
            "hooks": {"entries": {"curator-v2": {"mcp_allowlist": ["curator_v2"]}}},
        }
        (hermes_home / "config.yaml").write_text(
            json.dumps(profile_config), encoding="utf-8"
        )
        profile_config_path = hermes_home / "config.yaml"
        hook_dir = hermes_home / "hooks" / "curator-v2"
        hook_dir.mkdir(parents=True)
        shutil.copyfile(hook_source, hook_dir / "handler.py")
        (hook_dir / "HOOK.yaml").write_text(
            "name: curator-v2\n"
            "description: Disposable Curator V2 integration\n"
            "events: [agent:start, codex:turn:start, codex:turn:end]\n"
            "durable_events: [codex:turn:start, codex:turn:end]\n",
            encoding="utf-8",
        )

        from hermes_constants import get_hermes_home, profile_name_for_home
        from gateway.hooks import HookContext, HookRegistry
        from gateway.run_turn_progress import GatewayTurnProgressMixin
        from tools.mcp_tool_discovery import register_mcp_servers
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers

        if profile_name_for_home(get_hermes_home()) != profile_id:
            raise AssertionError(
                "Hermes did not resolve the disposable profile identity"
            )
        register_mcp_servers({"curator_v2": server_config})
        registry = HookRegistry()
        registry.discover_and_load()
        if registry._outbox is None:
            raise AssertionError("Hermes durable outbox was not initialized")
        turn_callback = GatewayTurnProgressMixin.__new__(GatewayTurnProgressMixin)
        turn_callback._ctx = SimpleNamespace(
            _hooks_ref=registry,
            _loop_for_step=None,
        )

        context = HookContext("curator-v2")
        start = context.call_mcp(
            "curator_v2",
            "goal_start",
            {
                "event_id": "vhost-managed-goal-start",
                "goal_id": goal_id,
                "problem": "Verify Hermes managed MCP delivery to Curator V2",
                "success_criteria": [
                    {
                        "criterion_id": "event-receipts",
                        "description": "Bounded lifecycle events are durably received",
                    }
                ],
            },
            session_id=session_id,
        )
        if start.get("ok") is not True:
            raise AssertionError(f"Curator goal start failed: {start}")
        event_ids: list[str] = []
        lost_ack_event: dict[str, object] | None = None

        async def deliver() -> None:
            turn_callback._ctx._loop_for_step = asyncio.get_running_loop()
            await registry.emit(
                "agent:start",
                {
                    "message": f"curator-v2 bind {goal_id}",
                    "session_id": event_session_id,
                },
            )
            premature_binding = registry._outbox._connection.execute(
                "SELECT project_id, goal_id FROM active_goal_bindings WHERE session_id = ?",
                (event_session_id,),
            ).fetchone()
            if premature_binding is not None:
                raise AssertionError(
                    f"Vhost bind command accepted a planned goal: {premature_binding!r}"
                )

            activated = await asyncio.to_thread(
                context.call_mcp,
                "curator_v2",
                "goal_activate",
                {
                    "event_id": "vhost-managed-goal-activate",
                    "goal_id": goal_id,
                    "reason": "Disposable local integration check",
                    "expected_lifecycle_revision": 1,
                },
                session_id=session_id,
            )
            if (
                activated.get("ok") is not True
                or activated.get("hermes_goal_binding") != "bound"
            ):
                raise AssertionError(
                    f"Hermes goal binding was not persisted: {activated}"
                )
            binding = registry._outbox._connection.execute(
                "SELECT project_id, goal_id FROM active_goal_bindings WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            if binding != (project_id, goal_id):
                raise AssertionError(
                    f"Unexpected persisted Hermes binding: {binding!r}"
                )

            await registry.emit(
                "agent:start",
                {
                    "message": f"curator-v2 bind {goal_id}",
                    "session_id": event_session_id,
                },
            )
            lifecycle = (
                (
                    "codex:turn:start",
                    {
                        "session_id": event_session_id,
                        "attempt_id": "vhost-managed-attempt",
                        "model": "PRIVATE_MODEL_CANARY",
                        "cwd": "/private/repository",
                    },
                ),
                (
                    "codex:turn:end",
                    {
                        "session_id": event_session_id,
                        "attempt_id": "vhost-managed-attempt",
                        "turn_id": "vhost-managed-turn",
                        "outcome": "completed",
                        "model": "PRIVATE_MODEL_CANARY",
                        "cwd": "/private/repository",
                    },
                ),
                (
                    "codex:turn:end",
                    {
                        "session_id": event_session_id,
                        "attempt_id": "vhost-managed-interrupted-attempt",
                        "turn_id": "vhost-managed-interrupted-turn",
                        "outcome": "interrupted",
                        "model": "PRIVATE_MODEL_CANARY",
                        "cwd": "/private/repository",
                    },
                ),
                (
                    "codex:turn:end",
                    {
                        "session_id": event_session_id,
                        "attempt_id": "vhost-managed-lost-ack-attempt",
                        "turn_id": "vhost-managed-lost-ack-turn",
                        "outcome": "completed",
                        "model": "PRIVATE_MODEL_CANARY",
                        "cwd": "/private/repository",
                    },
                ),
            )
            for event_type, event_context in lifecycle:
                reject_first_delivery = event_context.get("outcome") == "interrupted"
                simulate_lost_response = (
                    event_context.get("attempt_id")
                    == "vhost-managed-lost-ack-attempt"
                )
                hook_entry = profile_config["hooks"]["entries"]["curator-v2"]
                allowed_servers = list(hook_entry["mcp_allowlist"])
                if reject_first_delivery:
                    hook_entry["mcp_allowlist"] = []
                    profile_config_path.write_text(
                        json.dumps(profile_config), encoding="utf-8"
                    )
                scheduled = []
                callback_errors = []
                schedule = asyncio.run_coroutine_threadsafe

                def capture_callback_error(_message, error):
                    callback_errors.append(type(error).__name__)

                def capture_scheduled_delivery(coroutine, loop):
                    future = schedule(coroutine, loop)
                    scheduled.append(future)
                    return future

                original_call_mcp = HookContext.call_mcp

                def lose_committed_response(
                    hook_context,
                    server_name,
                    tool_name,
                    arguments,
                    **kwargs,
                ):
                    response = original_call_mcp(
                        hook_context,
                        server_name,
                        tool_name,
                        arguments,
                        **kwargs,
                    )
                    event_context_payload = (
                        arguments.get("context", {})
                        if isinstance(arguments, dict)
                        else {}
                    )
                    if (
                        tool_name == "hermes_codex_event"
                        and event_context_payload.get("attempt_id")
                        == "vhost-managed-lost-ack-attempt"
                    ):
                        return {
                            "ok": False,
                            "error": "simulated lost response",
                        }
                    return response

                try:
                    response_patch = (
                        patch.object(
                            HookContext, "call_mcp", lose_committed_response
                        )
                        if simulate_lost_response
                        else nullcontext()
                    )
                    with response_patch:
                        with (
                            patch(
                                "asyncio.run_coroutine_threadsafe",
                                side_effect=capture_scheduled_delivery,
                            ),
                            patch(
                                "gateway.run_turn_progress.logger.debug",
                                side_effect=capture_callback_error,
                            ),
                        ):
                            await asyncio.to_thread(
                                turn_callback._event_callback_sync,
                                event_type,
                                event_context,
                            )
                        if len(scheduled) != 1:
                            raise AssertionError(
                                f"Hermes did not schedule {event_type} delivery: "
                                f"{callback_errors!r}"
                            )
                        await asyncio.wrap_future(scheduled[0])
                finally:
                    if reject_first_delivery:
                        hook_entry["mcp_allowlist"] = allowed_servers
                        profile_config_path.write_text(
                            json.dumps(profile_config), encoding="utf-8"
                        )

                # Re-enqueueing the same callback payload must return its original
                # durable envelope without advancing the source sequence.
                queued_count = registry._outbox._connection.execute(
                    "SELECT COUNT(*) FROM codex_events"
                ).fetchone()[0]
                envelope = registry.queue_durable_event(event_type, event_context)
                if envelope is None:
                    raise AssertionError(f"Hermes failed to queue {event_type}")
                if reject_first_delivery:
                    failed_delivery = registry._outbox._connection.execute(
                        "SELECT attempts, acknowledged FROM codex_events WHERE event_id = ?",
                        (envelope["event_id"],),
                    ).fetchone()
                    if failed_delivery != (1, 0):
                        raise AssertionError(
                            f"failed managed-MCP delivery was not retained: {failed_delivery!r}"
                        )
                    await registry.drain_durable()
                    retried_delivery = registry._outbox._connection.execute(
                        "SELECT attempts, acknowledged FROM codex_events WHERE event_id = ?",
                        (envelope["event_id"],),
                    ).fetchone()
                    if retried_delivery != (2, 1):
                        raise AssertionError(
                            f"managed-MCP retry was not acknowledged: {retried_delivery!r}"
                        )
                if (
                    registry._outbox._connection.execute(
                        "SELECT COUNT(*) FROM codex_events"
                    ).fetchone()[0]
                    != queued_count
                ):
                    raise AssertionError(
                        "exact Hermes callback replay created a new outbox row"
                    )
                event_ids.append(envelope["event_id"])
                if "model" in envelope["context"] or "cwd" in envelope["context"]:
                    raise AssertionError(
                        "private provider or repository metadata was retained"
                    )
                if simulate_lost_response:
                    pending_delivery = registry._outbox._connection.execute(
                        "SELECT attempts, acknowledged FROM codex_events WHERE event_id = ?",
                        (envelope["event_id"],),
                    ).fetchone()
                    if pending_delivery != (1, 0):
                        raise AssertionError(
                            "committed event was not retained after response loss: "
                            f"{pending_delivery!r}"
                        )
                    lost_ack_event = envelope
                    continue
                if not await registry.emit_durable(envelope):
                    raise AssertionError(f"Vhost hook did not acknowledge {event_type}")
                if not await registry.emit_durable(envelope):
                    raise AssertionError(
                        f"Vhost hook did not acknowledge exact replay of {event_type}"
                    )

            if lost_ack_event is None:
                raise AssertionError("lost-ack lifecycle event was not queued")
            _reenroll_consumer(
                curator_python, database, project_root, profile_id
            )
            # Curator's launcher pins the consumer-binding revision at startup;
            # cutover therefore requires a fresh trusted MCP process before the
            # host may resume delivery.
            shutdown_mcp_servers(names={"curator_v2"})
            register_mcp_servers({"curator_v2": server_config})
            retry_responses = []
            original_call_mcp = HookContext.call_mcp

            def capture_retry_response(
                hook_context,
                server_name,
                tool_name,
                arguments,
                **kwargs,
            ):
                response = original_call_mcp(
                    hook_context,
                    server_name,
                    tool_name,
                    arguments,
                    **kwargs,
                )
                if tool_name == "hermes_codex_event":
                    retry_responses.append(response)
                return response

            with patch.object(HookContext, "call_mcp", capture_retry_response):
                await registry.drain_durable()
            recovered_delivery = registry._outbox._connection.execute(
                "SELECT attempts, acknowledged FROM codex_events WHERE event_id = ?",
                (lost_ack_event["event_id"],),
            ).fetchone()
            if recovered_delivery != (2, 1):
                stderr_log = hermes_home / "logs" / "mcp-stderr.log"
                stderr_tail = (
                    stderr_log.read_text(encoding="utf-8", errors="replace")[-2000:]
                    if stderr_log.is_file()
                    else "<no MCP stderr log>"
                )
                raise AssertionError(
                    "old-epoch receipt was not recovered after re-enrollment: "
                    f"{recovered_delivery!r}; "
                    f"response={retry_responses[-1] if retry_responses else None!r}; "
                    f"stderr_tail={stderr_tail!r}"
                )

            new_session_id = "vhost-hermes-new-source-epoch-session"
            await registry.emit(
                "agent:start",
                {
                    "message": f"curator-v2 bind {goal_id}",
                    "session_id": new_session_id,
                },
            )
            new_binding = registry._outbox._connection.execute(
                "SELECT source_id, source_epoch FROM active_goal_bindings WHERE session_id = ?",
                (new_session_id,),
            ).fetchone()
            if (
                new_binding is None
                or new_binding[1] != 2
                or new_binding[0] == lost_ack_event["source_id"]
            ):
                raise AssertionError(
                    f"new session did not bind the new Hermes source epoch: {new_binding!r}"
                )
            fresh_event = registry.queue_durable_event(
                "codex:turn:start",
                {
                    "session_id": new_session_id,
                    "attempt_id": "vhost-managed-new-epoch-attempt",
                    "model": "PRIVATE_MODEL_CANARY",
                    "cwd": "/private/repository",
                },
            )
            if (
                fresh_event is None
                or fresh_event["source_id"] != new_binding[0]
                or fresh_event["source_sequence"] != 1
            ):
                raise AssertionError(
                    f"new epoch event has unexpected identity: {fresh_event!r}"
                )
            event_ids.append(fresh_event["event_id"])
            if not await registry.emit_durable(fresh_event):
                raise AssertionError("new-epoch event did not receive its receipt")

        try:
            asyncio.run(deliver())
            explicit_binding = registry._outbox._connection.execute(
                "SELECT project_id, goal_id FROM active_goal_bindings WHERE session_id = ?",
                (event_session_id,),
            ).fetchone()
            if explicit_binding != (project_id, goal_id):
                raise AssertionError(
                    "Vhost bind command did not persist the active goal: "
                    f"{explicit_binding!r}"
                )
            report = context.call_mcp(
                "curator_v2", "goal_report", {"goal_id": goal_id}, session_id=session_id
            )
            rendered_report = json.dumps(report, ensure_ascii=False)
            if report.get("ok") is not True:
                raise AssertionError(f"Curator goal report failed: {report}")
            if (
                "Codex turn started for the explicitly bound goal"
                not in rendered_report
                or "Codex turn ended normally; no success criterion was verified"
                not in rendered_report
                or "Codex turn ended with runtime outcome: interrupted"
                not in rendered_report
                or "PRIVATE_MODEL_CANARY" in rendered_report
                or "/private/repository" in rendered_report
            ):
                raise AssertionError("Curator report did not match bounded event facts")

            before_reviewer_persist = target.read_text(encoding="utf-8")
            reviewer_persist = context.call_mcp(
                "curator_v2",
                "goal_persist",
                {
                    "goal_id": goal_id,
                    "target": ".curatormd-v2/persistence/HISTORY.md",
                },
                session_id=session_id,
            )
            if (
                reviewer_persist.get("ok") is not False
                or "forbidden" not in str(reviewer_persist.get("error"))
                or target.read_text(encoding="utf-8") != before_reviewer_persist
            ):
                raise AssertionError(
                    "write-only MCP grant bypassed the reviewer persistence boundary"
                )

            _persist_with_consumer_plugin(
                curator_python, project_root, database, goal_id
            )
            reconciliation = context.call_mcp(
                "curator_v2",
                "goal_reconcile",
                {"goal_id": goal_id, "target": ".curatormd-v2/persistence/HISTORY.md"},
                session_id=session_id,
            )
            if reconciliation.get("ok") is not True or "synced" not in str(
                reconciliation.get("result")
            ):
                raise AssertionError(
                    f"Vhost target did not reconcile: {reconciliation}"
                )

            projection = target.read_text(encoding="utf-8")
            if (
                "Codex turn started for the explicitly bound goal" not in projection
                or "Codex turn ended normally; no success criterion was verified"
                not in projection
                or "Codex turn ended with runtime outcome: interrupted"
                not in projection
                or "PRIVATE_MODEL_CANARY" in projection
                or "/private/repository" in projection
            ):
                raise AssertionError(
                    "Vhost canonical projection has unexpected contents"
                )
            if out_of_scope.read_text(encoding="utf-8") != "# Must remain unchanged\n":
                raise AssertionError("Vhost hook changed an out-of-scope target")
        finally:
            shutdown_mcp_servers()
            registry._outbox.close()

        _assert_processed_receipts(curator_python, database, event_ids)
        print(
            json.dumps(
                {
                    "result": "passed",
                    "profile": "disposable",
                    "consumer_project": project_id,
                    "hermes_managed_stdio_mcp": True,
                    "processed_events": len(event_ids),
                    "exact_replays_acknowledged": True,
                    "failed_delivery_retried": True,
                    "lost_ack_recovered_after_reenrollment": True,
                    "source_epoch_advanced_after_restart": True,
                    "explicit_goal_binding_verified": True,
                    "planned_goal_binding_rejected": True,
                    "vhost_projection_reconciled": True,
                    "private_model_and_cwd_absent": True,
                    "out_of_scope_target_unchanged": True,
                    "reviewer_mcp_persist_remains_denied": True,
                },
                sort_keys=True,
            )
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-root", type=Path, required=True)
    parser.add_argument("--curator-python", type=Path, required=True)
    args = parser.parse_args()
    run(args.hermes_root, args.curator_python)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
