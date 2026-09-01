// The package is `"type": "module"`, so every .js under it is ESM by default —
// including the CommonJS build. These per-directory markers are what tell Node
// which is which, and without them `require('announcer-sdk')` throws
// ERR_REQUIRE_ESM.
import { writeFileSync } from 'node:fs';

writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');

console.log('wrote dist/cjs/package.json and dist/esm/package.json');
