import { resolve } from 'node:path';
import type { PushTargetConfig } from '../manifest/schema.ts';
import { cliService } from './run-cli.ts';
import type { CliInvocation } from './run-cli.ts';

type CloudflareWorkersTarget = Extract<
  PushTargetConfig,
  { to: 'cloudflare-workers' }
>;

// wrangler reads stdin a line at a time, and Node's readline also breaks lines at U+2028 and
// U+2029, which JSON.stringify leaves raw inside strings
const formatBulkJson = (values: Record<string, string>) =>
  JSON.stringify(values)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

const formatTarget = (target: CloudflareWorkersTarget) =>
  `cloudflare-workers in ${target.dir}${target.wranglerEnv === undefined ? '' : ` (--env ${target.wranglerEnv})`}`;

// One `wrangler secret bulk` for every value, so one new Worker version. wrangler 4 exits 0 when it
// couldn't read its input, so the push also needs the line it prints once it has uploaded.
const getInvocations = ({
  target,
  root,
  values,
}: {
  target: CloudflareWorkersTarget;
  root: string;
  values: Record<string, string>;
}) => [
  {
    command: cliService.getPath({ name: 'wrangler', root, dir: target.dir }),
    args: [
      'secret',
      'bulk',
      // one token, so the value can never be read as a flag of its own
      ...(target.wranglerEnv === undefined
        ? []
        : [`--env=${target.wranglerEnv}`]),
    ],
    cwd: resolve(root, target.dir),
    keys: Object.keys(values),
    input: formatBulkJson(values),
    inputLabel: 'the values as JSON, on stdin',
    successText: 'Finished processing secrets file',
    installHint: "Add wrangler to the Worker's devDependencies.",
    failureHint:
      'If it says you need to log in, run `wrangler login` in that directory.',
  } satisfies CliInvocation,
];

export const cloudflareWorkersTarget = {
  format: formatTarget,
  getInvocations,
};
