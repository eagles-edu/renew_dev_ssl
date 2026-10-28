#!/usr/bin/env python3
"""Remove expired manual DNS renewal logs without reading their contents."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import time


LOG_PREFIX = "acme-dns-manual-"
LOG_SUFFIX = ".log"
# A six-hour schedule with up to fifteen minutes of spread needs this margin to
# remove a file before it reaches the approved 72-hour maximum age.
CLEAN_AFTER_SECONDS = (65 * 60 + 45) * 60 - 1


def expire_logs(log_directory: Path, *, now: float | None = None) -> int:
    """Delete only stale, regular, direct-child manual-DNS log files."""

    current_time = time.time() if now is None else now
    directory_stat = log_directory.lstat()
    if not stat.S_ISDIR(directory_stat.st_mode):
        raise NotADirectoryError(log_directory)

    expired_before = current_time - CLEAN_AFTER_SECONDS
    removed = 0
    with os.scandir(log_directory) as entries:
        for entry in entries:
            if not entry.name.startswith(LOG_PREFIX) or not entry.name.endswith(
                LOG_SUFFIX
            ):
                continue
            try:
                metadata = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                if metadata.st_mtime < expired_before:
                    os.unlink(entry.path)
                    removed += 1
            except FileNotFoundError:
                continue
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--log-directory", type=Path, default=Path("/var/log")
    )
    arguments = parser.parse_args()
    try:
        removed = expire_logs(arguments.log_directory)
    except OSError:
        print("manual DNS log cleanup failed")
        return 1
    print(f"manual DNS logs removed: {removed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
