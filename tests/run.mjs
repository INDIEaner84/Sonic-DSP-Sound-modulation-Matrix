/* Test-Runner: führt alle *.test.mjs aus. Ohne Argumente nur die
 * dependency-freien Tests; `--ui` nimmt die jsdom-UI-Tests mit dazu (devDependency).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const withUi = process.argv.includes('--ui');

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => (withUi ? true : f !== 'ui.test.mjs'))
  .sort();

console.log(`Sonic DSP — Tests (${files.length} Dateien${withUi ? ', inkl. UI' : ', ohne UI'})`);

for (const file of files) {
  await import(path.join(dir, file));
}

const { passed, failed } = await run();
process.exit(failed ? 1 : 0);
