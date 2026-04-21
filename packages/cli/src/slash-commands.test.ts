import { describe, expect, test } from 'bun:test';
import { parseSlash } from './slash-commands.js';

describe('parseSlash', () => {
  test('returns null for non-slash input', () => {
    expect(parseSlash('hello world')).toBeNull();
    expect(parseSlash('')).toBeNull();
  });

  test('parses simple commands', () => {
    expect(parseSlash('/help')).toEqual({ kind: 'help' });
    expect(parseSlash('/?')).toEqual({ kind: 'help' });
    expect(parseSlash('/cost')).toEqual({ kind: 'cost' });
    expect(parseSlash('/clear')).toEqual({ kind: 'clear' });
    expect(parseSlash('/exit')).toEqual({ kind: 'exit' });
    expect(parseSlash('/quit')).toEqual({ kind: 'exit' });
    expect(parseSlash('/sessions')).toEqual({ kind: 'sessions' });
    expect(parseSlash('/plan')).toEqual({ kind: 'plan' });
  });

  test('parses /mode with valid argument', () => {
    expect(parseSlash('/mode default')).toEqual({
      kind: 'mode',
      mode: 'default',
    });
    expect(parseSlash('/mode bypass')).toEqual({
      kind: 'mode',
      mode: 'bypass',
    });
    expect(parseSlash('/mode auto')).toEqual({ kind: 'mode', mode: 'auto' });
    expect(parseSlash('/mode plan')).toEqual({ kind: 'mode', mode: 'plan' });
  });

  test('/mode with invalid arg is unknown', () => {
    expect(parseSlash('/mode garbage')).toEqual({
      kind: 'unknown',
      name: 'mode',
    });
    expect(parseSlash('/mode')).toEqual({ kind: 'unknown', name: 'mode' });
  });

  test('parses /model with and without id', () => {
    expect(parseSlash('/model')).toEqual({ kind: 'model' });
    expect(parseSlash('/model claude-opus-4-6')).toEqual({
      kind: 'model',
      model: 'claude-opus-4-6',
    });
    expect(parseSlash('/model anthropic/claude-3.5-sonnet')).toEqual({
      kind: 'model',
      model: 'anthropic/claude-3.5-sonnet',
    });
    expect(parseSlash('/model refresh')).toEqual({
      kind: 'model',
      refresh: true,
    });
  });

  test('parses /resume optionally with id', () => {
    expect(parseSlash('/resume')).toEqual({ kind: 'resume' });
    expect(parseSlash('/resume abc-123')).toEqual({
      kind: 'resume',
      sessionId: 'abc-123',
    });
  });

  test('returns unknown for unrecognized command', () => {
    expect(parseSlash('/foo')).toEqual({ kind: 'unknown', name: 'foo' });
    expect(parseSlash('/')).toEqual({ kind: 'unknown', name: '' });
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseSlash('/help   ')).toEqual({ kind: 'help' });
    expect(parseSlash('/resume   xyz')).toEqual({
      kind: 'resume',
      sessionId: 'xyz',
    });
  });

  test('/plan with no args stays as the mode alias', () => {
    expect(parseSlash('/plan')).toEqual({ kind: 'plan' });
    expect(parseSlash('/plan   ')).toEqual({ kind: 'plan' });
  });

  test('/plan <description> hands off to the builder propose flow', () => {
    expect(parseSlash('/plan add a pr-review skill')).toEqual({
      kind: 'planPropose',
      description: 'add a pr-review skill',
    });
  });

  test('/yes with and without a phrase', () => {
    expect(parseSlash('/yes')).toEqual({ kind: 'proposalYes' });
    expect(parseSlash('/yes deploy')).toEqual({ kind: 'proposalYes', phrase: 'deploy' });
    expect(parseSlash('/yes deploy now')).toEqual({
      kind: 'proposalYes',
      phrase: 'deploy now',
    });
  });

  test('/no rejects the active proposal', () => {
    expect(parseSlash('/no')).toEqual({ kind: 'proposalNo' });
  });

  test('/edit parses <n> and consumes the rest as replacement', () => {
    expect(parseSlash('/edit 1 revise step')).toEqual({
      kind: 'proposalEdit',
      stepNumber: 1,
      replacement: 'revise step',
    });
    expect(parseSlash('/edit 3 create skills/pr-review.md (revised)')).toEqual({
      kind: 'proposalEdit',
      stepNumber: 3,
      replacement: 'create skills/pr-review.md (revised)',
    });
  });

  test('/edit emits a usage error on malformed input', () => {
    expect(parseSlash('/edit')).toEqual({
      kind: 'proposalEditInvalid',
      reason: 'usage: /edit <n> <replacement>',
    });
    expect(parseSlash('/edit 1')).toEqual({
      kind: 'proposalEditInvalid',
      reason: 'usage: /edit <n> <replacement>',
    });
    expect(parseSlash('/edit zero something')).toEqual({
      kind: 'proposalEditInvalid',
      reason: 'step number must be a positive integer, got "zero"',
    });
    expect(parseSlash('/edit -1 something')).toEqual({
      kind: 'proposalEditInvalid',
      reason: 'step number must be a positive integer, got "-1"',
    });
  });

  test('/diff with and without a path', () => {
    expect(parseSlash('/diff')).toEqual({ kind: 'diff' });
    expect(parseSlash('/diff agent.yaml')).toEqual({ kind: 'diff', path: 'agent.yaml' });
  });

  test('/scope has no args', () => {
    expect(parseSlash('/scope')).toEqual({ kind: 'scope' });
  });

  test('/fleet graph with and without a format', () => {
    expect(parseSlash('/fleet graph')).toEqual({ kind: 'fleetGraph' });
    expect(parseSlash('/fleet graph mermaid')).toEqual({ kind: 'fleetGraph', format: 'mermaid' });
    expect(parseSlash('/fleet graph dot')).toEqual({ kind: 'fleetGraph', format: 'dot' });
    expect(parseSlash('/fleet graph json')).toEqual({ kind: 'fleetGraph', format: 'json' });
  });

  test('/fleet without a sub-verb is unknown', () => {
    expect(parseSlash('/fleet')).toEqual({ kind: 'unknown', name: 'fleet' });
    expect(parseSlash('/fleet deploy')).toEqual({ kind: 'unknown', name: 'fleet' });
    expect(parseSlash('/fleet graph yaml')).toEqual({ kind: 'unknown', name: 'fleet graph' });
  });

  test('/undo parses without arguments', () => {
    expect(parseSlash('/undo')).toEqual({ kind: 'undo' });
  });

  test('/history accepts an optional limit', () => {
    expect(parseSlash('/history')).toEqual({ kind: 'history' });
    expect(parseSlash('/history 10')).toEqual({ kind: 'history', limit: 10 });
    // Non-numeric / negative args fall back to the default.
    expect(parseSlash('/history abc')).toEqual({ kind: 'history' });
    expect(parseSlash('/history -1')).toEqual({ kind: 'history' });
  });

  test('/init parses template + --force flag', () => {
    expect(parseSlash('/init')).toEqual({ kind: 'init' });
    expect(parseSlash('/init pr-review')).toEqual({ kind: 'init', template: 'pr-review' });
    expect(parseSlash('/init concierge --force')).toEqual({
      kind: 'init',
      template: 'concierge',
      force: true,
    });
    expect(parseSlash('/init --force')).toEqual({ kind: 'init', force: true });
    expect(parseSlash('/init -f oncall-escalator')).toEqual({
      kind: 'init',
      template: 'oncall-escalator',
      force: true,
    });
  });

  test('/prompt captures the path as-is (supports spaces)', () => {
    expect(parseSlash('/prompt /tmp/brief.md')).toEqual({
      kind: 'prompt',
      path: '/tmp/brief.md',
    });
    expect(parseSlash('/prompt ./notes/contract review.txt')).toEqual({
      kind: 'prompt',
      path: './notes/contract review.txt',
    });
  });

  test('/prompt without a path surfaces a usage message', () => {
    expect(parseSlash('/prompt')).toEqual({
      kind: 'promptInvalid',
      reason: 'usage: /prompt <path>',
    });
    expect(parseSlash('/prompt   ')).toEqual({
      kind: 'promptInvalid',
      reason: 'usage: /prompt <path>',
    });
  });
});
