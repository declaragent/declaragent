# `WhatsAppConversationWindowExpirySurge`

**Severity:** warning.

## Symptom
WhatsApp conversation windows on `{{ id }}` are expiring at > 0.01/s
sustained for 15 minutes.

## Likely cause
1. User engagement dropped — agents went silent past the 24h service window.
2. Agent is holding conversations open without a template-initiated re-open.
3. The adapter's window tracker drifted vs platform state.

## Immediate mitigation
If the tracker has drifted, resync:

```bash
declaragent channels whatsapp resync-windows --id <id>
```

Otherwise no action — the expiry is a signal about engagement, not a
malfunction.

## Root-cause investigation
Grafana: `WhatsApp Windows` dashboard → `Expired windows` + `Active
windows` panels. Compare against inbound message rate per conversation.

## Post-incident
- Capture: expired count, average conversation idle time, any followup campaigns required.
- Close when: expiry rate < 0.001/s for 30 minutes.
