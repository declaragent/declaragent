# `WhatsAppTemplateRejectSpike`

**Severity:** critical.

## Symptom
> 5% of template sends on WhatsApp channel `{{ id }}` are returning
`rejected` or `error` over a 5-minute window.

## Likely cause
1. Template not approved or recently un-approved by Meta.
2. Parameter count / type mismatch vs the approved template.
3. Recipient has opted out and the message was rejected at the platform layer.

## Immediate mitigation
Pause the outbound template campaign until the rejection cause is clear:

```bash
declaragent channels pause <id>
```

Sustained rejections put the business account's tier health at risk.

## Root-cause investigation
```bash
# Recent rejected outbound with error body:
declaragent channels audit query --id <id> --kind outbound --outcome rejected --since -15m --json

# Cross-reference in Meta Business Manager → Message Templates.
```

## Post-incident
- Capture: template name, rejection reason, audience slice, tier impact.
- Close when: reject rate < 1% for 15 minutes AND Meta reports tier health unchanged.
- If Meta auto-demoted the tier, file a reinstatement request citing the incident timeline.
