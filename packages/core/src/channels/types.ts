// Phase 5 — Communication Channels.
// Slice 1: contract types only. Runtime wiring (BaseChannelInstance,
// ChannelOutboundBridge, renderer, adapters) lands in slices 2+.

import type { EventPrincipal, EventSourceInstance, SourceDependencies } from '../events/types.js';
import type { PermissionMode } from '../types/permission.js';

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * Declared at adapter load time; immutable for the life of an adapter
 * instance. Skills may read these through the registry to degrade gracefully
 * (e.g. omit a button row when `supportsButtons` is false).
 */
export interface ChannelCapabilities {
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsTypingIndicator: boolean;
  supportsFileUpload: boolean;
  supportsVoice: boolean;
  supportsButtons: boolean;
  supportsEditMessage: boolean;
  supportsDeleteMessage: boolean;
  supportsPresence: boolean;
  supportsSlashCommands: boolean;
  supportsDMs: boolean;
  supportsGroupChats: boolean;
  supportsVoiceChannels: boolean;
  maxMessageLength: number;
  maxAttachmentBytes: number;
  /** WhatsApp only. When true, outbound outside `conversationWindowMs` must use a template. */
  requiresTemplateForOutbound?: boolean;
  /** WhatsApp's 24-hour conversation window in ms. */
  conversationWindowMs?: number;
}

// ── References ─────────────────────────────────────────────────────────────

/**
 * Uniquely identifies a destination across channels, threads, and DMs.
 * Adapter translates to platform-native ids.
 */
export interface ConversationRef {
  /** Adapter instance id (e.g. "telegram-main"). */
  channelId: string;
  /** Platform-specific id: chat_id, channel_id, phone number, etc. */
  conversationId: string;
  /** Slack/Discord thread id; undefined for WhatsApp and main channel Telegram. */
  threadId?: string;
  platformMeta?: Readonly<Record<string, unknown>>;
}

export interface MessageRef {
  conversation: ConversationRef;
  /** Platform-assigned message id (Slack ts, Discord/Telegram numeric id, WA wamid). */
  id: string;
}

export interface UserRef {
  /** Platform-specific user id. */
  id: string;
  /** Optional human-readable name for mentions / logs. */
  displayName?: string;
}

// ── Content ─────────────────────────────────────────────────────────────────

export type MessageTextFormat = 'plain' | 'markdown' | 'html';

export type ButtonStyle = 'primary' | 'secondary' | 'danger';

export interface Button {
  /** Callback id routed back as `channel.interaction.buttonId`. */
  id: string;
  label: string;
  style?: ButtonStyle;
  /** Link button; mutually exclusive with callback semantics per platform. */
  url?: string;
}

export type RichBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'bulleted-list'; items: readonly string[] }
  | { kind: 'button-row'; buttons: readonly Button[] }
  | { kind: 'divider' }
  | { kind: 'image'; url: string; alt?: string }
  | { kind: 'context'; text: string };

/**
 * Ref to a file that has (or will) exist on a platform or in the local
 * file-ref cache. Adapters are free to return their own opaque refs; the
 * common shape carries the minimum the outbound path needs.
 */
export interface FileRef {
  /** Stable identifier (content hash or platform file_id). */
  id: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Optional URL for platforms that accept remote URLs directly. */
  url?: string;
  /** Optional local path for platforms that require upload. */
  path?: string;
}

export interface FileUpload {
  name: string;
  mimeType: string;
  /** Either raw bytes or a local file path — adapters accept one or both. */
  bytes?: Uint8Array;
  path?: string;
}

export type ChannelMessageContent =
  | { kind: 'text'; text: string; format?: MessageTextFormat }
  | { kind: 'rich'; blocks: readonly RichBlock[] }
  | {
      kind: 'template';
      name: string;
      params: Readonly<Record<string, string>>;
      language?: string;
    }
  | { kind: 'file'; file: FileRef; caption?: string }
  | { kind: 'voice'; audio: FileRef; durationSec?: number };

// ── Send / action params ───────────────────────────────────────────────────

export interface SendMessageParams {
  conversation: ConversationRef;
  content: ChannelMessageContent;
  replyTo?: MessageRef;
  mentions?: readonly UserRef[];
  /**
   * Required. The ChannelOutboundBridge supplies
   * `session:<sessionId>:<eventId>`; tool callers supply their own.
   * `BaseChannelInstance` de-dupes on this within a TTL window.
   */
  idempotencyKey: string;
}

export interface SentMessage {
  /** Platform-assigned message id. */
  id: string;
  conversation: ConversationRef;
  /** Platform-assigned timestamp (ms-epoch); optional. */
  sentAt?: number;
}

/**
 * Out-of-band action — pin, mark-read, leave-channel, ... Extensible.
 * Adapters that don't support an action should return a typed error.
 */
export type ChannelAction =
  | { kind: 'pin'; ref: MessageRef }
  | { kind: 'unpin'; ref: MessageRef }
  | { kind: 'mark-read'; conversation: ConversationRef; upTo?: MessageRef }
  | { kind: 'leave'; conversation: ConversationRef };

// ── Webhook surface ─────────────────────────────────────────────────────────

export interface WebhookRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  /** Raw request body — kept as bytes so HMAC signatures verify byte-exact. */
  body: Uint8Array;
  /** Optional remote address if the HTTP server exposes it. */
  remoteAddr?: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  headers?: Readonly<Record<string, string>>;
}

// ── Conversation state store ───────────────────────────────────────────────

/**
 * Minimal persistent KV interface used by adapters that need cross-restart
 * state (WhatsApp window tracker, Telegram file-id cache, Discord command
 * content-hash). Default implementation in slice 2 is in-memory; sqlite
 * variant reuses the Phase-1 session store's underlying DB.
 */
export interface ConversationStateStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// ── Principal / identity ───────────────────────────────────────────────────

/**
 * Channel-scoped principal. Adapters populate one per inbound event and it
 * flows onto the event's `meta.principal`. The permission gate's
 * `resolveForChannel` (slice 9) uses it to apply per-user overrides.
 */
export interface ChannelPrincipal extends EventPrincipal {
  channelId: string;
  platformUserId: string;
  scopes: readonly string[];
  verified: boolean;
}

// ── Adapter + instance contracts ───────────────────────────────────────────

/** Registry lookup surface shared between daemon, outbound bridge, and tools. */
export interface ChannelRegistry {
  register(instance: ChannelInstance): void;
  unregister(id: string): void;
  get(id: string): ChannelInstance | undefined;
  list(): readonly ChannelInstance[];
}

/**
 * Dependencies handed to every channel adapter's `create()` call. Extends
 * Phase-4 `SourceDependencies` with a reference to the shared
 * `ChannelRegistry` and optional persistent state.
 *
 * Inherits `tenant?: TenantContext` from `SourceDependencies` (Phase 6).
 * Channel adapters that care about their tenant id read `deps.tenant?.id`;
 * the base channel instance auto-stamps every outbound event with the
 * resolved tenant id.
 *
 * @since 1.0.0
 */
export interface ChannelDependencies extends SourceDependencies {
  channels: ChannelRegistry;
  /** Optional — defaults to an in-memory store in slice 2. */
  conversationStore?: ConversationStateStore;
}

/**
 * Channel adapter contract. Not a type-level extension of
 * `EventSourceAdapter` — the narrower `deps` parameter would be
 * contravariantly unsafe. Adapters plug into the source discovery pipeline
 * via the slice-3 discovery layer, which registers one adapter per
 * `declaragent.kind === 'channel-adapter'` package.
 *
 * @since 1.0.0
 */
export interface ChannelAdapter<C = unknown> {
  readonly type: string;
  readonly capabilities: ChannelCapabilities;
  readonly agentCompat?: string;
  validateConfig(config: unknown): asserts config is C;
  create(config: C, deps: ChannelDependencies): Promise<ChannelInstance>;
}

/**
 * Live instance produced by a channel adapter. Extends
 * `EventSourceInstance` so it plugs into the Phase-4 source lifecycle
 * (start/stop/pause/resume/health/metrics) — inbound messages flow onto
 * the bus exactly as from any other source.
 *
 * Outbound methods are the Phase-5 addition. All but `send` are optional;
 * adapters that lack a capability MUST both omit the method and declare
 * the corresponding capability as false.
 */
export interface ChannelInstance extends EventSourceInstance {
  readonly capabilities: ChannelCapabilities;

  send(params: SendMessageParams): Promise<SentMessage>;

  setTyping?(conversation: ConversationRef, durationMs?: number): Promise<void>;
  react?(ref: MessageRef, emoji: string): Promise<void>;
  edit?(ref: MessageRef, content: ChannelMessageContent): Promise<void>;
  delete?(ref: MessageRef): Promise<void>;
  uploadFile?(file: FileUpload, conversation: ConversationRef): Promise<FileRef>;
  performAction?(action: ChannelAction): Promise<void>;

  /**
   * Webhook-mode adapters expose this; the daemon's HTTP server dispatches
   * incoming requests through it after path routing. Signature + auth
   * verification lives on the adapter.
   */
  handleWebhook?(req: WebhookRequest): Promise<WebhookResponse>;
}

// ── Permissions (slice 9) ──────────────────────────────────────────────────

/**
 * Per-channel permission configuration. Rides alongside the global
 * `spec.permissions` and lets operators tighten or relax permissions on a
 * per-channel basis — plus override them for specific platform users.
 *
 * Patterns use the shared permission glob syntax (`**` matches any run,
 * `*` matches any non-separator run, `?` matches one char). Each entry
 * in `allow` / `deny` is a rule of form `ToolName:permissionKey`, e.g.
 * `Bash:git *`, `Read:/tmp/**`, `mcp__calendar__*`.
 */
export interface ChannelPermissionsConfig {
  /** Default mode when no override matches. */
  mode: PermissionMode;
  /** Allow rules applied as the base. */
  allow?: readonly string[];
  /** Deny rules applied as the base. */
  deny?: readonly string[];
  /**
   * Per-user overrides. Entries are evaluated in longest-pattern-first
   * order so `U0ADMIN*` wins over `U0*` for the same principal. The
   * first match wins; subsequent overrides do not stack.
   */
  userOverrides?: readonly ChannelUserOverride[];
}

/**
 * One per-user override. `platformUserIdPattern` matches against
 * `principal.platformUserId` via the shared glob. `allow` fully replaces
 * the channel's base allow list on match; `deny` is union-merged with
 * the base so override denies are additive, never subtractive.
 *
 * A `mode` override is rarely needed — most callers just add `allow:
 * ['*']` to admin patterns while leaving `mode` inherited.
 */
export interface ChannelUserOverride {
  platformUserIdPattern: string;
  allow?: readonly string[];
  deny?: readonly string[];
  mode?: PermissionMode;
}

// ── Enroller (stub) ─────────────────────────────────────────────────────────

/**
 * Phase-5 slice 1 reserves this hook point. Implementations map a platform
 * user to an agent user — the default `allow-list` resolver ships in slice
 * 1; the OAuth-style flow lands with the managed control plane post-v1.0.
 */
export interface ChannelEnroller {
  /**
   * Given an inbound principal, return the agent-user id to associate with
   * the session. Returning `undefined` means "no mapping" — the principal
   * is treated as an anonymous participant subject to channel-level rules.
   */
  resolve(principal: ChannelPrincipal): Promise<string | undefined>;
}

/**
 * Config-driven allow-list mapping. Each entry maps a platform user id
 * glob to an agent user id. Non-match → undefined.
 */
export interface AllowListEnrollerEntry {
  /** Glob against `principal.platformUserId`. Simple `*` wildcards only. */
  platformUserIdPattern: string;
  /** Agent-side user id assigned on match. */
  agentUserId: string;
  /** Optional channel id filter; omit to match any channel. */
  channelId?: string;
}

export interface AllowListEnrollerConfig {
  entries: readonly AllowListEnrollerEntry[];
}
