export {
  ADAPTER_PREFIX,
  ADAPTER_SCOPE,
  AdapterDiscoveryError,
  discoverAdapters,
  registerDiscoveredAdapters,
} from './adapter-discovery.js';
export type {
  DiscoverAdaptersOptions,
  DiscoveredAdapter,
} from './adapter-discovery.js';
export {
  BaseSourceInstance,
  DEFAULT_ACK_DISPATCH_TIMEOUT_MS,
  DEFAULT_LATENCY_RESERVOIR_SIZE,
  LatencyHistogram,
} from './base-source.js';
export type { AckContext, BaseSourceConfig, BaseSourceOptions } from './base-source.js';
export { DEFAULT_RECENT_BUFFER_SIZE, createEventBus } from './bus.js';
export type { CreateEventBusOptions } from './bus.js';
export { CircuitBreaker } from './circuit-breaker.js';
export type {
  CircuitBreakerOptions,
  CircuitBreakerState,
  CircuitBreakerTransitionEvent,
  CircuitBreakerTransitionListener,
} from './circuit-breaker.js';
export { ConcurrencyLimiter } from './concurrency.js';
export {
  EventSourcesConfigError,
  loadEventSourcesConfig,
  validateEventSourcesConfig,
} from './config-loader.js';
export type {
  LoadEventSourcesOptions,
  LoadEventSourcesResult,
  ValidateEventSourcesOptions,
  ValidateEventSourcesReport,
} from './config-loader.js';
export {
  SecretResolverError,
  createDefaultSecretResolver,
} from './secret-resolver.js';
export type { CreateSecretResolverOptions } from './secret-resolver.js';
export { PerTargetRateLimiter, TokenBucket, targetIdentity } from './rate-limiter.js';
export type {
  EventTargetType,
  PerTargetRateLimiterOptions,
  RateLimitDecision,
  RateLimitRule,
  RateLimitSpec,
  TokenBucketOptions,
} from './rate-limiter.js';
export {
  BucketedHistogram,
  ObservabilityError,
  POWER_OF_TWO_BUCKETS,
  createNoopMetricsRegistry,
  createNoopTracer,
  createOtelBridge,
  createRecordingMetricsRegistry,
  createRecordingTracer,
} from './observability.js';
export type {
  HistogramSnapshot,
  MetricRecord,
  OtelBridgeOptions,
  RecordedSpan,
  RecordingMetricsRegistry,
  RecordingTracer,
} from './observability.js';
export { compareSemver, parseSemver, satisfies as semverSatisfies } from './semver.js';
export { KNOWN_TARGET_TYPES, assertEventTarget } from './target-validate.js';
export {
  FilterExpressionError,
  evaluateFilter,
  parseFilterExpression,
} from './filter-expr.js';
export type { Expr as FilterExpr } from './filter-expr.js';
export {
  JsonPathError,
  isJsonPath,
  parseJsonPath,
  resolveJsonPath,
} from './jsonpath.js';
export type { JsonPathSegment } from './jsonpath.js';
export { NormalizeError, createMessageNormalizer } from './normalizer.js';
export type { CreateMessageNormalizerOptions } from './normalizer.js';
export {
  CONFLUENT_MAGIC_BYTE,
  SchemaRegistryError,
  asBytes,
  createSchemaRegistry,
  decodeAvro,
  decodeMsgpack,
  decodeProtobuf,
  defaultPeerLoader,
  parseConfluentWireFormat,
} from './schema-registry.js';
export type {
  CreateSchemaRegistryOptions,
  PeerDepLoader,
  SchemaRecord,
  SchemaRegistryAuth,
  SchemaRegistryClient,
  WireFormatParts,
} from './schema-registry.js';
export {
  DEFAULT_CAUSED_BY_DEPTH_LIMIT,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_IDEMPOTENCY_CACHE_SIZE,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  createEventDispatcher,
  frameEvent,
} from './dispatcher.js';
export type {
  CreateEventDispatcherOptions,
  DispatcherSessionFactories,
} from './dispatcher.js';
export {
  NDJSONDecoder,
  encodeControlMessage,
  handleControlRequest,
  isControlRequest,
} from './control-protocol.js';
export type {
  ControlErrorBody,
  ControlMethod,
  ControlRequest,
  ControlRequestBase,
  ControlResponse,
  ControlResultByMethod,
} from './control-protocol.js';
export { startDaemon } from './daemon.js';
export type {
  ConfiguredSource,
  Daemon,
  DaemonReloadOptions,
  DaemonReloadResult,
  DaemonShutdownOptions,
  DaemonStatus,
  StartDaemonOptions,
} from './daemon.js';
export { DEFAULT_MAILBOX_TTL_MS, createMailbox } from './mailbox.js';
export type { CreateMailboxOptions, Mailbox } from './mailbox.js';
export {
  adapterExtension,
  eventSourceExtension,
  findAdapter,
  listEventSources,
  sourceInstanceExtension,
} from './source.js';
export type {
  AdapterExtensionOptions,
  EventSourceExtensionOptions,
  SourceInstanceDeps,
  SourceInstanceSpec,
} from './source.js';
export { DEFAULT_EVENT_RETENTION_MS, createEventStore } from './store.js';
export type {
  CreateEventStoreOptions,
  EventRejectionListFilter,
  EventRejectionRecord,
  EventStore,
  EventStoreListFilter,
  EventStoreRecord,
} from './store.js';
export {
  computeNextFire,
  createCronAdapter,
  isDuration,
  parseCron,
  parseDuration,
  validateSchedule,
} from './sources/cron.js';
export type {
  CronAdapterOptions,
  CronFields,
  CronTriggerConfig,
} from './sources/cron.js';
export {
  DEFAULT_DEBOUNCE_MS,
  PerPathDebouncer,
  createFileWatchAdapter,
  extractWatchRoot,
  globToRegExp,
} from './sources/file-watch.js';
export type {
  FileChangeKind,
  FileWatchAdapterOptions,
  FileWatchTriggerConfig,
  FileWatcherLike,
} from './sources/file-watch.js';
export {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  DEFAULT_WEBHOOK_REPLAY_WINDOW_SEC,
  createWebhookAdapter,
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqual,
} from './sources/webhook.js';
export type {
  WebhookAdapterOptions,
  WebhookAuth,
  WebhookListenOptions,
  WebhookRateLimit,
  WebhookServerHandle,
  WebhookTriggerConfig,
} from './sources/webhook.js';
export type {
  AgentEvent,
  AgentEventMeta,
  Clock,
  Counter,
  EventPrincipal,
  NormalizeContext,
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanStatus,
  Tracer,
  BusPressureListener,
  DeliveryConfig,
  DispatchOutcome,
  DlqConfig,
  DLQEntry,
  DLQListParams,
  EventAuth,
  EventBus,
  EventDispatcher,
  EventHandler,
  EventKind,
  EventKindFilter,
  EventSourceAdapter,
  EventSourceInstance,
  EventSourceTag,
  EventTarget,
  Gauge,
  Histogram,
  IdempotencyConfig,
  JsonPath,
  LimitsConfig,
  MessageNormalizer,
  MetricsRegistry,
  RawMessage,
  ReplayParams,
  RoutingConfig,
  SecretResolver,
  SeekPosition,
  SourceDependencies,
  SourceHealth,
  SourceHealthStatus,
  SourceMetrics,
  TargetSelector,
} from './types.js';
