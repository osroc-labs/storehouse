// Every flag storehouse knows; each command says which of them it takes.
export const options = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  out: { type: 'string' },
  limit: { type: 'string' },
  write: { type: 'boolean' },
  file: { type: 'string' },
} as const;

export type CommandOption = Exclude<keyof typeof options, 'help' | 'version'>;

export const optionHelp = {
  json: '--json         print JSON',
  'dry-run':
    '--dry-run      say what would happen; read no values and change nothing',
  force: '--force        overwrite a file that exists',
  out: '--out <path>   write the value to a file (0600) instead of stdout',
  limit: '--limit <n>    show at most n versions (default 20; 0 for all)',
  write: '--write        put the guide in AGENTS.md beside storehouse.json',
  file: '--file <path>  with --write, the file to put it in instead (CLAUDE.md, say)',
} satisfies Record<CommandOption, string>;
