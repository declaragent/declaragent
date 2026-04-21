import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { builderEnabled, getBuilderTools } from './register.js';

describe('builderEnabled', () => {
  test('true only when DECLARAGENT_BUILDER === "on"', () => {
    expect(builderEnabled({ DECLARAGENT_BUILDER: 'on' })).toBe(true);
    expect(builderEnabled({ DECLARAGENT_BUILDER: 'ON' })).toBe(false);
    expect(builderEnabled({ DECLARAGENT_BUILDER: '1' })).toBe(false);
    expect(builderEnabled({})).toBe(false);
  });
});

describe('getBuilderTools', () => {
  const prev = process.env.DECLARAGENT_BUILDER;

  beforeEach(() => {
    Reflect.deleteProperty(process.env, 'DECLARAGENT_BUILDER');
  });
  afterEach(() => {
    if (prev === undefined) {
      Reflect.deleteProperty(process.env, 'DECLARAGENT_BUILDER');
    } else {
      process.env.DECLARAGENT_BUILDER = prev;
    }
  });

  test('returns an empty array when the env flag is off', () => {
    expect(getBuilderTools({ scopeRoot: '/tmp/x' })).toEqual([]);
  });

  test('returns the phase-5 toolkit when the env flag is on', () => {
    process.env.DECLARAGENT_BUILDER = 'on';
    const tools = getBuilderTools({ scopeRoot: '/tmp/x' });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'DeclaraAddChannel',
      'DeclaraAddMCP',
      'DeclaraAddPeer',
      'DeclaraAddPlugin',
      'DeclaraAddSecret',
      'DeclaraAddSkill',
      'DeclaraAddSource',
      'DeclaraApplyChange',
      'DeclaraAuditVerify',
      'DeclaraAuthPlaybook',
      'DeclaraDlqShow',
      'DeclaraEventsTail',
      'DeclaraFleetAdd',
      'DeclaraFleetStatus',
      'DeclaraProposeChange',
    ]);
  });
});
