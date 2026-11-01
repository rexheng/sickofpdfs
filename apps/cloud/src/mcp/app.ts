// CL6 replaces this file: the MCP connector at /mcp (both protocol lanes), over `QueryApi` and `SyncService`.
import { Hono } from 'hono';
import { type AppEnv, notImplemented } from '../env';

export const mcpApp = new Hono<AppEnv>();
mcpApp.all('/mcp', notImplemented('CL6'));
