import { companionCalls } from './companions.js';
import { nativeCalls } from './native.js';
import { serverRoutes } from './server.js';
import { webCalls } from './web.js';
import { contractBinding } from './contracts.js';
import type { InventoryRow, ServerRoute } from './types.js';

export function routeKey(method: string, path: string) {
  return method.toUpperCase() + ' ' + path.replace(/(^|\/):[^/]+/g, '$1:').replace(/\/$/, '');
}

export function findServerRoute(routes: readonly ServerRoute[], method: string, path: string) {
  return routes.find(route => routeKey(route.method, route.path) === routeKey(method, path))
    ?? routes.find(route => route.method === method && route.path.endsWith('/*') && path.startsWith(route.path.slice(0, -1)));
}

export function clientInventory(root: string): InventoryRow[] {
  const server = serverRoutes(root);
  const grouped = new Map<string, InventoryRow>();
  for (const call of [...webCalls(root), ...nativeCalls(root), ...companionCalls(root)]) {
    const method = call.method.toUpperCase();
    const transport = call.transport ?? 'fastify';
    const route = transport === 'fastify' ? findServerRoute(server, method, call.path) : undefined;
    const path = route && !route.path.endsWith('/*') ? route.path : call.path;
    const key = transport + ' ' + routeKey(method, path);
    let row = grouped.get(key);
    if (!row) {
      const binding = contractBinding(method, path);
      row = {
        method, path, transport, server: route, auth: route?.auth ?? (transport !== 'fastify' ? call.auth : undefined),
        request: binding?.request ?? route?.request ?? call.request,
        response: binding?.response ?? route?.response ?? call.response,
        calls: [],
      };
      grouped.set(key, row);
    }
    row.request ??= call.request;
    row.response ??= call.response;
    row.calls.push(call);
  }
  const rows = [...grouped.values()];
  for (const row of rows) {
    row.calls = [...new Map(row.calls.map(call => [`${call.client}:${call.file}:${call.line}`, call])).values()];
    row.calls.sort((a, b) => a.client.localeCompare(b.client) || a.file.localeCompare(b.file) || a.line - b.line);
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.transport.localeCompare(b.transport));
}
