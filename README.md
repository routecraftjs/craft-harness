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
bun run setup
```

`setup` generates the two secrets that cannot be committed, writes them to
`.env` (gitignored), and writes `.routecraft/settings.yaml` so the CLI needs
no flags. It replaces nothing on a rerun. One value is left for you:

```bash
# in .env
LLM_API_KEY=sk-your-key-here
```

Start it:

```bash
bun run dev
```

Talk to it, from another terminal:

```bash
bun run exec chat --session=demo --message="what can you do?"
```

No `--token`, no `--url`: the instance is walled and the settings file carries
the credential. Or connect an assistant to the MCP transport at
`http://localhost:8081/mcp`, presenting the same key as a bearer token, and use
the `chat-tool` tool. Both reach the same conversation: the transcript is a
file, and `--session` names which one.

That is the whole loop. Everything below is what each part does and what it
refuses to do until you configure it.

### Cloning instead of scaffolding

A clone has no `.env` and no `.routecraft/`, because both are gitignored.
`bun run setup` is the same command and fills both in.

## What is here

```
capabilities/     one folder per capability, each with a route.ts
agents/           aria.md (flat) and researcher/ (a bundle with its own skills)
skills/           house skills every agent gets; skills/proposed/ is a drop box
shared/           pure helpers: paths, transcripts, schedules, approvals
scripts/setup.ts  generates this project's own credentials, once
craft.config.ts   what discovery cannot work out on its own, security included
env.ts            the environment contract, parsed once at boot
.env.schema       the same contract for a person, with no values in it
```

`craft start` discovers `capabilities/`, `agents/`, `skills/` and `plugins/`
from disk, so nothing is registered by hand. Read
[project structure](https://routecraft.dev/docs/introduction/project-structure)
for the convention.

## Security

The harness is walled from the first boot, with the static-key rung of
Routecraft's [credential ladder](https://routecraft.dev/docs/advanced/securing-capabilities)
pre-applied.

`bun run setup` generates `CRAFT_API_KEY` into `.env`. One validator in
`craft.config.ts` compares against it with `timingSafeStringEqual`, and all
three listeners use that one validator: the approval endpoint, the MCP
transport, and the ops door. One credential, one comparison, every surface.
Nothing in this repository ever holds the key, and nothing mints one at boot.

The ops tiers are scope-gated (`ops:introspection`, `ops:dispatch`) and the
validator puts those scopes on the principal it returns. `setup` also writes
the key and the ops url into `.routecraft/settings.yaml`, which is why
`craft exec` needs no flags against a walled instance.

A refused caller is told what to do about it:

```
$ craft exec --token wrong-key list-schedules
Refused: the instance rejected the credential (invalid_token).
The instance advertises no authorization server, so discovery cannot say who
issues. Ask whoever operates the instance how to obtain a credential.
Scopes this surface understands: ops:introspection, ops:dispatch.
```

That is not the harness explaining itself. Every 401 carries an RFC 9728
`resource_metadata` hint, the instance serves the document it points at, and
the CLI follows it. With a static key there is no issuer to discover, and the
message says so rather than inventing one.

**Rotating** is deleting `CRAFT_API_KEY` from `.env` and
`.routecraft/settings.yaml` and running `bun run setup` again. Setup never
replaces a value that is there, so rotation is something you do rather than
something that happens to you.

**Moving up the ladder** is a change to one object in `craft.config.ts`:
`jwt({ secret, issuer, audience })` for tokens you mint yourself,
`jwks({ jwksUrl, issuer, audience })` for a real identity provider. Every
surface follows and no route changes, because a route says what it needs
(`.authorize()`) and never how a credential is verified.

**The one public surface** is the approvals mount, and that is deliberate: an
approver clicks a link from their mail client and has no API key. Their
credential is the single-use token in the URL. See
[the approval security model](#the-security-model-plainly) below.

## What is switched off, and why you can tell

Three routes in a fresh scaffold are registered and not running. They are not
missing, and that difference is the point: a route nobody wrote looks exactly
like a route that is deliberately off, and only one of those is something you
can fix.

```
$ craft ops routes
ROUTE          DISPATCHABLE  ENABLED  SOURCES
heartbeat      no            no       timer    Ask the agent on a timer ...
mail-inbox     no            no       mail     Answer mail that arrives ...
mail-reply     no            no       direct   Send an email.
```

`craft ops health` says why:

```json
"mail-inbox": {
  "status": "inactive",
  "details": {
    "lifecycle": "disabled",
    "reason": "MAIL_ADDRESS, MAIL_APP_PASSWORD unset"
  }
}
```

The reason is the predicate's own return value, so it names the variables
actually missing rather than a sentence someone wrote once. `inactive` rather
than `down`: a deliberate configuration state must not degrade health.

A disabled route is also absent from the agent's tool surface. Aria's tool
list names `Direct(mail-reply)` unconditionally; enablement removes it. "The
agent cannot send mail until a mailbox is configured" is therefore true by
construction rather than by the model behaving well.

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
the harness can read. `.env` is in the same filesystem view, and it holds
`CRAFT_API_KEY`, which is the credential walling every surface this harness
exposes, and `ROUTECRAFT_SUSPENSION_SECRET`, which signs approval links.
`~/.ssh` is in there too. `network: false` does not contain what the shell
reads, because the shell is not the turn's only way out: the same agent holds
`web-fetch`, `mail-reply` and its own reply. Treat a command reaching this
tier as able to reach anything the account can read, and anything it reads as
able to leave.

Run this as a user whose files you are willing to let a model read, and keep
the harness's own secrets somewhere that account cannot: a container whose
only bind mount is `workspace/` is the shape that actually closes this.

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

The page is parsed rather than pattern-matched. `web-fetch` extracts through
the framework's `html()`, which is cheerio, so entity decoding and dropping
script and style content are the parser's rules rather than this repository's.

Extraction is per block (`h1` to `h6`, `p`, `li`, `pre`, `blockquote`, table
cells and a few others), joined with newlines, rather than taking the whole
document's text. Cheerio concatenates descendant text with nothing between it,
so a minified page, which is most of them, comes back as
`Getting startedInstall the package.` and the model is asked to quote wording
that was never on the page. A page whose prose sits loose in a `div` matches
no block and falls back to the whole document, because answering from an empty
page reads to the caller as the page not covering their question.

`cheerio` is a direct dependency rather than an inherited one. It is an
optional peer of `@routecraft/routecraft`, and it was only present here by way
of `@routecraft/cli`, which is a devDependency: a production install would
have had `html()` fail with `RC5017` at the first fetch.

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

`schedule-task` adds a task to `state/schedules.jsonl`. `scheduler-tick` runs
on its own cron, takes whatever is due, writes the rest back, and sends each
due task to `chat`. `list-schedules` and `cancel-schedule` are the rest.
Because the file is the state, a task survives a restart.

None of them touches the file. Every one of those operations is a read, a
change and a whole-file write, and four routes doing that against one path is
four ways to lose a task: a tick firing while a task is being added writes back
a file the new task was never in, and neither route fails. So the file has an
owner. `schedules-owner` performs the whole cycle under `.concurrency({ max: 1
})`, and everything else states what it wants and submits it there. Transcripts
work the same way through `transcript-owner`, keyed by session so two
conversations do not queue behind each other.

The lock is in memory and belongs to one instance, which is what the framework
offers today. It covers every writer inside a running harness, which is what
the races above are: routes in one process contending for one file. It does
not cover two harnesses sharing a working directory, nor a person editing a
state file by hand while one is running. Neither is a supported way to run
this, and if you need the first, the state directory is the thing to give each
instance its own copy of.

Reads change nothing. A read answers from the file and writes nothing back,
which matters because the parse drops lines the schema rejects: answering
`list-schedules` by rewriting what it parsed would erase a line somebody
hand-edited, permanently and without an error.

The lock is keyed by the file rather than by the caller. Per-route keying would
give each route its own slot and close nothing, because the race being closed
is between routes contending for one file.

## State is written before the caller is told

A route that reports work done has done it. That sounds like nothing until you
know that `.tap()` is detached by contract: the framework runs it on a tracked
task and the pipeline continues immediately. Every write in this harness used
one, so `schedule-task` answered before the task was on disk, `memory-save`
returned `saved: true` before the append, `workspace-write` reported a byte
count for a file that did not exist yet, and `mail-reply` said `sent: true`
before the message left. The next read saw the state before the last write, and
a failed write reached nobody: the agent had already told someone it was done.

Every write is `.to()` now, which the pipeline waits for. This also has to be
true for the owner routes to mean anything, because a lock can only serialise
work the route waits for.

`heartbeat` asks the agent on a timer whether anything needs doing. It is
**off by default**: with `HEARTBEAT_ENABLED` unset the route is registered and
not started, and `craft ops health` says which variable turns it on. An agent
that wakes itself up spends money while nobody is watching.

## Approvals

`request-approval` asks a named human for permission and hands the agent back
two links, approve and deny, both single-use and both against the same parked
exchange. The agent puts the link in its reply. When a mailbox is configured,
the same links are also mailed to the approver.

The parked half is `approval-park`, which suspends with a 30 minute TTL. Its
continuation runs when someone answers, possibly days later and certainly in a
different process, and posts the verdict back into the conversation that asked.
Both links open `approval-confirm`, which renders the verdict and a form and
resolves nothing. The token is spent only by `approval-callback`, which is
POST-only and reached only by submitting that form.

That split is not ceremony. The links travel by mail and in the agent's reply,
and both are read by machines before a human sees them: Safe Links, Proofpoint,
the Gmail proxy, antivirus scanners and chat unfurlers all issue a GET on every
link they find. An endpoint that resolved on retrieval would be resolved by
whichever scanner arrived first, and since both links sit in the same message,
which verdict it picked would be arbitrary. A form post is not something a
client that only retrieves will do.

It stops prefetching, not automated interaction. A detonation sandbox or
browser-isolation proxy that renders the page and clicks the button gets
through, and a nonce would not help because a renderer carries it too. The
only thing that upgrades this flow from "holder of a link" to "this person" is
a validator on the `approvals` mount, at which point the callback's authorize
hook starts demanding a verified approver.

The page names the verdict, not the request. Reading a parked exchange by
token needs `suspensionIdFor` and the configured store, and the framework
exports neither to a route, so an approver arriving cold has to recognise
which request they are answering from the mail that carried the link. Two
pending approvals are therefore told apart by their mail, not by the page.
Closing that needs a framework change and is filed, not fixed here.

A path segment this harness did not mint is refused with a 400 and a page
saying so. Folding an unrecognised verdict to `deny` would render a working
deny button for a link the system never issued, so a mangled URL would record
a denial nobody made.

An answer that cannot land gets the same treatment. A link opened after the
TTL, or one already spent, or one the resume hook refuses, all reach a 400 and
one sentence: nothing changed, ask for a new link. They are deliberately not
told apart, because the difference is the record's lifecycle and this mount
demands no credential. Without that arm the resume throws and the dispatcher
answers `{"error":"internal server error"}`, which is what an approver reading
their mail an hour late would otherwise see. The confirmation page says up
front how long the link lives, so the wait is a known one.

Both doors throttle per token rather than per route. A single bucket for the
whole route would let any anonymous caller spend the minute on tokens nobody
minted and have every genuine approver rejected, which is an approval gate
held shut by a stranger for the cost of one request every two seconds.

The pages carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
The URL they are fetched at contains the token, and the token is a bearer
credential, so it has no business in a shared cache or in a `Referer`.

`approval-park` is declared `direct({ internal: true })`. It exists to be
called by `request-approval` and by nothing else: it carries no `.authorize()`
because its caller does, and its answer to any other caller is a suspension
acknowledgment nobody asked for. Internal keeps the in-process call working
exactly as before and closes both external doors, so it is absent from
`craft exec`, refused by name if someone tries, never offered to the agent,
and listed as `dispatchable: false`.

Three routes here are internal: `approval-park` and the two state owners,
`schedules-owner` and `transcript-owner`. The owners are locks rather than
capabilities, and the reasoning is the same one: an agent asked to cancel
something should reach `cancel-schedule`, which validates what it is being
asked, and the owner trusts its caller precisely because its caller is in this
process. Every other `direct()` route here is a boundary capability and stays
open.

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

Until both exist, both mail routes are `.enabled()`-disabled: registered,
visible, not started, absent from the agent's tools, and reported by
`craft ops health` as `MAIL_ADDRESS, MAIL_APP_PASSWORD unset`. No IMAP
connection is opened and `craft.config.ts` declares no mail account, which is
why this repository boots and passes CI with no secrets anywhere.

Setting both and restarting is the whole activation. Nothing else changes: the
tool list already names `Direct(mail-reply)`, and the route appearing is what
puts it on aria's surface.

`mail-inbox` gives each correspondent their own conversation. It does **not**
decide who is allowed to talk to the agent: point it at a mailbox the public
can reach and anyone who can send mail can drive it. Put that rule in front of
the dispatch before you do.

## Compaction

`compact` reads a transcript, asks the model for a shorter one, and replaces
the file. It is an ordinary tool: the agent can call it, a person can run it
with `craft exec`, and `schedule-task` can arrange it for later. Nothing
compacts automatically, because deciding a conversation has gone on long
enough is a judgement, not a threshold.

Three rules stand between the model's answer and the file: the result must
have turns, it must be shorter than what it replaced, and the transcript must
still hold the same number of turns `compact` read. All three are applied by
`transcript-owner` inside its lock, because a model call takes seconds and a
turn arriving in that window would otherwise be erased by a replacement
computed before it existed. A transcript file has no undo.

A session with no transcript is refused before the model is asked. There is no
conversation to shorten, so the call could only be spent to reach a refusal
that was knowable for free, which is what a typo in `--session` used to cost.

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

`.env.schema` is the contract: every variable, what it is for, whether it is
required, and never a value. It follows [varlock](https://varlock.dev)
annotation format, but nothing here runs varlock; the format is a convention
so that adopting the tool later is an install rather than a rewrite. `env.ts`
parses the same set at boot with zod, so a misconfigured deployment fails
naming the variable rather than hours later inside a route.
`test/env-contract.test.ts` fails the build when the two drift apart.

Ports: approvals on 8080, MCP on 8081, ops on 9090. The application surface
takes the conventional port because it is the one a human opens from their
mail; management is kept off it. `craft exec` looks at 8080 by default, which
would be the wrong door, and never needs to: `bun run setup` writes the real
ops url into `.routecraft/settings.yaml`.

## Working on it

```bash
bun run setup        # generate this project's credentials, once
bun run all          # format, typecheck, lint, test
bun run boot-check   # boot and exit on the first exchange
```

The boot check is what CI runs, with a generated key and nothing else
configured. Its terminal outcome is the scheduler tick finding nothing due and
dropping, which is the one exchange this project produces without reaching
anything external.

The test suite pins its own environment rather than reading yours (see
`test/setup.ts`). Half of it asserts what a scaffold does before anything is
configured, and your `.env` would quietly turn those into assertions about
your machine.

## What this is not

`craft-showcase` is a different repository: a demo with Docker, fake mail and
seeded services, meant to be looked at. This one is a starting point meant to
be owned. There are no mock backends here, and nothing to delete before you
begin. Where a showcase would supply a fake, this supplies a placeholder that
fails loudly until you set it.
