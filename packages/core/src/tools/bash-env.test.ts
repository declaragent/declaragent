import { describe, expect, test } from 'bun:test';
import {
  BASH_ENV_KEEP_SET,
  type BashEnvPolicy,
  looksSecret,
  parseEnvKeyList,
  resolveBashEnvPolicy,
  scrubBashEnv,
} from './bash-env.js';

describe('looksSecret', () => {
  test.each([
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SESSION_TOKEN',
    'DECLARAGENT_CONTROL_PLANE_TOKEN',
    'GITHUB_TOKEN',
    'DB_PASSWORD',
    'SERVICE_PASSWD',
    'TLS_PRIVATE_KEY',
    'SOME_CREDENTIAL',
    'KAFKA_SASL_PASSWORD',
  ])('flags %s as secret', (key) => {
    expect(looksSecret(key)).toBe(true);
  });

  test.each(['PATH', 'HOME', 'NODE_ENV', 'PASSENGER_COUNT', 'TOKENIZER_PATH', 'AUTHOR'])(
    'does not flag %s',
    (key) => {
      expect(looksSecret(key)).toBe(false);
    },
  );
});

describe('scrubBashEnv (default mode)', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    NODE_ENV: 'production',
    ANTHROPIC_API_KEY: 'sk-secret',
    OPENROUTER_API_KEY: 'or-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'ghp_secret',
    HARMLESS_VAR: 'ok',
  };

  test('strips secret-looking keys, keeps the rest', () => {
    const out = scrubBashEnv(source);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/agent');
    expect(out.NODE_ENV).toBe('production');
    expect(out.HARMLESS_VAR).toBe('ok');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENROUTER_API_KEY).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
  });

  test('keep-set survives', () => {
    for (const key of BASH_ENV_KEEP_SET) {
      const out = scrubBashEnv({ [key]: 'v', ANTHROPIC_API_KEY: 'x' });
      expect(out[key]).toBe('v');
      expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });

  test('skips undefined values', () => {
    const out = scrubBashEnv({ PATH: '/bin', UNSET: undefined });
    expect(out.PATH).toBe('/bin');
    expect('UNSET' in out).toBe(false);
  });

  test('explicit denylist removes non-secret keys', () => {
    const out = scrubBashEnv(
      { PATH: '/bin', INTERNAL_URL: 'http://x', NODE_ENV: 'p' },
      {
        denylist: ['INTERNAL_URL'],
      },
    );
    expect(out.PATH).toBe('/bin');
    expect(out.NODE_ENV).toBe('p');
    expect(out.INTERNAL_URL).toBeUndefined();
  });

  test('denylist cannot strip the keep-set', () => {
    const out = scrubBashEnv({ PATH: '/bin' }, { denylist: ['PATH'] });
    expect(out.PATH).toBe('/bin');
  });
});

describe('scrubBashEnv (allowlist mode)', () => {
  test('passes only keep-set + allowlisted keys', () => {
    const source = {
      PATH: '/bin',
      HOME: '/h',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: 'sk',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
    };
    const policy: BashEnvPolicy = { allowlist: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] };
    const out = scrubBashEnv(source, policy);
    // keep-set retained
    expect(out.PATH).toBe('/bin');
    expect(out.HOME).toBe('/h');
    // explicitly allowed secrets pass (operator's choice)
    expect(out.AWS_ACCESS_KEY_ID).toBe('AKIA');
    expect(out.AWS_SECRET_ACCESS_KEY).toBe('secret');
    // everything else (even non-secret) is excluded
    expect(out.NODE_ENV).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('allowlist is case-insensitive', () => {
    const out = scrubBashEnv({ MY_VAR: 'v', OTHER: 'x' }, { allowlist: ['my_var'] });
    expect(out.MY_VAR).toBe('v');
    expect(out.OTHER).toBeUndefined();
  });
});

describe('parseEnvKeyList', () => {
  test('splits on comma / space / colon', () => {
    expect(parseEnvKeyList('A,B C:D')).toEqual(['A', 'B', 'C', 'D']);
  });
  test('empty / undefined → []', () => {
    expect(parseEnvKeyList(undefined)).toEqual([]);
    expect(parseEnvKeyList('')).toEqual([]);
    expect(parseEnvKeyList('  ')).toEqual([]);
  });
});

describe('resolveBashEnvPolicy', () => {
  test('reads allow + deny env vars', () => {
    const policy = resolveBashEnvPolicy({
      DECLARAGENT_BASH_ENV_ALLOW: 'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
      DECLARAGENT_BASH_ENV_DENY: 'INTERNAL_URL',
    });
    expect(policy.allowlist).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    expect(policy.denylist).toEqual(['INTERNAL_URL']);
  });
  test('absent vars → empty policy (default-scrub)', () => {
    const policy = resolveBashEnvPolicy({});
    expect(policy.allowlist).toBeUndefined();
    expect(policy.denylist).toBeUndefined();
  });
});
