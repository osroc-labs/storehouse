import { execFile } from 'node:child_process';
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getErrorMessage, getFailedError } from '../errors.ts';

// Google access tokens without a Google SDK. The first source that has one wins: an explicit
// token, an explicit credentials file, gcloud's login, gcloud's ADC file, then the metadata server.

type Env = Readonly<Record<string, string | undefined>>;

export const CredentialSource = {
  accessTokenEnv: 'GOOGLE_OAUTH_ACCESS_TOKEN',
  credentialsFileEnv: 'GOOGLE_APPLICATION_CREDENTIALS',
  gcloud: 'gcloud',
  adcFile: 'application default credentials',
  metadataServer: 'metadata server',
} as const;
export type CredentialSource =
  (typeof CredentialSource)[keyof typeof CredentialSource];

const scope = 'https://www.googleapis.com/auth/cloud-platform';
const googleOauthUrl = 'https://oauth2.googleapis.com';
// a token is found again this long before Google says it expires
const expiryMarginMs = 60_000;

const tokenReplySchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
});

const impersonationReplySchema = z.object({
  accessToken: z.string().min(1),
  expireTime: z.string().optional(),
});

const authorizedUserSchema = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string(),
  client_secret: z.string(),
  refresh_token: z.string(),
  token_uri: z.string().optional(),
  quota_project_id: z.string().optional(),
});

const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  client_email: z.string(),
  private_key: z.string(),
  private_key_id: z.string().optional(),
  token_uri: z.string().optional(),
  quota_project_id: z.string().optional(),
});

const externalAccountSchema = z.object({
  type: z.literal('external_account'),
  audience: z.string(),
  subject_token_type: z.string(),
  token_url: z.string().default('https://sts.googleapis.com/v1/token'),
  service_account_impersonation_url: z.string().optional(),
  quota_project_id: z.string().optional(),
  credential_source: z.object({
    file: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    format: z
      .object({
        type: z.enum(['text', 'json']).default('text'),
        subject_token_field_name: z.string().optional(),
      })
      .optional(),
  }),
});

const credentialsFileSchema = z.discriminatedUnion('type', [
  authorizedUserSchema,
  serviceAccountSchema,
  externalAccountSchema,
]);

type CredentialsFile = z.infer<typeof credentialsFileSchema>;

export type Token = {
  token: string;
  expiresAt: number | undefined;
  quotaProject: string | undefined;
};

// what a run needs from its credentials; tests hand in their own
export type Credentials = {
  getToken: () => Promise<Token>;
  // after a 401: a new token, or undefined when the source can't give one
  refreshToken: () => Promise<Token | undefined>;
  describe: () => Promise<{
    source: CredentialSource;
    detail: string;
    token: Token;
  }>;
};

const getExpiresAt = (now: number, expiresInSeconds: number | undefined) =>
  expiresInSeconds === undefined ? undefined : now + expiresInSeconds * 1000;

const parseJsonReply = (text: string, what: string) => {
  try {
    const json: unknown = JSON.parse(text);
    return json;
  } catch (error) {
    throw getFailedError(`Google's reply to ${what} wasn't JSON.`, {
      cause: error,
    });
  }
};

// a request to a token endpoint, with any network failure or timeout said in storehouse's words
const sendTokenRequest = async ({
  url,
  init,
  what,
  timeoutMs,
}: {
  url: string;
  init: RequestInit;
  what: string;
  timeoutMs: number;
}) => {
  try {
    const resp = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: resp.status, isOk: resp.ok, text: await resp.text() };
  } catch (error) {
    throw getFailedError(
      `Couldn't reach ${new URL(url).host} to ${what}: ${getErrorMessage(error)}. Check your connection, then run it again.`,
      { cause: error },
    );
  }
};

const postForToken = async ({
  url,
  body,
  what,
  timeoutMs,
}: {
  url: string;
  body: URLSearchParams;
  what: string;
  timeoutMs: number;
}) => {
  const resp = await sendTokenRequest({
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    },
    what,
    timeoutMs,
  });
  if (!resp.isOk) {
    throw getFailedError(
      `Google refused to ${what} (${resp.status}): ${resp.text.slice(0, 200)}`,
    );
  }
  const text = resp.text;
  const parsedReply = tokenReplySchema.safeParse(parseJsonReply(text, what));
  if (parsedReply.success) return parsedReply.data;
  throw getFailedError(`Google's reply to ${what} had no access token.`);
};

const toBase64Url = (data: string) => Buffer.from(data).toString('base64url');

// a JWT signed with the service account's key, exchanged for an access token
const getServiceAccountToken = async ({
  file,
  oauthUrl,
  now,
  timeoutMs,
}: {
  file: z.infer<typeof serviceAccountSchema>;
  oauthUrl: string;
  now: number;
  timeoutMs: number;
}) => {
  const tokenUri = file.token_uri ?? `${oauthUrl}/token`;
  const issuedAt = Math.floor(now / 1000);
  const header = toBase64Url(
    JSON.stringify({
      alg: 'RS256',
      typ: 'JWT',
      ...(file.private_key_id && { kid: file.private_key_id }),
    }),
  );
  const claims = toBase64Url(
    JSON.stringify({
      iss: file.client_email,
      scope,
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  let signature;
  try {
    signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(file.private_key, 'base64url');
  } catch (error) {
    throw getFailedError(
      `The service account key for ${file.client_email} couldn't sign a token: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  const reply = await postForToken({
    url: tokenUri,
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
    what: `get a token for ${file.client_email}`,
    timeoutMs,
  });
  return {
    token: reply.access_token,
    expiresAt: getExpiresAt(now, reply.expires_in),
    quotaProject: file.quota_project_id,
  } satisfies Token;
};

const getAuthorizedUserToken = async ({
  file,
  oauthUrl,
  now,
  timeoutMs,
}: {
  file: z.infer<typeof authorizedUserSchema>;
  oauthUrl: string;
  now: number;
  timeoutMs: number;
}) => {
  const reply = await postForToken({
    url: file.token_uri ?? `${oauthUrl}/token`,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: file.client_id,
      client_secret: file.client_secret,
      refresh_token: file.refresh_token,
    }),
    what: 'refresh your application default credentials',
    timeoutMs,
  });
  return {
    token: reply.access_token,
    expiresAt: getExpiresAt(now, reply.expires_in),
    quotaProject: file.quota_project_id,
  } satisfies Token;
};

const readSubjectText = async (
  source: z.infer<typeof externalAccountSchema>['credential_source'],
  timeoutMs: number,
) => {
  if (source.file !== undefined) return readFileSync(source.file, 'utf8');
  if (source.url === undefined) {
    throw getFailedError(
      'This external_account credential gets its token from a program or from AWS, which storehouse doesn\'t read yet. Use a "file" or "url" credential source, or set GOOGLE_OAUTH_ACCESS_TOKEN.',
    );
  }
  const resp = await sendTokenRequest({
    url: source.url,
    init: { headers: source.headers ?? {} },
    what: 'get the workload identity token',
    timeoutMs,
  });
  if (resp.isOk) return resp.text;
  throw getFailedError(
    `The workload identity token at ${source.url} didn't come (${resp.status}).`,
  );
};

const getSubjectToken = async (
  source: z.infer<typeof externalAccountSchema>['credential_source'],
  timeoutMs: number,
) => {
  const text = await readSubjectText(source, timeoutMs);
  const format = source.format ?? { type: 'text' };
  if (format.type === 'text') return text.trim();
  const field = format.subject_token_field_name ?? 'access_token';
  const subjectToken = z
    .record(z.string(), z.unknown())
    .safeParse(parseJsonReply(text, 'the workload identity token')).data?.[
    field
  ];
  if (typeof subjectToken === 'string') return subjectToken;
  throw getFailedError(`The workload identity token has no "${field}" field.`);
};

// workload identity federation: an outside token exchanged at STS, then for a service account's
// own token when the file says to impersonate one
const getExternalAccountToken = async ({
  file,
  now,
  timeoutMs,
}: {
  file: z.infer<typeof externalAccountSchema>;
  now: number;
  timeoutMs: number;
}) => {
  const subjectToken = await getSubjectToken(file.credential_source, timeoutMs);
  const federatedToken = await postForToken({
    url: file.token_url,
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: file.audience,
      scope,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: subjectToken,
      subject_token_type: file.subject_token_type,
    }),
    what: 'exchange the workload identity token',
    timeoutMs,
  });
  if (file.service_account_impersonation_url === undefined) {
    return {
      token: federatedToken.access_token,
      expiresAt: getExpiresAt(now, federatedToken.expires_in),
      quotaProject: file.quota_project_id,
    } satisfies Token;
  }
  const resp = await sendTokenRequest({
    url: file.service_account_impersonation_url,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${federatedToken.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ scope: [scope], lifetime: '3600s' }),
    },
    what: 'impersonate the service account',
    timeoutMs,
  });
  const { text } = resp;
  const parsedReply = resp.isOk
    ? impersonationReplySchema.safeParse(
        parseJsonReply(text, 'impersonate the service account'),
      )
    : undefined;
  if (!parsedReply?.success) {
    throw getFailedError(
      `Google refused to impersonate the service account (${resp.status}): ${text.slice(0, 200)}`,
    );
  }
  const { accessToken, expireTime } = parsedReply.data;
  return {
    token: accessToken,
    expiresAt: expireTime === undefined ? undefined : Date.parse(expireTime),
    quotaProject: file.quota_project_id,
  } satisfies Token;
};

const parseCredentialsFile = (path: string) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw getFailedError(
      `Couldn't read the credentials file ${path}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    // the parser's message quotes the file's first characters, which may be a token or key
    throw getFailedError(
      `The credentials file ${path} isn't JSON. Point GOOGLE_APPLICATION_CREDENTIALS at a credentials file, or put an access token in GOOGLE_OAUTH_ACCESS_TOKEN.`,
      { cause: error },
    );
  }
  const parsedFile = credentialsFileSchema.safeParse(json);
  if (parsedFile.success) return parsedFile.data;
  throw getFailedError(
    `${path} isn't a credentials file storehouse can use: it reads authorized_user, service_account and external_account files.`,
  );
};

const getTokenFromFile = ({
  file,
  oauthUrl,
  now,
  timeoutMs,
}: {
  file: CredentialsFile;
  oauthUrl: string;
  now: number;
  timeoutMs: number;
}) => {
  if (file.type === 'authorized_user') {
    return getAuthorizedUserToken({ file, oauthUrl, now, timeoutMs });
  }
  if (file.type === 'service_account') {
    return getServiceAccountToken({ file, oauthUrl, now, timeoutMs });
  }
  return getExternalAccountToken({ file, now, timeoutMs });
};

const describeCredentialsFile = (file: CredentialsFile) => {
  if (file.type === 'service_account') {
    return `service account ${file.client_email}`;
  }
  if (file.type === 'external_account') return 'workload identity federation';
  return 'a user login';
};

const getGcloudToken = (env: Env) =>
  new Promise<{ token: string } | { isMissing: true } | { error: string }>(
    (resolve) => {
      const child = execFile(
        'gcloud',
        ['auth', 'print-access-token', '--quiet'],
        { env, encoding: 'utf8', timeout: 60_000 },
        (error, stdout, stderr) => {
          if (error && 'code' in error && error.code === 'ENOENT') {
            resolve({ isMissing: true });
            return;
          }
          const token = stdout.trim();
          if (!error && token) {
            resolve({ token });
            return;
          }
          resolve({
            error:
              stderr.trim().split('\n').slice(-2).join(' ') || 'not logged in',
          });
        },
      );
      // gcloud never needs input here, and a closed stdin can't leave it waiting for some
      child.stdin?.end();
    },
  );

const getAdcPath = (env: Env) => {
  const configDir =
    env.CLOUDSDK_CONFIG ??
    (process.platform === 'win32' && env.APPDATA !== undefined
      ? join(env.APPDATA, 'gcloud')
      : join(env.HOME ?? homedir(), '.config', 'gcloud'));
  return join(configDir, 'application_default_credentials.json');
};

const getMetadataToken = async ({ env, now }: { env: Env; now: number }) => {
  const host = env.GCE_METADATA_HOST ?? '169.254.169.254';
  // only a host to ask, never a URL or a path that would send the request somewhere else
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) {
    throw getFailedError(
      `GCE_METADATA_HOST must be a bare host or host:port, such as metadata.google.internal, not ${JSON.stringify(host)}. Unset it, or fix it.`,
    );
  }
  try {
    const resp = await fetch(
      `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
      {
        headers: { 'Metadata-Flavor': 'Google' },
        // off Google Cloud nothing answers, so wait only briefly
        signal: AbortSignal.timeout(1000),
      },
    );
    if (!resp.ok) return undefined;
    const parsedReply = tokenReplySchema.safeParse(await resp.json());
    if (!parsedReply.success) return undefined;
    return {
      token: parsedReply.data.access_token,
      expiresAt: getExpiresAt(now, parsedReply.data.expires_in),
      quotaProject: undefined,
    } satisfies Token;
  } catch {
    // nothing answered: not on Google Cloud
    return undefined;
  }
};

// each source in turn, noting why one was passed over so the error can say what was tried
const findCredentials = async ({
  env,
  oauthUrl,
  now,
  timeoutMs,
}: {
  env: Env;
  oauthUrl: string;
  now: number;
  timeoutMs: number;
}) => {
  const tried: string[] = [];
  const tokenFromEnv = env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
  if (tokenFromEnv) {
    return {
      source: CredentialSource.accessTokenEnv,
      detail: 'an access token in the environment',
      canRefresh: false,
      token: {
        token: tokenFromEnv,
        expiresAt: undefined,
        quotaProject: undefined,
      } satisfies Token,
    };
  }
  tried.push('GOOGLE_OAUTH_ACCESS_TOKEN (not set)');

  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (credentialsPath) {
    const file = parseCredentialsFile(credentialsPath);
    return {
      source: CredentialSource.credentialsFileEnv,
      detail: `${describeCredentialsFile(file)}, from ${credentialsPath}`,
      canRefresh: true,
      token: await getTokenFromFile({ file, oauthUrl, now, timeoutMs }),
    };
  }
  tried.push('GOOGLE_APPLICATION_CREDENTIALS (not set)');

  const gcloudToken = await getGcloudToken(env);
  if ('token' in gcloudToken) {
    return {
      source: CredentialSource.gcloud,
      detail: 'gcloud auth print-access-token',
      canRefresh: true,
      token: {
        token: gcloudToken.token,
        expiresAt: undefined,
        quotaProject: undefined,
      } satisfies Token,
    };
  }
  tried.push(
    'isMissing' in gcloudToken
      ? 'gcloud (not installed)'
      : `gcloud (${gcloudToken.error})`,
  );

  const adcPath = getAdcPath(env);
  if (existsSync(adcPath)) {
    const file = parseCredentialsFile(adcPath);
    return {
      source: CredentialSource.adcFile,
      detail: `${describeCredentialsFile(file)}, from ${adcPath}`,
      canRefresh: true,
      token: await getTokenFromFile({ file, oauthUrl, now, timeoutMs }),
    };
  }
  tried.push(`${adcPath} (none)`);

  const metadataToken = await getMetadataToken({ env, now });
  if (metadataToken) {
    return {
      source: CredentialSource.metadataServer,
      detail: "this machine's service account",
      canRefresh: true,
      token: metadataToken,
    };
  }
  tried.push('the metadata server (not on Google Cloud)');

  throw getFailedError(
    `storehouse found no Google credentials. It tried:\n${tried.map((t) => `  ${t}`).join('\n')}\nRun \`gcloud auth login\`, or set GOOGLE_OAUTH_ACCESS_TOKEN or GOOGLE_APPLICATION_CREDENTIALS.`,
  );
};

// One set of credentials per run: found once, and found again when the token is about to expire
// or Google refuses it, since a token can expire mid-run.
export const createCredentials = ({
  env,
  oauthUrl = googleOauthUrl,
  timeoutMs = 30_000,
  now = Date.now,
}: {
  env: Env;
  oauthUrl?: string;
  timeoutMs?: number;
  now?: () => number;
}) => {
  let found: ReturnType<typeof findCredentials> | undefined;
  const findAgain = () => {
    found = findCredentials({ env, oauthUrl, now: now(), timeoutMs });
    return found;
  };
  const isFresh = (token: Token) =>
    token.expiresAt === undefined || token.expiresAt - expiryMarginMs > now();
  const getCredentials = async () => {
    const existingCredentials = await (found ?? findAgain());
    if (isFresh(existingCredentials.token)) return existingCredentials;
    return findAgain();
  };
  const getToken = async () => (await getCredentials()).token;
  // several requests refused at once share one refresh, not one each
  let refreshing: ReturnType<typeof findCredentials> | undefined;
  const refreshToken = async () => {
    const existingCredentials = await getCredentials();
    if (!existingCredentials.canRefresh) return undefined;
    refreshing ??= findAgain().finally(() => {
      refreshing = undefined;
    });
    return (await refreshing).token;
  };
  return {
    getToken,
    refreshToken,
    describe: getCredentials,
  } satisfies Credentials;
};
