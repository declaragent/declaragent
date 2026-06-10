/**
 * `capabilities.yaml` loader — declares the capabilities an agent exposes
 * over RPC, the transports it listens on, and the input/output schemas
 * per capability.
 *
 * Lives as a local git-tracked file alongside `agent.yaml`. Central
 * aggregation is a future v1.2 concern — here we only parse the shape.
 *
 * @since 1.1.0
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  CapabilitySchemaCompileError,
  compileCapabilityValidator,
} from './capability-validator.js';

export class CapabilitiesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilitiesConfigError';
  }
}

const kafkaTransportSchema = z
  .object({
    kind: z.literal('kafka'),
    brokers: z.array(z.string().min(1)).min(1),
    topics: z
      .object({
        requests: z.string().min(1),
        responses: z.string().min(1).optional(),
      })
      .strict(),
    // WS11 — TLS + SASL for production brokers. The password is a resolver ref
    // (e.g. `secret://platform/kafka`), never inlined; resolved at factory time.
    ssl: z.boolean().optional(),
    sasl: z
      .object({
        mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']),
        username: z.string().min(1),
        passwordRef: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const natsTransportSchema = z
  .object({
    kind: z.literal('nats'),
    servers: z.array(z.string().min(1)).min(1),
    subjects: z
      .object({
        requests: z.string().min(1),
        responses: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const sqsTransportSchema = z
  .object({
    kind: z.literal('sqs'),
    region: z.string().min(1),
    queues: z
      .object({
        requests: z.string().min(1),
        responses: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const amqpTransportSchema = z
  .object({
    kind: z.literal('amqp'),
    url: z.string().min(1),
    queues: z
      .object({
        requests: z.string().min(1),
        responses: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const mqttTransportSchema = z
  .object({
    kind: z.literal('mqtt'),
    url: z.string().min(1),
    topics: z
      .object({
        requests: z.string().min(1),
        responses: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const memoryTransportSchema = z
  .object({
    kind: z.literal('memory'),
    topics: z
      .object({
        requests: z.string().min(1),
        responses: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

const transportSchema = z.discriminatedUnion('kind', [
  kafkaTransportSchema,
  natsTransportSchema,
  sqsTransportSchema,
  amqpTransportSchema,
  mqttTransportSchema,
  memoryTransportSchema,
]);

const capabilitySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'capability name must be URL-safe'),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    idempotent: z.boolean().optional(),
    since: z.string().optional(),
    /** Skill to dispatch to. Defaults to `name`. */
    skill: z.string().min(1).optional(),
  })
  .strict();

export const capabilitiesConfigSchema = z
  .object({
    version: z.literal(1),
    agent: z.string().regex(/^agent:\/\/.+/, 'agent must be `agent://<id>`'),
    transports: z.array(transportSchema).min(1),
    capabilities: z.array(capabilitySchema).min(1),
  })
  .strict();

export type CapabilitiesConfig = z.infer<typeof capabilitiesConfigSchema>;
export type CapabilityTransport = z.infer<typeof transportSchema>;
export type CapabilityDefinition = z.infer<typeof capabilitySchema>;

export interface LoadedCapabilities {
  readonly config: CapabilitiesConfig;
  readonly byName: ReadonlyMap<string, CapabilityDefinition>;
  /** Source path if loaded from a file, else undefined. */
  readonly sourcePath?: string;
}

export interface ParseCapabilitiesConfigOptions {
  /**
   * When `true` (default), compile each declared `inputSchema`/`outputSchema`
   * via {@link compileCapabilityValidator} at load-time so malformed schemas
   * surface before the agent starts serving traffic. Capabilities with
   * neither schema declared are treated as legacy "loose JSON" and skipped
   * (back-compat for fleets that predate the v1.1 typed-capability work).
   *
   * @since 1.2.0 — Enterprise Production Plan §3 Item #11
   */
  validateSchemas?: boolean;
}

export function parseCapabilitiesConfig(
  raw: unknown,
  options: ParseCapabilitiesConfigOptions = {},
): LoadedCapabilities {
  const result = capabilitiesConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new CapabilitiesConfigError(formatZodError(result.error));
  }
  const config = result.data;
  const byName = new Map(config.capabilities.map((c) => [c.name, c]));
  if (byName.size !== config.capabilities.length) {
    throw new CapabilitiesConfigError('duplicate capability name');
  }
  if (options.validateSchemas !== false) {
    for (const cap of config.capabilities) {
      if (cap.inputSchema !== undefined) {
        try {
          compileCapabilityValidator({
            capabilityName: cap.name,
            side: 'request',
            schema: cap.inputSchema,
          });
        } catch (err) {
          if (err instanceof CapabilitySchemaCompileError) {
            throw new CapabilitiesConfigError(
              `capability "${cap.name}" inputSchema: ${err.message}`,
            );
          }
          throw err;
        }
      }
      if (cap.outputSchema !== undefined) {
        try {
          compileCapabilityValidator({
            capabilityName: cap.name,
            side: 'response',
            schema: cap.outputSchema,
          });
        } catch (err) {
          if (err instanceof CapabilitySchemaCompileError) {
            throw new CapabilitiesConfigError(
              `capability "${cap.name}" outputSchema: ${err.message}`,
            );
          }
          throw err;
        }
      }
    }
  }
  return { config, byName };
}

export async function loadCapabilitiesConfig(
  path: string,
  options: ParseCapabilitiesConfigOptions = {},
): Promise<LoadedCapabilities> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CapabilitiesConfigError(`no capabilities config at ${path}`);
    }
    throw err;
  }
  const parsed = parseFileContent(path, raw);
  const loaded = parseCapabilitiesConfig(parsed, options);
  return { ...loaded, sourcePath: path };
}

function parseFileContent(filePath: string, raw: string): unknown {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new CapabilitiesConfigError(
        `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Default to YAML (covers .yaml, .yml, and no extension).
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new CapabilitiesConfigError(
      `invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
