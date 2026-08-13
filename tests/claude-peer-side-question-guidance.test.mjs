import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillUrl = new URL("../plugins/claude-peer/skills/claude-peer/SKILL.md", import.meta.url);
const serverUrl = new URL("../plugins/claude-peer/scripts/claude-peer-mcp.mjs", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);

test("plugin guidance preserves Claude work during /btw side questions", async () => {
  const [skill, server, readme] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(serverUrl, "utf8"),
    readFile(readmeUrl, "utf8"),
  ]);

  for (const [name, content] of Object.entries({ skill, server, readme })) {
    assert.match(content, /\/btw/, `${name} must mention Codex's /btw command`);
  }

  assert.match(skill, /without cancelling, replacing, or steering the active Claude work/);
  assert.match(server, /without cancelling or steering the original work/);
  assert.match(readme, /without steering, cancelling, or replacing the active task/);
  assert.match(readme, /explicit request to stop or replace the current task still takes precedence/);
});
