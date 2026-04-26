import { describe, expect, it } from 'vitest';
import {
  buildLongTermMemoryContext,
  type LongTermMemoryCandidate,
} from '../main/memory/long-term-memory';

describe('buildLongTermMemoryContext', () => {
  it('prefers relevant snippets from earlier sessions', () => {
    const candidates: LongTermMemoryCandidate[] = [
      {
        sessionId: 'session-1',
        sessionTitle: 'Fix auth callback',
        role: 'user',
        text: 'Investigate the OAuth callback mismatch in the login flow.',
        timestamp: Date.UTC(2026, 3, 24),
      },
      {
        sessionId: 'session-1',
        sessionTitle: 'Fix auth callback',
        role: 'assistant',
        text: 'The root cause was the missing redirect URI normalization.',
        timestamp: Date.UTC(2026, 3, 24, 0, 5),
      },
      {
        sessionId: 'session-2',
        sessionTitle: 'Landing page polish',
        role: 'user',
        text: 'Adjust the marketing hero spacing on the homepage.',
        timestamp: Date.UTC(2026, 3, 23),
      },
    ];

    const result = buildLongTermMemoryContext('Continue the OAuth login fix.', candidates, {
      now: Date.UTC(2026, 3, 26),
    });

    expect(result).toContain('Relevant context remembered from earlier sessions');
    expect(result).toContain('OAuth callback mismatch');
    expect(result).toContain('redirect URI normalization');
    expect(result).not.toContain('marketing hero spacing');
  });

  it('supports Chinese prompts by matching CJK terms', () => {
    const candidates: LongTermMemoryCandidate[] = [
      {
        sessionId: 'session-3',
        sessionTitle: '长期记忆支持',
        role: 'assistant',
        text: '已经为长期记忆增加了跨会话检索逻辑。',
        timestamp: Date.UTC(2026, 3, 25),
      },
      {
        sessionId: 'session-4',
        sessionTitle: '日志清理',
        role: 'assistant',
        text: '整理了日志输出格式。',
        timestamp: Date.UTC(2026, 3, 24),
      },
    ];

    const result = buildLongTermMemoryContext('继续完善长期记忆功能', candidates, {
      now: Date.UTC(2026, 3, 26),
    });

    expect(result).toContain('长期记忆');
    expect(result).toContain('跨会话检索逻辑');
    expect(result).not.toContain('日志输出格式');
  });

  it('returns null when there is no usable memory', () => {
    expect(buildLongTermMemoryContext('anything', [])).toBeNull();
  });
});
