import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'vendor');

await mkdir(vendor, { recursive: true });
await Promise.all([
  copyFile(resolve(root, 'node_modules/web-tree-sitter/web-tree-sitter.js'), resolve(vendor, 'web-tree-sitter.js')),
  copyFile(resolve(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'), resolve(vendor, 'web-tree-sitter.wasm')),
  copyFile(resolve(root, 'node_modules/tree-sitter-go/tree-sitter-go.wasm'), resolve(vendor, 'tree-sitter-go.wasm')),
]);
