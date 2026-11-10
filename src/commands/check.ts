import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { agentGuideService } from '../agents/agent-guide.ts';
import { guideFileService } from '../agents/guide-file.ts';
import { guideTargetService } from '../agents/guide-target.ts';
import { ExitCode, getErrorMessage } from '../errors.ts';
import { gitService } from '../git.ts';
import { manifestService } from '../manifest/manifest.ts';
import type { Manifest } from '../manifest/schema.ts';
import type { Io } from '../terminal/io.ts';
import { format } from '../utils/format.ts';
import { WorkflowLimitError, workflowService } from '../workflows.ts';

const isDirectory = (path: string) =>
  existsSync(path) && statSync(path).isDirectory();

const getPathProblems = (manifest: Manifest, root: string) =>
  Object.entries(manifest.envs).flatMap(([env, config]) => [
    ...config.push.flatMap((target, i) =>
      !('dir' in target) || isDirectory(resolve(root, target.dir))
        ? []
        : [`envs.${env}.push[${i}].dir: there's no directory ${target.dir}.`],
    ),
    ...(config.pull && !isDirectory(dirname(join(root, config.pull.file)))
      ? [`envs.${env}.pull.file: there's no directory for ${config.pull.file}.`]
      : []),
  ]);

const getAllSecretNames = (manifest: Manifest) =>
  new Set(
    Object.keys(manifest.secrets).flatMap((key) =>
      manifestService.secrets
        .getEnvs(manifest, key)
        .map((env) => manifestService.secrets.getName(manifest, env, key)),
    ),
  );

const getManifestProjects = (manifest: Manifest) =>
  new Set(
    Object.keys(manifest.envs).map((env) =>
      manifestService.envs.getProject(manifest, env),
    ),
  );

// The manifest's secrets as a workflow can name them, built once per check: each name, and each
// project/name pair. A secret in a project the manifest doesn't use belongs to someone else.
const getManifestSecretIndex = (manifest: Manifest) => {
  const projects = getManifestProjects(manifest);
  const names = getAllSecretNames(manifest);
  const projectNames = new Set(
    Object.keys(manifest.secrets).flatMap((key) =>
      manifestService.secrets
        .getEnvs(manifest, key)
        .map(
          (env) =>
            `${manifestService.envs.getProject(manifest, env)}/${manifestService.secrets.getName(manifest, env, key)}`,
        ),
    ),
  );
  return (secret: { name: string; project?: string }) => {
    if (secret.project === undefined) return names.has(secret.name);
    if (!projects.has(secret.project)) return true;
    return projectNames.has(`${secret.project}/${secret.name}`);
  };
};

// GitHub reads workflows from the repo root, which is above a manifest in an app's own directory
const getWorkflowProblems = (manifest: Manifest, manifestPath: string) => {
  const workflowRoot =
    gitService.getRepoRoot(manifestPath) ?? dirname(manifestPath);
  const rules = workflowService.compileRules(manifest.workflows);
  const isSecretInManifest = getManifestSecretIndex(manifest);
  const budget = workflowService.createMatchBudget();
  const { files, skippedCount } = workflowService.getFiles(workflowRoot);
  const workflowChecks = files.map(({ file, text, problem }) => {
    if (text === undefined) {
      return {
        hasReferences: false,
        problems: [`${format.inline(file)}: ${problem}`],
      };
    }

    try {
      const references = workflowService.getReferences({
        file,
        text,
        rules,
        budget,
      });
      return {
        hasReferences: references.length > 0,
        problems: references
          .filter((ref) => !isSecretInManifest(ref))
          .map(
            (ref) =>
              `${format.inline(ref.file)}: ${format.inline(ref.where)} names ${JSON.stringify(ref.project === undefined ? ref.name : `${ref.project}/${ref.name}`)}, which storehouse.json doesn't have. Add the secret, with "name": ${JSON.stringify(ref.name)} if the pattern doesn't make it.`,
          ),
      };
    } catch (error) {
      if (error instanceof WorkflowLimitError) {
        return {
          hasReferences: false,
          problems: [`${format.inline(file)}: ${error.message}`],
        };
      }
      return {
        hasReferences: false,
        problems: [
          `${format.inline(file)}: isn't valid YAML (${getErrorMessage(error).split('\n')[0] ?? ''}).`,
        ],
      };
    }
  });
  return {
    problems: [
      ...workflowChecks.flatMap((c) => c.problems),
      ...(skippedCount > 0
        ? [
            `.github/workflows: ${skippedCount} more workflow files than check reads (${files.length}); the rest weren't checked.`,
          ]
        : []),
    ],
    checkedCount: workflowChecks.filter((c) => c.hasReferences).length,
  };
};

// The warning for one guide file beside the manifest, or undefined when it's current or has no
// guide. Anything wrong with the file is a warning too: only the manifest decides the exit code.
const getStaleGuideWarning = ({
  manifest,
  manifestPath,
  fileName,
  realPath,
}: {
  manifest: Manifest;
  manifestPath: string;
  fileName: string;
  realPath: string;
}) => {
  const guidePath = join(dirname(manifestPath), fileName);
  const fixCommand = `storehouse agents --write${fileName === 'AGENTS.md' ? '' : ` --file ${fileName}`}`;
  try {
    const existing = guideTargetService.read(realPath, fileName);
    if (existing === undefined) return undefined;
    const writtenGuide = guideFileService.getGuide(existing.text, fileName);
    if (writtenGuide === undefined) return undefined;
    const currentGuide = agentGuideService.format({
      manifest,
      manifestPath,
      guidePath,
      protectedEnvs: manifestService.getProtectedEnvs({
        manifest,
        path: manifestPath,
        cwd: dirname(manifestPath),
      }),
    });
    if (writtenGuide === currentGuide) return undefined;
    return `${fileName}'s storehouse guide is out of date with storehouse.json. Update it with: ${fixCommand}`;
  } catch (error) {
    return `${fileName}: ${getErrorMessage(error)}`;
  }
};

// AGENTS.md or CLAUDE.md beside the manifest whose storehouse guide is stale, each file once
const getStaleGuideWarnings = (manifest: Manifest, manifestPath: string) => {
  const seenPaths = new Set<string>();
  return ['AGENTS.md', 'CLAUDE.md'].flatMap((fileName) => {
    const guidePath = join(dirname(manifestPath), fileName);
    if (!existsSync(guidePath)) return [];
    const realPath = realpathSync.native(guidePath);
    if (seenPaths.has(realPath)) return [];
    seenPaths.add(realPath);
    const warning = getStaleGuideWarning({
      manifest,
      manifestPath,
      fileName,
      realPath,
    });
    return warning === undefined ? [] : [warning];
  });
};

export const handleCheck = ({ io, isJson }: { io: Io; isJson: boolean }) => {
  const path = manifestService.path.getOrThrow(io.cwd);
  const root = dirname(path);
  const { manifest, problems: manifestProblems } = manifestService.parse(
    manifestService.readJson(path),
  );
  const workflowCheck = manifest
    ? getWorkflowProblems(manifest, path)
    : { problems: [], checkedCount: 0 };
  const problems = [
    ...manifestProblems,
    ...(manifest
      ? [
          ...manifestService.getLocationProblems(manifest, path),
          ...getPathProblems(manifest, root),
        ]
      : []),
    ...workflowCheck.problems,
  ];
  const isOk = problems.length === 0;
  const shownPath = relative(io.cwd, path);
  // a stale guide only warns: the manifest is fine, and the guide is the person's to refresh
  const warnings = manifest ? getStaleGuideWarnings(manifest, path) : [];
  if (isJson) {
    io.stdout.write(
      format.json({ manifest: path, ok: isOk, problems, warnings }),
    );
    return isOk ? ExitCode.ok : ExitCode.manifest;
  }
  io.stderr.write(warnings.map((w) => `${w}\n`).join(''));
  if (isOk && manifest) {
    const workflowNote =
      workflowCheck.checkedCount > 0
        ? `, ${format.plural(workflowCheck.checkedCount, 'workflow')} checked`
        : '';
    io.stdout.write(
      `${shownPath} is good: ${format.plural(Object.keys(manifest.envs).length, 'env')}, ${format.plural(Object.keys(manifest.secrets).length, 'secret')}, ${format.plural(getAllSecretNames(manifest).size, 'Secret Manager name')}${workflowNote}.\n`,
    );
    return ExitCode.ok;
  }
  const paint = format.painter({ env: io.env, isTTY: io.stdout.isTTY });
  io.stdout.write(
    `${paint('red', `${shownPath} has ${format.plural(problems.length, 'problem')}:`)}\n${problems.map((p) => `  ${p}`).join('\n')}\n`,
  );
  return ExitCode.manifest;
};
