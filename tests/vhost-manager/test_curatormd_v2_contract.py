"""Consumer-side contract check for the installed Curator V2 plugin."""

from __future__ import annotations

import asyncio
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from mcp import Client
from mcp.client.stdio import StdioServerParameters
from mcp.types import TextContent
from curatormd_v2 import (
    AuthenticatedCaller,
    CodexGoalBinding,
    CuratorStore,
    EventInboxStatus,
    EventEnvelope,
    FactKind,
    GoalStarted,
    GoalStatus,
    NotFoundError,
    ProjectAccessManager,
    ProjectAction,
    ProjectAdministrationAction,
    ProjectConfig,
    ProjectRegistrationRequest,
    ProjectPlugin,
    SuccessCriterion,
    codex_hook_to_event,
)
from curatormd_v2.testing import assert_goal_started_event_contract


LOCAL_SUBJECT_ID = f"local-uid:{os.geteuid()}"


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
                        ProjectRegistrationRequest.from_project_config(
                            config, "Disposable two-consumer isolation test"
                        ),
                    )
                    for action in (ProjectAction.READ, ProjectAction.WRITE):
                        manager.grant(
                            operator,
                            config.project_id,
                            LOCAL_SUBJECT_ID,
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
                    ProjectRegistrationRequest.from_project_config(
                        config, "Disposable Vhost configured-target test"
                    ),
                )
                for action in (
                    ProjectAction.READ,
                    ProjectAction.WRITE,
                ):
                    manager.grant(
                        operator,
                        config.project_id,
                        LOCAL_SUBJECT_ID,
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
                manager = ProjectAccessManager(
                    store, _DisposableProjectAdministrator(config.project_id)
                )
                manager.register_project(
                    AuthenticatedCaller("vhost-alpha-test-operator"),
                    ProjectRegistrationRequest.from_project_config(
                        config, "Disposable Vhost event contract registration"
                    ),
                )
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
                    ProjectRegistrationRequest.from_project_config(
                        config, "Disposable Vhost Manager stdio contract test"
                    ),
                )
                for action in (ProjectAction.READ, ProjectAction.WRITE):
                    manager.grant(
                        operator,
                        config.project_id,
                        LOCAL_SUBJECT_ID,
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
                manager = ProjectAccessManager(
                    store, _DisposableProjectAdministrator(config.project_id)
                )
                manager.register_project(
                    AuthenticatedCaller("vhost-alpha-test-operator"),
                    ProjectRegistrationRequest.from_project_config(
                        config, "Disposable Vhost router contract registration"
                    ),
                )
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

    def test_vhost_apply_route_persists_and_retries_exact_curator_receipt(self) -> None:
        """Apply writes a durable operation first, then records/retries its V2 event."""

        source_root = Path(__file__).resolve().parents[2]
        config = ProjectConfig.load(source_root)
        launcher = Path(sys.executable).with_name("curatormd-v2-mcp")
        helper = source_root / "vhost-manager/curatormd-v2/apply_bridge.py"
        script_result_helper = source_root / "vhost-manager/curatormd-v2/script_result_bridge.py"
        cron_bridge = source_root / "vhost-manager/curatormd-v2/acme_cron_bridge.sh"
        profile_id = "vhost-alpha-route-contract"

        with tempfile.TemporaryDirectory(prefix="vhost-curator-v2-route-") as temp:
            base = Path(temp)
            fixture_root = base / "vhost-fixture"
            fixture_root.mkdir()
            ols_main = fixture_root / "usr/local/lsws/conf/httpd_config.conf"
            ols_main.parent.mkdir(parents=True)
            ols_main.write_text(
                "listener Default {\n  address *:8088\n}\n",
                encoding="utf-8",
            )
            database = base / "curator-v2.sqlite3"
            store = CuratorStore(database)
            try:
                manager = ProjectAccessManager(
                    store, _DisposableProjectAdministrator(config.project_id)
                )
                manager.register_project(
                    AuthenticatedCaller("vhost-alpha-test-operator"),
                    ProjectRegistrationRequest.from_project_config(
                        config, "Disposable Vhost apply-route receipt test"
                    ),
                )
                for action in (ProjectAction.READ, ProjectAction.WRITE):
                    manager.grant(
                        AuthenticatedCaller("vhost-alpha-test-operator"),
                        config.project_id,
                        LOCAL_SUBJECT_ID,
                        action,
                        "Disposable Vhost apply-route event grant",
                    )
            finally:
                store.close()

            with socket.socket() as port_socket:
                port_socket.bind(("127.0.0.1", 0))
                port = port_socket.getsockname()[1]

            def server_env(curator_command: Path, renewal_result: str) -> dict[str, str]:
                return {
                    **os.environ,
                    "VHOST_MANAGER_TEST_MODE": "1",
                    "VHOST_MANAGER_TEST_SSL_RENEWAL": renewal_result,
                    "VHOST_MANAGER_TEST_FAIL_APPLY_DOMAIN": "failapply-curator.test",
                    "VHOST_MANAGER_FIXTURE_ROOT": str(fixture_root),
                    "VHOST_MANAGER_PORT": str(port),
                    "CURATOR_V2_BRIDGE_PYTHON": sys.executable,
                    "CURATOR_V2_MCP_COMMAND": str(curator_command),
                    "CURATOR_V2_DATABASE": str(database),
                    "CURATOR_V2_PROJECT_ROOT": str(source_root),
                    "CURATOR_V2_PROFILE_ID": profile_id,
                    "CURATOR_V2_UID": str(os.geteuid()),
                    "CURATOR_V2_GID": str(os.getegid()),
                    "CURATOR_V2_HOME": os.environ.get("HOME", str(Path.home())),
                }

            def start_server(
                curator_command: Path, renewal_result: str
            ) -> subprocess.Popen[str]:
                process = subprocess.Popen(
                    ["node", str(source_root / "vhost-manager/server/index.cjs")],
                    cwd=source_root,
                    env=server_env(curator_command, renewal_result),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        detail = process.stderr.read() if process.stderr else ""
                        self.fail(f"Vhost test server exited early: {detail}")
                    try:
                        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                        connection.request("GET", "/api/session", headers={"Host": f"127.0.0.1:{port}"})
                        response = connection.getresponse()
                        payload = json.loads(response.read())
                        connection.close()
                        if response.status == 200:
                            return process
                    except OSError:
                        time.sleep(0.05)
                process.terminate()
                self.fail("Vhost test server did not start")
                raise AssertionError("unreachable")

            def request(
                method: str,
                route: str,
                payload: dict[str, object] | None = None,
                expected_status: tuple[int, ...] = (200, 202),
            ) -> dict[str, object]:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
                headers = {"Host": f"127.0.0.1:{port}"}
                body = None
                if method == "POST":
                    headers["Content-Type"] = "application/json"
                    headers["Origin"] = f"http://127.0.0.1:{port}"
                    headers["X-CSRF-Token"] = csrf
                    body = json.dumps(payload or {})
                connection.request(method, route, body=body, headers=headers)
                response = connection.getresponse()
                result = json.loads(response.read())
                connection.close()
                self.assertIn(response.status, expected_status, result)
                return result

            first_server = start_server(base / "unavailable-curator-mcp", "completed")
            try:
                csrf = str(request("GET", "/api/session")["csrf"])
                acme_home = base / "acme-home"
                acme_home.mkdir()
                pending_dir = base / "pending-cron"
                fake_acme = base / "fake-acme.sh"
                fake_acme.write_text(
                    "#!/bin/sh\nprintf '%s\\n' 'CRON_TRANSIENT_CANARY'\n"
                    "printf '%s\\n' 'CRON_TRANSIENT_CANARY' >&2\nexit 23\n",
                    encoding="utf-8",
                )
                fake_acme.chmod(0o755)
                cron_env = {
                    **os.environ,
                    "ACME_BIN": str(fake_acme),
                    "ACME_HOME": str(acme_home),
                    "PENDING_DIR": str(pending_dir),
                    "VHOST_MANAGER_URL": f"http://127.0.0.1:{port}",
                    "VHOST_MANAGER_HOST": f"127.0.0.1:{port}",
                    "CURL_BIN": shutil.which("curl") or "/usr/bin/curl",
                    "PYTHON_BIN": sys.executable,
                    "LOGGER_BIN": "/usr/bin/true",
                }
                with socket.socket() as unavailable_socket:
                    unavailable_socket.bind(("127.0.0.1", 0))
                    unavailable_port = unavailable_socket.getsockname()[1]
                unavailable_run = subprocess.run(
                    ["bash", str(cron_bridge)],
                    capture_output=True,
                    check=False,
                    cwd=source_root,
                    env={
                        **cron_env,
                        "VHOST_MANAGER_URL": f"http://127.0.0.1:{unavailable_port}",
                        "VHOST_MANAGER_HOST": f"127.0.0.1:{unavailable_port}",
                    },
                    timeout=15,
                    text=True,
                )
                self.assertEqual(unavailable_run.returncode, 23)
                queued_before_recovery = list(pending_dir.glob("*.json"))
                self.assertEqual(len(queued_before_recovery), 1)
                self.assertEqual(queued_before_recovery[0].stat().st_mode & 0o777, 0o600)
                cron_result = subprocess.run(
                    ["bash", str(cron_bridge)],
                    capture_output=True,
                    check=False,
                    cwd=source_root,
                    env=cron_env,
                    timeout=15,
                    text=True,
                )
                self.assertEqual(cron_result.returncode, 23)
                self.assertNotIn("CRON_TRANSIENT_CANARY", cron_result.stdout)
                self.assertNotIn("CRON_TRANSIENT_CANARY", cron_result.stderr)
                self.assertEqual(list(pending_dir.glob("*.json")), [])
                cron_operations = [
                    item
                    for item in request("GET", "/api/history")["history"]
                    if item["kind"] == "ssl-cron"
                ]
                self.assertEqual(len(cron_operations), 2)
                for cron_operation in cron_operations:
                    self.assertEqual(cron_operation["state"], "failed")
                    self.assertEqual(cron_operation["exitCode"], 23)
                    self.assertEqual(cron_operation["curatorV2"]["status"], "pending")
                cron_operation_ids = [str(item["id"]) for item in cron_operations]
                reset = request("POST", "/api/plan/reset", {})["plan"]
                archived = request(
                    "POST", "/api/archive/examples", {"planId": reset["id"]}
                )
                archive_operation = archived["operation"]
                self.assertEqual(archive_operation["kind"], "archive")
                self.assertEqual(archive_operation["state"], "archived")
                self.assertEqual(archived["curatorV2"]["status"], "pending")
                archive_operation_id = str(archive_operation["id"])
                preview = request(
                    "POST", "/api/plan/site", {"domain": "curator-smoke.test"}
                )
                plan = preview["plan"]
                self.assertEqual(
                    plan["curatorV2Goal"],
                    {
                        "problem": f"{plan['title']}: {plan['summary']}",
                        "success_criteria": [
                            {
                                "criterion_id": "nginx_valid",
                                "description": "The generated Nginx configuration passes validation.",
                            },
                            {
                                "criterion_id": "ols_valid",
                                "description": "The generated OpenLiteSpeed configuration passes validation.",
                            },
                            {
                                "criterion_id": "site_reachable",
                                "description": "The configured site returns a navigable response after reload.",
                            },
                            {
                                "criterion_id": "human_review",
                                "description": "A human reviews this Vhost Manager operation outcome.",
                            },
                        ],
                    },
                )
                static_preview = request(
                    "POST",
                    "/api/plan/site",
                    {
                        "domain": "curator-static-smoke.test",
                        "requestMode": "static",
                    },
                )["plan"]
                self.assertEqual(
                    [
                        item["criterion_id"]
                        for item in static_preview["curatorV2Goal"]["success_criteria"]
                    ],
                    ["nginx_valid", "site_reachable", "human_review"],
                )
                self.assertIn("Nginx static-file config", static_preview["summary"])
                self.assertNotIn("OpenLiteSpeed", static_preview["summary"])
                self.assertNotIn("PHP", static_preview["summary"])
                applied = request(
                    "POST",
                    "/api/apply",
                    {"planId": plan["id"], "confirmation": plan["confirmation"]},
                )
                operation = applied["operation"]
                self.assertEqual(operation["state"], "applied")
                self.assertEqual(operation["kind"], "site")
                self.assertEqual(operation["domain"], "curator-smoke.test")
                self.assertTrue(operation["files"])
                self.assertTrue(all(Path(item).is_file() for item in operation["files"]))
                self.assertEqual(applied["curatorV2"]["status"], "pending")
                operation_id = str(operation["id"])
                renewal = request(
                    "POST", "/api/ssl-renew", {"domain": "curator-smoke.test"}
                )["job"]
                self.assertEqual(renewal["status"], "completed")
                self.assertEqual(renewal["exitCode"], 0)
                self.assertEqual(renewal["curatorV2"]["status"], "pending")
                renewal_id = str(renewal["id"])
                in_progress_renewal = request(
                    "POST",
                    "/api/ssl-renew",
                    {
                        "domain": "curator-smoke.test",
                        "testOutcome": "running",
                    },
                )["job"]
                self.assertEqual(in_progress_renewal["status"], "running")
                in_progress_renewal_id = str(in_progress_renewal["id"])
                running_record = next(
                    item
                    for item in request("GET", "/api/history")["history"]
                    if item["id"] == in_progress_renewal_id
                )
                self.assertEqual(running_record["state"], "running")
                failed_apply_preview = request(
                    "POST",
                    "/api/plan/site",
                    {"domain": "failapply-curator.test"},
                )["plan"]
                failed_apply_response = request(
                    "POST",
                    "/api/apply",
                    {
                        "planId": failed_apply_preview["id"],
                        "confirmation": failed_apply_preview["confirmation"],
                    },
                    expected_status=(400,),
                )
                failed_apply = failed_apply_response["operation"]
                self.assertEqual(failed_apply["state"], "failed")
                self.assertEqual(failed_apply_response["curatorV2"]["status"], "pending")
                failed_apply_id = str(failed_apply["id"])
            finally:
                first_server.terminate()
                first_server.wait(timeout=5)

            second_server = start_server(launcher, "vary")
            try:
                csrf = str(request("GET", "/api/session")["csrf"])
                script_producers = [
                    "manual_dns_renewal",
                    "domain_batch_renewal",
                    "domain_inventory_refresh",
                    "nginx_vhost_setup",
                ]
                script_operation_ids: list[str] = []
                script_pending = base / "pending-script-results"
                for index, producer_id in enumerate(script_producers):
                    script_operation_id = str(uuid.uuid4())
                    script_operation_ids.append(script_operation_id)
                    script_env = {
                        **os.environ,
                        "CURATOR_V2_SCRIPT_PENDING_DIR": str(script_pending),
                        "DNS_TRANSIENT_CANARY": "must-not-be-sent",
                        "VHOST_MANAGER_URL": f"http://127.0.0.1:{port}",
                        "VHOST_MANAGER_HOST": f"127.0.0.1:{port}",
                    }
                    if index == 0:
                        script_env["VHOST_MANAGER_URL"] = f"http://127.0.0.1:{unavailable_port}"
                        script_env["VHOST_MANAGER_HOST"] = f"127.0.0.1:{unavailable_port}"
                    script_result = subprocess.run(
                        [
                            sys.executable,
                            str(script_result_helper),
                            producer_id,
                            script_operation_id,
                            str(index),
                        ],
                        capture_output=True,
                        check=False,
                        cwd=source_root,
                        env=script_env,
                        timeout=20,
                        text=True,
                    )
                    if index == 0:
                        self.assertEqual(script_result.returncode, 1, script_result.stderr)
                        queued = list(script_pending.glob("*.json"))
                        self.assertEqual(len(queued), 1)
                        self.assertNotIn("must-not-be-sent", queued[0].read_text())
                        script_env["VHOST_MANAGER_URL"] = f"http://127.0.0.1:{port}"
                        script_env["VHOST_MANAGER_HOST"] = f"127.0.0.1:{port}"
                        retry = subprocess.run(
                            [
                                sys.executable,
                                str(script_result_helper),
                                producer_id,
                                script_operation_id,
                                str(index),
                            ],
                            capture_output=True,
                            check=False,
                            cwd=source_root,
                            env=script_env,
                            timeout=20,
                            text=True,
                        )
                        self.assertEqual(retry.returncode, 0, retry.stderr)
                    else:
                        self.assertEqual(script_result.returncode, 0, script_result.stderr)
                self.assertEqual(list(script_pending.glob("*.json")), [])
                request(
                    "POST",
                    "/api/script-result",
                    {
                        "producerId": "domain_batch_renewal",
                        "operationId": script_operation_ids[0],
                        "exitCode": 0,
                    },
                    expected_status=(409,),
                )
                utility_bin = base / "utility-bin"
                utility_bin.mkdir()
                fake_timeout = utility_bin / "timeout"
                fake_timeout.write_text(
                    "#!/bin/sh\nshift\nexec \"$@\"\n", encoding="utf-8"
                )
                fake_timeout.chmod(0o755)
                fake_openssl = utility_bin / "openssl"
                fake_openssl.write_text(
                    "#!/bin/sh\n"
                    "if [ \"$1\" = s_client ]; then printf 'fixture certificate\\n'; exit 0; fi\n"
                    "case \" $* \" in\n"
                    "  *' -out '*) while [ $# -gt 0 ]; do if [ \"$1\" = -out ]; then shift; printf 'fixture certificate\\n' > \"$1\"; exit 0; fi; shift; done ;;\n"
                    "  *' -enddate '*) echo 'notAfter=Jul  1 00:00:00 2027 GMT' ;;\n"
                    "  *' -issuer '*) echo \"issuer=Let's Encrypt\" ;;\n"
                    "  *' -checkhost '*) exit 0 ;;\n"
                    "  *' -text '*) printf 'X509v3 Subject Alternative Name:\\n DNS:example.test, DNS:www.example.test\\nid-ecPublicKey\\n' ;;\n"
                    "  *) exit 1 ;;\n"
                    "esac\n",
                    encoding="utf-8",
                )
                fake_openssl.chmod(0o755)
                source_inventory = base / "source-inventory.md"
                source_inventory.write_text("example.test\n", encoding="utf-8")
                generated_inventory = base / "generated-inventory.md"
                generated_inventory_result = subprocess.run(
                    [
                        "bash",
                        str(source_root / "update_domain_inventory.sh"),
                        "--source",
                        str(source_inventory),
                        "--output",
                        str(generated_inventory),
                        "--nginx-dir",
                        str(base / "nginx-enabled"),
                    ],
                    capture_output=True,
                    check=False,
                    cwd=source_root,
                    env={
                        **os.environ,
                        "PATH": f"{utility_bin}:{os.environ.get('PATH', '')}",
                        "CURATOR_V2_SCRIPT_PENDING_DIR": str(script_pending),
                        "VHOST_MANAGER_URL": f"http://127.0.0.1:{port}",
                        "VHOST_MANAGER_HOST": f"127.0.0.1:{port}",
                    },
                    timeout=20,
                    text=True,
                )
                self.assertEqual(
                    generated_inventory_result.returncode,
                    0,
                    generated_inventory_result.stderr,
                )
                self.assertTrue(generated_inventory.is_file())
                self.assertIn("example.test", generated_inventory.read_text())
                updater_operation = next(
                    item
                    for item in request("GET", "/api/history")["history"]
                    if item.get("producerId") == "domain_inventory_refresh"
                )
                script_operation_ids.append(str(updater_operation["id"]))
                recovered_renewal = next(
                    item
                    for item in request("GET", "/api/history")["history"]
                    if item["id"] == in_progress_renewal_id
                )
                self.assertEqual(recovered_renewal["state"], "interrupted")
                self.assertEqual(recovered_renewal["curatorV2"]["status"], "received")
                pending_apply = next(
                    item
                    for item in request("GET", "/api/history")["history"]
                    if item["id"] == operation_id
                )
                self.assertEqual(
                    pending_apply["curatorRequest"],
                    {
                        "problem": f"{plan['title']}: {plan['summary']}",
                        "criterion_ids": [
                            "nginx_valid",
                            "ols_valid",
                            "site_reachable",
                            "human_review",
                        ],
                    },
                )
                recovered_retry = request(
                    "POST",
                    "/api/curator/retry",
                    {"operationId": in_progress_renewal_id},
                )
                recovered_receipt = recovered_retry["curatorV2"]
                self.assertEqual(recovered_receipt["project_id"], config.project_id)
                self.assertEqual(
                    recovered_receipt["event_id"],
                    f"vhost-ssl-renew-{in_progress_renewal_id}",
                )
                self.assertEqual(recovered_receipt["status"], "received")
                failed_apply_retry = request(
                    "POST",
                    "/api/curator/retry",
                    {"operationId": failed_apply_id},
                )
                failed_apply_receipt = failed_apply_retry["curatorV2"]
                self.assertEqual(failed_apply_receipt["project_id"], config.project_id)
                self.assertEqual(
                    failed_apply_receipt["event_id"], f"vhost-apply-{failed_apply_id}"
                )
                self.assertEqual(failed_apply_receipt["status"], "received")
                archive_retry = request(
                    "POST",
                    "/api/curator/retry",
                    {"operationId": archive_operation_id},
                )
                archive_receipt = archive_retry["curatorV2"]
                self.assertEqual(archive_receipt.get("project_id"), config.project_id)
                self.assertEqual(
                    archive_receipt["event_id"],
                    f"vhost-archive-{archive_operation_id}",
                )
                self.assertEqual(archive_receipt["status"], "received")
                for cron_operation_id in cron_operation_ids:
                    cron_retry = request(
                        "POST",
                        "/api/curator/retry",
                        {"operationId": cron_operation_id},
                    )
                    cron_receipt = cron_retry["curatorV2"]
                    self.assertEqual(cron_receipt["project_id"], config.project_id)
                    self.assertEqual(
                        cron_receipt["event_id"], f"vhost-ssl-cron-{cron_operation_id}"
                    )
                    self.assertEqual(cron_receipt["status"], "received")
                renewal_retry = request(
                    "POST", "/api/curator/retry", {"operationId": renewal_id}
                )
                renewal_receipt = renewal_retry["curatorV2"]
                self.assertEqual(renewal_receipt["project_id"], config.project_id)
                self.assertEqual(
                    renewal_receipt["event_id"], f"vhost-ssl-renew-{renewal_id}"
                )
                self.assertEqual(renewal_receipt["status"], "received")
                interrupted_renewal = request(
                    "POST",
                    "/api/ssl-renew",
                    {"domain": "curator-smoke.test", "testOutcome": "interrupted"},
                )["job"]
                self.assertEqual(interrupted_renewal["status"], "interrupted")
                self.assertEqual(interrupted_renewal["exitCode"], 143)
                self.assertEqual(interrupted_renewal["curatorV2"]["status"], "received")
                failed_renewal = request(
                    "POST",
                    "/api/ssl-renew",
                    {"domain": "curator-smoke.test", "testOutcome": "failed"},
                )["job"]
                self.assertEqual(failed_renewal["status"], "failed")
                self.assertEqual(failed_renewal["exitCode"], 1)
                self.assertEqual(failed_renewal["curatorV2"]["status"], "received")
                retried = request(
                    "POST", "/api/curator/retry", {"operationId": operation_id}
                )
                receipt = retried["curatorV2"]
                self.assertEqual(receipt.get("project_id"), config.project_id, receipt)
                self.assertEqual(receipt["event_id"], f"vhost-apply-{operation_id}")
                self.assertEqual(receipt["status"], "received")
                self.assertNotIn("curatorRequest", retried["operation"])
                rolled_back = request(
                    "POST", "/api/rollback", {"operationId": operation_id}
                )
                rollback = rolled_back["rollback"]
                self.assertEqual(rolled_back["operation"]["state"], "rolled-back")
                self.assertEqual(rollback["kind"], "rollback")
                self.assertEqual(rollback["reversesOperationId"], operation_id)
                rollback_receipt = rolled_back["curatorV2"]
                self.assertEqual(rollback_receipt["project_id"], config.project_id)
                self.assertEqual(
                    rollback_receipt["event_id"], f"vhost-rollback-{rollback['id']}"
                )
                self.assertEqual(rollback_receipt["status"], "received")

                failure_preview = request(
                    "POST", "/api/plan/site", {"domain": "curator-rollback-failure.test"}
                )["plan"]
                failure_applied = request(
                    "POST",
                    "/api/apply",
                    {
                        "planId": failure_preview["id"],
                        "confirmation": failure_preview["confirmation"],
                    },
                )
                failure_operation = failure_applied["operation"]
                failure_operation_id = str(failure_operation["id"])
                self.assertTrue(failure_operation["rollbackAvailable"])
                snapshot = Path(str(failure_operation["backup"])) / "snapshot.json"
                self.assertTrue(snapshot.is_file())
                snapshot.write_text("{invalid json", encoding="utf-8")
                failed_rollback_response = request(
                    "POST",
                    "/api/rollback",
                    {"operationId": failure_operation["id"]},
                    expected_status=(400,),
                )
                failed_rollback = failed_rollback_response["rollback"]
                self.assertEqual(failed_rollback["kind"], "rollback")
                self.assertEqual(failed_rollback["state"], "failed")
                self.assertEqual(
                    failed_rollback["reversesOperationId"], failure_operation["id"]
                )
                self.assertEqual(failed_rollback_response["curatorV2"]["status"], "received")
                failed_rollback_id = str(failed_rollback["id"])
                self.assertEqual(
                    failed_rollback_response["curatorV2"]["event_id"],
                    f"vhost-rollback-{failed_rollback_id}",
                )
            finally:
                second_server.terminate()
                second_server.wait(timeout=5)

            store = CuratorStore(database)
            try:
                archive_event_id = f"vhost-archive-{archive_operation_id}"
                archived_receipt = store.event_receipt(config.project_id, archive_event_id)
                self.assertEqual(archived_receipt.status, EventInboxStatus.PROCESSED)
                archive_goal = store.get_goal(
                    f"vhost-archive-{archive_operation_id}", config.project_id
                )
                self.assertEqual(archive_goal.status, GoalStatus.ACTIVE)
                self.assertNotIn(str(database), archive_goal.problem)
                self.assertNotIn(str(fixture_root), archive_goal.problem)
                for cron_operation_id in cron_operation_ids:
                    cron_event_id = f"vhost-ssl-cron-{cron_operation_id}"
                    cron_stored = store.event_receipt(config.project_id, cron_event_id)
                    self.assertEqual(cron_stored.status, EventInboxStatus.PROCESSED)
                    cron_goal = store.get_goal(cron_event_id, config.project_id)
                    self.assertEqual(cron_goal.status, GoalStatus.ACTIVE)
                    self.assertIn("SSL renewal failed", cron_goal.problem)
                    self.assertNotIn("CRON_TRANSIENT_CANARY", cron_goal.problem)
                    self.assertNotIn(str(database), cron_goal.problem)
                for index, script_operation_id in enumerate(script_operation_ids):
                    script_event_id = f"vhost-script-{script_operation_id}"
                    script_receipt = store.event_receipt(config.project_id, script_event_id)
                    self.assertEqual(script_receipt.status, EventInboxStatus.PROCESSED)
                    script_goal = store.get_goal(script_event_id, config.project_id)
                    self.assertEqual(script_goal.status, GoalStatus.ACTIVE)
                    self.assertIn("exit code", script_goal.problem)
                    self.assertNotIn("must-not-be-sent", script_goal.problem)
                    self.assertNotIn(str(database), script_goal.problem)
                    self.assertNotIn(str(fixture_root), script_goal.problem)
                stored = store.event_receipt(
                    config.project_id, f"vhost-apply-{operation_id}"
                )
                self.assertEqual(stored.status, EventInboxStatus.PROCESSED)
                goal = store.get_goal(f"vhost-op-{operation_id}", config.project_id)
                self.assertEqual(goal.status, GoalStatus.ACTIVE)
                self.assertEqual(goal.problem, f"{plan['title']}: {plan['summary']}")
                self.assertEqual(
                    goal.success_criteria,
                    (
                        SuccessCriterion(
                            "nginx_valid",
                            "The generated Nginx configuration passes validation.",
                        ),
                        SuccessCriterion(
                            "ols_valid",
                            "The generated OpenLiteSpeed configuration passes validation.",
                        ),
                        SuccessCriterion(
                            "site_reachable",
                            "The configured site returns a navigable response after reload.",
                        ),
                        SuccessCriterion(
                            "human_review",
                            "A human reviews this Vhost Manager operation outcome.",
                        ),
                    ),
                )
                self.assertNotIn(str(database), goal.problem)
                self.assertNotIn(str(fixture_root), goal.problem)
                for target_path in operation["files"]:
                    self.assertNotIn(str(target_path), goal.problem)
                failed_apply_event_id = f"vhost-apply-{failed_apply_id}"
                failed_apply_stored = store.event_receipt(
                    config.project_id, failed_apply_event_id
                )
                self.assertEqual(
                    failed_apply_stored.status, EventInboxStatus.PROCESSED
                )
                failed_apply_goal = store.get_goal(
                    f"vhost-op-{failed_apply_id}", config.project_id
                )
                self.assertEqual(failed_apply_goal.status, GoalStatus.ACTIVE)
                self.assertEqual(
                    failed_apply_goal.problem,
                    f"{failed_apply_preview['title']}: {failed_apply_preview['summary']}",
                )
                self.assertNotIn("Injected test-mode apply failure", failed_apply_goal.problem)
                self.assertNotIn(str(database), failed_apply_goal.problem)
                self.assertNotIn(str(fixture_root), failed_apply_goal.problem)
                self.assertNotIn(str(base), failed_apply_goal.problem)
                failed_apply_facts = store.list_facts(
                    f"vhost-op-{failed_apply_id}", config.project_id
                )
                self.assertEqual(len(failed_apply_facts), 1)
                self.assertEqual(
                    failed_apply_facts[0].bullet,
                    "Vhost Manager recorded operation outcome: apply failed.",
                )
                rollback_event_id = f"vhost-rollback-{rollback['id']}"
                stored_rollback = store.event_receipt(config.project_id, rollback_event_id)
                self.assertEqual(stored_rollback.status, EventInboxStatus.PROCESSED)
                rollback_goal = store.get_goal(
                    f"vhost-rollback-{rollback['id']}", config.project_id
                )
                self.assertEqual(rollback_goal.status, GoalStatus.ACTIVE)
                failed_rollback_event_id = f"vhost-rollback-{failed_rollback_id}"
                failed_rollback_receipt = store.event_receipt(
                    config.project_id, failed_rollback_event_id
                )
                self.assertEqual(
                    failed_rollback_receipt.status, EventInboxStatus.PROCESSED
                )
                failed_rollback_goal = store.get_goal(
                    failed_rollback_event_id, config.project_id
                )
                self.assertEqual(failed_rollback_goal.status, GoalStatus.ACTIVE)
                self.assertIn("rollback failed", failed_rollback_goal.problem)
                self.assertNotIn(str(database), failed_rollback_goal.problem)
                self.assertNotIn(str(fixture_root), failed_rollback_goal.problem)
                self.assertNotIn(str(base), failed_rollback_goal.problem)
                for ssl_job in (renewal, interrupted_renewal, failed_renewal):
                    ssl_event_id = f"vhost-ssl-renew-{ssl_job['id']}"
                    ssl_receipt = store.event_receipt(config.project_id, ssl_event_id)
                    self.assertEqual(ssl_receipt.status, EventInboxStatus.PROCESSED)
                    ssl_goal = store.get_goal(ssl_event_id, config.project_id)
                    self.assertEqual(ssl_goal.status, GoalStatus.ACTIVE)
                    self.assertIn(str(ssl_job["domain"]), ssl_goal.problem)
                    self.assertIn(str(ssl_job["status"]), ssl_goal.problem)
                    self.assertNotIn(str(database), ssl_goal.problem)
                    self.assertNotIn("Test mode", ssl_goal.problem)
                recovered_event_id = f"vhost-ssl-renew-{in_progress_renewal_id}"
                recovered_receipt = store.event_receipt(
                    config.project_id, recovered_event_id
                )
                self.assertEqual(
                    recovered_receipt.status, EventInboxStatus.PROCESSED
                )
                recovered_goal = store.get_goal(
                    recovered_event_id, config.project_id
                )
                self.assertEqual(recovered_goal.status, GoalStatus.ACTIVE)
                self.assertIn("SSL renewal interrupted", recovered_goal.problem)
                self.assertNotIn(str(database), recovered_goal.problem)
                self.assertNotIn(str(fixture_root), recovered_goal.problem)

                goal_fact_pairs = [
                    (f"vhost-archive-{archive_operation_id}", archive_operation_id),
                    *[
                        (f"vhost-ssl-cron-{item}", item)
                        for item in cron_operation_ids
                    ],
                    *[
                        (f"vhost-script-{item}", item)
                        for item in script_operation_ids
                    ],
                    (f"vhost-op-{operation_id}", operation_id),
                    (f"vhost-ssl-renew-{renewal_id}", renewal_id),
                    (
                        f"vhost-ssl-renew-{in_progress_renewal_id}",
                        in_progress_renewal_id,
                    ),
                    (f"vhost-op-{failed_apply_id}", failed_apply_id),
                    (
                        f"vhost-rollback-{rollback['id']}",
                        str(rollback["id"]),
                    ),
                    (f"vhost-rollback-{failed_rollback_id}", failed_rollback_id),
                    (
                        f"vhost-op-{failure_operation_id}",
                        failure_operation_id,
                    ),
                    (f"vhost-ssl-renew-{interrupted_renewal['id']}", str(interrupted_renewal["id"])),
                    (f"vhost-ssl-renew-{failed_renewal['id']}", str(failed_renewal["id"])),
                ]
                for goal_id, source_operation_id in goal_fact_pairs:
                    with self.subTest(goal_id=goal_id):
                        fact_event_id = f"vhost-fact-{source_operation_id}"
                        fact_receipt = store.event_receipt(
                            config.project_id, fact_event_id
                        )
                        self.assertEqual(
                            fact_receipt.status, EventInboxStatus.PROCESSED
                        )
                        facts = store.list_facts(goal_id, config.project_id)
                        self.assertEqual(len(facts), 1)
                        self.assertEqual(facts[0].kind, FactKind.CHANGE)
                        self.assertTrue(
                            facts[0].bullet.startswith(
                                "Vhost Manager recorded operation outcome: "
                            )
                        )
                        self.assertNotIn(str(database), facts[0].bullet)
                        self.assertNotIn(str(fixture_root), facts[0].bullet)
                        self.assertNotIn("CRON_TRANSIENT_CANARY", facts[0].bullet)
            finally:
                store.close()

            replay = subprocess.run(
                [sys.executable, str(helper)],
                input=json.dumps(
                    {
                        "operation": operation,
                        "request": {
                            "problem": f"{plan['title']}: {plan['summary']}",
                            "criterion_ids": [
                                "nginx_valid",
                                "ols_valid",
                                "site_reachable",
                                "human_review",
                            ],
                        },
                    }
                ),
                capture_output=True,
                check=False,
                cwd=source_root,
                env=server_env(launcher, "completed"),
                timeout=20,
                text=True,
            )
            self.assertEqual(replay.returncode, 0, replay.stderr)
            replay_receipt = json.loads(replay.stdout)["receipt"]
            self.assertEqual(replay_receipt["event_id"], f"vhost-apply-{operation_id}")
            self.assertIn(replay_receipt["status"], {"processed", "duplicate"})

            replay_rollback = subprocess.run(
                [sys.executable, str(helper)],
                input=json.dumps({"operation": rollback}),
                capture_output=True,
                check=False,
                cwd=source_root,
                env=server_env(launcher, "completed"),
                timeout=20,
                text=True,
            )
            self.assertEqual(replay_rollback.returncode, 0, replay_rollback.stderr)
            replay_rollback_receipt = json.loads(replay_rollback.stdout)["receipt"]
            self.assertEqual(
                replay_rollback_receipt["event_id"], f"vhost-rollback-{rollback['id']}"
            )
            self.assertIn(replay_rollback_receipt["status"], {"processed", "duplicate"})

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
                self.receipt_project_id = module.PROJECT_ID
                self.receipt_event_id: str | None = None
                self.binding: str = "bound"

            def call_mcp(self, *args: object, **kwargs: object) -> dict[str, object]:
                self.calls.append((args, kwargs))
                if len(args) >= 2 and args[1] == "hermes_goal_bind":
                    return {
                        "ok": True,
                        "result": '{"binding":"validated","project_id":"vhost-manager-alpha"}',
                        "hermes_goal_binding": self.binding,
                    }
                event_payload = args[2]
                event_id = (
                    event_payload.get("event_id")
                    if isinstance(event_payload, dict)
                    else None
                )
                return {
                    "ok": True,
                    "result": {
                        "receipt": {
                            "project_id": self.receipt_project_id,
                            "event_id": self.receipt_event_id or event_id,
                            "status": self.receipt,
                        }
                    },
                }

        async def exercise() -> None:
            context = _ManagedMcpContext()
            hook_event = {
                "project_id": config.project_id,
                "goal_id": "vhost-hook-goal",
                "event_id": "vhost-hook-event",
                "source_id": "hermes-vhost-hook-source",
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
                payload["source_id"], hook_event["source_id"]  # type: ignore[index]
            )
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
            context.receipt = "processed"
            context.receipt_event_id = "different-event"
            self.assertIs(
                await module.handle("codex:turn:end", hook_event, ctx=context),
                False,
            )
            context.receipt_event_id = None
            context.receipt_project_id = "another-project"
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

        source_root = Path(__file__).resolve().parents[2]
        profile_id = "vhost-manager-alpha-e2e-test"
        session_id = "vhost-alpha-e2e-session"
        goal_id = "vhost-alpha-e2e-goal"
        hook_path = (
            source_root
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
            project_root = Path(temp) / "consumer"
            for relative in ("docs", "vhost-manager"):
                (project_root / relative).mkdir(parents=True)
            subprocess.run(
                ["git", "init", "--quiet", str(project_root)],
                check=True,
                capture_output=True,
                timeout=10,
            )
            config_path = project_root / ".curatormd-v2.toml"
            config_path.write_bytes(
                (source_root / ".curatormd-v2.toml").read_bytes()
            )
            config_path.chmod(0o600)
            for target_relative in (
                ".curatormd-v2/persistence/HISTORY.md",
                ".curatormd-v2/persistence/LESSONS-LEARNED.md",
            ):
                target = project_root / target_relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("# Disposable Vhost alpha record\n", encoding="utf-8")
            (project_root / ".curatormd-v2" / "staging").mkdir(parents=True)
            out_of_scope = project_root / "persistence" / "HISTORY.md"
            out_of_scope.parent.mkdir(parents=True)
            out_of_scope.write_text("# Must remain unchanged\n", encoding="utf-8")
            config = ProjectConfig.load(project_root)
            database = Path(temp) / "curator-v2.sqlite3"
            store = CuratorStore(database)
            try:
                manager = ProjectAccessManager(store, _DisposableProjectAdministrator())
                operator = AuthenticatedCaller("vhost-alpha-test-operator")
                manager.register_project(
                    operator,
                    ProjectRegistrationRequest.from_project_config(
                        config, "Disposable Vhost Manager hook end-to-end test"
                    ),
                )
                for action in (ProjectAction.READ, ProjectAction.WRITE):
                    manager.grant(
                        operator,
                        config.project_id,
                        LOCAL_SUBJECT_ID,
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

            store = CuratorStore(database)
            try:
                plugin = ProjectPlugin.bind(config, store)
                target_relative = config.persistence_targets[0]
                persisted = plugin.persist_goal(goal_id, target_relative)
                self.assertEqual(persisted.target, project_root / target_relative)
                reconciled = plugin.reconcile_goal(goal_id, target_relative)
                self.assertEqual(reconciled.status, "synced")
            finally:
                store.close()

            projection = (project_root / target_relative).read_text(encoding="utf-8")
            self.assertIn(r"vhost\-alpha\-e2e\-goal", projection)
            self.assertIn("Codex turn started for the explicitly bound goal", projection)
            self.assertIn("Codex turn ended normally", projection)
            self.assertNotIn(prompt_canary, projection)
            self.assertNotIn(response_canary, projection)
            self.assertNotIn("VHOST_FAILURE_CANARY_MUST_NOT_PERSIST", projection)
            self.assertEqual(
                out_of_scope.read_text(encoding="utf-8"),
                "# Must remain unchanged\n",
            )


if __name__ == "__main__":
    unittest.main()
