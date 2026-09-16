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

# Python and shell verbs that write. Paired with a mention of .caw-tasks/ by
# `queue_writes` below, they identify a program whose job is to rewrite the queue.
#
# The pairing used to be taken over the whole text, and that over-fired four times
# across two installs, each time on a call that never wrote to the queue: a heredoc
# that READ a spec and wrote its commit message outside the queue; a heredoc
# appending to `.gitignore` whose payload merely NAMED the queue; one Bash call
# carrying two unrelated heredocs, the queue named in one and `.write_text(` in the
# other; and a heredoc rewriting a project's gate script, whose new bytes contain
# `spec_path=".caw-tasks/${CAW_SPEC}"` because that is how a gate reads its own spec.
# The last withdrew an approved verdict on an untouched queue and cost $6.74 to
# re-derive; the first two cost $19.69 between them. Three predicates satisfied by
# three different parts of one call is not a write, and `queue_writes` is the
# narrowing.
#
# The last one also retires the workaround the other three left behind. "Do not put
# the queue path in a heredoc" is unfollowable for a project whose gate must name the
# queue to work, which is why block strings are excluded rather than merely split.
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


# Inside a program — a heredoc body, a `-c` string, a script file — statements are
# separated by newlines and `;`. The shell's own `|` and `&` did their separating
# further up, on the command line.
STATEMENT = re.compile(r"[\n;]+")

# `p = Path('.caw-tasks/009.md')` binds the queue to a name and the write lands on
# the name a line later, which is exactly the script this guard exists to catch and
# the reason the pairing was not narrowed to one statement long ago. Binding both
# spellings a program reaches for: Python's `name =` and PowerShell's `$name =`.
# `==` is a comparison, not a binding.
BINDS = re.compile(r"(?:^|[\s(\[,])\$?([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)")


def mentions_tasks(text: str) -> bool:
    return ".caw-tasks/" in text


def writes(text: str) -> bool:
    return any(pattern.search(text) for pattern in WRITE_VERBS)


# A triple-quoted block is CONTENT the program moves around, not code the program runs. The
# distinction is load-bearing here because the one shape that reaches this branch legitimately
# is a script rewriting another script: the queue path sits inside the bytes being written, and
# for a gate that reads its own spec that line is obligatory — `spec_path=".caw-tasks/${CAW_SPEC}"`
# is how such a gate works at all. Measured on one install, that withdrew an approved verdict,
# and the advice "keep the queue path out of your heredocs" is unfollowable for that project.
#
# Blanked rather than dropped, and newlines are kept, so statement boundaries do not move.
BLOCK_STRING = re.compile(r"'{3}[\s\S]*?'{3}|\"{3}[\s\S]*?\"{3}")


def without_block_strings(text: str) -> str:
    return BLOCK_STRING.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def queue_writes(text: str) -> "str | None":
    """The statement whose write verb acts on the queue, or None if none does.

    Both predicates over the whole text is what withdrew three approved verdicts
    over calls that wrote nothing into the queue — see the WRITE_VERBS note. The
    unit is a statement, so a queue path named in a comment, in prose, or in the
    argument of a READ no longer answers for a write verb somewhere else entirely.

    One hop of binding is followed, because dropping it is what the whole-text
    pairing was buying:

        p = Path('.caw-tasks/009.md')
        p.write_text(new)

    A statement naming the queue binds every name it assigns, and a later write
    verb naming one of those is the same write. The hop is deliberately one and
    deliberately syntactic — it over-taints, which is the direction this guard is
    allowed to be wrong in, and it still cannot see a path composed at runtime or
    arriving through an unexpanded shell variable. Those remain stated limits.

    Triple-quoted blocks are blanked first, so a queue path inside the bytes a
    program WRITES neither taints a name nor answers for a write. Without that, a
    script rewriting a gate — the one shape that reaches this branch honestly —
    fires whenever the shell it emits happens to reuse a variable name the Python
    around it also uses. A queue path inside such a block is no longer visible to
    this function at all, which is a deliberate hole: reaching the queue through
    content assembled at runtime needs intent, and this guard never claimed to see
    intent.
    """
    tainted: set[str] = set()
    for statement in STATEMENT.split(without_block_strings(text)):
        holds_queue = mentions_tasks(statement)
        if holds_queue:
            tainted.update(BINDS.findall(statement))
        if not writes(statement):
            continue
        if holds_queue:
            return statement
        if any(re.search(rf"\$?\b{re.escape(name)}\b", statement) for name in tainted):
            return statement
    return None


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
    # itself, so the shell's segments say nothing here — `queue_writes` reads the
    # program's own statements instead, and answers with the one that writes.
    if touched is None and RUNS_INLINE.search(localized):
        touched = queue_writes(localized)

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
            # A gate script is the shape that made this branch matter: it reads the
            # spec CAW_SPEC names and writes its own logs and manifests elsewhere,
            # so over the whole file both predicates hold and neither is about the
            # queue. The statement is the unit here for the same reason it is above.
            hit = queue_writes(text)
            if hit is not None:
                touched = hit
                break

    if touched is None:
        allow()

    if PLAN.search(touched):
        deny(PLAN_REASON)

    invalidate_approval(root, f"shell write into .caw-tasks/: {command.splitlines()[0][:120]}")
    allow()


main()
