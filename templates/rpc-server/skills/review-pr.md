---
name: review-pr
description: Review a GitHub pull request on demand; respond with structured findings.
inputs:
  payload:
    type: object
    description: The caller's request payload. Shape mirrors `capabilities.yaml` → `review-pr.inputSchema`.
    required: true
outputs:
  review:
    type: object
    description: See `capabilities.yaml` → `review-pr.outputSchema`.
---

# review-pr

A caller (e.g. `agent://concierge`) invoked your `review-pr` capability
with the following payload:

```json
{{payload}}
```

## Step 1 — Validate

- If `payload.prUrl` is missing: call `ctx.respond({ ok: false, error:
  { code: "EINVAL", message: "prUrl is required" }})` and end the turn.
- If `payload.prUrl` is not a github.com URL: same error with code
  `EINVAL_SCOPE`.

## Step 2 — Fetch the diff

Until `@declaragent/plugin-github` ships, return a stub response:

```json
{
  "verdict": "comment",
  "findings": [],
  "summary": "Reviewer stub; install @declaragent/plugin-github to enable diff fetching."
}
```

Once the plugin is available, call `GitHubFetchDiff({ prUrl })` and
proceed.

## Step 3 — Skim

Look for (in priority order):

1. **Correctness**: null deref, off-by-one, swapped argument order.
2. **Error handling**: unhandled promise rejections, ignored non-zero
   exits, swallowed exceptions.
3. **Tests**: new exported function without a test?
4. **Docs**: public API rename without README update?

For each issue emit `{ file, line, severity, message }`. Cap at 8
entries; aggregate extras into `summary`.

## Step 4 — Respond

Emit the final response explicitly:

```js
ctx.respond({
  ok: true,
  data: {
    verdict: /* "approve" | "request-changes" | "comment" */,
    findings: [ /* … */ ],
    summary: /* ≤ 250 words */,
  },
});
```

If you skip `ctx.respond`, the runtime's default hook posts your
assistant.final text as `{ ok: true, data: <text> }` — good for quick
iterations, but the caller usually wants structured data.

NEVER emit `verdict: "approve"`. The caller decides.
