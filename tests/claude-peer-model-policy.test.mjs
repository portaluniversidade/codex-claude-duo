import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const pluginRoot = process.env.CLAUDE_PEER_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PEER_PLUGIN_ROOT)
  : fileURLToPath(new URL("../plugins/claude-peer", import.meta.url));
const serverPath = path.join(pluginRoot, "scripts", "claude-peer-mcp.mjs");
const manifest = JSON.parse(readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const responses = new Map();
  const waiters = new Map();
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
      waiter.resolve(message);
    } else {
      responses.set(message.id, message);
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(id, method, params = {}, timeoutMs = 10_000) {
    send({ jsonrpc: "2.0", id, method, params });
    if (responses.has(id)) {
      const response = responses.get(id);
      responses.delete(id);
      return Promise.resolve(response);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`));
      }, timeoutMs);
      waiters.set(id, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
      });
    });
  }

  async function close() {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await once(child, "exit");
    assert.equal(child.exitCode, 0, stderr);
  }

  return { child, close, request, send };
}

test("session-start schemas advertise the strongest default and current choices", async (t) => {
  const server = startServer();
  t.after(() => server.close());

  const initialized = await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "model-policy-test", version: "1" },
  });
  assert.equal(initialized.result.serverInfo.version, manifest.version);
  assert.match(initialized.result.instructions, /Fable at max effort/i);
  assert.match(initialized.result.instructions, /Opus\/Sonnet availability fallback/i);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listed = await server.request(2, "tools/list");
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.size, 8);
  const expectedAliases = [
    "default",
    "best",
    "fable",
    "opus",
    "opus[1m]",
    "sonnet",
    "sonnet[1m]",
    "haiku",
    "opusplan",
    "opusplan[1m]",
  ];
  const expectedExactPresets = [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ];

  for (const name of [
    "claude_plan",
    "claude_plan_unlimited",
    "claude_implement",
    "claude_full",
    "claude_full_unlimited",
  ]) {
    const properties = tools.get(name).inputSchema.properties;
    assert.equal(properties.model.default, "fable", name);
    assert.equal(properties.effort.default, "max", name);
    assert.deepEqual(properties.fallbackModels.default, ["opus", "sonnet"], name);
    for (const selector of [...expectedAliases, ...expectedExactPresets]) {
      if (name.startsWith("claude_full") && (selector === "haiku" || selector.startsWith("claude-haiku-"))) {
        assert.ok(!properties.model.anyOf[0].enum.includes(selector), `${name}: ${selector}`);
      } else {
        assert.ok(properties.model.anyOf[0].enum.includes(selector), `${name}: ${selector}`);
      }
    }
    assert.ok(properties.effort.enum.includes("max"), name);
    assert.ok(properties.effort.enum.includes("ultracode"), name);
    assert.match(properties.fallbackModels.description, /does not bypass safety refusals/i, name);
  }

  for (const name of ["claude_reply", "claude_full_reply"]) {
    const properties = tools.get(name).inputSchema.properties;
    assert.equal(properties.model, undefined, name);
    assert.equal(properties.effort, undefined, name);
    assert.equal(properties.fallbackModels, undefined, name);
  }

  const reviewModels = tools.get("claude_plan").inputSchema.properties.model.anyOf[0].enum;
  const fullModels = tools.get("claude_full").inputSchema.properties.model.anyOf[0].enum;
  assert.ok(reviewModels.includes("haiku"));
  assert.ok(reviewModels.includes("claude-haiku-4-5"));
  assert.ok(!fullModels.includes("haiku"));
  assert.ok(!fullModels.includes("claude-haiku-4-5"));

  const invalidHaikuEffort = await server.request(3, "tools/call", {
    name: "claude_plan",
    arguments: { prompt: "no inference", cwd: process.cwd(), model: "haiku", effort: "max" },
  });
  assert.equal(invalidHaikuEffort.error.code, -32602);
  assert.match(invalidHaikuEffort.error.message, /Haiku does not support selectable effort/i);

  const oversizedFallbackChain = await server.request(4, "tools/call", {
    name: "claude_plan",
    arguments: {
      prompt: "no inference",
      cwd: process.cwd(),
      fallbackModels: ["opus", "sonnet", "haiku", "default"],
    },
  });
  assert.equal(oversizedFallbackChain.error.code, -32602);
  assert.match(oversizedFallbackChain.error.message, /at most 3 model selectors/i);
});

test(
  "authenticated live smoke reports the requested and observed model policy",
  {
    skip: process.env.CLAUDE_PEER_LIVE_SMOKE !== "1",
    timeout: 20 * 60 * 1000,
  },
  async (t) => {
    const cwd = process.env.CLAUDE_PEER_LIVE_CWD;
    assert.ok(cwd, "CLAUDE_PEER_LIVE_CWD is required when CLAUDE_PEER_LIVE_SMOKE=1");
    const server = startServer();
    t.after(() => server.close());

    await server.request(10, "initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "live-model-policy-test", version: "1" },
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const statusResponse = await server.request(11, "tools/call", {
      name: "claude_status",
      arguments: {},
    });
    const status = statusResponse.result.structuredContent;
    assert.equal(status.status, "ready", status.content);
    assert.equal(status.modelSelection.defaultModel, "fable");
    assert.equal(status.modelSelection.defaultEffort, "max");
    assert.ok(status.modelSelection.supportedAliases.includes("opus"));
    assert.ok(status.modelSelection.supportedAliases.includes("haiku"));
    assert.ok(status.modelSelection.currentExactModelPresets.includes("claude-opus-5"));
    assert.ok(status.modelSelection.currentExactModelPresets.includes("claude-fable-5"));
    assert.ok(status.modelSelection.supportedEfforts.includes("ultracode"));
    assert.deepEqual(status.fullAgentPolicy.defaultAvailabilityFallbackModels, ["opus", "sonnet"]);

    const planResponse = await server.request(
      12,
      "tools/call",
      {
        name: "claude_plan",
        arguments: {
          prompt: "Live routing smoke test. Reply with exactly LIVE_SMOKE_OK. Do not inspect files or use tools.",
          cwd,
          maxTurns: 24,
        },
      },
      15 * 60 * 1000
    );
    const result = planResponse.result.structuredContent;
    assert.notEqual(planResponse.result.isError, true, JSON.stringify(result));
    assert.equal(result.status, "done");
    assert.equal(result.requestedModel, "fable");
    assert.equal(result.requestedEffort, "max");
    assert.deepEqual(result.configuredFallbackModels, ["opus", "sonnet"]);
    assert.ok(result.modelsUsed.some((model) => model.includes("claude-fable-")), result.modelsUsed.join(", "));
    assert.ok(
      ["primary_model_observed", "primary_and_fallback_models_observed"].includes(result.modelVerification.status),
      JSON.stringify(result.modelVerification)
    );
    assert.equal(result.effortVerification.requestedSetting, "max");
    assert.equal(result.effortVerification.cliArgumentApplied, true);
    assert.equal(result.effortVerification.effectiveEffort, null);

    console.log(
      JSON.stringify(
        {
          requestedModel: result.requestedModel,
          requestedEffort: result.requestedEffort,
          configuredFallbackModels: result.configuredFallbackModels,
          modelsUsed: result.modelsUsed,
          modelVerification: result.modelVerification,
          effortVerification: result.effortVerification,
          turns: result.turns,
          durationMs: result.durationMs,
        },
        null,
        2
      )
    );

    const failureResponse = await server.request(
      13,
      "tools/call",
      {
        name: "claude_plan",
        arguments: {
          prompt:
            "Failure telemetry smoke test. You must call Glob with pattern **/* before answering. Only after its result returns, answer FAILURE_SMOKE_OK.",
          cwd,
          maxTurns: 1,
        },
      },
      15 * 60 * 1000
    );
    const failure = failureResponse.result.structuredContent;
    assert.equal(failureResponse.result.isError, true, JSON.stringify(failure));
    assert.equal(failure.status, "error");
    assert.equal(failure.failureKind, "error_max_turns");
    assert.equal(failure.requestedModel, "fable");
    assert.equal(failure.requestedEffort, "max");
    assert.deepEqual(failure.configuredFallbackModels, ["opus", "sonnet"]);
    assert.ok(failure.modelsUsed.some((model) => model.includes("claude-fable-")), failure.modelsUsed.join(", "));
    assert.equal(failure.effortVerification.effectiveEffort, null);
    assert.equal(failure.fallbackPolicy.automaticRetryAfterSafetyRefusal, false);

    console.log(
      JSON.stringify(
        {
          expectedFailure: failure.failureKind,
          requestedModel: failure.requestedModel,
          requestedEffort: failure.requestedEffort,
          configuredFallbackModels: failure.configuredFallbackModels,
          modelsUsed: failure.modelsUsed,
          modelVerification: failure.modelVerification,
          effortVerification: failure.effortVerification,
        },
        null,
        2
      )
    );
  }
);
