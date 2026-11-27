/**
 * Read a host repo's screen contracts and menu tree from a git ref (the working tree is not touched) and write screens.json.
 *
 *   aegis-scan <repo> [--ref origin/main] [--contracts "features/*\/contracts/screen.contract.ts"]
 *              [--taxonomy path/to/taxonomy.ts --taxonomy-export PERMISSION_SCOPES] [--out screens.json]
 *
 * Contract and taxonomy files are TypeScript or JavaScript modules whose values are literals. They are transpiled and
 * evaluated in an empty context; imports resolve to inert stand-ins (types are erased anyway).
 */

import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { screensFromContracts, type ScreenContract, type Taxonomy } from './contracts.ts';

const blank = (): unknown => new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => '' : blank()), apply: () => blank() });

export function evaluateModule(source: string): Record<string, unknown> {
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(js, { module, exports: module.exports, require: () => blank() });
  return module.exports;
}

/** Glob with * (one segment) and ** (any depth). */
function globRe(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*');
  return new RegExp(`^${re}$`);
}

export function scanGit(repo: string, opt: { ref?: string; contracts?: string; taxonomy?: string; taxonomyExport?: string }) {
  const ref = opt.ref ?? 'HEAD';
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const show = (p: string) => git('show', `${ref}:${p}`);
  const files = git('ls-tree', '-r', '--name-only', ref).split('\n');
  const want = globRe(opt.contracts ?? '**/screen.contract.ts');
  const contracts: ScreenContract[] = [];
  const routes = new Map<string, string>();
  const skipped: string[] = [];
  for (const f of files.filter((x) => want.test(x))) {
    try {
      const src = show(f);
      const c = (evaluateModule(src).default ?? evaluateModule(src).contract) as ScreenContract | undefined;
      if (!c || typeof c !== 'object' || !c.featureId) continue;
      contracts.push(c);
      // a route written in the contract's header comment, e.g. "(/admin?view=…)"
      const r = /\((\/[\w-]+\?view=[\w-]+)\)/.exec(src)?.[1];
      if (r) routes.set(c.featureId, r);
    } catch (e) {
      skipped.push(`${f}: ${String(e).slice(0, 80)}`);
    }
  }
  let taxonomy: Taxonomy = {};
  if (opt.taxonomy) {
    const m = evaluateModule(show(opt.taxonomy));
    taxonomy = (m[opt.taxonomyExport ?? 'default'] ?? {}) as Taxonomy;
  }
  const screens = screensFromContracts(contracts, taxonomy, (c) => c.route ?? routes.get(c.featureId));
  return { ref, head: git('rev-parse', ref).trim(), at: git('log', '-1', '--format=%cI', ref).trim(), screens, skipped };
}
