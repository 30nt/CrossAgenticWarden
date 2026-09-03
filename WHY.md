# Why this is small

*[Русская версия](docs/why.ru.md)*

The previous version of this tool worked — it ran roughly 42 phases and 360 tasks on a real
iOS project. It also grew, and the way it grew is the design input for everything here.

## What went wrong

**It could give itself work.** A review that found something wrote a ticket. The ticket
produced a review, which proposed a defect class, which a cap refused, and the refusal
filed another ticket. Measured in that project: roughly **19 of the last 27 closed tickets
were meta-work**, and four open tickets existed only to record proposals a cap had already
rejected. Of 14 open tickets, 9 were defects in one file's prose — findings that do not
even travel to another project.

**It could write rules about itself.** Every run learned something and wrote it down;
nothing ever removed any of it. The pipeline reached 3609 lines, of which the agent role
definitions — the part that does the work — were 952. The rest was sediment. One project's
profile reached 1081 lines, 570 of them a list of defect classes whose own retirement rule
turned out to be satisfiable by almost no entry.

## What that bought

Some of it was real, and is kept here in compressed form.

- **The reviewer is the only thing that ever caught anything.** Measured across one phase
  and two tickets: all six claim-versus-measurement mismatches and the one genuine
  regression passed every local gate. Gates were green in 100% of the cases that mattered.
  So a red gate may skip the reviewer; a green one never may.
- **The author of a change does not judge its tests — but must see them.** Withholding the
  verdict is right. Withholding the fact costs a full round to surface something a fast
  test shows in a fraction of a second.
- **A gate result must not pass through an agent.** A test-runner specialist was deleted
  after measurement: 4 spawns, 256k tokens, 13% of a lane, **0 usable verdicts**. Green or
  red is an exit code, not a judgement.
- **A scoping tier between "fast" and "full" did not pay.** A per-task scope-selection map,
  three branches and per-path rows, resolved to the full suite on 2 tasks out of 2, and one
  phase plan budgeted twelve full runs for sixteen tasks. Two tiers here, no map.
- **Do not mechanise a rule that fires on cases it should not.** 87 sites were left to
  reviewer judgement rather than given a lint rule, because a rule that cries wolf gets
  worked around, and then it launders a violation as known noise.
- **Fifteen defect classes were one class.** Nearly all of them describe a claim about a
  search, a count or a population that the instrument producing it could not have
  falsified. That is four sentences in `.caw/agents/reviewer.md` now.

## The rule the rest follows from

> Only the executor can write, and only code.

Not as advice. As a `--tools` flag on every other agent.

## And this repository does not run on itself

The old one did, and self-hosting is the amplifier: it makes every document about the
pipeline simultaneously the product and an instance of it, so meta-work is indistinguishable
from work. This one is edited by hand and tested by running it on something else.
