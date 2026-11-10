import { ExitCode } from '../errors.ts';
import type { Io } from '../terminal/io.ts';
import { format } from '../utils/format.ts';

export const handleAuth = async ({
  io,
  isJson,
}: {
  io: Io;
  isJson: boolean;
}) => {
  const { source, detail, token } = await io.google.credentials.describe();
  if (isJson) {
    io.stdout.write(
      format.json({
        source,
        detail,
        ...(token.quotaProject !== undefined && {
          quotaProject: token.quotaProject,
        }),
      }),
    );
    return ExitCode.ok;
  }
  io.stdout.write(
    `Google credentials: ${source} (${detail}).\n${token.quotaProject === undefined ? '' : `Quota project: ${token.quotaProject}.\n`}`,
  );
  return ExitCode.ok;
};
