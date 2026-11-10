import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { commandLineService } from '../command-line/command-line.ts';
import { ExitCode } from '../errors.ts';
import {
  createRepoForTest,
  fakeManifest,
  runStorehouseForTest,
} from '../testing/storehouse-for-test.ts';
import { protectedInvocation } from './protect.ts';

// the words a person (or an agent) could put on a storehouse command line
const wordArbitrary = fc.oneof(
  fc.constantFrom(
    'status',
    'set',
    'get',
    'history',
    'check',
    'pull',
    'push',
    'auth',
    'help',
    'dev',
    'stage',
    'prod',
    'qa',
    'AUTH_SECRET',
    'TWILIO_SID',
    'NOPE',
    '--json',
    '--dry-run',
    '--force',
    '--out',
    '--out=prod',
    '--out=x',
    '--limit',
    '--limit=3',
    '-h',
    '--help',
    '--version',
    '--bogus',
    '--env=prod',
    '-x',
    '--',
    '3',
  ),
  fc.string({ maxLength: 6 }),
);

const argvArbitrary = fc.array(wordArbitrary, { maxLength: 6 });

// An independent reading of where a command line names its env, written from the README rather
// than from storehouse's parser: flags anywhere, --out and --limit take a value, `--` ends flags.
const valueFlags = new Set(['--out', '--limit']);
const envPositionByCommand: Record<string, 'first' | 'all' | 'none'> = {
  status: 'all',
  set: 'first',
  get: 'first',
  history: 'first',
  pull: 'first',
  push: 'first',
  check: 'none',
  auth: 'none',
};

const getEnvWordsByHand = (argv: readonly string[]) => {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? '';
    if (word === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (valueFlags.has(word)) i++;
    else if (!word.startsWith('-') || word === '-') positionals.push(word);
  }
  // --help and --version print and touch nothing, wherever they are
  const flags = argv.slice(
    0,
    argv.includes('--') ? argv.indexOf('--') : argv.length,
  );
  if (flags.some((word) => ['-h', '--help', '--version'].includes(word)))
    return [];
  const [command = '', ...rest] = positionals;
  const position = envPositionByCommand[command] ?? 'none';
  if (position === 'all') return rest;
  return position === 'first' ? rest.slice(0, 1) : [];
};

// every word, and the value of each --flag=value, which is all a guard can go on for a line the
// CLI won't run
const getEveryWordByHand = (argv: readonly string[]) =>
  argv.flatMap((word) =>
    word.startsWith('-') && word.includes('=')
      ? [word, word.slice(word.indexOf('=') + 1)]
      : [word],
  );

describe('protectedInvocation against the CLI, over generated command lines', () => {
  it('names a protected env exactly when an independent reading of the line does', () => {
    let parsedCount = 0;
    let refusedCount = 0;
    fc.assert(
      fc.property(argvArbitrary, (argv) => {
        const named = protectedInvocation(argv, fakeManifest())?.envs ?? [];
        let isParsed = true;
        try {
          commandLineService.parse(argv);
        } catch {
          isParsed = false;
        }
        if (isParsed) {
          parsedCount++;
          assert.equal(
            named.includes('prod'),
            getEnvWordsByHand(argv).includes('prod'),
            argv.join(' '),
          );
          return;
        }
        refusedCount++;
        // a line the CLI refuses is protected when any word in it names prod
        assert.equal(
          named.includes('prod'),
          getEveryWordByHand(argv).includes('prod'),
          argv.join(' '),
        );
      }),
      { numRuns: 5000 },
    );
    assert.ok(parsedCount > 500, `only ${parsedCount} lines parsed`);
    assert.ok(refusedCount > 500, `only ${refusedCount} lines were refused`);
  });

  it('never lets the CLI reach a protected env the guard calls safe', async () => {
    const cwd = createRepoForTest();
    await fc.assert(
      fc.asyncProperty(argvArbitrary, async (argv) => {
        const r = await runStorehouseForTest(argv, {
          cwd,
          env: { CLAUDECODE: '1' },
          tty: true,
          answers: ['prod'],
        });
        const isRefusedAsProtected =
          r.code === ExitCode.refused && /protected env/.test(r.stderr());
        if (protectedInvocation(argv, fakeManifest()) === undefined) {
          assert.equal(isRefusedAsProtected, false, argv.join(' '));
          assert.deepEqual(r.prompts, [], argv.join(' '));
        }
      }),
      { numRuns: 400 },
    );
  });
});
