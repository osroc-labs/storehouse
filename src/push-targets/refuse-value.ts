import { CliError, ExitCode } from '../errors.ts';

// A value a platform's CLI would change on the way in is refused before anything is sent.
export const getUnsendableValueError = ({
  key,
  target,
  reason,
}: {
  key: string;
  target: string;
  reason: string;
}) =>
  new CliError(
    ExitCode.failed,
    `${key}: ${target} can't take this value as it is (${reason}), so nothing was sent anywhere.`,
  );
