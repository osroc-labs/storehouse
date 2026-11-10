import { parseArgs } from 'node:util';
import { getUsageError } from '../errors.ts';
import { EnvPosition, commands } from './commands.ts';
import type { CommandName } from './commands.ts';
import { optionHelp, options } from './options.ts';

type Tokens = NonNullable<ReturnType<typeof parseArgs>['tokens']>;

const defaultLimit = 20;

const isCommand = (word: string | undefined): word is CommandName =>
  word !== undefined && Object.hasOwn(commands, word);

const isKnownOption = (name: string): name is keyof typeof options =>
  Object.hasOwn(options, name);

const formatUsage = (name: CommandName) => {
  const { args } = commands[name];
  return `Usage: storehouse ${name}${args ? ` ${args}` : ''}\nRun storehouse ${name} --help for more.`;
};

// one paragraph wrapped at 78 columns, for a terminal
const wrapParagraph = (paragraph: string) => {
  const lines: string[] = [];
  for (const word of paragraph.split(' ')) {
    const last = lines.at(-1);
    if (last === undefined || `${last} ${word}`.length > 78) lines.push(word);
    else lines[lines.length - 1] = `${last} ${word}`;
  }
  return lines.join('\n');
};

const wrapParagraphs = (text: string) =>
  text.split('\n').map(wrapParagraph).join('\n');

const formatMainHelp = (version: string) => {
  const entries = Object.entries(commands);
  const width = Math.max(
    ...entries.map(([name, c]) => `${name} ${c.args}`.length),
  );
  return `storehouse ${version}: Google Secret Manager, with a manifest in the repo.

Usage: storehouse <command> [options]

Commands:
${entries.map(([name, c]) => `  ${`${name} ${c.args}`.padEnd(width)}   ${c.summary}`).join('\n')}

Options:
  -h, --help     help for storehouse or a command
  --version      print the version

storehouse reads storehouse.json from this directory or the nearest parent.
Run storehouse <command> --help for a command's options.

Exit codes: see the README.
`;
};

const formatCommandHelp = (name: CommandName) => {
  const command = commands[name];
  const flags = command.options.map((o) => `  ${optionHelp[o]}`);
  const optionsBlock =
    flags.length > 0 ? `\nOptions:\n${flags.join('\n')}\n` : '';
  return `Usage: storehouse ${name}${command.args ? ` ${command.args}` : ''}${flags.length > 0 ? ' [options]' : ''}

${command.summary}

${wrapParagraphs(command.details)}
${optionsBlock}`;
};

// every flag on the line, checked against what the command takes, in storehouse's own words
const assertFlags = (tokens: Tokens, command: CommandName | undefined) => {
  const forCommand = command === undefined ? '' : ` for storehouse ${command}`;
  const usage =
    command === undefined
      ? 'Run storehouse --help for the commands.'
      : formatUsage(command);
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    const { name, rawName } = token;
    if (!isKnownOption(name)) {
      throw getUsageError(`Unknown option ${rawName}${forCommand}.\n${usage}`);
    }
    const isGlobal = name === 'help' || name === 'version';
    const isTakenByCommand =
      command === undefined ||
      commands[command].options.some((o: string) => o === name);
    if (!isGlobal && !isTakenByCommand) {
      throw getUsageError(
        `storehouse ${command} doesn't take ${rawName}.\n${usage}`,
      );
    }
    if (options[name].type === 'string' && token.value === undefined) {
      throw getUsageError(`${rawName} needs a value.\n${usage}`);
    }
    if (options[name].type === 'boolean' && token.inlineValue === true) {
      throw getUsageError(`${rawName} doesn't take a value.\n${usage}`);
    }
  }
};

const getStringValue = (value: string | boolean | undefined) =>
  typeof value === 'string' ? value : undefined;

const parseLimit = (text: string | undefined) => {
  if (text === undefined) return defaultLimit;
  if (/^\d+$/.test(text)) return Number(text);
  throw getUsageError(
    `--limit takes a whole number of versions, or 0 for all, not "${text}".`,
  );
};

// The command line as storehouse acts on it. Flags may come before or after the command, as
// `--out path` or `--out=path`.
const parseCommandLine = (argv: readonly string[]) => {
  const { values, positionals, tokens } = parseArgs({
    args: [...argv],
    options,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const [first, ...words] = positionals;
  const command = isCommand(first) ? first : undefined;
  assertFlags(tokens, command);
  if (values.version === true) return { kind: 'version' } as const;
  if (first === 'help') {
    const [topic] = words;
    if (topic === undefined) return { kind: 'help' } as const;
    if (!isCommand(topic)) {
      throw getUsageError(`There's no command "${topic}".`);
    }
    return { kind: 'help', command: topic } as const;
  }
  if (first === undefined) return { kind: 'help' } as const;
  if (command === undefined) {
    throw getUsageError(
      `There's no command "${first}". The commands are ${Object.keys(commands).join(', ')}.`,
    );
  }
  if (values.help === true) return { kind: 'help', command } as const;
  const { min, max } = commands[command];
  if (words.length < min || words.length > max) {
    throw getUsageError(formatUsage(command));
  }
  return {
    kind: 'command',
    command,
    words,
    isJson: values.json === true,
    isDryRun: values['dry-run'] === true,
    isForced: values.force === true,
    out: getStringValue(values.out),
    limit: parseLimit(getStringValue(values.limit)),
    isWriting: values.write === true,
    file: getStringValue(values.file),
  } as const;
};

type CommandLine = ReturnType<typeof parseCommandLine>;
export type ParsedCommand = Extract<CommandLine, { kind: 'command' }>;

const envWordsByPosition = {
  [EnvPosition.all]: (words) => words,
  [EnvPosition.first]: (words) => words.slice(0, 1),
  [EnvPosition.none]: () => [],
} satisfies Record<
  EnvPosition,
  (words: readonly string[]) => readonly string[]
>;

// The envs a parsed command acts on, by name. An empty list for status means every env.
const getEnvWords = (line: CommandLine) =>
  line.kind === 'command'
    ? envWordsByPosition[commands[line.command].envs](line.words)
    : [];

export const commandLineService = {
  parse: parseCommandLine,
  getEnvWords,
  help: { main: formatMainHelp, command: formatCommandHelp },
};
