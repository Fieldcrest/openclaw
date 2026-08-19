// @vitest-environment node
import { describe, expect, it } from "vitest";
import { soleActiveSessionRunId } from "./session-active-run.ts";

describe("soleActiveSessionRunId", () => {
  it.each([
    { name: "omitted identities", row: {}, expected: undefined },
    { name: "an exact idle set", row: { activeRunIds: [] }, expected: undefined },
    {
      name: "overlapping active runs",
      row: { activeRunIds: ["run-first", "run-second"] },
      expected: undefined,
    },
    { name: "one exact active run", row: { activeRunIds: ["run-only"] }, expected: "run-only" },
  ])("returns only $name", ({ row, expected }) => {
    expect(soleActiveSessionRunId(row)).toBe(expected);
  });
});
