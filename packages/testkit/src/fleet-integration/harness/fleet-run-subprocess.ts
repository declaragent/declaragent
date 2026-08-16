/**
 * Subprocess entry for the multi-process Kafka soak harness.
 *
 * Spec: `docs/POST_ENTERPRISE_BACKLOG.md` §1 Item #26 —
 * > Kafka soak harness: literal `declaragent fleet run` subprocess spawn
 * > (today worker replicates broker loop).
 *
 * Before this script existed, `multi-process-worker.ts` ran an inline
 * subscribe→publish loop. That proved the transport worked but skipped
 * every layer between `startFleetDaemon` and the broker: fleet manifest
 * parsing, capabilities.yaml validation, per-agent worker bootstrap,
 * runtime initialization. This script closes that gap by spawning a
 * real fleet-run-shaped subprocess that:
 *
 *   1. Loads the fleet manifest via `@declaragent/core`'s `loadFleet`.
 *   2. Instantiates `createKafkaTransport` from `@declaragent/plugin-agent-rpc`.
 *   3. Iterates the agent capabilities table the same way `startAgentWorker`
 *      does — subscribing on the declared requests topic for every agent.
 *   4. On each request, invokes `createRespondHook` with the KAFKA transport
 *      (not memory) so the response round-trips back through the broker.
 *
 * ## Why not use `startFleetDaemon` directly?
 *
 * `packages/cli/src/fleet-run.ts` hard-wires the respond path to the memory
 * transport (see `startAgentWorker` comment: "for the memory case today we
 * reuse the shared memory transport; future per-agent factories could
 * supply a dedicated instance"). A true cross-process Kafka round trip can't
 * use memory as the response channel. Until that limitation is fixed, this
 * subprocess replicates the relevant slice of `startAgentWorker`'s subscribe
 * logic against the kafka transport directly — still on top of the real
 * manifest loader + capabilities parser.
 *
 * ## Handler
 *
 * The per-request handler is a deterministic echo — identical shape to
 * `packages/cli/src/fleet-run.ts`'s exported `defaultHandler`. The soak
 * measures transport behaviour, not LLM output; a real provider would
 * fight the 24h budget.
 *
 * ## Status events
 *
 * Matches `multi-process-worker.ts` so the parent harness parser in
 * `multi-process.ts` works unchanged:
 *
 *     {"event":"ready","agentId":"alpha","pid":12345}
 *     {"event":"received","agentId":"alpha","correlationId":"c-1"}
 *     {"event":"responded","agentId":"alpha","correlationId":"c-1"}
 *     {"event":"stopped","agentId":"alpha"}
 *     {"event":"error","agentId":"alpha","err":"..."}
 *
 * Fatal errors exit with code 1 and emit `{event:"fatal",err}` on stderr.
 *
 * @since 0.7.1 — post-enterprise backlog item #26
 */

import type { AgentRpcEnvelope, RpcTransport } from '@declaragent/core';
import { loadFleet } from '@declaragent/core';
import { createKafkaTransport, createRespondHook } from '@declaragent/plugin-agent-rpc';
import { resolveKafkaJsModule } from './kafkajs-resolver.js';

interface SubprocessConfig {
  fleetRoot: string;
  brokers: readonly string[];
  agentId: string;
  clientId: string;
  groupId: string;
}

function parseArgs(argv: readonly string[]): SubprocessConfig {
  const map = new Map<string, string>();
  for (const entry of argv) {
    if (!entry.startsWith('--')) continue;
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    map.set(entry.slice(2, eq), entry.slice(eq + 1));
  }
  const fleetRoot = map.get('fleet-root');
  const brokers = map.get('brokers');
  const agentId = map.get('agent-id');
  const clientId = map.get('client-id');
  const groupId = map.get('group-id');
  if (!fleetRoot || !brokers || !agentId || !clientId || !groupId) {
    throw new Error(
      'fleet-run-subprocess: required args: --fleet-root --brokers --agent-id --client-id --group-id',
    );
  }
  return {
    fleetRoot,
    brokers: brokers.split(','),
    agentId,
    clientId,
    groupId,
  };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Extract the requests topic for the given kafka transport block. Matches
 * `requestsTopicFor` in `fleet-run.ts` — kept local so this script stays
 * CLI-package-independent at runtime (we import types, not the function).
 */
function kafkaRequestsTopic(
  transports: ReadonlyArray<{ kind: string; topics?: { requests?: string } }>,
): string | undefined {
  for (const t of transports) {
    if (t.kind === 'kafka' && t.topics?.requests) return t.topics.requests;
  }
  return undefined;
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));

  // Real manifest parse. Fails loud if fleet.yaml / capabilities.yaml is
  // malformed — same fast-fail behaviour `declaragent fleet run` gives.
  const fleet = await loadFleet({ root: cfg.fleetRoot });
  const agent = fleet.agents.find((a) => a.id === cfg.agentId);
  if (agent === undefined) {
    throw new Error(
      `fleet-run-subprocess: agent "${cfg.agentId}" not declared in fleet.yaml (have: ${fleet.agents
        .map((a) => a.id)
        .join(', ')})`,
    );
  }
  if (!agent.capabilities) {
    throw new Error(
      `fleet-run-subprocess: agent "${cfg.agentId}" has no capabilities.yaml — this soak only exercises kafka-configured agents`,
    );
  }
  const requestTopic = kafkaRequestsTopic(agent.capabilities.config.transports);
  if (requestTopic === undefined) {
    throw new Error(
      `fleet-run-subprocess: agent "${cfg.agentId}" has no \`kind: kafka\` transport block with topics.requests set`,
    );
  }

  const transport: RpcTransport = await createKafkaTransport({
    brokers: cfg.brokers,
    clientId: cfg.clientId,
    groupId: cfg.groupId,
    // Resolve kafkajs from testkit's own deps — the spawned subprocess can't
    // rely on plugin-agent-rpc's bare `import('kafkajs')` resolving.
    kafkajsModule: resolveKafkaJsModule(),
  });

  const selfAddress: `agent://${string}` = `agent://${cfg.agentId}`;
  let seq = 0;

  const unsub = transport.subscribe(requestTopic, async (envelope: AgentRpcEnvelope) => {
    if (envelope.kind !== 'request') return;
    emit({ event: 'received', agentId: cfg.agentId, correlationId: envelope.correlationId });
    seq += 1;

    // createRespondHook handles replyTo routing + envelope shape. Passing
    // the kafka transport here is the critical difference vs. the fleet-
    // run.ts path — the respond hop actually crosses the broker.
    const respond = createRespondHook({
      request: envelope,
      transport,
      selfAgent: selfAddress,
    });

    try {
      await respond({
        ok: true,
        data: {
          agent: cfg.agentId,
          capability: envelope.capability,
          echoed: envelope.payload,
          seq,
        },
      });
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
    process.exit(0);
  }

  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());

  emit({ event: 'ready', agentId: cfg.agentId, pid: process.pid });
}

main().catch((err) => {
  process.stderr.write(
    `${JSON.stringify({
      event: 'fatal',
      err: err instanceof Error ? err.message : String(err),
    })}\n`,
  );
  process.exit(1);
});
