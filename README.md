# craft-harness

An agent harness you own, built out of [Routecraft](https://routecraft.dev)
capabilities.

Chat, a sandboxed shell, web fetch and search, a workspace, memory, a
scheduler, and human approvals. Every one of them is an ordinary route in
`capabilities/` that you can read on one screen and change without asking
anyone. There is no agent framework layer here: the framework is Routecraft,
and this repository is what a project built on it looks like.

## Five minutes

```bash
bunx create-routecraft my-agent \
  --example https://github.com/routecraftjs/craft-harness
cd my-agent
```

Write a `.env` with the two values that have no sensible default. `.env.schema`
documents every variable this project reads; these are the ones that must be
set before anything happens.

```bash
cat > .env <<'EOF'
NODE_ENV=development
LLM_API_KEY=sk-your-key-here
ROUTECRAFT_SUSPENSION_SECRET=paste-openssl-rand-base64-32-here
EOF
```

Start it:

```bash
bun run dev
```

Talk to it, from another terminal:

```bash
bun run exec chat --session=demo --message="what can you do?"
```

Or connect an assistant to the MCP transport at `http://localhost:8082/mcp`
and use the `chat-tool` tool. Both reach the same conversation: the transcript
is a file, and `--session` names which one.

That is the whole loop. Everything below is what each part does and what it
refuses to do until you configure it.

## What is here

```
capabilities/     one folder per capability, each with a route.ts
agents/           aria.md (flat) and researcher/ (a bundle with its own skills)
skills/           house skills every agent gets; skills/proposed/ is a drop box
shared/           pure helpers: paths, transcripts, schedules, approvals
craft.config.ts   what discovery cannot work out on its own
env.ts            the environment contract, parsed once at boot
.env.schema       the same contract for a person, with no values in it
```

`craft start` discovers `capabilities/`, `agents/`, `skills/` and `plugins/`
from disk, so nothing is registered by hand. Read
[project structure](https://routecraft.dev/docs/introduction/project-structure)
for the convention.

## Chat

`chat` is a `direct()` route. It reads the session's transcript, records what
you said, dispatches the agent seeded with the conversation, appends the
answer and returns it. `chat-tool` is a second route that exposes the same
thing over MCP, because a route has one ingress and reaching it from an
assistant needs another one.

Transcripts are JSON Lines under `state/transcripts/`, one file per session.
They are the conversation a person would recognise, not the model's own
thread: you can open one, read it, and edit it.

There is no `craft chat` command. `craft exec chat` is the command, and it is
the same door the assistant and the scheduler use, which means the route's own
`.input()`, `.throttle()` and `.authorize()` apply to all three.

## The shell

`bash-runner` runs a script through `shell()` on the `unshare` isolation tier:
Linux kernel namespaces, no network egress, no view of host processes, none of
the caller's privileges. It is granted to the agent as `Bash`.

There is no command allowlist, deliberately. Deciding whether a command is
dangerous by reading it is a game the reader loses, and a checker that usually
works teaches everyone to trust a boundary that is not one. The tier is the
boundary.

What the tier does not do is stop the script reading files the account running
the harness can read: `~/.ssh` and `.env` are in the same filesystem view. Run
this as a user whose files you are willing to let a model read.

### macOS

`unshare` is Linux. There is no macOS equivalent shipped today, and the tier
is named for the mechanism precisely so it cannot claim something it does not
deliver. On macOS `bash-runner` fails at the call with `OS1001` naming the
missing tier.

That is this template's position: fail loudly, never degrade. Run the harness
on Linux or inside a container. Writing `isolation: "none"` in that route
would make it work on macOS by handing a model an unsandboxed shell as your
user, which is a different product.

## The web

`web-fetch` reads one page and answers a question about it. `web-search`
returns ranked results and deliberately answers nothing, so the reading and
the answering stay separate acts.

**A fresh scaffold reaches nothing.** `WEB_FETCH_ALLOWED_HOSTS` has no default
and no wildcard, so the empty allowlist refuses every URL until you decide
where the harness may go. `test/egress.test.ts` asserts that, so it cannot
quietly stop being true.

Redirects are re-checked rather than followed: the route asks for
`redirect: "manual"` and re-runs the same allowlist rule on the `Location`
before taking one further hop. A longer chain is refused. Following a 3xx by
default would have made the allowlist guard only the first request.

`web-search` needs `BRAVE_SEARCH_API_KEY`, and refuses at validation without
it rather than calling an endpoint that would answer 401.

## Workspace and memory

`workspace-read`, `workspace-write` and `workspace-list` work inside
`workspace/`, plus write access to `skills/proposed/`. The containment rule
resolves the path and compares it to the root, so `..`, an absolute path, and
a sibling directory whose name starts the same way are all refused by one
check.

`memory-save` and `memory-recall` are a folder of plain text files under
`memory/`, one per topic, appended to and searched by substring. No
embeddings, no index, nothing to reindex. You can read what the agent thinks
it knows, and delete a line you disagree with.

Nothing is recalled automatically. Recall is a tool the agent chooses to call.

## Scheduling and the heartbeat

`schedule-task` writes a line to `state/schedules.jsonl`. `scheduler-tick`
runs on its own cron, takes whatever is due, writes the rest back, and sends
each due task to `chat`. `list-schedules` and `cancel-schedule` are the rest.
Because the file is the state, a task survives a restart.

`heartbeat` asks the agent on a timer whether anything needs doing. It is
**off by default** and off by being unconstructed: with `HEARTBEAT_ENABLED`
unset, that module exports no routes at all. An agent that wakes itself up
spends money while nobody is watching.

## Approvals

`request-approval` asks a named human for permission and hands the agent back
two links, approve and deny, both single-use and both against the same parked
exchange. The agent puts the link in its reply. When a mailbox is configured,
the same links are also mailed to the approver.

The parked half is `approval-park`, which suspends with a 30 minute TTL. Its
continuation runs when someone answers, possibly days later and certainly in a
different process, and posts the verdict back into the conversation that asked.
`approval-callback` is the one endpoint both links open.

### The security model, plainly

At the floor, **the link is the credential**. The token is signed, single-use
and short-lived, and it proves this deployment minted it for this request. It
does not prove who is holding it.

Two things raise that floor without any code change:

- **The mail loop is the sender check.** A link is mailed only to an address
  `APPROVERS` names, so a request naming someone who is not configured never
  produces a delivery.
- **A validator on the mount upgrades everything.** Put `jwks({...})` on the
  `approvals` mount in `craft.config.ts` and `approval-callback`'s hook starts
  demanding a verified subject who is a configured approver. Every approval in
  the harness moves from "holder of a link" to "this person", and no route
  changes.

The scope a specific request needs is checked in `approval-park`'s
continuation rather than in the resume hook, because the hook deliberately
cannot see the parked body. The hook is the coarse check and runs before the
token is spent; the scope is the fine one and runs where the request is
readable.

`APPROVERS` is empty by default, so nobody can approve anything until you say
who can.

## Mail, dormant until you activate it

The mail capabilities are prefilled for Gmail and inert. Two values activate
them:

```
MAIL_ADDRESS=you@gmail.com
MAIL_APP_PASSWORD=your-app-passcode
```

An app passcode, not your account password: Gmail and its equivalents issue a
separate credential for IMAP and SMTP. Hosts and ports are already set
(`imap.gmail.com`, `smtp.gmail.com:587`); change them for another provider.

Until both exist, `capabilities/mail/*` export no routes and `craft.config.ts`
omits the `mail` key entirely. Nothing connects, nothing appears in the ops
listing, and nothing in the agent's tool surface claims a mailbox exists. That
is why this repository boots and passes CI with no secrets anywhere.

`mail-inbox` gives each correspondent their own conversation. It does **not**
decide who is allowed to talk to the agent: point it at a mailbox the public
can reach and anyone who can send mail can drive it. Put that rule in front of
the dispatch before you do.

## Compaction

`compact` reads a transcript, asks the model for a shorter version of the same
conversation with optional steering, validates the result against a schema,
and writes it back under the same session id. It is a tool the agent can call,
a command you can run, and a thing `schedule-task` can arrange.

It refuses to write a result that is empty or no shorter than what it
replaced, because a transcript file has no undo.

## Skills

Two ship: `skills/web-research` and `skills/scheduling`. They are house skills,
available to every agent, surfaced progressively so the model loads one when
it decides it is relevant.

The agent drafts new ones into `skills/proposed/`, which is **not loaded**:
nothing there reaches an agent until a person reads it and moves it into
`skills/`. That gap is the point. An agent that can grant itself new
instructions has no boundary left.

`agents/researcher/` shows the other shape: an agent bundle whose own
`skills/` folder is scoped to it alone.

## Configuration

`.env.schema` is the contract, in [varlock](https://varlock.dev) format: every
variable, what it is for, whether it is required, and never a value. `env.ts`
parses the same set at boot, so a misconfigured deployment fails naming the
variable rather than hours later inside a route.
`test/env-contract.test.ts` fails the build when the two drift apart.

Ports: ops on 8080 (where `craft exec` looks by default), approvals on 8081,
MCP on 8082.

## Working on it

```bash
bun run all          # format, typecheck, lint, test
bun run boot-check   # boot with no secrets and exit on the first exchange
```

The boot check is what CI runs. Its terminal outcome is the scheduler tick
finding nothing due and dropping, which is the one exchange this project
produces without reaching anything external.

## What this is not

`craft-showcase` is a different repository: a demo with Docker, fake mail and
seeded services, meant to be looked at. This one is a starting point meant to
be owned. There are no mock backends here, and nothing to delete before you
begin. Where a showcase would supply a fake, this supplies a placeholder that
fails loudly until you set it.
