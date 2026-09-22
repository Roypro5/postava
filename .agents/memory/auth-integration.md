---
name: Authentication integration boundary
description: Why authentication is isolated from the guest Pomodoro and how to interpret local preview checks.
---
Keep provider-managed authentication isolated from the existing vanilla Pomodoro rather than migrating the timer and camera interface to React.

**Why:** Real accounts need the supported Clerk integration, but the user's existing Pomodoro must remain usable without an account and retain its current behavior.

**How to apply:** Extend the authentication boundary for account features; do not make the timer or camera depend on a signed-in session.

Validate Clerk redirect behavior on the actual Replit development domain, not solely through localhost screenshots.

**Why:** A persistent localhost screenshot context produced a session-refresh loop warning while fresh and repeated navigation on the real development domain completed normally.

**How to apply:** Investigate warnings with real-domain browser navigation before concluding that the managed keys are mismatched. Never change keys solely on the basis of this local screenshot warning.

The project owner confirmed the full development flow with a real account and accessible email on September 22, 2026: verification email, recovery email, remember/no-remember reopening, sign-out, and revoked access all behaved as intended.

**Why:** Automated UI tests cannot prove email delivery or browser reopening behavior; this confirmation closes the development-only evidence gap.

**How to apply:** Treat development authentication as verified, but repeat the same matrix in the isolated Production Clerk environment before launch.