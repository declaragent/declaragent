import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  WhatsAppClient,
  WhatsAppCreateTemplateParams,
  WhatsAppTemplate,
  WhatsAppTemplateComponent,
  WhatsAppTemplateStatus,
} from '@declaragent/channel-whatsapp';
import { createWhatsAppClient } from '@declaragent/channel-whatsapp';
import { ChannelsConfigError, type ConfiguredChannel, loadChannelsConfig } from '@declaragent/core';
import { channelsConfigPath, whatsappTemplatesCachePath } from './paths.js';

/**
 * `declaragent channel whatsapp templates …` subcommand.
 *
 * Manages the approved-template registry against Meta's Graph API and
 * caches the current state to disk so the runtime adapter can validate
 * outbound template sends without a round-trip per message.
 *
 * Cache file format (at `~/.declaragent/whatsapp-templates/<channel-id>.json`):
 *
 * ```json
 * {
 *   "version": 1,
 *   "channelId": "whatsapp-cloud",
 *   "syncedAt": "2026-04-17T14:00:00.000Z",
 *   "templates": [ {"name": "...", "status": "APPROVED", ...} ]
 * }
 * ```
 */

// ── IO seam ──────────────────────────────────────────────────────────────

export interface WhatsAppTemplatesIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: WhatsAppTemplatesIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// ── Cache file ───────────────────────────────────────────────────────────

export const TEMPLATE_CACHE_VERSION = 1;

export interface WhatsAppTemplateCacheFile {
  version: number;
  channelId: string;
  syncedAt: string;
  templates: WhatsAppTemplate[];
}

export function readTemplateCache(path: string): WhatsAppTemplateCacheFile | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as WhatsAppTemplateCacheFile;
    if (parsed.version !== TEMPLATE_CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeTemplateCache(path: string, file: WhatsAppTemplateCacheFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
}

// ── Shared deps ──────────────────────────────────────────────────────────

export interface WhatsAppTemplatesCliDeps {
  io?: WhatsAppTemplatesIO;
  /** Override the channels config path. */
  configPath?: string;
  /** Override the template cache directory (tests). */
  cacheDir?: string;
  /** Test seam: pre-built WhatsApp client. Skips factory + config loading. */
  client?: WhatsAppClient;
  /** Clock injection (ms-epoch). */
  now?: () => number;
  /** Injected fetch for production client factory. */
  fetchImpl?: typeof fetch;
  /** Override the `process.env` that secret references resolve against. */
  env?: Record<string, string | undefined>;
}

interface ResolvedChannel {
  channelId: string;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  baseUrl: string | undefined;
}

async function resolveWhatsAppChannel(
  targetId: string | undefined,
  deps: WhatsAppTemplatesCliDeps,
): Promise<ResolvedChannel> {
  const configPath = deps.configPath ?? channelsConfigPath();
  if (!existsSync(configPath)) {
    throw new WhatsAppTemplatesCliError(
      `channels config not found at "${configPath}". Create channels.json or channels.yaml first.`,
    );
  }
  const loaded = await loadChannelsConfig({
    path: configPath,
    ...(deps.env !== undefined && { secretResolver: { env: deps.env } }),
  });
  const matches = loaded.channels.filter((c) => c.type === 'whatsapp');
  if (matches.length === 0) {
    throw new WhatsAppTemplatesCliError(
      'no WhatsApp channel found in config. Add an entry with type: whatsapp.',
    );
  }
  const picked = pickChannel(matches, targetId);
  if (!picked) {
    const ids = matches.map((c) => (c.config.id as string | undefined) ?? '<unset>').join(', ');
    throw new WhatsAppTemplatesCliError(
      `no WhatsApp channel matched --id "${targetId ?? ''}". Available ids: ${ids}.`,
    );
  }
  const transport = (picked.config.transport ?? {}) as Record<string, unknown>;
  const channelId = picked.config.id as string;
  const accessToken = asString(transport.accessToken, `${channelId}.transport.accessToken`);
  const phoneNumberId = asString(transport.phoneNumberId, `${channelId}.transport.phoneNumberId`);
  const businessAccountId = asString(
    transport.businessAccountId,
    `${channelId}.transport.businessAccountId`,
  );
  const baseUrl = typeof transport.baseUrl === 'string' ? transport.baseUrl : undefined;
  return { channelId, accessToken, phoneNumberId, businessAccountId, baseUrl };
}

function pickChannel(
  matches: readonly ConfiguredChannel[],
  targetId: string | undefined,
): ConfiguredChannel | null {
  if (targetId === undefined) {
    if (matches.length === 1) return matches[0] ?? null;
    return null;
  }
  return matches.find((c) => c.config.id === targetId) ?? null;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WhatsAppTemplatesCliError(`${path} must be a non-empty string`);
  }
  return value;
}

function buildClient(resolved: ResolvedChannel, deps: WhatsAppTemplatesCliDeps): WhatsAppClient {
  if (deps.client) return deps.client;
  return createWhatsAppClient({
    accessToken: resolved.accessToken,
    phoneNumberId: resolved.phoneNumberId,
    businessAccountId: resolved.businessAccountId,
    ...(resolved.baseUrl !== undefined && { baseUrl: resolved.baseUrl }),
    ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
  });
}

function nowIso(deps: WhatsAppTemplatesCliDeps): string {
  return new Date(deps.now ? deps.now() : Date.now()).toISOString();
}

export class WhatsAppTemplatesCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppTemplatesCliError';
  }
}

// ── `list` ────────────────────────────────────────────────────────────────

export interface ListArgs {
  id?: string;
  /** When true, hit Meta + refresh cache before printing. Default: false. */
  remote?: boolean;
}

export async function whatsappTemplatesList(
  args: ListArgs,
  deps: WhatsAppTemplatesCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  try {
    const resolved = await resolveWhatsAppChannel(args.id, deps);
    const cachePath = whatsappTemplatesCachePath(resolved.channelId, deps.cacheDir);
    let cache = readTemplateCache(cachePath);

    if (args.remote || cache === null) {
      const client = buildClient(resolved, deps);
      const templates = await client.listTemplates();
      cache = {
        version: TEMPLATE_CACHE_VERSION,
        channelId: resolved.channelId,
        syncedAt: nowIso(deps),
        templates,
      };
      writeTemplateCache(cachePath, cache);
      io.out(`synced ${templates.length} template(s) from Meta → ${cachePath}\n`);
    }

    const templates = cache?.templates ?? [];
    io.out(`templates (${templates.length}) — channel=${resolved.channelId}\n`);
    if (cache) io.out(`last sync: ${cache.syncedAt}\n`);
    for (const t of templates) {
      io.out(`  ${t.name} [${t.language}] — ${t.status}${t.category ? ` (${t.category})` : ''}\n`);
      for (const comp of t.components) {
        io.out(`    • ${comp.type}${comp.text ? `: ${truncateOneLine(comp.text, 60)}` : ''}\n`);
      }
    }
    return 0;
  } catch (err) {
    return reportError(io, err);
  }
}

// ── `add` ─────────────────────────────────────────────────────────────────

export type WhatsAppTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
const VALID_CATEGORIES: readonly WhatsAppTemplateCategory[] = [
  'MARKETING',
  'UTILITY',
  'AUTHENTICATION',
];

export interface AddArgs {
  id?: string;
  name: string;
  language: string;
  category?: WhatsAppTemplateCategory;
  /** Body text — may contain {{1}}, {{2}} placeholder tokens. Required. */
  body: string;
  /** Optional header text component. */
  header?: string;
  /** Optional footer text component. */
  footer?: string;
  /** Optional QUICK_REPLY buttons, each a label string. */
  buttons?: readonly string[];
}

export async function whatsappTemplatesAdd(
  args: AddArgs,
  deps: WhatsAppTemplatesCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  try {
    assertString(args.name, 'name');
    assertString(args.language, 'language');
    assertString(args.body, 'body');

    const resolved = await resolveWhatsAppChannel(args.id, deps);
    const client = buildClient(resolved, deps);
    const components: WhatsAppTemplateComponent[] = [];
    if (args.header) components.push({ type: 'HEADER', format: 'TEXT', text: args.header });
    components.push({ type: 'BODY', text: args.body });
    if (args.footer) components.push({ type: 'FOOTER', text: args.footer });
    if (args.buttons && args.buttons.length > 0) {
      if (args.buttons.length > 3) {
        throw new WhatsAppTemplatesCliError(
          'WhatsApp templates accept at most 3 buttons per BUTTONS component',
        );
      }
      components.push({
        type: 'BUTTONS',
        buttons: args.buttons.map((label) => ({ type: 'QUICK_REPLY' as const, text: label })),
      });
    }
    const category: WhatsAppTemplateCategory = args.category ?? 'UTILITY';
    if (!VALID_CATEGORIES.includes(category)) {
      throw new WhatsAppTemplatesCliError(
        `--category must be one of ${VALID_CATEGORIES.join(', ')} (got "${category}")`,
      );
    }
    const createParams: WhatsAppCreateTemplateParams = {
      name: args.name,
      language: args.language,
      category,
      components,
    };
    const created = await client.createTemplate(createParams);
    io.out(`submitted template "${created.name}" [${created.language}] status=${created.status}\n`);
    if (created.status === 'PENDING') {
      io.out('  Meta approval usually takes up to 24 hours.\n');
    }
    // Refresh cache after submission so the local view reflects the new pending entry.
    const templates = await client.listTemplates();
    const cachePath = whatsappTemplatesCachePath(resolved.channelId, deps.cacheDir);
    writeTemplateCache(cachePath, {
      version: TEMPLATE_CACHE_VERSION,
      channelId: resolved.channelId,
      syncedAt: nowIso(deps),
      templates,
    });
    io.out(`cache updated: ${cachePath}\n`);
    return 0;
  } catch (err) {
    return reportError(io, err);
  }
}

// ── `sync` ────────────────────────────────────────────────────────────────

export interface SyncArgs {
  id?: string;
}

export async function whatsappTemplatesSync(
  args: SyncArgs,
  deps: WhatsAppTemplatesCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  try {
    const resolved = await resolveWhatsAppChannel(args.id, deps);
    const client = buildClient(resolved, deps);
    const templates = await client.listTemplates();
    const cachePath = whatsappTemplatesCachePath(resolved.channelId, deps.cacheDir);
    writeTemplateCache(cachePath, {
      version: TEMPLATE_CACHE_VERSION,
      channelId: resolved.channelId,
      syncedAt: nowIso(deps),
      templates,
    });
    io.out(`synced ${templates.length} template(s) → ${cachePath}\n`);
    const byStatus = countByStatus(templates);
    for (const [status, count] of byStatus) {
      io.out(`  ${status}: ${count}\n`);
    }
    return 0;
  } catch (err) {
    return reportError(io, err);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function countByStatus(templates: readonly WhatsAppTemplate[]): [WhatsAppTemplateStatus, number][] {
  const counts = new Map<WhatsAppTemplateStatus, number>();
  for (const t of templates) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function truncateOneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WhatsAppTemplatesCliError(`--${field} is required and must be a non-empty string`);
  }
}

function reportError(io: WhatsAppTemplatesIO, err: unknown): number {
  if (err instanceof WhatsAppTemplatesCliError) {
    io.err(`✗ ${err.message}\n`);
    return 1;
  }
  if (err instanceof ChannelsConfigError) {
    io.err(`✗ channels config: ${err.message}\n`);
    return 1;
  }
  io.err(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}
