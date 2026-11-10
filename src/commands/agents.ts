import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { agentGuideService } from '../agents/agent-guide.ts';
import { guideFileService } from '../agents/guide-file.ts';
import { guideTargetService } from '../agents/guide-target.ts';
import { ExitCode } from '../errors.ts';
import { fileService } from '../files.ts';
import { gitService } from '../git.ts';
import { manifestService } from '../manifest/manifest.ts';
import type { LoadedManifest } from '../manifest/manifest.ts';
import type { Io } from '../terminal/io.ts';

// the CLAUDE.md nearest above dir, up to the repo root, or undefined when there's none
const findClaudeFileAbove = (dir: string, repoRoot: string) => {
  let current = dirname(dir);
  while (current === repoRoot || current.startsWith(`${repoRoot}/`)) {
    const claudePath = join(current, 'CLAUDE.md');
    if (existsSync(claudePath)) return claudePath;
    if (dirname(current) === current) return undefined;
    current = dirname(current);
  }
  return undefined;
};

// Claude Code reads AGENTS.md only where no CLAUDE.md sits in or above its directory.
const formatClaudeNote = ({
  guidePath,
  repoRoot,
  cwd,
}: {
  guidePath: string;
  repoRoot: string;
  cwd: string;
}) => {
  if (basename(guidePath) !== 'AGENTS.md') return undefined;
  const dir = realpathSync.native(dirname(guidePath));
  if (existsSync(join(dir, 'CLAUDE.md'))) return undefined;
  const claudePath = findClaudeFileAbove(dir, repoRoot);
  if (claudePath === undefined) return undefined;
  const shownClaudePath = fileService.formatPath(
    join(dirname(guidePath), relative(dir, claudePath)),
    cwd,
  );
  return `Claude Code won't read ${fileService.formatPath(guidePath, cwd)} while ${shownClaudePath} is above it. Add a CLAUDE.md beside it with the line @AGENTS.md, or put the guide in a CLAUDE.md with --file.`;
};

export const handleAgents = ({
  io,
  loaded,
  isWriting,
  isDryRun,
  isForced,
  file,
}: {
  io: Io;
  loaded: LoadedManifest;
  isWriting: boolean;
  isDryRun: boolean;
  isForced: boolean;
  file: string | undefined;
}) => {
  const guidePath =
    file === undefined ? join(loaded.root, 'AGENTS.md') : resolve(io.cwd, file);
  const guide = agentGuideService.format({
    manifest: loaded.manifest,
    manifestPath: loaded.path,
    guidePath,
    protectedEnvs: manifestService.getProtectedEnvs({
      manifest: loaded.manifest,
      path: loaded.path,
      cwd: loaded.root,
    }),
  });
  if (!isWriting && !isDryRun) {
    io.stdout.write(`${guide}\n`);
    return ExitCode.ok;
  }
  const shownPath = fileService.formatPath(guidePath, io.cwd);
  const repoRoot =
    gitService.getRepoRoot(loaded.path) ?? realpathSync.native(loaded.root);
  const target = guideTargetService.get({
    manifestPath: loaded.path,
    path: guidePath,
    shownPath,
    repoRoot,
    isNamed: file !== undefined,
    isForced,
  });
  if (target.notice !== undefined) io.stderr.write(`${target.notice}\n`);
  const existing = guideTargetService.read(target.path, shownPath);
  const updatedText = guideFileService.place({
    existingText: existing?.text,
    guide,
    fileName: shownPath,
  });
  if (updatedText === existing?.text) {
    io.stdout.write(`${shownPath} is current.\n`);
    return ExitCode.ok;
  }
  if (isDryRun) {
    io.stdout.write(
      `${guideFileService.formatChange({ before: existing?.text ?? '', after: updatedText, fileName: shownPath })}\n`,
    );
    return ExitCode.ok;
  }
  guideTargetService.write({
    path: target.path,
    shownPath,
    existing,
    text: updatedText,
  });
  io.stdout.write(
    `${existing === undefined ? 'Wrote' : 'Updated'} storehouse's guide in ${shownPath}.\n`,
  );
  const claudeNote =
    existing === undefined
      ? formatClaudeNote({ guidePath, repoRoot, cwd: io.cwd })
      : undefined;
  if (claudeNote !== undefined) io.stderr.write(`${claudeNote}\n`);
  return ExitCode.ok;
};
