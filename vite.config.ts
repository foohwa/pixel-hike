import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Dev-only: mirrors each track's saved edits (checkpoint names, settings…) to edits/<key>.json
 * so they survive cleared browser data and app updates. The folder is git-ignored.
 */
function editsOnDisk(): Plugin {
  const dir = join(process.cwd(), 'edits');
  return {
    name: 'pixelhike-edits-on-disk',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__pixelhike/edits/', (req, res) => {
        const key = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0]);
        if (!/^pixelhike:v1:\d+:\d+$/.test(key)) {
          res.statusCode = 400;
          res.end('bad key');
          return;
        }
        const file = join(dir, `${key.replace(/:/g, '_')}.json`);
        if (req.method === 'GET') {
          if (!existsSync(file)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(readFileSync(file));
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            try {
              JSON.parse(body);
              mkdirSync(dir, { recursive: true });
              writeFileSync(file, body);
              res.end('ok');
            } catch {
              res.statusCode = 400;
              res.end('bad json');
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

/**
 * Build-only: public/ is copied into dist/ as-is, and public/samples/ holds private tracks
 * (names + exact routes) for the dev server. Never ship them.
 */
function dropPrivateSamples(): Plugin {
  return {
    name: 'pixelhike-drop-private-samples',
    apply: 'build',
    closeBundle() {
      const dir = join(process.cwd(), 'dist', 'samples');
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

// GitHub Pages serves the app from /<repo>/; the deploy workflow sets BASE_PATH. Locally it stays '/'.
export default defineConfig({ base: process.env.BASE_PATH ?? '/', plugins: [editsOnDisk(), dropPrivateSamples()] });
