import { commandLineService } from '../command-line/command-line.ts';
import { CliError, ExitCode } from '../errors.ts';
import type { Io } from '../terminal/io.ts';
import { getAgentMarker } from './agents.ts';

// the part of a manifest protectedInvocation reads, so a guard can pass storehouse.json as parsed
export type ProtectedEnvs = { envs: Readonly<Record<string, unknown>> };

const formatEnvList = (envs: readonly string[]) => envs.join(', ');

// every word as it stands, and the value of each `--flag=value`
const getEveryWord = (argv: readonly string[]) =>
  argv.flatMap((word) => {
    const at = word.indexOf('=');
    return word.startsWith('-') && at > 0 ? [word, word.slice(at + 1)] : [word];
  });

const isProtectedEnv = (manifest: ProtectedEnvs, word: string) => {
  const env = Object.hasOwn(manifest.envs, word)
    ? manifest.envs[word]
    : undefined;
  return (
    typeof env === 'object' &&
    env !== null &&
    'protected' in env &&
    env.protected === true
  );
};

// the env words storehouse would act on, or every word when it would refuse the line
const getCandidateWords = (argv: readonly string[]) => {
  try {
    return commandLineService.getEnvWords(commandLineService.parse(argv));
  } catch {
    return getEveryWord(argv);
  }
};

/**
 * Whether a storehouse command line would act on a protected env, for a repo's guard to refuse it.
 * `argv` is the words after `storehouse`; `manifest` is storehouse.json as parsed. Returns the
 * protected envs it names with a reason to show, or undefined.
 */
export const protectedInvocation = (
  argv: readonly string[],
  manifest: ProtectedEnvs,
) => {
  const envs = [
    ...new Set(
      getCandidateWords(argv).filter((word) => isProtectedEnv(manifest, word)),
    ),
  ];
  if (envs.length === 0) return undefined;
  return {
    envs,
    reason: `\`storehouse ${argv.join(' ')}\` uses the protected env ${formatEnvList(envs)}, which is for a person in their own terminal.`,
  };
};

export type ProtectedInvocation = NonNullable<
  ReturnType<typeof protectedInvocation>
>;

const getRefusal = (message: string) => new CliError(ExitCode.refused, message);

// the run-time line for a protected env: no agent, a terminal on both ends, and its name typed
export const verifyProtectedAccess = async (
  envs: readonly string[],
  io: Io,
) => {
  if (envs.length === 0) return;
  const marker = getAgentMarker(io.env);
  if (marker) {
    throw getRefusal(
      `${formatEnvList(envs)} is a protected env, and ${marker.name} is set in this shell (${marker.agent}). Protected envs are for a person in their own terminal; no flag or variable changes that.`,
    );
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw getRefusal(
      `${formatEnvList(envs)} is a protected env: run storehouse in a terminal, with nothing piped into or out of it.`,
    );
  }
  for (const env of envs) {
    const typedName = await io.prompt(
      `${env} is a protected env. Type its name to go on: `,
      { isHidden: false },
    );
    if (typedName.trim() !== env) {
      throw getRefusal(`That isn't "${env}". Nothing was done.`);
    }
  }
};
