import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateWorkspaceMemoryWithClaudeSdk: vi.fn(),
}));

vi.mock('../src/main/claude/claude-sdk-one-shot', () => ({
  generateWorkspaceMemoryWithClaudeSdk: mocks.generateWorkspaceMemoryWithClaudeSdk,
}));

import {
  composeContextualPrompt,
  getWorkspaceMemoryPath,
  getWorkspaceMemoryPromptContext,
  listWorkspaceMemoryEntries,
  readWorkspaceMemoryDocument,
  scheduleWorkspaceMemoryUpdate,
  saveWorkspaceMemoryEntries,
} from '../src/main/memory/workspace-memory';

describe('workspace-memory', () => {
  let tempDir: string;

  afterEach(() => {
    mocks.generateWorkspaceMemoryWithClaudeSdk.mockReset();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('composes contextual prompt with workspace memory before history and prompt', () => {
    expect(
      composeContextualPrompt('Current prompt', {
        workspaceMemoryPrompt: '<workspace_memory>memory</workspace_memory>',
        conversationHistoryPrompt: '<conversation_history>history</conversation_history>',
      })
    ).toBe(
      '<workspace_memory>memory</workspace_memory>\n\n<conversation_history>history</conversation_history>\n\nCurrent prompt'
    );
  });

  it('updates workspace memory in a compact shared file and exposes it for prompt injection', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-memory-'));
    mocks.generateWorkspaceMemoryWithClaudeSdk.mockResolvedValue(
      JSON.stringify({
        entries: [
          {
            category: 'user_preference',
            content:
              'Prefer PowerShell commands on Windows unless the user explicitly asks for bash.',
          },
          {
            category: 'command_rule',
            content: 'Use npm scripts in this workspace; avoid pnpm assumptions.',
          },
          {
            category: 'command_rule',
            content: 'Use npm scripts in this workspace; avoid pnpm assumptions.',
          },
        ],
      })
    );

    await scheduleWorkspaceMemoryUpdate({
      workspaceDir: tempDir,
      userMessage: {
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: [
          { type: 'text', text: '以后在这个项目里优先给我 PowerShell 命令，而且这里用 npm。' },
        ],
        timestamp: 1,
      },
      assistantMessages: [
        {
          id: 'a1',
          sessionId: 's1',
          role: 'assistant',
          content: [{ type: 'text', text: '我会按 PowerShell 和 npm 约定来处理。' }],
          timestamp: 2,
        },
      ],
      config: { provider: 'anthropic', model: 'claude-3-5-sonnet' } as never,
    });

    const memoryPath = getWorkspaceMemoryPath(tempDir);
    expect(memoryPath).toBeTruthy();
    expect(memoryPath && fs.existsSync(memoryPath)).toBe(true);

    const document = readWorkspaceMemoryDocument(tempDir);
    expect(document?.entries).toHaveLength(2);
    expect(document?.entries[0]?.content).toContain('Prefer PowerShell commands');

    const promptContext = getWorkspaceMemoryPromptContext(tempDir);
    expect(promptContext.entryCount).toBe(2);
    expect(promptContext.prompt).toContain('<workspace_memory>');
    expect(promptContext.prompt).toContain(
      'command_rule: Use npm scripts in this workspace; avoid pnpm assumptions.'
    );
  });

  it('supports explicit save and read operations for workspace memory tools', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-memory-'));

    const document = saveWorkspaceMemoryEntries(tempDir, [
      {
        category: 'os',
        content:
          'This workspace is primarily used on Windows and shell examples should default to PowerShell.',
      },
      {
        category: 'dependency',
        content:
          'Use npm in this repo unless the user explicitly asks for another package manager.',
      },
    ]);

    expect(document?.entries).toHaveLength(2);
    expect(listWorkspaceMemoryEntries(tempDir)).toHaveLength(2);
    expect(listWorkspaceMemoryEntries(tempDir, { category: 'os' })).toEqual([
      expect.objectContaining({ category: 'os' }),
    ]);
    expect(listWorkspaceMemoryEntries(tempDir, { query: 'package manager' })).toEqual([
      expect.objectContaining({ category: 'dependency' }),
    ]);
  });
});
