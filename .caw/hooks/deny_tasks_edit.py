#!/usr/bin/env python3
"""Keep PLAN.md out of every hand, and make a spec edit withdraw the verdict.

The first version of this guard refused Edit and Write on everything under
.caw-tasks/. That was aimed at the right failure — a hand-edited spec skips every gate
this pipeline has — but it hit the wrong target. What a spec edit actually
threatens is not the text: it is the `approved` flag, which only `review-specs`
can raise. An edit that is judged afterwards costs nothing; an edit that is not
is the whole problem. Refusing every edit forbade both, and forbade them for the
repository owner too — who, working through a remote session with no filesystem
of their own, then had no way to fix a plan at all.

So the rule inverted: edit the specs freely, and the approval goes down with the
edit. `PLAN.md` stays refused, because it carries the verdict itself — a hand
that can set `approved: true` does not need to pass the gate, and on the install
that wrote the first version of this file, that hand was its author's, half an
hour earlier.

This is stricter than what it replaces. The old refusal left an already-approved
plan editable through any route the patterns did not cover; this one withdraws
the approval on the routes it does cover and refuses nothing that a later
`review-specs` would not catch anyway.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    allow,
    deny,
    edit_paths,
    invalidate_approval,
    localize,
    project_root,
    read_event,
)


PLAN_REASON = (
    "PLAN.md is written by caw.mjs, not by hand. Its `approved` flag is the only "
    "gate standing between an incomplete plan and a build; setting it manually "
    "removes the check instead of passing it. Edit the specs instead — that is "
    "allowed, and it withdraws the approval so `review-specs` has to judge them "
    "again. To accept a plan with its holes, say so and let the build announce it."
)


def main() -> None:
    event = read_event()
    raw_paths = edit_paths(event)
    if not raw_paths:
        allow()

    # `localize` first, and the order matters on Windows: a path arrives as
    # `C:\…\.caw-tasks\PLAN.md` or `/c/Users/…/.caw-tasks/PLAN.md` depending on which shell
    # the caller thinks in, and `Path(".caw-tasks\\PLAN.md")` is one filename rather
    # than two segments anywhere but Windows. Stripping the root and the
    # separators here makes the same payload decide the same way on both
    # platforms, which is what keeps this gate honest when it runs on macOS.
    root = project_root(event)
    relatives = []
    for raw_path in raw_paths:
        path = Path(localize(raw_path, root))
        if not path.is_absolute():
            path = root / path
        try:
            relatives.append(path.resolve().relative_to(root / ".caw-tasks"))
        except ValueError:
            continue

    # Compared without case, because the filesystems these sessions mostly run on
    # are: APFS by default and NTFS always. Measured on macOS — `.caw-tasks/plan.md`
    # walked past an exact comparison and the write landed in PLAN.md, with the
    # approval withdrawn a moment before the hand-written `approved: true` went in.
    if any(relative.name.lower() == "plan.md" for relative in relatives):
        deny(PLAN_REASON)

    # Only a spec can invalidate a verdict about specs. `notes.log`, a request
    # text and anything else parked in the queue are not built from.
    specs = [relative for relative in relatives if relative.suffix.lower() == ".md"]
    if specs:
        invalidate_approval(root, "edit of " + ", ".join(f".caw-tasks/{path}" for path in specs))

    allow()


main()
