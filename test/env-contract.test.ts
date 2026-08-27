import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * `.env.schema` and `env.ts` describe the same contract for two different
 * readers: a person setting the project up, and the compiler. Nothing links
 * them, so they drift the moment someone adds a variable to one and forgets
 * the other, and the way that drift surfaces is a deployment failing on a
 * variable nobody documented.
 */
describe("environment contract", () => {
  const read = (path: string): Promise<string> =>
    readFile(new URL(path, import.meta.url), "utf8");

  /** Variable names declared in `.env.schema`, in file order. */
  const declared = async (): Promise<string[]> => {
    const source = await read("../.env.schema");
    return Array.from(
      source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm),
      (match) => match[1]!,
    );
  };

  /** Variable names the zod schema in `env.ts` parses. */
  const parsed = async (): Promise<string[]> => {
    const source = await read("../env.ts");
    const schema = source.slice(source.indexOf("const envSchema"));
    return Array.from(
      schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm),
      (match) => match[1]!,
    );
  };

  /**
   * @case Every documented variable is one the project actually parses
   * @preconditions .env.schema and env.ts read from disk
   * @expectedResult No extras, so the file cannot promise a variable that
   *   does nothing
   */
  test("every declared variable is parsed", async () => {
    const inEnv = new Set(await parsed());
    expect((await declared()).filter((name) => !inEnv.has(name))).toEqual([]);
  });

  /**
   * @case Every parsed variable is documented
   * @preconditions .env.schema and env.ts read from disk
   * @expectedResult No extras, so a variable added to env.ts cannot ship
   *   undocumented
   */
  test("every parsed variable is declared", async () => {
    const inSchema = new Set(await declared());
    expect((await parsed()).filter((name) => !inSchema.has(name))).toEqual([]);
  });

  /**
   * @case The schema file carries no values
   * @preconditions .env.schema read from disk
   * @expectedResult Only variables with defaults have a right-hand side, and
   *   nothing marked @sensitive does, so the committed file can never carry a
   *   secret
   */
  test("no sensitive variable has a value", async () => {
    const source = await read("../.env.schema");
    const withValues = Array.from(
      source.matchAll(/@sensitive[\s\S]*?^([A-Z][A-Z0-9_]*)=(.*)$/gm),
      (match) => [match[1]!, match[2]!] as const,
    ).filter(([, value]) => value.trim() !== "");
    expect(withValues).toEqual([]);
  });
});
