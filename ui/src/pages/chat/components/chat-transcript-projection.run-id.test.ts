/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import * as chatThread from "../chat-thread.ts";
import { resetThreadPresentation, type ChatThreadProps } from "./chat-thread-interactions.ts";
import type { ChatTranscriptSession } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";

function transcript(): ChatTranscriptSession {
  return {
    liveAnnouncementText: "",
    render: () => html``,
    syncMessageRows: () => undefined,
    revealMessage: () => false,
    setContentReady: () => undefined,
    handleFocusIn: () => undefined,
    handleFocusOut: () => undefined,
  };
}

function props(activeRunIds: string[], runId?: string): ChatThreadProps {
  const sessions = createSessionsListResult();
  const session = sessions.sessions[0];
  if (!session) {
    throw new Error("expected main session fixture");
  }
  session.hasActiveRun = true;
  session.activeRunIds = activeRunIds;
  return {
    paneId: `projection-${activeRunIds.join("-")}-${runId ?? "none"}`,
    sessionKey: "main",
    loading: false,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    ...(runId === undefined ? {} : { runId }),
    queue: [],
    showThinking: false,
    showToolCalls: true,
    sessions,
    assistantName: "Val",
    assistantAvatar: null,
    onDraftChange: () => undefined,
    onSend: () => undefined,
  };
}

afterEach(() => {
  resetThreadPresentation();
  vi.restoreAllMocks();
});

describe("chat transcript run identity", () => {
  it("leaves ambiguous Gateway sets to the session-and-leaf cache identity", () => {
    const buildItems = vi.spyOn(chatThread, "buildCachedChatItems");

    projectChatTranscript(props(["run-first", "run-second"]), transcript());

    expect(buildItems).toHaveBeenCalledWith(expect.objectContaining({ runId: null }));
  });

  it("keeps the host-owned chat run identity when provided", () => {
    const buildItems = vi.spyOn(chatThread, "buildCachedChatItems");

    projectChatTranscript(props(["run-first", "run-second"], "host-run"), transcript());

    expect(buildItems).toHaveBeenCalledWith(expect.objectContaining({ runId: "host-run" }));
  });
});
