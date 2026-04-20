/**
 * Narrow, hand-written type shapes for the subset of the Meta WhatsApp
 * Cloud API we consume. We model only fields the adapter reads or
 * produces so version upgrades surface as explicit additions rather than
 * churn elsewhere.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api.
 */

// ── Shared primitives ─────────────────────────────────────────────────────

export interface WhatsAppMediaDescriptor {
  id: string;
  mime_type?: string;
  sha256?: string;
  filename?: string;
  caption?: string;
  voice?: boolean;
}

export interface WhatsAppContact {
  /** Display name from the user's WhatsApp profile (only present in window). */
  profile: { name: string };
  /** Platform-assigned user id (phone number in E.164 without the `+`). */
  wa_id: string;
}

// ── Inbound message variants ──────────────────────────────────────────────

export interface WhatsAppTextInbound {
  type: 'text';
  text: { body: string };
}

export interface WhatsAppButtonInbound {
  /** Legacy "quick reply" button coming from a template button press. */
  type: 'button';
  button: { payload: string; text: string };
}

export interface WhatsAppInteractiveInbound {
  type: 'interactive';
  interactive:
    | {
        type: 'button_reply';
        button_reply: { id: string; title: string };
      }
    | {
        type: 'list_reply';
        list_reply: { id: string; title: string; description?: string };
      };
}

export interface WhatsAppReactionInbound {
  type: 'reaction';
  reaction: { message_id: string; emoji: string };
}

export interface WhatsAppImageInbound {
  type: 'image';
  image: WhatsAppMediaDescriptor;
}

export interface WhatsAppDocumentInbound {
  type: 'document';
  document: WhatsAppMediaDescriptor;
}

export interface WhatsAppAudioInbound {
  type: 'audio';
  audio: WhatsAppMediaDescriptor;
}

export interface WhatsAppVideoInbound {
  type: 'video';
  video: WhatsAppMediaDescriptor;
}

export type WhatsAppInboundMessageVariant =
  | WhatsAppTextInbound
  | WhatsAppButtonInbound
  | WhatsAppInteractiveInbound
  | WhatsAppReactionInbound
  | WhatsAppImageInbound
  | WhatsAppDocumentInbound
  | WhatsAppAudioInbound
  | WhatsAppVideoInbound;

export type WhatsAppInboundMessage = WhatsAppInboundMessageVariant & {
  /** Message id (wamid). */
  id: string;
  /** Sender's waId (same as contacts[].wa_id). */
  from: string;
  /** UNIX timestamp in seconds (string per Meta's spec). */
  timestamp: string;
  /** Message-level metadata: context (replied-to message etc.). */
  context?: { from?: string; id?: string };
};

// ── Delivery / status ────────────────────────────────────────────────────

export type WhatsAppStatusKind = 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppMessageStatus {
  id: string;
  recipient_id: string;
  status: WhatsAppStatusKind;
  timestamp: string;
  conversation?: { id: string; expiration_timestamp?: string };
  errors?: { code: number; title: string; message?: string }[];
}

// ── Webhook envelope ──────────────────────────────────────────────────────

export interface WhatsAppWebhookValue {
  messaging_product: 'whatsapp';
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppInboundMessage[];
  statuses?: WhatsAppMessageStatus[];
}

export interface WhatsAppWebhookChange {
  field: 'messages' | string;
  value: WhatsAppWebhookValue;
}

export interface WhatsAppWebhookEntry {
  id: string;
  changes: WhatsAppWebhookChange[];
}

export interface WhatsAppWebhookBody {
  object: 'whatsapp_business_account';
  entry: WhatsAppWebhookEntry[];
}

// ── Templates ─────────────────────────────────────────────────────────────

export type WhatsAppTemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export interface WhatsAppTemplateComponent {
  type: 'BODY' | 'HEADER' | 'FOOTER' | 'BUTTONS';
  text?: string;
  format?: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'VIDEO';
  buttons?: {
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    phone_number?: string;
  }[];
  example?: Record<string, unknown>;
}

export interface WhatsAppTemplate {
  name: string;
  language: string;
  components: WhatsAppTemplateComponent[];
  status: WhatsAppTemplateStatus;
  category?: string;
  id?: string;
}

// ── Phone number health ───────────────────────────────────────────────────

export interface WhatsAppPhoneNumberInfo {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating?: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  messaging_limit_tier?: string;
  code_verification_status?: string;
}
