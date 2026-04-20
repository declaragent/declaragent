---
name: review
description: Review a GitHub pull request by skimming the diff and posting inline comments.
inputs:
  pullRequest:
    type: object
    description: GitHub `pull_request` webhook payload's `pull_request` object.
    required: true
  repository:
    type: object
    description: The `repository` object from the webhook payload.
    required: true
  action:
    type: string
    description: Either `opened` or `synchronize`.
    required: true
outputs:
  review:
    type: object
    description: The review body that was posted; `null` if the PR was skipped.
---

# Review skill

You got a GitHub webhook for a PR:

- Repo: `{{repository.full_name}}`
- Action: `{{action}}`
- Number: `{{pullRequest.number}}`
- Title: `{{pullRequest.title}}`
- Draft: `{{pullRequest.draft}}`
- Author type: `{{pullRequest.user.type}}`

## Skip early

- If `action != "opened" && action != "synchronize"`: return `null`.
- If `pullRequest.draft === true`: return `null`.
- If `pullRequest.user.type === "Bot"`: return `null`.

## Fetch diff

Call `GitHubFetchDiff` with `{ owner, repo, number }` from the inputs.
The tool returns a unified diff string; cap to 4000 lines before
feeding to the model.

## Review rubric

Skim the diff for:

1. **Correctness** — obvious bugs (null deref, off-by-one, swapped
   argument order, resource leaks).
2. **Error handling** — unhandled promise rejections, ignored
   non-zero exits, swallowed exceptions.
3. **Tests** — new exported function or CLI flag without a
   corresponding test?
4. **Docs** — public type / CLI flag renamed, README not updated?

For each issue, produce an inline comment pinned to the file + line.
Max 8 inline comments; aggregate extras into the top-level summary.

## Post the review

Call `GitHubReviewComment` with:

- `owner`, `repo`, `pull_number` (from inputs).
- `event`: `"REQUEST_CHANGES"` if any inline comment is severity
  `blocker`, else `"COMMENT"`.
- `body`: a top-level summary (≤ 250 words). Start with a one-line
  "what this PR does" sentence, then group findings by category.
- `comments`: the inline comments array.

NEVER call with `event: "APPROVE"`. A human merges.
