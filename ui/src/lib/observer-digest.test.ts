// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isCriticalObserverHealth,
  projectSessionObserverDigest,
  resolveChatPaneObserverRunId,
} from "./observer-digest.ts";

describe("projectSessionObserverDigest", () => {
  it("binds a session-row projection to its owning session", () => {
    expect(
      projectSessionObserverDigest("agent:main:projected", {
        runId: "run-1",
        revision: 2,
        updatedAt: 3,
        headline: "Projected",
        health: "on-track",
      }),
    ).toEqual({
      sessionKey: "agent:main:projected",
      runId: "run-1",
      revision: 2,
      updatedAt: 3,
      headline: "Projected",
      health: "on-track",
    });
  });
});

describe("isCriticalObserverHealth", () => {
  it("recognizes only health states that require operator attention", () => {
    expect(isCriticalObserverHealth("stuck")).toBe(true);
    expect(isCriticalObserverHealth("waiting-on-user")).toBe(true);
    expect(isCriticalObserverHealth("done")).toBe(false);
    expect(isCriticalObserverHealth("failed")).toBe(false);
  });
});

describe("resolveChatPaneObserverRunId", () => {
  it("uses the digest-owned identity when the active set is unavailable or ambiguous", () => {
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session: { hasActiveRun: true },
        digest: { runId: "digest-run" },
      }),
    ).toBe("digest-run");
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session: { hasActiveRun: true, activeRunIds: ["run-1", "run-2"] },
        digest: { runId: "digest-run" },
      }),
    ).toBe("digest-run");
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session: { hasActiveRun: true, activeRunIds: ["run-1", "run-2"] },
        digest: null,
      }),
    ).toBeNull();
  });

  it("prefers local and sole Gateway identities over a digest copy", () => {
    expect(
      resolveChatPaneObserverRunId({
        localRunId: "local-run",
        session: { hasActiveRun: true, activeRunIds: ["gateway-run"] },
        digest: { runId: "digest-run" },
      }),
    ).toBe("local-run");
    expect(
      resolveChatPaneObserverRunId({
        localRunId: null,
        session: { hasActiveRun: true, activeRunIds: ["gateway-run"] },
        digest: { runId: "digest-run" },
      }),
    ).toBe("gateway-run");
  });
});
