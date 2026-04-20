# `DaemonHeartbeatTimeout`

**Severity:** critical.

## Symptom
Daemon heartbeat is stale by more than 60 seconds. Either the process
is hung / paused or the metrics pipeline dropped.

## Likely cause
1. Process deadlocked on an I/O await (channel send, secret resolve).
2. Debugger attached and paused on a breakpoint.
3. OTel collector / Prometheus endpoint is unreachable and `push` pipelines are backing up.

## Immediate mitigation
Verify the process is actually running:

```bash
declaragent daemon status
# If unresponsive:
declaragent daemon restart
```

## Root-cause investigation
Check host-level signals first — CPU / memory pressure, disk full,
network partition. If the host is healthy, the daemon is internally
hung; take a stack dump before restarting if possible.

```bash
# Bun stack dump (where supported):
kill -USR1 $(pgrep -f 'declaragent daemon')
```

## Post-incident
- Capture: stack dump, host signals, restart timeline.
- Close when: heartbeat < 30s for 10 minutes post-restart.
- Post-mortem: mandatory for any non-restart-fixed incident.
