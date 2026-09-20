// Codex tests cover the before_agent_run admission gate in startCodexAttemptTurn.
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
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
    const terminal = readAttemptTerminal(result);
    expect(terminal.promptError).toBe(
      "Your message could not be sent: Request blocked. (blocked by policy)",
    );
    // Denial must settle as the canonical before_agent_run policy-block
    // terminal, not an ordinary "prompt" failure, so the outer harness
    // lifecycle (src/agents/harness/lifecycle.ts) reports it as blocked
    // rather than a generic error.
    expect(terminal.promptErrorSource).toBe("hook:before_agent_run");
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

  it("redacts the rejected prompt before the transcript owner, agent_end, or the returned snapshot see it", async () => {
    const sensitiveSentinel = "SENTINEL-4b2e-classified-prompt-payload";
    const beforeAgentRun = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "unsafe input",
      message: "Request blocked.",
    }));
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_run", handler: beforeAgentRun, pluginId: "policy" },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    createStartedThreadHarness();
    const persistBlocked = vi.fn(async (_message: unknown) => undefined);
    const params = createParams(sessionFile, workspaceDir, { prompt: sensitiveSentinel });
    params.userTurnTranscriptRecorder = {
      message: undefined,
      resolveMessage: async () => undefined,
      getAdmissionReceipt: () => undefined,
      markRuntimePersistencePending() {},
      markRuntimePersisted() {},
      persistBlocked,
    } as unknown as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];

    const result = await runCodexAppServerAttempt(params);

    expect(readAttemptTerminal(result).promptErrorSource).toBe("hook:before_agent_run");

    // The transcript owner receives a redacted replacement, never the
    // original rejected prompt text.
    expect(persistBlocked).toHaveBeenCalledTimes(1);
    const [persistedMessage] = persistBlocked.mock.calls[0] as [unknown];
    expect(JSON.stringify(persistedMessage)).not.toContain(sensitiveSentinel);

    // agent_end never sees the original prompt either.
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { messages?: unknown[] },
      unknown,
    ];
    expect(JSON.stringify(agentEndPayload.messages)).not.toContain(sensitiveSentinel);

    // Nor does the snapshot returned to the caller for persistence/future context.
    expect(
      JSON.stringify((result as { messagesSnapshot?: unknown[] }).messagesSnapshot),
    ).not.toContain(sensitiveSentinel);
  });

  it("derives the admission channel identity from the canonical per-conversation hook context", async () => {
    // Two distinct conversations on the same messaging provider must resolve
    // distinct admission channel identities. Deriving channelId from raw
    // messageChannel/messageProvider alone would collapse every conversation
    // on one provider into the same identity.
    // Block outcome keeps this test on the fast, zero-native-I/O path; the
    // event construction under test happens identically either way.
    const beforeAgentRun = vi.fn(async (..._args: unknown[]) => ({
      outcome: "block" as const,
      reason: "test probe",
      message: "Request blocked.",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );

    const runOneConversation = async (options: { sessionId: string; currentChannelId: string }) => {
      createStartedThreadHarness();
      const sessionFile = path.join(tempDir, options.sessionId, "session.jsonl");
      const workspaceDir = path.join(tempDir, options.sessionId, "workspace");
      const params = createParams(sessionFile, workspaceDir, {
        sessionId: options.sessionId,
        sessionKey: `agent:main:${options.sessionId}`,
      });
      params.messageProvider = "telegram";
      params.currentChannelId = options.currentChannelId;
      await runCodexAppServerAttempt(params);
    };

    await runOneConversation({ sessionId: "session-alpha", currentChannelId: "chat-alpha" });
    await runOneConversation({ sessionId: "session-beta", currentChannelId: "chat-beta" });

    expect(beforeAgentRun).toHaveBeenCalledTimes(2);
    const [firstEvent] = beforeAgentRun.mock.calls[0] as [{ channelId?: string }, unknown];
    const [secondEvent] = beforeAgentRun.mock.calls[1] as [{ channelId?: string }, unknown];
    expect(firstEvent.channelId).toBe("chat-alpha");
    expect(secondEvent.channelId).toBe("chat-beta");
    expect(firstEvent.channelId).not.toBe(secondEvent.channelId);
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

  it("starts no native turn when the run is cancelled while admission is still pending", async () => {
    const admissionGate = createDeferred<{ outcome: "pass" }>();
    const beforeAgentRun = vi.fn(() => admissionGate.promise);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_run", handler: beforeAgentRun }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const abortController = new AbortController();
    const params = createParams(sessionFile, workspaceDir);
    params.abortSignal = abortController.signal;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(beforeAgentRun).toHaveBeenCalledTimes(1), fastWait);

    const abortReason = new Error("cancelled while admission pending");
    abortController.abort(abortReason);
    // Resolve admission after cancellation: neither a pass nor a block
    // decision computed for an already-cancelled attempt may start a turn.
    admissionGate.resolve({ outcome: "pass" });

    const rejection = await run.catch((error: unknown) => error);
    expect(harness.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(rejection).toBe(abortReason);
  });
});
