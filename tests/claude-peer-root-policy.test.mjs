import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const pluginRoot = process.env.CLAUDE_PEER_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PEER_PLUGIN_ROOT)
  : fileURLToPath(new URL("../plugins/claude-peer", import.meta.url));
const serverPath = path.join(pluginRoot, "scripts", "claude-peer-mcp.mjs");
const bundleRoot = fileURLToPath(new URL("..", import.meta.url));

// A deliberately absent binary path. resolveClaudeBinary() is fail-closed for an explicit override,
// so reaching it proves the cwd root check passed while guaranteeing that no Claude inference,
// authentication probe, or subscription usage happens in these tests.
const MISSING_CLAUDE_BINARY = path.join(tmpdir(), "claude-peer-tests", "no-such-claude.exe");
const OVERRIDE_REJECTED = /CLAUDE_PEER_CLAUDE_BIN was set/i;
const ROOT_REJECTED = /outside the operator-configured Claude workspace roots/i;

function startServer(environmentOverrides = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: bundleRoot,
    env: {
      ...process.env,
      CLAUDE_PEER_CLAUDE_BIN: MISSING_CLAUDE_BINARY,
      // Every test pins its own policy inputs so the machine's real configuration cannot leak in.
      CLAUDE_PEER_ALLOWED_ROOTS: "",
      CLAUDE_PEER_ALLOW_ALL_ROOTS: "",
      CLAUDE_PEER_CONFIG: "",
      ...environmentOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const waiters = new Map();
  const responses = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    } else {
      responses.set(message.id, message);
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params = {}, timeoutMs = 30_000) {
    send({ jsonrpc: "2.0", id, method, params });
    if (responses.has(id)) {
      const message = responses.get(id);
      responses.delete(id);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`));
      }, timeoutMs);
      waiters.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  }

  async function close() {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await once(child, "exit");
    assert.equal(child.exitCode, 0, stderr);
  }

  return { close, request, send };
}

async function readySession(environmentOverrides) {
  const server = startServer(environmentOverrides);
  await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "root-policy-test", version: "1" },
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return server;
}

let nextOperationRequestId = 20_000;
async function terminalOperation(server, queued, timeoutMs = 30_000) {
  assert.equal(queued.status, "queued");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await server.request(nextOperationRequestId++, "tools/call", {
      name: "claude_operation",
      arguments: { operationHandle: queued.operationHandle },
    });
    const result = response.result.structuredContent;
    if (["completed", "error", "cancelled"].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Operation ${queued.operationHandle} did not reach terminal state.`);
}

function temporaryTree(t) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-peer-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside-any-allowlist");
  mkdirSync(outside);
  const configPath = path.join(root, "claude-peer-config.json");
  const writeConfig = (document) => writeFileSync(configPath, JSON.stringify(document, null, 2), "utf8");
  return { root, outside, configPath, writeConfig };
}

async function planIn(server, id, cwd) {
  const response = await server.request(id, "tools/call", {
    name: "claude_plan",
    arguments: { prompt: "root policy probe; no inference is expected to start", cwd },
  });
  return terminalOperation(server, response.result.structuredContent);
}

test("restricted mode still refuses a directory outside the configured roots", async (t) => {
  const tree = temporaryTree(t);
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => server.close());

  const result = await planIn(server, 2, tree.outside);
  assert.equal(result.status, "error");
  assert.match(result.content, ROOT_REJECTED);
  assert.doesNotMatch(result.content, OVERRIDE_REJECTED);
});

test("persistent allowAllRoots config accepts any existing directory", async (t) => {
  const tree = temporaryTree(t);
  tree.writeConfig({ allowAllRoots: true, allowedRoots: [] });
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => server.close());

  // Reaching the fail-closed binary override proves the root check no longer rejected this cwd.
  const outside = await planIn(server, 2, tree.outside);
  assert.equal(outside.status, "error");
  assert.match(outside.content, OVERRIDE_REJECTED);

  const driveRoot = await planIn(server, 3, path.parse(process.cwd()).root);
  assert.equal(driveRoot.status, "error");
  assert.match(driveRoot.content, OVERRIDE_REJECTED);
});

test("CLAUDE_PEER_ALLOW_ALL_ROOTS overrides the config file in both directions", async (t) => {
  const tree = temporaryTree(t);
  tree.writeConfig({ allowAllRoots: false, allowedRoots: [] });
  const enabled = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath, CLAUDE_PEER_ALLOW_ALL_ROOTS: "1" });
  t.after(() => enabled.close());
  const enabledResult = await planIn(enabled, 2, tree.outside);
  assert.equal(enabledResult.status, "error");
  assert.match(enabledResult.content, OVERRIDE_REJECTED);

  tree.writeConfig({ allowAllRoots: true, allowedRoots: [] });
  const disabled = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath, CLAUDE_PEER_ALLOW_ALL_ROOTS: "0" });
  t.after(() => disabled.close());
  const disabledResult = await planIn(disabled, 2, tree.outside);
  assert.equal(disabledResult.status, "error");
  assert.match(disabledResult.content, ROOT_REJECTED);
});

test("a wildcard entry in CLAUDE_PEER_ALLOWED_ROOTS removes the restriction", async (t) => {
  const tree = temporaryTree(t);
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath, CLAUDE_PEER_ALLOWED_ROOTS: "*" });
  t.after(() => server.close());

  const result = await planIn(server, 2, tree.outside);
  assert.equal(result.status, "error");
  assert.match(result.content, OVERRIDE_REJECTED);
});

test("claude_full without cwd and claude_implement also honor the persistent policy", async (t) => {
  const tree = temporaryTree(t);
  tree.writeConfig({ allowAllRoots: true });
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => server.close());

  const explicitCwd = await server.request(2, "tools/call", {
    name: "claude_full",
    arguments: { prompt: "root policy probe; no inference is expected to start", cwd: tree.outside },
  });
  const explicitCwdResult = await terminalOperation(server, explicitCwd.result.structuredContent);
  assert.match(explicitCwdResult.content, OVERRIDE_REJECTED);

  const implement = await server.request(3, "tools/call", {
    name: "claude_implement",
    arguments: { prompt: "root policy probe; no inference is expected to start", cwd: tree.outside },
  });
  const implementResult = await terminalOperation(server, implement.result.structuredContent);
  // claude_implement keeps its own worktree authorization gate after the root check is satisfied.
  assert.match(
    implementResult.content,
    /CLAUDE_PEER_CLAUDE_BIN was set|linked Git worktree|write authorization/i
  );
});

test("claude_status reports the effective root policy and its unaffected safeguards", async (t) => {
  const tree = temporaryTree(t);
  tree.writeConfig({ allowAllRoots: true, allowedRoots: [] });
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => server.close());

  const response = await server.request(2, "tools/call", { name: "claude_status", arguments: {} });
  const status = response.result.structuredContent;
  assert.deepEqual(status.runtimeConfiguration, {
    safeMode: false,
    settingSources: "normal/user-project-local",
    strictMcpConfig: false,
    chromeIntegration: "operator-configured",
    pluginsAndMcpNotDisabledByBridge: true,
    normalConfigurationLaunchPolicy: true,
  });
  assert.equal(status.rootPolicy.allowAllRoots, true);
  assert.equal(status.rootPolicy.mode, "all-roots");
  assert.equal(status.rootPolicy.configPath, tree.configPath);
  assert.equal(status.rootPolicy.configPresent, true);
  assert.equal(status.rootPolicy.error, null);
  assert.equal(status.allowedRootsConfigured, true);
  assert.ok(status.rootPolicy.unaffectedSafeguards.some((item) => /Max OAuth/i.test(item)));
  assert.ok(status.rootPolicy.unaffectedSafeguards.some((item) => /redaction.*not plugin\/MCP\/hook containment/i.test(item)));
});

test("restricted status keeps reporting the allowlist and refuses drive roots", async (t) => {
  const tree = temporaryTree(t);
  tree.writeConfig({ allowAllRoots: false, allowedRoots: [bundleRoot] });
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => server.close());

  const response = await server.request(2, "tools/call", { name: "claude_status", arguments: {} });
  const status = response.result.structuredContent;
  assert.equal(status.rootPolicy.allowAllRoots, false);
  assert.equal(status.rootPolicy.mode, "restricted");
  assert.ok(status.allowedRoots.length > 0);

  const driveRootServer = await readySession({
    CLAUDE_PEER_CONFIG: tree.configPath,
    CLAUDE_PEER_ALLOWED_ROOTS: path.parse(process.cwd()).root,
  });
  t.after(() => driveRootServer.close());
  const refused = await planIn(driveRootServer, 2, bundleRoot);
  assert.equal(refused.status, "error");
  assert.match(refused.content, /Drive roots and the entire user profile are refused/i);
});

test("a malformed policy file fails loud instead of silently changing the policy", async (t) => {
  const tree = temporaryTree(t);
  writeFileSync(tree.configPath, "{ not json", "utf8");
  const server = await readySession({ CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => server.close());

  const result = await planIn(server, 2, bundleRoot);
  assert.equal(result.status, "error");
  assert.match(result.content, /root policy file is not valid JSON/i);

  const response = await server.request(3, "tools/call", { name: "claude_status", arguments: {} });
  const status = response.result.structuredContent;
  assert.equal(status.rootPolicy.mode, "misconfigured");
  assert.equal(status.allowedRootsConfigured, false);
  assert.match(status.rootPolicy.error, /not valid JSON/i);
});

test("idle Claude sessions persist across bridge restarts until explicitly closed", async (t) => {
  const tree = temporaryTree(t);
  const stateRoot = path.join(tree.root, "state");
  mkdirSync(stateRoot);
  const sessionHandle = "11111111-1111-4111-8111-111111111111";
  const sessionStatePath = path.join(stateRoot, "claude-peer-sessions.json");
  writeFileSync(sessionStatePath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sessions: [{
      handle: sessionHandle,
      kind: "review",
      claudeSessionId: "22222222-2222-4222-8222-222222222222",
      cwd: bundleRoot,
      mode: "unlimited",
      model: "fable",
      effort: "max",
      fallbackModels: ["opus", "sonnet"],
      replyLimit: null,
      replies: 0,
      inFlight: false,
      createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
      lastActivityAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
    }],
  }, null, 2), "utf8");

  const first = await readySession({ CLAUDE_PEER_STATE_DIR: stateRoot, CLAUDE_PEER_CONFIG: tree.configPath });
  const listed = await first.request(2, "tools/call", { name: "claude_sessions", arguments: {} });
  assert.equal(listed.result.structuredContent.count, 1);
  assert.equal(listed.result.structuredContent.sessions[0].sessionHandle, sessionHandle);
  assert.equal(listed.result.structuredContent.sessions[0].idleExpiresAt, null);
  assert.equal(listed.result.structuredContent.sessions[0].idleDisconnectPolicy, "never");

  const closed = await first.request(3, "tools/call", {
    name: "claude_session_close",
    arguments: { sessionHandle },
  });
  assert.equal(closed.result.structuredContent.status, "closed");
  await first.close();

  const second = await readySession({ CLAUDE_PEER_STATE_DIR: stateRoot, CLAUDE_PEER_CONFIG: tree.configPath });
  t.after(() => second.close());
  const afterRestart = await second.request(2, "tools/call", { name: "claude_sessions", arguments: {} });
  assert.equal(afterRestart.result.structuredContent.count, 0);
  const persisted = JSON.parse(readFileSync(sessionStatePath, "utf8"));
  assert.deepEqual(persisted.sessions, []);
});
