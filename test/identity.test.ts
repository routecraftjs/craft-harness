import { describe, expect, test } from "bun:test";
import { craftConfig } from "../craft.config.js";
import manifest from "../package.json";

/**
 * The project's name, on the three surfaces a person reads it.
 *
 * A project scaffolded from this template renames itself in `package.json`
 * and nowhere else. Every identity the instance presents has to follow from
 * there, and none of it is covered by any other test in this suite: the
 * config object was built from string literals, so a scaffold called
 * `my-agent` logged `craft-harness`, offered `Craft Harness` in an editor's
 * agent picker and listed `craft-harness` as its MCP server. All three read
 * as somebody else's project, and all three were silent about it.
 *
 * These assertions are deliberately against the manifest rather than against
 * a literal: hardcoding `craft-harness` here would pass for this repository
 * and prove nothing about a scaffold, which is the case that broke.
 */
describe("the project's identity", () => {
  /**
   * @case The context name follows the manifest
   * @preconditions craftConfig built from this project's package.json
   * @expectedResult `name` equals the manifest name, which is what rides on `service.name` on every log line
   */
  test("the context is named from package.json", () => {
    expect(craftConfig.name).toBe(manifest.name);
  });

  /**
   * @case The editor's agent entry follows the manifest
   * @preconditions acp.agentInfo present on the config
   * @expectedResult name and version come from the manifest. The title is what an editor's agent picker shows, so it is the project's name read by a person rather than its id
   */
  test("the ACP agent is named from package.json", () => {
    const agentInfo = craftConfig.acp?.agentInfo;
    expect(agentInfo?.name).toBe(manifest.name);
    expect(agentInfo?.version).toBe(manifest.version);
    expect(agentInfo?.title).not.toContain("craft-harness");
  });

  /**
   * @case The MCP server entry follows the manifest
   * @preconditions mcp config present
   * @expectedResult name and version come from the manifest, so an assistant lists the project rather than the template it came from
   */
  test("the MCP server is named from package.json", () => {
    expect(craftConfig.mcp?.name).toBe(manifest.name);
    expect(craftConfig.mcp?.version).toBe(manifest.version);
  });

  /**
   * @case A hyphenated project name reads as words where a person sees it
   * @preconditions The title is derived rather than written
   * @expectedResult This repository's own name renders as "Craft Harness", which is the transform a scaffold called `acme-ops-agent` needs to produce "Acme Ops Agent"
   */
  test("the title is the name a person would write", () => {
    expect(craftConfig.acp?.agentInfo?.title).toBe("Craft Harness");
  });
});
