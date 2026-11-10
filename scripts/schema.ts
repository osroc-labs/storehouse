import { readFileSync, writeFileSync } from 'node:fs';
import { generateJsonSchema } from '../src/manifest/json-schema.ts';

const path = new URL('../schema.json', import.meta.url);
const check = process.argv.includes('--check');
const current = (() => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
})();

if (current === generateJsonSchema()) {
  console.log('schema.json is up to date.');
} else if (check) {
  console.error('schema.json is out of date. Run pnpm schema.');
  process.exitCode = 1;
} else {
  writeFileSync(path, generateJsonSchema());
  console.log('Wrote schema.json.');
}
