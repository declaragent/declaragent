# `WebhookAuthFailureSpike`

**Severity:** warning.

## Symptom
Webhook trigger `{{ triggerId }}` is rejecting > 0.5 auth failures/s
for 5 minutes. HMAC or bearer signatures don't match the configured
secret.

## Likely cause
1. Upstream partner rotated the shared secret out-of-band.
2. The partner is misconfigured (wrong secret in their webhook form).
3. Someone is probing the webhook endpoint — reconnaissance.

## Immediate mitigation
If the secret genuinely rotated, roll the stored value:

```bash
declaragent secrets rotate <triggerId-webhook-secret>
declaragent sources reload <triggerId>
```

If reconnaissance is suspected, block the source IP at the ingress
layer. Do NOT weaken the HMAC check.

## Root-cause investigation
```bash
# Auth failure samples with request metadata:
declaragent audit query --kind webhook --outcome auth_failure --since -15m --json
```

Correlate `remoteAddr` — a single IP hammering with varying payloads
is a probe; many IPs with the same payload is a partner config issue.

## Post-incident
- Capture: peak failure rate, source IP distribution, mitigation.
- Close when: auth failures < 0.01/s for 30 minutes.
- If reconnaissance was confirmed, escalate to security.
