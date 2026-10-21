"""Consumer-side contract check for the installed Curator V2 plugin."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from mcp import Client
from mcp.client.stdio import StdioServerParameters
from mcp.types import TextContent
from curatormd_v2 import (
    AuthenticatedCaller,
    CodexGoalBinding,
    CuratorStore,
    EventInboxStatus,
    EventEnvelope,
    GoalStarted,
    GoalStatus,
    NotFoundError,
    ProjectAccessManager,
    ProjectAction,
    ProjectAdministrationAction,
    ProjectConfig,
    ProjectPlugin,
    SuccessCriterion,
    codex_hook_to_event,
)
from curatormd_v2.testing import assert_goal_started_event_contract


class _DisposableProjectAdministrator:
    """Authorize one exact synthetic consumer registration and its grants."""

    def __init__(self, project_id: str = "vhost-manager-alpha") -> None:
        self.project_id = project_id

    def authorize_project_administration(
        self,
        caller: AuthenticatedCaller,
        project_id: str,
        action: ProjectAdministrationAction,
    ) -> bool:
        """Allow the synthetic operator to administer only its test project."""

        return (
            caller.subject_id == "vhost-alpha-test-operator"
            and project_id == self.project_id
            and action in {
                ProjectAdministrationAction.REGISTER,
                ProjectAdministrationAction.GRANT,
            }
        )


class CuratorV2ConsumerContractTests(unittest.TestCase):
    """Run the shared event/backend contract against Vhost Manager's config."""

    def test_two_installed_consumers_isolate_access_and_configured_persistence(self) -> None:
        """Bind two configs to one store without cross-project reads or writes."""

        source_root = Path(__file__).resolve().parents[2]
        source_config = source_root / ".curatormd-v2.toml"
        profile_ids = ("vhost-alpha-isolation", "consumer-two-isolation")
        project_ids = ("vhost-manager-alpha", "consumer-two-alpha")
        goal_ids = ("vhost-isolated-goal", "consumer-two-isolated-goal")
        problem_texts = (
            "Vhost isolation test project marker",
            "Second consumer isolation test project marker",
        )

        with tempfile.TemporaryDirectory(prefix="curator-v2-two-consumers-") as temp:
            base = Path(temp)
            database = base / "curator-v2.sqlite3"
            roots: list[Path] = []
            configs: list[ProjectConfig] = []
            targets: list[Path] = []
            for index, project_id in enumerate(project_ids):
                root = base / f"consumer-{index + 1}"
                for relative in (
                    "docs",
                    "vhost-manager",
                    ".curatormd-v2/staging",
                    ".curatormd-v2/persistence",
                ):
                    (root / relative).mkdir(parents=True, exist_ok=True)
                subprocess.run(
                    ["git", "init", "--quiet", str(root)],
                    check=True,
                    capture_output=True,
                    timeout=10,
                )
                config_bytes = source_config.read_bytes()
                if index:
                    config_bytes = config_bytes.replace(
                        b'project_id = "vhost-manager-alpha"',
                        f'project_id = "{project_id}"'.encode("ascii"),
                    )
                config_path = root / ".curatormd-v2.toml"
                config_path.write_bytes(config_bytes)
                config_path.chmod(0o600)
                config = ProjectConfig.load(root)
                target = config.persistence_targets[0]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("# Disposable consumer history\n", encoding="utf-8")
                roots.append(root)
                configs.append(config)
                targets.append(target)

            operator = AuthenticatedCaller("vhost-alpha-test-operator")
            store = CuratorStore(database)
            try:
                for config, profile_id in zip(configs, profile_ids, strict=True):
                    manager = ProjectAccessManager(
                        store, _DisposableProjectAdministrator(config.project_id)
                    )
                    manager.register_project(
                        operator,
                        config.project_id,
                        config.repository_fingerprint,
                        config.config_sha256,
                        config.backend_api_version,
                        "Disposable two-consumer isolation test",
                    )
                    for action in (ProjectAction.READ, ProjectAction.WRITE):
                        manager.grant(
                            operator,
                            config.project_id,
                            profile_id,
                            action,
                            "Exact disposable consumer grant",
                        )
            finally:
                store.close()

            async def exercise_launchers() -> None:
                launcher = Path(sys.executable).with_name("curatormd-v2-mcp")
                for index, (root, config, profile_id) in enumerate(
                    zip(roots, configs, profile_ids, strict=True)
                ):
                    other_index = 1 - index
                    parameters = StdioServerParameters(
                        command=str(launcher),
                        args=[
                            "--project-root", str(root),
                            "--database", str(database),
                            "--profile-id", profile_id,
                            "--allow-write",
                        ],
                        env={"PATH": os.environ.get("PATH", "")},
                        cwd=root,
                    )
                    async with Client(parameters, raise_exceptions=True) as client:
                        meta = {
                            "hermes/profile_id": profile_id,
                            "hermes/session_id": f"{profile_id}-session",
                        }
                        started = await client.call_tool(
                            "goal_start",
                            {
                                "event_id": f"{goal_ids[index]}-started",
                                "goal_id": goal_ids[index],
                                "problem": problem_texts[index],
                                "success_criteria": [
                                    {
                                        "criterion_id": "consumer-boundary",
                                        "description": (
                                            "Only this consumer can read and persist its goal"
                                        ),
                                    }
                                ],
                            },
                            meta=meta,
                        )
                        own_status = await client.call_tool(
                            "goal_status", {"goal_id": goal_ids[index]}, meta=meta
                        )
                        cross_status = await client.call_tool(
                            "goal_status", {"goal_id": goal_ids[other_index]}, meta=meta
                        )
                        self.assertFalse(started.is_error)
                        self.assertFalse(own_status.is_error)
                        self.assertTrue(cross_status.is_error)
                        self.assertNotIn(problem_texts[other_index], str(cross_status.content))
                        own_value = json.loads(own_status.content[0].text)
                        self.assertEqual(own_value["goal"]["project_id"], config.project_id)

            asyncio.run(exercise_launchers())

            store = CuratorStore(database)
            try:
                for index, config in enumerate(configs):
                    plugin = ProjectPlugin.bind(config, store)
                    result = plugin.persist_goal(goal_ids[index], targets[index])
                    self.assertEqual(result.target, targets[index])
                    projection = targets[index].read_text(encoding="utf-8")
                    self.assertIn(goal_ids[index].replace("-", r"\-"), projection)
                    self.assertIn(problem_texts[index], projection)
                    self.assertNotIn(
                        goal_ids[1 - index].replace("-", r"\-"), projection
                    )
                    self.assertNotIn(problem_texts[1 - index], projection)
                    with self.assertRaises(NotFoundError):
                        plugin.persist_goal(goal_ids[1 - index], targets[index])
            finally:
                store.close()

    def test_installed_launcher_persists_only_to_vhost_configured_target(self) -> None:
        """Exercise Vhost's actual Markdown target without touching project data."""

        source_root = Path(__file__).resolve().parents[2]
        profile_id = "vhost-manager-alpha-persistence-test"

        with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-persist-") as temp:
            root = Path(temp) / "consumer"
            for relative in ("docs", "vhost-manager"):
                (root / relative).mkdir(parents=True)
            subprocess.run(
                ["git", "init", "--quiet", str(root)],
                check=True,
                capture_output=True,
                timeout=10,
            )
            config_path = root / ".curatormd-v2.toml"
            config_path.write_bytes((source_root / ".curatormd-v2.toml").read_bytes())
            config_path.chmod(0o600)
            target_relative = ".curatormd-v2/persistence/HISTORY.md"
            target = root / target_relative
            target.parent.mkdir(parents=True)
            target.write_text("# Disposable Vhost alpha history\n", encoding="utf-8")
            (root / ".curatormd-v2" / "staging").mkdir(parents=True)
            out_of_scope = root / "persistence" / "HISTORY.md"
            out_of_scope.parent.mkdir(parents=True)
            out_of_scope.write_text("# Must remain unchanged\n", encoding="utf-8")
            config = ProjectConfig.load(root)

            database = Path(temp) / "curator-v2.sqlite3"
            store = CuratorStore(database)
            try:
                manager = ProjectAccessManager(store, _DisposableProjectAdministrator())
                operator = AuthenticatedCaller("vhost-alpha-test-operator")
                manager.register_project(
                    operator,
                    config.project_id,
                    config.repository_fingerprint,
                    config.config_sha256,
                    config.backend_api_version,
                    "Disposable Vhost configured-target test",
                )
                for action in (
                    ProjectAction.READ,
                    ProjectAction.WRITE,
                ):
                    manager.grant(
                        operator,
                        config.project_id,
                        profile_id,
                        action,
                        "Disposable Vhost configured-target test",
                    )
            finally:
                store.close()

            launcher = Path(sys.executable).with_name("curatormd-v2-mcp")
            parameters = StdioServerParameters(
                command=str(launcher),
                args=[
                    "--project-root",
                    str(root),
                    "--database",
                    str(database),
                    "--profile-id",
                    profile_id,
                    "--allow-write",
                ],
                env={"PATH": os.environ.get("PATH", "")},
                cwd=root,
            )

            async def exercise() -> None:
                async with Client(parameters, raise_exceptions=True) as client:
                    meta = {
                        "hermes/profile_id": profile_id,
                        "hermes/session_id": "vhost-persistence-test-session",
                    }
                    started = await client.call_tool(
                        "goal_start",
                        {
                            "event_id": "vhost-persistence-goal-started",
                            "goal_id": "vhost-persistence-contract-goal",
                            "problem": "Verify Vhost's configured V2 persistence adapter",
                            "success_criteria": [
                                {
                                    "criterion_id": "configured-target",
                                    "description": "Only the configured Vhost target is updated",
                                }
                            ],
                        },
                        meta=meta,
                    )
                    self.assertFalse(started.is_error)
                    activated = await client.call_tool(
                        "goal_activate",
                        {
                            "event_id": "vhost-persistence-goal-activated",
                            "goal_id": "vhost-persistence-contract-goal",
                            "reason": "Run the configured-target persistence contract",
                            "expected_lifecycle_revision": 1,
                        },
                        meta=meta,
                    )
                    self.assertFalse(activated.is_error)
                    fact = await client.call_tool(
                        "fact_record",
                        {
                            "event_id": "vhost-persistence-fact-recorded",
                            "goal_id": "vhost-persistence-contract-goal",
                            "fact_id": "vhost-persistence-contract-fact",
                            "kind": "change",
                            "bullet": "The installed Vhost launcher wrote the configured target",
                        },
                        meta=meta,
                    )
                    self.assertFalse(fact.is_error)
                    persisted = await client.call_tool(
                        "goal_persist",
                        {
                            "goal_id": "vhost-persistence-contract-goal",
                            "target": target_relative,
                        },
                        meta=meta,
                    )
                    self.assertTrue(persisted.is_error)

            asyncio.run(exercise())
            store = CuratorStore(database)
            try:
                plugin = ProjectPlugin.bind(config, store)
                persisted = plugin.persist_goal(
                    "vhost-persistence-contract-goal", target_relative
                )
                self.assertEqual(persisted.target, target)
                reconciled = plugin.reconcile_goal(
                    "vhost-persistence-contract-goal", target_relative
                )
                self.assertEqual(reconciled.status, "synced")
                with self.assertRaises(ValueError):
                    plugin.persist_goal(
                        "vhost-persistence-contract-goal", "persistence/HISTORY.md"
                    )
            finally:
                store.close()
            projection = target.read_text(encoding="utf-8")
            self.assertIn(r"vhost\-persistence\-contract\-goal", projection)
            self.assertIn(r"vhost\-manager\-alpha", projection)
            self.assertIn(
                "The installed Vhost launcher wrote the configured target",
                projection,
            )
            self.assertEqual(
                out_of_scope.read_text(encoding="utf-8"),
                "# Must remain unchanged\n",
            )

    def test_goal_started_contract_uses_vhost_config_and_disposable_store(self) -> None:
        project_root = Path(__file__).resolve().parents[2]
        config = ProjectConfig.load(project_root)
        self.assertEqual(config.project_id, "vhost-manager-alpha")

        with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-contract-") as temp:
            store = CuratorStore(Path(temp) / "curator-v2.sqlite3")
            try:
                plugin = ProjectPlugin.bind(config, store)
                event = EventEnvelope(
                    event_id="vhost-contract-goal-started",
                    project_id=config.project_id,
                    source_id="vhost-manager-contract-test",
                    source_sequence=1,
                    payload=GoalStarted(
                        goal_id="vhost-contract-goal",
                        problem="Verify Vhost Manager Curator V2 plugin compatibility",
                        success_criteria=(
                            SuccessCriterion(
                                criterion_id="contract-roundtrip",
                                description=(
                                    "The configured consumer plugin preserves the "
                                    "typed goal and discards event payload bytes"
                                ),
                            ),
                        ),
                        initial_status=GoalStatus.PLANNED,
                    ),
                )

                evidence = assert_goal_started_event_contract(
                    plugin,
                    event,
                    expected_project_id=config.project_id,
                )

                self.assertGreater(evidence.event_payload_bytes, 0)
                self.assertEqual(evidence.event_payload_bytes_retained, 0)
            finally:
                store.close()

    def test_installed_mcp_stdio_launcher_is_bound_to_vhost_config(self) -> None:
        """Run goal write, exact replay, and read through the installed launcher."""

        project_root = Path(__file__).resolve().parents[2]
        config = ProjectConfig.load(project_root)
        profile_id = "vhost-manager-alpha-test"

        with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-stdio-") as temp:
            database = Path(temp) / "curator-v2.sqlite3"
            store = CuratorStore(database)
            try:
                manager = ProjectAccessManager(store, _DisposableProjectAdministrator())
                operator = AuthenticatedCaller("vhost-alpha-test-operator")
                manager.register_project(
                    operator,
                    config.project_id,
                    config.repository_fingerprint,
                    config.config_sha256,
                    config.backend_api_version,
                    "Disposable Vhost Manager stdio contract test",
                )
                for action in (ProjectAction.READ, ProjectAction.WRITE):
                    manager.grant(
                        operator,
                        config.project_id,
                        profile_id,
                        action,
                        "Disposable stdio contract grant",
                    )
            finally:
                store.close()

            launcher = Path(sys.executable).with_name("curatormd-v2-mcp")
            self.assertTrue(launcher.is_file(), f"missing installed launcher: {launcher}")
            parameters = StdioServerParameters(
                command=str(launcher),
                args=[
                    "--project-root",
                    str(project_root),
                    "--database",
                    str(database),
                    "--profile-id",
                    profile_id,
                    "--allow-write",
                ],
                env={"PATH": os.environ.get("PATH", "")},
                cwd=project_root,
            )

            async def exercise() -> None:
                async with Client(parameters, raise_exceptions=True) as client:
                    event = {
                        "event_id": "vhost-stdio-goal-started",
                        "goal_id": "vhost-stdio-contract-goal",
                        "problem": "Verify the installed Vhost Manager Curator V2 plugin",
                        "success_criteria": [
                            {
                                "criterion_id": "stdio-binding",
                                "description": "The configured project goal is durable and replayable",
                            }
                        ],
                        "owner": "vhost-alpha-test",
                        "next_action": "Exercise the installed consumer report path",
                    }
                    meta = {
                        "hermes/profile_id": profile_id,
                        "hermes/session_id": "vhost-stdio-contract-session",
                    }
                    first = await client.call_tool("goal_start", event, meta=meta)
                    replay = await client.call_tool("goal_start", event, meta=meta)
                    status = await client.call_tool(
                        "goal_status",
                        {"goal_id": "vhost-stdio-contract-goal"},
                        meta=meta,
                    )
                    self.assertFalse(first.is_error)
                    self.assertFalse(replay.is_error)
                    self.assertFalse(status.is_error)
                    result = status.content[0]
                    self.assertIsInstance(result, TextContent)
                    value = json.loads(result.text)
                    self.assertEqual(value["goal"]["project_id"], config.project_id)
                    self.assertEqual(value["goal"]["status"], "planned")
                    self.assertEqual(
                        value["goal"]["success_criteria"][0]["criterion_id"],
                        "stdio-binding",
                    )
                    activation = await client.call_tool(
                        "goal_activate",
                        {
                            "event_id": "vhost-stdio-goal-activated",
                            "goal_id": "vhost-stdio-contract-goal",
                            "reason": "Begin the installed consumer report check",
                            "expected_lifecycle_revision": 1,
                        },
                        meta=meta,
                    )
                    fact = await client.call_tool(
                        "fact_record",
                        {
                            "event_id": "vhost-stdio-fact-recorded",
                            "goal_id": "vhost-stdio-contract-goal",
                            "fact_id": "vhost-stdio-fact",
                            "kind": "change",
                            "bullet": "The installed consumer launcher recorded a compact change fact",
                        },
                        meta=meta,
                    )
                    finish = await client.call_tool(
                        "goal_finish",
                        {
                            "event_id": "vhost-stdio-goal-finished",
                            "goal_id": "vhost-stdio-contract-goal",
                            "completion_claim": "Check the installed consumer outcome report",
                            "expected_lifecycle_revision": 2,
                        },
                        meta=meta,
                    )
                    report = await client.call_tool(
                        "goal_report",
                        {"goal_id": "vhost-stdio-contract-goal"},
                        meta=meta,
                    )
                    activation_result = json.loads(activation.content[0].text)
                    fact_result = json.loads(fact.content[0].text)
                    finish_result = json.loads(finish.content[0].text)
                    self.assertFalse(fact.is_error)
                    self.assertEqual(activation_result["status"], "processed")
                    self.assertEqual(fact_result["status"], "processed")
                    self.assertEqual(finish_result["status"], "processed")
                    self.assertFalse(report.is_error)
                    report_content = report.content[0]
                    self.assertIsInstance(report_content, TextContent)
                    self.assertIn("- Project: `vhost-manager-alpha`", report_content.text)
                    self.assertIn("owner: vhost-alpha-test", report_content.text)
                    self.assertIn("The installed consumer launcher recorded a compact change fact", report_content.text)
                    self.assertIn(
                        "goal next action: Verify unmet success criteria: The configured project goal is durable and replayable",
                        report_content.text,
                    )
                    self.assertIn("- Outcome: `open`", report_content.text)
                    self.assertIn("Outcome: open", report_content.text)
                    self.assertIn("lacks passing evidence", report_content.text)

            asyncio.run(exercise())

    def test_installed_router_processes_only_the_configured_vhost_project(self) -> None:
        """The packaged one-shot router leaves other projects' events pending."""

        project_root = Path(__file__).resolve().parents[2]
        config = ProjectConfig.load(project_root)

        with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-router-") as temp:
            database = Path(temp) / "curator-v2.sqlite3"
            store = CuratorStore(database)
            try:
                for project_id, event_id, goal_id in (
                    (
                        config.project_id,
                        "vhost-router-bound-event",
                        "vhost-router-bound-goal",
                    ),
                    (
                        "another-project",
                        "vhost-router-unbound-event",
                        "vhost-router-unbound-goal",
                    ),
                ):
                    store.ingest_event(
                        EventEnvelope(
                            event_id,
                            project_id,
                            GoalStarted(
                                goal_id,
                                f"Route the event for {project_id}",
                                (
                                    SuccessCriterion(
                                        "routed", "The configured project event is processed"
                                    ),
                                ),
                                initial_status=GoalStatus.ACTIVE,
                            ),
                        )
                    )
            finally:
                store.close()

            router = Path(sys.executable).with_name("curatormd-v2-router")
            self.assertTrue(router.is_file(), f"missing installed router: {router}")
            result = subprocess.run(
                [
                    str(router),
                    "--database",
                    str(database),
                    "--project-root",
                    str(project_root),
                    "--route-events",
                ],
                capture_output=True,
                check=False,
                cwd=project_root,
                env={"PATH": os.environ.get("PATH", "")},
                timeout=15,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            self.assertEqual(summary["processed"], 1)
            self.assertEqual(summary["pending"], 0)
            self.assertEqual(summary["project_count"], 1)

            store = CuratorStore(database)
            try:
                bound = store.event_receipt(
                    config.project_id, "vhost-router-bound-event"
                )
                unbound = store.event_receipt(
                    "another-project", "vhost-router-unbound-event"
                )
                self.assertEqual(bound.status, EventInboxStatus.PROCESSED)
                self.assertEqual(unbound.status, EventInboxStatus.RECEIVED)
                self.assertEqual(unbound.attempts, 0)
            finally:
                store.close()

    def test_hermes_hook_routes_only_bounded_project_events_and_waits_for_receipt(self) -> None:
        """The consumer hook uses managed MCP and acknowledges durable receipts only."""

        project_root = Path(__file__).resolve().parents[2]
        config = ProjectConfig.load(project_root)
        hook_path = (
            project_root
            / "vhost-manager"
            / "curatormd-v2"
            / "hermes_hook"
            / "handler.py"
        )
        spec = importlib.util.spec_from_file_location("vhost_curator_v2_hook", hook_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader if spec is not None else None)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.PROJECT_ID, config.project_id)

        class _ManagedMcpContext:
            def __init__(self) -> None:
                self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
                self.receipt: str = "processed"
                self.binding: str = "bound"

            def call_mcp(self, *args: object, **kwargs: object) -> dict[str, object]:
                self.calls.append((args, kwargs))
                if len(args) >= 2 and args[1] == "hermes_goal_bind":
                    return {
                        "ok": True,
                        "result": '{"binding":"validated","project_id":"vhost-manager-alpha"}',
                        "hermes_goal_binding": self.binding,
                    }
                return {"ok": True, "result": {"receipt": {"status": self.receipt}}}

        async def exercise() -> None:
            context = _ManagedMcpContext()
            hook_event = {
                "project_id": config.project_id,
                "goal_id": "vhost-hook-goal",
                "event_id": "vhost-hook-event",
                "source_sequence": 1,
                "occurred_at": "2026-10-20T08:00:00+00:00",
                "session_id": "vhost-hook-session",
                "attempt_id": "vhost-hook-attempt",
                "turn_id": "vhost-hook-turn",
                "prompt": "must not be forwarded",
                "response": "must not be forwarded",
                "failure_detail": "must not be forwarded",
            }

            self.assertIs(
                await module.handle("codex:turn:end", hook_event, ctx=context),
                True,
            )
            self.assertEqual(len(context.calls), 1)
            args, kwargs = context.calls[0]
            self.assertEqual(args[:2], ("curator_v2", "hermes_codex_event"))
            self.assertEqual(kwargs["session_id"], "vhost-hook-session")
            self.assertIs(kwargs["hermes_durable_event"], True)
            payload = args[2]
            self.assertIsInstance(payload, dict)
            self.assertEqual(
                set(payload["context"]),  # type: ignore[index]
                {"attempt_id", "session_id", "turn_id"},
            )
            self.assertNotIn("prompt", payload)  # type: ignore[operator]
            self.assertNotIn("response", payload)  # type: ignore[operator]
            self.assertNotIn("failure_detail", payload)  # type: ignore[operator]

            bind_context = {
                "session_id": "vhost-explicit-bind-session",
                "message": "curator-v2 bind vhost-active-goal",
            }
            self.assertIs(
                await module.handle("agent:start", bind_context, ctx=context), True
            )
            bind_args, bind_kwargs = context.calls[-1]
            self.assertEqual(bind_args[:2], ("curator_v2", "hermes_goal_bind"))
            self.assertEqual(bind_args[2], {"goal_id": "vhost-active-goal"})
            self.assertEqual(
                bind_kwargs,
                {"timeout": 30, "session_id": "vhost-explicit-bind-session"},
            )
            self.assertNotIn("message", bind_args[2])
            malformed_bind = {
                "session_id": "vhost-explicit-bind-session",
                "message": "curator-v2 bind vhost-active-goal with extra text",
            }
            before_malformed = len(context.calls)
            self.assertIs(
                await module.handle("agent:start", malformed_bind, ctx=context), None
            )
            self.assertEqual(len(context.calls), before_malformed)
            context.binding = "not_recorded"
            self.assertIs(
                await module.handle("agent:start", bind_context, ctx=context), False
            )

            context.receipt = "duplicate"
            self.assertIs(
                await module.handle("codex:turn:end", hook_event, ctx=context),
                True,
            )
            context.receipt = "queued"
            self.assertIs(
                await module.handle("codex:turn:end", hook_event, ctx=context),
                False,
            )
            foreign_event = {**hook_event, "project_id": "another-project"}
            before = len(context.calls)
            self.assertIs(
                await module.handle("codex:turn:end", foreign_event, ctx=context),
                None,
            )
            self.assertEqual(len(context.calls), before)

        asyncio.run(exercise())

    def test_vhost_hook_delivers_through_installed_mcp_and_acknowledges_receipt(self) -> None:
        """Exercise the consumer hook, installed launcher, and durable receipt together."""

        project_root = Path(__file__).resolve().parents[2]
        config = ProjectConfig.load(project_root)
        profile_id = "vhost-manager-alpha-e2e-test"
        session_id = "vhost-alpha-e2e-session"
        goal_id = "vhost-alpha-e2e-goal"
        hook_path = (
            project_root
            / "vhost-manager"
            / "curatormd-v2"
            / "hermes_hook"
            / "handler.py"
        )
        spec = importlib.util.spec_from_file_location("vhost_curator_v2_e2e_hook", hook_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader if spec is not None else None)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-hook-e2e-") as temp:
            database = Path(temp) / "curator-v2.sqlite3"
            store = CuratorStore(database)
            try:
                manager = ProjectAccessManager(store, _DisposableProjectAdministrator())
                operator = AuthenticatedCaller("vhost-alpha-test-operator")
                manager.register_project(
                    operator,
                    config.project_id,
                    config.repository_fingerprint,
                    config.config_sha256,
                    config.backend_api_version,
                    "Disposable Vhost Manager hook end-to-end test",
                )
                for action in (ProjectAction.READ, ProjectAction.WRITE):
                    manager.grant(
                        operator,
                        config.project_id,
                        profile_id,
                        action,
                        "Disposable hook end-to-end grant",
                    )
            finally:
                store.close()

            launcher = Path(sys.executable).with_name("curatormd-v2-mcp")
            self.assertTrue(launcher.is_file(), f"missing installed launcher: {launcher}")
            parameters = StdioServerParameters(
                command=str(launcher),
                args=[
                    "--project-root",
                    str(project_root),
                    "--database",
                    str(database),
                    "--profile-id",
                    profile_id,
                    "--allow-write",
                ],
                env={"PATH": os.environ.get("PATH", "")},
                cwd=project_root,
            )
            prompt_canary = "VHOST_PROMPT_CANARY_MUST_NOT_PERSIST"
            response_canary = "VHOST_RESPONSE_CANARY_MUST_NOT_PERSIST"
            event_ids: list[str] = []

            async def exercise() -> None:
                async with Client(parameters, raise_exceptions=True) as client:
                    meta = {
                        "hermes/profile_id": profile_id,
                        "hermes/session_id": session_id,
                    }
                    started = await client.call_tool(
                        "goal_start",
                        {
                            "event_id": "vhost-hook-e2e-goal-start",
                            "goal_id": goal_id,
                            "problem": "Verify the installed Vhost hook route",
                            "success_criteria": [
                                {
                                    "criterion_id": "receipt",
                                    "description": "The bounded hook event has a durable receipt",
                                }
                            ],
                            "source_sequence": 1,
                        },
                        meta=meta,
                    )
                    self.assertFalse(started.is_error)
                    activated = await client.call_tool(
                        "goal_activate",
                        {
                            "event_id": "vhost-hook-e2e-goal-activate",
                            "goal_id": goal_id,
                            "reason": "Accepted for the isolated alpha integration test",
                            "expected_lifecycle_revision": 1,
                            "source_sequence": 2,
                        },
                        meta=meta,
                    )
                    self.assertFalse(activated.is_error)
                    bound = await client.call_tool(
                        "hermes_goal_bind", {"goal_id": goal_id}, meta=meta
                    )
                    self.assertFalse(bound.is_error)

                    source_id = "hermes-" + hashlib.sha256(
                        f"{profile_id}\0{config.project_id}".encode("utf-8")
                    ).hexdigest()
                    binding = CodexGoalBinding(
                        profile_id=profile_id,
                        project_id=config.project_id,
                        session_id=session_id,
                        goal_id=goal_id,
                        source_id=source_id,
                    )
                    attempt_context = {
                        "attempt_id": "vhost-alpha-e2e-attempt",
                        "session_id": session_id,
                    }
                    end_context = {
                        **attempt_context,
                        "turn_id": "vhost-alpha-e2e-turn",
                        "outcome": "completed",
                    }
                    start_event = codex_hook_to_event(
                        "codex:turn:start",
                        attempt_context,
                        binding,
                        source_sequence=1,
                        occurred_at="2026-10-20T07:59:00+00:00",
                    )
                    end_event = codex_hook_to_event(
                        "codex:turn:end",
                        end_context,
                        binding,
                        source_sequence=2,
                        occurred_at="2026-10-20T08:00:00+00:00",
                    )
                    event_ids.extend((start_event.event_id, end_event.event_id))
                    start_hook_event = {
                        **attempt_context,
                        "project_id": config.project_id,
                        "goal_id": goal_id,
                        "event_id": start_event.event_id,
                        "source_sequence": 1,
                        "occurred_at": "2026-10-20T07:59:00+00:00",
                        "prompt": prompt_canary,
                        "response": response_canary,
                    }
                    end_hook_event = {
                        **end_context,
                        "project_id": config.project_id,
                        "goal_id": goal_id,
                        "event_id": end_event.event_id,
                        "source_sequence": 2,
                        "occurred_at": "2026-10-20T08:00:00+00:00",
                        "prompt": prompt_canary,
                        "response": response_canary,
                        "failure_detail": "VHOST_FAILURE_CANARY_MUST_NOT_PERSIST",
                    }

                    class _ManagedMcpBridge:
                        """Adapt Hermes' synchronous capability to the real stdio client."""

                        def __init__(self) -> None:
                            self.loop = asyncio.get_running_loop()
                            self.calls = 0

                        def call_mcp(
                            self,
                            server_name: str,
                            tool_name: str,
                            arguments: dict[str, object],
                            **kwargs: object,
                        ) -> dict[str, object]:
                            self.calls += 1
                            if server_name != "curator_v2" or tool_name != "hermes_codex_event":
                                return {"ok": False, "truncated": False}
                            if (
                                kwargs.get("session_id") != session_id
                                or kwargs.get("hermes_durable_event") is not True
                            ):
                                return {"ok": False, "truncated": False}
                            request_meta = {
                                "hermes/profile_id": profile_id,
                                "hermes/session_id": session_id,
                                "hermes/durable_event": True,
                            }
                            pending = asyncio.run_coroutine_threadsafe(
                                client.call_tool(
                                    tool_name,
                                    arguments,
                                    meta=request_meta,
                                ),
                                self.loop,
                            )
                            result = pending.result(timeout=30)
                            if result.is_error or not result.content:
                                return {"ok": False, "truncated": False}
                            first = result.content[0]
                            if not isinstance(first, TextContent):
                                return {"ok": False, "truncated": False}
                            return {
                                "ok": True,
                                "truncated": False,
                                "result": json.loads(first.text),
                            }

                    bridge = _ManagedMcpBridge()
                    self.assertIs(
                        await module.handle(
                            "codex:turn:start", start_hook_event, ctx=bridge
                        ),
                        True,
                    )
                    self.assertIs(
                        await module.handle(
                            "codex:turn:start", start_hook_event, ctx=bridge
                        ),
                        True,
                    )
                    self.assertIs(
                        await module.handle("codex:turn:end", end_hook_event, ctx=bridge),
                        True,
                    )
                    self.assertIs(
                        await module.handle("codex:turn:end", end_hook_event, ctx=bridge),
                        True,
                    )
                    self.assertEqual(bridge.calls, 4)
                    status = await client.call_tool(
                        "goal_status", {"goal_id": goal_id}, meta=meta
                    )
                    self.assertFalse(status.is_error)
                    status_content = status.content[0]
                    self.assertIsInstance(status_content, TextContent)
                    status_value = json.loads(status_content.text)
                    self.assertEqual(
                        {fact["kind"] for fact in status_value["facts"]},
                        {"intent", "change"},
                    )
                    self.assertNotIn(prompt_canary, status_content.text)
                    self.assertNotIn(response_canary, status_content.text)

            asyncio.run(exercise())

            store = CuratorStore(database)
            try:
                self.assertEqual(len(event_ids), 2)
                for event_id in event_ids:
                    receipt = store.event_receipt(config.project_id, event_id)
                    self.assertEqual(receipt.status, EventInboxStatus.PROCESSED)
            finally:
                store.close()
            for path in (database, Path(f"{database}-wal"), Path(f"{database}-shm")):
                if path.is_file():
                    contents = path.read_bytes()
                    self.assertNotIn(prompt_canary.encode(), contents, str(path))
                    self.assertNotIn(response_canary.encode(), contents, str(path))
                    self.assertNotIn(
                        b"VHOST_FAILURE_CANARY_MUST_NOT_PERSIST", contents, str(path)
                    )


if __name__ == "__main__":
    unittest.main()
