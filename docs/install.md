# Installing Cross-Agentic Warden

A minimal agentic pipeline. An architect splits a request into tasks, an executor implements
them one at a time, a reviewer judges each one, an enumerator says what the request implied,
and `caw.mjs` holds the whole thing together. Roles bind explicitly to trusted provider adapters;
the engine owns the protocol, schemas, gates, state and commits. The reviewer may mutate only an
engine-owned isolated surface, while only the executor may mutate delivery.

*[Русская версия](install.ru.md)*

This file is the installation manual, and it is long because most of it is a hazard somebody
already walked into. [README.md](../README.md) is the short version,
[WHY.md](../WHY.md) is why the tool is this small, and
[limitations.md](limitations.md) is what is proven, unexercised or broken in it right now.

Two steps of this procedure have their own file, because each is a job rather than a step:
[gate.md](gate.md) is how to write a gate command that does not lie, and
[updating.md](updating.md) is how to move a vendored copy to a new version.

## Prerequisites

- **Node 18+.**
- **An outer filesystem boundary for the host.** Every bounded role — the two planning roles, the
  executor and the reviewer — runs inside one, and a host without it publishes no bounded row, so
  preflight refuses every pipeline command. Claude has two implementations of that one mechanism:
  the **macOS arm64** seatbelt through `/usr/bin/sandbox-exec`, and **Linux** through
  **`bubblewrap`** (`bwrap` on `PATH`; `apt install bubblewrap`, `dnf install bubblewrap`). Neither
  is installed for you and neither is substituted for the other. **Presence is not capability:**
  a default Docker container ships `bwrap` and denies the unprivileged user namespace it needs,
  and Ubuntu 24.04 restricts that namespace through AppArmor. The adapters run the helper once
  rather than looking for the file, so such a host refuses before it spends — but you have to
  lift the restriction to get a boundary at all. **Do not run the pipeline as root on Linux**
  either: measured in a container, the case asserting that a write outside the review surface is
  denied passes as an ordinary user and fails as root. Codex is macOS arm64 only — its
  adapter still names seatbelt directly — so a Linux host runs Claude rows and refuses Codex rows.
  The refusal names the guarantee, not the missing helper: `architect requires
  writeScope=engine-private-only; adapter field is shell-residual-delivery` is what a missing
  `bwrap` looks like.
- **Every provider executable named by `.caw/runtime.json`.** Claude resolves as
  `CAW_CLAUDE` or `claude`; Codex resolves as `CAW_CODEX` or `codex`. Executable overrides and
  credentials stay environment-owned, never in the runtime file. The currently measured Codex
  executor/reviewer path is macOS arm64 and exact-version probed: a new CLI version may declare the
  same semantic rows, but remains unavailable until its own probe is green. The default npm wrapper
  is not replaced automatically when it is broken. If authentication must be staged for Codex, point
  `CAW_CODEX_AUTH_FILE` at a regular private auth file. The adapter copies it into a private
  transport, caps it at 1 MiB and removes the copy after observing that the turn started. This is
  cleanup, not an access barrier: from child start until that event, the role's first shell command
  can read the copy. Set `CAW_CODEX_AUTH_FILE` only if you accept that residual exposure.
- **Green live evidence for every configured binding that declares a probe.** Run
  `node caw.mjs probe <provider>` on the machine that will execute it. A CLI upgrade, adapter
  change, executable change, missing evidence or red probe makes that binding unavailable before
  spend. This is not a warning you can opt past.
- **`bash` on `PATH`.** Every gate runs as `bash -lc "<your gate command>"` from the
  repository root. It is a **login** shell, so PATH comes from the login profile: a gate that
  needs nvm, rbenv or asdf behaves differently here than in your own shell. On Windows this
  means Git Bash or WSL must be reachable.
- **`python3` on `PATH`, before you wire the guards.** The hooks are Python. A settings file
  naming a hook the harness cannot run is a way to lock a session out of `Bash` and `Edit`
  at once (measured, with two deleted hook files). Run one by hand first — see below.
- **`pytest`, to verify the guards.** Only for that step, and the step is the only check that
  the wiring took. `python3 -m pytest` must work, not just `python3`.
  A clean macOS command-line-tools Python may not include it. If you do not want to install it
  globally, use a disposable environment outside the project:

  ```bash
  guard_venv="$(mktemp -d "${TMPDIR:-/tmp}/caw-guard-venv.XXXXXX")"
  python3 -m venv "$guard_venv"
  pytest_python="$guard_venv/bin/python"
  "$pytest_python" -m pip install pytest
  ```

  Every `pytest` line below is written as `"${pytest_python:-python3}"`, so it uses that
  environment when you made one and the system interpreter when you did not. Some distributions
  need it rather than offer it: on Ubuntu 25.04 the system interpreter is externally managed and
  carries no pytest at all, so the bare form fails there.

  Keep that shell open through **Confirm the install end to end**, then delete the temporary
  environment after the check. The guards themselves still run with `python3`; pytest is only
  their installation test.

## Install

Copy these, and never the `.caw/` directory as a whole:

```
caw.mjs
.caw/agents/          five role files
.caw/adapters/        trusted provider adapters and runners
.caw/hooks/           the guards and their tests
.caw/CAW.md           the profile form — yours once filled in, never overwrite it again
.caw/runtime.json      first install only — fill all five rows, never overwrite it on update
```

A recursive copy of `.caw/` silently replaces a filled-in `CAW.md` with the blank form. That
has happened once, on this tool's first update of its first real install.

**Keep `.caw/` out of anything that rewrites files.** An install whose gate runs a formatter
over the whole repository forks the vendored copy silently, and the pipeline's own `git add -A`
then commits the fork — measured on one install, where black had rewritten four of the five
hook files to bytes that were exactly `black(upstream)`. Nothing announces it: the files still
work, and the divergence only surfaces as a conflict the day upstream touches one of them.
Exclude the directory in your formatter's config, not by remembering.

**Pin the line-ending conversion off at the source; `git archive` alone does not do it.** On
Windows the working tree holds CRLF, so identical content hashes differently: one install
comparing with `cmp` reported every copied file stale when two had actually changed. Reaching
for `git archive` because it reads the object database rather than the working tree is the
obvious repair, and it is not sufficient: `archive` applies the SOURCE clone's `core.autocrlf`,
so a clone checked out with it true streams CRLF into the tar, and a target whose own setting
is false stages those bytes verbatim. Measured on the first Windows install of this version:
all fourteen blobs differed while all fourteen modes matched, which is what this failure looks
like from the comparison below. Start from the project root. On a first install,
when `.caw/CAW.md` and `.caw/runtime.json` do not yet belong to the project, take exactly these
paths from the `main` remote-tracking ref. The `fetch` is yours to run even in a clone somebody
else works in: it moves remote-tracking refs and touches neither the working tree, the index nor
the checked-out branch. `pull` does, and is never yours to run there.

```bash
git -C <clone> fetch --quiet origin
git -C <clone> -c core.autocrlf=false -c core.eol=lf \
  archive --format=tar origin/main -- \
  caw.mjs .caw/agents .caw/adapters .caw/hooks .caw/CAW.md .caw/runtime.json \
  | tar -xf -
```

This is not a recursive copy of `.caw/`: the archive contains only the six named paths. On an
update, omit the two project-owned files exactly as [updating.md](updating.md) says.

**Blob identity alone does not compare the file mode.** One install carried `755` on two files
this repository tracks as `644`, and every content check passed on it: the divergence was invisible
to the procedure whose whole job is finding divergence. `git archive` restores the tracked modes;
then stage only the four CAW-owned paths so the target index can be compared with the source tree:

```bash
git add -- caw.mjs .caw/agents .caw/adapters .caw/hooks
```

Compare mode and blob together against the same named ref:

```bash
diff -u \
  <(git -C <clone> ls-tree -r origin/main -- caw.mjs .caw/agents .caw/adapters .caw/hooks \
      | awk '{print $1, $3, $4}' | sort) \
  <(git ls-files -s caw.mjs .caw/agents .caw/adapters .caw/hooks \
      | awk '$3 == 0 {print $1, $2, $4}' | sort)
```

No output is green. This one comparison covers bytes, modes, missing files, extra files and a
mixed adapter/engine/role/hook update. It deliberately excludes `.caw/CAW.md` and
`.caw/runtime.json`, because those become project-owned at first installation.

**On a host with no execute bit, the mode half of that sentence is not true, and the `755`
case above is exactly what it stops catching.** Windows carries no POSIX permission bits, so
the target index records `644` for every file whatever the source tracks, and a mode-only
fork is invisible to a comparison that prints nothing and reads as green. Measured: the
engine's own test for this comparison fails on Windows with `a mode-only fork is visible`
asserted and absent. Read a green run there as covering bytes, missing files and extra files
only. The mode half needs a POSIX host, and until one has checked this install, an update
that changes nothing but a mode reaches it unannounced.

Three hooks are executable because they are wired as entry points; `_common.py` is imported and
`test_guards.py` runs under pytest, so both are `644`. A `chmod +x` to "fix" those two is a
divergence, not a repair — that install had it the wrong way round and read the update as the
breakage.

Add to `.gitignore`:

```
__pycache__/    # the only one that matters: running the guard tests creates one and the
                # happy path runs `git add -A`, so without this line .pyc files get committed
.caw-tasks/     # belt and braces — caw.mjs already resets both after staging, but a plain
.caw-logs/      # `git add -A` from a hand or another tool does not
```

Three things `build` refuses to start on, re-checked every run rather than set once: a
**dirty working tree**, being on the branch named in `main_branch:`, and — this one from every
command — not being at the **repository root**. Only the root check binds `plan`, so
`node caw.mjs plan` on your main branch runs to completion and spends $3-12.

**Do not run a broad `git add -A` while a task has unfinished round state.** A stopped task keeps
its delivery changes in the working tree and its state under `.caw-tasks/.round-*.json`; `git add -A`
for an unrelated configuration commit will stage the delivery too. This happened twice during live
acceptance. CAW correctly refused the resulting inconsistent continuation, but it cannot undo a Git
commit made outside its process. Finish/review the task first, or stage the configuration paths
explicitly. This manual is the current guard; a machine warning for an advanced HEAD over saved round
state is a recommended follow-up, not an implemented protection.

## Fill in `.caw/CAW.md`

It is a form and its fields are the whole configuration; the comments in it say what each
field is for. Two things it points at that live here: the gate contract, and `gate_full:`
may be left empty, meaning the fast gate is the whole gate.

## Bind all five roles in `.caw/runtime.json`

The runtime file is explicit and closed: `architect`, `enumerator`, `plan-reviewer`, `executor`
and `reviewer` each name `provider`, provider-native `model`, and CAW reasoning
`low | medium | high | max`. There are no inherited role defaults and no executable or credential
paths in this file.

### Clean machine with Claude only

Codex is not a prerequisite when no row selects it, on either supported host — but the host's own
outer boundary from **Prerequisites** is, and it is the one thing on this path that a clean machine
is most likely to be missing. Confirm it before writing anything:

```bash
case "$(uname -s)" in
  Darwin) test -x /usr/bin/sandbox-exec && echo "seatbelt present" ;;
  Linux)  command -v bwrap >/dev/null && echo "bubblewrap present" ;;
esac
```

An empty answer means every pipeline command will refuse after the install verifies clean. Then,
on a machine with Claude as the only provider, write this exact `.caw/runtime.json`:

```json
{
  "version": 1,
  "roles": {
    "architect": { "provider": "claude", "model": "opus", "reasoning": "high" },
    "enumerator": { "provider": "claude", "model": "opus", "reasoning": "high" },
    "plan-reviewer": { "provider": "claude", "model": "opus", "reasoning": "high" },
    "executor": { "provider": "claude", "model": "sonnet", "reasoning": "high" },
    "reviewer": { "provider": "claude", "model": "opus", "reasoning": "high" }
  }
}
```

The `opus` and `sonnet` names are sent to Claude exactly as written. Confirm that the installed CLI
accepts them. If `claude` is on `PATH` and already authenticated, no provider environment variable
is required. Otherwise set only `CAW_CLAUDE` to the Claude executable's absolute path and use the
CLI's normal authentication setup. Do not install Codex and do not set `CAW_CODEX` or
`CAW_CODEX_AUTH_FILE`; no Claude row reads them.

`claude auth status` can report `loggedIn: true` while a cached OAuth access token is already
expired. The version command and status are therefore prerequisites, not authentication evidence.
The probe below is the actual authenticated check. If it returns HTTP 401 or says the token expired,
run `claude auth login` interactively and then rerun the same probe; do not treat the four red
attestations as usable evidence.

After filling `.caw/CAW.md`, run the Claude recovery probe from the target repository root. It makes
four live provider calls, which may be charged:

```bash
claude --version                         # or: "$CAW_CLAUDE" --version
node caw.mjs probe claude
```

A correct run reports all four as green:

```text
claude-planning-boundary-v1: green
claude-enumerator-tools-v1: green
claude-executor-delivery-v1: green
claude-review-isolation-v3: green
```

The paths printed after those summaries are repository-bound attestations under the Git-private
probe directory. All four files must still exist after the command; one must not evict another:

```bash
probe_dir="$(git rev-parse --git-path caw/probes)/claude"
find "$probe_dir" -maxdepth 1 -type f -name '*.json' -print | sort
test "$(find "$probe_dir" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')" -eq 4
```

Missing, red or evicted evidence correctly makes every pipeline command refuse before its first
role call and print `node caw.mjs probe claude` as the recovery command.

The planning roles run with `writeScope: engine-private-only`: provider transport and scratch may
write, but delivery may not. That scope is enforced by the probe-backed `os-boundary`; it is not an
`isolated-surface`, because no writable repository copy is created. `os-boundary` names one
mechanism with a per-host implementation, and the probe is what tells them apart: an attestation is
keyed by operating system, canonical executable and the adapter's own bytes, so seatbelt evidence is
never credited to bubblewrap, and editing the boundary invalidates every attestation it was
gathered under. It is **not** keyed by CLI build: what the probe measures is enforced by the
kernel against any build, so a provider update leaves green evidence green and preflight prints
`probe evidence for claude was observed on CLI <x>; running <y>` once instead of refusing. The
half of the contract a build *could* move — the enumerator's absent shell, external tools staying
out — is held by flags no probe observes yet. A green attestation is evidence about what the
OS enforced and about nothing else; the flags asserted around it are not a claim this file
makes. The executor uses the same OS
mechanism with delivery writable, while the reviewer receives a real isolated writable copy. Role
guarantees are compared by an explicit per-key partial order, so a provider declaration that is
strictly stronger satisfies a weaker requirement—for example, Claude's absent editor satisfies
`directEdit: forbidden-delivery` for the planning roles.

Both `probe` and every successful pipeline preflight print an `UNBOUNDED RUNTIME RESIDUALS` block
before the first role/model call. It is not an error and does not make a green probe unavailable.
It states that shell-enabled roles can read outside delivery and make outbound network requests;
`externalToolAccess: forbidden` only excludes provider-native external tools. The durable account
and the conditions for removing those residuals are in [SECURITY.md](../SECURITY.md), which is
what the printed line names. It is a URL rather than a path for exactly this reason: the install
copies six paths and the documentation tree is not one of them, so a repository-relative pointer
would resolve against the target project and find nothing.

### Invocation graph and all-five preflight

The invocation graph is: `plan` and `review-specs` each call `enumerator`, `architect` and
`plan-reviewer`, while `build` calls `executor` and `reviewer`. That graph does **not** scope
pipeline preflight: `plan`, `review-specs`, `build`, `round` and `review` resolve and check all five
rows before work, including roles they will not invoke. One row that is unknown, unsupported,
missing its executable or lacks current green probe evidence therefore refuses every pipeline
command; a partially available installation is inert, not a reduced pipeline that can still build
hand-written specs. Repair commands are deliberately outside that guarantee gate: `artifacts list`
and `purge` require no matrix, while `probe <provider>` still requires a valid runtime, trusted
adapter and resolvable target executable/CLI but does not require role guarantees already to be
satisfied. A legacy profile
containing `model_architect`, `model_executor`, `model_reviewer`, `effort` or `permission_mode` is
rejected with a complete five-row migration starting point; move the choices to `runtime.json`,
then remove the legacy fields rather than keeping two sources of truth.

The enumerator is bound by outcome, not by which repository-reading tool a provider happens to
use. It must read delivery while an exact-version OS-boundary probe demonstrates that delivery
writes fail and engine-private writes succeed. Every adapter still reports shell availability, but
the enumerator row does not compare it. After a paid enumeration, the engine independently resolves
every case's structured source against the current repository, the exact human request or the exact
digested `index_cmd` block delivered to that call. One malformed or invented anchor discards the
whole population, records a bounded diagnostic and falls back to the plan reviewer's own reading;
there is no silent partial list and no automatic paid retry. This opens a measured Codex enumerator
binding without claiming that a resolved address proves the case or that the returned population is
globally exhaustive.

## Wiring the guards

`.caw/hooks/` holds three `PreToolUse` guards on the session you run the pipeline from. They
refuse writes into `.caw-tasks/` that would falsify a verdict, and refuse a pipeline run that does
not save its output.

**Run one by hand before wiring it**, so a missing interpreter is a failed command rather
than a locked session:

```bash
echo '{}' | python3 .caw/hooks/deny_tasks_edit.py
```

Then merge the appropriate fragment; do not overwrite a client file that already has hooks:

- Claude sessions: merge
  [`claude-settings.fragment.json`](../.caw/hooks/fragments/claude-settings.fragment.json)
  into the project's `.claude/settings.json`.
- Codex sessions: merge
  [`codex-hooks.fragment.json`](../.caw/hooks/fragments/codex-hooks.fragment.json)
  into the project's `.codex/hooks.json`. Codex reports shell and unified-exec calls as `Bash`,
  and reports file patches as `apply_patch`, for which `Edit|Write` are documented matcher aliases.

Both fragments check that Python and the named guard entry point exist and return blocking exit
code 2 when they do not. This matters most during a mixed-version update: silently skipping a
missing guard is worse than refusing the tool call.

Hooks are snapshotted when a session starts. Restart the session after merging. For Codex, the
project `.codex/` layer must itself be trusted, and the exact hook definitions must be reviewed
and trusted in `/hooks`; trust is tied to their hashes, so every change requires another review.
The project file's presence alone is not evidence that its hooks ran. The
`--dangerously-bypass-hook-trust` flag is only for a one-off invocation whose hook bytes were
independently inspected, not normal project wiring.

**Then verify, and check the exit code** — this is the acceptance test for everything above,
because four of its cases read this install's own `settings.json` and assert the wiring. A
guard the harness never calls is not a guard, and a missing `pytest` exits 1 with one line
that is easy to read as success:

```bash
"${pytest_python:-python3}" -m pytest .caw/hooks   # 118 cases; 4 more with Claude wiring present
node --test test/operator-hooks.test.mjs
```

What they refuse, so a first run does not read as broken: a write into `.caw-tasks/PLAN.md`
outright, and a write into any spec is allowed but flips `approved:` back to `false`, so
`review-specs` has to judge the queue again. Reading `.caw-tasks/` is never blocked, and
`caw.mjs` itself is exempt — the guards bind hands and sessions, not the tool whose queue it
is. That is why `plan` writing specs into `.caw-tasks/` does not trip them.

These are operator-session guardrails only. Noninteractive provider children use the adapter
capability boundary; their guarantees never depend on either client hook configuration. In
particular, the Codex child invocation disables hooks explicitly, so a green `/hooks` operator
check cannot be credited as a child capability.

## Saving a run

**Mandatory, and enforced.** Redirect the human-readable transcript into `.caw-logs/`;
`require_caw_log.py` refuses a pipeline launch that does not name that directory. Separately,
the engine creates a private bounded `run-*` sidecar containing canonical final provider objects,
runtime/adapter identities and bounded failure evidence. It never retains successful progress or
tool streams. Recovery patches, round state, review surfaces, probes and file transports have
their own explicit bounds and lifetimes; inspect them with `artifacts list` rather than assuming
every `.caw-logs` entry follows one rule.

```bash
mkdir -p .caw-logs
node caw.mjs plan "…" > .caw-logs/plan-$(date +%H%M%S).log 2>&1
```

PowerShell — timestamp it too, or every run overwrites the last:
`node caw.mjs plan "…" *> .caw-logs\plan-$(Get-Date -Format HHmmss).log`

If a transcript contains evidence you want beyond its local pruning window, copy it out. Run
sidecars keep the newest 20 and at most 30 days. `artifacts list` is the authority on what is
currently retained and under which rule; do not assume every `.caw-logs` entry follows one.

## Confirm the install end to end

The deterministic and guard suites prove the engine/adapter contracts and operator policy. They
are not live-provider acceptance. Run the engine suite from the CAW source clone—the installation
does not copy `test/`—and run the syntax/guard checks from the target project. Those are
non-spending. Versioned provider probes are live calls and may be charged. Then, on a scratch branch
and disposable authenticated repository, run a small real request through the exact matrix you
intend to support:

```bash
node --check caw.mjs
node --test <clone>/test/*.test.mjs
"${pytest_python:-python3}" -m pytest .caw/hooks
node caw.mjs probe claude              # Claude-only matrix: four green attestations
node caw.mjs plan "<something small and real>" > .caw-logs/smoke.log 2>&1
```

Specs should land in `.caw-tasks/`, with `.caw-tasks/PLAN.md` beside them. Nothing has run yet, so
delete them if you do not want them.

## When a run stops

- **A plan runs out of rounds, or the reviewer raises a question the request does not
  settle.** The specs are kept and `PLAN.md` carries `approved: false`. `build` refuses until
  `review-specs` comes back clean and flips it — or until you set it yourself, in which case
  the unclosed holes stay in the file and every `build` says the plan was approved by hand.
  **Answer where the next run will find it, and state sets by rule rather than by list.** The
  answers are what the amended request carries, and a request that names its own decisions —
  *record A, B and C* — goes stale the moment an answer adds a D. One install was asked the same
  question twice, two rounds and about $7 apart, the second time with a longer alphabet: *item D
  enumerates five and was written before G and H existed*. Answering is what produced it.
  `record every decision this request carries` is the same instruction, closed under amendment,
  and free.
- **The architect refuses the request outright** — a different stop, and it leaves **nothing**
  in `.caw-tasks/`, no specs and no `PLAN.md`. It does this to a request whose deliverable is a
  conclusion (prove, rule out, measure, audit): there is no gate for a report, so the build
  would pass whatever it concluded. Run those as a conversation. This is the likeliest first
  stop on a smoke run, so pick something that changes code.
- **A task is not approved by the round the run stops at.** This stop is a question, not a
  verdict on the task, and it is asked in two numbers rather than in prose: how many of the
  open items the last round **closed**, and how many are **new**. `2 closed of 3, 0 new` is a
  loop converging and wants another round; `0 closed of 3, 4 new` is a reviewer redrawing and
  wants your hands. Nothing is committed, the tree keeps the work, the spec stays in the
  queue, and the review history is saved — so both answers carry the open items forward
  instead of starting a fresh reading:
  - `node caw.mjs round <spec>` — **one** more round: the executor against those items, then
    the reviewer. It stops and asks again, so a third round is a third decision.
  - fix the open items yourself, leave the work in the tree, then `node caw.mjs review <spec>`
    — the reviewer judges what you did and nothing else runs. On approve it commits, and the
    commit says the last round was written by hand. **A task finished by hand still gets a
    review**, which is the whole reason this command exists.

  Both stop for the same decision again rather than looping, and either commits on approval.
  Run `build` again for the rest of the queue.

  `done` is still there and it is now the narrow case: it removes a spec from the queue with
  **no judgement of the work at all**, and it refuses while the tree is dirty, because dirty
  means `review` can still do better. Reach for it only when the work is already committed.
- **`plan` over a queue that still holds specs** → refused. It would renumber from 001 and
  interleave two plans in silence.
- **A run dies mid-task** → the spec is still there and re-running redoes that task. What the
  run had noticed goes to `.caw-tasks/notes.log`; `plan` and `build` announce that file on the way
  in, and nothing deletes it but you.
- **A task's executor returns `blocked`** → its work is in the tree and a copy is written to
  `.caw-logs/blocked-<task>.patch`. Nothing judged that work: no gate ran on it and no
  reviewer saw it.
- **The full gate is red at the end** → every task was committed on its own green fast gate,
  so the fast gate is not what missed it. The script prints the `git bisect` range.

- **A role call is killed at thirty minutes** → nothing comes back and what it spent is spent.
  That cap has fired once on a call that was still working — an architect over a queue of
  sixteen specs — so treat it as a cap, not a diagnosis. Re-run with a larger one:
  `CAW_AGENT_TIMEOUT_MS=5400000 node caw.mjs review-specs "…" > .caw-logs/…`. Milliseconds, a
  positive whole number; anything else refuses to start rather than falling back. A run under
  a non-default cap says so in its first line, so the log carries which cap it ran under.

Three caps in `caw.mjs`, because three different things go wrong: `MAX_PLAN_ROUNDS`,
`MAX_TASK_ROUNDS` (review rounds inside one `build`) and `MAX_GATE_RETRIES`. A red gate is
not a review round and must not spend one. `MAX_TASK_ROUNDS` is no longer a number a task
dies at — it is where an unattended run stops to ask you — and a task also stops early when a
round closes nothing, which is the sharper of the two signals and the only one that can fire
before the cap. They stay in the file on purpose: what makes four installs
comparable is that they run the same numbers, and the one measurement anybody has across
installs — tasks finished by hand after the ceiling, 3 of 10 on one and 1 of 14 on another —
means nothing once each install picks its own cap.
