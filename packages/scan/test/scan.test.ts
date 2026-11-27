import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONTRACTS, TAXONOMY } from '../../../examples/demo/host.ts';
import { evaluateModule, scanGit, screensFromContracts } from '../src/index.ts';

test('contracts are placed in the host menu by the permissions their elements use', () => {
  const s = screensFromContracts(CONTRACTS, TAXONOMY);
  const by = Object.fromEntries(s.map((x) => [x.id, x]));
  assert.deepEqual(by.agents.menu, ['Agent operations', 'Agents']);
  assert.deepEqual(by['approval-rules'].menu, ['Approval', 'Approval rules']);
  assert.equal(by.agents.route, '/admin?view=agents');
  assert.deepEqual(by.agents.apis.map((a) => `${a.method} ${a.path}`), [
    'GET /api/admin/agents/list', 'PUT /api/admin/agents/{agentId}', 'DELETE /api/admin/agents/{agentId}', 'GET /api/admin/users/all',
  ]);
  assert.ok(by.dashboard.order! < by.agents.order!);
});

test('a screen whose permissions the menu tree does not know is placed by its title, else left unplaced', () => {
  const s = screensFromContracts([
    { featureId: 'x', title: 'Users', elements: [{ uiId: 'a', permissions: ['other.thing:read'], api: { method: 'GET', path: '/api/x' } }] },
    { featureId: 'y', title: 'Nowhere', elements: [] },
  ], TAXONOMY);
  assert.deepEqual(s[0].menu, ['Users & access', 'Users']);
  assert.equal(s[1].menu, null);
  assert.equal(s[1].route, '/admin?view=y');
});

test('TypeScript contract modules evaluate to their literal (types and imports erased)', () => {
  const m = evaluateModule(`
    import type { ScreenContract } from '@host/screen-contracts';
    import { PERM } from '@host/types';
    const contract = { featureId: 'f', title: 'T', note: \`\${PERM.READ}\`, elements: [{ uiId: 'e', api: { method: 'GET', path: '/api/f' } }] } satisfies ScreenContract;
    export default contract;
  `);
  const c = m.default as { featureId: string; elements: unknown[] };
  assert.equal(c.featureId, 'f');
  assert.equal(c.elements.length, 1);
});

test('scanGit reads contracts and the menu tree from a git ref without touching the working tree', () => {
  // scratch repo inside this checkout (ignored by git), not the system temp folder
  const dir = mkdtempSync(join(fileURLToPath(new URL('../../../', import.meta.url)), '.tmp-scan-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(dir, 'features/agents/contracts'), { recursive: true });
    mkdirSync(join(dir, 'shared'), { recursive: true });
    writeFileSync(join(dir, 'features/agents/contracts/screen.contract.ts'), `
      /** Agents (/admin?view=agents-main) */
      const contract = { featureId: 'agents', title: 'Agents', elements: [
        { uiId: 't', permissions: ['admin.agents:read'], api: { method: 'GET', path: '/api/admin/agents/list' } },
      ] };
      export default contract;`);
    writeFileSync(join(dir, 'shared/menu.ts'), `export const SCOPES = ${JSON.stringify(TAXONOMY)};`);
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'c');
    // a change in the working tree is ignored: the ref is read
    writeFileSync(join(dir, 'features/agents/contracts/screen.contract.ts'), 'broken');
    const r = scanGit(dir, { ref: 'HEAD', contracts: 'features/*/contracts/screen.contract.ts', taxonomy: 'shared/menu.ts', taxonomyExport: 'SCOPES' });
    assert.equal(r.screens.length, 1);
    assert.deepEqual(r.screens[0].menu, ['Agent operations', 'Agents']);
    assert.equal(r.screens[0].route, '/admin?view=agents-main');
    assert.equal(r.skipped.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
