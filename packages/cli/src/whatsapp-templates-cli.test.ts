import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  WhatsAppClient,
  WhatsAppCreateTemplateParams,
  WhatsAppTemplate,
} from '@declaragent/channel-whatsapp';
import {
  readTemplateCache,
  whatsappTemplatesAdd,
  whatsappTemplatesList,
  whatsappTemplatesSync,
} from './whatsapp-templates-cli.js';

// ── Harness ─────────────────────────────────────────────────────────────

function captureIO(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
}

interface StubCalls {
  listTemplates: number;
  createTemplate: WhatsAppCreateTemplateParams[];
}

interface StubOptions {
  templates?: WhatsAppTemplate[];
  listError?: () => Error;
  createError?: () => Error;
  createReturn?: (params: WhatsAppCreateTemplateParams) => WhatsAppTemplate;
}

function stubClient(opts: StubOptions = {}): { client: WhatsAppClient; calls: StubCalls } {
  const templates: WhatsAppTemplate[] = opts.templates ? [...opts.templates] : [];
  const calls: StubCalls = { listTemplates: 0, createTemplate: [] };
  const sent = {
    messaging_product: 'whatsapp' as const,
    contacts: [{ input: '+1', wa_id: '1' }],
    messages: [{ id: 'x' }],
  };
  const client: WhatsAppClient = {
    sendText: async () => sent,
    sendInteractive: async () => sent,
    sendTemplate: async () => sent,
    sendMedia: async () => sent,
    sendReaction: async () => sent,
    getMedia: async () => ({
      url: '',
      mime_type: '',
      sha256: '',
      file_size: 0,
      id: '',
      messaging_product: 'whatsapp',
    }),
    downloadMedia: async () => new Uint8Array(),
    listTemplates: async () => {
      calls.listTemplates += 1;
      if (opts.listError) throw opts.listError();
      return templates.slice();
    },
    createTemplate: async (params) => {
      calls.createTemplate.push(params);
      if (opts.createError) throw opts.createError();
      const created: WhatsAppTemplate = opts.createReturn?.(params) ?? {
        name: params.name,
        language: params.language,
        components: params.components,
        status: 'PENDING',
        category: params.category,
      };
      templates.push(created);
      return created;
    },
    getPhoneNumber: async () => ({
      id: 'x',
      display_phone_number: '+1',
      verified_name: 'bot',
    }),
  };
  return { client, calls };
}

function tmp(): { root: string; write(name: string, contents: string): string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-whatsapp-cli-'));
  return {
    root,
    write(name, contents) {
      const path = join(root, name);
      writeFileSync(path, contents, 'utf-8');
      return path;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeChannelsConfig(
  t: ReturnType<typeof tmp>,
  name = 'channels.yaml',
  ...extra: string[]
): string {
  const body = [
    'channels:',
    '  - id: whatsapp-cloud',
    '    type: whatsapp',
    '    transport:',
    '      provider: meta-cloud',
    '      phoneNumberId: "1234567890"',
    '      businessAccountId: "9876543210"',
    '      accessToken: "${env:WA_TOKEN}"',
    '      webhookVerifyToken: "vt"',
    '      webhookAppSecret: "as"',
    ...extra,
  ].join('\n');
  return t.write(name, `${body}\n`);
}

const env = { WA_TOKEN: 'test-token' };

// ── list ─────────────────────────────────────────────────────────────────

describe('whatsappTemplatesList', () => {
  test('syncs from Meta when no cache exists and writes the cache file', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client, calls } = stubClient({
        templates: [
          {
            name: 'order_shipped',
            language: 'en_US',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'Your order has shipped.' }],
          },
        ],
      });
      const { out, io } = captureIO();
      const code = await whatsappTemplatesList(
        {},
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(0);
      expect(calls.listTemplates).toBe(1);
      const text = out.join('');
      expect(text).toContain('synced 1 template(s)');
      expect(text).toContain('order_shipped');
      expect(text).toContain('APPROVED');
      const cachePath = join(t.root, 'whatsapp-templates', 'whatsapp-cloud.json');
      const cached = readTemplateCache(cachePath);
      expect(cached?.templates).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });

  test('prints from cache when cache exists and --remote is not set', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { whatsappTemplatesCachePath } = await import('./paths.js');
      const cachePath = whatsappTemplatesCachePath('whatsapp-cloud', t.root);
      writeFileSync(
        cachePath,
        JSON.stringify({
          version: 1,
          channelId: 'whatsapp-cloud',
          syncedAt: '2026-04-17T00:00:00.000Z',
          templates: [
            {
              name: 'reminder_v1',
              language: 'en_US',
              status: 'APPROVED',
              components: [{ type: 'BODY', text: 'Reminder.' }],
            },
          ],
        }),
      );
      const { client, calls } = stubClient();
      const { out, io } = captureIO();
      const code = await whatsappTemplatesList(
        {},
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(0);
      expect(calls.listTemplates).toBe(0);
      expect(out.join('')).toContain('reminder_v1');
    } finally {
      t.cleanup();
    }
  });

  test('--remote refreshes cache from Meta even if one exists', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const cachePath = join(t.root, 'whatsapp-templates', 'whatsapp-cloud.json');
      // pre-write an old cache that should be overwritten
      const { whatsappTemplatesCachePath } = await import('./paths.js');
      whatsappTemplatesCachePath('whatsapp-cloud', t.root); // ensures dir exists
      writeFileSync(
        cachePath,
        JSON.stringify({
          version: 1,
          channelId: 'whatsapp-cloud',
          syncedAt: '2020-01-01T00:00:00.000Z',
          templates: [],
        }),
      );
      const { client, calls } = stubClient({
        templates: [
          {
            name: 'new_template',
            language: 'en_US',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'new' }],
          },
        ],
      });
      const { io } = captureIO();
      const code = await whatsappTemplatesList(
        { remote: true },
        { io, configPath, cacheDir: t.root, client, env, now: () => 1_700_000_000_000 },
      );
      expect(code).toBe(0);
      expect(calls.listTemplates).toBe(1);
      const refreshed = readTemplateCache(cachePath);
      expect(refreshed?.templates[0]?.name).toBe('new_template');
      expect(refreshed?.syncedAt).toBe(new Date(1_700_000_000_000).toISOString());
    } finally {
      t.cleanup();
    }
  });

  test('fails cleanly when no WhatsApp entry exists', async () => {
    const t = tmp();
    try {
      const configPath = t.write(
        'channels.yaml',
        'channels:\n  - id: tg\n    type: telegram\n    transport: { mode: long-polling, botToken: x }\n',
      );
      const { err, io } = captureIO();
      const code = await whatsappTemplatesList({}, { io, configPath, cacheDir: t.root, env });
      expect(code).toBe(1);
      expect(err.join('')).toContain('no WhatsApp channel');
    } finally {
      t.cleanup();
    }
  });

  test('disambiguates when multiple WhatsApp channels exist and --id is missing', async () => {
    const t = tmp();
    try {
      const configPath = t.write(
        'channels.yaml',
        [
          'channels:',
          '  - id: wa-a',
          '    type: whatsapp',
          '    transport: { provider: meta-cloud, phoneNumberId: "1", businessAccountId: "11", accessToken: t, webhookVerifyToken: v, webhookAppSecret: s }',
          '  - id: wa-b',
          '    type: whatsapp',
          '    transport: { provider: meta-cloud, phoneNumberId: "2", businessAccountId: "22", accessToken: t, webhookVerifyToken: v, webhookAppSecret: s }',
        ].join('\n'),
      );
      const { err, io } = captureIO();
      const code = await whatsappTemplatesList({}, { io, configPath, cacheDir: t.root, env });
      expect(code).toBe(1);
      expect(err.join('')).toContain('matched --id');
    } finally {
      t.cleanup();
    }
  });

  test('fails cleanly when secret ref cannot resolve', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { err, io } = captureIO();
      // Pass an empty env so ${env:WA_TOKEN} fails.
      const code = await whatsappTemplatesList({}, { io, configPath, cacheDir: t.root, env: {} });
      expect(code).toBe(1);
      expect(err.join('')).toContain('WA_TOKEN');
    } finally {
      t.cleanup();
    }
  });
});

// ── add ──────────────────────────────────────────────────────────────────

describe('whatsappTemplatesAdd', () => {
  test('POSTs a new template and refreshes the cache', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client, calls } = stubClient();
      const { out, io } = captureIO();
      const code = await whatsappTemplatesAdd(
        {
          name: 'appointment_reminder_v1',
          language: 'en_US',
          body: 'Hi {{1}}, your appointment is at {{2}}.',
          footer: 'Reply CANCEL to reschedule.',
          buttons: ['Confirm', 'Reschedule'],
        },
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(0);
      expect(calls.createTemplate).toHaveLength(1);
      const created = calls.createTemplate[0];
      expect(created?.name).toBe('appointment_reminder_v1');
      expect(created?.category).toBe('UTILITY');
      expect(created?.components.some((c) => c.type === 'BUTTONS')).toBe(true);
      const text = out.join('');
      expect(text).toContain('submitted template');
      expect(text).toContain('PENDING');
      // Cache contains the newly created template.
      const cachePath = join(t.root, 'whatsapp-templates', 'whatsapp-cloud.json');
      const cached = readTemplateCache(cachePath);
      expect(cached?.templates.some((t2) => t2.name === 'appointment_reminder_v1')).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test('rejects >3 buttons with a clear error', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client } = stubClient();
      const { err, io } = captureIO();
      const code = await whatsappTemplatesAdd(
        {
          name: 'x',
          language: 'en_US',
          body: 'b',
          buttons: ['a', 'b', 'c', 'd'],
        },
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('at most 3 buttons');
    } finally {
      t.cleanup();
    }
  });

  test('surfaces Meta API errors cleanly', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client } = stubClient({
        createError: () => new Error('template name already exists'),
      });
      const { err, io } = captureIO();
      const code = await whatsappTemplatesAdd(
        { name: 'dupe', language: 'en_US', body: 'b' },
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('already exists');
    } finally {
      t.cleanup();
    }
  });

  test('rejects missing required fields', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client } = stubClient();
      const { err, io } = captureIO();
      const code = await whatsappTemplatesAdd(
        { name: '', language: 'en_US', body: 'b' },
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('--name is required');
    } finally {
      t.cleanup();
    }
  });
});

// ── sync ─────────────────────────────────────────────────────────────────

describe('whatsappTemplatesSync', () => {
  test('writes cache + prints a status summary', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client } = stubClient({
        templates: [
          {
            name: 'a',
            language: 'en_US',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'a' }],
          },
          {
            name: 'b',
            language: 'en_US',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'b' }],
          },
          {
            name: 'c',
            language: 'en_US',
            status: 'REJECTED',
            components: [{ type: 'BODY', text: 'c' }],
          },
        ],
      });
      const { out, io } = captureIO();
      const code = await whatsappTemplatesSync(
        {},
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('synced 3 template(s)');
      expect(text).toContain('APPROVED: 2');
      expect(text).toContain('REJECTED: 1');
      const cachePath = join(t.root, 'whatsapp-templates', 'whatsapp-cloud.json');
      const parsed = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(parsed.templates).toHaveLength(3);
      expect(parsed.channelId).toBe('whatsapp-cloud');
    } finally {
      t.cleanup();
    }
  });

  test('surfaces list errors with non-zero exit', async () => {
    const t = tmp();
    try {
      const configPath = writeChannelsConfig(t);
      const { client } = stubClient({ listError: () => new Error('401 unauthorized') });
      const { err, io } = captureIO();
      const code = await whatsappTemplatesSync(
        {},
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('401');
    } finally {
      t.cleanup();
    }
  });

  test('honors --id when multiple WhatsApp channels exist', async () => {
    const t = tmp();
    try {
      const configPath = t.write(
        'channels.yaml',
        [
          'channels:',
          '  - id: wa-a',
          '    type: whatsapp',
          '    transport: { provider: meta-cloud, phoneNumberId: "1", businessAccountId: "11", accessToken: t, webhookVerifyToken: v, webhookAppSecret: s }',
          '  - id: wa-b',
          '    type: whatsapp',
          '    transport: { provider: meta-cloud, phoneNumberId: "2", businessAccountId: "22", accessToken: t, webhookVerifyToken: v, webhookAppSecret: s }',
        ].join('\n'),
      );
      const { client } = stubClient();
      const { io } = captureIO();
      const code = await whatsappTemplatesSync(
        { id: 'wa-b' },
        { io, configPath, cacheDir: t.root, client, env },
      );
      expect(code).toBe(0);
      const cachePath = join(t.root, 'whatsapp-templates', 'wa-b.json');
      expect(readTemplateCache(cachePath)?.channelId).toBe('wa-b');
    } finally {
      t.cleanup();
    }
  });
});
