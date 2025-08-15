import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const src = resolve(__dirname, '../client/dist');
const dst = resolve(__dirname, '../server/public');

await cp(src, dst, { recursive: true });
console.log(`Copied client/dist → server/public`);
