---
name: Authentication test tooling
description: A mismatch between documented testing tools and this environment's available subagent kinds.
---

Do not substitute mocked adapter checks for verified Clerk authentication or email delivery.

**Why:** On 2026-09-19 the documented `testing` subagent kind was rejected as unknown. The prescribed `signInClerkUser` helper is scoped to that browser test runtime, not standalone Playwright. Local Playwright worked for public pages and explicitly mocked UI contracts, but did not resolve the managed-login verification gap.

**How to apply:** Check current testing guidance and actual tool availability before planning managed-auth tests. If the runtime is still unavailable, report the limitation and do not invent a replacement for the mandated helper or label mock results as live authentication tests.