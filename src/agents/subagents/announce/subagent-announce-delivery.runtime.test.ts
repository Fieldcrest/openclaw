import { describe, expect, it, vi } from "vitest";
import { WRITE_SCOPE } from "../../../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "../../../gateway/server-methods/types.js";
import { dispatchSubagentAnnounceAgent } from "./subagent-announce-delivery.runtime.js";

function createContext(handlers: GatewayRequestHandlers): GatewayRequestContext {
  return {
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => createRegistry(handlers),
    logGateway: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function createRegistry(handlers: GatewayRequestHandlers) {
  return createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: WRITE_SCOPE,
    })),
  );
}

describe("subagent announce Gateway instance dispatch", () => {
  it("delivers a detached announce through its explicit instance resolver", async () => {
    const context = createContext({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const idempotencyKey = "detached-subagent-announce";
    context.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId: "announce-run", status: "ok", summary: "delivered" },
    });

    await expect(
      dispatchSubagentAnnounceAgent(
        {
          message: "Process one completed child result.",
          idempotencyKey,
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          resolveGatewayContext: () => context,
        },
      ),
    ).resolves.toEqual({ runId: "announce-run", status: "ok", summary: "delivered" });
  });

  it("uses the bound Gateway instance and rejects a stale owner", async () => {
    const runId = "bound-announce-run";
    const firstContext = createContext();
    const secondContext = createContext();
    firstContext.dedupe.set(`agent:${runId}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", summary: "first" },
    });
    secondContext.dedupe.set(`agent:${runId}`, {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", summary: "second" },
    });
    const registry = createRegistry({
      agent: ({ respond }) => respond(true, { raw: true }),
    });
    const first = createGatewayInstanceRuntime({
      getContext: () => firstContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    firstContext.recoveryRuntime = first.recovery;
    const second = createGatewayInstanceRuntime({
      getContext: () => secondContext,
      getMethodRegistry: () => registry,
      isDispatchAvailable: () => true,
    });
    secondContext.recoveryRuntime = second.recovery;
    let firstActive = true;
    const dispatch = () =>
      dispatchSubagentAnnounceAgent(
        { message: "Process one completed child result.", idempotencyKey: runId },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          resolveGatewayContext: () => (firstActive ? firstContext : undefined),
        },
      );

    try {
      await expect(dispatch()).resolves.toEqual({ runId, status: "ok", summary: "first" });
      firstActive = false;
      first.close();
      await expect(dispatch()).rejects.toThrow("Gateway instance lifecycle dispatch unavailable");
    } finally {
      first.close();
      second.close();
    }
  });
});
