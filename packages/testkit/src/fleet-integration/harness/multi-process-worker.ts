/**
 * Worker script for the multi-process Kafka soak harness.
 *
 * Spawned as a Bun subprocess by `multi-process.ts`. Each worker boots
 * a single-agent loop that:
 *   - connects to the shared Redpanda via `createKafkaTransport`;
 *   - subscribes to its requests topic;
 *   - handles each request with a deterministic mocked LLM handler
 *     (no Anthropic SDK — pure function of capability + payload);
 *   - publishes the response envelope back over the caller's `replyTo`
 *     (falling back to `<from>-responses` for loose harness usage).
 *
 * Config is passed via command-line arguments instead of a YAML fleet
 * manifest so the harness owns the topology end-to-end and the test
 * doesn't have to write temp files. The shape matches what
 * `startFleetDaemon` would observe at runtime, just without the loader:
 * each agent has exactly one request topic + one response topic, and
 * the handler runs the same `createRespondHook`-style reply the real
 * engine would.
 *
 * The worker prints one JSON status line per lifecycle transition to
 * stdout so the parent harness can detect readiness + request counts
 * without parsing free-form logs:
 *
 *     {"event":"ready","agentId":"alpha","pid":12345}
 *     {"event":"received","agentId":"alpha","correlationId":"c-1"}
 *     {"event":"responded","agentId":"alpha","correlationId":"c-1"}
 *
 * Non-fatal errors go to stderr as JSON too:
 *
 *     {"event":"error","agentId":"alpha","err":"..."}
 *
 * SIGTERM + SIGINT trigger a clean shutdown: unsubscribe, close the
 * transport, emit `{"event":"stopped"}`, exit 0.
 *
 * @since 0.6.1
 */

import type { AgentRpcEnvelope } from '@declaragent/core';
import { createKafkaTransport } from '@declaragent/plugin-agent-rpc';

interface WorkerConfig {
  agentId: string;
  brokers: readonly string[];
  requestTopic: string;
  responseTopic: string;
  clientId: string;
  groupId: string;
}

function parseArgs(argv: readonly string[]): WorkerConfig {
  const map = new Map<string, string>();
  for (const entry of argv) {
    const eq = entry.indexOf('=');
    if (eq <= 2) continue; // skip positional / bun / script
    if (!entry.startsWith('--')) continue;
    const key = entry.slice(2, eq);
    const value = entry.slice(eq + 1);
    map.set(key, value);
  }
  const brokers = map.get('brokers');
  const agentId = map.get('agent-id');
  const requestTopic = map.get('request-topic');
  const responseTopic = map.get('response-topic');
  const clientId = map.get('client-id');
  const groupId = map.get('group-id');
  if (
    brokers === undefined ||
    agentId === undefined ||
    requestTopic === undefined ||
    responseTopic === undefined ||
    clientId === undefined ||
    groupId === undefined
  ) {
    throw new Error(
      'multi-process-worker: missing required arg(s). Required: --agent-id --brokers --request-topic --response-topic --client-id --group-id',
    );
  }
  return {
    agentId,
    brokers: brokers.split(','),
    requestTopic,
    responseTopic,
    clientId,
    groupId,
  };
}

function emit(event: Record<string, unknown>): void {
  // Single-line JSON. The parent harness reads stdout by line.
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Deterministic mocked LLM handler. For the soak we want reproducible
 * responses — no randomness, no network. The reply echoes the payload
 * plus a per-agent marker + a monotonic local sequence so the caller
 * can assert ordering when needed.
 */
function makeMockHandler(agentId: string): (req: AgentRpcEnvelope) => {
  kind: 'response';
  payload: unknown;
} {
  let seq = 0;
  return (req) => {
    seq += 1;
    return {
      kind: 'response',
      payload: {
        ok: true,
        data: {
          echoed: req.payload,
          handledBy: `agent://${agentId}`,
          capability: req.capability,
          seq,
        },
      },
    };
  };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const transport = await createKafkaTransport({
    brokers: cfg.brokers,
    clientId: cfg.clientId,
    groupId: cfg.groupId,
  });
  const handle = makeMockHandler(cfg.agentId);

  const unsub = transport.subscribe(cfg.requestTopic, async (envelope) => {
    if (envelope.kind !== 'request') return;
    emit({ event: 'received', agentId: cfg.agentId, correlationId: envelope.correlationId });
    const result = handle(envelope);
    const replyTopic = envelope.replyTo
      ? envelope.replyTo.replace(/^kafka:\/\//, '')
      : cfg.responseTopic;
    const response: AgentRpcEnvelope = {
      version: 1,
      kind: 'response',
      messageId: `${cfg.agentId}-resp-${envelope.messageId}`,
      correlationId: envelope.correlationId,
      from: `agent://${cfg.agentId}`,
      to: envelope.from,
      capability: envelope.capability,
      payload: result.payload,
    };
    try {
      await transport.publish(replyTopic, response);
      emit({ event: 'responded', agentId: cfg.agentId, correlationId: envelope.correlationId });
    } catch (err) {
      emit({
        event: 'error',
        agentId: cfg.agentId,
        correlationId: envelope.correlationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      unsub();
      await transport.close();
    } catch (err) {
      emit({
        event: 'error',
        agentId: cfg.agentId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    emit({ event: 'stopped', agentId: cfg.agentId });
    // Explicit exit so any lingering kafkajs reconnect timers don't keep
    // the event loop alive.
    process.exit(0);
  }

  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());

  // Kafka consumer join is eventual — we report READY only after the
  // producer is connected. First message RTT will still include the
  // consumer rebalance window; the harness accounts for this with a
  // warm-up round trip before soak timing begins.
  emit({ event: 'ready', agentId: cfg.agentId, pid: process.pid });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  process.stderr.write(
    `${JSON.stringify({
      event: 'fatal',
      err: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
});
