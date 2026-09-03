# Contributing

*[Русская версия](docs/contributing.ru.md)*

This project has an unusual bar, and it is worth stating plainly before you spend an evening on
something that will be declined.

**The currency here is a measurement, not an opinion.** The tool exists because its predecessor
grew until 19 of its last 27 closed tickets were meta-work — work the pipeline had generated for
itself. Everything below is the machinery that keeps that from happening again.

## What a useful contribution looks like

A number, and the instrument that produced it.

> On Linux 6.8 / bubblewrap 0.9.0 / Node 20.11, `node caw.mjs probe claude` fails at
> `<step>` with `<output>`. Reproduced 3 of 3 times. Working around it with `<x>` makes
> it pass.

That is actionable. This is not:

> The probe seems flaky on Linux.

The difference is not politeness. A claim about a population is the claim nobody checks, and
patterns written to count things have been silently wrong here twice — a task-name pattern that
could not match a digit, and a phrase pattern missing one word of the line it was written for.
**State the population, count it, then read one member by hand.**

Three rules that cost real money to learn:

- **Name the subject inside the claim, not in front of it.** "`caw.mjs` at `6f1cb37` prints no
  residual block" cannot be widened by accident; "it prints no residual block" can, and was.
- **Never derive a negative from truncated output.** One report said a branch was absent from a
  remote, having run `git branch -a | head -5` over a seven-line list whose seventh line was the
  branch. Re-run without the pipe before asserting an absence.
- **A document saying what should be there is evidence about intent and none about state.**

## Issues, and which kind

- **Measured defect** → an issue. Something is broken and you have the output.
- **Hypothesis** → a Discussion. A falsifiable claim, alive until refuted or built:

  ```
  claim:        <one falsifiable sentence>
  subject:      <the file, function or command it is about>
  refuted by:   <the observation that would kill it>
  becomes:      <the code change it would justify, or — >
  ```

- **Security** → not an issue. See [SECURITY.md](SECURITY.md).

## What is declined by default

Not because the idea is bad — because this specific project has measured what these cost.

- **Rules about the tool itself.** New profile sections, new defect classes, new conventions
  documenting conventions. The profile this one replaced reached 1081 lines and every one was
  added by someone with a good reason.
- **A defect class with no named precedent.** If you cannot point at the code that proves it,
  it is a preference.
- **Mechanising a rule that fires on cases it should not.** A rule that cries wolf gets worked
  around, and then it launders a violation as known noise. 87 sites were left to reviewer
  judgement for exactly this reason.
- **Configuration knobs.** The answer to "it should be configurable" here is usually a refusal
  that names the situation instead.
- **Making the tool run on itself.** Deliberate, and explained in [WHY.md](WHY.md).

## Sending a patch

```bash
node --test test/*.test.mjs      # must be green
python3 -m pytest .caw/hooks     # must be green
```

Live tests (`*-live.test.mjs`) make real, paid provider calls and are not part of that bar. Run
them if you can; say so if you did.

**Sign your commits off** with the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

That is the whole legal process. There is no CLA.

A commit message here says what changed and **what it cost to find out**. Look at `git log` — a
one-line message is fine for a mechanical change and out of place for a behavioural one.

## On AI-authored patches

This is a tool for running models on repositories, so a patch written by one is not a problem.
The project's own rule applies unchanged, to you and to it:

**The author of a change does not judge its tests.** If a model wrote the patch and the same
model told you it works, you have one opinion, not two. Run the suite yourself, and say in the
PR what you verified by hand.

A patch whose description contains a claim about a population that the model could not have
falsified — "all callers updated", "no other usages" — will be asked for the count and how it
was taken. That is the single most common defect class this project has measured, across
fifteen apparent classes that turned out to be one.

## Support expectations

One maintainer, a research tool, no service-level commitment. Expect acknowledgement rather than
a fix date. An issue may be closed as "recorded, not scheduled" and that is not a rejection —
[limitations.md](docs/limitations.md) is where those live, on purpose.
