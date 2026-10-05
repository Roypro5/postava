// A focus block belongs to the account present when it starts, never to the
// account that happens to be active when it completes or uploads.
export function bindFocusAccount(focusStats, accountId) {
  if (!focusStats.startedAt) focusStats.accountId = accountId ?? null;
}

// Classifies a failed POST /api/stats/sessions by HTTP status so the retry
// queue knows whether to keep an entry (network/5xx/401, transient) or drop
// it (400/409, the request itself will never succeed). 422 is the daily
// limit: also dropped, but "reject" tells the queue to tell the user (that
// session is lost). 429 (rate limit) stays "retry".
export function classifyStatsSendError(status) {
  if (status === 422) return "reject";
  if (status === 400 || status === 409) return "discard";
  return "retry";
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