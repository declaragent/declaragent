import { describe, expect, it } from 'bun:test';
import { createAllowListEnroller, matchAllowList } from './enroller.js';
import type { AllowListEnrollerConfig, ChannelPrincipal } from './types.js';

function principal(overrides: Partial<ChannelPrincipal> = {}): ChannelPrincipal {
  return {
    channelId: 'slack-prod',
    platformUserId: 'U0ALICE',
    scopes: [],
    verified: false,
    ...overrides,
  };
}

describe('createAllowListEnroller', () => {
  it('returns the mapped agentUserId on a glob match', async () => {
    const enroller = createAllowListEnroller({
      entries: [{ platformUserIdPattern: 'U0*', agentUserId: 'alice@example.com' }],
    });
    const agentUser = await enroller.resolve(principal());
    expect(agentUser).toBe('alice@example.com');
  });

  it('returns undefined when no entry matches', async () => {
    const enroller = createAllowListEnroller({
      entries: [{ platformUserIdPattern: 'admin-*', agentUserId: 'admin@example.com' }],
    });
    const agentUser = await enroller.resolve(principal());
    expect(agentUser).toBeUndefined();
  });

  it('scopes an entry to a channel when channelId is set', async () => {
    const enroller = createAllowListEnroller({
      entries: [
        {
          platformUserIdPattern: 'U0*',
          agentUserId: 'slack-user',
          channelId: 'slack-prod',
        },
      ],
    });
    expect(await enroller.resolve(principal({ channelId: 'slack-prod' }))).toBe('slack-user');
    expect(await enroller.resolve(principal({ channelId: 'slack-other' }))).toBeUndefined();
  });

  it('ignores channelId filter when entry omits it', async () => {
    const enroller = createAllowListEnroller({
      entries: [{ platformUserIdPattern: '*', agentUserId: 'everyone' }],
    });
    expect(await enroller.resolve(principal({ channelId: 'telegram-main' }))).toBe('everyone');
    expect(await enroller.resolve(principal({ channelId: 'discord-main' }))).toBe('everyone');
  });

  it('respects first-match ordering', async () => {
    const config: AllowListEnrollerConfig = {
      entries: [
        { platformUserIdPattern: 'U0ADMIN*', agentUserId: 'admin' },
        { platformUserIdPattern: 'U0*', agentUserId: 'member' },
      ],
    };
    expect(matchAllowList(principal({ platformUserId: 'U0ADMIN1' }), config)).toBe('admin');
    expect(matchAllowList(principal({ platformUserId: 'U0ALICE' }), config)).toBe('member');
  });

  it('exposes a sync matcher for callers that want to bypass promises', () => {
    const config: AllowListEnrollerConfig = {
      entries: [{ platformUserIdPattern: 'U0*', agentUserId: 'alice' }],
    };
    expect(matchAllowList(principal(), config)).toBe('alice');
  });
});
