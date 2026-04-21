import { describe, expect, test } from 'bun:test';
import { assertEventTarget } from './target-validate.js';

describe('assertEventTarget', () => {
  test('accepts every known target type', () => {
    for (const type of ['session', 'new-session', 'skill', 'sub-agent', 'broadcast']) {
      expect(() => assertEventTarget({ type, name: 'x' }, 'test')).not.toThrow();
    }
  });

  test('rejects a target whose type field is missing', () => {
    expect(() => assertEventTarget({ name: 'x' }, 'webhook')).toThrow(
      /target\.type must be a non-empty string/,
    );
  });

  test('surfaces the common `kind`→`type` mistake with a rewrite hint', () => {
    expect(() => assertEventTarget({ kind: 'skill', name: 'extract' }, 'webhook')).toThrow(
      /uses "kind".*Replace with `type: skill`/s,
    );
  });

  test('rejects an unknown target type verb', () => {
    expect(() => assertEventTarget({ type: 'telemetry' }, 'cron')).toThrow(
      /cron target\.type "telemetry" is not a known EventTarget kind/,
    );
  });

  test('rejects non-object targets', () => {
    expect(() => assertEventTarget('skill', 'file-watch')).toThrow(
      /file-watch trigger config requires an object "target"/,
    );
    expect(() => assertEventTarget(null, 'file-watch')).toThrow(
      /file-watch trigger config requires an object "target"/,
    );
    expect(() => assertEventTarget(undefined, 'file-watch')).toThrow(
      /file-watch trigger config requires an object "target"/,
    );
  });
});
