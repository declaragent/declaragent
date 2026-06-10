/**
 * WS4 — build the `transportFactories` map that `fleet run` hands to
 * `startFleetDaemon`, so a declared Kafka/NATS fleet actually instantiates its
 * brokers instead of warn-skipping every non-memory transport.
 *
 * The factory for each kind reads the `CapabilityTransport` config block
 * (brokers/servers/topics already validated by the capabilities loader) and
 * calls the matching transport constructor from `@declaragent/plugin-agent-rpc`.
 * The transport constructors are INJECTABLE so the config→args mapping is
 * unit-testable without a live broker; the real broker connection is exercised
 * by the integration soak (which needs a broker).
 *
 * Consumer-group / client-id derivation: each kind gets a stable per-process
 * id derived from the fleet name. A single fleet-run process runs one consumer
 * per transport kind subscribing to every declared topic, so one group id is
 * correct for the single-process case. Multi-replica HA (shared group →
 * partitioned delivery) is the WS6/day-2 replicas>1 concern, called out there.
 */

import type { RpcTransport, RpcTransportKind } from '@declaragent/core';
import {
  type CreateKafkaTransportOptions,
  type CreateNatsTransportOptions,
  createKafkaTransport,
  createNatsTransport,
} from '@declaragent/plugin-agent-rpc';
import type { FleetTransportFactory } from './fleet-run.js';

/** Injectable transport constructors (tests pass fakes; prod uses the real ones). */
export interface TransportConstructors {
  kafka?: (opts: CreateKafkaTransportOptions) => Promise<RpcTransport> | RpcTransport;
  nats?: (opts: CreateNatsTransportOptions) => Promise<RpcTransport> | RpcTransport;
}

export interface BuildTransportFactoriesOptions {
  /** Used to derive stable clientId/groupId for the broker connections. */
  fleetName: string;
  /** Constructor overrides (tests). Defaults to the real plugin constructors. */
  constructors?: TransportConstructors;
  /**
   * WS11 — resolver for SASL `passwordRef` (e.g. `secret://platform/kafka`).
   * Required when a kafka transport declares a `sasl` block; the resolved
   * password is handed to the transport and never logged or inlined.
   */
  resolveSecret?: (ref: string) => Promise<string>;
}

/**
 * WS11 — turn a kafka transport's declared `sasl` block into the resolved
 * credentials kafkajs needs. Returns undefined when no SASL is declared
 * (plaintext dev brokers). Throws when SASL is declared but no secret resolver
 * is available — a fleet must never connect to a SASL broker unauthenticated.
 */
interface KafkaSaslDecl {
  readonly mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  readonly username: string;
  readonly passwordRef: string;
}

async function resolveKafkaSasl(
  sasl: KafkaSaslDecl | undefined,
  resolveSecret: ((ref: string) => Promise<string>) | undefined,
): Promise<CreateKafkaTransportOptions['sasl']> {
  if (sasl === undefined) return undefined;
  if (resolveSecret === undefined) {
    throw new Error(
      'kafka transport declares a sasl block but no secret resolver was provided to buildTransportFactories',
    );
  }
  const password = await resolveSecret(sasl.passwordRef);
  return { mechanism: sasl.mechanism, username: sasl.username, password };
}

/**
 * Build the factory map for the broker kinds the CLI can construct (kafka,
 * nats). Kinds without a factory here still warn-skip in `startFleetDaemon`
 * with an actionable message — same as before, just now a much smaller set.
 */
export function buildTransportFactories(
  opts: BuildTransportFactoriesOptions,
): Partial<Record<RpcTransportKind, FleetTransportFactory>> {
  const kafka = opts.constructors?.kafka ?? createKafkaTransport;
  const nats = opts.constructors?.nats ?? createNatsTransport;
  const idBase = `declaragent-${opts.fleetName}`;

  return {
    kafka: async (config) => {
      if (config.kind !== 'kafka') {
        throw new Error(`kafka factory received non-kafka transport config: ${config.kind}`);
      }
      // WS11 — resolve SASL credentials when declared. The password ref is
      // pulled through the secrets resolver; an unresolvable/absent resolver is
      // a loud boot error rather than a silent unauthenticated connection.
      const sasl = await resolveKafkaSasl(config.sasl, opts.resolveSecret);
      return kafka({
        brokers: config.brokers,
        clientId: idBase,
        groupId: idBase,
        ...(config.ssl !== undefined && { ssl: config.ssl }),
        ...(sasl !== undefined && { sasl }),
      });
    },
    nats: (config) => {
      if (config.kind !== 'nats') {
        throw new Error(`nats factory received non-nats transport config: ${config.kind}`);
      }
      return nats({
        servers: config.servers,
        clientName: idBase,
      });
    },
  };
}

/** Exposed for tests / docs: the transport kinds the CLI can construct today. */
export const SUPPORTED_FACTORY_KINDS: readonly RpcTransportKind[] = ['kafka', 'nats'];
