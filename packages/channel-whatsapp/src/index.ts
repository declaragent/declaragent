export { createWhatsAppAdapter, whatsappAdapter } from './adapter.js';
export type { WhatsAppAdapterOptions } from './adapter.js';
export { WHATSAPP_CAPABILITIES } from './capabilities.js';
export {
  WhatsAppApiError,
  createWhatsAppClient,
} from './client.js';
export type {
  CreateWhatsAppClientOptions,
  WhatsAppButtonInteractive,
  WhatsAppClient,
  WhatsAppCreateTemplateParams,
  WhatsAppInteractive,
  WhatsAppListInteractive,
  WhatsAppMediaType,
  WhatsAppMediaUrlResponse,
  WhatsAppReplyButton,
  WhatsAppSendInteractiveParams,
  WhatsAppSendMediaParams,
  WhatsAppSendReactionParams,
  WhatsAppSendTemplateParams,
  WhatsAppSendTextParams,
  WhatsAppSentResponse,
} from './client.js';
export { assertWhatsAppConfig } from './config.js';
export type {
  WhatsAppChannelConfig,
  WhatsAppOutsideWindowAction,
  WhatsAppPolicyConfig,
  WhatsAppTemplateDescriptor,
  WhatsAppTransportConfig,
} from './config.js';
export { ConversationWindowTracker } from './conversation-window.js';
export type {
  ConversationWindowSnapshot,
  ConversationWindowTrackerOptions,
} from './conversation-window.js';
export { WhatsAppChannelInstance, WhatsAppTemplateError } from './instance.js';
export type {
  WhatsAppChannelInstanceOptions,
  WhatsAppFileCache,
} from './instance.js';
export { parseWhatsAppWebhook } from './update-parser.js';
export type { ParsedUpdate, ParseWebhookOptions } from './update-parser.js';
export type {
  WhatsAppAudioInbound,
  WhatsAppButtonInbound,
  WhatsAppContact,
  WhatsAppDocumentInbound,
  WhatsAppImageInbound,
  WhatsAppInboundMessage,
  WhatsAppInboundMessageVariant,
  WhatsAppInteractiveInbound,
  WhatsAppMediaDescriptor,
  WhatsAppMessageStatus,
  WhatsAppPhoneNumberInfo,
  WhatsAppReactionInbound,
  WhatsAppStatusKind,
  WhatsAppTemplate,
  WhatsAppTemplateComponent,
  WhatsAppTemplateStatus,
  WhatsAppTextInbound,
  WhatsAppVideoInbound,
  WhatsAppWebhookBody,
  WhatsAppWebhookChange,
  WhatsAppWebhookEntry,
  WhatsAppWebhookValue,
} from './whatsapp-api.js';

export { createWhatsAppAdapter as default } from './adapter.js';
