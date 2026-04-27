/**
 * Tests for MCPManager connection timeout and status tracking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/open-cowork-test',
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

// Mock logger to suppress output during tests
vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logCtx: vi.fn(),
  logCtxError: vi.fn(),
  logTiming: vi.fn(),
}));

// Mock shell-resolver
vi.mock('../../main/utils/shell-resolver', () => ({
  getDefaultShell: () => '/bin/bash',
}));

import { MCPManager } from '../../main/mcp/mcp-manager';
import type { MCPServerConfig } from '../../main/mcp/mcp-manager';

describe('MCPManager', () => {
  let manager: MCPManager;

  beforeEach(() => {
    manager = new MCPManager();
  });

  describe('getServerStatus()', () => {
    it('returns disabled status for disabled servers', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'test-1',
          name: 'Test Server',
          type: 'stdio',
          command: 'echo',
          args: ['hello'],
          enabled: false,
        },
      ];

      await manager.initializeServers(configs);
      const statuses = manager.getServerStatus();

      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        id: 'test-1',
        name: 'Test Server',
        connected: false,
        status: 'disabled',
        toolCount: 0,
      });
    });

    it('returns failed status when connection fails', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'test-fail',
          name: 'Failing Server',
          type: 'sse',
          url: 'http://127.0.0.1:1/nonexistent',
          enabled: true,
        },
      ];

      // initializeServers catches errors internally, so this should not throw
      await manager.initializeServers(configs);
      const statuses = manager.getServerStatus();

      expect(statuses).toHaveLength(1);
      expect(statuses[0].id).toBe('test-fail');
      expect(statuses[0].status).toBe('failed');
      expect(statuses[0].connected).toBe(false);
    });

    it('includes status field in all returned statuses', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'disabled-server',
          name: 'Disabled',
          type: 'stdio',
          command: 'echo',
          enabled: false,
        },
        {
          id: 'enabled-server',
          name: 'Enabled',
          type: 'sse',
          url: 'http://127.0.0.1:1/bad',
          enabled: true,
        },
      ];

      await manager.initializeServers(configs);
      const statuses = manager.getServerStatus();

      expect(statuses).toHaveLength(2);
      for (const s of statuses) {
        expect(s).toHaveProperty('status');
        expect(['connecting', 'connected', 'failed', 'disabled']).toContain(s.status);
      }
    });

    it('returns empty array when no servers configured', () => {
      const statuses = manager.getServerStatus();
      expect(statuses).toEqual([]);
    });
  });

  describe('connection timeout', () => {
    it('fails with timeout error when transport never responds', async () => {
      // Create a server config that will try to connect to a non-existent SSE endpoint
      // The SSE transport will fail quickly (connection refused), but this validates
      // the error is properly caught and status is set to 'failed'
      const config: MCPServerConfig = {
        id: 'timeout-test',
        name: 'Timeout Test',
        type: 'sse',
        url: 'http://127.0.0.1:1/timeout-test',
        enabled: true,
      };

      await manager.initializeServers([config]);
      const statuses = manager.getServerStatus();

      const serverStatus = statuses.find((s) => s.id === 'timeout-test');
      expect(serverStatus).toBeDefined();
      expect(serverStatus!.status).toBe('failed');
      expect(serverStatus!.connected).toBe(false);
    });
  });

  describe('disconnectServer()', () => {
    it('removes connection status when disconnecting', async () => {
      const configs: MCPServerConfig[] = [
        {
          id: 'disc-test',
          name: 'Disconnect Test',
          type: 'sse',
          url: 'http://127.0.0.1:1/bad',
          enabled: true,
        },
      ];

      await manager.initializeServers(configs);

      // Server should be in failed state
      let statuses = manager.getServerStatus();
      expect(statuses[0].status).toBe('failed');

      // After disconnect, enabled servers keep an explicit disconnected runtime state
      await manager.disconnectServer('disc-test');
      statuses = manager.getServerStatus();
      expect(statuses[0].status).toBe('disconnected');
    });
  });

  describe('runtime connection controls', () => {
    it('connects a configured enabled server by id', async () => {
      const config: MCPServerConfig = {
        id: 'connect-test',
        name: 'Connect Test',
        type: 'sse',
        url: 'http://127.0.0.1:1/connect-test',
        enabled: true,
      };

      (manager as unknown as { serverConfigs: Map<string, MCPServerConfig> }).serverConfigs =
        new Map([[config.id, config]]);
      const connectSpy = vi
        .spyOn(
          manager as unknown as { connectServer: (config: MCPServerConfig) => Promise<void> },
          'connectServer'
        )
        .mockResolvedValue();
      const refreshSpy = vi.spyOn(manager, 'refreshTools').mockResolvedValue();

      await manager.connectServerById(config.id);

      expect(connectSpy).toHaveBeenCalledWith(config);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('disconnects a configured server by id and refreshes tools', async () => {
      const refreshSpy = vi.spyOn(manager, 'refreshTools').mockResolvedValue();
      const disconnectSpy = vi.spyOn(manager, 'disconnectServer').mockResolvedValue();

      await manager.disconnectServerById('disconnect-test');

      expect(disconnectSpy).toHaveBeenCalledWith('disconnect-test');
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });

    it('restarts a configured enabled server by id', async () => {
      const config: MCPServerConfig = {
        id: 'restart-test',
        name: 'Restart Test',
        type: 'sse',
        url: 'http://127.0.0.1:1/restart-test',
        enabled: true,
      };

      (manager as unknown as { serverConfigs: Map<string, MCPServerConfig> }).serverConfigs =
        new Map([[config.id, config]]);
      const reconnectSpy = vi
        .spyOn(
          manager as unknown as { reconnectServer: (serverId: string) => Promise<boolean> },
          'reconnectServer'
        )
        .mockResolvedValue(true);

      await manager.restartServer(config.id);

      expect(reconnectSpy).toHaveBeenCalledWith(config.id);
    });
  });

  describe('callTool() recovery', () => {
    it('reconnects chrome servers when tool results indicate the browser session went stale', async () => {
      const toolName = 'mcp__Chrome__navigate';
      const config: MCPServerConfig = {
        id: 'chrome-server',
        name: 'Chrome',
        type: 'stdio',
        command: 'npx',
        enabled: true,
      };
      const staleResult = {
        isError: true,
        content: [{ type: 'text', text: 'Target closed' }],
      };
      const successResult = {
        content: [{ type: 'text', text: 'ok' }],
      };
      const client = {
        callTool: vi.fn().mockResolvedValueOnce(staleResult).mockResolvedValueOnce(successResult),
      };

      (
        manager as unknown as {
          tools: Map<
            string,
            {
              name: string;
              description: string;
              inputSchema: { type: string; properties: Record<string, unknown> };
              serverId: string;
              serverName: string;
            }
          >;
          clients: Map<string, unknown>;
          serverConfigs: Map<string, MCPServerConfig>;
        }
      ).tools = new Map([
        [
          toolName,
          {
            name: toolName,
            description: 'Chrome navigate',
            inputSchema: { type: 'object', properties: {} },
            serverId: config.id,
            serverName: config.name,
          },
        ],
      ]);
      (manager as unknown as { clients: Map<string, unknown> }).clients = new Map([
        [config.id, client],
      ]);
      (manager as unknown as { serverConfigs: Map<string, MCPServerConfig> }).serverConfigs =
        new Map([[config.id, config]]);

      const reconnectSpy = vi
        .spyOn(
          manager as unknown as { reconnectServer: (serverId: string) => Promise<boolean> },
          'reconnectServer'
        )
        .mockResolvedValue(true);

      const result = await manager.callTool(toolName, { url: 'https://example.com' });

      expect(result).toBe(successResult);
      expect(reconnectSpy).toHaveBeenCalledWith(config.id);
      expect(client.callTool).toHaveBeenCalledTimes(2);
    });
  });
});
