/**
 * Serves a generated site folder, or a baseline folder holding many `<scenario>/site/` folders, on loopback
 * for a manual look: `npx tsx scripts/sites-serve.ts <dir> [port]`. Static files only, exact media types,
 * no caching. A folder without index.html gets a plain listing; unknown paths get the site's own 404 page.
 */
import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'artifacts/sites-2026-11-22');
const port = Number(process.argv[3] ?? process.env.PORT ?? 5177);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip', '.md': 'text/plain; charset=utf-8' };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }
async function listing(directory: string, urlPath: string): Promise<string> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
  const rows = await Promise.all(entries.map(async entry => {
    const site = entry.isDirectory() && await exists(join(directory, entry.name, 'site', 'index.html')) ? `${entry.name}/site/` : entry.isDirectory() ? `${entry.name}/` : entry.name;
    return `<li><a href="${escape(site)}">${escape(entry.name)}</a>${site.endsWith('site/') ? ' — generated site' : ''}</li>`;
  }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(urlPath)}</title><style>body{font:16px system-ui;margin:2rem;max-width:60rem}li{margin:.3rem 0}</style></head><body><h1>${escape(urlPath)}</h1><ul>${rows.join('')}</ul></body></html>`;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let target = join(root, relative);
    if (!target.startsWith(root)) { response.writeHead(403); response.end(); return; }
    if (await exists(target) && (await stat(target)).isDirectory()) {
      if (!url.pathname.endsWith('/')) { response.writeHead(302, { location: `${url.pathname}/` }); response.end(); return; }
      if (await exists(join(target, 'index.html'))) target = join(target, 'index.html');
      else { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(await listing(target, url.pathname)); return; }
    }
    if (!await exists(target)) {
      // The nearest site's own 404 page, when the path is inside a generated site.
      const siteRoot = relative.split(/[/\\]/).slice(0, relative.includes(`${sep}site${sep}`) || relative.includes('/site/') ? 2 : 0).join(sep);
      const notFound = siteRoot ? join(root, siteRoot, 'site', '404.html') : join(root, '404.html');
      if (await exists(notFound)) { response.writeHead(404, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' }); response.end(await readFile(notFound)); return; }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); response.end(`not found: ${url.pathname}`); return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(target));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); response.end(String(error));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}/`));
