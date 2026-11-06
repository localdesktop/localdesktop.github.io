import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { simHash } from './server/simhash.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Emits sw.js with a precache list of every file in the build, so the game works fully
 * offline once loaded (and can be installed as a PWA). No dependencies needed.
 */
function serviceWorker(): Plugin {
  return {
    name: 'bear-war-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.startsWith('gallery'));
      const extra = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
      const urls = [...new Set([...extra, ...files])];
      const version = createHash('sha256').update(urls.join('|') + Date.now()).digest('hex').slice(0, 12);
      const src = `// Generated at build time, do not edit.
const CACHE = 'bear-war-${version}';
const PRECACHE = ${JSON.stringify(urls)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('bear-war-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.endsWith('/ws')) return;
  if (req.mode === 'navigate') {
    // network first so updates arrive when online; fall back to the cached app shell
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./', { ignoreSearch: true }).then((r) => r || caches.match(req, { ignoreSearch: true }))),
    );
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) => hit || fetch(req).then((res) => {
        if (res.ok && url.pathname.includes('/assets/')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }),
    ),
  );
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [serviceWorker()],
  define: {
    // the multiplayer server only lets clients with the same simulation code play together
    __SIM_HASH__: JSON.stringify(command === 'build' ? simHash(ROOT) : 'dev'),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      // during development the multiplayer server runs separately (npm run dev:server)
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
}));
