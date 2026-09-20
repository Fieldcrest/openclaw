// Codex tests cover the before_agent_run admission gate in startCodexAttemptTurn.
import path from "node:path";
import {
  onInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt before_agent_run admission", () => {
  it("admits an allowed attempt once and starts exactly one native turn", async () => {
    const beforeAgentRun = vi.fn(async () => ({ outcome: "pass" as const }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
  });

  it("blocks a denied attempt with zero native starts and a terminal blocked result", async () => {
    const beforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "unsafe input",
      message: "Request blocked.",
    }));
    const llmInput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun, pluginId: "policy" },
        { hookName: "llm_input", handler: llmInput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBe(
      "Your message could not be sent: Request blocked. (blocked by policy)",
    );
    expect(llmInput).not.toHaveBeenCalled();
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { success?: boolean; error?: string },
      unknown,
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe(
      "Your message could not be sent: Request blocked. (blocked by policy)",
    );
  });

  it("fails closed with zero native starts when the admission hook throws", async () => {
    const beforeAgentRun = vi.fn(async () => {
      throw new Error("policy unavailable");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const result = await runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));

    expect(beforeAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(readAttemptTerminal(result).promptError).toBe(
      "Your message could not be sent: blocked by before_agent_run",
    );
  });

  it("holds diagnostics, llm_input, and the native turn until admission resolves", async () => {
    const admissionGate = createDeferred<{ outcome: "pass" }>();
    const beforeAgentRun = vi.fn(() => admissionGate.promise);
    const llmInput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type === "model.call.started") {
        diagnosticEvents.push(event);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.config = {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
      } as never;
      const run = runCodexAppServerAttempt(params);

      await vi.waitFor(() => expect(beforeAgentRun).toHaveBeenCalledTimes(1), fastWait);
      // Nothing model-facing should start while admission is still pending.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(llmInput).not.toHaveBeenCalled();
      expect(diagnosticEvents).toHaveLength(0);
      expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);

      admissionGate.resolve({ outcome: "pass" });
      await harness.waitForMethod("turn/start");
      await vi.waitFor(() => expect(llmInput).toHaveBeenCalledTimes(1), fastWait);
      await vi.waitFor(() => expect(diagnosticEvents).toHaveLength(1), fastWait);

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    } finally {
      stopDiagnostics();
    }
  });
});
