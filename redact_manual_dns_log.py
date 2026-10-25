"""Stream manual ACME output to logs without retaining credentials or DNS proofs."""

from __future__ import annotations

import re
import sys


_LABELED_VALUE = re.compile(
    r"(?i)\b(TXT(?:\s+(?:record|value))?|"
    r"DNS\s+(?:challenge|TXT)(?:\s+(?:value|code|token))?|expected)"
    r"\s*:\s*.*$"
)
_CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?i)\b(password|passwd|pwd|key|api[_-]?key|private[_-]?key|access[_-]?token|"
    r"refresh[_-]?token|token|secret)\s*[:=]\s*.*$"
)
_LONG_TOKEN = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])")
_PRIVATE_KEY_BEGIN = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
_PRIVATE_KEY_END = re.compile(r"-----END [A-Z0-9 ]*PRIVATE KEY-----")


def _redact_line(line: str, in_private_key: bool) -> tuple[str, bool]:
    if in_private_key:
        if _PRIVATE_KEY_END.search(line):
            return "[REDACTED PRIVATE KEY BLOCK]\n", False
        return "", True
    if _PRIVATE_KEY_BEGIN.search(line):
        if _PRIVATE_KEY_END.search(line):
            return "[REDACTED PRIVATE KEY BLOCK]\n", False
        return "[REDACTED PRIVATE KEY BLOCK]\n", True

    for pattern, label in (
        (_CREDENTIAL_ASSIGNMENT, "credential"),
        (_LABELED_VALUE, "TXT value"),
    ):
        match = pattern.search(line)
        if match:
            return f"{line[:match.start()]}{match.group(1)}: [REDACTED {label}]\n", False

    return _LONG_TOKEN.sub("[REDACTED]", line), False


def main() -> int:
    """Filter stdin incrementally, retaining neither labeled values nor PEM keys."""

    in_private_key = False
    for raw_line in sys.stdin:
        safe_line, in_private_key = _redact_line(raw_line, in_private_key)
        sys.stdout.write(safe_line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
