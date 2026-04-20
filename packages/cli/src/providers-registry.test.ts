import { describe, expect, test } from 'bun:test';
import { getPreset, listPresetIds, listPresets } from './providers-registry.js';

describe('provider registry', () => {
  test('exposes all expected presets', () => {
    const ids = listPresetIds();
    for (const id of ['anthropic', 'openai', 'openrouter', 'groq', 'ollama']) {
      expect(ids).toContain(id);
    }
  });

  test('every preset has required fields', () => {
    for (const p of listPresets()) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(['anthropic', 'openai-compat']).toContain(p.kind);
      expect(['cloud', 'local']).toContain(p.hosting);
      if (p.kind === 'openai-compat') {
        expect(p.baseURL).toBeTruthy();
      }
    }
  });

  test('getPreset returns undefined for unknown ids', () => {
    expect(getPreset('mystery')).toBeUndefined();
  });

  test('getPreset finds known presets', () => {
    expect(getPreset('openrouter')?.kind).toBe('openai-compat');
    expect(getPreset('anthropic')?.kind).toBe('anthropic');
  });

  test('all preset ids are unique', () => {
    const ids = listPresetIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
