import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import test from "node:test";

const repoRoot = realpathSync.native(path.resolve(import.meta.dirname, ".."));
const serverPath = path.join(repoRoot, "claude-plugins", "codex-peer", "scripts", "codex-peer-mcp.mjs");

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const waiters = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(String(message.id));
      if (waiter) {
        waiters.delete(String(message.id));
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  let nextId = 1;
  const request = (method, params = {}, timeoutMs = 30_000) => {
    const id = String(nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`));
      }, timeoutMs);
      waiters.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const close = async () => {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await once(child, "exit");
  };
  return { child, request, notify, close, stderr: () => stderr };
}

async function initializedServer() {
  const server = startServer();
  const initialized = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "reciprocal-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "codex-peer");
  assert.match(initialized.result.instructions, /pins all calls/);
  server.notify("notifications/initialized");
  return server;
}

test("reciprocal tool surface pins workspace and omits danger-full-access", async () => {
  const server = await initializedServer();
  try {
    const listed = await server.request("tools/list");
    const tools = listed.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "codex_plan",
      "codex_plan_unlimited",
      "codex_reply",
      "codex_full",
      "codex_full_unlimited",
      "codex_full_reply",
      "codex_status",
    ]);
    for (const tool of tools) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties, "cwd"), false, `${tool.name} must not expose cwd`);
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /danger-full-access/);
    }
    const unlimited = tools.find((tool) => tool.name === "codex_full_unlimited");
    assert.equal(unlimited.inputSchema.properties.confirmation.const, "USER_EXPLICITLY_REQUESTED_UNLIMITED");
    const reply = tools.find((tool) => tool.name === "codex_reply");
    assert.deepEqual(reply.inputSchema.required, ["sessionHandle", "expectedReplyNumber", "prompt"]);
  } finally {
    await server.close();
  }
});

test("codex_status verifies the authenticated official MCP server without inference", async () => {
  const server = await initializedServer();
  try {
    const response = await server.request("tools/call", { name: "codex_status", arguments: {} }, 60_000);
    assert.equal(response.result.isError, undefined, JSON.stringify(response));
    const status = response.result.structuredContent;
    assert.equal(status.status, "ready", status.content);
    assert.equal(status.authenticatedWithChatGPT, true);
    assert.equal(status.workspaceWriteSandboxReady, true, status.workspaceWriteSandboxProbe);
    if (process.platform === "win32") {
      assert.match(status.codexBinary, /Microsoft[\\/]WinGet[\\/]Packages[\\/]OpenAI\.Codex_/i);
      assert.doesNotMatch(status.codexBinary, /Microsoft[\\/]WinGet[\\/]Links/i);
    }
    assert.equal(realpathSync.native(status.workspace), repoRoot);
    assert.equal(status.workspaceBinding, "fixed_at_claude_mcp_startup");
    assert.deepEqual(status.recursionPrevention, {
      pluginsDisabled: true,
      appsDisabled: true,
      hooksDisabled: true,
      configuredMcpServersCleared: true,
      developerInstructionApplied: true,
    });
  } finally {
    await server.close();
  }
});

test("Claude plugin metadata and skill describe the enforced reciprocal boundary", async () => {
  const [marketplace, manifest, mcp, skill, source] = await Promise.all([
    readFile(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    readFile(path.join(repoRoot, "claude-plugins", "codex-peer", ".claude-plugin", "plugin.json"), "utf8"),
    readFile(path.join(repoRoot, "claude-plugins", "codex-peer", ".mcp.json"), "utf8"),
    readFile(path.join(repoRoot, "claude-plugins", "codex-peer", "skills", "codex-peer", "SKILL.md"), "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.equal(JSON.parse(marketplace).plugins[0].source, "./claude-plugins/codex-peer");
  assert.equal(JSON.parse(manifest).name, "codex-peer");
  assert.match(JSON.parse(mcp).mcpServers["codex-peer"].args[0], /CLAUDE_PLUGIN_ROOT/);
  assert.match(skill, /USER GOAL/);
  assert.match(skill, /Claude -> Codex -> Claude recursion/);
  assert.match(source, /"--disable", "plugins"/);
  assert.match(source, /"--disable", "apps"/);
  assert.match(source, /"--disable", "hooks"/);
  assert.match(source, /"mcp_servers=\{\}"/);
  assert.match(source, /sandbox_workspace_write\.network_access=false/);
});

test("authenticated reciprocal read-only smoke", { skip: process.env.CODEX_PEER_LIVE_SMOKE !== "1", timeout: 20 * 60 * 1000 }, async () => {
  const server = await initializedServer();
  try {
    const response = await server.request("tools/call", {
      name: "codex_plan",
      arguments: {
        prompt: "Reply with exactly RECIPROCAL_CODEX_OK and do not inspect or change files.",
        effort: "low",
      },
    }, 15 * 60 * 1000);
    assert.equal(response.result.isError, undefined, JSON.stringify(response));
    const result = response.result.structuredContent;
    assert.match(result.content, /RECIPROCAL_CODEX_OK/);
    assert.match(result.sessionHandle, /^[0-9a-f-]{36}$/i);
    assert.equal(result.nextReplyNumber, 1);
    assert.equal(result.sandbox, "read-only");
  } finally {
    await server.close();
  }
});
