import { describe, expect, test } from 'bun:test';
import { createPermissionGate } from '../permission/gate.js';
import { findOverride, resolveForChannel } from './permissions.js';
import type { ChannelPermissionsConfig, ChannelPrincipal } from './types.js';

function principal(overrides: Partial<ChannelPrincipal> = {}): ChannelPrincipal {
  return {
    channelId: 'slack-prod',
    platformUserId: 'U0ALICE',
    scopes: [],
    verified: false,
    ...overrides,
  };
}

describe('resolveForChannel', () => {
  test('returns an empty default config when no channel permissions are set', () => {
    const cfg = resolveForChannel(principal(), undefined);
    expect(cfg.mode).toBe('default');
    expect(cfg.rules).toEqual([]);
  });

  test('passes channel base rules through when no user override matches', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['Read(**/*)', 'mcp__calendar__*'],
      deny: ['Bash(*)'],
    };
    const cfg = resolveForChannel(principal(), perms);
    expect(cfg.mode).toBe('auto');
    expect(cfg.rules).toEqual([
      { pattern: 'Bash(*)', decision: 'deny' },
      { pattern: 'Read(**/*)', decision: 'allow' },
      { pattern: 'mcp__calendar__*', decision: 'allow' },
    ]);
  });

  test('user override replaces allow list on match', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['Read(**/*)'],
      deny: ['Bash(*)'],
      userOverrides: [{ platformUserIdPattern: 'U0ADMIN*', allow: ['*'] }],
    };
    const cfg = resolveForChannel(principal({ platformUserId: 'U0ADMIN1' }), perms);
    expect(cfg.rules).toEqual([
      { pattern: 'Bash(*)', decision: 'deny' },
      { pattern: '*', decision: 'allow' },
    ]);
  });

  test('user override denies union-merge with base denies', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['Read(**/*)'],
      deny: ['Bash(*)'],
      userOverrides: [
        {
          platformUserIdPattern: 'U0BOT*',
          deny: ['Read(**/*)', 'mcp__*'],
        },
      ],
    };
    const cfg = resolveForChannel(principal({ platformUserId: 'U0BOTZ' }), perms);
    // Deny patterns sorted by insertion; both base + override denies present.
    const denyPatterns = cfg.rules
      .filter((r) => r.decision === 'deny')
      .map((r) => r.pattern)
      .sort();
    expect(denyPatterns).toEqual(['Bash(*)', 'Read(**/*)', 'mcp__*']);
    // Base allow passes through because override had no allow entry.
    const allowPatterns = cfg.rules.filter((r) => r.decision === 'allow').map((r) => r.pattern);
    expect(allowPatterns).toEqual(['Read(**/*)']);
  });

  test('longest-pattern override wins over shorter', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['Read(**/*)'],
      userOverrides: [
        { platformUserIdPattern: 'U0*', allow: ['Read(**/*)'] },
        { platformUserIdPattern: 'U0ADMIN*', allow: ['*'] },
      ],
    };
    const cfg = resolveForChannel(principal({ platformUserId: 'U0ADMINX' }), perms);
    const allowPatterns = cfg.rules.filter((r) => r.decision === 'allow').map((r) => r.pattern);
    expect(allowPatterns).toEqual(['*']);
  });

  test('mode override takes effect when the override sets one', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['Read(**/*)'],
      userOverrides: [{ platformUserIdPattern: 'U0LOCKED*', mode: 'plan', allow: [] }],
    };
    const cfg = resolveForChannel(principal({ platformUserId: 'U0LOCKEDX' }), perms);
    expect(cfg.mode).toBe('plan');
  });

  test('returns an idle config when principal is absent', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['Read(**/*)'],
      userOverrides: [{ platformUserIdPattern: '*', allow: ['*'] }],
    };
    const cfg = resolveForChannel(undefined, perms);
    // Without a principal we should not apply overrides — base only.
    const allowPatterns = cfg.rules.filter((r) => r.decision === 'allow').map((r) => r.pattern);
    expect(allowPatterns).toEqual(['Read(**/*)']);
  });

  test('ties on pattern length preserve config order', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'auto',
      allow: ['base'],
      userOverrides: [
        { platformUserIdPattern: 'U0?*', allow: ['first'] },
        { platformUserIdPattern: 'U0A*', allow: ['second'] },
      ],
    };
    const cfg = resolveForChannel(principal(), perms);
    // Both patterns match U0ALICE; both 4 chars long; first-in-config wins.
    const allows = cfg.rules.filter((r) => r.decision === 'allow').map((r) => r.pattern);
    expect(allows).toEqual(['first']);
  });

  test('produces a config that createPermissionGate accepts unchanged', () => {
    const perms: ChannelPermissionsConfig = {
      mode: 'default',
      allow: ['Read(**/*)'],
      deny: ['Bash(*)'],
      userOverrides: [{ platformUserIdPattern: 'U0ADMIN*', allow: ['*'] }],
    };
    const cfg = resolveForChannel(principal({ platformUserId: 'U0ADMIN1' }), perms);
    const gate = createPermissionGate(cfg);
    expect(gate.mode).toBe('default');
  });
});

describe('findOverride', () => {
  test('returns the matching override', () => {
    const match = findOverride(principal(), [{ platformUserIdPattern: 'U0*', allow: ['x'] }]);
    expect(match?.platformUserIdPattern).toBe('U0*');
  });

  test('returns undefined when no overrides match', () => {
    expect(
      findOverride(principal(), [{ platformUserIdPattern: 'ADMIN-*', allow: ['x'] }]),
    ).toBeUndefined();
  });

  test('returns undefined when overrides is empty or missing', () => {
    expect(findOverride(principal(), undefined)).toBeUndefined();
    expect(findOverride(principal(), [])).toBeUndefined();
  });
});
