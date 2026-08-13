#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const CLIENT_NAME = "codex-claude-duo-apps-supervisor";
const CLIENT_VERSION = "1.0.0";
const READY_POLL_MS = 2_000;
const RPC_TIMEOUT_MS = 20_000;
const SERVER_READY_TIMEOUT_MS = 15_000;
const LOG_TAIL_LIMIT = 24_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const REQUIRED_THREAD_MCP_SERVERS = ["codex_apps", "claude-peer"];

class FriendlyError extends Error {}
class FatalError extends FriendlyError {}

function usage() {
  return [
    "Usage:",
    "  node start-codex-with-apps.mjs --codex CODEX_EXE --cwd DIRECTORY",
    "       [--retry-limit N] [--attempt-timeout-seconds N] -- [CODEX_ARGS...]",
    "",
    "A retry limit of 0 means retry until Apps is ready or the user cancels.",
  ].join("\n");
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new FriendlyError(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new FriendlyError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseWrapperArguments(argv) {
  const delimiter = argv.indexOf("--");
  const own = delimiter === -1 ? argv : argv.slice(0, delimiter);
  const codexArguments = delimiter === -1 ? [] : argv.slice(delimiter + 1);
  const result = {
    codex: null,
    cwd: null,
    retryLimit: 0,
    attemptTimeoutSeconds: 120,
    codexArguments,
  };

  for (let index = 0; index < own.length; index += 1) {
    const option = own[index];
    if (option === "--help" || option === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = own[index + 1];
    if (option === "--codex") {
      result.codex = value;
      index += 1;
    } else if (option === "--cwd") {
      result.cwd = value;
      index += 1;
    } else if (option === "--retry-limit") {
      result.retryLimit = parseInteger(value, option, 0, 1_000);
      index += 1;
    } else if (option === "--attempt-timeout-seconds") {
      result.attemptTimeoutSeconds = parseInteger(value, option, 45, 600);
      index += 1;
    } else {
      throw new FriendlyError(`Unknown supervisor option: ${option}\n${usage()}`);
    }
  }

  if (!result.codex || !result.cwd) {
    throw new FriendlyError(`Both --codex and --cwd are required.\n${usage()}`);
  }
  if (result.codex.includes("\0") || result.cwd.includes("\0")) {
    throw new FriendlyError("NUL characters are not allowed in paths.");
  }

  result.codex = path.resolve(result.codex);
  result.cwd = path.resolve(result.cwd);
  if (!fs.existsSync(result.codex) || !fs.statSync(result.codex).isFile()) {
    throw new FriendlyError(`Codex executable is not an existing file: ${result.codex}`);
  }
  if (!fs.existsSync(result.cwd) || !fs.statSync(result.cwd).isDirectory()) {
    throw new FriendlyError(`Workspace is not an existing directory: ${result.cwd}`);
  }
  if (process.platform === "win32" && !result.codex.toLowerCase().endsWith(".exe")) {
    throw new FriendlyError(
      "Resilient Apps mode requires a standalone codex.exe on Windows. " +
      "Run setup.ps1 -InstallCLIs if only a .cmd shim is available.",
    );
  }
  return result;
}

function requireOptionValue(args, index, option) {
  const value = args[index + 1];
  if (value === undefined || value === "--") {
    throw new FriendlyError(`${option} requires a value.`);
  }
  return value;
}

function optionValueFromEquals(token, option) {
  const prefix = `${option}=`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : null;
}

function shortOptionValue(token, option) {
  if (token === option || !token.startsWith(option)) return null;
  const suffix = token.slice(option.length);
  return suffix.startsWith("=") ? suffix.slice(1) : suffix;
}

function requireInlineOptionValue(value, option) {
  if (value === null) return null;
  if (value.length === 0) throw new FriendlyError(`${option} requires a value.`);
  return value;
}

function normalizeAdditionalRoot(root, cwd) {
  const resolved = path.resolve(cwd, root);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new FriendlyError(`--add-dir is not an existing directory: ${resolved}`);
  }
  return resolved;
}

function prepareCodexOptions(originalArguments, cwd) {
  const appServerArguments = [];
  const tuiArguments = [];
  const threadParams = {
    cwd,
    ephemeral: false,
    sessionStartSource: "startup",
  };
  const runtimeRoots = [cwd];

  for (let index = 0; index < originalArguments.length; index += 1) {
    const token = originalArguments[index];
    let value;

    if (token === "--") {
      // Everything after the standard option delimiter is positional input,
      // even when it looks like a model/sandbox/config flag.
      tuiArguments.push(...originalArguments.slice(index));
      break;
    }

    if (token === "-c" || token === "--config") {
      value = requireOptionValue(originalArguments, index, token);
      appServerArguments.push("--config", value);
      tuiArguments.push(token, value);
      index += 1;
      continue;
    }
    value = requireInlineOptionValue(shortOptionValue(token, "-c"), "-c");
    if (value !== null) {
      appServerArguments.push("--config", value);
      tuiArguments.push(token);
      continue;
    }
    value = optionValueFromEquals(token, "--config");
    if (value !== null) {
      appServerArguments.push("--config", value);
      tuiArguments.push(token);
      continue;
    }

    if (token === "--enable" || token === "--disable") {
      value = requireOptionValue(originalArguments, index, token);
      if (value === "apps" && token === "--disable") {
        throw new FriendlyError(
          "Do not pass --disable apps to resilient mode. Use start-duo.ps1 -DisableApps " +
          "only when you explicitly want a connector-free session.",
        );
      }
      if (value !== "apps") appServerArguments.push(token, value);
      if (value !== "apps") tuiArguments.push(token, value);
      index += 1;
      continue;
    }
    value = optionValueFromEquals(token, "--enable");
    if (value !== null) {
      if (value !== "apps") appServerArguments.push("--enable", value);
      if (value !== "apps") tuiArguments.push(token);
      continue;
    }
    value = optionValueFromEquals(token, "--disable");
    if (value !== null) {
      if (value === "apps") {
        throw new FriendlyError(
          "Do not pass --disable=apps to resilient mode. Use start-duo.ps1 -DisableApps instead.",
        );
      }
      appServerArguments.push("--disable", value);
      tuiArguments.push(token);
      continue;
    }

    if (token === "--strict-config") {
      appServerArguments.push(token);
      tuiArguments.push(token);
      continue;
    }
    if (token === "--search") {
      appServerArguments.push("--config", 'web_search="live"');
      tuiArguments.push(token);
      continue;
    }

    if (token === "-m" || token === "--model") {
      threadParams.model = requireOptionValue(originalArguments, index, token);
      tuiArguments.push(token, threadParams.model);
      index += 1;
      continue;
    }
    value = requireInlineOptionValue(shortOptionValue(token, "-m"), "-m");
    if (value !== null) {
      threadParams.model = value;
      tuiArguments.push(token);
      continue;
    }
    value = optionValueFromEquals(token, "--model");
    if (value !== null) {
      threadParams.model = value;
      tuiArguments.push(token);
      continue;
    }

    if (token === "-s" || token === "--sandbox") {
      threadParams.sandbox = requireOptionValue(originalArguments, index, token);
      tuiArguments.push(token, threadParams.sandbox);
      index += 1;
      continue;
    }
    value = requireInlineOptionValue(shortOptionValue(token, "-s"), "-s");
    if (value !== null) {
      threadParams.sandbox = value;
      tuiArguments.push(token);
      continue;
    }
    value = optionValueFromEquals(token, "--sandbox");
    if (value !== null) {
      threadParams.sandbox = value;
      tuiArguments.push(token);
      continue;
    }

    if (token === "-a" || token === "--ask-for-approval") {
      threadParams.approvalPolicy = requireOptionValue(originalArguments, index, token);
      tuiArguments.push(token, threadParams.approvalPolicy);
      index += 1;
      continue;
    }
    value = requireInlineOptionValue(shortOptionValue(token, "-a"), "-a");
    if (value !== null) {
      threadParams.approvalPolicy = value;
      tuiArguments.push(token);
      continue;
    }
    value = optionValueFromEquals(token, "--ask-for-approval");
    if (value !== null) {
      threadParams.approvalPolicy = value;
      tuiArguments.push(token);
      continue;
    }

    if (token === "--dangerously-bypass-approvals-and-sandbox") {
      threadParams.sandbox = "danger-full-access";
      threadParams.approvalPolicy = "never";
      tuiArguments.push(token);
      continue;
    }
    if (token === "--approve-for-me") {
      threadParams.sandbox = "workspace-write";
      threadParams.approvalsReviewer = "auto_review";
      tuiArguments.push(token);
      continue;
    }

    if (token === "--add-dir") {
      value = requireOptionValue(originalArguments, index, token);
      runtimeRoots.push(normalizeAdditionalRoot(value, cwd));
      tuiArguments.push(token, value);
      index += 1;
      continue;
    }
    value = optionValueFromEquals(token, "--add-dir");
    if (value !== null) {
      runtimeRoots.push(normalizeAdditionalRoot(value, cwd));
      tuiArguments.push(token);
      continue;
    }

    if (token === "-C" || shortOptionValue(token, "-C") !== null ||
        token === "--cd" || optionValueFromEquals(token, "--cd") !== null) {
      throw new FriendlyError(
        "Use start-duo.ps1 -Workspace to select the workspace in resilient Apps mode; " +
        "do not also pass Codex -C/--cd.",
      );
    }
    if (token === "--remote" || optionValueFromEquals(token, "--remote") !== null) {
      throw new FriendlyError("The Apps supervisor owns --remote; remove the extra Codex --remote option.");
    }
    if (token === "-p" || shortOptionValue(token, "-p") !== null ||
        token === "--profile" || token === "--oss" ||
        token === "--local-provider" || optionValueFromEquals(token, "--profile") !== null ||
        optionValueFromEquals(token, "--local-provider") !== null ||
        token === "--dangerously-bypass-hook-trust") {
      throw new FriendlyError(
        `${token} cannot be applied to an already-live remote thread. ` +
        "Use config.toml/-c, or start-duo.ps1 -DirectCodex for this specialized invocation.",
      );
    }

    // Presentation options, image inputs, a starting prompt, and future options
    // remain TUI-owned. Known thread/config overrides above are applied before
    // the Apps connection starts so resume cannot silently ignore them.
    tuiArguments.push(token);
  }

  if (runtimeRoots.length > 1) {
    threadParams.runtimeWorkspaceRoots = [...new Set(runtimeRoots)];
  }
  if (threadParams.sandbox && !new Set(["read-only", "workspace-write", "danger-full-access"]).has(threadParams.sandbox)) {
    throw new FatalError(`Unsupported sandbox mode: ${threadParams.sandbox}`);
  }
  if (threadParams.approvalPolicy && !new Set(["untrusted", "on-request", "never"]).has(threadParams.approvalPolicy)) {
    throw new FatalError(`Unsupported approval policy: ${threadParams.approvalPolicy}`);
  }
  return { appServerArguments, tuiArguments, threadParams };
}

function assertCompatibleCodex(codex, cwd) {
  const probes = [
    { args: ["--help"], required: ["--remote"] },
    { args: ["app-server", "--help"], required: ["--listen"] },
  ];
  for (const probe of probes) {
    const result = spawnSync(codex, probe.args, {
      cwd,
      env: process.env,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
    });
    const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.error || result.status !== 0 || !probe.required.every((literal) => help.includes(literal))) {
      throw new FatalError(
        `The selected Codex CLI is incompatible with resilient Apps mode; missing ${probe.required.join(", ")}. ` +
        "Update the standalone Codex CLI or use start-duo.ps1 -DirectCodex.",
      );
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForNotification(emitter, eventName, milliseconds) {
  return new Promise((resolve) => {
    let timeout;
    const onNotification = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    timeout = setTimeout(() => {
      emitter.removeListener(eventName, onNotification);
      resolve(null);
    }, milliseconds);
    emitter.once(eventName, onNotification);
  });
}

function withTimeout(promise, milliseconds, description) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new FriendlyError(`${description} timed out after ${Math.round(milliseconds / 1_000)}s.`)), milliseconds);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function chooseLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new FriendlyError("Could not allocate a loopback port for Codex App Server.");
  return port;
}

function appendLogTail(context, label, chunk) {
  context.logTail += `[${label}] ${String(chunk)}`;
  if (context.logTail.length > LOG_TAIL_LIMIT) {
    context.logTail = context.logTail.slice(-LOG_TAIL_LIMIT);
  }
}

function sanitizeMessage(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/[\w.+-]+@[\w.-]+/g, "[redacted-email]")
    .replace(/(token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function taskkillTree(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch {}
  }
}

function closeContext(context) {
  if (!context) return;
  try { context.rpc?.close(); } catch {}
  try { context.ws?.close(); } catch {}
  if (context.server && context.server.exitCode === null && context.server.signalCode === null) {
    taskkillTree(context.server.pid);
  }
  context.server = null;
}

async function waitForHttpReady(context, port) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (context.serverError) {
      throw new FatalError(`Could not start Codex App Server: ${sanitizeMessage(context.serverError.message)}`);
    }
    if (context.server.exitCode !== null || context.server.signalCode !== null) {
      throw new FatalError(`Codex App Server exited before readiness (code ${context.server.exitCode ?? "unknown"}).`);
    }
    try {
      const response = await withTimeout(fetch(`http://127.0.0.1:${port}/readyz`), 1_500, "App Server readiness request");
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new FriendlyError("Codex App Server did not open its local readiness endpoint.");
}

async function openWebSocket(endpoint) {
  const ws = new WebSocket(endpoint);
  await withTimeout(new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new FriendlyError("Could not connect to the local Codex App Server WebSocket.")), { once: true });
  }), SERVER_READY_TIMEOUT_MS, "App Server WebSocket connection");
  return ws;
}

class RpcClient {
  constructor(ws, notifications) {
    this.ws = ws;
    this.notifications = notifications;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => this.failPending(new FriendlyError("Codex App Server WebSocket closed.")));
    ws.addEventListener("error", () => this.failPending(new FriendlyError("Codex App Server WebSocket failed.")));
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    // Thread-scoped server requests are broadcast to every subscriber with one
    // shared callback. This supervisor is intentionally passive; the attached
    // TUI must be the only client that answers approvals, user-input requests,
    // and MCP elicitations. A fast -32601 here could beat the user's response.
    if (message.id !== undefined && message.method) {
      this.notifications.emit("server-request", message);
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        const ErrorType = message.error.code === -32601 || message.error.code === -32602 ? FatalError : FriendlyError;
        pending.reject(new ErrorType(`${pending.method} failed: ${sanitizeMessage(message.error.message ?? JSON.stringify(message.error))}`));
      }
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.notifications.emit("notification", message);
  }

  request(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
    // String IDs avoid legal collisions with App Server's small integer IDs in
    // this bidirectional JSON-RPC connection.
    const id = `${CLIENT_NAME}:${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new FriendlyError(`${method} did not respond within ${Math.round(timeoutMs / 1_000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method, params) {
    this.ws.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.failPending(new FriendlyError("Apps supervisor closed the RPC connection."));
  }
}

async function waitForRequiredServersReady(context, threadId, deadline) {
  const readStatus = (name) => context.startupStatuses.get(`${threadId}:${name}`);
  while (Date.now() < deadline) {
    const pending = REQUIRED_THREAD_MCP_SERVERS.filter(
      (name) => readStatus(name)?.status !== "ready",
    );
    if (pending.length === 0) {
      return new Map(REQUIRED_THREAD_MCP_SERVERS.map((name) => [name, readStatus(name)]));
    }
    // Codex can publish cancelled/failed while replacing or reconnecting the
    // same hosted runtime, followed by ready. Keep this exact thread loaded
    // until the attempt deadline instead of treating an intermediate state as
    // final.

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitForNotification(
      context.notifications,
      "startup-update",
      Math.min(READY_POLL_MS, remaining),
    );
  }
  const details = REQUIRED_THREAD_MCP_SERVERS.map((name) => {
    const status = readStatus(name);
    const error = status?.error ? ` (${sanitizeMessage(status.error)})` : "";
    return `${name}=${status?.status ?? "not reported"}${error}`;
  });
  throw new FriendlyError(
    `Required MCP servers did not reach live ready state: ${details.join(", ")}.`,
  );
}

async function prepareLiveThread(options, prepared, attemptDeadline) {
  const port = await chooseLoopbackPort();
  const endpoint = `ws://127.0.0.1:${port}`;
  const serverArguments = [
    "app-server",
    "--listen",
    endpoint,
    ...options.appServerArguments,
    "--enable",
    "apps",
  ];
  const context = {
    server: null,
    ws: null,
    rpc: null,
    endpoint,
    logTail: "",
    notifications: new EventEmitter(),
    startupStatuses: new Map(),
    serverError: null,
  };
  prepared.context = context;

  context.server = spawn(options.codex, serverArguments, {
    cwd: options.cwd,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.server.stdout.on("data", (chunk) => appendLogTail(context, "stdout", chunk));
  context.server.stderr.on("data", (chunk) => appendLogTail(context, "stderr", chunk));
  context.server.once("error", (error) => {
    context.serverError = error;
    context.notifications.emit("server-error", error);
  });

  await waitForHttpReady(context, port);
  context.ws = await openWebSocket(endpoint);
  context.rpc = new RpcClient(context.ws, context.notifications);
  context.notifications.on("notification", (message) => {
    if (message.method !== "mcpServer/startupStatus/updated") return;
    const params = message.params ?? {};
    if (!params.threadId || !params.name) return;
    context.startupStatuses.set(`${params.threadId}:${params.name}`, params);
    context.notifications.emit("startup-update", params);
  });

  await context.rpc.request("initialize", {
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    capabilities: { experimentalApi: true },
  });
  context.rpc.notify("initialized");

  // Start the real terminal thread directly. app/installed(forceRefresh=true)
  // creates a separate temporary MCP runtime with the same fixed 30-second
  // timeout, so putting it here would add a second, unrelated failure gate.
  const threadResult = await context.rpc.request("thread/start", options.threadParams, Math.max(RPC_TIMEOUT_MS, attemptDeadline - Date.now()));
  const threadId = threadResult?.thread?.id;
  if (!threadId) throw new FriendlyError("thread/start did not return a thread id.");

  await waitForRequiredServersReady(context, threadId, attemptDeadline);

  // An empty assistant item materializes the otherwise-empty rollout without a
  // visible title, user message, reconstructed turn, or Git metadata mutation.
  // This is required because an entirely empty thread is not persisted and
  // therefore cannot be resumed by the remote TUI.
  await context.rpc.request("thread/inject_items", {
    threadId,
    items: [{ type: "message", role: "assistant", content: [] }],
  });

  return {
    context,
    threadId,
  };
}

function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
}

async function spawnTui(options, ready) {
  const args = [
    "--remote",
    ready.context.endpoint,
    "--enable",
    "apps",
    "resume",
    ready.threadId,
    ...options.tuiArguments,
  ];
  const tui = spawn(options.codex, args, {
    cwd: options.cwd,
    env: process.env,
    windowsHide: false,
    stdio: "inherit",
  });
  activeTui = tui;
  return new Promise((resolve, reject) => {
    tui.once("error", (error) => {
      activeTui = null;
      reject(error);
    });
    tui.once("exit", (code, signal) => {
      activeTui = null;
      resolve({ code, signal });
    });
  });
}

let options;
try {
  const wrapper = parseWrapperArguments(process.argv.slice(2));
  const preparedOptions = prepareCodexOptions(wrapper.codexArguments, wrapper.cwd);
  options = { ...wrapper, ...preparedOptions };
} catch (error) {
  process.stderr.write(`Apps-resilient Codex launch failed: ${sanitizeMessage(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
}
let activeContext = null;
let activeTui = null;
let tuiRunning = false;

function terminateActiveTui() {
  if (activeTui && activeTui.exitCode === null && activeTui.signalCode === null) {
    taskkillTree(activeTui.pid);
  }
  activeTui = null;
}

process.on("SIGINT", () => {
  // During the TUI phase, Codex itself owns Ctrl+C (cancel/interrupt). Keeping
  // the supervisor alive preserves the already-ready Apps connection.
  if (tuiRunning) return;
  closeContext(activeContext);
  process.stderr.write("\n[Apps] Readiness wait cancelled.\n");
  process.exit(130);
});
process.on("SIGTERM", () => {
  terminateActiveTui();
  closeContext(activeContext);
  process.exit(143);
});
process.on("SIGHUP", () => {
  terminateActiveTui();
  closeContext(activeContext);
  process.exit(129);
});
process.on("exit", () => {
  terminateActiveTui();
  closeContext(activeContext);
});

try {
  if (typeof WebSocket !== "function") {
    throw new FatalError("Node.js does not provide WebSocket support. Install the current Node.js LTS release.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) {
    throw new FatalError(
      "Resilient Apps mode needs an interactive terminal. Run it from Windows Terminal, " +
      "or use start-duo.ps1 -DirectCodex for a non-interactive invocation.",
    );
  }
  assertCompatibleCodex(options.codex, options.cwd);
  let ready = null;
  for (let attempt = 1; !ready; attempt += 1) {
    const startedAt = Date.now();
    const timeoutMs = options.attemptTimeoutSeconds * 1_000;
    const holder = { context: null };
    process.stdout.write(
      `[Duo] Verifying hosted Apps and Claude Peer on the real Codex thread ` +
      `(attempt ${attempt}${options.retryLimit === 0 ? ", retries unlimited" : ` of ${options.retryLimit}`}; no model inference)...\n`,
    );
    try {
      ready = await withTimeout(
        prepareLiveThread(options, holder, startedAt + timeoutMs),
        timeoutMs,
        "Hosted Apps readiness attempt",
      );
      activeContext = ready.context;
      const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
      process.stdout.write(
        `[Duo] Ready in ${seconds}s: codex_apps and Claude Peer are live on the terminal thread. ` +
        "Starting Codex on this verified thread.\n",
      );
    } catch (error) {
      activeContext = holder.context;
      const logTail = activeContext?.logTail ?? "";
      closeContext(activeContext);
      activeContext = null;
      const reason = sanitizeMessage(error instanceof Error ? error.message : error);
      process.stderr.write(`[Duo] Attempt ${attempt} did not become ready: ${reason}\n`);
      if (process.env.CODEX_DUO_APPS_DEBUG === "1" && logTail) {
        process.stderr.write(`${sanitizeMessage(logTail)}\n`);
      }
      if (error instanceof FatalError) throw error;
      if (options.retryLimit > 0 && attempt >= options.retryLimit) {
        throw new FriendlyError(
          `Hosted Apps remained unavailable after ${attempt} attempt(s). ` +
          "Nothing was disabled and no degraded terminal was started. Retry later, increase " +
          "-AppsRetryLimit, use 0 for unlimited retries, or explicitly use -DirectCodex.",
        );
      }
      const waitMs = retryDelay(attempt);
      process.stderr.write(`[Duo] Retrying in ${Math.round(waitMs / 1_000)}s. Press Ctrl+C to stop.\n`);
      await delay(waitMs);
    }
  }

  tuiRunning = true;
  const result = await spawnTui(options, ready);
  tuiRunning = false;
  closeContext(activeContext);
  activeContext = null;
  if (result.signal) {
    process.stderr.write(`Codex TUI exited from signal ${result.signal}.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.code ?? 1;
  }
} catch (error) {
  tuiRunning = false;
  closeContext(activeContext);
  activeContext = null;
  process.stderr.write(`Apps-resilient Codex launch failed: ${sanitizeMessage(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
}
