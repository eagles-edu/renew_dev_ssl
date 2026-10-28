"""Send one applied Vhost operation through the configured Curator V2 MCP."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from mcp import Client
from mcp.client.stdio import StdioServerParameters
from mcp.types import TextContent


MAX_INPUT_BYTES = 16 * 1024
PROJECT_ID = "vhost-manager-alpha"
SCRIPT_PRODUCERS = {
    "manual_dns_renewal": "manual DNS certificate renewal",
    "domain_batch_renewal": "domain batch renewal",
    "domain_inventory_refresh": "domain inventory refresh",
    "nginx_vhost_setup": "Nginx vhost setup",
}
CRITERIA = {
    "nginx_valid": "The generated Nginx configuration passes validation.",
    "ols_valid": "The generated OpenLiteSpeed configuration passes validation.",
    "site_reachable": "The configured site returns a navigable response after reload.",
    "operation_recorded": "Vhost Manager records the requested operation outcome.",
    "human_review": "A human reviews this Vhost Manager operation outcome.",
}


def _receipt_from_result(result: Any, event_id: str) -> dict[str, str]:
    if result.is_error:
        raise RuntimeError("Curator V2 rejected the applied-operation event")
    for content in result.content:
        if not isinstance(content, TextContent):
            continue
        try:
            value = json.loads(content.text)
        except json.JSONDecodeError:
            continue
        receipt = value.get("receipt", value) if isinstance(value, dict) else None
        if (
            isinstance(receipt, dict)
            and receipt.get("project_id") == PROJECT_ID
            and receipt.get("event_id") == event_id
            and receipt.get("status") in {"processed", "duplicate"}
        ):
            return {
                "project_id": PROJECT_ID,
                "event_id": event_id,
                "status": receipt["status"],
            }
    raise RuntimeError("Curator V2 returned no matching durable event receipt")


def _goal_request(payload: dict[str, Any], summary: str) -> tuple[str, list[dict[str, str]]]:
    request = payload.get("request")
    if request is None:
        return summary[:2000], [{
            "criterion_id": "human_review",
            "description": CRITERIA["human_review"],
        }]
    if not isinstance(request, dict) or set(request) != {"problem", "criterion_ids"}:
        raise ValueError("invalid source request")
    problem = request["problem"]
    ids = request["criterion_ids"]
    if (
        not isinstance(problem, str)
        or not problem.strip()
        or len(problem) > 2000
        or "\n" in problem
        or "\r" in problem
        or not isinstance(ids, list)
        or not ids
        or len(ids) > 8
        or any(not isinstance(item, str) or item not in CRITERIA for item in ids)
        or len(set(ids)) != len(ids)
    ):
        raise ValueError("invalid source request")
    criteria = [
        {"criterion_id": item, "description": CRITERIA[item]}
        for item in ids
    ]
    if "human_review" not in ids:
        criteria.append({
            "criterion_id": "human_review",
            "description": CRITERIA["human_review"],
        })
    return problem.strip(), criteria


async def _send(
    event: dict[str, str],
    fact: dict[str, str],
    operation: dict[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    command = os.environ["CURATOR_V2_MCP_COMMAND"]
    database = os.environ["CURATOR_V2_DATABASE"]
    project_root = os.environ["CURATOR_V2_PROJECT_ROOT"]
    profile_id = os.environ["CURATOR_V2_PROFILE_ID"]
    home = os.environ["HOME"]
    if not all(
        Path(value).is_absolute() for value in (command, database, project_root, home)
    ):
        raise RuntimeError("Curator V2 host paths must be absolute")

    parameters = StdioServerParameters(
        command=command,
        args=[
            "--project-root",
            project_root,
            "--database",
            database,
            "--profile-id",
            profile_id,
            "--allow-write",
        ],
        env={"PATH": os.environ.get("PATH", ""), "HOME": home},
        cwd=project_root,
    )
    async with Client(parameters, raise_exceptions=True) as client:
        goal_result = await client.call_tool(
            "goal_start",
            event,
            meta={
                "hermes/profile_id": profile_id,
                "hermes/session_id": f"vhost-app-{operation['event_id']}",
            },
        )
        goal_receipt = _receipt_from_result(goal_result, operation["event_id"])
        fact_result = await client.call_tool(
            "fact_record",
            fact,
            meta={
                "hermes/profile_id": profile_id,
                "hermes/session_id": f"vhost-app-{operation['event_id']}",
            },
        )
        fact_receipt = _receipt_from_result(
            fact_result, fact["event_id"]
        )
    return goal_receipt, fact_receipt


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        print(json.dumps({"error": "input_too_large"}))
        return 2
    try:
        payload = json.loads(raw)
        operation = payload["operation"]
        operation_id = operation["id"]
        if not isinstance(operation_id, str) or not (
            len(operation_id) == 36
            or (operation_id.startswith("archive-") and len(operation_id) == 44)
        ):
            raise ValueError("invalid operation id")
        kind = operation.get("kind")
        is_rollback = kind == "rollback"
        is_archive = kind == "archive"
        is_ssl_renewal = kind == "ssl-renew"
        is_ssl_cron = kind == "ssl-cron"
        is_script = kind == "script"
        producer_id = operation.get("producerId")
        if is_script and producer_id not in SCRIPT_PRODUCERS:
            raise ValueError("unknown standalone producer")
        expected_states = (
            {"completed", "failed", "interrupted"}
            if is_ssl_renewal
            else {"completed", "failed"}
            if is_ssl_cron
            else {"completed", "failed"}
            if is_script
            else {"complete", "failed"}
            if is_rollback
            else {"archived"}
            if is_archive
            else {"applied", "failed"}
        )
        state = operation.get("state")
        if state not in expected_states:
            raise ValueError("operation is not in a completed state")
        event_prefix = (
            "vhost-rollback-"
            if is_rollback
            else "vhost-archive-"
            if is_archive
            else "vhost-ssl-renew-"
            if is_ssl_renewal
            else "vhost-ssl-cron-"
            if is_ssl_cron
            else "vhost-script-"
            if is_script
            else "vhost-apply-"
        )
        goal_prefix = (
            "vhost-rollback-"
            if is_rollback
            else "vhost-archive-"
            if is_archive
            else "vhost-ssl-renew-"
            if is_ssl_renewal
            else "vhost-ssl-cron-"
            if is_ssl_cron
            else "vhost-script-"
            if is_script
            else "vhost-op-"
        )
        event_id = f"{event_prefix}{operation_id}"
        goal_id = f"{goal_prefix}{operation_id}"
        fact_event_id = f"vhost-fact-{operation_id}"
        fact_id = f"vhost-fact-{operation_id}"
        title = operation.get("title") or operation.get("kind") or "operation"
        domain = operation.get("domain")
        action = (
            ("rolled back" if state == "complete" else "rollback failed")
            if is_rollback
            else "archived"
            if is_archive
            else f"SSL renewal {state}"
            if is_ssl_renewal or is_ssl_cron
            else f"{SCRIPT_PRODUCERS[producer_id]} {state}"
            if is_script
            else "apply failed"
            if state == "failed"
            else "applied"
        )
        summary = f"Vhost Manager {action} {title} operation {operation_id}"
        if isinstance(domain, str) and domain:
            summary += f" for {domain}"
        exit_code = operation.get("exitCode")
        if (is_ssl_renewal or is_ssl_cron or is_script) and isinstance(exit_code, int):
            summary += f" (exit code {exit_code})"
        problem, criteria = _goal_request(payload, summary)
        event = {
            "event_id": event_id,
            "goal_id": goal_id,
            "problem": problem,
            "success_criteria": criteria,
            # The operation has already completed. Keep its review goal active
            # so Curator accepts the compact outcome fact, then let a human
            # review and disposition it.
            "initial_status": "active",
            "next_action": "Review this Vhost Manager operation outcome.",
        }
        fact = {
            "event_id": fact_event_id,
            "goal_id": goal_id,
            "fact_id": fact_id,
            "kind": "change",
            "bullet": f"Vhost Manager recorded operation outcome: {action}.",
        }
        receipt, fact_receipt = asyncio.run(
            _send(event, fact, {"event_id": event_id})
        )
    except Exception as error:
        print(json.dumps({"error": "curator_receipt_unavailable"}))
        print(type(error).__name__, file=sys.stderr)
        return 1
    print(
        json.dumps(
            {"receipt": receipt, "fact_receipt": fact_receipt},
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
