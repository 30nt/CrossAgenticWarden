# What is known to be broken

*[Русская версия](limitations.ru.md)*

Every entry here was measured, not guessed. The rule for this file is the one it was written
under: **an item leaves by being fixed or exercised, never by being rewritten.**

Publishing this rather than a feature list is deliberate. A tool that runs model-authored code
and commits it has hazards; the choice is whether its users find them here or in their tree.

Measurements name their instrument as a class — "one install, Python", "one install, iOS/Swift".
They are single-install observations, not benchmarks.

## Hazards you can hit on a real run

### An interrupted reviewer can leave a mutation in your working tree

The reviewer copies the working tree somewhere, mutates it to see whether a test can still fail,
and deletes it. **No role file tells it to.** The copy is made by an agent's shell command, so
`caw.mjs` never learns the path and cannot clean it up.

Counted from the run log — which holds verdicts and never a tool call — it read as "seven times
across three tasks". Counted from the child-session transcripts of the same run, where tool calls
actually live: **6 of 6 tasks judged, 39 commands outside the repository, twice a plain `cp -r`
of the whole tree**, out of a tree holding a keystore and a mode-664 `.env`.

Most of those 39 are not copies. The common shape is worse: a file backed up to `/tmp`, a `sed -i`
**in the working tree**, the suite, then a restore. An interrupted process leaves the mutation in
place, and the next thing `caw.mjs` does on the happy path is `git add -A`.

A second install splits the finding: the surface is built there too, unasked, but only ever over
enumerated subtrees, so its two credential files never left. **The behaviour is 2 of 2; the
exposure is 1 of 2**, and nothing measured yet predicts which shape you get.

*What you can do:* write the `## Standing authorizations` entry in `.caw/CAW.md`, and name the
paths the copy must never **receive** — not paths deleted afterwards, which is a narrower window
and not a closed one.

### A mutation can be inert without anything noticing

Verified four ways in a sandbox: a copied venv script's shebang runs the *original* interpreter;
an editable install resolves through an absolute path and imports the original source; a workspace
symlink survives pointing at the original; and an inert edit can land on a branch the test never
walks. All four return the same green, and a reviewer reads that green as a weak test — so the
finding lands as a revision written against a healthy test, which is the expensive direction.

The check that covers all four is a positive control: break the same site outright and require
*that* to go red first. Nothing the reviewer reads says so today.

### A git-based gate reports PASS where it enumerated nothing

The manual prescribes enumerating with `git ls-files --cached --others --exclude-standard`. Build
the review surface with `tar` instead of `git clone` and there is no `.git` there, so the
enumeration returns an empty list, the language branch is skipped, and the `exit 75` that would
have said "did not run" sits inside the branch that was skipped.

Measured in both directions on one install: built as a clone and then mutated, the gate exits 1
and names the test. **Built without a `.git`, it exits 0 and PASSES on every mutation.**
Confirmed on a second install in a second language.

*What you can do:* if your gate enumerates through git, build the surface with `git clone
--no-hardlinks`, not with `tar`. This is not a preference.

### The gate runs before anything is staged

A gate that inspects the index rather than the working tree sees the previous state. The script
sets this trap for every install that writes one.

### `approved: true` is one draw, and `build` treats it as a gate

Measured on one install with ten byte-identical specs across two runs, clean tree: the same
question got different answers at different times. An approval is a sample, not a proof.

### An executor can commit its own work, and only prose stops it

The engine owns commits: the one it makes carries the spec's full text and clears the spec from
the queue, and `git log` is the record because of that. Nothing enforces it. `.caw/agents/`
now says so, but a rule carried by prose is a preference — the rule this whole design rests on,
that only the executor writes, is a `--tools` flag on a child process rather than a sentence.

**One observation, one vendor.** A Codex executor committed correct work and thereby stopped its
own task: the tree was clean, so the engine had nothing to stage. It refuses rather than
proceeding, and the refusal now names which of the two silences happened and hands over the two
commands that recover it. Nothing is lost when this fires. A second run that would have said
whether the behaviour is systematic was stopped before it finished, so the count stands at one.

What would close it is a boundary that denies the executor writes under `.git/` while leaving the
delivery tree writable — the same shape as the `--tools` flag. Both seatbelt and bubblewrap can
express it. It is not built because it needs measuring first: the gate runs inside that same
boundary, and a gate that takes an index lock or stashes would break. The falsifier is "denying
`.git` writes to the executor breaks no gate the manual's own rules permit".

## Limits that are not hazards

- **The request is the only input nothing checks.** The engine refuses a case the enumerator
  returns unless its excerpt is found in real bytes — and checks the request itself for exactly
  one thing: that it is non-empty. It then goes verbatim into the enumerator prompt and into
  `PLAN.md`. So the pipeline demands evidence from the model and takes the author's word for it.
  One install traced **three of six planning stops in a block to a rule written without running
  the command that falsifies it**, at $5–15 a stop, on a block whose planning came to $92.22.
- **The tool cannot defend its queue.** `.caw-tasks/` is owned by the engine and excluded from
  every git read and write it makes, but nothing in `caw.mjs` sees anything else touching it.
  Two routes measured on real installs: a hand's `git add -A` swept specs into a commit, and a
  patch script rewrote five specs and died on the fifth under a running review. The guards in
  `.caw/hooks/` answer this for an agent session — not for a hand or a script. Half is now
  instrumented: `review-specs` records a digest per spec at the moment it flips the flag, and
  `build` compares the queue against it. It **reports and does not refuse**, on purpose.
- **The reviewer can write, and so can the architect.** Both get `Bash` for a real reason, and a
  shell can write files. The guarantee is that no edit *path* is offered, not that writing is
  impossible. Two roles rather than one doubles that surface without changing the argument.
- **The gate has no timeout.** A hung agent call no longer blocks a run; a gate that never
  returns does. It is open deliberately: how long a suite runs is a property of the project —
  one install measures 3:20, another's is seconds — so the tool has no basis to pick a bound,
  and a wrong guess turns a passing suite into a failed run.
- **The manual approval path is narrowed, not closed.** `build` can tell a hand-flipped `PLAN.md`
  from a judged one, because `review-specs` removes the `## Unclosed` section when it flips the
  flag. Anyone who also deletes that section by hand gets silence. The override went from editing
  one word to a deliberate second act — which is the whole change. Worth recording why it needed
  narrowing: on one install the person who wrote the refusal text reached for the override
  reflexively, within an hour.
- **Byte-identity is the graduation rule and is not observable across platforms.** An install is
  a vendored copy whose version is the tag its bytes match. Line endings and file modes both
  break that check invisibly — one install carried `755` on two files tracked as `644` and every
  content check passed. `.gitattributes` closes the line-ending half.
- **A rejected round's notes never reach a commit, and the run prints that they did.**
- **No bootstrap.** The loop is "change the code, keep the gate green", and an empty repository
  has no gate to keep green. A human makes the first commit — skeleton, manifest, one passing
  test, `gate_fast` — by hand.

### Presence is not capability, and a Linux container shows it

`bwrap` on `PATH` does not mean `bwrap` can run. A default Docker container ships it and denies
the unprivileged user namespace it needs; Ubuntu 24.04 restricts the same namespace through
AppArmor. The adapter resolves the boundary helper by looking for the file, so on such a host it
declares the mechanism available and the refusal arrives later — from a live probe, after four
paid provider calls that were doomed before the first one.

Measured in a `node:22-bookworm-slim` container: the helper present, the namespace denied, and
`bwrap: Creating new namespace failed: Operation not permitted`. With the namespace allowed and
a non-root user, the same container runs 130 of 130.

The adapters now run the helper instead of looking for the file, so such a host refuses its
bounded rows before spending. That does not make the suite green there: 17 cases still go red in
a container with no usable namespace, because they assert a boundary directly and consult neither
the adapter nor the host probe. On a host with a working boundary — macOS, or Linux with the
namespace allowed — everything passes.

**And running as root defeats part of the boundary.** The case asserting that a write outside the
review surface is denied passes as uid 1000 and fails as root, in the same container with the
same helper. Do not run the pipeline as root on Linux.

## What has actually been exercised

The release evidence is external to this repository: a disposable acceptance project, with
transcripts in `.caw-logs/` and run records beside them. The table below is the summary; the
artifacts themselves are not published.

| Binding or path | Live provider evidence | Deterministic evidence / limit |
|---|---|---|
| Codex executor / Codex reviewer | task 001 committed at `304b832`; task 002 rounds 1–2 carried forward | engine contract suite also covers it |
| Codex executor / Claude reviewer | task 002 round 3, commit `cfaff0a`; carried Codex finding adjudicated by Claude with origin retained | engine contract suite also covers provider-change carry |
| all-Claude | task 003, commit `1ef3768` | engine contract suite also covers it |
| Claude executor / Codex reviewer | task 004, commit `86b2d10` | engine contract suite also covers it |
| all-Codex | none | not run; the earlier release could not bind its enumerator, while this version requires new green `codex-enumerator-boundary-v1` evidence and still has no live all-Codex matrix evidence |
| red-gate retry and gate exit 75 | none; three attempts stopped earlier as truthful executor `blocked` results | deterministic only; neither branch has fired live |
| Claude reviewer weak capture | reported by one Linux install, 2026-09-03: three weaks on one task, capture commits at `caw-weak-N`, closed by replay | **not verified here** — the run record is a gitignored log on that machine; what reached this repository is the same claim in a commit. The earlier statement that no round had ever produced one was a claim about this repository's evidence, and is withdrawn as a blanket one |
| native macOS Xcode/Swift review gate | direct experiment failed four of five checks inside the current profile; controls passed outside it | the review-boundary limitation above; Node-gate acceptance does not generalize to toolchains needing external writable temp/cache state |
| Linux, planning half | reported by one install (Python, bubblewrap 0.11.0, uid 1000), 2026-09-03: `plan` of 7 calls, 3 review rounds, no refusal or retry, $19.41 | **not verified here**, same reason. All three planning roles share `engine-private-only`, so this is one write scope, not three |
| Linux, `build` | reported in progress by the same install: executor under bwrap, `createReviewSurface()` built by the engine, `gate_fast` green and red inside it | **not verified here**. Not reported even there: a task commit, five remaining tasks, a completed `build` |
| Windows | none | portable contract tests do not substitute for an OS boundary run |

Across the four supported live bindings, four tasks were planned, spec-reviewed, built,
task-reviewed and committed through one engine. The queue emptied, `.caw-tasks/PLAN.md` cleared and the
resulting tree passed 24 tests. This is evidence about the exact measured machine, CLI versions and
adapters; your install still needs its own current probes and smoke task.

A plan revision costs a fraction of the pass it revises. Reported by one Linux install, and not verified in this repository: the
architect's first pass cost $3.98 and its two revisions $1.09 and $1.15, across a `plan` that
converged in three review rounds for $19.41 total. That is the loop moving cases between tasks
rather than redrawing the plan, which is what `resplit` reports line by line — one measurement,
one install, and the first number attached to a claim this tool had been making in prose.

## Deliberately not doing

Recorded so they are not re-proposed as omissions.

- **No metrics ledger.** Cost is printed and discarded. A run reports what it did; where that
  report is kept is not the tool's business. One install lost a $3.87 plan to a truncated
  terminal and re-planned the same ground three times — the answer was to redirect output to a
  file, and on that install a guard now refuses a run whose command line does not name the log
  directory.
- **No queue file the tool can write to, no history tiers, no archive command.** `ls .caw-tasks/`
  is the whole queue and existence is its whole state. What `round` and `review` resume is not
  progress — it is what a reviewer already checked, which is the one thing in this pipeline with
  nowhere else to live.
- **No scoping tier between "fast" and "full".** A per-task scope-selection map with three
  branches resolved to the full suite on 2 tasks out of 2.
