# Updating a vendored copy

*[Русская версия](updating.ru.md)*

An install is a vendored copy, and its version is the tag its bytes match. That makes updating
a comparison rather than a download, and every rule here exists because a comparison lied.

## Updating

**Copy, then run the guard suite, then commit, then verify — in that order.** The verification
below reads git's index, so between the copy and the commit it reports the old blobs against
already-correct modes, which looks exactly like an update that never arrived. Committing first
also closes the other half: an install whose update sits uncommitted has a `git log` claiming
the version it ran yesterday, and that log is the only record of its version anybody else can
read.

Copy `caw.mjs`, `.caw/agents/`, `.caw/adapters/` and `.caw/hooks/` as one update. Never copy
`.caw/CAW.md` or `.caw/runtime.json` during an update — both are project-owned after first install:

```bash
git -C <caw-clone> fetch --quiet origin
git -C <caw-clone> -c core.autocrlf=false -c core.eol=lf \
  archive --format=tar origin/main -- \
  caw.mjs .caw/agents .caw/adapters .caw/hooks \
  | tar -xf -
```

Verify with the normalized `git ls-tree`/`git ls-files -s` diff in [install.md](install.md), so
modes and bytes are compared together,
and **against a named ref rather than the clone's `HEAD`**: an install copying file by file
from `HEAD:` had another session run a `pull` in the same clone mid-copy, so the source moved
under it and its first report named the wrong version. A named ref cannot move while you read it.

If your project patched the engine, mark each patch with a `LOCAL CHANGE` comment at its site
and run `grep -rn 'LOCAL CHANGE' caw.mjs .caw/` **before** copying, not after: the point is to
make re-application a list rather than a memory. A local change that survives two updates is
one that belongs upstream instead.

### When, and who decides

**The install decides.** Not the owner, and not a session on another machine: neither can see
whether a run is in flight, so "update the rails" is timed by whoever happens to send it, and a
claim about somebody else's state goes stale before it arrives.

The condition is local and costs one `ls`: **`.caw-tasks/` is empty.**

**Check `tasks/` too if you are coming from a build older than the rename.** The queue used to
live at `tasks/`, and a reader on that layout runs `ls .caw-tasks`, finds nothing, and concludes
they are ready while a live queue sits in the old directory. The engine refuses rather than
reading the new path silently — but only once `tasks/` holds `.md` specs, so an empty one is
silent in both directions. The migration is the rename and nothing else:

```
git mv tasks .caw-tasks
```

If `tasks/` is empty because the queue was delivered, removing it is tidier than leaving it: left
in place, a later `.md` dropped there by a hand makes the engine refuse a run over a directory
nobody owns. If `tasks/` belongs to the project rather than to CAW — an Ansible role requires
one — leave it and delete nothing. The last plan was delivered
and no working state survives the swap. Not "at the start of a session" — a session can open on
a half-run plan and the engine would change underneath it. One install was in exactly
that position when it was checked, holding an undelivered spec and its `PLAN.md`, and a
hand-timed update that afternoon would have hit it.

Busy is not a problem. Skip, and check next time. An update is never urgent: the most a late one
costs is one measurement taken on an older engine, and the report names the engine anyway.

Nothing bought this rule yet — it is derived from the two above it rather than paid for, and the
first over-fire or missed swap belongs in this paragraph.

Whether there is anything to take is one command, against a ref both clones can name:

```
git -C <caw-clone> fetch --quiet \
  && git -C <caw-clone> show origin/main:caw.mjs | diff -q - caw.mjs
```

Then copy as above — **all of the vendored files or none of them.** A half-copied engine is
worse than an out-of-date one: byte-identity is how an install answers which version it runs,
and a mixed tree answers nothing.
## Ambient client instructions and the rails-update block

Critical CAW semantics do not depend on `CLAUDE.md`, `AGENTS.md`, user rules, MCP, apps or operator
hooks: the engine assembles and injects the pipeline invariants, role contract, factual capability
statement and documentation language on every child call. Measured Claude children may also load
project ambient memory, so long or interactive-only instructions there may still cost tokens or
conflict with the role. The Codex child path ignores user rules/config and disables hooks, MCP,
apps and web. These are provider-specific measured facts, not a shared guarantee.

The update reminder belongs in the project-owned instruction file used by each supported operator
client: `CLAUDE.md` for Claude sessions and `AGENTS.md` for Codex sessions. It is an operator
reminder only and never evidence about a noninteractive child capability.

**Its owner puts it there.** A session does not edit its own instructions because another
session asked it to — the same rule that stops a peer from rewriting yours.

Copy it verbatim, markers included. The markers are what make "does this project carry the rule"
a diff instead of a memory, and they are why the block may sit anywhere in the file:

```markdown
<!-- caw-rails-update -->
## Updating the CAW rails

Check for a new engine when `.caw-tasks/` is empty and no run is in flight — never mid-plan, and not
merely because a session has started. Run `git -C <caw-clone> fetch` yourself first, then take
`caw.mjs`, `.caw/agents/`, `.caw/adapters/` and `.caw/hooks/` from `origin/main`, all of them or
none; never overwrite project-owned `.caw/CAW.md` or `.caw/runtime.json`. Then
follow `## Updating` in that repository's `docs/updating.md`. Never from that clone's working tree or
`HEAD`: both are as old as whoever last worked there. Nobody outside this project can time any
of this — when busy, skip and check next time. An update is never urgent.
<!-- /caw-rails-update -->
```

**Nobody pulls the CAW clone for you, and nobody needs to.** `origin/main` in a clone is only
as fresh as the last `fetch` run there, and the session working in that clone fetches on its own
schedule — one clone was measured 30 commits behind its own
remote-tracking ref, which was itself three days stale until the session there ran a `fetch`. An
install taking the engine that afternoon would have copied a three-day-old `caw.mjs` out of a ref
that looked authoritative.

So the install runs the `fetch` itself, and this is safe to do from outside: `fetch` moves
remote-tracking refs and touches neither the working tree, the index, nor the checked-out
branch, so it cannot disturb whoever is editing there. `pull` can, and is therefore never
yours to run in somebody else's clone.

A written convention is evidence about intent and none about state. Compare each client file that
the project supports against the marked upstream block:

```
diff <(sed -n '/^<!-- caw-rails-update -->$/,/^<!-- \/caw-rails-update -->$/p' <CLAUDE.md-or-AGENTS.md>) \
     <(git -C <caw-clone> show origin/main:docs/updating.md \
       | sed -n '/^<!-- caw-rails-update -->$/,/^<!-- \/caw-rails-update -->$/p')
```

Take one project first. Four copies of an unchecked rule cost four times as much to withdraw,
and the thing worth measuring — whether the owner stops being the clock — needs one install to
answer, not four.
