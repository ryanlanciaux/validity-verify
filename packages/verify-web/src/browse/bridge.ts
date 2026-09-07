import { localRequestStatus } from '@validity.ai/verify-spec';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Vite types `server.httpServer` as `http.Server | http2.Http2SecureServer`.
 * Both expose `.on('upgrade', …)` with the same signature; this minimal
 * structural type lets `attachBridge` accept either without dragging in the
 * full http2 typings.
 */
interface UpgradableServer {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  off(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

/**
 * Server→page command channel for browse mode. The MCP layer pushes
 * navigation / scenario / prop-override commands here so an LLM can drive
 * a live browse session ("show me the dropdown", "switch scenarios") without
 * the user clicking. Strictly one-way: pages do not send commands back.
 *
 * Lifecycle is bound to the Vite dev server's HTTP server — we attach to
 * its `upgrade` event for the `/__validity/bridge` path and let everything
 * else (HMR included) fall through to Vite's own handlers.
 */

export type BridgeMessage =
  | {
      type: 'navigate';
      /** Component path (mutually exclusive with `view`). */
      path?: string;
      /** Author-defined view name (mutually exclusive with `path`). When set,
       * the page refreshes its config before applying focus so a newly-created
       * view is visible. */
      view?: string;
      scenario?: string;
      propOverrides?: Record<string, unknown> | null;
      viewport?: 'desktop' | 'tablet' | 'mobile';
    }
  | { type: 'scenario'; id: string }
  | {
      type: 'propOverrides';
      component: string;
      overrides: Record<string, unknown> | null;
    }
  /** Tell the page to re-fetch /__validity/api/config — sent after a
   * views_create / views_delete write so the palette picks up the change
   * without a full page reload. */
  | { type: 'configRefresh' }
  | { type: 'ping' };

const BRIDGE_PATH = '/__validity/bridge';

export interface BridgeHandle {
  /** Push a message to whichever page is currently connected. Returns false when no page is connected. */
  send: (message: BridgeMessage) => boolean;
  /** Whether at least one page is currently subscribed. */
  isConnected: () => boolean;
  /** Tear down the WS server. Called by the dev-server close path. */
  close: () => void;
}

/**
 * Attach a WebSocket endpoint at `/__validity/bridge` to the given HTTP
 * server. Each new connection replaces the previous one — the assumption is
 * one open browse tab per project; if the user opens a second tab the new
 * one takes over (the old one is closed cleanly).
 *
 * Returns a handle the dev-server layer can hand back to the MCP server.
 */
export function attachBridge(httpServer: UpgradableServer): BridgeHandle {
  const wss = new WebSocketServer({ noServer: true });
  let activeSocket: WebSocket | null = null;

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!req.url) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== BRIDGE_PATH) return;
    if (localRequestStatus(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
        try {
          activeSocket.close(1000, 'replaced by newer session');
        } catch {
          /* ignore */
        }
      }
      activeSocket = ws;
      ws.on('close', () => {
        if (activeSocket === ws) activeSocket = null;
      });
      ws.on('error', () => {
        if (activeSocket === ws) activeSocket = null;
      });
      // No client→server commands today — silently drop anything we receive.
      ws.on('message', () => {
        /* intentional no-op */
      });
    });
  };

  httpServer.on('upgrade', upgrade);

  return {
    send(message) {
      const ws = activeSocket;
      if (!ws || ws.readyState !== ws.OPEN) return false;
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    isConnected() {
      const ws = activeSocket;
      return Boolean(ws && ws.readyState === ws.OPEN);
    },
    close() {
      httpServer.off('upgrade', upgrade);
      try {
        wss.close();
      } catch {
        /* ignore */
      }
      if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
        try {
          activeSocket.close(1001, 'server shutting down');
        } catch {
          /* ignore */
        }
      }
      activeSocket = null;
    },
  };
}
