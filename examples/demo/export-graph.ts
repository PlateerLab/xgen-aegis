// Write the demo host's search graph for the server: node examples/demo/export-graph.ts [out]
import { writeFileSync } from 'node:fs';
import { evaluate, load, toSearchGraph } from '../../packages/core/src/index.ts';
import { adapter, seed } from './host.ts';
import { RULES } from './rules.ts';

const a = await load(adapter(seed()));
const out = process.argv[2] ?? 'graph.json';
writeFileSync(out, JSON.stringify(toSearchGraph(a, evaluate(a.graph, RULES)), null, 1), 'utf8');
console.log(`items ${a.graph.items.length} · links ${a.graph.links.length} → ${out}`);
