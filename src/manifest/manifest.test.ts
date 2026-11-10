import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fakeManifest } from '../testing/storehouse-for-test.ts';
import { generateJsonSchema } from './json-schema.ts';
import { manifestService } from './manifest.ts';

const { parse: parseManifest } = manifestService;
const secretName = manifestService.secrets.getName;

const problemsOf = (json: unknown) => parseManifest(json).problems;

describe('manifestService', () => {
  it('parses the example and fills the defaults', () => {
    const { manifest, problems } = parseManifest(fakeManifest());
    assert.deepEqual(problems, []);
    assert.deepEqual(manifest?.envs, {
      dev: { protected: false, pull: { file: 'worker/.dev.vars' }, push: [] },
      stage: {
        protected: false,
        push: [
          { to: 'cloudflare-workers', dir: 'worker', wranglerEnv: 'stage' },
        ],
      },
      prod: {
        protected: true,
        push: [
          { to: 'cloudflare-workers', dir: 'worker', wranglerEnv: 'prod' },
        ],
      },
    });
    assert.deepEqual(manifest.secrets.TWILIO_SID, {
      purpose: 'The Twilio account that texts sign-in codes.',
      required: false,
      pull: true,
      push: true,
    });
  });

  it('makes names from the pattern, or the secret’s own', () => {
    const { manifest } = parseManifest({
      ...fakeManifest(),
      secrets: {
        A: { purpose: 'a' },
        B: { purpose: 'b', name: 'legacy-{env}-b-token' },
      },
    });
    assert.ok(manifest);
    assert.equal(secretName(manifest, 'stage', 'A'), 'acme-stage-A');
    assert.equal(secretName(manifest, 'prod', 'B'), 'legacy-prod-b-token');
  });

  it('lets an env use its own project', () => {
    const { manifest, problems } = parseManifest({
      name: '{key}',
      envs: { dev: { project: 'proj-dev' }, prod: { project: 'proj-prod' } },
      secrets: { A: { purpose: 'a' } },
    });
    assert.deepEqual(problems, []);
    assert.equal(manifest?.envs.prod?.project, 'proj-prod');
  });

  it('refuses what the schema doesn’t allow, naming where', () => {
    const problems = problemsOf({
      project: 'proj-test',
      name: 'x-{env}-{key}',
      envs: { Dev: {}, stage: { push: [{ to: 'heroku' }] } },
      secrets: {
        'BAD-KEY': { purpose: 'x' },
        NO_PURPOSE: {},
        FILE: { purpose: 'x', file: true },
      },
      extra: 1,
    });
    const text = problems.join('\n');
    assert.match(text, /envs\.Dev/);
    assert.match(text, /envs\.stage\.push\.0\.to/);
    assert.match(text, /secrets\.BAD-KEY/);
    assert.match(text, /secrets\.NO_PURPOSE\.purpose/);
    assert.match(text, /secrets\.FILE/);
    assert.match(text, /extra/);
  });

  it('finds names that collide, are invalid or have unknown placeholders', () => {
    const problems = problemsOf({
      project: 'proj-test',
      name: 'app-{key}',
      envs: { dev: {}, stage: {} },
      secrets: {
        A: { purpose: 'a' },
        B: { purpose: 'b', name: 'app-{env}-{KEY}' },
        C: { purpose: 'c', name: 'has.dot-{env}' },
        D: { purpose: 'd', envs: ['qa'] },
      },
    });
    const text = problems.join('\n');
    assert.match(
      text,
      /secrets\.A: its stage name, "app-A", is also A in dev's/,
    );
    assert.match(text, /secrets\.B\.name: \{KEY\} isn't a placeholder/);
    assert.match(
      text,
      /secrets\.C: its dev name, "has\.dot-dev", isn't a valid/,
    );
    assert.match(text, /secrets\.D\.envs: "qa" isn't an env/);
  });

  it('needs a project and a name for every env and secret', () => {
    const text = problemsOf({
      envs: { dev: {} },
      secrets: { A: { purpose: 'a' } },
    }).join('\n');
    assert.match(text, /envs\.dev: no Google Cloud project/);
    assert.match(text, /secrets\.A: no name/);
  });

  it('allows the same name in two projects', () => {
    assert.deepEqual(
      problemsOf({
        name: 'app-{key}',
        envs: { dev: { project: 'proj-aaa' }, prod: { project: 'proj-bbb' } },
        secrets: { A: { purpose: 'a' } },
      }),
      [],
    );
  });
  it('refuses control characters, a bad wrangler env and a bad project id', () => {
    const manifest = fakeManifest();
    const text = problemsOf({
      ...manifest,
      project: 'not a project/../x',
      envs: {
        ...manifest.envs,
        stage: {
          push: [{ to: 'cloudflare-workers', wranglerEnv: '--name=other' }],
        },
      },
      secrets: {
        ...manifest.secrets,
        AUTH_SECRET: { purpose: 'x\u001b[2KFAKE LINE' },
      },
    }).join('\n');
    assert.match(text, /^project: A Google Cloud project id is/m);
    assert.match(
      text,
      /envs\.stage\.push\.0\.wranglerEnv: Wrangler's --env is a label/,
    );
    assert.match(text, /secrets\.AUTH_SECRET\.purpose: Control characters/);
  });

  it('shows a bad key with its control characters escaped', () => {
    const text = problemsOf({
      ...fakeManifest(),
      secrets: { 'BAD\u001bKEY': { purpose: 'x' } },
    }).join('\n');
    assert.ok(text.includes('BAD\\u001bKEY'));
    assert.ok(!text.includes('\u001b'));
  });
  it('refuses github-actions shapes gh would refuse', () => {
    const manifest = fakeManifest();
    const withTarget = (target: Record<string, unknown>) =>
      problemsOf({
        ...manifest,
        envs: {
          ...manifest.envs,
          stage: { push: [{ to: 'github-actions', ...target }] },
        },
      }).join('\n');
    assert.match(
      withTarget({ org: 'acme', environment: 'staging' }),
      /envs\.stage\.push\.0\.environment: Give "org" or "environment", not both/,
    );
    assert.match(
      withTarget({ visibility: 'all' }),
      /envs\.stage\.push\.0\.visibility: "visibility" is for an organization secret/,
    );
    assert.match(
      withTarget({ org: 'acme', visibility: 'all', repos: ['app'] }),
      /envs\.stage\.push\.0\.repos: "repos" is for an organization secret with "visibility": "selected"/,
    );
    assert.equal(
      withTarget({ org: 'acme', visibility: 'selected', repos: ['app'] }),
      '',
    );
    assert.equal(withTarget({ repo: 'acme/app', environment: 'staging' }), '');
  });
});

describe('schema.json', () => {
  it('is generated from the Zod schema (run pnpm schema)', () => {
    assert.equal(
      readFileSync(new URL('../../schema.json', import.meta.url), 'utf8'),
      generateJsonSchema(),
    );
  });
});
