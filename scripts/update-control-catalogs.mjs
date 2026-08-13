#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

const generatedAt = option("--generated-at") || new Date().toISOString();
const suppliedManual = option("--codex-manual");
const defaultManual = path.join(tmpdir(), "openai-docs-cache", "codex-manual.md");

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" } });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

const claudeCommandsUrl = "https://code.claude.com/docs/en/commands.md";
const claudeCliUrl = "https://code.claude.com/docs/en/cli-usage.md";
const claudeInteractiveUrl = "https://code.claude.com/docs/en/interactive-mode.md";
const codexManualUrl = "https://developers.openai.com/codex/codex-manual.md";

const claudeScreenshotCommands = `
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

const claudeHeadlessSlashCommands = [
  "deep-research", "design-sync", "dataviz", "update-config", "verify", "debug", "code-review",
  "simplify", "batch", "fewer-permission-prompts", "doctor", "loop", "schedule", "claude-api",
  "run", "run-skill-generator", "agents", "autocompact", "clear", "color", "compact", "config",
  "context", "effort", "fast", "heapdump", "init", "mcp", "import", "model", "__remote-workflow",
  "workflow-launch-exec", "reload-skills", "rename", "ultrareview", "security-review", "usage-credits",
  "extra-usage", "usage", "insights", "recap", "goal", "design", "design-consent", "design-revoke",
  "team-onboarding",
];

const claudeOriginalHeadlessSkills = [
  "deep-research", "design-sync", "dataviz", "update-config", "verify", "debug", "code-review",
  "simplify", "batch", "fewer-permission-prompts", "doctor", "loop", "schedule", "claude-api",
  "run", "run-skill-generator",
];

const claudeCurrentHeadlessSkills = [
  ...claudeOriginalHeadlessSkills.filter((name) =>
    !new Set(["deep-research", "design-sync", "verify", "debug", "batch", "doctor", "run-skill-generator"]).has(name)
  ),
  "keybindings-help", "init", "security-review",
];
const claudeHeadlessSkills = [...new Set([...claudeOriginalHeadlessSkills, ...claudeCurrentHeadlessSkills])];

const [claudeCommands, claudeCli, claudeInteractive, codexManual] = await Promise.all([
  fetchText(claudeCommandsUrl),
  fetchText(claudeCliUrl),
  fetchText(claudeInteractiveUrl),
  suppliedManual
    ? Promise.resolve(readFileSync(path.resolve(suppliedManual), "utf8"))
    : (() => {
        try {
          return Promise.resolve(readFileSync(defaultManual, "utf8"));
        } catch {
          return fetchText(codexManualUrl);
        }
      })(),
]);

function headingLevel(line) {
  const match = line.match(/^(#{1,6})\s+/);
  return match ? match[1].length : null;
}

function section(markdown, heading, fromIndex = 0) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line, index) => index >= fromIndex && line.trim() === heading);
  if (start === -1) throw new Error(`Heading not found: ${heading}`);
  const level = headingLevel(lines[start]);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const candidate = headingLevel(lines[index]);
    if (candidate !== null && candidate <= level) {
      end = index;
      break;
    }
  }
  return { text: lines.slice(start, end).join("\n"), start, end };
}

function sectionUntilLevel(markdown, heading, stopLevel) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`Heading not found: ${heading}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const candidate = headingLevel(lines[index]);
    if (candidate !== null && candidate <= stopLevel) {
      end = index;
      break;
    }
  }
  return { text: lines.slice(start, end).join("\n"), start, end };
}

function splitTableRow(line) {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "|" && body[index - 1] !== "\\") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/\\\|/g, "|"));
}

function firstTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line, index) =>
    /^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|\s*:?-{3,}/.test(lines[index + 1])
  );
  if (start === -1) throw new Error("Markdown table not found in section");
  const headers = splitTableRow(lines[start]);
  const rows = [];
  for (let index = start + 2; index < lines.length && /^\s*\|/.test(lines[index]); index += 1) {
    const cells = splitTableRow(lines[index]);
    if (cells.length < headers.length) continue;
    rows.push(Object.fromEntries(headers.map((header, cellIndex) => [plain(header), cells[cellIndex]])));
  }
  return rows;
}

function allTables(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tables = [];
  const headingStack = [];
  let lastCommandHeading = null;
  for (let index = 0; index < lines.length; index += 1) {
    const level = headingLevel(lines[index]);
    if (level !== null) {
      while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
      const text = plain(lines[index].replace(/^#{1,6}\s+/, ""));
      headingStack.push({ level, text });
      if (/^codex(?:\s|$)/i.test(text)) lastCommandHeading = text;
    }
    if (!/^\s*\|/.test(lines[index]) || index + 1 >= lines.length || !/^\s*\|\s*:?-{3,}/.test(lines[index + 1])) {
      continue;
    }
    const headers = splitTableRow(lines[index]).map(plain);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && /^\s*\|/.test(lines[cursor])) {
      const cells = splitTableRow(lines[cursor]);
      if (cells.length >= headers.length) {
        rows.push(Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]])));
      }
      cursor += 1;
    }
    tables.push({
      headers,
      rows,
      heading: headingStack.at(-1)?.text || null,
      headingPath: headingStack.map((entry) => entry.text),
      lastCommandHeading,
    });
    index = cursor - 1;
  }
  return tables;
}

function plain(value) {
  return String(value || "")
    .replace(/<\/?(?:Note|Tip|Warning|Info|Steps?|Tabs?|Tab|CodeGroup|Frame|Accordion|AccordionGroup|Card|CardGroup|Columns?|ParamField|ResponseField|Expandable|Details|Summary|br|kbd)(?:\s+[^<>]*?)?\s*\/?>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[_*]/g, "")
    .replace(/\\([|<>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shortPurpose(value) {
  const text = plain(value);
  if (text.length <= 320) return text;
  const sentence = text.slice(0, 320).match(/^(.{80,}?\.)\s/);
  return sentence ? sentence[1] : `${text.slice(0, 317).trim()}...`;
}

function slashNames(syntax) {
  return [...new Set(String(syntax).match(/\/[A-Za-z0-9_-]+/g) || [])];
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function claudeCommandAccess(names, kind) {
  const primary = names[0]?.slice(1) || "";
  if (primary === "model") return ["bridge-equivalent", "Set model on claude_plan or claude_full; the bridge pins it for continuations."];
  if (primary === "effort") return ["bridge-equivalent", "Set effort on claude_plan or claude_full; the bridge pins it for continuations."];
  if (primary === "plan") return ["bridge-equivalent", "Use claude_plan for the read-only peer phase."];
  if (primary === "status") return ["bridge-equivalent", "Use claude_status for peer installation, auth, model, root, and policy status."];
  if (["compact", "context", "clear", "branch", "fork", "resume", "rewind", "btw"].includes(primary)) {
    return ["bridge-equivalent", "Use a new or continued opaque peer session; the interactive transcript UI itself remains local to Claude Code."];
  }
  if (["autofix-pr", "batch", "bug", "feedback", "design-login", "design-sync", "install-github-app", "install-slack-app", "schedule", "team-onboarding", "ultrareview", "usage-credits", "web-setup"].includes(primary)) {
    return ["conditional-external", "Requires the top-level user's exact authorization and an eligible interactive/account surface; the peer bridge does not silently perform it."];
  }
  if (kind !== "built-in" || ["init", "security-review", "review", "code-review"].includes(primary)) {
    return ["peer-agent", "Ask claude_full to perform the workflow with its native agent tools; raw TUI preprocessing is not assumed."];
  }
  if (["diff", "doctor", "run", "verify", "simplify", "skills", "tasks", "agents", "subtask"].includes(primary)) {
    return ["peer-agent", "Ask claude_full for the same outcome; Claude uses its built-in tools rather than another terminal's UI."];
  }
  return ["interactive-host-only", "Run this in the visible Claude Code terminal. The peer can explain it but cannot claim to operate another terminal's local UI."];
}

function codexCommandAccess(names) {
  const primary = names[0]?.slice(1) || "";
  if (primary === "model") return ["bridge-equivalent", "Set model on codex_plan or codex_full."];
  if (primary === "plan") return ["bridge-equivalent", "Use codex_plan for a read-only Codex peer."];
  if (primary === "permissions") return ["bridge-equivalent", "Choose codex_plan (read-only) or codex_full (workspace-write); approval policy remains never."];
  if (primary === "status") return ["bridge-equivalent", "Use codex_status for binary, authentication, workspace, MCP, and sandbox readiness."];
  if (["new", "clear", "fork", "resume", "side", "btw"].includes(primary)) {
    return ["bridge-equivalent", "Start or continue an opaque Codex peer session; the Codex TUI transcript controls remain local to the host."];
  }
  if (["diff", "init", "mention", "review", "goal", "compact", "skills"].includes(primary)) {
    return ["peer-agent", "Ask Codex for the equivalent outcome inside the bound peer phase; do not send the raw TUI command as if it were an MCP method."];
  }
  if (["apply", "feedback", "import", "logout", "plugins", "apps", "hooks", "delete", "archive", "experimental", "usage"].includes(primary)) {
    return ["conditional-host", "This changes host configuration, account/session state, or external state. It is not exposed by the reciprocal peer without an exact authorized host workflow."];
  }
  return ["interactive-host-only", "Run this in the visible Codex TUI. Claude can explain or request the semantic outcome, but cannot press Codex's local UI."];
}

const entries = [];
function add(entry) {
  entries.push({
    product: entry.product,
    surface: entry.surface,
    name: entry.name,
    ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
    ...(entry.syntax ? { syntax: entry.syntax } : {}),
    purpose: entry.purpose,
    access: entry.access,
    route: entry.route,
    source: entry.source,
  });
}

const claudeCommandRows = firstTable(section(claudeCommands, "## All commands").text);
for (const row of claudeCommandRows) {
  const syntax = plain(row.Command);
  const names = slashNames(syntax);
  if (!names.length) continue;
  const rawPurpose = row.Purpose || "";
  const aliasClause = plain(rawPurpose).match(/\bAlias(?:es)?:\s*((?:\/[A-Za-z0-9_-]+)(?:\s*(?:,|or|and)\s*\/[A-Za-z0-9_-]+)*)/i)?.[1] || "";
  const documentedAliases = slashNames(aliasClause);
  const aliases = [...new Set([...names.slice(1), ...documentedAliases.filter((name) => name !== names[0])])];
  const normalizedPurpose = plain(rawPurpose);
  const kind = /^Skill\b/i.test(normalizedPurpose) ? "skill" : /^Workflow\b/i.test(normalizedPurpose) ? "workflow" : "built-in";
  const [access, route] = claudeCommandAccess(names, kind);
  add({
    product: "claude",
    surface: "interactive-command",
    name: names[0],
    aliases,
    syntax,
    purpose: `${kind}: ${shortPurpose(rawPurpose)}`,
    access,
    route,
    source: claudeCommandsUrl,
  });
}

const observedClaudeExtras = [
  ["/artifact-capabilities", "Observed in the user's Claude Code 2.1.231 command menu."],
  ["/artifact-design", "Observed in the user's Claude Code 2.1.231 command menu."],
  ["/artifact-diagramming", "Observed in the user's Claude Code 2.1.231 command menu."],
  ["/artifacts", "Observed in the user's Claude Code 2.1.231 command menu."],
  ["/claude-in-chrome", "Observed in the user's Claude Code 2.1.231 command menu."],
  ["/design", "Observed in the user's Claude Code 2.1.231 command menu."],
  ["/update-config", "Observed bundled skill in the user's Claude Code 2.1.231 command menu."],
  ["/mcp__claude_ai_Cloudflare_Developer_Platform__workers-prompt-full", "Observed dynamic MCP prompt; availability depends on that MCP server being connected."],
];
for (const [name, purpose] of observedClaudeExtras) {
  add({
    product: "claude",
    surface: "observed-command",
    name,
    purpose,
    access: name.startsWith("/mcp__") ? "conditional-host" : "interactive-host-only",
    route: "Discover it dynamically in the originating Claude Code window; it is not guaranteed by the base CLI on every account or project.",
    source: "user screenshots captured 2026-08-13",
  });
}

const documentedClaudeCommands = new Set(
  entries
    .filter((entry) => entry.product === "claude" && ["interactive-command", "observed-command"].includes(entry.surface))
    .flatMap((entry) => [entry.name, ...(entry.aliases || [])])
);
for (const command of claudeHeadlessSlashCommands.map((name) => `/${name}`)) {
  if (documentedClaudeCommands.has(command)) continue;
  add({
    product: "claude",
    surface: "observed-command",
    name: command,
    purpose: "Command identifier reported by the live Claude Code 2.1.231 headless initialization metadata but absent from the cited public command table.",
    access: "conditional-host",
    route: "Treat as dynamic or internal. Use only when the originating Claude runtime advertises it; do not assume it is a stable MCP method.",
    source: "live Claude Code 2.1.231 init probe on 2026-08-13",
  });
}

for (const name of claudeHeadlessSkills) {
  add({
    product: "claude",
    surface: "agent-skill",
    name,
    purpose: "Bundled skill reported by at least one Claude Code 2.1.231 headless initialization probe; the active set is runtime-dependent.",
    access: "peer-agent",
    route: "Ask claude_full for the workflow outcome; Claude may select the Skill tool when the runtime advertises this skill.",
    source: "live Claude Code 2.1.231 init probe on 2026-08-13",
  });
}

const claudeOriginalAgentTools = [
  "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit", "EnterWorktree",
  "ExitWorktree", "Glob", "Grep", "Monitor", "NotebookEdit", "PowerShell", "PushNotification", "Read",
  "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill", "TaskCreate", "TaskGet",
  "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch", "WebFetch", "WebSearch", "Workflow", "Write",
];
const claudeCurrentAgentTools = claudeOriginalAgentTools.map((name) => name === "Task" ? "Agent" : name);
const claudeAgentTools = [...new Set([...claudeOriginalAgentTools, ...claudeCurrentAgentTools])];
for (const name of claudeAgentTools) {
  add({
    product: "claude",
    surface: "agent-tool",
    name,
    purpose: "Built-in tool reported by at least one Claude Code 2.1.231 headless initialization probe; availability is checked per invocation.",
    access: "peer-agent",
    route: "Available for Claude to select inside claude_full when compatible with the current permission mode and task authorization.",
    source: "live Claude Code 2.1.231 init probe on 2026-08-13",
  });
}

const claudeCliCommands = firstTable(section(claudeCli, "## CLI commands").text);
for (const row of claudeCliCommands) {
  const syntax = plain(row.Command);
  const bridgeRuntime = /^claude\s+-p(?:\s|$)/.test(syntax);
  add({
    product: "claude",
    surface: "cli-command",
    name: syntax,
    syntax,
    purpose: shortPurpose(row.Description),
    access: bridgeRuntime ? "bridge-runtime" : "host-cli-only",
    route: bridgeRuntime
      ? "The Claude peer bridge owns the native headless process and exposes policy-bound MCP tools instead of a raw command shell."
      : "Run from a trusted local terminal with explicit authorization; the bridge does not expose a generic Claude CLI shell.",
    source: claudeCliUrl,
  });
}

const claudeCliFlags = firstTable(section(claudeCli, "## CLI flags").text);
const mappedClaudeFlags = new Set([
  "--allowedTools", "--append-system-prompt", "--disallowedTools", "--effort", "--fallback-model",
  "--max-turns", "--model", "--no-chrome", "--output-format", "--permission-mode", "--resume", "--safe-mode", "--setting-sources",
  "--strict-mcp-config", "--tools",
]);
for (const row of claudeCliFlags) {
  const syntax = plain(row.Flag || row.Option || Object.values(row)[0]);
  const flagNames = syntax.match(/--[A-Za-z0-9-]+/g) || [];
  const mapped = flagNames.some((name) => mappedClaudeFlags.has(name));
  add({
    product: "claude",
    surface: "cli-option",
    name: flagNames[0] || syntax,
    aliases: flagNames.slice(1),
    syntax,
    purpose: shortPurpose(row.Description || row.Behavior || Object.values(row)[1]),
    access: mapped ? "bridge-runtime" : "host-launch-only",
    route: mapped
      ? "The Claude bridge uses this exact option internally; callers use the policy-bound MCP schema rather than passing raw argv."
      : "This is a native Claude launch option and is not accepted as arbitrary peer input.",
    source: claudeCliUrl,
  });
}

for (const table of allTables(claudeInteractive)) {
  for (const row of table.rows) {
    const shortcut = plain(row.Shortcut || row.Command || row.Key || row.Method || "");
    const method = plain(row.Method || "");
    const purpose = shortPurpose(row.Description || row.Action || row.Notes || row.Context || "");
    if (!shortcut || !purpose) continue;
    const vim = table.headingPath.some((heading) => /Vim editor mode/i.test(heading)) ||
      /NORMAL mode|Visual mode|Mode switching/i.test(table.heading || "");
    add({
      product: "claude",
      surface: vim ? "vim-command" : "keyboard-shortcut",
      name: shortcut,
      syntax: method && method !== shortcut ? `${method}: ${shortcut}` : shortcut,
      purpose: `${table.heading || "Interactive control"}: ${purpose}`,
      access: "interactive-host-only",
      route: "Use in the visible Claude Code terminal; keyboard/editor input is not an MCP model tool.",
      source: claudeInteractiveUrl,
    });
  }
}

const screenshotShortcuts = [
  ["!", "shell mode"], ["/", "commands"], ["@", "file paths"], ["/btw", "side question"],
  ["Esc Esc", "clear input"], ["Shift+Tab", "auto-accept edits"], ["Ctrl+O", "verbose output"],
  ["Ctrl+T", "toggle tasks"], ["Shift+Enter", "newline"], ["Ctrl+Shift+_", "undo"],
  ["Alt+V", "paste images"], ["Alt+P", "switch model"], ["Ctrl+S", "stash prompt"],
  ["Ctrl+G", "edit in external editor"], ["/keybindings", "customize keybindings"],
];
for (const [name, purpose] of screenshotShortcuts) {
  add({
    product: "claude",
    surface: "observed-shortcut",
    name,
    purpose: `Claude terminal shortcut: ${purpose}.`,
    access: "interactive-host-only",
    route: "Use in the visible Claude Code terminal; keyboard input is not an MCP model tool.",
    source: "user screenshot of Claude Code 2.1.231 help",
  });
}

const codexCliReference = section(codexManual, "### CLI command reference").text;
const codexGlobalFlags = firstTable(section(codexCliReference, "#### Global flags").text);
const runtimeCodexFlags = new Set(["--config", "-c", "--disable"]);
const equivalentCodexFlags = new Set(["--ask-for-approval", "-a", "--cd", "-C", "--model", "-m", "--sandbox", "-s"]);
for (const row of codexGlobalFlags) {
  const syntax = plain(row.Key);
  const flagNames = syntax.match(/--[A-Za-z0-9-]+/g) || [];
  const shortFlags = syntax.match(/(?:^|[\s,])-[A-Za-z](?=$|[\s,])/g)?.map((name) => name.trim()) || [];
  const names = [...flagNames, ...shortFlags];
  const runtime = names.some((name) => runtimeCodexFlags.has(name));
  const equivalent = names.some((name) => equivalentCodexFlags.has(name));
  add({
    product: "codex",
    surface: "cli-option",
    name: flagNames[0] || syntax,
    aliases: flagNames.slice(1),
    syntax,
    purpose: shortPurpose(row.Details),
    access: runtime ? "bridge-runtime" : equivalent ? "bridge-equivalent" : "host-launch-only",
    route: runtime
      ? "The reciprocal bridge uses this exact option internally while starting the official Codex MCP server."
      : equivalent
        ? "Use the corresponding reciprocal tool field or fixed policy; arbitrary raw CLI flags are not accepted."
      : "Use in a trusted local Codex terminal; the peer does not expose a generic Codex CLI shell.",
    source: codexManualUrl,
  });
}

const codexCliCommands = firstTable(section(codexCliReference, "#### Command overview").text);
for (const row of codexCliCommands) {
  const syntax = plain(row.Key);
  if (!syntax) throw new Error("Codex CLI command table contained a row without a Key value.");
  const details = plain(row.Details);
  const aliasClause = details.match(/\bAlias(?:es)?:\s*([^.]*)/i)?.[1] || "";
  const aliases = aliasClause
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((value) => value.trim())
    .filter((value) => /^codex(?:\s|$)/.test(value));
  const runtime = ["codex login", "codex mcp-server", "codex sandbox"].includes(syntax);
  add({
    product: "codex",
    surface: "cli-command",
    name: syntax,
    aliases,
    syntax,
    purpose: shortPurpose(details),
    access: runtime ? "bridge-runtime" : "host-cli-only",
    route: runtime
      ? syntax === "codex mcp-server"
        ? "The reciprocal bridge starts this exact official MCP server and exposes narrower peer tools instead of raw CLI execution."
        : "The reciprocal integration uses this exact command for an authentication or sandbox-readiness check; callers cannot supply arbitrary subcommands."
      : "Run from a trusted local terminal with exact authorization; the bridge does not expose arbitrary Codex subcommands.",
    source: codexManualUrl,
  });
}

const seenCodexSubcommandOptions = new Set();
for (const table of allTables(codexCliReference)) {
  if (!table.headers.includes("Key") || !/^codex(?:\s|$)/i.test(table.lastCommandHeading || "")) continue;
  const command = plain(table.lastCommandHeading).replace(/\s+\(interactive\)$/i, "");
  for (const row of table.rows) {
    const syntax = plain(row.Key);
    if (!syntax) continue;
    const identity = `${command} ${syntax}`;
    if (seenCodexSubcommandOptions.has(identity)) continue;
    seenCodexSubcommandOptions.add(identity);
    add({
      product: "codex",
      surface: "cli-subcommand-option",
      name: identity,
      syntax,
      purpose: shortPurpose(row.Details || row.Description || Object.values(row)[3] || "Documented Codex subcommand option."),
      access: "host-launch-only",
      route: "Use on this exact native Codex subcommand from a trusted local terminal; the reciprocal bridge does not expose arbitrary argv.",
      source: codexManualUrl,
    });
  }
}

const codexSecurityReference = section(codexManual, "### Codex Security CLI reference").text;
const seenSecurityCommands = new Set();
const seenSecurityOptions = new Set();
for (const table of allTables(codexSecurityReference)) {
  if (table.headers.includes("Command") && table.headers.includes("Purpose")) {
    for (const row of table.rows) {
      const command = plain(row.Command);
      if (!/^codex-security(?:\s|$)/.test(command) || seenSecurityCommands.has(command)) continue;
      seenSecurityCommands.add(command);
      add({
        product: "codex",
        surface: "security-cli-command",
        name: command,
        syntax: command,
        purpose: shortPurpose(row.Purpose),
        access: "host-cli-only",
        route: "Run through the separately installed Codex Security CLI with exact authorization and access; it is not a reciprocal-peer MCP method.",
        source: codexManualUrl,
      });
    }
  }
  const optionHeader = table.headers.find((header) => /^(?:Argument|Option|Flag|Key)$/.test(header));
  if (!optionHeader) continue;
  for (const row of table.rows) {
    const syntax = plain(row[optionHeader]);
    if (!/--[A-Za-z0-9-]+/.test(syntax)) continue;
    const context = table.heading || "codex-security";
    const identity = `${context} ${syntax}`;
    if (seenSecurityOptions.has(identity)) continue;
    seenSecurityOptions.add(identity);
    add({
      product: "codex",
      surface: "security-cli-option",
      name: identity,
      syntax,
      purpose: shortPurpose(row.Purpose || row.Details || row.Description || Object.values(row)[1]),
      access: "host-launch-only",
      route: "Use with the documented Codex Security command in a trusted local terminal; the reciprocal bridge does not accept this raw option.",
      source: codexManualUrl,
    });
  }
}

const codexInteractiveShortcutSection = section(codexCliReference, "#### Interactive shortcuts").text;
const codexInteractiveShortcutBullets = codexInteractiveShortcutSection
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*-\s+(.+)/)?.[1])
  .filter(Boolean);
for (const bullet of codexInteractiveShortcutBullets) {
  const normalized = plain(bullet);
  const name = normalized.match(/^Type ([^ ]+)/i)?.[1] ||
    normalized.match(/^Press (.+?)(?: to | while | with )/i)?.[1] ||
    normalized.match(/^Prefix a line with ([^ ]+)/i)?.[1] ||
    normalized.split(/\s+/).slice(0, 5).join(" ");
  add({
    product: "codex",
    surface: "cli-interactive-shortcut",
    name,
    syntax: normalized,
    purpose: normalized,
    access: "interactive-host-only",
    route: "Use in the visible Codex CLI; terminal input and key handling are not reciprocal MCP tools.",
    source: codexManualUrl,
  });
}

const codexSlashRows = firstTable(section(codexManual, "#### Built-in slash commands").text);
for (const row of codexSlashRows) {
  const syntax = plain(row.Command);
  const names = slashNames(syntax);
  if (!names.length) continue;
  const [access, route] = codexCommandAccess(names);
  add({
    product: "codex",
    surface: "interactive-command",
    name: names[0],
    aliases: names.slice(1),
    syntax,
    purpose: shortPurpose(row.Purpose),
    access,
    route,
    source: codexManualUrl,
  });
}

const codexDesktopShortcuts = firstTable(section(codexManual, "#### Keyboard shortcuts").text);
for (const row of codexDesktopShortcuts) {
  const action = plain(row.Action);
  const shortcut = plain(row.Shortcut);
  if (!action || !shortcut) continue;
  add({
    product: "codex",
    surface: "desktop-shortcut",
    name: shortcut,
    purpose: action,
    access: "interactive-host-only",
    route: "Use in the visible Codex desktop app; keyboard input is not an MCP model method.",
    source: codexManualUrl,
  });
}

const codexDeepLinkReference = sectionUntilLevel(codexManual, "#### Deep links", 3).text;
const seenDeepLinks = new Set();
for (const table of allTables(codexDeepLinkReference)) {
  for (const row of table.rows) {
    if (table.headers.includes("Query parameter")) {
      const parameter = plain(row["Query parameter"]);
      if (parameter) {
        add({
          product: "codex",
          surface: "desktop-deep-link-parameter",
          name: parameter,
          syntax: parameter,
          purpose: shortPurpose(row["What it does"] || row.Description || "Documented deep-link query parameter."),
          access: "host-link",
          route: "Encode this parameter into a documented codex:// link; opening a link prepares desktop UI state and does not silently send a turn.",
          source: codexManualUrl,
        });
      }
    }
    const rawCells = Object.values(row).map(plain);
    for (const cell of rawCells) {
      for (let link of cell.match(/codex:\/\/[^\s,|)]+/g) || []) {
        const purpose = shortPurpose(row.Opens || row.Action || row.Description || row["What it does"] || "Documented Codex desktop deep link.");
        if (link === "codex://threads/" && /technical thread ID|local chat/i.test(purpose)) link = "codex://threads/<session>";
        if (seenDeepLinks.has(link)) continue;
        seenDeepLinks.add(link);
        add({
          product: "codex",
          surface: "desktop-deep-link",
          name: link,
          purpose,
          access: "host-link",
          route: "Open explicitly in the Codex desktop app; links prepare UI state and do not silently send a model turn.",
          source: codexManualUrl,
        });
      }
    }
  }
}

const codexIdeCommands = firstTable(section(codexManual, "#### Extension commands").text);
for (const row of codexIdeCommands) {
  const name = plain(row.Command);
  if (!name) continue;
  add({
    product: "codex",
    surface: "ide-command",
    name,
    purpose: shortPurpose(row.Description),
    access: "interactive-host-only",
    route: "Invoke from the editor's Command Palette; the reciprocal MCP does not control the editor UI.",
    source: codexManualUrl,
  });
}
if (!codexIdeCommands.some((row) => plain(row.Command) === "chatgpt.newChat")) {
  add({
    product: "codex",
    surface: "ide-command",
    name: "chatgpt.newChat",
    syntax: "macOS: Cmd+N; Windows/Linux: Ctrl+N",
    purpose: "Create a new chat. The upstream Markdown row wraps the platform-specific key binding across two physical lines, so it is normalized explicitly.",
    access: "interactive-host-only",
    route: "Invoke from the editor's Command Palette or its platform shortcut; the reciprocal MCP does not control the editor UI.",
    source: codexManualUrl,
  });
}

const codexIdeSettings = firstTable(section(codexManual, "#### Editor settings reference").text);
for (const row of codexIdeSettings) {
  const name = plain(row.Setting);
  if (!name) continue;
  add({
    product: "codex",
    surface: "ide-setting",
    name,
    syntax: plain(row.Default),
    purpose: shortPurpose(row.Description),
    access: "conditional-host",
    route: "Configure in the originating editor settings UI; the reciprocal bridge does not mutate editor configuration implicitly.",
    source: codexManualUrl,
  });
}

const ideSlashSectionStart = codexManual.indexOf("### Codex IDE extension slash commands");
const ideSlashSection = section(codexManual.slice(ideSlashSectionStart), "#### Available slash commands").text;
const codexIdeSlash = firstTable(ideSlashSection);
for (const row of codexIdeSlash) {
  const syntax = plain(row["Slash command"]);
  const names = slashNames(syntax);
  if (!names.length) continue;
  add({
    product: "codex",
    surface: "ide-slash-command",
    name: names[0],
    aliases: names.slice(1),
    syntax,
    purpose: shortPurpose(row.Description),
    access: "interactive-host-only",
    route: "Invoke in the Codex IDE composer; Claude may request an equivalent peer outcome but cannot operate the editor UI.",
    source: codexManualUrl,
  });
}

const codexMicroHardwareControls = [
  ["Agent Key single press", "Switch to the assigned chat without bringing ChatGPT forward by default."],
  ["Agent Key double press", "Switch to the assigned chat and bring the ChatGPT window forward when pressed twice within 350 milliseconds."],
  ["Unassigned Agent Key press", "Open a new chat, which is assigned to that key when started."],
  ["Agent Keys: Most recent chats", "Follow the six most recently updated chats."],
  ["Agent Keys: Pinned chats", "Follow the first six pinned chats."],
  ["Agent Keys: Priority chats", "Prioritize chats waiting for input, unread chats, and active chats."],
  ["Agent Keys: Custom assignments", "Assign a chat, shortcut, physical key action, or enabled skill to each Agent Key."],
  ["Microphone key hold", "Use push-to-talk while held, then stop recording on release."],
  ["Microphone key double press", "Keep recording hands-free after two presses within 350 milliseconds."],
  ["Microphone key press", "Stop an active hands-free recording."],
  ["Command Key: Toggle Fast mode", "Turn Fast mode on or off."],
  ["Command Key: Approve request", "Approve the current request."],
  ["Command Key: Decline request", "Decline the current request."],
  ["Command Key: Continue in new chat", "Continue the current chat in a new chat."],
  ["Command Key: Push-to-talk", "Start push-to-talk."],
  ["Command Key: Send composer message", "Send the message in the composer."],
  ["Dial turn", "Move through composer controls/options in the default Composer navigation mode."],
  ["Dial press", "Open or select the focused control; in conversation scrolling it jumps to the latest message."],
  ["Dial long press", "Open device settings except when Custom assignments maps a long-press action."],
];
for (const [name, purpose] of codexMicroHardwareControls) {
  add({
    product: "codex",
    surface: "hardware-control",
    name,
    purpose,
    access: "interactive-host-only",
    route: "Use on configured Codex Micro hardware through the ChatGPT desktop app; physical input is not an MCP method.",
    source: codexManualUrl,
  });
}

for (const table of allTables(sectionUntilLevel(codexManual, "#### Use and customize Command Keys", 4).text)) {
  for (const row of table.rows) {
    const action = plain(row["Default action"]);
    if (!action) continue;
    add({
      product: "codex",
      surface: "hardware-control",
      name: `Command Key: ${action}`,
      purpose: action,
      access: "interactive-host-only",
      route: "Use or remap the physical Command Key in Codex Micro device settings; it is not an MCP method.",
      source: codexManualUrl,
    });
  }
}

for (const table of allTables(sectionUntilLevel(codexManual, "#### Use the analog stick and dial", 4).text)) {
  for (const row of table.rows) {
    const direction = plain(row.Direction);
    const mode = plain(row.Mode);
    const name = direction ? `Analog stick ${direction}` : mode ? `Dial mode: ${mode}` : null;
    if (!name) continue;
    add({
      product: "codex",
      surface: "hardware-control",
      name,
      purpose: shortPurpose(row["Default action"] || row.Behavior),
      access: "interactive-host-only",
      route: "Use or remap this physical Codex Micro control in device settings; it is not an MCP method.",
      source: codexManualUrl,
    });
  }
}

const bridgeTools = {
  claude: [
    "claude_plan", "claude_plan_unlimited", "claude_reply", "claude_implement", "claude_full",
    "claude_full_unlimited", "claude_full_reply", "claude_status", "claude_capabilities",
    "claude_operation", "claude_operation_cancel", "claude_sessions", "claude_session_close",
  ],
  codex: [
    "codex_plan", "codex_plan_unlimited", "codex_reply", "codex_full", "codex_full_unlimited",
    "codex_full_reply", "codex_status", "codex_capabilities", "codex_operation", "codex_operation_cancel",
    "codex_sessions", "codex_session_close",
  ],
};
for (const [product, names] of Object.entries(bridgeTools)) {
  for (const name of names) {
    add({
      product,
      surface: "bridge-tool",
      name,
      purpose: `Policy-bound ${product === "claude" ? "Codex-to-Claude" : "Claude-to-Codex"} reciprocal MCP tool.`,
      access: "peer-direct",
      route: `Call ${name} through the installed reciprocal plugin and honor its current input schema.`,
      source: "codex-claude-duo plugin",
    });
  }
}

for (const name of ["codex", "codex-reply"]) {
  add({
    product: "codex",
    surface: "official-mcp-tool",
    name,
    purpose: "Tool exposed by the official `codex mcp-server` process.",
    access: "bridge-runtime",
    route: "The codex-peer policy proxy wraps this tool; Claude should call the policy tool rather than bypassing it.",
    source: "https://github.com/openai/codex/blob/main/codex-rs/docs/codex_mcp_interface.md",
  });
}

const deduplicatedEntries = new Map();
for (const entry of entries) {
  const key = `${entry.product}\0${entry.surface}\0${entry.name}`;
  const existing = deduplicatedEntries.get(key);
  if (!existing) {
    deduplicatedEntries.set(key, entry);
    continue;
  }
  const aliases = [...new Set([...(existing.aliases || []), ...(entry.aliases || [])])]
    .filter((alias) => alias !== entry.name);
  if (aliases.length) existing.aliases = aliases;
  const existingPurpose = existing.purpose || "";
  const incomingPurpose = entry.purpose || "";
  if (incomingPurpose && incomingPurpose !== existingPurpose) {
    existing.purpose = [existingPurpose, incomingPurpose].filter(Boolean).join(" Also documented in another context: ");
  }
}
entries.length = 0;
entries.push(...deduplicatedEntries.values());

entries.sort((left, right) =>
  left.product.localeCompare(right.product) || left.surface.localeCompare(right.surface) || left.name.localeCompare(right.name)
);

const knownClaudeCommands = new Set(
  entries
    .filter((entry) => entry.product === "claude")
    .flatMap((entry) => [entry.name, ...(entry.aliases || [])])
);
const missingScreenshotCommands = claudeScreenshotCommands.filter((name) => !knownClaudeCommands.has(name));
const missingHeadlessCommands = claudeHeadlessSlashCommands
  .map((name) => `/${name}`)
  .filter((name) => !knownClaudeCommands.has(name));
if (missingScreenshotCommands.length || missingHeadlessCommands.length) {
  throw new Error(
    `Control coverage failed. Missing screenshot commands: ${missingScreenshotCommands.join(", ") || "none"}. ` +
    `Missing headless commands: ${missingHeadlessCommands.join(", ") || "none"}.`
  );
}
if (seenSecurityCommands.size !== 14) {
  throw new Error(`Expected 14 documented Codex Security commands, captured ${seenSecurityCommands.size}.`);
}
if (seenSecurityOptions.size !== 31) {
  throw new Error(`Expected 31 documented Codex Security options, captured ${seenSecurityOptions.size}.`);
}
if (codexInteractiveShortcutBullets.length !== 9) {
  throw new Error(`Expected 9 documented Codex CLI interactive shortcuts, captured ${codexInteractiveShortcutBullets.length}.`);
}
if (!entries.some((entry) => entry.product === "codex" && entry.surface === "ide-command" && entry.name === "chatgpt.newChat")) {
  throw new Error("The normalized chatgpt.newChat IDE command is missing.");
}
if (!entries.some((entry) => entry.product === "codex" && entry.surface === "cli-subcommand-option")) {
  throw new Error("Codex per-subcommand CLI options were not captured.");
}
if (!entries.some((entry) => entry.product === "codex" && entry.surface === "hardware-control")) {
  throw new Error("Codex Micro hardware controls were not captured.");
}

const countsByProductAndSurface = Object.fromEntries(
  [...new Set(entries.map((entry) => `${entry.product}.${entry.surface}`))]
    .sort()
    .map((key) => [key, entries.filter((entry) => `${entry.product}.${entry.surface}` === key).length])
);

const catalog = {
  schemaVersion: 1,
  generatedAt,
  completeness: {
    claim: "Complete for the explicitly enumerated command, flag, shortcut, deep-link, IDE, hardware, security, bridge, and live-probe surfaces in the cited snapshots; not a timeless promise about conditional or future controls.",
    rule: "A command is not called remotely merely because its name is known. Use each entry's access and route fields.",
    dynamicAvailability: "Platform, plan, organization policy, feature flags, installed plugins, MCP servers, and host surface can add, hide, or remove commands.",
    recursionBoundary: "Nested MCP/plugin/app/hook routes are technically disabled in the reciprocal Codex launch. Shell-level peer launch is also prohibited by both peers' developer instructions, but that part is instruction enforcement rather than an operating-system impossibility. Unlimited collaboration is serialized through durable operation handles.",
  },
  sources: [
    claudeCommandsUrl,
    claudeCliUrl,
    claudeInteractiveUrl,
    "https://code.claude.com/docs/en/overview",
    codexManualUrl,
    "user-provided Claude Code 2.1.231 screenshots",
    "live Claude Code 2.1.231 headless initialization probe",
    "installed Codex CLI 0.147.0 and sandbox-capable 0.146.1 probes",
  ],
  sourceSnapshots: {
    claudeCommandsSha256: sha256(claudeCommands),
    claudeCliUsageSha256: sha256(claudeCli),
    claudeInteractiveModeSha256: sha256(claudeInteractive),
    codexManualSha256: sha256(codexManual),
  },
  coverage: {
    totalEntries: entries.length,
    countsByProductAndSurface,
    claudeScreenshotCommandsExpected: claudeScreenshotCommands.length,
    claudeScreenshotCommandsCaptured: claudeScreenshotCommands.length - missingScreenshotCommands.length,
    claudeHeadlessCommandsExpected: claudeHeadlessSlashCommands.length,
    claudeHeadlessCommandsCaptured: claudeHeadlessSlashCommands.length - missingHeadlessCommands.length,
  },
  runtimeObservations: {
    claudeInteractiveVersion: "2.1.231",
    claudeHeadlessToolCount: claudeAgentTools.length,
    claudeHeadlessTools: claudeAgentTools,
    claudeOriginalProbeTools: claudeOriginalAgentTools,
    claudeCurrentProbeTools: claudeCurrentAgentTools,
    claudeHeadlessSlashCommands,
    claudeHeadlessSkills,
    claudeOriginalProbeSkills: claudeOriginalHeadlessSkills,
    claudeCurrentProbeSkills: claudeCurrentHeadlessSkills,
    codexNewestInstalledVersion: "0.147.0",
    codexSelectedSandboxCapableVersion: "0.146.1",
    codexInstallationProbe: {
      observedAt: generatedAt,
      newestInstalled: {
        path: "C:\\Users\\gui07\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
        version: "0.147.0",
      },
      reciprocalBridgeSelected: {
        path: "C:\\Users\\gui07\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex.exe",
        version: "0.146.1",
        reason: "This package path keeps codex-command-runner.exe adjacent to argv[0] for the verified Windows sandbox path; the WinGet Links hard link does not.",
      },
    },
    officialCodexMcpTools: ["codex", "codex-reply"],
  },
  accessLegend: {
    "peer-direct": "Direct reciprocal MCP tool.",
    "peer-agent": "The invoked peer can achieve this with its own agent tools; the host does not press the peer UI.",
    "bridge-equivalent": "The bridge has a semantic control or session field for the outcome.",
    "bridge-controlled": "The bridge fixes or validates this launch option rather than accepting raw argv.",
    "bridge-runtime": "Exact native command, flag, or official MCP tool used internally by the current bridge implementation.",
    "interactive-host-only": "Visible terminal, desktop, or editor UI control; known but not remotely executable as an MCP model tool.",
    "host-cli-only": "Native CLI subcommand intentionally not exposed as a generic peer shell.",
    "host-launch-only": "Native launch flag intentionally not accepted as arbitrary peer input.",
    "host-link": "Explicit desktop deep link.",
    "conditional-host": "Host/config/account state action requiring an exact authorized workflow.",
    "conditional-external": "Potential external mutation or cloud/account workflow requiring exact top-level authorization.",
  },
  entries,
};

const outputs = [
  path.join(repoRoot, "plugins", "claude-peer", "assets", "control-catalog.json"),
  path.join(repoRoot, "claude-plugins", "codex-peer", "assets", "control-catalog.json"),
];
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
for (const output of outputs) {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, serialized, "utf8");
}

console.log(JSON.stringify({ generatedAt, entries: entries.length, outputs }, null, 2));
