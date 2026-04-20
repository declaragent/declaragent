import type {
  BaseChannelOutboundConfig,
  DeliveryConfig,
  LimitsConfig,
  RoutingConfig,
} from '@declaragent/core';

/**
 * Meta WhatsApp Cloud API transport settings. The Cloud API is currently
 * the only supported provider; BSP providers (Twilio, 360dialog) would
 * layer on later as additional `provider` values.
 */
export interface WhatsAppTransportConfig {
  provider: 'meta-cloud';
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  /** Meta echoes this on the GET verification handshake. */
  webhookVerifyToken: string;
  /** HMAC-SHA256 shared secret (the Meta App Secret). */
  webhookAppSecret: string;
  /** Override `https://graph.facebook.com`. */
  baseUrl?: string;
  /** Graph API version ("v18.0", etc.). Default `v18.0`. */
  apiVersion?: string;
}

export type WhatsAppOutsideWindowAction = 'template' | 'queue' | 'drop';

export interface WhatsAppPolicyConfig {
  /** Default `true`. Set `false` to bypass 24h-window enforcement (NOT recommended). */
  enforceConversationWindow?: boolean;
  /** Default `template`. */
  outsideWindowAction?: WhatsAppOutsideWindowAction;
  /** Required when `outsideWindowAction === 'template'`. */
  defaultTemplate?: string;
}

export interface WhatsAppTemplateDescriptor {
  name: string;
  language: string;
  /** Positional parameter names; order matches `{{1}}`, `{{2}}`, … in the body. */
  parameterNames: readonly string[];
}

export interface WhatsAppChannelConfig {
  id: string;
  transport: WhatsAppTransportConfig;
  policy?: WhatsAppPolicyConfig;
  /** Local cache of approved templates; the template-registry CLI (slice 10) syncs this. */
  templates?: readonly WhatsAppTemplateDescriptor[];
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  outbound?: BaseChannelOutboundConfig;
  idempotency?: { ttlMs?: number; maxEntries?: number };
}

export function assertWhatsAppConfig(cfg: unknown): asserts cfg is WhatsAppChannelConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('whatsapp config must be an object');
  }
  const c = cfg as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('whatsapp.id must be a non-empty string');
  }
  const t = c.transport as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') {
    throw new Error(`whatsapp[${c.id}].transport is required`);
  }
  if (t.provider !== 'meta-cloud') {
    throw new Error(`whatsapp[${c.id}].transport.provider must be "meta-cloud"`);
  }
  for (const field of [
    'phoneNumberId',
    'businessAccountId',
    'accessToken',
    'webhookVerifyToken',
    'webhookAppSecret',
  ] as const) {
    if (typeof t[field] !== 'string' || (t[field] as string).length === 0) {
      throw new Error(`whatsapp[${c.id}].transport.${field} is required`);
    }
  }

  // Group mode is non-negotiable: reject anywhere it sneaks in.
  const hasGroupModeFlag = (obj: Record<string, unknown> | undefined): boolean => {
    if (!obj) return false;
    if ('groupMode' in obj) return true;
    if ('groups' in obj) {
      const v = obj.groups;
      if (v === true) return true;
      if (typeof v === 'object' && v !== null) return true;
    }
    return false;
  };
  if (hasGroupModeFlag(c) || hasGroupModeFlag(t) || hasGroupModeFlag(c.policy as never)) {
    throw new Error(
      `whatsapp[${c.id}]: group mode is not supported on the Cloud API adapter (v0.9)`,
    );
  }

  const policy = c.policy as Record<string, unknown> | undefined;
  if (policy !== undefined) {
    if (
      policy.enforceConversationWindow !== undefined &&
      typeof policy.enforceConversationWindow !== 'boolean'
    ) {
      throw new Error(`whatsapp[${c.id}].policy.enforceConversationWindow must be boolean`);
    }
    if (policy.outsideWindowAction !== undefined) {
      const v = policy.outsideWindowAction;
      if (v !== 'template' && v !== 'queue' && v !== 'drop') {
        throw new Error(
          `whatsapp[${c.id}].policy.outsideWindowAction must be "template" | "queue" | "drop"`,
        );
      }
      if (v === 'template' && typeof policy.defaultTemplate !== 'string') {
        throw new Error(
          `whatsapp[${c.id}].policy.defaultTemplate is required when outsideWindowAction === "template"`,
        );
      }
    }
    if (policy.defaultTemplate !== undefined && typeof policy.defaultTemplate !== 'string') {
      throw new Error(`whatsapp[${c.id}].policy.defaultTemplate must be a string`);
    }
  }

  const templates = c.templates;
  if (templates !== undefined) {
    if (!Array.isArray(templates)) {
      throw new Error(`whatsapp[${c.id}].templates must be an array`);
    }
    for (const tpl of templates as unknown[]) {
      if (!tpl || typeof tpl !== 'object') {
        throw new Error(`whatsapp[${c.id}].templates entries must be objects`);
      }
      const entry = tpl as Record<string, unknown>;
      if (typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new Error(`whatsapp[${c.id}].templates[].name is required`);
      }
      if (typeof entry.language !== 'string' || entry.language.length === 0) {
        throw new Error(`whatsapp[${c.id}].templates[].language is required`);
      }
      if (!Array.isArray(entry.parameterNames)) {
        throw new Error(`whatsapp[${c.id}].templates[].parameterNames must be an array`);
      }
    }
  }

  if (!c.routing) throw new Error(`whatsapp[${c.id}].routing is required`);
  if (!c.delivery) throw new Error(`whatsapp[${c.id}].delivery is required`);
  if (!c.limits) throw new Error(`whatsapp[${c.id}].limits is required`);
}
