#!/usr/bin/env python3
"""Refuse a caw.mjs run whose output is not captured, and prune old logs.

On 2026-08-19 a diagnostic architect call returned a valid plan for $3.87 and
the output was printed truncated instead of saved, so the plan was lost and the
same ground was re-planned three times. A run of this pipeline costs $3-12 and
its only record is what it wrote to a terminal that scrolls.

The same call prunes .caw-logs/ to the newest KEEP files: the event that fills
the directory is the event that trims it, so nobody has to remember.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import allow, deny, localize, project_root, read_event, shell_command  # noqa: E402


LOG_DIR = ".caw-logs"
KEEP = 20

# A run is a segment that actually starts with `node`, once the wrappers installs
# put in front of it are stripped. Matching `caw.mjs <subcommand>` anywhere in the
# command line also matched `grep -n "node caw.mjs plan" CLAUDE.md`, and a guard
# that blocks reading the documentation for the tool is a guard people turn off.
# `round` and `review` each spend a real model call — one executor and one reviewer, or one
# reviewer — so they are runs by the only definition that matters here: money, and a verdict
# whose text lives nowhere else. They were added to this list in the same change that added
# them to the tool, because a subcommand that is not listed is one this guard silently exempts
# from being saved, and the exemption is invisible until someone wants the log.
#
# `review\b` would already match `review-specs`; both are spelled out so that reading this line
# tells you which subcommands exist rather than which prefixes happen to collide.
RUN = re.compile(
    r"^node(?:\.exe)?\s+\S*caw\.mjs\s+(?:plan|build|review-specs|review|round|ship)\b"
)
SEGMENT = re.compile(r"[;&|\n]+")

# The wrappers, each one a form an install actually launches the pipeline with.
# `env` carries flags, and that omission cost this guard its entire job on the
# Windows machine: the launch form there is
# `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT CAW_CLAUDE=… node caw.mjs plan …`,
# because Claude Code refuses to start inside its own session — so the one shape
# the owner is obliged to type was the one shape that walked past. `-u NAME` and
# `-C dir` are listed before the bare `-\S+` branch so the flag's argument is
# eaten with it rather than left behind to fail the `^node` anchor.
PREFIX = re.compile(
    r"^(?:"
    r"\s*(?:nohup|time|winpty)\s+"
    r"|\s*caffeinate(?:\s+-\S+)*\s+"
    r"|\s*env(?:\s+-u\s+\S+|\s+-C\s+\S+|\s+-\S+)*\s+"
    r"|\s*(?:powershell(?:\.exe)?|pwsh)(?:\s+-\S+)*\s+-(?:c|command)\s+['\"]?"
    r"|\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+"
    r")+",
    re.IGNORECASE,
)


def is_run(command: str) -> bool:
    """True when some segment of the command line launches the pipeline."""
    for segment in SEGMENT.split(command):
        stripped = PREFIX.sub("", segment).strip()
        if RUN.match(stripped):
            return True
    return False

REASON = (
    "A caw.mjs run must write its output to {log_dir}/ — this one does not. "
    "A run costs $3-12 and reports the cost, the round verdicts and the reason a "
    "role died; on 2026-08-19 an architect call worth $3.87 returned a valid plan "
    "that was never saved, and the same plan was paid for three more times. "
    "Append `> {log_dir}/<name>-$(date +%H%M%S).log 2>&1` and run it again — in "
    "PowerShell, `> {log_dir}/<name>-$(Get-Date -Format HHmmss).log 2>&1`."
)


def prune(directory: Path) -> None:
    """Keep the newest KEEP logs; ignore anything that goes wrong doing it.

    Two things are exempt and are not counted against KEEP. A log is a transcript
    of a run that is over; the exempt files are the only copy of something nobody
    can reproduce. Pruning by mtime would give each a silent lifetime of KEEP
    further runs — and a `plan`, a `build` and a `review-specs` each write their
    own log, so that is fewer runs than it sounds. Nobody deletes them but a hand.

    `blocked-<task>.patch` is an executor round somebody paid for and no reviewer
    judged, waiting for a human to apply it.

    `diverged-<spec>` is the text of a task spec as it stood on disk when its own
    task committed, kept because it differed from the text the executor and the
    reviewer were actually given. It is whatever somebody else meant, no role in
    the pipeline ever read it, and the spec it came from is gone. It was first
    written to this directory under the impression that this function already
    protected it, which it did not — the exemption was `.patch` alone.
    """
    try:
        files = sorted(
            (p for p in directory.iterdir()
             if p.is_file() and p.suffix != ".patch" and not p.name.startswith("diverged-")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale in files[KEEP:]:
            stale.unlink(missing_ok=True)
    except OSError:
        pass


def main() -> None:
    event = read_event()
    root = project_root(event)
    # Localized before anything looks at it: `.caw-logs\p.log` is the same
    # directory as `.caw-logs/p.log`, and a redirect written in a PowerShell
    # session spells it the first way.
    command = localize(shell_command(event), root)
    if not is_run(command):
        allow()

    directory = root / LOG_DIR
    try:
        directory.mkdir(exist_ok=True)
        prune(directory)
    except OSError:
        pass

    if f"{LOG_DIR}/" not in command:
        deny(REASON.format(log_dir=LOG_DIR))

    allow()


main()
