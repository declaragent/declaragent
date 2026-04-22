/**
 * `rpc-peers.yaml` loader — a git-tracked peer table that maps logical
 * `agent://<id>` addresses to concrete transport + topic pairs. Used by
 * the producer-side `RequestAgent` tool to resolve peer addresses at
 * publish time.
 *
 * @since 1.1.0
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { BrokerAddress } from './envelope.js';

export class PeersConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeersConfigError';
  }
}

const kafkaPeerTransport = z
  .object({
    kind: z.literal('kafka'),
    brokers: z.array(z.string().min(1)).min(1),
    topics: z
      .object({
        requests: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const natsPeerTransport = z
  .object({
    kind: z.literal('nats'),
    servers: z.array(z.string().min(1)).min(1),
    subjects: z
      .object({
        requests: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const sqsPeerTransport = z
  .object({
    kind: z.literal('sqs'),
    region: z.string().min(1),
    queues: z
      .object({
        requests: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const amqpPeerTransport = z
  .object({
    kind: z.literal('amqp'),
    url: z.string().min(1),
    queues: z
      .object({
        requests: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const mqttPeerTransport = z
  .object({
    kind: z.literal('mqtt'),
    url: z.string().min(1),
    topics: z
      .object({
        requests: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const memoryPeerTransport = z
  .object({
    kind: z.literal('memory'),
    topics: z
      .object({
        requests: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const peerTransportSchema = z.discriminatedUnion('kind', [
  kafkaPeerTransport,
  natsPeerTransport,
  sqsPeerTransport,
  amqpPeerTransport,
  mqttPeerTransport,
  memoryPeerTransport,
]);

/**
 * Per-peer authentication config. Optional — absent = legacy
 * `internal`/`hmac` envelope auth. When present, incoming envelopes
 * from this peer MUST carry a matching {@link RpcAuth.kind} and pass
 * provider-side verify. See `@declaragent/plugin-agent-rpc/auth/*`
 * for the provider implementations.
 *
 * @since 1.2.0
 */
const oidcPeerAuthSchema = z
  .object({
    provider: z.literal('oidc'),
    issuer: z.string().min(1),
    audience: z.string().min(1),
    jwksUri: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

const oauth2ClientPeerAuthSchema = z
  .object({
    provider: z.literal('oauth2-client'),
    tokenEndpoint: z.string().min(1),
    clientId: z.string().min(1),
    /**
     * Resolver reference (e.g. `secret://platform/client-secret`). The
     * secret is pulled through the Phase-6 secret-resolver pipeline at
     * runtime, never inlined into the config.
     */
    clientSecretRef: z.string().min(1),
    jwksUri: z.string().min(1).optional(),
    issuer: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const peerAuthSchema = z.discriminatedUnion('provider', [
  oidcPeerAuthSchema,
  oauth2ClientPeerAuthSchema,
]);

export type PeerAuthConfig = z.infer<typeof peerAuthSchema>;

const peerEntrySchema = z
  .object({
    agent: z.string().regex(/^agent:\/\/.+/, 'agent must be `agent://<id>`'),
    transports: z.array(peerTransportSchema).min(1),
    auth: peerAuthSchema.optional(),
  })
  .strict();

export const peersConfigSchema = z
  .object({
    version: z.literal(1),
    peers: z.array(peerEntrySchema),
  })
  .strict();

export type PeersConfig = z.infer<typeof peersConfigSchema>;
export type PeerEntry = z.infer<typeof peerEntrySchema>;
export type PeerTransport = z.infer<typeof peerTransportSchema>;

export interface LoadedPeers {
  readonly config: PeersConfig;
  readonly byAgent: ReadonlyMap<string, PeerEntry>;
  readonly sourcePath?: string;
}

export function parsePeersConfig(raw: unknown): LoadedPeers {
  const result = peersConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new PeersConfigError(formatZodError(result.error));
  }
  const config = result.data;
  const byAgent = new Map<string, PeerEntry>();
  for (const peer of config.peers) {
    if (byAgent.has(peer.agent)) {
      throw new PeersConfigError(`duplicate peer entry for ${peer.agent}`);
    }
    byAgent.set(peer.agent, peer);
  }
  return { config, byAgent };
}

export async function loadPeersConfig(path: string): Promise<LoadedPeers> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PeersConfigError(`no peers config at ${path}`);
    }
    throw err;
  }
  const parsed = parseFileContent(path, raw);
  const loaded = parsePeersConfig(parsed);
  return { ...loaded, sourcePath: path };
}

/**
 * Resolve an `agent://` URL into a concrete `BrokerAddress` + transport
 * kind. Returns the first transport in the peer entry — callers that
 * care about transport preference (e.g. "use Kafka if available") can
 * iterate the peer's transports themselves.
 */
export function resolvePeerTransport(
  peers: LoadedPeers,
  agent: string,
): { transport: PeerTransport; address: BrokerAddress } | undefined {
  const entry = peers.byAgent.get(agent);
  if (!entry) return undefined;
  const transport = entry.transports[0];
  if (!transport) return undefined;
  return { transport, address: peerTransportToAddress(transport) };
}

function peerTransportToAddress(t: PeerTransport): BrokerAddress {
  switch (t.kind) {
    case 'kafka':
      return `kafka://${t.topics.requests}`;
    case 'nats':
      return `nats://${t.subjects.requests}`;
    case 'sqs':
      return `sqs://${t.queues.requests}`;
    case 'amqp':
      return `amqp://${t.queues.requests}`;
    case 'mqtt':
      return `mqtt://${t.topics.requests}`;
    case 'memory':
      return `memory://${t.topics.requests}`;
  }
}

function parseFileContent(filePath: string, raw: string): unknown {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new PeersConfigError(
        `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new PeersConfigError(
      `invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
