import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one command between a clone and a running instance.
 *
 * Setup generates the two secrets that cannot be committed and writes them
 * where they are read from. What it must never do is replace one: a rerun
 * that minted a fresh key would silently invalidate the settings file, every
 * link already mailed, and every parked approval.
 *
 * Run as a subprocess against a scratch directory, because that is the only
 * way to test a script whose whole job is which files exist afterwards.
 */
describe("bun run setup", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "harness-setup-"));
    await mkdir(join(scratch, "scripts"), { recursive: true });
    await writeFile(
      join(scratch, "scripts", "setup.ts"),
      await readFile(new URL("../scripts/setup.ts", import.meta.url), "utf8"),
    );
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const run = async (): Promise<string> => {
    const proc = Bun.spawn(
      ["bun", "run", join(scratch, "scripts", "setup.ts")],
      {
        cwd: scratch,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
    return await new Response(proc.stdout).text();
  };

  const envValue = async (name: string): Promise<string> => {
    const contents = await readFile(join(scratch, ".env"), "utf8");
    return new RegExp(`^${name}=(.*)$`, "m").exec(contents)?.[1] ?? "";
  };

  /**
   * @case A fresh directory gets both secrets and a usable settings file
   * @preconditions Neither .env nor .routecraft/ exists, as after a clone
   * @expectedResult Both secrets generated at full length, and the settings
   *   file carrying the same key plus the ops url, so `craft exec` needs no
   *   flags on the very first run
   */
  test("generates both secrets and the settings file", async () => {
    await run();

    expect((await envValue("CRAFT_API_KEY")).length).toBeGreaterThanOrEqual(32);
    expect(
      (await envValue("ROUTECRAFT_SUSPENSION_SECRET")).length,
    ).toBeGreaterThanOrEqual(32);

    const settings = await readFile(
      join(scratch, ".routecraft", "settings.yaml"),
      "utf8",
    );
    expect(settings).toContain(`token: ${await envValue("CRAFT_API_KEY")}`);
    expect(settings).toContain("url: http://127.0.0.1:9090");
  });

  /**
   * @case The key a person must supply is named rather than invented
   * @preconditions A fresh directory
   * @expectedResult LLM_API_KEY is present and empty, and the output says it
   *   is still needed, so the gap is visible in the file rather than only at
   *   the boot that fails on it
   */
  test("leaves the model key for a person to fill in", async () => {
    const output = await run();

    expect(await envValue("LLM_API_KEY")).toBe("");
    expect(output).toContain("LLM_API_KEY");
  });

  /**
   * @case A second run replaces nothing
   * @preconditions Setup has already run once
   * @expectedResult The same key in .env and in the settings file. A rerun
   *   that minted a fresh key would invalidate every mailed approval link and
   *   the settings file in one step, silently.
   */
  test("never replaces a secret that already exists", async () => {
    await run();
    const first = await envValue("CRAFT_API_KEY");

    const output = await run();

    expect(await envValue("CRAFT_API_KEY")).toBe(first);
    expect(output).toContain("Kept");
    const settings = await readFile(
      join(scratch, ".routecraft", "settings.yaml"),
      "utf8",
    );
    expect(settings).toContain(`token: ${first}`);
  });

  /**
   * @case An existing .env is added to, not rewritten
   * @preconditions A .env already carrying the model key
   * @expectedResult That value survives and the generated secrets join it,
   *   because setup is also the command someone runs after pulling a change
   *   that added a variable
   */
  test("keeps values a person already wrote", async () => {
    await writeFile(join(scratch, ".env"), "LLM_API_KEY=sk-mine\n");

    await run();

    expect(await envValue("LLM_API_KEY")).toBe("sk-mine");
    expect((await envValue("CRAFT_API_KEY")).length).toBeGreaterThanOrEqual(32);
    expect(existsSync(join(scratch, ".routecraft", "settings.yaml"))).toBe(
      true,
    );
  });
});
