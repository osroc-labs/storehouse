import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// A stand-in for a platform's CLI (wrangler, gh, vercel, fly) that records each run (argv, cwd,
// stdin and env) and answers as told. Every log is kept, so the leak check can read them all.

export const FakeCliBehaviour = {
  ok: 'ok',
  notLoggedIn: 'not-logged-in',
  fails: 'fails',
  // starts, prints part of what it would, and exits 0 without finishing
  partial: 'partial',
  // succeeds for the first run, then fails
  failsSecond: 'fails-second',
} as const;
export type FakeCliBehaviour =
  (typeof FakeCliBehaviour)[keyof typeof FakeCliBehaviour];

const cliRunSchema = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  stdin: z.string(),
  env: z.record(z.string(), z.string()),
});

const allLogPaths: string[] = [];

const constructScript = ({
  logPath,
  behaviour,
  successText,
}: {
  logPath: string;
  behaviour: FakeCliBehaviour;
  successText: string;
}) => `#!${process.execPath}
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const run = { argv: process.argv.slice(2), cwd: process.cwd(), stdin: Buffer.concat(chunks).toString('utf8'), env: process.env };
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(run) + '\\n');
  const runs = fs.readFileSync(${JSON.stringify(logPath)}, 'utf8').trim().split('\\n').length;
  const behaviour = ${JSON.stringify(behaviour)};
  if (behaviour === 'not-logged-in') { console.error('You are not logged in. Run the login command.'); process.exit(1); }
  if (behaviour === 'fails') { console.error('Something went wrong.'); process.exit(3); }
  if (behaviour === 'fails-second' && runs > 1) { console.error('Rate limited.'); process.exit(1); }
  if (behaviour === 'partial') { console.log('Processing the secrets...'); process.exit(0); }
  console.log(${JSON.stringify(successText)});
});
`;

// Writes the fake as `name` in binDir, executable, and returns a reader for its runs.
export const createFakeCliForTest = ({
  binDir,
  name,
  behaviour = FakeCliBehaviour.ok,
  successText = 'Done.',
}: {
  binDir: string;
  name: string;
  behaviour?: FakeCliBehaviour;
  successText?: string;
}) => {
  mkdirSync(binDir, { recursive: true });
  const logPath = join(binDir, `${name}.runs.jsonl`);
  allLogPaths.push(logPath);
  const scriptPath = join(binDir, name);
  writeFileSync(
    scriptPath,
    constructScript({ logPath, behaviour, successText }),
  );
  chmodSync(scriptPath, 0o755);
  return () =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => cliRunSchema.parse(JSON.parse(line)))
      : [];
};

// every run of every fake CLI made so far in this process
export const getAllFakeCliRuns = () =>
  allLogPaths.flatMap((logPath) =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => cliRunSchema.parse(JSON.parse(line)))
      : [],
  );
