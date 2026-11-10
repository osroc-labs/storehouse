import { parseEnv } from 'node:util';
import { CliError, ExitCode } from './errors.ts';

// a value pasted at a prompt or piped from `echo` usually ends with the newline that ended it
const stripTrailingNewline = (value: string) =>
  value.endsWith('\n') ? value.slice(0, -1) : value;

const parseDotenv = (text: string) =>
  Object.fromEntries(
    Object.entries(parseEnv(text)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const getLossyValueError = (key: string, reason: string) =>
  new CliError(
    ExitCode.failed,
    `${key}: a value with ${reason} can't be written to a dotenv file without changing it. Nothing was written.`,
  );

// Written so Node's parseEnv and wrangler's .dev.vars parser (dotenv 16) both read back exactly the
// value. Neither keeps a carriage return, so one is refused.
const formatDotenvValue = (key: string, value: string) => {
  if (value.includes('\r')) {
    throw getLossyValueError(
      key,
      'a carriage return (a Windows line ending, say)',
    );
  }
  if (/^[^\s"'`#\\]*$/.test(value)) return value;
  if (!/['\n]/.test(value)) return `'${value}'`;
  if (!/["\\]/.test(value)) return `"${value.replaceAll('\n', '\\n')}"`;
  throw getLossyValueError(
    key,
    'a single quote or a line break, and a double quote or a backslash',
  );
};

const formatDotenv = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([key, value]) => `${key}=${formatDotenvValue(key, value)}\n`)
    .join('');

export const dotenvService = {
  parse: parseDotenv,
  format: formatDotenv,
  stripTrailingNewline,
};
