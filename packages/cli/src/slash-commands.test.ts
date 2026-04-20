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
});
