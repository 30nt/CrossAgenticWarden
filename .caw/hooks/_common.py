"""Shared helpers for the PreToolUse guards an install wires in front of its own session.

The guards exist because a rule in CLAUDE.md is advice the model may or may not
follow, while a hook is executed by the harness before the tool call happens.
Each one encodes a failure an install actually paid for, named in its module
docstring.
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional


def read_event() -> dict:
    """Return the hook payload, or an empty dict when stdin holds no JSON.

    A guard that crashes on unexpected input would block every matching tool
    call, so malformed input is treated as "nothing to say".
    """
    try:
        return json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
        return {}


def project_root(event: dict) -> Path:
    """Return the repository root the tool call runs against."""
    for candidate in (os.environ.get("CLAUDE_PROJECT_DIR"), event.get("cwd"), os.getcwd()):
        if candidate:
            return Path(candidate).resolve()
    return Path.cwd().resolve()


def root_forms(root: Path) -> tuple[str, ...]:
    """Every spelling of the project root a command line can carry, each ending in `/`.

    One on POSIX; three in daily use on Windows, because three shells write the
    same directory three ways: the native `C:\\Users\\…\\repo`, the same path
    with forward slashes, and the Git Bash mount `/c/Users/…/repo`. Longest
    first, so `/cygdrive/c/…` is stripped before the `/c/…` that is its tail.
    """
    posix = root.as_posix()
    forms = {f"{posix}/"}
    drive = root.drive
    if drive.endswith(":"):
        letter = drive[0].lower()
        tail = posix[len(drive) :]
        forms.add(f"/{letter}{tail}/")
        forms.add(f"/cygdrive/{letter}{tail}/")
    return tuple(sorted(forms, key=len, reverse=True))


# A backslash that is not escaping whitespace is a separator.
_SEPARATOR = re.compile(r"\\(?=[^\s])")


def localize(text: str, root: Path) -> str:
    """Rewrite a path-carrying string so the queue reads `.caw-tasks/…` in any spelling.

    Every pattern in these guards is written in the POSIX spelling, and on
    2026-08-21 three probes showed what that costs on Windows: `.caw-tasks\\PLAN.md`,
    `C:\\…\\.caw-tasks\\PLAN.md` and the Git Bash `/c/Users/…/.caw-tasks/PLAN.md` all
    walked past a guard that refuses `.caw-tasks/PLAN.md`. Two normalizations fix
    all three and change nothing on POSIX.

    Backslashes become slashes — a separator on Windows, and the same file —
    except before whitespace, where a backslash is a shell escape (`my\\ dir`)
    rather than a separator. Then the project root goes, in whichever spelling
    arrived, because an absolute path is how half the commands in a session are
    written. Root matching is case-insensitive: Windows answers to `c:` and `C:`
    for one directory.
    """
    localized = _SEPARATOR.sub("/", text)
    for form in root_forms(root):
        localized = re.sub(re.escape(form), "", localized, flags=re.IGNORECASE)
    # A Python string literal spells the Windows separator twice — `".caw-tasks\\\\PLAN.md"`
    # is how a non-raw string names that file — and two separators became two
    # slashes above, which `.caw-tasks/PLAN\.md` does not match. Measured on macOS: a
    # script written that way walked past the refusal. Runs collapse to one; the
    # `://` of a URL is left alone, not because it matters for matching but so
    # the localized text still reads as what it was.
    return re.sub(r"(?<!:)/{2,}", "/", localized)


APPROVED_TRUE = re.compile(r"^approved:\s*true\s*$", re.MULTILINE)

_DIRECT_PATH_KEYS = (
    "file_path",
    "notebook_path",
    "path",
    "target_path",
    "destination",
)
_CODEX_PATCH_PATH = re.compile(
    r"^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$"
    r"|^\*\*\*\s+Move\s+to:\s*(.+?)\s*$",
    re.MULTILINE,
)
_UNIFIED_PATCH_PATH = re.compile(r"^\+\+\+\s+(?:b/)?(.+?)\s*$", re.MULTILINE)
_DIFF_GIT_PATH = re.compile(r"^diff --git\s+(?:a/)?\S+\s+(?:b/)?(.+?)\s*$", re.MULTILINE)


def tool_input(event: dict) -> dict:
    """Return the provider tool arguments when they are an object.

    Claude direct tools and Codex local function tools both use ``tool_input``.
    Codex documents it as any JSON value, so a non-object is deliberately an
    empty input rather than something policy code guesses how to interpret.
    """
    value = event.get("tool_input")
    return value if isinstance(value, dict) else {}


def shell_command(event: dict) -> str:
    """Normalize Claude shell calls and Codex's Bash/unified-exec hook payload."""
    value = tool_input(event).get("command")
    return value if isinstance(value, str) else ""


def _clean_patch_path(value: str) -> Optional[str]:
    path = value.strip().strip('"\'')
    if not path or path == "/dev/null":
        return None
    return path


def edit_paths(event: dict) -> tuple[str, ...]:
    """Normalize direct edit arguments and every path carried by patch text.

    Claude Write/Edit/NotebookEdit expose a direct path. Codex ``apply_patch``
    exposes its patch through ``tool_input.command``. Standard unified diffs are
    accepted as well because other local patch tools use that shape. Only path
    fields and patch headers are interpreted; arbitrary strings are never
    treated as filesystem intent.
    """
    value = tool_input(event)
    paths: list[str] = []
    for key in _DIRECT_PATH_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            paths.append(candidate)
    changes = value.get("changes")
    if isinstance(changes, list):
        for change in changes:
            if isinstance(change, dict) and isinstance(change.get("path"), str):
                paths.append(change["path"])

    patch = value.get("patch")
    if not isinstance(patch, str):
        command = value.get("command")
        patch = command if isinstance(command, str) else ""
    if patch and (
        event.get("tool_name") == "apply_patch"
        or "*** Begin Patch" in patch
        or "diff --git " in patch
    ):
        for pattern in (_CODEX_PATCH_PATH, _UNIFIED_PATCH_PATH, _DIFF_GIT_PATH):
            for match in pattern.finditer(patch):
                candidate = _clean_patch_path(next(group for group in match.groups() if group))
                if candidate:
                    paths.append(candidate)

    return tuple(dict.fromkeys(paths))


def invalidate_approval(root: Path, actor: str) -> bool:
    """Set `approved: false` in .caw-tasks/PLAN.md, and say whether it had been true.

    This is what replaced refusing spec edits outright. The thing worth
    protecting was never the text of a spec — it was the verdict: `approved`
    flips only when `review-specs` finds no holes, and a spec edited after that
    verdict makes the verdict describe a plan that no longer exists. So an edit
    is allowed and the verdict is withdrawn, which is strictly stronger than the
    old refusal: that one left an approved plan editable through any route the
    patterns missed.

    Runs before the write, on intent rather than on result. An edit that then
    fails leaves the flag down — the safe direction, since the cost is one
    `review-specs` round and the alternative is building an unjudged plan.
    """
    plan = root / ".caw-tasks" / "PLAN.md"
    try:
        text = plan.read_text(encoding="utf-8")
    except OSError:
        return False

    if not APPROVED_TRUE.search(text):
        return False

    try:
        plan.write_text(APPROVED_TRUE.sub("approved: false", text), encoding="utf-8")
    except OSError:
        return False

    logs = root / ".caw-logs"
    try:
        logs.mkdir(exist_ok=True)
        with (logs / "invalidations.log").open("a", encoding="utf-8") as handle:
            handle.write(f"approval withdrawn: {actor}\n")
    except OSError:
        pass
    return True


def deny(reason: str) -> None:
    """Refuse the tool call and tell the caller why, then exit successfully.

    Exit code stays 0: the guard did its job. The refusal is carried by the
    JSON envelope, which is what the harness reads. A non-zero exit is a hook
    error, and the harness answers one by refusing the tool call outright — a
    settings file naming two deleted hook files locked a session out of Bash
    and Edit at once.
    """
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def allow() -> None:
    """Say nothing and let the tool call proceed."""
    sys.exit(0)
