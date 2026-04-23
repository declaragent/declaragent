<!--
Thanks for the PR. Fill the sections below; delete whatever doesn't apply.
For enterprise-program work, link to the matching §3 item in
docs/ENTERPRISE_PRODUCTION_PLAN.md.
-->

## Summary

<!-- 1-3 sentences. The WHY before the WHAT. -->

## Test plan

- [ ] `bun run typecheck`
- [ ] `bun test`
- [ ] `bun run build`
- [ ] `bun run lint`

## Builder regression fixtures

The conversational builder (`packages/cli/src/builder/`) has a
recorded-conversation regression suite at
`packages/cli/src/builder/__tests__/fixture-replay.test.ts`. Five JSONL
fixtures in `packages/cli/src/builder/fixtures/` pin the expected
propose → apply step-kind sequence for the canonical flows.

**Tick one of the boxes below** if this PR touches any of:

- The builder system prompt (`getBuilderSystemPrompt`, builder tool
  descriptions, or anything that changes how the model is asked to
  shape `DeclaraProposeChange` / `DeclaraApplyChange` calls).
- The `DeclaraProposeChange` or `DeclaraApplyChange` input schemas.
- The `proposalStepKindSchema` enum or step dispatcher in
  `packages/cli/src/builder/apply-change.ts`.

- [ ] N/A — this PR does not touch the builder prompt or proposal/apply schemas.
- [ ] I re-authored / re-recorded the relevant fixture(s) under
      `packages/cli/src/builder/fixtures/` so
      `fixture-replay.test.ts` still pins the expected step kinds. See
      `docs/ENTERPRISE_PRODUCTION_PLAN.md` §3 Item #12 for the fixture
      format and the optional `BUILDER_RECORD=1 declaragent` capture
      path.

## Links

<!-- Issue, RFC, or enterprise-plan item number. -->
