import type { LLMProvider, LLMRequest, LLMResponse } from '../types/llm.js';
import type { Message } from '../types/messages.js';

/**
 * Scriptable LLMProvider for tests. Yields canned responses in order; throws
 * when exhausted so a runaway loop is obvious.
 */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  private index = 0;
  readonly requests: LLMRequest[] = [];

  constructor(private readonly responses: LLMResponse[]) {}

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(
        `FakeProvider: exhausted after ${this.index} response(s). Extra call received.`,
      );
    }
    this.index += 1;
    return response;
  }

  async countTokens(_messages: Message[]): Promise<number> {
    return 0;
  }

  get callCount(): number {
    return this.index;
  }
}
