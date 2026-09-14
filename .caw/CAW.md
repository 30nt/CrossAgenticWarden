---
# Machine-read by caw.mjs. Flat `key: value` only — the first colon separates.

name: My Project
main_branch: main

# Run after every task, before the reviewer. Keep it in the seconds.
# Two conventions, both explained in docs/gate.md: exit 75 when the gate REFUSES to start
# rather than fails, and read CAW_SPEC when the gate looks at .caw-tasks/ at all.
gate_fast: npm test
# Optional positive milliseconds. Empty means no engine timeout.
gate_fast_timeout_ms:

# Run once, at the end of a build. Leave empty when it is the same as gate_fast.
gate_full:
gate_full_timeout_ms:

# Optional. Prints this project's CLOSED sets — the ones a script can list in full and a
# model can only sample: every member of an enum, every caller, every migration, every
# numbered section of a spec against the files citing it. Its stdout is handed to the
# enumerator and to no other role. Leave empty and nothing changes.
# Whatever you write here must be verified against a count taken another way before you
# trust it: on one project the obvious pattern for "every route" returned 22 of 90.
index_cmd:

# Comma-separated ignored dependency roots exposed read-only inside task-review surfaces.
# Every other ignored project path is absent there and denied through its delivery-tree path.
review_dependency_roots:

# Task specs, commit messages, notes. Stated explicitly because an agent otherwise
# inherits whatever language preference the machine it runs on happens to carry.
docs_language: English
---

# CAW profile

This file is a **form**. It has the fields above and the sections below, and the pipeline
reads only those.

If you find yourself wanting a new section here, that is the failure mode this tool was
built to avoid: the profile it replaces reached 1081 lines, and every line of it was
added by someone who had a good reason. What you want to record almost certainly belongs
in a comment at the site it describes, in a commit message, or nowhere.

## Domain

One or two sentences. What this project is, what it is built with.

## Module boundaries

What may not import what. What must never be edited. Facts, not advice — the executor is
bound by them and the reviewer checks against them.

## Settled behaviours

Rules earlier runs already decided, each carried by code you can read. A spec touching an
entity that has one of these properties states it itself — leaving it implicit is what a
review round comes back with, and a round costs money and a human's attention.

Every entry names the code that proves it. An entry that cannot is a preference, and a
preference belongs nowhere. When the gate starts checking one, its entry leaves. This is
the section most likely to regrow the thousand-line profile — the old one carried 570
lines of defect classes whose retirement rule almost nothing could satisfy — so the named
precedent *is* the retirement rule here: no precedent, no entry. Cost, measured on the
install that added the section: every role reads it on every call, roughly 600 tokens
against a $6 review round — it pays for itself the first time it saves a quarter of one.

## Canonical docs

Where an agent goes when a question about product behaviour is ambiguous. A list of file
paths. If they do not settle it, the agent stops and asks the human.

## Standing authorizations

What the pipeline may do without asking, and what that permission does *not* extend to.
Without this section every side effect stops the run.

The one nearly every install needs is the reviewer's work surface: somewhere to make a fix
inert and see whether the suite still passes. This entry is not what permits it. With no entry
here and nothing in the role file asking for one, a reviewer builds itself a surface anyway —
measured on one project by counting the child-session transcripts, since a run log holds the
verdict and never a tool call: **6 of the 6 tasks judged, 39 commands outside the repository,
twice a plain `cp -r` of a tree holding a keystore and a mode-664 `.env`**. Count it that way
if you measure it yourself; the reviewer's own prose about itself reported a third of it.

Most of those 39 are not a copy, and that is the half to write for. The common shape is a file
backed up to `/tmp`, a `sed -i` **in the working tree**, the suite, then a restore. One
interrupted process leaves the mutation in place, and the next thing `caw.mjs` does on the
happy path is `git add -A`. So say both halves: that a probe needing the tree gets a copy of
it, and what that copy may carry.

Name paths, and name them as paths the copy never RECEIVES — not as paths deleted afterwards,
which is a narrower window and not a closed one. A recursive copy takes the ignored set with
it, and by convention that is where credentials live: a `.env`, a keystore, a token cache, out
of a tree whose own profile most likely forbids reading them.

Write the entry even though the danger is not certain, because the SHAPE of the copy is what
you cannot predict. Measured on two installs, both of which built a surface with nothing asking
them to: one copied the whole repository twice and carried a mode-664 `.env` into `/tmp`; the
other only ever copied enumerated subtrees — `cp -r src tests /tmp/` and the like — so its two
credential files never left, and on one pass the reviewer ran `ls $R/.env.local` afterwards to
check that they had not. Same behaviour, opposite outcome, and nothing observed so far predicts
which you get. The entry is what makes the outcome independent of the shape.

Excluding everything git ignores is not the answer either — the same set holds `.venv` and
`node_modules`, and the gate needs them. Two shapes carry the right files by construction
rather than by cleanup, and both leave the ignored secrets behind without a single `rm`:

```
git clone --no-hardlinks <repo> <scratch outside the repo>
git ls-files --cached --others --exclude-standard | tar -cT - | tar -x -C <scratch>
```

then symlink the virtualenv rather than copying it. Measured on one install, in both
directions: built that way and then mutated, the gate exits 1 and names the test that caught
it; **built without a `.git`, it exits 0 and PASSES** — because the enumeration this README
prescribes returns nothing, the language branch is skipped, and the `exit 75` that would have
said "did not run" sits inside the branch that was skipped. A surface that reports green on
every mutation is worse than one that refuses to start, and it is the easier one to build by
accident.

**The two shapes are not interchangeable, and the second is dangerous for exactly the gate this
README asks you to write.** A tar copy carries no `.git`, so a gate enumerating with
`git ls-files --cached --others --exclude-standard` returns an empty list there and reports ok
on anything. Confirmed on a second install in a second language, whose secret sweep cannot go
red in a tar copy at all. If your gate enumerates through git, the clone is not a preference.

Whatever this profile's gate runs, keep `.caw/` out of anything that rewrites files. The
engine, the roles and the guards are vendored and are meant to stay byte-identical to upstream,
which is how an install checks what version it runs. A formatter in the gate breaks that
silently — measured on one install, where four of five hook files had been rewritten to
`black(upstream)` and the pipeline's own `git add -A` committed the fork. Exclude the directory
in the formatter's own config.

## Not gated

Invariants that are real, that a reviewer should check by hand, and that are deliberately
**not** mechanised — because a rule that fires on cases it should not gets worked around
rather than obeyed, and then it launders a violation as known noise.

**At most five entries.** If you need a sixth, one of the five should have been a check.
