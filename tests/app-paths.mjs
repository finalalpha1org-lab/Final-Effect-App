import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function appPath(name) {
  const publicPath = resolve(projectRoot, 'public', name);
  return existsSync(publicPath) ? publicPath : resolve(projectRoot, name);
}
