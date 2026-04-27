import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance } from '../src/main/db/database';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-session-manager-workspace-memory-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }
  }

  return { default: MockStore };
});

vi.mock('../src/main/claude/agent-runner', () => ({
  ClaudeAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

const memoryMocks = vi.hoisted(() => ({
  scheduleWorkspaceMemoryUpdate: vi.fn(async () => undefined),
}));

vi.mock('../src/main/memory/workspace-memory', () => ({
  scheduleWorkspaceMemoryUpdate: memoryMocks.scheduleWorkspaceMemoryUpdate,
}));

import { configStore } from '../src/main/config/config-store';
import { SessionManager } from '../src/main/session/session-manager';
import { scheduleWorkspaceMemoryUpdate } from '../src/main/memory/workspace-memory';

const mockedScheduleWorkspaceMemoryUpdate = vi.mocked(scheduleWorkspaceMemoryUpdate);

function makeDb(overrides: Partial<DatabaseInstance> = {}): DatabaseInstance {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
    ...overrides,
  } as unknown as DatabaseInstance;
}

describe('SessionManager workspace memory updates', () => {
  beforeEach(() => {
    mockedScheduleWorkspaceMemoryUpdate.mockClear();
    configStore.set('provider', 'openai');
    configStore.set('customProtocol', 'openai');
    configStore.set('apiKey', 'sk-test');
    configStore.set('model', 'gpt-4.1');
  });

  it('routes new assistant messages into shared workspace memory updates', async () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => ({
          id: 's1',
          title: 'Session',
          claude_session_id: null,
          openai_thread_id: null,
          status: 'idle',
          cwd: '/tmp/workspace',
          mounted_paths: '[]',
          allowed_tools: '[]',
          memory_enabled: 0,
          model: 'gpt-4.1',
          created_at: 1,
          updated_at: 2,
        })),
        getAll: vi.fn(() => []),
        update: vi.fn(),
        delete: vi.fn(),
      } as never,
      messages: {
        create: vi.fn(),
        getBySessionId: vi.fn(() => [
          {
            id: 'old',
            session_id: 's1',
            role: 'assistant',
            content: JSON.stringify([{ type: 'text', text: 'old reply' }]),
            timestamp: 1,
            token_usage: null,
            execution_time_ms: null,
          },
          {
            id: 'user',
            session_id: 's1',
            role: 'user',
            content: JSON.stringify([{ type: 'text', text: '以后优先给我 PowerShell 命令' }]),
            timestamp: 2,
            token_usage: null,
            execution_time_ms: null,
          },
          {
            id: 'assistant',
            session_id: 's1',
            role: 'assistant',
            content: JSON.stringify([{ type: 'text', text: '后续我会优先使用 PowerShell。' }]),
            timestamp: 3,
            token_usage: null,
            execution_time_ms: null,
          },
        ]),
        update: vi.fn(),
        delete: vi.fn(),
        deleteBySessionId: vi.fn(),
      } as never,
    });

    const manager = new SessionManager(db, vi.fn());
    const proto = SessionManager.prototype as unknown as {
      runWorkspaceMemoryUpdate(
        session: { id: string; cwd?: string },
        userMessage: {
          id: string;
          sessionId: string;
          role: 'user';
          content: Array<{ type: 'text'; text: string }>;
          timestamp: number;
        },
        messageCountBeforeAssistantMessages: number
      ): Promise<void>;
    };

    await proto.runWorkspaceMemoryUpdate.call(
      manager,
      { id: 's1', cwd: '/tmp/workspace' },
      {
        id: 'user',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'text', text: '以后优先给我 PowerShell 命令' }],
        timestamp: 2,
      },
      2
    );

    expect(mockedScheduleWorkspaceMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(mockedScheduleWorkspaceMemoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: '/tmp/workspace',
        assistantMessages: [
          expect.objectContaining({
            role: 'assistant',
            content: [{ type: 'text', text: '后续我会优先使用 PowerShell。' }],
          }),
        ],
        config: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4.1',
        }),
      })
    );
  });
});
