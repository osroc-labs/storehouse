import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  CliError,
  ExitCode,
  getErrorMessage,
  getFailedError,
} from '../errors.ts';
import type { Credentials } from './credentials.ts';

// Secret Manager's REST API v1, one function per endpoint, each reply parsed. Only secrets.ts
// imports it.

export const secretManagerUrl = 'https://secretmanager.googleapis.com/v1';

const secretVersionSchema = z.object({
  name: z.string(),
  createTime: z.string(),
  state: z.enum(['ENABLED', 'DISABLED', 'DESTROYED', 'STATE_UNSPECIFIED']),
});

export type SecretVersion = z.infer<typeof secretVersionSchema>;

const secretSchema = z.object({
  labels: z.record(z.string(), z.string()).optional(),
});

const versionPageSchema = z.object({
  versions: z.array(secretVersionSchema).optional(),
  nextPageToken: z.string().optional(),
});

const accessedVersionSchema = z.object({
  payload: z.object({ data: z.string() }),
});

const errorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
  }),
});

const retryableStatuses = new Set([429, 500, 502, 503, 504]);
// the longest a Retry-After header can make a run wait
const maxRetryAfterMs = 30_000;

// An error from a request Google answered, so a caller can branch on its status (status shows a
// 403 for one secret in its cell instead of failing the whole table).
export class GoogleRequestError extends CliError {
  readonly httpStatus: number;

  constructor(httpStatus: number, message: string, options?: ErrorOptions) {
    super(ExitCode.failed, message, options);
    this.name = 'GoogleRequestError';
    this.httpStatus = httpStatus;
  }
}

const parseErrorBody = (text: string) => {
  try {
    const parsedBody = errorBodySchema.safeParse(JSON.parse(text));
    if (parsedBody.success) {
      return {
        said: parsedBody.data.error.message ?? '',
        status: parsedBody.data.error.status,
      };
    }
  } catch {
    // not JSON: the start of the text says more than nothing
  }
  return { said: text.slice(0, 200), status: undefined };
};

const getRequestError = ({
  code,
  body,
  what,
  project,
}: {
  code: number;
  body: ReturnType<typeof parseErrorBody>;
  what: string;
  project: string;
}) => {
  if (code === 401) {
    return new GoogleRequestError(
      code,
      `Google didn't accept the access token while trying to ${what}. Run \`gcloud auth login\`, or set a fresh GOOGLE_OAUTH_ACCESS_TOKEN. \`storehouse auth\` shows which credentials storehouse uses.`,
    );
  }
  if (
    code === 403 &&
    /has not been used|is disabled|SERVICE_DISABLED/.test(body.said)
  ) {
    return new GoogleRequestError(
      code,
      `The Secret Manager API is off in project ${project}. Turn it on with \`gcloud services enable secretmanager.googleapis.com --project ${project}\`.`,
    );
  }
  if (code === 403) {
    return new GoogleRequestError(
      code,
      `Google refused to ${what}: ${body.said}\nYou need a Secret Manager role on project ${project}: Secret Manager Viewer for status and history, Secret Accessor to read values, Secret Manager Admin to set them.`,
    );
  }
  if (code === 429) {
    return new GoogleRequestError(
      code,
      `Google is limiting requests to project ${project} and still refused after retrying, while trying to ${what}. Wait a minute and run it again.`,
    );
  }
  return new GoogleRequestError(
    code,
    `Google failed to ${what} (${code}${body.status ? ` ${body.status}` : ''}): ${body.said}`,
  );
};

// Retry-After in seconds or as a date, capped; else a backoff that doubles each try
const getRetryDelayMs = ({
  resp,
  attempt,
  retryBaseMs,
}: {
  resp: Response | undefined;
  attempt: number;
  retryBaseMs: number;
}) => {
  const retryAfter = resp?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const delayMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delayMs)) {
      return Math.min(Math.max(delayMs, 0), maxRetryAfterMs);
    }
  }
  return retryBaseMs * 2 ** (attempt - 1);
};

// a reply in a shape storehouse doesn't know is Google's change, not the person's mistake
const parseReply = <T>(schema: z.ZodType<T>, json: unknown, what: string) => {
  const parsedReply = schema.safeParse(json);
  if (parsedReply.success) return parsedReply.data;
  throw getFailedError(
    `Secret Manager's reply to ${what} isn't in the shape storehouse expects. Report it with the command you ran.`,
  );
};

const getSecretPath = (project: string, secret: string) =>
  `projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(secret)}`;

// a request that never got an answer, or whose answer was cut off
const getNetworkError = (what: string, error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? getFailedError(
        `Secret Manager didn't answer in time while trying to ${what}. Check your connection, then run it again.`,
        { cause: error },
      )
    : getFailedError(
        `Couldn't reach Secret Manager to ${what}: ${getErrorMessage(error)}. Check your connection, then run it again.`,
        { cause: error },
      );

export const createSecretManagerApi = ({
  baseUrl,
  credentials,
  retryBaseMs = 300,
  timeoutMs = 30_000,
}: {
  baseUrl: string;
  credentials: Pick<Credentials, 'getToken' | 'refreshToken'>;
  retryBaseMs?: number;
  timeoutMs?: number;
}) => {
  const getHeaders = async ({
    hasBody,
    isRefreshed,
  }: {
    hasBody: boolean;
    isRefreshed: boolean;
  }) => {
    const token = isRefreshed
      ? await credentials.refreshToken()
      : await credentials.getToken();
    if (token === undefined) return undefined;
    return {
      authorization: `Bearer ${token.token}`,
      ...(token.quotaProject !== undefined && {
        'x-goog-user-project': token.quotaProject,
      }),
      ...(hasBody && { 'content-type': 'application/json' }),
    };
  };

  // A 404 is { isFound: false }. So is a disabled or destroyed latest version when reading a value:
  // "latest" is the newest version whatever its state, and status counts that as missing too.
  const request = async ({
    method,
    path,
    what,
    project,
    body,
  }: {
    method: 'GET' | 'POST' | 'PATCH';
    path: string;
    what: string;
    project: string;
    body?: unknown;
  }) => {
    // only reads are retried: a retried write could add a second version
    const tries = method === 'GET' ? 3 : 1;
    let headers = await getHeaders({
      hasBody: body !== undefined,
      isRefreshed: false,
    });
    let hasRefreshed = false;
    for (let attempt = 1; ; attempt++) {
      let resp: Response | undefined;
      let text: string;
      try {
        resp = await fetch(`${baseUrl}/${path}`, {
          method,
          headers: headers ?? {},
          signal: AbortSignal.timeout(timeoutMs),
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        text = await resp.text();
      } catch (error) {
        if (attempt >= tries) throw getNetworkError(what, error);
        await sleep(getRetryDelayMs({ resp, attempt, retryBaseMs }));
        continue;
      }
      // a token can expire mid-run: one refresh, then the same request again (Google did nothing)
      if (resp.status === 401 && !hasRefreshed) {
        hasRefreshed = true;
        const refreshedHeaders = await getHeaders({
          hasBody: body !== undefined,
          isRefreshed: true,
        });
        if (refreshedHeaders !== undefined) {
          headers = refreshedHeaders;
          attempt--;
          continue;
        }
      }
      if (resp.ok) {
        try {
          const json: unknown = JSON.parse(text);
          return { isFound: true, json } as const;
        } catch (error) {
          throw getFailedError(
            `Secret Manager's reply to ${what} wasn't JSON. Run it again; if it keeps happening, report it with the command you ran.`,
            { cause: error },
          );
        }
      }
      if (retryableStatuses.has(resp.status) && attempt < tries) {
        await sleep(getRetryDelayMs({ resp, attempt, retryBaseMs }));
        continue;
      }
      const errorBody = parseErrorBody(text);
      const isMissing =
        resp.status === 404 ||
        (path.endsWith(':access') &&
          errorBody.status === 'FAILED_PRECONDITION');
      if (isMissing) return { isFound: false } as const;
      throw getRequestError({
        code: resp.status,
        body: errorBody,
        what,
        project,
      });
    }
  };

  // the secret's labels, or undefined when it doesn't exist
  const getSecret = async (project: string, secret: string) => {
    const resp = await request({
      method: 'GET',
      path: getSecretPath(project, secret),
      what: `look up ${secret}`,
      project,
    });
    return resp.isFound
      ? (parseReply(secretSchema, resp.json, `look up ${secret}`).labels ?? {})
      : undefined;
  };

  const updateSecretLabels = async ({
    project,
    secret,
    labels,
  }: {
    project: string;
    secret: string;
    labels: Record<string, string>;
  }) => {
    await request({
      method: 'PATCH',
      path: `${getSecretPath(project, secret)}?updateMask=labels`,
      what: `label ${secret}`,
      project,
      body: { labels },
    });
  };

  const createSecret = async ({
    project,
    secret,
    labels,
  }: {
    project: string;
    secret: string;
    labels: Record<string, string>;
  }) => {
    await request({
      method: 'POST',
      path: `projects/${encodeURIComponent(project)}/secrets?secretId=${encodeURIComponent(secret)}`,
      what: `create ${secret}`,
      project,
      body: { replication: { automatic: {} }, labels },
    });
  };

  const getLatestVersion = async (project: string, secret: string) => {
    const resp = await request({
      method: 'GET',
      path: `${getSecretPath(project, secret)}/versions/latest`,
      what: `read ${secret}'s latest version`,
      project,
    });
    return resp.isFound
      ? parseReply(
          secretVersionSchema,
          resp.json,
          `read ${secret}'s latest version`,
        )
      : undefined;
  };

  const listVersions = async ({
    project,
    secret,
    pageToken,
  }: {
    project: string;
    secret: string;
    pageToken: string;
  }) => {
    const query = `pageSize=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const resp = await request({
      method: 'GET',
      path: `${getSecretPath(project, secret)}/versions?${query}`,
      what: `list ${secret}'s versions`,
      project,
    });
    return resp.isFound
      ? parseReply(versionPageSchema, resp.json, `list ${secret}'s versions`)
      : undefined;
  };

  const accessLatestVersion = async (project: string, secret: string) => {
    const resp = await request({
      method: 'GET',
      path: `${getSecretPath(project, secret)}/versions/latest:access`,
      what: `read ${secret}'s value`,
      project,
    });
    return resp.isFound
      ? parseReply(accessedVersionSchema, resp.json, `read ${secret}'s value`)
          .payload.data
      : undefined;
  };

  const addVersion = async ({
    project,
    secret,
    data,
  }: {
    project: string;
    secret: string;
    data: string;
  }) => {
    const resp = await request({
      method: 'POST',
      path: `${getSecretPath(project, secret)}:addVersion`,
      what: `add a version to ${secret}`,
      project,
      body: { payload: { data } },
    });
    if (!resp.isFound) {
      throw getFailedError(`${secret} disappeared while it was being set.`);
    }
    return parseReply(
      secretVersionSchema,
      resp.json,
      `add a version to ${secret}`,
    );
  };

  return {
    secrets: {
      get: getSecret,
      create: createSecret,
      updateLabels: updateSecretLabels,
    },
    versions: {
      getLatest: getLatestVersion,
      list: listVersions,
      accessLatest: accessLatestVersion,
      add: addVersion,
    },
  };
};

export type SecretManagerApi = ReturnType<typeof createSecretManagerApi>;
