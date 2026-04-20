/**
 * Slack Block Kit schema sanity pre-flight.
 *
 * Slack's API returns a terse 400 ("invalid_blocks") on shape errors; a
 * local validator surfaces the specific violation + block path at build
 * time so a misconfigured skill fails loudly on the sender side instead
 * of appearing to "send but display nothing".
 *
 * This validator covers the subset of Block Kit we emit:
 *   - section (with optional accessory: none)
 *   - header
 *   - divider
 *   - actions (with button elements)
 *   - context (with mrkdwn elements)
 *   - image
 *
 * Constraints enforced (from the published Block Kit reference):
 *   - section text ≤ 3000 chars
 *   - header text ≤ 150 chars
 *   - button text ≤ 75 chars
 *   - button action_id ≤ 255 chars
 *   - actions block ≤ 5 elements
 *   - context block ≤ 10 elements
 *   - image title ≤ 2000 chars, alt_text ≤ 2000 chars
 */

export class BlockKitValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'BlockKitValidationError';
  }
}

const LIMITS = {
  sectionText: 3000,
  headerText: 150,
  buttonText: 75,
  actionId: 255,
  actionsElements: 5,
  contextElements: 10,
  imageAlt: 2000,
  imageTitle: 2000,
} as const;

export function validateBlockKit(blocks: readonly unknown[]): void {
  if (!Array.isArray(blocks)) {
    throw new BlockKitValidationError('blocks must be an array', '$');
  }
  for (const [i, block] of blocks.entries()) {
    validateBlock(block, `blocks[${i}]`);
  }
}

function validateBlock(block: unknown, path: string): void {
  if (!block || typeof block !== 'object') {
    throw new BlockKitValidationError('block must be an object', path);
  }
  const b = block as { type?: unknown };
  if (typeof b.type !== 'string') {
    throw new BlockKitValidationError('block.type must be a string', path);
  }
  switch (b.type) {
    case 'section':
      validateSection(block as Record<string, unknown>, path);
      return;
    case 'header':
      validateHeader(block as Record<string, unknown>, path);
      return;
    case 'divider':
      return;
    case 'actions':
      validateActions(block as Record<string, unknown>, path);
      return;
    case 'context':
      validateContext(block as Record<string, unknown>, path);
      return;
    case 'image':
      validateImage(block as Record<string, unknown>, path);
      return;
    default:
      throw new BlockKitValidationError(`unsupported block type "${b.type}"`, path);
  }
}

function validateSection(block: Record<string, unknown>, path: string): void {
  const text = block.text as { type?: unknown; text?: unknown } | undefined;
  if (!text || typeof text !== 'object') {
    throw new BlockKitValidationError('section requires a text object', `${path}.text`);
  }
  if (text.type !== 'mrkdwn' && text.type !== 'plain_text') {
    throw new BlockKitValidationError(
      'section.text.type must be "mrkdwn" or "plain_text"',
      `${path}.text.type`,
    );
  }
  if (typeof text.text !== 'string') {
    throw new BlockKitValidationError('section.text.text must be a string', `${path}.text.text`);
  }
  if (text.text.length > LIMITS.sectionText) {
    throw new BlockKitValidationError(
      `section text exceeds ${LIMITS.sectionText} chars (got ${text.text.length})`,
      `${path}.text.text`,
    );
  }
}

function validateHeader(block: Record<string, unknown>, path: string): void {
  const text = block.text as { type?: unknown; text?: unknown } | undefined;
  if (!text || typeof text !== 'object') {
    throw new BlockKitValidationError('header requires a text object', `${path}.text`);
  }
  if (text.type !== 'plain_text') {
    throw new BlockKitValidationError('header.text.type must be "plain_text"', `${path}.text.type`);
  }
  if (typeof text.text !== 'string') {
    throw new BlockKitValidationError('header.text.text must be a string', `${path}.text.text`);
  }
  if (text.text.length > LIMITS.headerText) {
    throw new BlockKitValidationError(
      `header text exceeds ${LIMITS.headerText} chars (got ${text.text.length})`,
      `${path}.text.text`,
    );
  }
}

function validateActions(block: Record<string, unknown>, path: string): void {
  const elements = block.elements;
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new BlockKitValidationError(
      'actions requires a non-empty elements array',
      `${path}.elements`,
    );
  }
  if (elements.length > LIMITS.actionsElements) {
    throw new BlockKitValidationError(
      `actions.elements exceeds ${LIMITS.actionsElements} entries (got ${elements.length})`,
      `${path}.elements`,
    );
  }
  for (const [i, el] of elements.entries()) {
    validateButton(el, `${path}.elements[${i}]`);
  }
}

function validateButton(el: unknown, path: string): void {
  if (!el || typeof el !== 'object') {
    throw new BlockKitValidationError('button must be an object', path);
  }
  const b = el as Record<string, unknown>;
  if (b.type !== 'button') {
    throw new BlockKitValidationError(
      `expected type "button", got "${String(b.type)}"`,
      `${path}.type`,
    );
  }
  const text = b.text as { type?: unknown; text?: unknown } | undefined;
  if (!text || typeof text !== 'object') {
    throw new BlockKitValidationError('button requires a text object', `${path}.text`);
  }
  if (text.type !== 'plain_text') {
    throw new BlockKitValidationError('button.text.type must be "plain_text"', `${path}.text.type`);
  }
  if (typeof text.text !== 'string' || text.text.length === 0) {
    throw new BlockKitValidationError('button text is required', `${path}.text.text`);
  }
  if (text.text.length > LIMITS.buttonText) {
    throw new BlockKitValidationError(
      `button text exceeds ${LIMITS.buttonText} chars (got ${text.text.length})`,
      `${path}.text.text`,
    );
  }
  if (typeof b.action_id !== 'string' || b.action_id.length === 0) {
    throw new BlockKitValidationError('button.action_id is required', `${path}.action_id`);
  }
  if (b.action_id.length > LIMITS.actionId) {
    throw new BlockKitValidationError(
      `button.action_id exceeds ${LIMITS.actionId} chars (got ${b.action_id.length})`,
      `${path}.action_id`,
    );
  }
}

function validateContext(block: Record<string, unknown>, path: string): void {
  const elements = block.elements;
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new BlockKitValidationError(
      'context requires a non-empty elements array',
      `${path}.elements`,
    );
  }
  if (elements.length > LIMITS.contextElements) {
    throw new BlockKitValidationError(
      `context.elements exceeds ${LIMITS.contextElements} entries (got ${elements.length})`,
      `${path}.elements`,
    );
  }
}

function validateImage(block: Record<string, unknown>, path: string): void {
  if (typeof block.image_url !== 'string' || block.image_url.length === 0) {
    throw new BlockKitValidationError('image.image_url is required', `${path}.image_url`);
  }
  if (typeof block.alt_text !== 'string') {
    throw new BlockKitValidationError('image.alt_text must be a string', `${path}.alt_text`);
  }
  if (block.alt_text.length > LIMITS.imageAlt) {
    throw new BlockKitValidationError(
      `image.alt_text exceeds ${LIMITS.imageAlt} chars (got ${block.alt_text.length})`,
      `${path}.alt_text`,
    );
  }
}
