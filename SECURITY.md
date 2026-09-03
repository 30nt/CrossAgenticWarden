# Security model

This file is what `caw.mjs` points at when it prints `UNBOUNDED RUNTIME RESIDUALS` before the
first paid call of every run. It states what the tool enforces, and — at greater length, because
that is the half people are surprised by — what it does not.

CAW runs model-authored code and commits the result. Read this before pointing it at a repository
that holds anything you would mind losing or leaking.

## What is enforced

**Only the executor writes delivery.** Every other role is launched without write tools. This is
a `--tools` flag on the child process, not an instruction in a prompt, and it is the rule the
rest of the design follows from.

**The reviewer writes only an engine-owned isolated surface.** It gets a place to make a fix inert
and re-run the suite. A patch it produces is checked before replay: a path that is absolute,
climbs with `..`, leaves the surface root, or lands in `.git/`, `.caw-tasks/` or `.caw-logs/`
rejects the whole verdict rather than that one item.

**Every bounded role runs inside an OS filesystem boundary.** macOS arm64 uses the seatbelt
through `/usr/bin/sandbox-exec`; Linux uses `bubblewrap`. A host with neither publishes no bounded
row, and preflight then refuses every pipeline command. Neither is installed for you and neither
substitutes for the other.

**A binding is unavailable until its probe is green.** Guarantees are established by a live call
on the machine that will execute them, not by a declaration in a config file. A CLI upgrade,
adapter change, executable change, missing evidence or red probe makes that binding unavailable
before spend. This is not a warning you can opt past.

**Gate results never pass through an agent.** Green or red is an exit code.

## What is NOT enforced

`externalToolAccess: forbidden` is narrower than "the role cannot reach anything external". It
says provider-native external tools are absent or disabled. It says nothing about a shell.

### Shell-mediated reads outside delivery

Any role with shell execution can read paths outside the delivery tree — including SSH keys and
provider authentication files, wherever OS permissions let the CAW process read them. **A write
boundary is not a read boundary.**

The measured seatbelt profiles begin with `(allow default)`, deny writes, and add only narrow read
denials for ignored paths inside a delivery or review surface. The provider process and the role's
shell share that profile. A general read denial would also have to preserve the provider's own
executable, libraries, configuration and authentication reads, and no complete allowlist has been
demonstrated on either supported provider.

### Shell-mediated outbound network traffic

Any role with shell execution can open outbound connections. Disabling provider-native web search,
apps and MCP servers does not prevent `curl` or equivalent shell code from using the network.

The provider CLI needs outbound access and runs inside the same OS profile as role commands. The
profiles contain no network denial, and applying one to the whole child prevents the provider call
rather than separating its control plane from a shell command.

### The Codex credential-copy window

This one exists **only if you set `CAW_CODEX_AUTH_FILE`.** The adapter copies that file into a
private transport, caps it at 1 MiB, and deletes the copy once it observes the turn start. From
child start until that event, the role's first shell command can read the copy and win the race.
Mode, size cap and deletion bound retention — they are not an access barrier.

Set that variable only if you accept the window. Nothing else in CAW requires it.

### The reviewer's work surface, on an install that does not authorize one

Counted by reading child-session transcripts on one install, because a run log holds verdicts and
never a tool call: **6 of 6 tasks judged, 39 commands outside the repository, twice a plain
`cp -r` of a tree holding a keystore and a mode-664 `.env`.** A second install, same behaviour,
opposite outcome: it copied only enumerated subtrees, so its two credential files never left.

Nothing observed so far predicts which shape you get. The `## Standing authorizations` section of
`.caw/CAW.md` is what makes the outcome independent of the shape — write it, and name the paths
the copy must never *receive*, not paths deleted afterwards.

## Reporting a vulnerability

Open a **private** security advisory through the repository's Security tab. Please do not open a
public issue for anything exploitable.

Include what you ran, on which OS and provider, and what you observed. A report that names its
instrument can be acted on; one that describes a worry cannot.

There is one maintainer and no service-level commitment. Expect acknowledgement rather than a
fix date.

## Scope

In scope: the engine, the vendored adapters, the guard hooks, and the documented install
procedure.

Out of scope: the provider CLIs themselves, and the residuals listed above under **What is NOT
enforced** — those are known, recorded, and printed before every run. A report re-describing one
of them is welcome as a refinement of the wording, not as a vulnerability.
