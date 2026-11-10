import { resolve } from 'node:path';
import type { PushTargetConfig } from '../manifest/schema.ts';
import { getUnsendableValueError } from './refuse-value.ts';
import type { CliInvocation } from './run-cli.ts';

type FlyTarget = Extract<PushTargetConfig, { to: 'fly' }>;

const tripleQuote = '"""';
// Go's bufio.Scanner, which `fly secrets import` reads with, stops at a 64 KiB line
const maxLineLength = 60_000;

const formatTarget = (target: FlyTarget) =>
  `fly ${target.app ?? `in ${target.dir}`}${target.stage ? ' (staged)' : ''}`;

const countQuotes = (text: string) => text.split('"').length - 1;

// Why a value can't be written as a triple-quoted `fly secrets import` entry that flyctl reads
// back exactly, or undefined when it can be.
const getUnwritableReason = (value: string) => {
  if (value.includes('\r')) return 'a carriage return';
  const lines = value.split('\n');
  const [firstLine = ''] = lines;
  if (lines.some((line) => line.length > maxLineLength)) {
    return 'a line longer than flyctl reads';
  }
  // flyctl cuts a line at `#` when the quotes before it pair up
  const hashAt = firstLine.indexOf('#');
  if (hashAt !== -1 && countQuotes(firstLine.slice(0, hashAt)) % 2 === 1) {
    return 'a # after an odd number of quote marks';
  }
  const isMultiline = lines.length > 1;
  const endsLineEarly = isMultiline
    ? lines.slice(0, -1).some((line) => line.endsWith(tripleQuote))
    : false;
  if (endsLineEarly) return 'a line ending in three quote marks';
  return undefined;
};

const formatFlyImport = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => {
      const reason = getUnwritableReason(value);
      if (reason !== undefined) {
        throw getUnsendableValueError({
          key,
          target: 'fly secrets import',
          reason: `it has ${reason}`,
        });
      }
      return `${key}=${tripleQuote}${value}${tripleQuote}\n`;
    })
    .join('');

// one `fly secrets import` for every value, so one release of the app
const getInvocations = ({
  target,
  root,
  values,
}: {
  target: FlyTarget;
  root: string;
  keys: readonly string[];
  values: Record<string, string>;
}) => [
  {
    command: 'fly',
    args: [
      'secrets',
      'import',
      ...(target.app === undefined ? [] : [`--app=${target.app}`]),
      ...(target.stage ? ['--stage'] : []),
    ],
    cwd: resolve(root, target.dir),
    keys: Object.keys(values),
    input: formatFlyImport(values),
    inputLabel: 'NAME="""value""" lines, on stdin',
    installHint: 'Install flyctl (https://fly.io/docs/flyctl/install/).',
    failureHint: "If it says you're not logged in, run `fly auth login`.",
  } satisfies CliInvocation,
];

export const flyTarget = {
  format: formatTarget,
  getInvocations,
  utils: { formatFlyImport },
};
