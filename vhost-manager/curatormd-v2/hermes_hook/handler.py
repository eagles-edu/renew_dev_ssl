"""Consumer-owned Hermes hook for Vhost Manager's Curator V2 project."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Mapping
from typing import Any


PROJECT_ID = "vhost-manager-alpha"
MCP_SERVER = "curator_v2"
SUPPORTED_EVENTS = frozenset({"agent:start", "codex:turn:start", "codex:turn:end"})
_BIND_COMMAND_RE = re.compile(
    r"curator-v2 bind ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})"
)
CONTEXT_FIELDS = frozenset(
    {"attempt_id", "session_id", "turn_id", "outcome", "failure_kind"}
)


def _durable_receipt(result: object) -> bool:
    """Acknowledge only a durable processed or duplicate Curator receipt."""

    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, Mapping):
        return False
    receipt = result.get("receipt", result)
    return (
        isinstance(receipt, Mapping)
        and receipt.get("status") in {"processed", "duplicate"}
    )


def _goal_binding_confirmed(response: object) -> bool:
    """Accept only a validated active goal and a persisted Hermes outbox binding."""
    if (
        not isinstance(response, Mapping)
        or response.get("ok") is not True
        or response.get("hermes_goal_binding") != "bound"
    ):
        return False
    result = response.get("structuredContent", response.get("result"))
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            return False
    return isinstance(result, Mapping) and result.get("binding") == "validated"


async def handle(
    event_type: str, hook_context: Mapping[str, Any], *, ctx: Any
) -> bool | None:
    """Deliver one Vhost Manager outbox event through Hermes managed MCP."""

    if event_type not in SUPPORTED_EVENTS:
        return None

    if event_type == "agent:start":
        match = _BIND_COMMAND_RE.fullmatch(str(hook_context.get("message", "")))
        session_id = hook_context.get("session_id")
        if match is None or not isinstance(session_id, str) or not session_id:
            return None
        try:
            response = await asyncio.to_thread(
                ctx.call_mcp,
                MCP_SERVER,
                "hermes_goal_bind",
                {"goal_id": match.group(1)},
                timeout=30,
                session_id=session_id,
            )
            return _goal_binding_confirmed(response)
        except Exception:
            return False

    if hook_context.get("project_id") != PROJECT_ID:
        return None

    try:
        raw_context = {
            key: hook_context[key]
            for key in CONTEXT_FIELDS
            if key in hook_context
        }
        session_id = raw_context.get("session_id")
        if not isinstance(session_id, str):
            return False
        payload = {
            "event_type": event_type,
            "goal_id": hook_context["goal_id"],
            "event_id": hook_context["event_id"],
            "source_sequence": hook_context["source_sequence"],
            "occurred_at": hook_context["occurred_at"],
            "context": raw_context,
        }
        response = await asyncio.to_thread(
            ctx.call_mcp,
            MCP_SERVER,
            "hermes_codex_event",
            payload,
            timeout=30,
            session_id=session_id,
            hermes_durable_event=True,
        )
        if (
            not isinstance(response, Mapping)
            or response.get("ok") is not True
            or response.get("truncated") is True
        ):
            return False
        return _durable_receipt(response.get("result"))
    except Exception:
        # Keep event data and internal errors out of gateway logs and responses.
        return False
