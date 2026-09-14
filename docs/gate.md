# Writing the gate

*[Русская версия](gate.ru.md)*

The gate is the one thing in this pipeline whose verdict never passes through a model: green
or red is an exit code. That makes it the piece most worth getting right, and these rules were
each bought by an install that did without one.

`gate_fast` and `gate_full` are each **one command**. A project whose gate is really five
checks wraps them in a script and names that — `bash scripts/gate_fast.sh`, or a `make check`
that already does it. Five rules, every one of them bought by an install that did without it:

Set `gate_fast_timeout_ms` and `gate_full_timeout_ms` in `.caw/CAW.md` when the project has a
defensible limit. They are positive whole milliseconds; an empty value leaves that gate without
an engine timeout. A timeout is recorded separately from red and exit-75 refusal: CAW kills the
gate, keeps task recovery state, and does not wake an executor or recommend a bisect.

1. **Exit 0 green, 75 refused-to-start, any other non-zero red.** 75 (`EX_TEMPFAIL`) means
   the gate never looked: a machine too loaded for the suite it shards, a simulator that is
   not there, a service that is down. `caw.mjs` then says the run was *not tested* rather
   than that it failed. (One install used exit 1 for both, and a reader
   bisected a range where nothing had executed.)

2. **If your gate enumerates files at all, enumerate with
   `git ls-files --cached --others --exclude-standard`** — the set
   `git add -A` would stage. The gate runs *before* anything is staged, so a check reading
   git's index is blind to exactly what the executor just produced, and a new file is its
   characteristic output. (A credential in an untracked file passed a `git ls-files` secret
   sweep and a plain recursive grep found it in the same second.) Note the consequence: this
   enumeration returns nothing outside a git worktree, so a gate built on it exits **0** in a
   scratch copy with no `.git` — measured, and it makes every mutation there look green. If
   your gate enumerates through git, exit 75 when `git rev-parse --git-dir` fails.

3. **Compare sets, not totals**, if your gate shards or selects tests by name: classes on
   disk against classes assigned, assigned against classes that reported a result. (One
   project had a class passed to the runner and silently never executed while another ran
   that should have been skipped — the two offset exactly and the total matched the baseline
   perfectly.)

4. **Survive being run twice at once.** This script runs the gate, and a human runs it too —
   while a build is in flight, which is ordinary. A gate holding a database, a simulator or a
   fixed port must take a lock or refuse; refusing is `75`, not red. (Measured on one install:
   two full-gate runs raced over the same Postgres volume, the loser failed with foreign-key
   violations and unrelated errors, and an executor spent its round believing it had broken
   something.)

5. **Read `CAW_SPEC`** if the gate looks at `.caw-tasks/` at all. It holds the one spec being
   gated, e.g. `003_slug.md`. It is exported around the gate, and around the two agent calls
   that are about one task — the executor and the reviewer; the architect, enumerator and
   plan-reviewer never see it.
   Unset — a hand run, or the full gate — means the whole directory is the right subject.
   (Without it a gate reds a plan's early tasks over a debt only its last task settles.)

The reviewer and every `weak` replay run this gate again inside an isolated write boundary. A green
delivery gate does not prove that the same command is runnable there. The live acceptance repository
used a Node gate successfully, but a direct macOS experiment against one iOS/Swift install's Xcode/Swift gate had
four of five checks fail inside the profile because native tools wrote to the per-user temp directory
and package state outside the surface; the controls passed outside it. That is a known limitation of the review boundary, not
a project failure and not evidence that the delivery gate is red. Until the boundary gains a
project-level preflight, treat toolchains needing external writable caches/temp roots as an explicit
review-capability limitation rather than silently crediting an in-surface rerun.

## Writing `index_cmd` (optional)

The enumerator rebuilds its population from scratch on every call, and on two installs the
same request came back at 60–97 and 51–118 cases: it SAMPLES what a script can settle. It is
also the most expensive role on one of them — 53% of planning spend, $6.44 a call. `index_cmd`
hands it the part that is settled, so the model's budget goes to the part no script reaches.

One command, like a gate, printing to stdout. What belongs in it is whatever your project can
list **in full**: every member of an enum, every caller of a function, every migration, every
route, every numbered section of a specification against the files that cite it. What does not
belong is anything you cannot close — a summary, an architectural overview, advice.

New profiles set `index_format: json-v1`. The command must print one strict object:

```json
{
  "api_version": 1,
  "sets": [
    {
      "id": "public-routes",
      "label": "Public HTTP routes",
      "source": "scripts/project-index.mjs",
      "members": ["GET /health", "POST /orders"]
    }
  ]
}
```

Set ids and members must be unique inside their scope. Unknown fields, malformed output,
duplicate ids or members, non-zero exit, oversized output, and a rendered index above the prompt
cap stop planning before a provider call. CAW never truncates a structured closed set.

Profiles installed before this contract and lacking `index_format` keep `text-v0`: their stdout
is passed as before, and command failure stays non-fatal. Set `index_format: json-v1` only after
the command emits the object above.

**A set may only be drawn from what the project says it MUST do, never from what it records
having done.** An archive of finished tasks carries section numbers exactly like a
specification does, and no pattern tells them apart — one clone read 252 numbered references
in one project's closed-task reports as a numbered source of truth and advised that project to
start annotating code against it. A section nobody cites means "possibly uncovered" in a
specification and means nothing at all in a report about work that shipped a year ago. If the
two live in one tree, the boundary is the directory, and drawing it costs no edits: on that
project all 252 stopped being noise the moment the index was scoped to the normative half.

**And when a document does not fit the instrument, move the instrument.** The first proposal
there was to renumber the documents so the script could read them — which for a report of a
closed task is falsification, not tidying. Instruments are cheap and revisable; the record of
what happened is neither. This is more general than indexing, and it is the rule the gate obeys
too: a check that cannot see something is narrowed or replaced, never answered by editing what
it looks at.

**Verify every set against a count taken on a different axis, before you trust it.** Not a
second pattern of the same shape: a verification written quickly regresses to the simpler
pattern, so its error has a direction, and two clones doing this on one day both under-reported.
One returned 174 headings against its own extractor's 204, missing every `## 2. Title` — a dot
with no digit after it. Another read 0 numbered headings off a tree carrying 55 and 0 code
references off one carrying 87, the latter because that project cites sections in words rather
than a sign. **A zero is what a wrong pattern produces**, so treat one as a reason to count
again, never as a result. Measured earlier the same way: the obvious pattern for "every route"
on one project returned 22 where the real number was 90, and its own commit messages said 82.
A script that quietly under-reports is worse than no script, because the enumerator is about to
be told the set is closed.

In legacy `text-v0`, failure remains non-fatal. No command, an empty print, or a non-zero exit
makes the run enumerate as it always has. Output above the cap is truncated, the run says how much
was dropped, and the enumerator is told it may not treat any set in there as closed. In both
formats a visible index member can still be cited with the exact digest, line range and excerpt;
the model never turns that address into a global completeness claim.
