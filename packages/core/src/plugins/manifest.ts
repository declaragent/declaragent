import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { type PluginManifest, PluginManifestError } from './types.js';

/**
 * Zod schema for `plugin.json`. Defaults are applied so the loader can
 * treat all contribution arrays as present, never `undefined`.
 */
const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const HTTPTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'mcpServers[].name must be alphanumeric/_/-'),
  transport: z.union([StdioTransportSchema, HTTPTransportSchema]),
  protocolVersion: z.string().min(1),
});

const ContributesSchema = z
  .object({
    tools: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    mcpServers: z.array(McpServerSchema).default([]),
    hooks: z.array(z.string()).default([]),
    commands: z.array(z.string()).default([]),
  })
  .default({ tools: [], skills: [], mcpServers: [], hooks: [], commands: [] });

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  permissions: z.array(z.string()).default([]),
  contributes: ContributesSchema,
});

/**
 * Validate a parsed manifest object. Throws `PluginManifestError` with
 * a flattened Zod error message on failure.
 */
export function parsePluginManifest(raw: unknown, pluginDir: string): PluginManifest {
  const result = PluginManifestSchema.safeParse(raw);
  if (!result.success) {
    const message = formatZodError(result.error);
    throw new PluginManifestError(pluginDir, `invalid plugin.json: ${message}`);
  }
  return result.data as PluginManifest;
}

/** Read + parse `<pluginDir>/plugin.json`. */
export async function loadPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PluginManifestError(pluginDir, 'no plugin.json found');
    }
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PluginManifestError(
      pluginDir,
      `plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsePluginManifest(json, pluginDir);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const pathStr = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${pathStr}: ${issue.message}`;
    })
    .join('; ');
}
