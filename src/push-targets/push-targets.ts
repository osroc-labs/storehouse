import type { PushTargetConfig } from '../manifest/schema.ts';
import { cloudflareWorkersTarget } from './cloudflare-workers.ts';
import { flyTarget } from './fly.ts';
import { githubActionsTarget } from './github-actions.ts';
import { vercelTarget } from './vercel.ts';
import type { CliInvocation } from './run-cli.ts';

type PushTargetKind = PushTargetConfig['to'];

type PushTargetHandler<K extends PushTargetKind> = {
  format: (target: Extract<PushTargetConfig, { to: K }>) => string;
  getInvocations: (options: {
    target: Extract<PushTargetConfig, { to: K }>;
    root: string;
    keys: readonly string[];
    values: Record<string, string>;
  }) => CliInvocation[];
};

// one handler per kind of target; a new kind fails to compile until it has one
const pushTargetHandlers: { [K in PushTargetKind]: PushTargetHandler<K> } = {
  'cloudflare-workers': cloudflareWorkersTarget,
  'github-actions': githubActionsTarget,
  vercel: vercelTarget,
  fly: flyTarget,
};

const getPushTargetHandler = <K extends PushTargetKind>(
  target: Extract<PushTargetConfig, { to: K }>,
): PushTargetHandler<K> => pushTargetHandlers[target.to];

export const pushTargetService = {
  format: (target: PushTargetConfig) =>
    getPushTargetHandler(target).format(target),
  getInvocations: (
    options: Omit<
      Parameters<PushTargetHandler<PushTargetKind>['getInvocations']>[0],
      'target'
    > & {
      target: PushTargetConfig;
    },
  ) => getPushTargetHandler(options.target).getInvocations(options),
};
