export { createTelegramAdapter, telegramAdapter } from './adapter.js';
export type { TelegramAdapterOptions } from './adapter.js';
export { TELEGRAM_CAPABILITIES } from './capabilities.js';
export {
  TelegramApiError,
  createTelegramClient,
} from './client.js';
export type {
  AnswerCallbackQueryParams,
  CreateTelegramClientOptions,
  DeleteMessageParams,
  EditMessageTextParams,
  GetUpdatesParams,
  SendChatActionParams,
  SendDocumentParams,
  SendMessageParams as TelegramSendMessageParams,
  SendVoiceParams,
  SetMessageReactionParams,
  SetWebhookParams,
  TelegramClient,
  TelegramInlineButton,
  TelegramReplyMarkup,
} from './client.js';
export { assertTelegramConfig } from './config.js';
export type {
  TelegramChannelConfig,
  TelegramTransportConfig,
  TelegramTransportMode,
} from './config.js';
export { TelegramChannelInstance } from './instance.js';
export type { TelegramChannelInstanceOptions } from './instance.js';
export type {
  TelegramBotInfo,
  TelegramCallbackQuery,
  TelegramChat,
  TelegramChatAction,
  TelegramDocument,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramPhotoSize,
  TelegramUpdate,
  TelegramUser,
  TelegramVoice,
} from './telegram-api.js';
export { parseUpdate } from './update-parser.js';
export type { ParsedUpdate, ParseUpdateOptions } from './update-parser.js';

export { telegramAdapter as default } from './adapter.js';
