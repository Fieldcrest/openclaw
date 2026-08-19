type SessionActiveRunProjection = {
  activeRunIds?: readonly string[];
};

/** Selects a run only when the Gateway projected one complete, unambiguous identity. */
export function soleActiveSessionRunId(
  row: SessionActiveRunProjection | null | undefined,
): string | undefined {
  return row?.activeRunIds?.length === 1 ? row.activeRunIds[0] : undefined;
}
