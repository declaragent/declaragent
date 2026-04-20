import { estimateCostUSD } from '../session/pricing.js';
import type { Message } from '../types/messages.js';
import type { AgentSpec, SessionHandle, SessionLedger, TurnStatus } from '../types/session.js';

export interface MemorySessionOptions {
  id?: string;
  spec?: Partial<AgentSpec>;
}

const DEFAULT_SPEC: AgentSpec = {
  name: 'memory-agent',
  model: 'claude-opus-4-6',
  systemPrompt: 'you are a test',
};

/**
 * In-memory SessionHandle. Not for production — used by engine tests and
 * as a reference impl until SQLite lands in slice 7.
 */
export function createMemorySession(
  options: MemorySessionOptions = {},
): SessionHandle & { turnStatuses: ReadonlyMap<string, TurnStatus> } {
  const messages: Message[] = [];
  const turnStatuses = new Map<string, TurnStatus>();
  let currentSpec: AgentSpec = { ...DEFAULT_SPEC, ...options.spec };
  const id = options.id ?? `mem-${crypto.randomUUID()}`;
  const ledger: SessionLedger = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
    estimatedCostUSD: 0,
  };

  return {
    id,
    get spec(): AgentSpec {
      return currentSpec;
    },
    get transcript(): ReadonlyArray<Message> {
      return messages;
    },
    async updateSpec(patch: Partial<AgentSpec>): Promise<void> {
      currentSpec = { ...currentSpec, ...patch };
    },
    async appendMessage(m: Message): Promise<void> {
      messages.push(m);
      const usage = m.meta?.usage;
      if (usage) {
        ledger.inputTokens += usage.inputTokens;
        ledger.outputTokens += usage.outputTokens;
        if (usage.cacheReadTokens) {
          ledger.cacheReadTokens += usage.cacheReadTokens;
        }
        ledger.estimatedCostUSD += estimateCostUSD(m.meta?.model, usage);
      }
    },
    ledger(): SessionLedger {
      return { ...ledger };
    },
    async markTurn(turnId: string, status: TurnStatus): Promise<void> {
      turnStatuses.set(turnId, status);
      if (status === 'ok') ledger.turns += 1;
    },
    turnStatuses,
  };
}
