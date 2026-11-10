import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { z } from 'zod';

// The release workflow's shape, so the tagged commit's code can never run beside npm's OIDC token.

const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const jobSchema = z.object({
  needs: z.string().optional(),
  environment: z.string().optional(),
  permissions: z.record(z.string(), z.string()),
  outputs: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
});
const workflowSchema = z.object({
  jobs: z.record(z.string(), jobSchema),
});

const workflow = workflowSchema.parse(
  parse(readFileSync('.github/workflows/release.yml', 'utf8')),
);

describe('the release workflow', () => {
  it('mints the OIDC token only in a job that runs none of the repo', () => {
    const tokenJobs = Object.entries(workflow.jobs).filter(
      ([, job]) => job.permissions['id-token'] === 'write',
    );
    assert.equal(tokenJobs.length, 1);
    const [[, publish] = ['', undefined]] = tokenJobs;
    assert.ok(publish);
    assert.equal(publish.environment, 'npm');
    assert.equal(publish.needs, 'pack');
    for (const step of publish.steps) {
      assert.doesNotMatch(step.uses ?? '', /checkout|pnpm\/action-setup/);
      assert.doesNotMatch(step.run ?? '', /pnpm|npm (install|ci|run)|node /);
    }
    assert.ok(
      publish.steps.some((step) => /sha256sum --check/.test(step.run ?? '')),
    );
    assert.ok(
      publish.steps.some((step) =>
        /npm publish .*--provenance .*--ignore-scripts/.test(step.run ?? ''),
      ),
    );
  });

  it('checks the tagged commit is on master before any of its code runs', () => {
    const jobsRunningRepo = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps.some((step) => /checkout/.test(step.uses ?? '')),
    );
    assert.deepEqual(
      jobsRunningRepo.map(([name]) => name),
      ['verify', 'pack'],
    );
    for (const [, job] of jobsRunningRepo) {
      assert.equal(job.permissions['id-token'], undefined);
      const ancestry = job.steps.findIndex((step) =>
        /merge-base --is-ancestor/.test(step.run ?? ''),
      );
      const firstRepoCode = job.steps.findIndex((step) =>
        /pnpm/.test(`${step.uses ?? ''} ${step.run ?? ''}`),
      );
      assert.ok(ancestry > 0 && ancestry < firstRepoCode);
    }
  });

  it('runs the whole gate before it packs', () => {
    const { verify, pack } = workflow.jobs;
    assert.ok(verify && pack);
    assert.equal(pack.needs, 'verify');
    const runs = verify.steps.map((step) => step.run ?? '');
    assert.ok(runs.includes('pnpm install --frozen-lockfile'));
    assert.ok(runs.includes('pnpm check'));
    assert.ok(runs.every((run) => !/pnpm pack|upload-artifact/.test(run)));
  });

  it('packs the library alone, without the site toolchain, and hands its hash on', () => {
    const { pack, publish } = workflow.jobs;
    assert.ok(pack && publish);
    const installs = pack.steps.filter((step) =>
      /pnpm install/.test(step.run ?? ''),
    );
    assert.deepEqual(
      installs.map((step) => step.run),
      ['pnpm install --frozen-lockfile --filter @osroc-labs/storehouse'],
    );
    assert.ok(pack.steps.some((step) => /pnpm pack/.test(step.run ?? '')));
    assert.ok(
      pack.steps.some((step) => /upload-artifact/.test(step.uses ?? '')),
    );
    assert.match(pack.outputs?.sha256 ?? '', /steps\.pack\.outputs\.sha256/);
    const publishText = JSON.stringify(publish.steps);
    assert.match(publishText, /needs\.pack\.outputs\.sha256/);
    assert.doesNotMatch(publishText, /needs\.verify/);
  });
});
