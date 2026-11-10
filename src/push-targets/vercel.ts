import { resolve } from 'node:path';
import type { PushTargetConfig } from '../manifest/schema.ts';
import { getUnsendableValueError } from './refuse-value.ts';
import { cliService } from './run-cli.ts';
import type { CliInvocation } from './run-cli.ts';

type VercelTarget = Extract<PushTargetConfig, { to: 'vercel' }>;

const formatTarget = (target: VercelTarget) =>
  `vercel in ${target.dir} (${target.environments.join(', ')})`;

// vercel drops the trailing line break of a one-line value read from stdin, and leaves any other
// value alone, so only a value that is one line plus its line break can't arrive as it is
const assertSendable = (key: string, value: string) => {
  if (!/^[^\r\n]*\r?\n$/.test(value)) return;
  throw getUnsendableValueError({
    key,
    target: 'vercel env add',
    reason: 'vercel drops the line break at the end of a one-line value',
  });
};

// one `vercel env add --force` per secret, the value on stdin and only the name in argv
const getInvocations = ({
  target,
  root,
  keys,
  values,
}: {
  target: VercelTarget;
  root: string;
  keys: readonly string[];
  values: Record<string, string>;
}) =>
  keys.map((key) => {
    const value = values[key] ?? '';
    assertSendable(key, value);
    return {
      command: cliService.getPath({ name: 'vercel', root, dir: target.dir }),
      args: [
        'env',
        'add',
        key,
        // each flag one token, so a value can never be read as a flag of its own
        `--environment=${target.environments.join(',')}`,
        '--force',
        '--yes',
        ...(target.scope === undefined ? [] : [`--scope=${target.scope}`]),
      ],
      cwd: resolve(root, target.dir),
      keys: [key],
      // vercel waits for input it can't tell apart from none, so an empty value is a line break
      input: value === '' ? '\n' : value,
      inputLabel: `the value of ${key}, on stdin`,
      installHint:
        'Install the Vercel CLI (npm i -g vercel), version 64.7 or later.',
      failureHint:
        "If it says you're not logged in, run `vercel login`; if the project isn't linked, run `vercel link` in that directory.",
    } satisfies CliInvocation;
  });

export const vercelTarget = { format: formatTarget, getInvocations };
