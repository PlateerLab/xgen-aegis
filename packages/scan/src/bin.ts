#!/usr/bin/env node
// aegis-scan <repo> [--ref REF] [--contracts GLOB] [--taxonomy FILE --taxonomy-export NAME] [--out screens.json]
import { writeFileSync } from 'node:fs';
import { scanGit } from './git.ts';

const argv = process.argv.slice(2);
const opt: Record<string, string> = {};
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i] ?? '';
  else rest.push(argv[i]);
}
if (!rest[0]) {
  console.log('usage: aegis-scan <repo> [--ref REF] [--contracts GLOB] [--taxonomy FILE --taxonomy-export NAME] [--out screens.json]');
  process.exit(1);
}
const out = opt.out ?? 'screens.json';
const r = scanGit(rest[0], { ref: opt.ref, contracts: opt.contracts, taxonomy: opt.taxonomy, taxonomyExport: opt['taxonomy-export'] });
writeFileSync(out, JSON.stringify(r, null, 1), 'utf8');
console.log(`screens ${r.screens.length} · placed in menu ${r.screens.filter((s) => s.menu).length} · apis ${r.screens.reduce((n, s) => n + s.apis.length, 0)} · skipped ${r.skipped.length} → ${out}`);
