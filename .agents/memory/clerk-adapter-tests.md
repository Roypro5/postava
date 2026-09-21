---
name: Clerk adapter tests
description: Avoid importing the browser authentication SDK during pure Node adapter tests.
---

Keep the Clerk browser SDK behind a lazy import and inject a provider double for unit tests.

**Why:** Eagerly importing Clerk JS in Node caused the test process to remain alive after every assertion passed, until the command timed out. Browser-only initialization should not affect pure adapter tests.

**How to apply:** When extending adapter tests, avoid eager browser SDK imports. Use live browser verification separately; mocked adapter tests are not evidence of actual email delivery or successful provider authentication.