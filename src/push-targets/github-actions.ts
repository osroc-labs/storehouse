import type { PushTargetConfig } from '../manifest/schema.ts';
import { getUnsendableValueError } from './refuse-value.ts';
import type { CliInvocation } from './run-cli.ts';

type GithubActionsTarget = Extract<PushTargetConfig, { to: 'github-actions' }>;

const formatTarget = (target: GithubActionsTarget) => {
  if (target.org !== undefined)
    return `github-actions in the ${target.org} organization`;
  const repo = target.repo ?? 'this repo';
  return target.environment === undefined
    ? `github-actions in ${repo}`
    : `github-actions in ${repo} (environment ${target.environment})`;
};

const getScopeArgs = (target: GithubActionsTarget) => [
  // each flag one token, so a manifest value can never be read as a flag of its own
  ...(target.repo === undefined ? [] : [`--repo=${target.repo}`]),
  ...(target.environment === undefined ? [] : [`--env=${target.environment}`]),
  ...(target.org === undefined ? [] : [`--org=${target.org}`]),
  ...(target.visibility === undefined
    ? []
    : [`--visibility=${target.visibility}`]),
  ...(target.repos === undefined ? [] : [`--repos=${target.repos.join(',')}`]),
  ...(target.app === undefined ? [] : [`--app=${target.app}`]),
];

// gh reads a value from stdin and trims its trailing line breaks, so a value ending in one can't
// arrive as it is
const assertSendable = (key: string, value: string) => {
  if (!/[\r\n]$/.test(value)) return;
  throw getUnsendableValueError({
    key,
    target: 'gh secret set',
    reason: 'gh drops a trailing line break',
  });
};

// one `gh secret set` per secret, the value on stdin and only the name in argv
const getInvocations = ({
  target,
  root,
  keys,
  values,
}: {
  target: GithubActionsTarget;
  root: string;
  keys: readonly string[];
  values: Record<string, string>;
}) =>
  keys.map((key) => {
    const value = values[key] ?? '';
    assertSendable(key, value);
    return {
      command: 'gh',
      args: ['secret', 'set', key, ...getScopeArgs(target)],
      cwd: root,
      keys: [key],
      input: value,
      inputLabel: `the value of ${key}, on stdin`,
      installHint: 'Install the GitHub CLI (https://cli.github.com).',
      failureHint:
        "If it says you're not logged in, run `gh auth login`; an organization secret needs the admin:org scope.",
    } satisfies CliInvocation;
  });

export const githubActionsTarget = { format: formatTarget, getInvocations };
