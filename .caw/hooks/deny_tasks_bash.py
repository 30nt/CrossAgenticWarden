#!/usr/bin/env python3
"""The same rule as the Edit guard, for the routes that go through a shell.

Shells, plural, since 2026-08-21: one install is worked on from Windows,
where the session's own shell tool is PowerShell and its writes never reached
this file at all — the hook was wired to the `Bash` matcher alone, and a probe
`Set-Content .caw-tasks\\_probe.txt` created the file in silence. The matcher now
names both tools, so the cmdlet forms below are as load-bearing as the `>` ones,
and `_common.localize` folds the three Windows spellings of a path back into the
POSIX one every pattern here is written in.

Writes into .caw-tasks/ are allowed and withdraw the plan's approval; a write into
.caw-tasks/PLAN.md is refused, because that file carries the verdict itself. See
`deny_tasks_edit.py` for why the rule inverted from refusing edits to withdrawing
approval — and why these two files kept their names through that inversion: they
still deny, just the one file that matters instead of the whole directory.

Any write to the queue counts, not only an edit of an existing spec: dropping a
fourteenth spec in, or deleting one of the thirteen, makes the verdict describe a
queue that is not there any more just as surely as rewriting a done_when does.

caw.mjs is exempt: the pipeline owns .caw-tasks/, writes every spec, raises the flag
through `review-specs`, deletes each spec at its own commit and removes a
hand-finished task's spec through `done`. Reading is never touched — `cat`, `ls`,
`grep` over .caw-tasks/ are how the queue is inspected.

What it does not see, stated so nobody mistakes it for a seal: a path that
reaches the shell through a variable (`python3 "$S/patch.py"`, `$env:Q/x.md`), a
name broken up by quoting (`"tas"ks/x.md"`), a program that composes the path at
runtime, or PowerShell's one-and-two-letter aliases (`ni`, `ri`, `sc`) — those
last are left out deliberately, because `sc` is also Windows' service control and
a guard that fires on unrelated commands is one people switch off. All of these
need intent. The guard is aimed at the write nobody stopped to think about, and
the cost of missing one is now a stale `approved: true` rather than a silently
rewritten queue — which is the argument for putting the real check in `caw.mjs`,
where `build` can compare the specs against what was actually judged.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    allow,
    deny,
    invalidate_approval,
    localize,
    project_root,
    read_event,
    shell_command,
)


PLAN_REASON = (
    ".caw-tasks/PLAN.md is written by caw.mjs, not by a shell. Its `approved` flag is "
    "the only gate between an incomplete plan and a build, and setting it by hand "
    "removes the check instead of passing it. Editing the specs is allowed — it "
    "withdraws the approval, and `review-specs` judges them again."
)

# The queue's path as it gets typed. `./.caw-tasks/001.md` is the same file as
# `.caw-tasks/001.md`. This carried a `\b` when the directory was `.caw-tasks/`, to keep the
# fragment from matching `subtasks/`; the `.caw-` prefix does that job now, and the dot
# is escaped because an unescaped one matches any character and would widen the pattern.
QUEUE = r"['\"]?(?:\./)*\.caw-tasks/"
# Without case, for the same reason the Edit guard compares without case: on
# APFS and NTFS `.caw-tasks/plan.md` is this file, and a redirect into that spelling
# overwrote it on macOS while an exact match looked the other way.
PLAN = re.compile(rf"{QUEUE}PLAN\.md", re.IGNORECASE)

# One command line does several things; these are what separates them.
SEGMENT = re.compile(r"[;&|]+")

# Shell forms that put bytes into .caw-tasks/. `cp`/`mv` only count when .caw-tasks/ is the
# destination — copying a spec OUT of the queue is a read.
SHELL_WRITES = [
    re.compile(rf">>?\s*{QUEUE}"),
    re.compile(rf"\btee\b[^|;&]*{QUEUE}"),
    re.compile(rf"\b(?:cp|mv|install|rsync)\b[^|;&]*\s{QUEUE}\S*['\"]?\s*(?:$|[;&|])"),
    re.compile(rf"\b(?:rm|touch|mkdir|truncate|del|erase)\b[^|;&]*\s{QUEUE}"),
    re.compile(rf"\bsed\b[^|;&]*-i[^|;&]*{QUEUE}"),
]

# PowerShell's cmdlets, for the sessions whose shell is PowerShell. Redirection
# is spelled the same in both shells, so the forms above already cover
# `> .caw-tasks/PLAN.md`; these are the writes that have no bash twin. `Get-Content`,
# `Get-ChildItem` and `Select-String` are absent on purpose — reading the queue
# is how the queue is inspected, in either shell.
POWERSHELL_WRITES = [
    re.compile(
        r"\b(?:Set-Content|Add-Content|Out-File|Tee-Object|New-Item|Remove-Item"
        rf"|Clear-Content|Rename-Item|Set-ItemProperty)\b[^|;&]*{QUEUE}",
        re.IGNORECASE,
    ),
    # `Copy-Item`/`Move-Item` count only when the queue is where the bytes land,
    # the same asymmetry the `cp`/`mv` pattern above carries: copying a spec OUT
    # is a read. PowerShell can say it either by position or by `-Destination`.
    re.compile(
        rf"\b(?:Copy-Item|Move-Item)\b[^|;&]*\s{QUEUE}\S*['\"]?\s*(?:$|[;&|])",
        re.IGNORECASE,
    ),
    re.compile(rf"\b(?:Copy-Item|Move-Item)\b[^|;&]*-Destination\s+{QUEUE}", re.IGNORECASE),
]

# `New-Item -Path tasks -Name 014.md` composes the path from two arguments and
# never spells `.caw-tasks/` at all — and it is the form PowerShell's own help teaches.
# Either argument order. The name is captured so PLAN.md can be told apart; a
# `New-Item` with `-Path tasks` and no `-Name` is creating the directory, which
# is not a write into it.
NEW_ITEM_COMPOSED = re.compile(
    r"\bNew-Item\b(?=[^|;&]*-Path\s+['\"]?(?:\./)*\.caw-tasks/?['\"]?(?:\s|$))"
    r"[^|;&]*-Name\s+['\"]?([^\s'\"]+)",
    re.IGNORECASE,
)

# Python and shell verbs that write. Paired with a mention of .caw-tasks/ in the same
# text, they identify a script whose job is to rewrite the queue.
#
# The pairing is deliberate and it over-fires, which is the trade. Measured on one
# install: a heredoc that READ a spec and wrote the commit message it built to a
# path outside the queue withdrew the plan's approval, because the write verb and
# the .caw-tasks/ path sat in one segment and nothing checks they are the same path.
# Cost there: a review pass. Narrowing it to verb-and-path-on-one-line would miss
#     p = Path('.caw-tasks/009.md')
#     p.write_text(new)
# which is exactly the script this exists to catch, so the rule stays and the cost
# is written down instead. Two shapes that read the queue without tripping it:
# `cat` the spec into a variable, and build a commit message in a file outside
# .caw-tasks/ then `git commit -F` it.
WRITE_VERBS = [
    re.compile(r"\.write_text\s*\("),
    re.compile(r"\.write_bytes\s*\("),
    re.compile(r"open\s*\([^)]*['\"][wa]"),
    re.compile(r"\.unlink\s*\("),
    re.compile(r"\bos\.(?:remove|rename|replace)\s*\("),
    re.compile(r"\bshutil\.(?:copy|move|rmtree)"),
    re.compile(
        r"\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Clear-Content"
        r"|Rename-Item|Copy-Item|Move-Item)\b",
        re.IGNORECASE,
    ),
]

# A script the command runs carries the program one level away. `cat patcher.py`,
# `git add patcher.py` and `rm patcher.py` only name a file; naming is not running.
#
# The boundary before the interpreter is `(?<![\w.])` and not `\b`, because the tail of a
# filename satisfies `\b`: in `git diff a.py flip.py` the `py` of `a.py` reads as the
# interpreter and `flip.py` as the program it runs. Any command carrying two `.py`
# arguments in a row was affected — `git add`, `cp`, `black`. It fired live on one install,
# denying `git diff` over the hook files themselves, which is exactly when someone is
# checking a guard update.
RUNS_SCRIPT = re.compile(
    r"(?<![\w.])(?:python3?|py|bash|sh|zsh|node|perl|ruby|powershell(?:\.exe)?|pwsh)\s+"
    r"(?:-\S+\s+)*(\S+\.(?:py|sh|ps1))\b"
    r"|(?:^|\s)(\.[/\\]\S+\.(?:py|sh|ps1))\b",
    re.IGNORECASE,
)

# An interpreter reading its program from the command line: `python3 -c '…'`,
# `python3 - <<'EOF'`. The interpreter comes *before* the program, which is what
# separates running a script from storing one: `cat > /tmp/probe.py <<'EOF'` puts
# bytes on disk and does nothing with them, and running that file is caught by the
# branch that reads it back.
RUNS_INLINE = re.compile(
    r"\b(?:python3?|py|bash|sh|zsh|node|perl|ruby)\b[^|;&\n]*?(?:\s-[ce]\b|\s-\s|<<)"
    r"|\b(?:powershell(?:\.exe)?|pwsh)\b[^|;&\n]*?\s-(?:c|command|encodedcommand)\b",
    re.IGNORECASE,
)


def mentions_tasks(text: str) -> bool:
    return ".caw-tasks/" in text


def writes(text: str) -> bool:
    return any(pattern.search(text) for pattern in WRITE_VERBS)


def main() -> None:
    event = read_event()
    command = shell_command(event)
    if not command:
        allow()

    # The pipeline owns .caw-tasks/: it writes every spec, raises the flag and deletes
    # each spec at its commit.
    if "caw.mjs" in command:
        allow()

    # `<repo>/.caw-tasks/001.md` is the queue too, and an
    # absolute path is how half the commands in a session are written. On Windows
    # there are three such spellings and a second separator; `localize` folds all
    # of them into the one form the patterns above read. Everything downstream
    # judges the localized text rather than the raw command, because a script
    # path and a heredoc arrive in the same spellings as a redirect target.
    root = project_root(event)
    localized = localize(command, root)

    # Segment by segment, because one command line does several things: `head
    # .caw-tasks/PLAN.md; touch .caw-tasks/012.md` reads the plan and writes a spec, and
    # judging the whole line would refuse it for naming PLAN.md in the half that
    # only looks. Each SHELL_WRITES pattern already stops at `|;&`, so a match
    # lies inside one segment — this asks which one.
    touched = None
    for segment in SEGMENT.split(localized):
        if any(pattern.search(segment) for pattern in SHELL_WRITES + POWERSHELL_WRITES):
            if PLAN.search(segment):
                deny(PLAN_REASON)
            touched = segment
        composed = NEW_ITEM_COMPOSED.search(segment)
        if composed:
            if composed.group(1).lower() == "plan.md":
                deny(PLAN_REASON)
            touched = segment

    # A heredoc, a `-c` program or a `-Command` string carries its target inside
    # itself, so the whole text is the unit here — there are no segments to tell
    # apart.
    if (
        touched is None
        and RUNS_INLINE.search(localized)
        and mentions_tasks(localized)
        and writes(localized)
    ):
        touched = localized

    # A script the command runs carries it one level away, in the file.
    if touched is None:
        for match in RUNS_SCRIPT.finditer(localized):
            candidate = Path(match.group(1) or match.group(2))
            if not candidate.is_absolute():
                candidate = root / candidate
            try:
                text = localize(candidate.read_text(encoding="utf-8", errors="ignore"), root)
            except OSError:
                continue
            if mentions_tasks(text) and writes(text):
                touched = text
                break

    if touched is None:
        allow()

    if PLAN.search(touched):
        deny(PLAN_REASON)

    invalidate_approval(root, f"shell write into .caw-tasks/: {command.splitlines()[0][:120]}")
    allow()


main()
