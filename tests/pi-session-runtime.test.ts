import { describe, expect, it } from 'vitest';
import { buildPiSessionRuntimeSignature } from '../src/main/claude/pi-session-runtime';

describe('pi session runtime signature', () => {
  const baseInput = {
    configProvider: 'custom',
    customProtocol: 'openai',
    modelProvider: 'openai',
    modelApi: 'openai-completions',
    modelBaseUrl: 'https://relay.example.com/v1',
    effectiveCwd: '/workspace/demo',
    apiKey: 'sk-demo-key',
  };

  it('changes when provider runtime changes even if the session id stays the same', () => {
    const original = buildPiSessionRuntimeSignature(baseInput);
    const changedProvider = buildPiSessionRuntimeSignature({
      ...baseInput,
      configProvider: 'openrouter',
    });

    expect(changedProvider).not.toBe(original);
  });

  it('changes when base url, api, key, or cwd changes', () => {
    const original = buildPiSessionRuntimeSignature(baseInput);

    expect(
      buildPiSessionRuntimeSignature({
        ...baseInput,
        modelBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      })
    ).not.toBe(original);

    expect(
      buildPiSessionRuntimeSignature({
        ...baseInput,
        modelApi: 'openai-responses',
      })
    ).not.toBe(original);

    expect(
      buildPiSessionRuntimeSignature({
        ...baseInput,
        apiKey: 'sk-another-key',
      })
    ).not.toBe(original);

    expect(
      buildPiSessionRuntimeSignature({
        ...baseInput,
        effectiveCwd: '/workspace/other',
      })
    ).not.toBe(original);
  });

  it('normalizes equivalent urls with trailing slashes', () => {
    const original = buildPiSessionRuntimeSignature(baseInput);
    const normalized = buildPiSessionRuntimeSignature({
      ...baseInput,
      modelBaseUrl: 'https://relay.example.com/v1/',
    });

    expect(normalized).toBe(original);
  });

  it('changes when the custom tool set changes', () => {
    const original = buildPiSessionRuntimeSignature({
      ...baseInput,
      customToolNames: ['read_workspace_memory', 'mcp_list_servers'],
    });

    const changed = buildPiSessionRuntimeSignature({
      ...baseInput,
      customToolNames: [
        'read_workspace_memory',
        'mcp_list_servers',
        'mcp__Chrome__browser_navigate',
      ],
    });

    expect(changed).not.toBe(original);
  });

  it('normalizes custom tool names ordering', () => {
    const original = buildPiSessionRuntimeSignature({
      ...baseInput,
      customToolNames: ['mcp_list_servers', 'read_workspace_memory'],
    });

    const reordered = buildPiSessionRuntimeSignature({
      ...baseInput,
      customToolNames: ['read_workspace_memory', 'mcp_list_servers'],
    });

    expect(reordered).toBe(original);
  });
});
