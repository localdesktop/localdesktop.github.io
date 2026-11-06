// Fingerprint of the simulation source code (src/game). Lockstep multiplayer only works
// when every client runs exactly the same simulation, so the server refuses clients
// whose build has a different fingerprint (for example a tab opened before a deploy).
// vite.config.ts bakes the same fingerprint into the client at build time.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function simHash(root: string = path.resolve(import.meta.dirname, '..')): string {
  const dir = path.join(root, 'src', 'game');
  const files: string[] = [];
  const walk = (d: string): void => {
    const ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const f of ents) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(dir, f).split(path.sep).join('/'));
    h.update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  }
  return h.digest('hex').slice(0, 12);
}
