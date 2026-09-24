// A focus block belongs to the account present when it starts, never to the
// account that happens to be active when it completes or uploads.
export function bindFocusAccount(focusStats, accountId) {
  if (!focusStats.startedAt) focusStats.accountId = accountId ?? null;
}

export function completedFocusPayload(focusStats, id) {
  if (!focusStats.accountId) return null;
  return {
    id,
    expectedUserId: focusStats.accountId,
    type: "focus",
    completed: true,
    startedAt: focusStats.startedAt,
    durationMinutes: Math.min(180, Math.max(1, Math.ceil(focusStats.elapsedMs / 60_000))),
    goodMs: Math.round(focusStats.goodMs),
    badMs: Math.round(focusStats.badMs),
    alerts: focusStats.alerts,
    issues: { ...focusStats.issues },
    issuesUnit: "count",
  };
}