import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { SecretInputFormat } from './manifest/schema.ts';
import type { WorkflowRule } from './manifest/schema.ts';

// Secret Manager secrets that GitHub Actions workflows name, so check can find any the manifest
// lacks. Google's own action is known; anything else is a rule in the manifest's `workflows`.
const builtInRules = [
  {
    uses: 'google-github-actions/get-secretmanager-secrets',
    inputs: { secrets: SecretInputFormat.resource },
  },
] satisfies WorkflowRule[];

const inputsSchema = z.record(z.string(), z.unknown());
const workflowSchema = z.object({
  jobs: z
    .record(
      z.string(),
      z.object({
        uses: z.string().optional(),
        with: inputsSchema.optional(),
        steps: z
          .array(
            z.object({
              uses: z.string().optional(),
              with: inputsSchema.optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

// past these lengths a pattern or a workflow's text is too long to be a real one, and doesn't match
const maxPatternLength = 200;
const maxTextLength = 1000;

// Past these, check stops and says so rather than run for minutes on a hostile repo.
const maxWorkflowFiles = 100;
const maxWorkflowBytes = 256 * 1024;
const maxEntriesPerFile = 10_000;
const maxEntriesPerCheck = 40_000;
const maxNamesPerCheck = 10_000;
const maxStepsPerFile = 1000;
const maxMatchesPerCheck = 200_000;

export class WorkflowLimitError extends Error {}

// A glob compiled once: `*` matches anything, `/` included, and everything else matches itself.
// The parts between stars are found left to right with indexOf, so no pattern backtracks.
const getGlobMatcher = (pattern: string) => {
  if (pattern.length > maxPatternLength) return () => false;
  const parts = pattern.split('*');
  const first = parts[0] ?? '';
  const last = parts.at(-1) ?? '';
  const middle = parts.slice(1, -1);
  return (text: string) => {
    if (text.length > maxTextLength) return false;
    if (parts.length === 1) return text === pattern;
    if (!text.startsWith(first) || !text.endsWith(last)) return false;
    const end = text.length - last.length;
    let at = first.length;
    if (at > end) return false;
    for (const part of middle) {
      const found = text.indexOf(part, at);
      if (found === -1 || found + part.length > end) return false;
      at = found + part.length;
    }
    return true;
  };
};

const isGlobMatch = (pattern: string, text: string) =>
  getGlobMatcher(pattern)(text);

type CompiledRule = {
  isUsesMatch: (text: string) => boolean;
  inputs: { isMatch: (text: string) => boolean; format: SecretInputFormat }[];
};

// the built-in rules and the manifest's, each glob compiled once for the whole check
const compileRules = (rules: readonly WorkflowRule[]): CompiledRule[] =>
  [...builtInRules, ...rules].map((rule) => ({
    isUsesMatch: getGlobMatcher(rule.uses),
    inputs: Object.entries(rule.inputs).map(([pattern, format]) => ({
      isMatch: getGlobMatcher(pattern),
      format,
    })),
  }));

// What a check may still spend: glob matches, YAML keys and list items parsed, and secret names
// read. Each spend throws a WorkflowLimitError once its allowance runs out.
const createMatchBudget = () => {
  const left = {
    matches: maxMatchesPerCheck,
    entries: maxEntriesPerCheck,
    names: maxNamesPerCheck,
  };
  const spendOn = (kind: keyof typeof left, count: number, what: string) => {
    left[kind] -= count;
    if (left[kind] < 0) {
      throw new WorkflowLimitError(
        `${what} Use fewer rules or split the workflows.`,
      );
    }
  };
  return {
    spend: () => {
      spendOn(
        'matches',
        1,
        `too many workflow rules, steps and inputs to check (over ${maxMatchesPerCheck} matches).`,
      );
    },
    spendEntries: (count: number) => {
      spendOn(
        'entries',
        count,
        `too many YAML keys and list items across the workflows to check (over ${maxEntriesPerCheck}).`,
      );
    },
    spendNames: (count: number) => {
      spendOn(
        'names',
        count,
        `too many secret names across the workflows to check (over ${maxNamesPerCheck}).`,
      );
    },
  };
};

type MatchBudget = ReturnType<typeof createMatchBudget>;

const splitLines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

// commas and line breaks separate entries, except where a backslash escapes them
const splitEntries = (value: string) =>
  value
    .split(/(?<!\\)[,\n]/)
    .map((entry) => entry.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter(Boolean);

const getLabelledName = (line: string) =>
  line
    .slice(line.indexOf(':') + 1)
    .trim()
    .replace(/@[^@]*$/, '');

// `projects/p/secrets/s[/versions/v]` or `p/s[/v]`; a regional secret isn't one storehouse manages
const parseSecretResource = (reference: string) => {
  const longForm =
    /^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/[^/]+)?$/.exec(
      reference,
    );
  if (longForm) return { project: longForm[1] ?? '', name: longForm[2] ?? '' };
  if (reference.startsWith('projects/')) return undefined;
  const shortForm = /^([^/]+)\/([^/]+)(?:\/[^/]+)?$/.exec(reference);
  if (shortForm) {
    return { project: shortForm[1] ?? '', name: shortForm[2] ?? '' };
  }
  return undefined;
};

const getResourceSecrets = (value: string) =>
  splitEntries(value).flatMap((entry) => {
    const at = entry.search(/(?<!\\):/);
    const secret = parseSecretResource(entry.slice(at + 1).trim());
    return secret ? [secret] : [];
  });

// a lookup typed as the table, so every format returns the same shape
const secretsByFormat: Record<
  SecretInputFormat,
  (value: string) => { name: string; project?: string }[]
> = {
  [SecretInputFormat.name]: (value) =>
    splitLines(value)
      .slice(0, 1)
      .map((name) => ({ name })),
  [SecretInputFormat.names]: (value) =>
    splitLines(value).map((name) => ({ name })),
  [SecretInputFormat.labelled]: (value) =>
    splitLines(value).map((line) => ({ name: getLabelledName(line) })),
  [SecretInputFormat.resource]: getResourceSecrets,
};

const getInputFormat = ({
  rules,
  uses,
  input,
  budget,
}: {
  rules: readonly CompiledRule[];
  uses: string;
  input: string;
  budget: MatchBudget;
}) => {
  const target = uses.replace(/@[^@]*$/, '');
  if (target.length > maxTextLength || input.length > maxTextLength) {
    return undefined;
  }
  for (const rule of rules) {
    budget.spend();
    if (!rule.isUsesMatch(target)) continue;
    for (const { isMatch, format } of rule.inputs) {
      budget.spend();
      if (isMatch(input)) return format;
    }
  }
  return undefined;
};

const getReferencesFromInputs = ({
  rules,
  uses,
  inputs,
  file,
  where,
  budget,
}: {
  rules: readonly CompiledRule[];
  budget: MatchBudget;
  uses: string | undefined;
  inputs: Record<string, unknown> | undefined;
  file: string;
  where: string;
}) =>
  Object.entries(inputs ?? {}).flatMap(([input, value]) => {
    if (uses === undefined || typeof value !== 'string') return [];
    // an expression (`${{ … }}`) is only known when the workflow runs
    if (value.includes('${{')) return [];
    const format = getInputFormat({ rules, uses, input, budget });
    if (format === undefined) return [];
    const secrets = secretsByFormat[format](value);
    budget.spendNames(secrets.length);
    return secrets.map((secret) => ({
      ...secret,
      file,
      where: `${where}.with.${input}`,
    }));
  });

// A count, in one pass, that no YAML can have more keys or list items than: every key or item in
// block style starts a line, and in flow style follows a comma or a colon. The parse slows with
// many keys, so this runs first.
const countPossibleEntries = (text: string) => {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === ',' || char === ':') count++;
  }
  return count;
};

// Every secret one workflow file names, by the compiled rules. Throws on YAML that doesn't parse,
// and a WorkflowLimitError on a file or a check too big to finish quickly.
const getWorkflowReferences = ({
  file,
  text,
  rules,
  budget,
}: {
  file: string;
  text: string;
  rules: readonly CompiledRule[];
  budget: MatchBudget;
}) => {
  const entryCount = countPossibleEntries(text);
  if (entryCount > maxEntriesPerFile) {
    throw new WorkflowLimitError(
      `has more than ${maxEntriesPerFile} lines, commas and colons, too many to check.`,
    );
  }
  budget.spendEntries(entryCount);
  const parsedWorkflow = workflowSchema.safeParse(parse(text));
  if (!parsedWorkflow.success) return [];
  const jobs = Object.entries(parsedWorkflow.data.jobs ?? {});
  const stepCount = jobs.reduce(
    (count, [, job]) => count + 1 + (job.steps?.length ?? 0),
    0,
  );
  if (stepCount > maxStepsPerFile) {
    throw new WorkflowLimitError(
      `has more than ${maxStepsPerFile} jobs and steps, too many to check.`,
    );
  }
  return jobs.flatMap(([id, job]) => [
    ...getReferencesFromInputs({
      rules,
      uses: job.uses,
      inputs: job.with,
      file,
      where: `jobs.${id}`,
      budget,
    }),
    ...(job.steps ?? []).flatMap((step, i) =>
      getReferencesFromInputs({
        rules,
        uses: step.uses,
        inputs: step.with,
        file,
        where: `jobs.${id}.steps[${i}]`,
        budget,
      }),
    ),
  ]);
};

// One workflow file's text, read through a descriptor at most to the cap, or a problem: a
// symlink, a device or anything else that isn't a plain file is never opened.
const readWorkflowFile = (path: string) => {
  if (!lstatSync(path).isFile()) {
    return { problem: "isn't a regular file, so check doesn't read it." };
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      return { problem: "isn't a regular file, so check doesn't read it." };
    }
    const buffer = Buffer.alloc(maxWorkflowBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxWorkflowBytes) {
      return { problem: 'is over 256 KB, too big to check.' };
    }
    return { text: buffer.subarray(0, length).toString('utf8') };
  } finally {
    closeSync(fd);
  }
};

// The workflow files under .github/workflows, the first maxWorkflowFiles by name, each with its
// text or the problem that kept check from reading it.
const getWorkflowFiles = (root: string) => {
  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return { files: [], skippedCount: 0 };
  const names = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .toSorted();
  return {
    files: names.slice(0, maxWorkflowFiles).map((f) => ({
      file: join('.github', 'workflows', f),
      ...readWorkflowFile(join(dir, f)),
    })),
    skippedCount: Math.max(0, names.length - maxWorkflowFiles),
  };
};

export const workflowService = {
  isGlobMatch,
  compileRules,
  createMatchBudget,
  getFiles: getWorkflowFiles,
  getReferences: getWorkflowReferences,
};
