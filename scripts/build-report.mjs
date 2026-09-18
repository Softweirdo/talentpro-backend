import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Prints what the build produced.
 *
 * `tsc` is silent on success, which is indistinguishable from a command that
 * did nothing — every developer who runs it for the first time assumes the
 * build is broken. This turns a passing build into something you can see.
 */
const DIST = 'dist';
const ENTRY = join(DIST, 'server.js');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error('\n  ✗ Build produced no dist/ directory.\n');
  process.exit(1);
}

const files = walk(DIST);
const js = files.filter((f) => f.endsWith('.js'));
const maps = files.filter((f) => f.endsWith('.js.map'));
const bytes = files.reduce((n, f) => n + statSync(f).size, 0);

// A build without an entry point compiled, but produced nothing runnable.
if (!existsSync(ENTRY)) {
  console.error(`\n  ✗ ${ENTRY} is missing — nothing to run.\n`);
  process.exit(1);
}

const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(
  [
    '',
    `  ✓ Build complete — ${js.length} files${maps.length ? ` (+${maps.length} sourcemaps)` : ''}, ${mb} MB`,
    `    entry:  ${relative('.', ENTRY)}`,
    `    run it: npm start`,
    '',
  ].join('\n'),
);
