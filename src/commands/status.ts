import { ExitCode } from '../errors.ts';
import { manifestService } from '../manifest/manifest.ts';
import { GoogleRequestError } from '../secret-manager/secret-manager-api.ts';
import type { Manifest } from '../manifest/schema.ts';
import { format } from '../utils/format.ts';
import type { Painter } from '../utils/format.ts';
import { mapAll } from '../utils/map-all.ts';
import { commandService } from './context.ts';
import type { CommandHandler, Context } from './context.ts';

type Cell =
  | { state: 'unused' }
  | { state: 'denied'; name: string; project: string }
  | { state: 'missing'; name: string; project: string }
  | {
      state: 'set';
      name: string;
      project: string;
      version: number;
      updated: string;
    };

const getCell = async ({
  secrets,
  manifest,
  key,
  env,
}: {
  secrets: Context['secrets'];
  manifest: Manifest;
  key: string;
  env: string;
}): Promise<Cell> => {
  if (!manifestService.secrets.isUsedIn(manifest, key, env)) {
    return { state: 'unused' };
  }
  const { project, name } = commandService.getSecretLocation(
    manifest,
    env,
    key,
  );
  let latestVersion;
  try {
    latestVersion = await secrets.getLatestVersion(project, name);
  } catch (error) {
    // one secret the caller can't see shouldn't hide the rest of the table
    if (error instanceof GoogleRequestError && error.httpStatus === 403) {
      return { state: 'denied', name, project };
    }
    throw error;
  }
  if (latestVersion?.state !== 'ENABLED') {
    return { state: 'missing', name, project };
  }
  return {
    state: 'set',
    name,
    project,
    version: latestVersion.number,
    updated: latestVersion.created,
  };
};

const formatCell = ({
  cell,
  isRequired,
  paint,
  now,
}: {
  cell: Cell;
  isRequired: boolean;
  paint: Painter;
  now: Date;
}) => {
  if (cell.state === 'set') {
    return paint('green', `set ${format.ago(cell.updated, now)}`);
  }
  if (cell.state === 'unused') return paint('dim', '-');
  if (cell.state === 'denied') return paint('red', 'no access');
  return isRequired ? paint('red', 'MISSING') : paint('yellow', 'missing');
};

// a refused read is a failure even when a required secret is missing too: it may be set
const getStatusExitCode = ({
  hasDenied,
  hasMissingRequired,
}: {
  hasDenied: boolean;
  hasMissingRequired: boolean;
}) => {
  if (hasDenied) return ExitCode.failed;
  return hasMissingRequired ? ExitCode.missing : ExitCode.ok;
};

const formatLeftOutNote = (shownEnvs: string[], leftOut: string[]) => {
  const isOne = leftOut.length === 1;
  return `${leftOut.join(', ')} ${isOne ? 'is' : 'are'} protected and not shown. Name ${isOne ? 'it' : 'them'} to include ${isOne ? 'it' : 'them'}: storehouse status ${[...shownEnvs, ...leftOut].join(' ')}`;
};

export const handleStatus: CommandHandler = ({
  io,
  loaded,
  line,
  secrets,
  protectedEnvs,
}) => {
  const { manifest } = loaded;
  const allEnvs = Object.keys(manifest.envs);
  const isNamingEnvs = line.words.length > 0;
  const envs = isNamingEnvs
    ? [
        ...new Set(
          line.words.map((env) => commandService.assertEnv(manifest, env)),
        ),
      ]
    : allEnvs.filter((env) => !protectedEnvs.has(env));
  const leftOut = isNamingEnvs
    ? []
    : allEnvs.filter((env) => !envs.includes(env));
  const keys = Object.keys(manifest.secrets);

  return async () => {
    const pairs = keys.flatMap((key) => envs.map((env) => ({ key, env })));
    const cells = await mapAll(pairs, ({ key, env }) =>
      getCell({ secrets, manifest, key, env }),
    );
    const getCellFor = (key: string, env: string) =>
      cells[pairs.findIndex((p) => p.key === key && p.env === env)] ?? {
        state: 'unused',
      };
    const missingRequired = pairs.filter(
      ({ key, env }) =>
        manifest.secrets[key]?.required === true &&
        getCellFor(key, env).state === 'missing',
    );
    const denied = pairs.flatMap(({ key, env }) => {
      const cell = getCellFor(key, env);
      return cell.state === 'denied' ? [{ key, env, ...cell }] : [];
    });
    const exitCode = getStatusExitCode({
      hasDenied: denied.length > 0,
      hasMissingRequired: missingRequired.length > 0,
    });
    const deniedNote =
      denied.length > 0
        ? `Google refused to show ${format.plural(denied.length, 'secret')}: ${denied.map((d) => `${d.key} in ${d.env}`).join(', ')}. You need Secret Manager Viewer on ${[...new Set(denied.map((d) => d.project))].join(', ')} to see them.\n`
        : '';

    if (line.isJson) {
      io.stdout.write(
        format.json({
          envs,
          secrets: keys.map((key) => ({
            key,
            purpose: manifest.secrets[key]?.purpose,
            required: manifest.secrets[key]?.required,
            envs: Object.fromEntries(
              envs.map((env) => [env, getCellFor(key, env)]),
            ),
          })),
          missingRequired,
          ...(leftOut.length > 0 && { protectedLeftOut: leftOut }),
        }),
      );
      io.stderr.write(deniedNote);
      return exitCode;
    }

    const paint = format.painter({ env: io.env, isTTY: io.stdout.isTTY });
    const now = io.now();
    const rows = keys.map((key) => [
      key,
      ...envs.map((env) =>
        formatCell({
          cell: getCellFor(key, env),
          isRequired: manifest.secrets[key]?.required === true,
          paint,
          now,
        }),
      ),
    ]);
    const header = ['', ...envs].map((h) => paint('bold', h));
    const grid = format.table([header, ...rows]).split('\n');
    const gridWidth = Math.max(...grid.map(format.visibleWidth));
    const room = io.stdout.isTTY ? (io.stdout.columns ?? 0) : 0;
    const lines = grid.map((row, i) => {
      const start = `${row}${' '.repeat(gridWidth - format.visibleWidth(row))}  `;
      if (i === 0) return `${start}${paint('bold', 'purpose')}`;
      const purpose = manifest.secrets[keys[i - 1] ?? '']?.purpose ?? '';
      return `${start}${paint('dim', format.truncate(purpose, room - format.visibleWidth(start)))}`;
    });

    const out =
      keys.length === 0 ? ['storehouse.json lists no secrets yet.'] : lines;
    if (leftOut.length > 0) out.push('', formatLeftOutNote(envs, leftOut));
    if (missingRequired.length > 0) {
      out.push(
        '',
        paint(
          'red',
          `${format.plural(missingRequired.length, 'required secret is', 'required secrets are')} missing:`,
        ),
        ...missingRequired.map(
          ({ key, env }) => `  storehouse set ${env} ${key}`,
        ),
      );
    }
    io.stdout.write(`${out.join('\n')}\n`);
    io.stderr.write(deniedNote);
    return exitCode;
  };
};
