import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientContext, client } from "@agentclientprotocol/sdk";
import { tools } from "@routecraft/ai";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type {
  ClientCapabilities,
  RequestPermissionOutcome,
} from "@agentclientprotocol/sdk";
import { bootServer, type TestContext } from "@routecraft/testing";
import { MockLanguageModelV3 } from "ai/test";
import type { AnyRouteBuilder } from "@routecraft/routecraft";

/**
 * An editor, scripted, on the other end of the real ACP mount.
 *
 * The capabilities in `capabilities/editor/` are only meaningful against a
 * client, because every one of them is a call OUT to the person's editor.
 * Asserting them against a stub of the framework's surface would test the
 * stub. So this boots the mount the project actually serves, connects the
 * ACP SDK's own client over HTTP, and answers the protocol for real:
 * `terminal/create` spawns a child process, `terminal/output` returns what
 * that process actually wrote, and `terminal/kill` actually kills it.
 *
 * Two things it adds that a real editor does not. It records every call it
 * receives, in order, so a test can assert that a terminal was released and
 * not merely that the output looked right. And the model is a stub that
 * emits one tool call, because a turn is what carries a surface and this
 * suite has no model provider: `provider: "custom"` is the framework's
 * documented escape hatch for exactly that, and it means these tests make no
 * network call of any kind.
 */

/**
 * One part of a model's stream, as the SDK's provider contract shapes it.
 * Structural rather than imported: `@ai-sdk/provider` is a transitive
 * dependency here, and a test helper should not pin a version of it.
 */
type StreamPart = Record<string, unknown> & { type: string };

/** One protocol call the editor received, as a test reads it back. */
export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

/** How a case wants this editor to behave where behaviour is a choice. */
export interface ScriptedEditorOptions {
  /** Routes to register. The capability under test, and anything it calls. */
  routes: AnyRouteBuilder[];
  /**
   * Route id the stubbed model calls, e.g. `run-command`.
   *
   * One name in, two out: the tool builder wants `Direct(run-command)` and
   * the model emits `direct__run-command`, and a caller that has to know
   * both spellings will eventually pass one where the other belongs.
   */
  route: string;
  /** Arguments the stubbed model calls it with. */
  input: unknown;
  /**
   * What the editor advertises at `initialize`. Defaults to a capable
   * editor; a case proves the refusal path by handing over one that offers
   * no terminal.
   */
  capabilities?: ClientCapabilities;
  /** How the editor answers a permission request. Defaults to allowing. */
  permission?: (params: Record<string, unknown>) => RequestPermissionOutcome;
  /** Files the editor will serve to `fs/read_text_file`, by absolute path. */
  files?: Record<string, string>;
  /**
   * Cancel the turn the first time this method is received.
   *
   * A person hitting stop while something runs, expressed the way the
   * protocol expresses it: a `session/cancel` notification mid-turn.
   */
  cancelOn?: string;
  /**
   * Commands this machine does not have.
   *
   * The editor answers a `terminal/create` for one of these the way it
   * answers a spawn that failed: exit 127, nothing on the output. Emulated
   * at the editor rather than by editing PATH, because every directory that
   * holds ripgrep also holds git, and removing it would take the fallback
   * away along with the thing being hidden.
   */
  absent?: string[];
  /** Files to write into the project before the turn, by relative path. */
  seed?: Record<string, string>;
  /** Make the project a git repository with the seeded files committed. */
  gitInit?: boolean;
  /**
   * How long to keep the connection open after the prompt resolves, for
   * updates and cleanup calls that land just after it. A cancelled turn
   * unwinds after its prompt has already answered, so a case about
   * cancellation needs longer than one about a normal reply.
   */
  drainMs?: number;
}

/** What a case gets back: the turn's outcome and everything that happened. */
export interface ScriptedEditorRun {
  /** The project directory the session was opened in. */
  cwd: string;
  /** Every call the editor received, in order. */
  calls: RecordedCall[];
  /** Calls of one method, for the common assertion. */
  callsTo: (method: string) => RecordedCall[];
  /** Text the agent replied with, joined. */
  text: string;
  /** How the prompt turn ended, e.g. `end_turn`, `cancelled`, `refusal`. */
  stopReason: string;
  /** Files the editor holds after the turn, by absolute path. */
  files: Record<string, string>;
  /** Contents the agent wrote through `fs/write_text_file`. */
  written: Record<string, string>;
  /**
   * The tool's own result, as the editor saw it on the tool-call update.
   * Undefined when the call failed.
   */
  toolOutput: Record<string, unknown> | undefined;
  /** Whether the tool call ended as failed. */
  toolFailed: boolean;
  /** The tool call's reported text, which carries a failure's reason. */
  toolText: string;
  /** Names left in the project directory after the turn. */
  leftInProject: string[];
  /**
   * What the model was handed after the tool ran, serialised.
   *
   * The editor is told only that a call failed and which class of error it
   * was, so a failure's actual reason is visible here and nowhere else.
   */
  modelSaw: string;
}

/** An editor that offers everything the capabilities here can ask for. */
export const CAPABLE_EDITOR: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/**
 * A model that calls one tool and then stops.
 *
 * `finishReason` is `{ unified }` rather than a string. That is the whole
 * difference between a turn that runs the tool and one that emits the call
 * and stops after a single step with nothing executed, because the SDK reads
 * `.unified` and a string leaves it undefined.
 *
 * Two steps: emit the tool call, then, once its result comes back, finish
 * with the result as text. That is the smallest shape that exercises a real
 * turn, and the text is what a case reads to see what the capability
 * answered.
 */
function oneToolCall(
  route: string,
  input: unknown,
  seen: { prompt: string },
): MockLanguageModelV3 {
  // The mock's `doStream` is typed against the provider package's own part
  // union, which this project does not depend on directly. The parts below
  // are that union's shapes; the cast is what keeps a transitive type out of
  // a test helper's signature.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let called = false;
  return new MockLanguageModelV3({
    doStream: (async (options: { prompt?: unknown }) => {
      if (called) {
        // The second call carries the tool's result, which is what the model
        // actually gets to read. The editor is shown only that the call
        // failed, so this is the only place a failure's reason is visible.
        seen.prompt = JSON.stringify(options.prompt ?? null);
      }
      if (called) {
        return {
          stream: simulateStream([
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "done" },
            { type: "text-end", id: "0" },
            {
              type: "finish",
              finishReason: { unified: "stop" },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]),
        };
      }
      called = true;
      return {
        stream: simulateStream([
          {
            type: "tool-input-start",
            id: "call-1",
            toolName: `direct__${route}`,
          },
          {
            type: "tool-input-delta",
            id: "call-1",
            delta: JSON.stringify(input),
          },
          { type: "tool-input-end", id: "call-1" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: `direct__${route}`,
            input: JSON.stringify(input),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls" },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      };
    }) as any,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * The AI SDK's stream shape, from a list of parts.
 *
 * `stream-start` is prepended because the protocol expects it first and a
 * stream without it produces a turn that ends with nothing in it, which
 * reads exactly like a model that was never called.
 */
function simulateStream(parts: StreamPart[]): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/**
 * Run one turn against the real mount with this editor on the other end.
 *
 * The temporary directory is the session's `cwd`, which is what makes "it
 * runs in the project" assertable: a command that prints its working
 * directory must print this path and never the one this process runs in.
 */
export async function runWithScriptedEditor(
  options: ScriptedEditorOptions,
): Promise<ScriptedEditorRun> {
  const cwd = await mkdtemp(join(tmpdir(), "scripted-editor-"));
  for (const [name, content] of Object.entries(options.seed ?? {})) {
    await writeFile(join(cwd, name), content);
  }
  if (options.gitInit === true) {
    // A real repository, because the fallback under test is `git grep`, and
    // git refuses to grep outside one.
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
    ]) {
      spawnSync("git", args, { cwd });
    }
  }
  const calls: RecordedCall[] = [];
  const files: Record<string, string> = { ...(options.files ?? {}) };
  const written: Record<string, string> = {};
  const terminals = new Map<string, Terminal>();
  const seen = { prompt: "" };

  let booted: { ctx: TestContext; port: number } | undefined;
  try {
    booted = await bootServer((builder) =>
      builder
        .with({
          llm: {
            providers: {
              custom: {
                model: oneToolCall(options.route, options.input, seen),
              },
            },
          },
          agent: {
            agents: {
              aria: {
                description: "The harness agent.",
                system: "You are Aria.",
                model: "custom:stub",
                tools: tools([`Direct(${options.route})`]),
              },
            },
            toolPolicy: { fn: true, direct: true, mcp: false },
          },
          acp: { server: "default", agent: "aria" },
          suspension: {},
          servers: { default: { host: "127.0.0.1", port: 0 } },
        })
        .routes(options.routes),
    );

    let sessionId = "";
    let cancelled = false;
    const record = (method: string, params: unknown): void => {
      calls.push({ method, params: params as Record<string, unknown> });
    };

    /**
     * Cancel once, and only once the call that triggers it has been
     * recorded, so a case can assert on the call that was in flight.
     */
    const cancelIfAsked = (method: string, agent: ClientContext): void => {
      if (options.cancelOn !== method || cancelled) return;
      cancelled = true;
      void agent.notify("session/cancel", { sessionId });
    };

    const editor = client({ name: "scripted-editor" })
      .onRequest("terminal/create", async ({ params, agent }) => {
        record("terminal/create", params);
        cancelIfAsked("terminal/create", agent);
        const id = `terminal-${terminals.size + 1}`;
        const create = params as CreateParams;
        terminals.set(
          id,
          (options.absent ?? []).includes(create.command)
            ? notInstalled()
            : openTerminal(create, cwd, params.cwd ?? cwd),
        );
        return { terminalId: id };
      })
      .onRequest("terminal/output", async ({ params }) => {
        record("terminal/output", params);
        const terminal = terminals.get(params.terminalId)!;
        return {
          output: terminal.output(),
          truncated: terminal.truncated(),
          ...(terminal.exitCode === undefined
            ? {}
            : { exitStatus: { exitCode: terminal.exitCode } }),
        };
      })
      .onRequest("terminal/wait_for_exit", async ({ params, agent }) => {
        record("terminal/wait_for_exit", params);
        cancelIfAsked("terminal/wait_for_exit", agent);
        const terminal = terminals.get(params.terminalId)!;
        return { exitCode: await terminal.exited };
      })
      .onRequest("terminal/kill", async ({ params }) => {
        record("terminal/kill", params);
        terminals.get(params.terminalId)?.kill();
        return {};
      })
      .onRequest("terminal/release", async ({ params }) => {
        record("terminal/release", params);
        terminals.get(params.terminalId)?.kill();
        terminals.delete(params.terminalId);
        return {};
      })
      .onRequest("fs/read_text_file", async ({ params }) => {
        record("fs/read_text_file", params);
        const content = files[params.path];
        if (content === undefined) {
          throw new Error(`No such file: ${params.path}`);
        }
        return { content };
      })
      .onRequest("fs/write_text_file", async ({ params }) => {
        record("fs/write_text_file", params);
        files[params.path] = params.content;
        written[params.path] = params.content;
        return {};
      })
      .onRequest("session/request_permission", async ({ params }) => {
        record("session/request_permission", params);
        const answer = options.permission?.(
          params as unknown as Record<string, unknown>,
        );
        return {
          outcome: answer ?? { outcome: "selected", optionId: "allow" },
        };
      })
      .onRequest("elicitation/create", async ({ params }) => {
        record("elicitation/create", params);
        return { action: "accept" };
      })
      .onNotification("session/update", async ({ params }) => {
        record("session/update", params);
      });

    const stream = createHttpStream(`http://127.0.0.1:${booted.port}/acp`, {});
    const result = await editor.connectWith(stream, async (agent) => {
      await agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: options.capabilities ?? CAPABLE_EDITOR,
      });
      const session = await agent.buildSession(cwd).start();
      sessionId = session.sessionId;
      const answer = await session.prompt([{ type: "text", text: "go" }]);
      // Notifications are not ordered against the prompt's own reply, and
      // the tool call's settled update routinely lands just after it. Closing
      // the connection the instant the prompt resolves loses exactly the
      // update a case wants to read, which looks like the mount never sent
      // one.
      await Bun.sleep(options.drainMs ?? 150);
      return answer;
    });

    const call = toolCallFrom(calls);
    return {
      cwd,
      calls,
      callsTo: (method) => calls.filter((call) => call.method === method),
      text: textFrom(calls),
      stopReason: String(result.stopReason),
      files,
      written,
      toolOutput: call.output,
      toolFailed: call.failed,
      toolText: call.text,
      leftInProject: await readdir(cwd),
      modelSaw: seen.prompt,
    };
  } finally {
    for (const terminal of terminals.values()) terminal.kill();
    await booted?.ctx.stop();
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Params `terminal/create` carries, narrowed to what this editor uses. */
interface CreateParams {
  command: string;
  args?: string[];
  outputByteLimit?: number | null;
  cwd?: string | null;
}

/** A real child process, with the client-side half of the terminal contract. */
interface Terminal {
  output: () => string;
  truncated: () => boolean;
  exitCode: number | undefined;
  exited: Promise<number>;
  kill: () => void;
}

/**
 * Spawn the command for real, in the session's directory.
 *
 * Standard error is merged into standard output because that is the single
 * stream the protocol carries, and truncation drops from the FRONT to stay
 * within the limit, which is what the schema tells clients to do.
 */
function notInstalled(): Terminal {
  return {
    output: () => "",
    truncated: () => false,
    exitCode: 127,
    exited: Promise.resolve(127),
    kill: () => undefined,
  };
}

function openTerminal(
  params: CreateParams,
  sessionCwd: string,
  requestedCwd: string,
): Terminal {
  const child = spawn(params.command, params.args ?? [], {
    cwd: requestedCwd === "" ? sessionCwd : requestedCwd,
    // No shell, ever. The list of arguments is the list of arguments.
    shell: false,
    // Standard input is closed rather than left as an open pipe. A pipe
    // nothing ever writes to makes any program that reads stdin when it has
    // no file argument, ripgrep and grep among them, wait forever, which
    // reaches the capability as a timeout rather than as a result.
    stdio: ["ignore", "pipe", "pipe"],
  });

  const limit = params.outputByteLimit ?? Number.MAX_SAFE_INTEGER;
  let buffer = "";
  let dropped = false;
  const append = (chunk: Buffer): void => {
    buffer += chunk.toString();
    if (buffer.length > limit) {
      buffer = buffer.slice(buffer.length - limit);
      dropped = true;
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const terminal: Terminal = {
    output: () => buffer,
    truncated: () => dropped,
    exitCode: undefined,
    exited: new Promise<number>((resolve) => {
      child.on("close", (code, signal) => {
        // A killed process has no exit code, and the protocol carries the
        // signal separately; the capability only reads the code, so a
        // signalled death answers as a non-zero one.
        const value = code ?? (signal === null ? 0 : 137);
        terminal.exitCode = value;
        resolve(value);
      });
      child.on("error", () => {
        terminal.exitCode = 127;
        resolve(127);
      });
    }),
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
  return terminal;
}

/**
 * What the tool call reported, read off the updates the agent pushed.
 *
 * The mount reports a tool call twice, in progress and then settled, so the
 * last update for the call is the one that carries its outcome.
 */
function toolCallFrom(calls: RecordedCall[]): {
  output: Record<string, unknown> | undefined;
  failed: boolean;
  text: string;
} {
  let output: Record<string, unknown> | undefined;
  let failed = false;
  let text = "";
  for (const call of calls) {
    if (call.method !== "session/update") continue;
    const update = (call.params as { update?: Record<string, unknown> }).update;
    if (update?.["sessionUpdate"] !== "tool_call_update") continue;
    if (update["status"] === "failed") failed = true;
    const raw = update["rawOutput"];
    if (raw !== undefined && raw !== null) {
      output = raw as Record<string, unknown>;
    }
    for (const block of (update["content"] ?? []) as Array<
      Record<string, unknown>
    >) {
      const inner = block["content"] as { text?: string } | undefined;
      text += inner?.text ?? "";
    }
  }
  return { output, failed, text };
}

/** The agent's own text, pulled out of the session updates it pushed. */
function textFrom(calls: RecordedCall[]): string {
  let text = "";
  for (const call of calls) {
    if (call.method !== "session/update") continue;
    const update = (call.params as { update?: Record<string, unknown> }).update;
    if (update?.["sessionUpdate"] !== "agent_message_chunk") continue;
    const content = update["content"] as { text?: string } | undefined;
    text += content?.text ?? "";
  }
  return text;
}
