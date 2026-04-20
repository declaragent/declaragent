export { createDiscordAdapter, discordAdapter } from './adapter.js';
export type { DiscordAdapterOptions } from './adapter.js';
export { DISCORD_CAPABILITIES } from './capabilities.js';
export {
  DiscordApiError,
  createDiscordClient,
} from './client.js';
export type {
  CreateDiscordClientOptions,
  CreateGatewayTransportOptions,
  DiscordClient,
  DiscordCreateFollowupMessageParams,
  DiscordCreateInteractionResponseParams,
  DiscordCreateReactionParams,
  DiscordDeleteMessageParams,
  DiscordEditMessageParams,
  DiscordRegisterGlobalCommandsParams,
  DiscordSendMessageParams,
  DiscordTriggerTypingParams,
  DiscordUnarchiveThreadParams,
  GatewayEventHandler,
  GatewayTransport,
} from './client.js';
export {
  DISCORD_INTENT_BITS,
  PRIVILEGED_INTENTS,
  assertDiscordConfig,
  computeIntentsBitfield,
} from './config.js';
export type {
  ArchivedThreadPolicy,
  DiscordChannelConfig,
  DiscordIntentName,
  DiscordSlashCommandConfig,
  DiscordTransportConfig,
} from './config.js';
export type {
  DiscordActionRowComponent,
  DiscordApplicationCommand,
  DiscordAttachment,
  DiscordChannel,
  DiscordChannelType,
  DiscordComponentButton,
  DiscordEmbedField,
  DiscordEmbedObject,
  DiscordGatewayBotInfo,
  DiscordGatewayPayload,
  DiscordGuildMember,
  DiscordHelloData,
  DiscordInteraction,
  DiscordInteractionData,
  DiscordInteractionDataOption,
  DiscordInteractionResponse,
  DiscordInteractionResponseType,
  DiscordInteractionType,
  DiscordMessage,
  DiscordMessageReference,
  DiscordReadyData,
  DiscordThreadMetadata,
  DiscordUser,
} from './discord-api.js';
export { DiscordChannelInstance } from './instance.js';
export type { DiscordChannelInstanceOptions } from './instance.js';
export { parseDiscordEvent } from './update-parser.js';
export type { DiscordInboundEvent, ParsedUpdate, ParseOptions } from './update-parser.js';

export { createDiscordAdapter as default } from './adapter.js';
