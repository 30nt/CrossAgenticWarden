r"""The three PreToolUse guards in this directory, replayed with synthetic payloads.

The guards are the only rules an install's model cannot forget, which makes a
silent regression in them expensive: nothing fails, the queue simply stops
being protected. The dotted path form (`./.caw-tasks/001.md`) was exactly that —
five write shapes out of seven went through the first draft, found by hand
rather than by a gate. So the population lives here. An install that has
pytest runs it with `python3 -m pytest .caw/hooks`; the tool itself has no
test suite and does not run this.

On 2026-08-20 the rule inverted. The first version refused every write under
.caw-tasks/, which forbade the one path that converges — edit the spec, let
`review-specs` judge it — and forbade it for the repository owner too, who works
through sessions with no filesystem of their own. What actually needs protecting
is the verdict, not the text: `approved` rises only when the reviewer finds no
holes. So a spec edit is allowed and withdraws the approval, while `PLAN.md`,
which carries the flag, stays refused. These tests assert both halves, because a
guard that allows the edit without withdrawing the verdict is worse than the
refusal it replaced.

On 2026-08-21 the same class of silent hole was found again, on a Windows machine
one install is worked on from rather than in the patterns: four probes, four holes.
`.caw-tasks\PLAN.md`, `C:\…\.caw-tasks\PLAN.md` and the Git Bash `/c/Users/…/.caw-tasks/PLAN.md`
all walked past a guard that refuses `.caw-tasks/PLAN.md`; the session's own shell tool
is PowerShell, which the `Bash` matcher never named at all; and the launch form
this machine is obliged to use — `env -u CLAUDECODE … node caw.mjs plan` — was the
one form the log guard did not recognise as a run. The suite was green through all
four, which is the point: it only knew the POSIX spellings. Every case below that
carries a backslash, a cmdlet or an `env` flag is one of those holes, and the
wiring itself is asserted too, since a guard the harness never calls is not a
guard.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


HOOKS = Path(__file__).resolve().parent
# The install this directory sits in: `.caw/hooks/` is two levels down from it.
SETTINGS = HOOKS.parents[1] / ".claude" / "settings.json"

# Assembled from fragments rather than written out. `deny_tasks_bash.py` reads
# any `.py` file a command runs, so a literal queue path sitting next to a literal
# write call would make this test file look like a queue-rewriting script.
QUEUE = ".caw-tas" + "ks/"
QUEUE_WIN = QUEUE.replace("/", "\\")
WRITE_CALL = ".write" + "_text("

INLINE_SCRIPT = f'python3 -c \'from pathlib import Path; Path("{QUEUE}x.md"){WRITE_CALL}"y")\''
HEREDOC_SCRIPT = f'python3 - <<"EOF"\nPath("{QUEUE}x.md"){WRITE_CALL}"y")\nEOF'
STORED_SCRIPT = f'cat > /tmp/probe.py <<"EOF"\nPath("{QUEUE}x.md"){WRITE_CALL}"y")\nEOF'

APPROVED_PLAN = "---\napproved: true\n---\n\n# Plan\n\nbody\n"


def decide(
    hook: str,
    tool_input: dict,
    project_dir: Path,
    *,
    tool_name=None,
) -> tuple[str, str]:
    """Run one guard over one payload and return its (decision, reason).

    `project_dir` is required, never defaulted to the repository root: the guards
    have side effects — `invalidate_approval` rewrites `.caw-tasks/PLAN.md` and
    `require_caw_log.py` prunes `.caw-logs/` — and a hook run against the real
    root performs them against the real repository. One install paid for the
    default on 2026-08-21: the fast gate inside a `build` ran these tests, an
    "allow" case withdrew the approval of the very plan being built, and the
    restart refused until a hand raised the flag again.

    Silence is consent: a guard that prints nothing has allowed the call, which
    is why empty stdout maps to "allow" rather than to an error.

    A crash is reported as its own verdict rather than as silence. The harness
    treats a hook that exits non-zero as a hook error and refuses the tool call
    outright — on 2026-08-20 a missing hook file locked a session out of both
    Bash and Edit — so "the guard died" must never read here as "the guard
    allowed it".
    """
    event = {"tool_input": tool_input, "cwd": str(project_dir)}
    if tool_name:
        event.update({"tool_name": tool_name, "hook_event_name": "PreToolUse"})
    completed = subprocess.run(
        [sys.executable, str(HOOKS / hook)],
        input=json.dumps(event),
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "CLAUDE_PROJECT_DIR": str(project_dir)},
    )

    if completed.returncode != 0:
        return "crash", completed.stderr.strip()[-300:]

    if not completed.stdout.strip():
        return "allow", ""

    output = json.loads(completed.stdout)["hookSpecificOutput"]
    return output["permissionDecision"], output["permissionDecisionReason"]


def git_bash_root(root: Path) -> str:
    r"""The root as the Git Bash mount spells it: `/c/Users/…` for `C:\Users\…`.

    Nothing to translate on POSIX, where the answer is the root itself — so a
    case built on this asserts the same property on both platforms: an absolute
    path in the spelling the local shell hands out reaches the queue. Without it
    the Windows hole would be untestable anywhere the gate actually runs green.
    """
    drive = root.drive
    if drive.endswith(":"):
        return f"/{drive[0].lower()}{root.as_posix()[len(drive) :]}"
    return root.as_posix()


def spell(text: str, root: Path) -> str:
    """Fill the two root placeholders a case may carry."""
    return text.replace("{root}", str(root)).replace("{gitbash}", git_bash_root(root))


def queue_with_approved_plan(root: Path) -> Path:
    """Build a .caw-tasks/ holding one spec and a plan that reads `approved: true`."""
    tasks = root / ".caw-tasks"
    tasks.mkdir()
    (tasks / "PLAN.md").write_text(APPROVED_PLAN, encoding="utf-8")
    (tasks / "001_thing.md").write_text("# spec\n", encoding="utf-8")
    (tasks / "notes.log").write_text("a note\n", encoding="utf-8")
    return tasks


@pytest.mark.parametrize(
    ("file_path", "expected"),
    [
        (f"{QUEUE}PLAN.md", "deny"),
        (f"./{QUEUE}PLAN.md", "deny"),
        (f"{{root}}/{QUEUE}PLAN.md", "deny"),
        (f"{QUEUE_WIN}PLAN.md", "deny"),
        (f"{{root}}\\{QUEUE_WIN}PLAN.md", "deny"),
        (f"{{gitbash}}/{QUEUE}PLAN.md", "deny"),
        (f"{QUEUE}plan.md", "deny"),
        (f"{QUEUE}001_x.md", "allow"),
        (f"{QUEUE_WIN}001_x.md", "allow"),
        (f"{QUEUE}sub/x.md", "allow"),
        (f"{QUEUE}notes.log", "allow"),
        (f"{{root}}/{QUEUE}001_x.md", "allow"),
        ("src/main.py", "allow"),
        ("caw.mjs", "allow"),
        (f"docs/workflow/{QUEUE}notes.md", "allow"),
    ],
)
def test_edit_guard(file_path: str, expected: str, tmp_path: Path) -> None:
    """Only PLAN.md is refused; every other path, in or out of the queue, goes through.

    `{root}` stands for the project root the guard resolves — a temp one here,
    so the absolute-path cases exercise localization without the side effects
    landing in the real repository. `{gitbash}` is the same root as the Git Bash
    mount spells it, and the backslash cases are the Windows separator: three
    spellings of one file, which is what the Edit tool actually hands over
    depending on which shell the caller was thinking in.
    """
    decision, _ = decide(
        "deny_tasks_edit.py",
        {"file_path": spell(file_path, tmp_path)},
        project_dir=tmp_path,
    )

    assert decision == expected


def test_edit_guard_refusal_points_at_the_open_path(tmp_path: Path) -> None:
    """Refusing PLAN.md is only defensible while editing the specs is open, so it says so.

    A refusal that names no alternative is the kind people route around: the
    reader wanted to fix a plan, and the answer has to tell them where that is
    done.
    """
    _, reason = decide("deny_tasks_edit.py", {"file_path": f"{QUEUE}PLAN.md"}, project_dir=tmp_path)

    assert "approved" in reason
    assert "review-specs" in reason


def test_editing_a_spec_withdraws_the_approval(tmp_path: Path) -> None:
    """The verdict goes down with the edit — this is what replaced refusing the edit.

    Asserted on intent, before the write happens: the guard cannot see whether
    the edit succeeds, and a flag left up on a spec that did change is the
    failure worth avoiding.
    """
    tasks = queue_with_approved_plan(tmp_path)

    decision, _ = decide(
        "deny_tasks_edit.py", {"file_path": f"{QUEUE}001_thing.md"}, project_dir=tmp_path
    )

    assert decision == "allow"
    assert "approved: false" in (tasks / "PLAN.md").read_text()
    assert "approval withdrawn" in (tmp_path / ".caw-logs" / "invalidations.log").read_text()


def test_editing_a_non_spec_leaves_the_approval(tmp_path: Path) -> None:
    """`notes.log` and a request text are parked in the queue, not built from it."""
    tasks = queue_with_approved_plan(tmp_path)

    decide("deny_tasks_edit.py", {"file_path": f"{QUEUE}notes.log"}, project_dir=tmp_path)

    assert "approved: true" in (tasks / "PLAN.md").read_text()


@pytest.mark.parametrize(
    ("patch", "expected"),
    [
        ("*** Begin Patch\n*** Update File: .caw-tasks/PLAN.md\n@@\n-old\n+new\n*** End Patch", "deny"),
        ("*** Begin Patch\n*** Delete File: .caw-tasks\\plan.md\n*** End Patch", "deny"),
        ("*** Begin Patch\n*** Add File: {root}/.caw-tasks/PLAN.md\n+x\n*** End Patch", "deny"),
        ("diff --git a/.caw-tasks/PLAN.md b/.caw-tasks/PLAN.md\n--- a/.caw-tasks/PLAN.md\n+++ b/.caw-tasks/PLAN.md", "deny"),
        ("*** Begin Patch\n*** Add File: .caw-tasks/014_new.md\n+x\n*** End Patch", "allow"),
        ("*** Begin Patch\n*** Update File: src/main.py\n@@\n-x\n+y\n*** End Patch", "allow"),
    ],
)
def test_codex_patch_paths_replay_the_shared_edit_policy(
    patch: str, expected: str, tmp_path: Path
) -> None:
    """Codex apply_patch carries paths in command text instead of file_path."""
    queue_with_approved_plan(tmp_path)
    decision, _ = decide(
        "deny_tasks_edit.py",
        {"command": spell(patch, tmp_path)},
        project_dir=tmp_path,
        tool_name="apply_patch",
    )

    assert decision == expected
    if "014_new.md" in patch:
        assert "approved: false" in (tmp_path / ".caw-tasks" / "PLAN.md").read_text()


@pytest.mark.parametrize("path_key", ["file_path", "path", "target_path", "destination"])
def test_direct_file_operations_share_path_normalization(path_key: str, tmp_path: Path) -> None:
    """Claude direct edits and Codex/local write tools reach the same path policy."""
    decision, _ = decide(
        "deny_tasks_edit.py",
        {path_key: ".caw-tasks/PLAN.md"},
        project_dir=tmp_path,
        tool_name="Write",
    )

    assert decision == "deny"


def test_codex_bash_alias_replays_shell_and_capture_policies(tmp_path: Path) -> None:
    """Codex reports unified exec as Bash and keeps the command in the shared field."""
    queue_with_approved_plan(tmp_path)
    queue = decide(
        "deny_tasks_bash.py",
        {"command": "printf x > .caw-tasks/015_codex.md"},
        project_dir=tmp_path,
        tool_name="Bash",
    )
    uncaptured = decide(
        "require_caw_log.py",
        {"command": "node caw.mjs plan x"},
        project_dir=tmp_path,
        tool_name="Bash",
    )

    assert queue[0] == "allow"
    assert "approved: false" in (tmp_path / ".caw-tasks" / "PLAN.md").read_text()
    assert uncaptured[0] == "deny"


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        (f"echo x > {QUEUE}PLAN.md", "deny"),
        (f"sed -i '' 's/false/true/' {QUEUE}PLAN.md", "deny"),
        (f"cp /tmp/x.md ./{QUEUE}PLAN.md", "deny"),
        (f"rm {{root}}/{QUEUE}PLAN.md", "deny"),
        (f"echo x > {QUEUE}001.md", "allow"),
        (f"echo x > ./{QUEUE}001.md", "allow"),
        (f"rm ./{QUEUE}001.md", "allow"),
        (f"cp /tmp/x.md {{root}}/{QUEUE}014_new.md", "allow"),
        (INLINE_SCRIPT, "allow"),
        (HEREDOC_SCRIPT, "allow"),
        (f"cat {QUEUE}001_x.md", "allow"),
        (f"ls -la {QUEUE}", "allow"),
        (f"grep -rn done_when {QUEUE}", "allow"),
        (f"wc -l {QUEUE}PLAN.md", "allow"),
        (f"cp {QUEUE}001.md /tmp/x.md", "allow"),
        (f"echo hi | tee docs/sub{QUEUE}notes.md", "allow"),
        (f"head -3 {QUEUE}PLAN.md; touch {QUEUE}012.md", "allow"),
        (f"grep -n approved {QUEUE}PLAN.md && rm {QUEUE}013.md", "allow"),
        ("node caw.mjs build > .caw-logs/b.log 2>&1", "allow"),
        (STORED_SCRIPT, "allow"),
        ("", "allow"),
        # The Windows spellings of the same file, all three of which went
        # through the POSIX-only patterns on 2026-08-21.
        (f"echo x > {QUEUE_WIN}PLAN.md", "deny"),
        (f"rm {{root}}\\{QUEUE_WIN}PLAN.md", "deny"),
        (f"echo x > {{gitbash}}/{QUEUE}PLAN.md", "deny"),
        (f"echo x > {QUEUE_WIN}001.md", "allow"),
        (f"cat {QUEUE_WIN}PLAN.md", "allow"),
        # PowerShell, the shell the session on that machine actually gets.
        (f"Set-Content -Path {QUEUE_WIN}PLAN.md -Value x", "deny"),
        (f"Out-File -FilePath {QUEUE}PLAN.md", "deny"),
        (f"Remove-Item {QUEUE_WIN}PLAN.md", "deny"),
        (f"Copy-Item C:\\tmp\\x.md -Destination {QUEUE_WIN}PLAN.md", "deny"),
        (f"Set-Content {{root}}\\{QUEUE_WIN}PLAN.md x", "deny"),
        (f'powershell -NoProfile -Command "Set-Content {QUEUE}PLAN.md x"', "deny"),
        (f"New-Item -ItemType File {QUEUE_WIN}014.md", "allow"),
        (f"Add-Content {QUEUE}001.md -Value x", "allow"),
        (f"Move-Item x.md {QUEUE_WIN}014.md", "allow"),
        (f"Copy-Item {QUEUE_WIN}001.md C:\\tmp\\x.md", "allow"),
        (f"Get-Content {QUEUE_WIN}PLAN.md", "allow"),
        (f"Get-ChildItem {QUEUE_WIN}", "allow"),
        (f"Select-String -Path {QUEUE}*.md -Pattern done_when", "allow"),
        # The filesystems these sessions mostly run on do not care about case, so
        # neither does the refusal: measured on macOS, a redirect into
        # `.caw-tasks/plan.md` overwrote PLAN.md while the exact match looked away.
        (f"echo x > {QUEUE}plan.md", "deny"),
        (f"Set-Content {QUEUE_WIN}plan.md -Value x", "deny"),
        # The composed form PowerShell's own help teaches, which never spells
        # `.caw-tasks/` at all. A `-Path tasks` with no `-Name` creates the directory.
        (f"New-Item -Path {QUEUE[:-1]} -Name PLAN.md -ItemType File", "deny"),
        (f"New-Item -ItemType File -Name plan.md -Path .\\{QUEUE[:-1]}", "deny"),
        (f"New-Item -Path {QUEUE[:-1]} -Name 014.md -ItemType File", "allow"),
        (f"New-Item -Path {QUEUE[:-1]} -ItemType Directory", "allow"),
    ],
)
def test_bash_guard(command: str, expected: str, tmp_path: Path) -> None:
    """A shell write into PLAN.md is refused; every other queue write goes through.

    Reading PLAN.md stays allowed — `wc -l` on it is how the queue is inspected,
    and a guard that refuses to let anyone look at the file it protects is one
    people switch off. That half is asserted per shell, because PowerShell reads
    the queue with different verbs and a guard that cannot tell `Get-Content`
    from `Set-Content` fails in the direction that gets it disabled.

    `Copy-Item` out of the queue is a read and `Copy-Item -Destination` into it is
    a write — the same asymmetry `cp` already carried, asserted here because the
    cmdlet can name its destination two ways.

    `{root}` and `{gitbash}` resolve to a temp root so the allowed queue writes
    withdraw a temp approval, not the real one.
    """
    decision, _ = decide(
        "deny_tasks_bash.py",
        {"command": spell(command, tmp_path)},
        project_dir=tmp_path,
    )

    assert decision == expected


@pytest.mark.parametrize(
    "command",
    [
        "echo x > " + QUEUE + "001_thing.md",
        "rm ./" + QUEUE + "001_thing.md",
        "cp /tmp/x.md " + QUEUE + "014_new.md",
        "touch " + QUEUE + "002_second.md",
        "echo x > " + QUEUE_WIN + "001_thing.md",
        "New-Item -ItemType File " + QUEUE_WIN + "015_new.md",
        "Remove-Item " + QUEUE_WIN + "001_thing.md",
        "Set-Content -Path " + QUEUE + "001_thing.md -Value x",
        "New-Item -Path " + QUEUE[:-1] + " -Name 015_new.md -ItemType File",
    ],
)
def test_a_shell_write_withdraws_the_approval(command: str, tmp_path: Path) -> None:
    """Adding a spec and deleting one count as much as rewriting one.

    The plan was approved for the thirteen specs that were there. A fourteenth,
    or a twelfth, makes the verdict describe a queue that is not on disk any
    more — so the flag comes down for any write, not only for an edit in place.
    """
    tasks = queue_with_approved_plan(tmp_path)

    decision, _ = decide("deny_tasks_bash.py", {"command": command}, project_dir=tmp_path)

    assert decision == "allow"
    assert "approved: false" in (tasks / "PLAN.md").read_text()


# Assembled like the three above it, so this file is not itself a queue-rewriting script
# when the guard reads it back.
GITIGNORE_HEREDOC = (
    "python3 - <<'PY'\n"
    "from pathlib import Path\n"
    "p = Path('.gitignore')\n"
    "p" + WRITE_CALL + "p.read_text() + 'docs/caw/\\n')\n"
    "# the ignore list also covers " + QUEUE + " and .caw-logs/\n"
    "PY"
)
TWO_HEREDOCS = (
    "cat > docs/harness/report.md <<'EOF'\n"
    "The approval flag is raised by review-specs over " + QUEUE + ", once it finds no holes.\n"
    "EOF\n"
    "python3 - <<'PY'\n"
    "from pathlib import Path\n"
    "Path('docs/other.md')" + WRITE_CALL + "'x')\n"
    "PY"
)
# The gate this rewrites must name the queue to read its own spec, so "keep the queue path
# out of your heredocs" is unfollowable for the project that met this.
TRIPLE = "'" * 3
REWRITES_A_GATE = (
    "python3 - <<'PY'\n"
    "import pathlib\n"
    'p = pathlib.Path("scripts/gate_fast.sh")\n'
    "s = p.read_text()\n"
    "new = " + TRIPLE + "\n"
    '  spec_path="' + QUEUE + '${CAW_SPEC}"\n'
    + TRIPLE + "\n"
    "p" + WRITE_CALL + "s[:start] + new + s[end:])\n"
    "PY"
)
# The same, where the shell being written happens to bind the same name the Python around it
# writes through. One hop of taint hits this; blanking block strings is what stops it.
REWRITES_A_GATE_NAME_COLLISION = (
    "python3 - <<'PY'\n"
    "import pathlib\n"
    'p = pathlib.Path("scripts/gate_fast.sh")\n'
    "new = " + TRIPLE + "\n"
    'p="' + QUEUE + '${CAW_SPEC}"\n'
    + TRIPLE + "\n"
    "p" + WRITE_CALL + "new)\n"
    "PY"
)
# Both halves of the catch this guard exists for, so narrowing never quietly removes them.
BINDS_THEN_WRITES = (
    "python3 - <<'PY'\n"
    "from pathlib import Path\n"
    "p = Path('" + QUEUE + "009.md')\n"
    "p" + WRITE_CALL + "new)\n"
    "PY"
)


@pytest.mark.parametrize(
    "command",
    [
        GITIGNORE_HEREDOC,
        TWO_HEREDOCS,
        REWRITES_A_GATE,
        REWRITES_A_GATE_NAME_COLLISION,
    ],
)
def test_a_call_that_never_writes_to_the_queue_keeps_the_approval(
    command: str, tmp_path: Path
) -> None:
    """Three predicates satisfied by three different parts of one call is not a write.

    Measured: three false withdrawals across two installs, each over a call that
    read the queue or merely named it. Priced twice — $19.69 for the first two
    re-judgements, and $6.74 for one re-derivation of a verdict that already
    existed on an untouched queue. The write verb and the queue path are now
    paired per statement, following one hop of binding, with the bytes a program
    WRITES excluded from both halves.
    """
    tasks = queue_with_approved_plan(tmp_path)

    decision, _ = decide("deny_tasks_bash.py", {"command": command}, project_dir=tmp_path)

    assert decision == "allow"
    assert "approved: true" in (tasks / "PLAN.md").read_text()


@pytest.mark.parametrize("command", [INLINE_SCRIPT, HEREDOC_SCRIPT, BINDS_THEN_WRITES])
def test_a_program_that_does_write_the_queue_still_withdraws(
    command: str, tmp_path: Path
) -> None:
    """The narrowing above must not cost the catch it was narrowed around.

    `BINDS_THEN_WRITES` is why the pairing was never reduced to one statement:
    the queue is bound to a name and the write lands on the name a line later.
    """
    tasks = queue_with_approved_plan(tmp_path)

    decision, _ = decide("deny_tasks_bash.py", {"command": command}, project_dir=tmp_path)

    assert decision == "allow"
    assert "approved: false" in (tasks / "PLAN.md").read_text()


def test_reading_the_queue_leaves_the_approval(tmp_path: Path) -> None:
    """Inspecting the queue is not changing it, and must not cost a review round.

    Both shells, because both are how people look: a session on Windows reaches
    for `Get-Content` where one on macOS reaches for `cat`, and withdrawing a
    verdict over a read costs a `review-specs` round for nothing.
    """
    tasks = queue_with_approved_plan(tmp_path)

    for command in (
        f"cat {QUEUE}001_thing.md",
        f"ls {QUEUE}",
        f"grep -rn x {QUEUE}",
        f"Get-Content {QUEUE_WIN}001_thing.md",
        f"Get-ChildItem {QUEUE_WIN}",
        f"Select-String -Path {QUEUE}001_thing.md -Pattern x",
    ):
        decide("deny_tasks_bash.py", {"command": command}, project_dir=tmp_path)

    assert "approved: true" in (tasks / "PLAN.md").read_text()


def test_the_pipeline_itself_never_withdraws_the_approval(tmp_path: Path) -> None:
    """`review-specs` raises the flag; a guard that lowered it right after would loop."""
    tasks = queue_with_approved_plan(tmp_path)

    decision, _ = decide(
        "deny_tasks_bash.py",
        {"command": 'node caw.mjs review-specs "x" > .caw-logs/r.log 2>&1'},
        project_dir=tmp_path,
    )

    assert decision == "allow"
    assert "approved: true" in (tasks / "PLAN.md").read_text()


def test_bash_guard_reads_a_script_only_when_the_command_runs_it(tmp_path: Path) -> None:
    """A patch script matters when run, not when mentioned — `rm probe.py` is not a write."""
    queue_with_approved_plan(tmp_path)
    patcher = tmp_path / "patcher.py"
    patcher.write_text(f'from pathlib import Path\nPath("{QUEUE}x.md"){WRITE_CALL}"y")\n')

    run = decide("deny_tasks_bash.py", {"command": "python3 patcher.py"}, project_dir=tmp_path)
    mention = decide("deny_tasks_bash.py", {"command": "rm patcher.py"}, project_dir=tmp_path)

    assert run[0] == "allow"
    assert "approved: false" in (tmp_path / ".caw-tasks" / "PLAN.md").read_text()
    assert mention[0] == "allow"


def test_a_script_that_rewrites_the_plan_is_still_refused(tmp_path: Path) -> None:
    """The refusal follows the target, not the route: a script naming PLAN.md is a script."""
    queue_with_approved_plan(tmp_path)
    patcher = tmp_path / "flip.py"
    patcher.write_text(
        f'from pathlib import Path\nPath("{QUEUE}PLAN.md"){WRITE_CALL}"approved: true")\n'
    )

    decision, _ = decide("deny_tasks_bash.py", {"command": "python3 flip.py"}, project_dir=tmp_path)

    assert decision == "deny"


def test_a_second_script_argument_is_not_a_program(tmp_path: Path) -> None:
    """`git diff a.py flip.py` runs nothing: the tail of a filename is not an interpreter."""
    queue_with_approved_plan(tmp_path)
    flip = tmp_path / "flip.py"
    flip.write_text(
        f'from pathlib import Path\nPath("{QUEUE}PLAN.md"){WRITE_CALL}"approved: true")\n'
    )

    pair = decide(
        "deny_tasks_bash.py",
        {"command": "git diff --numstat spec.py flip.py"},
        project_dir=tmp_path,
    )
    run = decide("deny_tasks_bash.py", {"command": "python3 flip.py"}, project_dir=tmp_path)

    assert pair[0] == "allow"
    assert run[0] == "deny"


@pytest.mark.parametrize(
    ("target", "expected"),
    [("PLAN.md", "deny"), ("x.md", "allow")],
)
def test_bash_guard_reads_a_powershell_script_it_runs(
    target: str, expected: str, tmp_path: Path
) -> None:
    """A `.ps1` carries the write one level away exactly as a `.py` does.

    The Python branch was there from the first draft because the machine of the
    day ran Python; the same route through `powershell -File patch.ps1` was not,
    and it is the cheaper one to reach for on Windows.
    """
    queue_with_approved_plan(tmp_path)
    (tmp_path / "patch.ps1").write_text(
        f"Set-Content -Path {QUEUE_WIN}{target} -Value y\n", encoding="utf-8"
    )

    decision, _ = decide(
        "deny_tasks_bash.py", {"command": "powershell -File patch.ps1"}, project_dir=tmp_path
    )

    assert decision == expected
    if expected == "allow":
        assert "approved: false" in (tmp_path / ".caw-tasks" / "PLAN.md").read_text()


def test_a_script_spelling_the_plan_with_a_doubled_backslash_is_still_refused(
    tmp_path: Path,
) -> None:
    """`".caw-tasks\\\\PLAN.md"` is how a non-raw Python string names the file on Windows.

    `localize` turns both backslashes into slashes, and `.caw-tasks//PLAN.md` is not
    `.caw-tasks/PLAN.md` to a pattern. Measured on macOS before the collapse: the
    script below was allowed with the approval withdrawn — which is exactly the
    state a hand-written `approved: true` then overwrites.
    """
    queue_with_approved_plan(tmp_path)
    patcher = tmp_path / "flip.py"
    patcher.write_text(
        'from pathlib import Path\nPath("' + QUEUE[:-1] + '\\\\PLAN.md")' + WRITE_CALL + '"approved: true")\n'
    )

    decision, _ = decide("deny_tasks_bash.py", {"command": "python3 flip.py"}, project_dir=tmp_path)

    assert decision == "deny"


def test_bash_guard_does_not_see_a_path_hidden_in_a_variable(tmp_path: Path) -> None:
    """The stated limit, asserted so it stays a known one rather than a surprise.

    `python3 "$S/patch.py"` reaches the shell with the path unexpanded, so there
    is nothing on disk at that name for the guard to read. Closing this class
    needs filesystem permissions or a check inside `caw.mjs` comparing the specs
    against what was judged; a regex over a command line cannot.
    """
    queue_with_approved_plan(tmp_path)
    patcher = tmp_path / "patcher.py"
    patcher.write_text(f'from pathlib import Path\nPath("{QUEUE}x.md"){WRITE_CALL}"y")\n')

    decision, _ = decide(
        "deny_tasks_bash.py", {"command": 'python3 "$S/patcher.py"'}, project_dir=tmp_path
    )

    assert decision == "allow"
    assert "approved: true" in (tmp_path / ".caw-tasks" / "PLAN.md").read_text()


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ('node caw.mjs plan "x"', "deny"),
        ('node caw.mjs review-specs "x"', "deny"),
        ('node caw.mjs ship "x"', "deny"),
        ("caffeinate -dims node caw.mjs build", "deny"),
        ("echo hi && node caw.mjs build", "deny"),
        ('NODE_OPTIONS=--x node caw.mjs plan "y"', "deny"),
        ('node caw.mjs plan "x" > .caw-logs/p.log 2>&1', "allow"),
        ("caffeinate -dims node caw.mjs build > .caw-logs/b.log 2>&1", "allow"),
        ("node caw.mjs build | tee .caw-logs/b.log", "allow"),
        ('grep -n "node caw.mjs plan" CLAUDE.md', "allow"),
        ("node caw.mjs --help", "allow"),
        # `done` spawns no agent and costs nothing, so it is not a run.
        ("node caw.mjs done 007_x.md", "allow"),
        # `round` and `review` each spend model calls and produce a verdict whose
        # text lives nowhere else, so both are runs and both owe a log. The pair
        # below is the whole point: adding a subcommand to the tool without adding
        # it here exempts it from being saved, silently.
        ("node caw.mjs round 001_x.md", "deny"),
        ("node caw.mjs review 001_x.md", "deny"),
        ("node caw.mjs round 001_x.md > .caw-logs/r.log 2>&1", "allow"),
        ("node caw.mjs review 001_x.md > .caw-logs/r.log 2>&1", "allow"),
        # `review` must not swallow `review-specs`: they take different arguments
        # and a guard reading one as the other would still be enforcing a log, but
        # this pins that the older spelling is matched on its own terms.
        ('node caw.mjs review-specs "x" > .caw-logs/r.log 2>&1', "allow"),
        ("git log --oneline", "allow"),
        # The launch form this repository is obliged to use on Windows: Claude
        # Code refuses to start inside its own session, so the nesting markers
        # are unset with `env -u` and the binary named through CAW_CLAUDE. The
        # guard skipped it for a year of runs' worth of money.
        (
            "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT "
            'CAW_CLAUDE=/c/x/claude.exe node caw.mjs plan "x"',
            "deny",
        ),
        (
            "env -u CLAUDECODE node caw.mjs build > .caw-logs/b.log 2>&1",
            "allow",
        ),
        ("node caw.mjs build > .caw-logs\\b.log 2>&1", "allow"),
        ('node.exe caw.mjs plan "x"', "deny"),
        ('powershell -NoProfile -Command "node caw.mjs build"', "deny"),
        ('$env:CAW_CLAUDE="c:/x.exe"; node caw.mjs plan "x"', "deny"),
    ],
)
def test_log_guard(command: str, expected: str, tmp_path: Path) -> None:
    """A pipeline run needs a log; quoting the command in a grep is not a run.

    A temp root here is load-bearing twice over: the guard prunes `.caw-logs/`
    on every allowed run, and pruning the real directory from a unit test is
    how a session silently loses its planning history.
    """
    decision, _ = decide("require_caw_log.py", {"command": command}, project_dir=tmp_path)

    assert decision == expected


def hook_wiring() -> dict[str, set[str]]:
    """Map each guard script to the tool names the settings file points at it."""
    if not SETTINGS.is_file():
        pytest.skip("no .claude/settings.json two levels up — the tool's own repository wires nothing")
    settings = json.loads(SETTINGS.read_text(encoding="utf-8"))
    wiring: dict[str, set[str]] = {}
    for group in settings["hooks"]["PreToolUse"]:
        tools = set(group["matcher"].split("|"))
        for hook in group["hooks"]:
            script = hook["command"].rsplit("/", 1)[-1].strip('"')
            wiring.setdefault(script, set()).update(tools)
    return wiring


@pytest.mark.parametrize(
    ("script", "tools"),
    [
        ("deny_tasks_bash.py", {"Bash", "PowerShell"}),
        ("require_caw_log.py", {"Bash", "PowerShell"}),
        ("deny_tasks_edit.py", {"Edit", "Write"}),
    ],
)
def test_every_guard_is_wired_to_every_tool_that_can_reach_the_queue(
    script: str, tools: set[str]
) -> None:
    """A guard the harness never calls is not a guard, and nothing else notices.

    This is the hole that was live on 2026-08-21 and cost nothing to find only
    because someone went looking: the matcher named `Bash`, the shell tool on
    this machine is `PowerShell`, and a probe wrote into the queue in silence
    while every case above stayed green. The patterns can be tested by replaying
    payloads; the wiring can only be read off the file the harness reads, so it
    is read here.
    """
    assert tools <= hook_wiring().get(script, set())


def test_every_wired_guard_exists_on_disk() -> None:
    """A missing hook file is a hook error, and a hook error refuses the tool call.

    On 2026-08-20 renaming these files mid-session locked the session out of Bash
    and Edit at once — the harness reads `settings.json` at start and cannot be
    told the file moved. A rename that lands without its settings edit is a dead
    session, so the pair is asserted rather than remembered.
    """
    missing = [script for script in hook_wiring() if not (HOOKS / script).is_file()]

    assert missing == []


def test_log_guard_prunes_to_the_newest_twenty(tmp_path: Path) -> None:
    """The event that fills `.caw-logs/` trims it, so nobody has to remember."""
    logs = tmp_path / ".caw-logs"
    logs.mkdir()
    for minute in range(25):
        stale = logs / f"run-{minute:02d}.log"
        stale.touch()
        os.utime(stale, (minute, minute))

    decision, _ = decide(
        "require_caw_log.py",
        {"command": "node caw.mjs build > .caw-logs/b.log 2>&1"},
        project_dir=tmp_path,
    )

    survivors = sorted(p.name for p in logs.iterdir())
    assert decision == "allow"
    assert survivors == [f"run-{minute:02d}.log" for minute in range(5, 25)]


def test_log_guard_exempts_what_cannot_be_reproduced(tmp_path: Path) -> None:
    """Both exempt kinds survive, and neither is counted against KEEP.

    Given the oldest mtimes in the directory, so a pruner that merely forgot to
    delete them — rather than excluding them from the count — would still drop two
    logs that should have lived. `diverged-` was written to this directory once
    under the impression that the exemption already covered it; it did not.
    """
    logs = tmp_path / ".caw-logs"
    logs.mkdir()
    for name in ("blocked-004_api.patch", "diverged-001_cells.md"):
        keepsake = logs / name
        keepsake.touch()
        os.utime(keepsake, (0, 0))
    for minute in range(1, 26):
        stale = logs / f"run-{minute:02d}.log"
        stale.touch()
        os.utime(stale, (minute, minute))

    decision, _ = decide(
        "require_caw_log.py",
        {"command": "node caw.mjs build > .caw-logs/b.log 2>&1"},
        project_dir=tmp_path,
    )

    survivors = sorted(p.name for p in logs.iterdir())
    assert decision == "allow"
    assert "blocked-004_api.patch" in survivors
    assert "diverged-001_cells.md" in survivors
    assert [p for p in survivors if p.endswith(".log")] == [
        f"run-{minute:02d}.log" for minute in range(6, 26)
    ]
