import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const codexSidePath = path.join(repoRoot, "plugins", "claude-peer", "assets", "control-catalog.json");
const claudeSidePath = path.join(repoRoot, "claude-plugins", "codex-peer", "assets", "control-catalog.json");

const screenshotCommands = `
/add-dir /advisor /agents /artifact-capabilities /artifact-design /artifact-diagramming /artifacts /autocompact
/autofix-pr /background /batch /branch /btw /bug /cd /chrome /claude-api /claude-in-chrome /clear
/code-review /color /compact /config /context /copy /dataviz /debug /deep-research /design /design-login
/design-sync /desktop /diff /doctor /effort /exit /export /fast /feedback /fewer-permission-prompts /focus
/fork /goal /help /hooks /ide /import /init /insights /install-github-app /install-slack-app /keybindings
/login /logout /loop /mcp /memory /mobile /model /permissions /plan /plugin /powerup /privacy-settings
/radio /recap /release-notes /reload-plugins /reload-skills /remote-control /remote-env /rename /resume /rewind
/run /run-skill-generator /schedule /scroll-speed /security-review /simplify /skills /status /statusline /stickers
/subtask /tasks /team-onboarding /teleport /terminal-setup /theme /tui /ultrareview /update-config /upgrade
/usage /usage-credits /verify /voice /web-setup /workflows
`.trim().split(/\s+/);

async function catalogs() {
  const [codexSide, claudeSide] = await Promise.all([
    readFile(codexSidePath, "utf8"),
    readFile(claudeSidePath, "utf8"),
  ]);
  return { codexSide, claudeSide, catalog: JSON.parse(codexSide) };
}

test("both peers ship one byte-identical versioned control catalog", async () => {
  const { codexSide, claudeSide, catalog } = await catalogs();
  assert.equal(claudeSide, codexSide);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.coverage.totalEntries, catalog.entries.length);
  assert.equal(catalog.coverage.totalEntries, 815);
  for (const hash of Object.values(catalog.sourceSnapshots)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.match(catalog.completeness.claim, /not a timeless promise/i);
});

test("catalog independently covers every supplied Claude screenshot command and live command", async () => {
  const { catalog } = await catalogs();
  const names = new Set(
    catalog.entries
      .filter((entry) => entry.product === "claude")
      .flatMap((entry) => [entry.name, ...(entry.aliases || [])])
  );
  assert.equal(screenshotCommands.length, 100);
  assert.deepEqual(screenshotCommands.filter((name) => !names.has(name)), []);
  assert.equal(catalog.coverage.claudeScreenshotCommandsExpected, 100);
  assert.equal(catalog.coverage.claudeScreenshotCommandsCaptured, 100);
  const liveCommands = catalog.runtimeObservations.claudeHeadlessSlashCommands.map((name) => `/${name}`);
  assert.equal(liveCommands.length, 46);
  assert.deepEqual(liveCommands.filter((name) => !names.has(name)), []);
  assert.equal(catalog.coverage.claudeHeadlessCommandsCaptured, 46);
});

test("every routed control has a recognized access class and source", async () => {
  const { catalog } = await catalogs();
  const unique = new Set();
  for (const entry of catalog.entries) {
    assert.ok(catalog.accessLegend[entry.access], `${entry.product}/${entry.surface}/${entry.name}: ${entry.access}`);
    assert.ok(entry.route);
    assert.ok(entry.source);
    const key = `${entry.product}\0${entry.surface}\0${entry.name}`;
    assert.ok(!unique.has(key), `duplicate control key: ${key}`);
    unique.add(key);
  }
  assert.equal(catalog.coverage.countsByProductAndSurface["claude.agent-tool"], 33);
  assert.equal(catalog.coverage.countsByProductAndSurface["claude.agent-skill"], 19);
  assert.equal(catalog.coverage.countsByProductAndSurface["claude.bridge-tool"], 13);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.bridge-tool"], 12);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.interactive-command"], 50);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.official-mcp-tool"], 2);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.security-cli-command"], 14);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.security-cli-option"], 31);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.cli-interactive-shortcut"], 9);
  assert.equal(catalog.coverage.countsByProductAndSurface["codex.ide-command"], 6);
  assert.ok(catalog.coverage.countsByProductAndSurface["codex.cli-subcommand-option"] >= 100);
  assert.ok(catalog.coverage.countsByProductAndSurface["codex.hardware-control"] >= 27);
  assert.ok(catalog.sources.includes("https://code.claude.com/docs/en/interactive-mode.md"));
  assert.ok(catalog.sources.includes("https://code.claude.com/docs/en/overview"));
  assert.ok(catalog.sources.includes("https://developers.openai.com/codex/codex-manual.md"));
});

test("catalog normalizes malformed rows, aliases, drifted probes, and angle placeholders", async () => {
  const { catalog } = await catalogs();
  const find = (product, surface, name) => catalog.entries.find(
    (entry) => entry.product === product && entry.surface === surface && entry.name === name
  );

  assert.ok(find("codex", "ide-command", "chatgpt.newChat"));
  assert.ok(find("codex", "desktop-deep-link", "codex://threads/<session>"));
  assert.ok(find("codex", "security-cli-command", "codex-security scan"));
  assert.ok(find("codex", "hardware-control", "Agent Key single press"));
  assert.ok(find("codex", "hardware-control", "Command Key: Approve request"));
  assert.ok(find("codex", "hardware-control", "Analog stick Up"));
  assert.ok(find("codex", "hardware-control", "Dial mode: Reasoning only"));

  assert.deepEqual(find("claude", "interactive-command", "/background").aliases, ["/bg"]);
  assert.ok(!find("claude", "interactive-command", "/background").aliases.includes("/fork"));
  assert.ok(!find("claude", "interactive-command", "/rewind").aliases.includes("/or"));
  assert.ok(!find("claude", "interactive-command", "/clear").aliases.includes("/resume"));
  assert.ok(!find("claude", "interactive-command", "/code-review").aliases.includes("/simplify"));
  assert.equal(find("claude", "interactive-command", "/design-sync").access, "conditional-external");

  assert.ok(catalog.runtimeObservations.claudeHeadlessTools.includes("Task"));
  assert.ok(catalog.runtimeObservations.claudeHeadlessTools.includes("Agent"));
  assert.ok(catalog.runtimeObservations.claudeHeadlessSkills.includes("keybindings-help"));
  assert.ok(catalog.runtimeObservations.claudeHeadlessSkills.includes("deep-research"));
  assert.equal(find("claude", "cli-command", "claude").access, "host-cli-only");
  for (const option of ["--safe-mode", "--setting-sources", "--strict-mcp-config", "--no-chrome"]) {
    assert.equal(find("claude", "cli-option", option).access, "host-launch-only", option);
  }
  for (const option of ["--config", "--disable"]) {
    assert.equal(find("codex", "cli-option", option).access, "host-launch-only", option);
  }
  assert.equal(find("codex", "cli-command", "codex exec").access, "host-cli-only");
  assert.equal(find("codex", "cli-command", "codex login").access, "bridge-runtime");
  assert.equal(find("codex", "cli-command", "codex mcp-server").access, "bridge-runtime");
  assert.equal(find("codex", "cli-command", "codex sandbox").access, "bridge-runtime");

  const ctrlT = find("claude", "keyboard-shortcut", "Ctrl+T").purpose;
  const ctrlE = find("claude", "keyboard-shortcut", "Ctrl+E").purpose;
  const vimP = find("claude", "vim-command", "p").purpose;
  const vimJ = find("claude", "vim-command", "J").purpose;
  const vimO = find("claude", "vim-command", "o").purpose;
  assert.match(ctrlT, /task checklist/i);
  assert.match(ctrlT, /syntax highlighting/i);
  assert.match(ctrlE, /cursor to end/i);
  assert.match(ctrlE, /show all content/i);
  assert.match(vimP, /paste after cursor/i);
  assert.match(vimP, /replace selection/i);
  assert.match(vimJ, /join lines/i);
  assert.match(vimJ, /join selected lines/i);
  assert.match(vimO, /open line below/i);
  assert.match(vimO, /swap cursor and anchor/i);
});

test("Claude installer byte-verifies the complete selected plugin cache", async () => {
  const setup = await readFile(path.join(repoRoot, "setup.ps1"), "utf8");
  assert.match(setup, /selected\.installPath/);
  assert.match(setup, /selected\.version -eq \$expectedVersion/);
  assert.match(setup, /Test-PluginCacheMatches -SourceRoot \$pluginSource -CacheRoot \$expectedCacheRoot -AllowAdditionalCacheFiles/);
  assert.match(setup, /including assets\/control-catalog\.json/);
});
