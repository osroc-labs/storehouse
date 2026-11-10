import { z } from 'zod';

const envName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,62}$/,
    'An env name is lowercase letters, digits, - and _, starting with a letter (it becomes a Secret Manager label).',
  );

// text a terminal shows as it is: no control characters, which could repaint it
const plainText = z
  .string()
  .regex(
    /^[^\p{Cc}]*$/u,
    'Control characters (escape sequences, line breaks) are not allowed here.',
  );

// A path in the repo: relative, plain characters, no `..`. pull writes its file there and adds
// it to .gitignore, so nothing in it may read as a path elsewhere or as an ignore rule.
// A name a push passes to a CLI as a flag's value. It starts with a letter or digit, so it can
// never read as a flag of its own, whatever form the flag is passed in.
const cliName = (what: string) =>
  z
    .string()
    .regex(
      /^[A-Za-z0-9][\w.-]*$/,
      `${what} starts with a letter or digit, then letters, digits, ., - and _.`,
    );

const repoPath = z
  .string()
  .min(1)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    'A path here is relative to storehouse.json, made of letters, digits, ., _, - and /, without "..".',
  );

// Google's rule for a project id
const projectId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    'A Google Cloud project id is 6 to 30 lowercase letters, digits and hyphens, starting with a letter.',
  );

const keyName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'A key is an environment variable name: letters, digits and _, not starting with a digit.',
  );

const projectDir = (what: string) =>
  repoPath
    .default('.')
    .describe(
      `${what}, relative to storehouse.json. Default: storehouse.json's own directory.`,
    );

const cloudflareWorkers = z
  .object({
    to: z.literal('cloudflare-workers'),
    dir: projectDir("The Worker's directory, where wrangler finds its config"),
    wranglerEnv: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
        "Wrangler's --env is a label: a letter or digit, then letters, digits, - and _.",
      )
      .optional()
      .describe("Wrangler's --env. Leave it out for the top-level Worker."),
  })
  .strict()
  .describe(
    'A Cloudflare Worker: one `wrangler secret bulk`, with the values on stdin.',
  );

const githubActions = z
  .object({
    to: z.literal('github-actions'),
    repo: z
      .string()
      .regex(
        /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/,
        'A repo is owner/name, starting with a letter or digit.',
      )
      .optional()
      .describe(
        "owner/name. Default: the repo gh finds from storehouse.json's directory.",
      ),
    environment: plainText
      .regex(
        /^[^-\s]/,
        'A GitHub environment starts with something other than a dash or a space.',
      )
      .optional()
      .describe(
        'A deployment environment in the repo, for environment secrets.',
      ),
    org: z
      .string()
      .regex(
        /^[A-Za-z0-9][\w.-]*$/,
        'An organization starts with a letter or digit, then letters, digits, ., - and _.',
      )
      .optional()
      .describe(
        "An organization, for organization secrets instead of a repo's.",
      ),
    visibility: z
      .enum(['all', 'private', 'selected'])
      .optional()
      .describe('Which repos can read an organization secret.'),
    repos: z
      .array(cliName('A repo'))
      .min(1)
      .optional()
      .describe(
        'The repos that can read an organization secret (visibility "selected").',
      ),
    app: z
      .enum(['actions', 'dependabot', 'codespaces'])
      .optional()
      .describe('Which app reads the secrets. Default: actions.'),
  })
  .strict()
  // gh refuses these, and check should say so before a push sends anything anywhere
  .superRefine((target, ctx) => {
    if (target.org !== undefined && target.environment !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['environment'],
        message:
          'Give "org" or "environment", not both: gh sets an organization secret or an environment one.',
      });
    }
    if (target.org === undefined && target.visibility !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['visibility'],
        message: '"visibility" is for an organization secret: add "org".',
      });
    }
    if (
      target.repos !== undefined &&
      (target.org === undefined ||
        (target.visibility ?? 'selected') !== 'selected')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['repos'],
        message:
          '"repos" is for an organization secret with "visibility": "selected".',
      });
    }
  })
  .describe(
    'GitHub Actions secrets: one `gh secret set` per secret, the value on stdin.',
  );

const vercel = z
  .object({
    to: z.literal('vercel'),
    dir: projectDir("The linked Vercel project's directory"),
    environments: z
      .array(cliName('A Vercel environment'))
      .min(1)
      .describe(
        'Vercel environments: production, preview, development, or a custom one.',
      ),
    scope: cliName('A Vercel team')
      .optional()
      .describe("The team, as vercel's --scope."),
  })
  .strict()
  .describe(
    'Vercel environment variables: one `vercel env add --force` per secret, the value on stdin. Needs Vercel CLI 64.7 or later.',
  );

const fly = z
  .object({
    to: z.literal('fly'),
    dir: projectDir("The app's directory, where fly.toml is"),
    app: cliName('A Fly app')
      .optional()
      .describe("The Fly app, as fly's -a. Default: the one in fly.toml."),
    stage: z
      .boolean()
      .default(false)
      .describe('Set the secrets without restarting the app (fly --stage).'),
  })
  .strict()
  .describe('A Fly app: one `fly secrets import`, with the values on stdin.');

const pushTarget = z.discriminatedUnion('to', [
  cloudflareWorkers,
  githubActions,
  vercel,
  fly,
]);

export type PushTargetConfig = z.infer<typeof pushTarget>;

const envSchema = z
  .object({
    project: projectId
      .optional()
      .describe("This env's Google Cloud project, if not the manifest's."),
    protected: z
      .boolean()
      .default(false)
      .describe(
        'For people only: every command against it needs a terminal and the name typed, and refuses to run under an agent.',
      ),
    pull: z
      .object({
        file: repoPath.describe(
          'The dotenv file `storehouse pull` writes, relative to storehouse.json. Without one, pull writes .env.<env> beside storehouse.json.',
        ),
      })
      .strict()
      .optional(),
    push: z
      .array(pushTarget)
      .default([])
      .describe('Where `storehouse push` sends the secrets.'),
  })
  .strict();

const secretSchema = z
  .object({
    purpose: plainText
      .min(1)
      .describe('What the secret is for. Shown by `storehouse status`.'),
    required: z
      .boolean()
      .default(false)
      .describe(
        'A missing required secret fails `status` and stops `pull` and `push`.',
      ),
    envs: z
      .array(envName)
      .min(1)
      .optional()
      .describe('The envs that use it. Default: all of them.'),
    pull: z
      .boolean()
      .default(true)
      .describe('Whether `storehouse pull` writes it.'),
    push: z
      .boolean()
      .default(true)
      .describe('Whether `storehouse push` sends it.'),
    name: plainText
      .min(1)
      .optional()
      .describe(
        "Its own name pattern, instead of the manifest's, for a secret that's already named.",
      ),
  })
  .strict();

// How a workflow input names Secret Manager secrets.
export const SecretInputFormat = {
  // one secret name
  name: 'name',
  // one name per line
  names: 'names',
  // `label: name` per line, with any `@version` ignored
  labelled: 'labelled',
  // google-github-actions/get-secretmanager-secrets: `output:project/secret[/version]` or a full
  // resource name, per line or comma
  resource: 'resource',
} as const;
export type SecretInputFormat =
  (typeof SecretInputFormat)[keyof typeof SecretInputFormat];

// enough for any real repo, and few enough that check stays quick on a hostile one
const maxWorkflowRules = 64;
const maxWorkflowRuleInputs = 32;

const workflowRuleSchema = z
  .object({
    uses: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'The action or reusable workflow, as written after `uses:` without its @ref. `*` matches anything: "my-org/deploy/.github/workflows/*".',
      ),
    inputs: z
      .record(z.string().max(200), z.enum(SecretInputFormat))
      .refine((inputs) => Object.keys(inputs).length <= maxWorkflowRuleInputs, {
        message: `At most ${maxWorkflowRuleInputs} inputs per rule.`,
      })
      .describe(
        'Each `with:` input that names secrets (`*` matches anything, as in "*-secret"), and how it names them.',
      ),
  })
  .strict();

export type WorkflowRule = z.infer<typeof workflowRuleSchema>;

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    project: projectId
      .optional()
      .describe('The Google Cloud project id that holds the secrets.'),
    name: plainText
      .min(1)
      .optional()
      .describe(
        "How an env and a key become a Secret Manager name, such as 'myapp-{env}-{key}'.",
      ),
    envs: z.record(envName, envSchema).describe('The environments, by name.'),
    secrets: z
      .record(keyName, secretSchema)
      .describe('The secrets, by key: the name the app reads.'),
    workflows: z
      .array(workflowRuleSchema)
      .max(maxWorkflowRules)
      .default([])
      .describe(
        "GitHub Actions that name Secret Manager secrets, for `storehouse check`. Google's get-secretmanager-secrets action is known already.",
      ),
  })
  .strict()
  .describe('The secrets an app has in each environment (storehouse.json).');

export type Manifest = z.infer<typeof manifestSchema>;
