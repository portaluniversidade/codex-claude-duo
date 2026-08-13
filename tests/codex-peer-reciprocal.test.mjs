import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

const repoRoot = realpathSync.native(path.resolve(import.meta.dirname, ".."));
const serverPath = path.join(repoRoot, "claude-plugins", "codex-peer", "scripts", "codex-peer-mcp.mjs");

function startServer(environmentOverrides = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot, ...environmentOverrides },
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

async function initializedServer(environmentOverrides = {}) {
  const server = startServer(environmentOverrides);
  const initialized = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "reciprocal-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "codex-peer");
  assert.match(initialized.result.instructions, /pins all calls/);
  assert.match(initialized.result.instructions, /unlimited follow-ups by default/i);
  assert.match(initialized.result.instructions, /never expire for idleness/i);
  assert.match(initialized.result.instructions, /codex_operation/i);
  assert.match(initialized.result.instructions, /codex_capabilities/i);
  server.notify("notifications/initialized");
  return server;
}

async function pollCodexOperation(server, queued, timeoutMs = null) {
  assert.equal(queued.status, "queued");
  assert.match(queued.operationHandle, /^[0-9a-f-]{36}$/i);
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  while (deadline === null || Date.now() < deadline) {
    const response = await server.request("tools/call", {
      name: "codex_operation",
      arguments: { operationHandle: queued.operationHandle },
    });
    const operation = response.result.structuredContent;
    if (["completed", "error", "cancelled"].includes(operation.status)) return { response, operation };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Codex operation ${queued.operationHandle} did not complete within the test waiter window.`);
}

function compileFakeCodex(t) {
  if (process.platform !== "win32") {
    t.skip("The deterministic fake Codex executable currently uses the Windows .NET compiler.");
    return null;
  }
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "codex-peer-fake-codex-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const windowsRoot = process.env.WINDIR || "C:\\Windows";
  const compilerCandidates = [
    path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windowsRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = compilerCandidates.find((candidate) => existsSync(candidate));
  assert.ok(compiler, "A .NET Framework C# compiler is required for the Windows fake-Codex regression test.");
  const sourcePath = path.join(fixtureRoot, "FakeCodex.cs");
  const binaryPath = path.join(fixtureRoot, "codex.exe");
  const inferenceMarker = path.join(fixtureRoot, "inference-started.txt");
  writeFileSync(sourcePath, String.raw`
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class FakeCodex
{
    static string Field(string json, string key)
    {
        Match match = Regex.Match(json, @"""" + key + @"""\s*:\s*""([^""]*)""");
        return match.Success ? match.Groups[1].Value : null;
    }

    static int Main(string[] args)
    {
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("codex-cli 0.147.0"); return 0; }
        if (args.Length >= 2 && args[0] == "login" && args[1] == "status") { Console.WriteLine("Logged in using ChatGPT"); return 0; }
        if (args.Length >= 1 && args[0] == "sandbox") { Console.WriteLine("CODEX_PEER_SANDBOX_OK"); return 0; }
        if (args.Length < 1 || args[0] != "mcp-server") return 2;

        StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string method = Field(line, "method");
            Match idMatch = Regex.Match(line, @"""id""\s*:\s*(""[^""]*""|[0-9]+)");
            string id = idMatch.Success ? idMatch.Groups[1].Value : "null";
            if (method == "initialize")
            {
                Thread.Sleep(2000);
                output.WriteLine("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"serverInfo\":{\"name\":\"fake-codex\",\"version\":\"0.147.0\"}}}");
            }
            else if (method == "tools/list")
                output.WriteLine("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{\"tools\":[{\"name\":\"codex\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"codex-reply\",\"inputSchema\":{\"type\":\"object\"}}]}}");
            else if (method == "tools/call")
            {
                File.WriteAllText(@"${inferenceMarker}", "started");
                Thread.Sleep(30000);
                output.WriteLine("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"structuredContent\":{\"threadId\":\"fake-thread-0001\",\"content\":\"ok\"}}}");
            }
        }
        return 0;
    }
}
`, "utf8");
  const compiled = spawnSync(compiler, ["-nologo", "-optimize", `-out:${binaryPath}`, sourcePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
  assert.ok(existsSync(binaryPath));
  return { binaryPath, inferenceMarker };
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
      "codex_capabilities",
      "codex_operation",
      "codex_operation_cancel",
      "codex_sessions",
      "codex_session_close",
    ]);
    for (const tool of tools) {
      assert.equal(Object.hasOwn(tool.inputSchema.properties, "cwd"), false, `${tool.name} must not expose cwd`);
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /danger-full-access/);
    }
    const unlimited = tools.find((tool) => tool.name === "codex_full_unlimited");
    assert.equal(unlimited.inputSchema.properties.confirmation.const, "USER_EXPLICITLY_REQUESTED_UNLIMITED");
    for (const name of ["codex_plan", "codex_full"]) {
      const maxFollowUps = tools.find((tool) => tool.name === name).inputSchema.properties.maxFollowUps;
      assert.equal(maxFollowUps.minimum, 0, name);
      assert.equal(maxFollowUps.maximum, undefined, name);
      assert.match(maxFollowUps.description, /omit it for unlimited/i, name);
    }
    const reply = tools.find((tool) => tool.name === "codex_reply");
    assert.deepEqual(reply.inputSchema.required, ["sessionHandle", "expectedReplyNumber", "prompt"]);
    assert.ok(tools.find((tool) => tool.name === "codex_plan").inputSchema.properties.effort.enum.includes("minimal"));

    const capabilities = await server.request("tools/call", {
      name: "codex_capabilities",
      arguments: { product: "codex", query: "/btw", limit: 10 },
    });
    assert.equal(capabilities.result.isError, undefined, JSON.stringify(capabilities));
    assert.ok(capabilities.result.structuredContent.totalMatches >= 1);
    assert.ok(capabilities.result.structuredContent.entries.some(
      (entry) => entry.name === "/btw" || entry.aliases?.includes("/btw")
    ));
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
    assert.equal(status.collaborationPolicy.defaultReplyLimit, null);
    assert.equal(status.collaborationPolicy.defaultMode, "unlimited");
    assert.equal(status.collaborationPolicy.bridgeWallClockTimeout, null);
    assert.equal(status.collaborationPolicy.idleDisconnectPolicy, "never");
    assert.equal(status.recursionPrevention.pluginsDisabled, false);
    assert.equal(status.recursionPrevention.appsDisabled, false);
    assert.equal(status.recursionPrevention.hooksDisabled, false);
    assert.equal(status.recursionPrevention.configuredMcpServersCleared, false);
    assert.equal(status.recursionPrevention.normalConfigurationNotDisabledByBridge, true);
    assert.equal(status.recursionPrevention.developerInstructionApplied, true);
    assert.equal(status.recursionPrevention.shellLaunchProhibitedByInstructionOnly, true);
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
  const launchBuilder = source.slice(source.indexOf("async start()"), source.indexOf("onLine(line)"));
  for (const disabledOption of ["--disable", "mcp_servers={}", "shell_environment_policy.inherit=\"core\""]) {
    assert.doesNotMatch(launchBuilder, new RegExp(disabledOption.replace(/[{}]/g, "\\$&")), disabledOption);
  }
  assert.doesNotMatch(launchBuilder, /sandbox_workspace_write\.network_access=false/);
  assert.doesNotMatch(source, /sandbox_workspace_write\.network_access=false/);
  assert.match(source, /networkAccessPolicy: "operator_configuration"/);
});

test("idle Codex sessions persist across bridge restarts until explicitly closed", async (t) => {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-peer-state-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 24);
  const statePath = path.join(stateRoot, `codex-peer-sessions-${key}.json`);
  const sessionHandle = "33333333-3333-4333-8333-333333333333";
  writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    workspace: repoRoot,
    updatedAt: new Date().toISOString(),
    sessions: [{
      handle: sessionHandle,
      kind: "review",
      mode: "unlimited",
      threadId: "44444444-4444-4444-8444-444444444444",
      model: null,
      effort: "low",
      replyLimit: null,
      replies: 0,
      inFlight: false,
      createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
      lastActivityAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
    }],
  }, null, 2), "utf8");

  const first = await initializedServer({ CODEX_PEER_STATE_DIR: stateRoot });
  const listed = await first.request("tools/call", { name: "codex_sessions", arguments: {} });
  assert.equal(listed.result.structuredContent.count, 1);
  assert.equal(listed.result.structuredContent.sessions[0].sessionHandle, sessionHandle);
  assert.equal(listed.result.structuredContent.sessions[0].idleExpiresAt, null);
  assert.equal(listed.result.structuredContent.sessions[0].idleDisconnectPolicy, "never");
  const closed = await first.request("tools/call", {
    name: "codex_session_close",
    arguments: { sessionHandle },
  });
  assert.equal(closed.result.structuredContent.status, "closed");
  await first.close();

  const second = await initializedServer({ CODEX_PEER_STATE_DIR: stateRoot });
  t.after(() => second.close());
  const afterRestart = await second.request("tools/call", { name: "codex_sessions", arguments: {} });
  assert.equal(afterRestart.result.structuredContent.count, 0);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(persisted.sessions, []);
});

test("cancelled write-capable codex_full starts disclose possible partial changes", async (t) => {
  const fakeCodex = compileFakeCodex(t);
  if (!fakeCodex) return;
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-peer-cancel-state-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const server = await initializedServer({
    CODEX_PEER_CODEX_BIN: fakeCodex.binaryPath,
    CODEX_PEER_STATE_DIR: stateRoot,
  });
  try {
    const cancelledDuringStartup = await server.request("tools/call", {
      name: "codex_full",
      arguments: { prompt: "Begin a write-capable fake operation and wait." },
    });
    const startupQueued = cancelledDuringStartup.result.structuredContent;
    for (;;) {
      const inspected = await server.request("tools/call", {
        name: "codex_operation",
        arguments: { operationHandle: startupQueued.operationHandle },
      });
      if (inspected.result.structuredContent.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await server.request("tools/call", {
      name: "codex_operation_cancel",
      arguments: { operationHandle: startupQueued.operationHandle },
    });
    const { operation: startupCancellation } = await pollCodexOperation(server, startupQueued);
    assert.equal(startupCancellation.status, "cancelled");
    assert.equal(startupCancellation.error.failureKind, "cancelled");
    assert.equal(startupCancellation.error.workspaceMayContainPartialChanges, undefined);
    assert.equal(existsSync(fakeCodex.inferenceMarker), false);

    const accepted = await server.request("tools/call", {
      name: "codex_full",
      arguments: { prompt: "Begin another write-capable fake operation and wait." },
    });
    const queued = accepted.result.structuredContent;
    while (!existsSync(fakeCodex.inferenceMarker)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const cancellation = await server.request("tools/call", {
      name: "codex_operation_cancel",
      arguments: { operationHandle: queued.operationHandle },
    });
    assert.match(cancellation.result.structuredContent.content, /explicitly requested/i);
    const { operation } = await pollCodexOperation(server, queued);
    assert.equal(operation.status, "cancelled");
    assert.equal(operation.error.failureKind, "cancelled");
    assert.equal(operation.error.workspaceMayContainPartialChanges, true);
    assert.equal(operation.error.automaticRollbackPerformed, false);
    assert.equal(operation.error.inspectionRequired, true);
    assert.match(operation.error.content, /may already have changed files or produced command side effects/i);
    assert.match(operation.error.content, /inspect the workspace diff/i);
  } finally {
    await server.close();
  }
});

test("authenticated reciprocal read-only smoke", { skip: process.env.CODEX_PEER_LIVE_SMOKE !== "1" }, async () => {
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
    const queued = response.result.structuredContent;
    const { response: completedResponse, operation } = await pollCodexOperation(server, queued);
    const result = operation.result;
    assert.equal(completedResponse.result.isError, undefined, JSON.stringify(operation));
    assert.match(result.content, /RECIPROCAL_CODEX_OK/);
    assert.match(result.sessionHandle, /^[0-9a-f-]{36}$/i);
    assert.equal(result.nextReplyNumber, 1);
    assert.equal(result.sandbox, "read-only");
    assert.equal(result.replyLimit, null);
    assert.equal(result.sessionMode, "unlimited");
  } finally {
    await server.close();
  }
});
