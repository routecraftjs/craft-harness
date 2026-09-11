# Your agent harness

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

That is the whole loop.

`HELP.md` is the rest: what every capability does, what it refuses to do
until you configure it, and how to reach this from your editor. Read it once
and delete it. This file is yours to rewrite as your project's own.

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
HELP.md           the scaffold explaining itself; safe to delete
```

`craft start` discovers `capabilities/`, `agents/`, `skills/` and `plugins/`
from disk, so nothing is registered by hand. Read
[project structure](https://routecraft.dev/docs/introduction/project-structure)
for the convention.

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
