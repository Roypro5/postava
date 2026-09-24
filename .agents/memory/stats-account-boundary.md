---
name: Account-bound session aggregates
description: Preventing cross-account attribution when authentication changes during a timer or retry.
---
Bind a private focus block to the account present when the timer begins, and keep that binding through completion and retries. A guest block must remain a guest block even if someone signs in midway.

**Why:** Looking up the active account only at completion can attribute one person's posture aggregates to another person after an account switch in another tab. Checking the account just before an upload still leaves a race before the request reaches the server.

**How to apply:** Scope pending queues to the original account and have the authenticated server compare the block's expected owner with the verified session identity before accepting a write. Never let client-provided identity replace server authentication.