import { ExitCode } from '../errors.ts';
import { manifestService } from '../manifest/manifest.ts';
import type { Version } from '../secret-manager/secrets.ts';
import { format } from '../utils/format.ts';
import type { Painter } from '../utils/format.ts';
import { mapAll } from '../utils/map-all.ts';
import { commandService } from './context.ts';
import type { CommandHandler, Context } from './context.ts';

type HistoryRow = Version & { key: string; name: string; project: string };

// newest first; Google's times differ in their fractional digits, so they're compared as times
const compareNewestFirst = (a: HistoryRow, b: HistoryRow) =>
  Date.parse(b.created) - Date.parse(a.created) ||
  a.key.localeCompare(b.key) ||
  b.number - a.number;

const limitRows = <T>(rows: readonly T[], limit: number) =>
  limit === 0 ? rows : rows.slice(0, limit);

const formatMoreNote = (shownCount: number, total: number) =>
  shownCount < total
    ? `\nShowing the newest ${shownCount} of ${format.plural(total, 'version')}. --limit 0 shows them all.`
    : '';

const formatState = (paint: Painter, state: Version['state']) =>
  state === 'ENABLED' ? 'enabled' : paint('dim', state.toLowerCase());

const handleSecretHistory = async ({
  context: { io, loaded, line, secrets },
  env,
  key,
}: {
  context: Context;
  env: string;
  key: string;
}) => {
  const { project, name } = commandService.getSecretLocation(
    loaded.manifest,
    env,
    key,
  );
  const versions = await secrets.getVersions(project, name);
  if (versions === undefined) {
    throw commandService.getNotSetError({ env, key, name });
  }
  const shownVersions = limitRows(versions, line.limit);
  if (line.isJson) {
    io.stdout.write(
      format.json({
        key,
        env,
        project,
        name,
        versions: shownVersions,
        total: versions.length,
      }),
    );
    return ExitCode.ok;
  }
  const paint = format.painter({ env: io.env, isTTY: io.stdout.isTTY });
  const now = io.now();
  const rows = shownVersions.map((v) => [
    String(v.number),
    formatState(paint, v.state),
    format.when(v.created, now),
    paint('dim', format.ago(v.created, now)),
  ]);
  const body =
    rows.length === 0
      ? 'It has no versions yet.'
      : format.table([
          ['version', 'state', 'added', ''].map((h) => paint('bold', h)),
          ...rows,
        ]);
  io.stdout.write(
    `${key} in ${env}: ${name} in ${project}\n\n${body}${formatMoreNote(shownVersions.length, versions.length)}\n`,
  );
  return ExitCode.ok;
};

const handleEnvHistory = async ({
  context: { io, loaded, line, secrets },
  env,
}: {
  context: Context;
  env: string;
}) => {
  const { manifest } = loaded;
  const keys = manifestService.envs.getSecretKeys(manifest, env);
  const secretHistories = await mapAll(keys, async (key) => {
    const { project, name } = commandService.getSecretLocation(
      manifest,
      env,
      key,
    );
    return {
      key,
      project,
      name,
      versions: await secrets.getVersions(project, name),
    };
  });
  const allRows = secretHistories
    .flatMap(({ key, project, name, versions }) =>
      (versions ?? []).map((v) => ({ ...v, key, project, name })),
    )
    .toSorted(compareNewestFirst);
  const missing = secretHistories
    .filter((h) => (h.versions ?? []).length === 0)
    .map(({ key, project, name }) => ({ key, project, name }));
  const shownRows = limitRows(allRows, line.limit);

  if (line.isJson) {
    io.stdout.write(
      format.json({
        env,
        versions: shownRows.map((r) => ({
          key: r.key,
          name: r.name,
          project: r.project,
          number: r.number,
          state: r.state,
          created: r.created,
        })),
        total: allRows.length,
        missing,
      }),
    );
    return ExitCode.ok;
  }
  const paint = format.painter({ env: io.env, isTTY: io.stdout.isTTY });
  const now = io.now();
  const rows = [
    ...shownRows.map((r) => [
      format.when(r.created, now),
      paint('dim', format.ago(r.created, now)),
      r.key,
      String(r.number),
      formatState(paint, r.state),
    ]),
    ...missing.map(({ key }) => [
      '-',
      '',
      key,
      '-',
      paint('yellow', 'missing'),
    ]),
  ];
  const body =
    rows.length === 0
      ? `storehouse.json lists no secrets used in ${env}.`
      : format.table([
          ['added', '', 'key', 'version', 'state'].map((h) => paint('bold', h)),
          ...rows,
        ]);
  io.stdout.write(
    `${body}${formatMoreNote(shownRows.length, allRows.length)}\n`,
  );
  return ExitCode.ok;
};

export const handleHistory: CommandHandler = (context) => {
  const { manifest } = context.loaded;
  const [envWord = '', keyWord] = context.line.words;
  const env = commandService.assertEnv(manifest, envWord);
  if (keyWord === undefined) return () => handleEnvHistory({ context, env });
  const key = commandService.assertKey(manifest, env, keyWord);
  return () => handleSecretHistory({ context, env, key });
};
