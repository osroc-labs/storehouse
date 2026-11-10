import { createVerify } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

// A small Secret Manager v1 in memory: the endpoints storehouse calls, the faults Google's servers
// have, and Google's token endpoints (OAuth, STS, impersonation, the metadata server).

type State = 'ENABLED' | 'DISABLED' | 'DESTROYED';
type FakeVersion = {
  number: number;
  data: Buffer;
  state: State;
  created: string;
};
type FakeSecret = { labels: Record<string, string>; versions: FakeVersion[] };

// what goes wrong with the next request to a path
export type Fault =
  | { kind: 'status'; code: number; retryAfter?: string }
  | { kind: 'timeout' }
  | { kind: 'reset' }
  | { kind: 'malformed' };

export const token = 'test-token';

const created = (n: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const parseJsonBody = (text: string) =>
  text ? z.unknown().parse(JSON.parse(text)) : undefined;

const send = (res: ServerResponse, status: number, json: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
};

const sendError = (
  res: ServerResponse,
  code: number,
  status: string,
  message: string,
) => send(res, code, { error: { code, status, message } });

const addBody = z.object({ payload: z.object({ data: z.string() }) });
const createBody = z.object({
  labels: z.record(z.string(), z.string()).optional(),
});

const versionJson = (project: string, secret: string, v: FakeVersion) => ({
  name: `projects/${project}/secrets/${secret}/versions/${v.number}`,
  createTime: v.created,
  state: v.state,
});

const sendFault = (res: ServerResponse, fault: Fault) => {
  if (fault.kind === 'timeout') return;
  if (fault.kind === 'reset') {
    // a reply cut off mid-body, as a dropped connection leaves it
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '400',
    });
    res.write('{"name": "projects/');
    setTimeout(() => res.socket?.destroy(), 5);
    return;
  }
  if (fault.kind === 'malformed') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"name": not json');
    return;
  }
  res.writeHead(fault.code, {
    'content-type': 'application/json',
    ...(fault.retryAfter !== undefined && { 'retry-after': fault.retryAfter }),
  });
  res.end(
    JSON.stringify({
      error: { code: fault.code, status: 'UNAVAILABLE', message: 'Try again.' },
    }),
  );
};

// the claims of a service account's JWT, when its signature holds for publicKey
const verifyJwt = (assertion: string, publicKey: string) => {
  const [header = '', claims = '', signature = ''] = assertion.split('.');
  if (!publicKey) return undefined;
  const isValid = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, signature, 'base64url');
  if (!isValid) return undefined;
  return z
    .object({ iss: z.string(), aud: z.string(), scope: z.string() })
    .parse(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')));
};

export const fakeSecretManager = async (
  options: { pageSize?: number } = {},
) => {
  const secrets = new Map<string, FakeSecret>();
  const requests: {
    method: string;
    path: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[] = [];
  const deniedProjects = new Set<string>();
  const deniedSecrets = new Set<string>();
  const faults: { path: string; fault: Fault }[] = [];
  const acceptedTokens = new Set([token]);
  // what the token endpoints answer with
  const oauth = {
    accessToken: 'oauth-token',
    expiresIn: 3600,
    servicePublicKey: '',
  };
  let clock = 0;

  const handleOauth = async (
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const form = new URLSearchParams(await readBody(req));
    const grant = form.get('grant_type');
    if (url.pathname === '/oauth/token' && grant === 'refresh_token') {
      if (form.get('refresh_token') !== 'refresh-me') {
        sendError(res, 400, 'invalid_grant', 'Bad refresh token.');
        return;
      }
      send(res, 200, {
        access_token: oauth.accessToken,
        expires_in: oauth.expiresIn,
      });
      return;
    }
    if (url.pathname === '/oauth/token' && grant?.endsWith('jwt-bearer')) {
      const claims = verifyJwt(
        form.get('assertion') ?? '',
        oauth.servicePublicKey,
      );
      if (!claims?.scope.includes('cloud-platform')) {
        sendError(res, 400, 'invalid_grant', 'Bad JWT.');
        return;
      }
      send(res, 200, {
        access_token: `${oauth.accessToken}-for-${claims.iss}`,
        expires_in: oauth.expiresIn,
      });
      return;
    }
    if (
      url.pathname === '/sts/v1/token' &&
      form.get('subject_token') === 'oidc-token'
    ) {
      send(res, 200, { access_token: 'federated-token', expires_in: 3600 });
      return;
    }
    if (url.pathname.endsWith(':generateAccessToken')) {
      if (req.headers.authorization !== 'Bearer federated-token') {
        sendError(res, 403, 'PERMISSION_DENIED', 'Not federated.');
        return;
      }
      send(res, 200, {
        accessToken: oauth.accessToken,
        expireTime: '2099-01-01T00:00:00Z',
      });
      return;
    }
    if (url.pathname === '/oidc') {
      send(res, 200, { value: 'oidc-token' });
      return;
    }
    if (url.pathname.startsWith('/computeMetadata/')) {
      if (req.headers['metadata-flavor'] !== 'Google') {
        sendError(res, 403, 'FORBIDDEN', 'Missing Metadata-Flavor.');
        return;
      }
      send(res, 200, { access_token: 'metadata-token', expires_in: 3600 });
      return;
    }
    sendError(res, 400, 'invalid_request', 'Unknown grant.');
  };

  const handleSecretManager = async (
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
      body,
    });
    const at = faults.findIndex((f) => url.pathname.endsWith(f.path));
    const [planned] = at === -1 ? [] : faults.splice(at, 1);
    if (planned) {
      sendFault(res, planned.fault);
      return;
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!acceptedTokens.has(bearer)) {
      sendError(
        res,
        401,
        'UNAUTHENTICATED',
        'Request had invalid authentication credentials.',
      );
      return;
    }
    const match =
      /^\/v1\/projects\/([^/]+)\/secrets(?:\/([^/:]+))?(?:(:addVersion)|\/versions(?:\/(latest)(:access)?)?)?$/.exec(
        url.pathname,
      );
    if (!match) {
      sendError(res, 404, 'NOT_FOUND', 'No such endpoint.');
      return;
    }
    const [, project = '', name, addVersion, latest, access] = match;
    const isDenied =
      deniedProjects.has(project) ||
      deniedSecrets.has(`${project}/${name ?? ''}`);
    if (isDenied) {
      sendError(
        res,
        403,
        'PERMISSION_DENIED',
        `Permission denied on ${name ?? project}.`,
      );
      return;
    }
    if (name === undefined) {
      const id = url.searchParams.get('secretId') ?? '';
      if (method !== 'POST' || !id) {
        sendError(res, 400, 'INVALID_ARGUMENT', 'Bad request.');
        return;
      }
      if (secrets.has(`${project}/${id}`)) {
        sendError(res, 409, 'ALREADY_EXISTS', 'Secret already exists.');
        return;
      }
      const { labels = {} } = createBody.parse(parseJsonBody(body));
      secrets.set(`${project}/${id}`, { labels, versions: [] });
      send(res, 200, { name: `projects/${project}/secrets/${id}`, labels });
      return;
    }
    const secret = secrets.get(`${project}/${name}`);
    if (!secret) {
      sendError(
        res,
        404,
        'NOT_FOUND',
        `Secret [projects/${project}/secrets/${name}] not found.`,
      );
      return;
    }
    if (method === 'PATCH') {
      const { labels = {} } = createBody.parse(parseJsonBody(body));
      secret.labels = labels;
      send(res, 200, { name: `projects/${project}/secrets/${name}`, labels });
      return;
    }
    if (addVersion) {
      const { payload } = addBody.parse(parseJsonBody(body));
      const v: FakeVersion = {
        number: secret.versions.length + 1,
        data: Buffer.from(payload.data, 'base64'),
        state: 'ENABLED',
        created: created(++clock),
      };
      secret.versions.push(v);
      send(res, 200, versionJson(project, name, v));
      return;
    }
    if (latest) {
      const v = secret.versions.at(-1);
      if (!v) {
        sendError(res, 404, 'NOT_FOUND', 'Secret Version not found.');
        return;
      }
      if (!access) {
        send(res, 200, versionJson(project, name, v));
        return;
      }
      if (v.state !== 'ENABLED') {
        sendError(
          res,
          400,
          'FAILED_PRECONDITION',
          `Secret Version is in ${v.state} state.`,
        );
        return;
      }
      send(res, 200, {
        name: '',
        payload: { data: v.data.toString('base64') },
      });
      return;
    }
    if (url.pathname.endsWith('/versions')) {
      const size = Math.min(
        Number(url.searchParams.get('pageSize') ?? 25),
        options.pageSize ?? Infinity,
      );
      const start = Number(url.searchParams.get('pageToken') || 0);
      const newestFirst = secret.versions.toReversed();
      const page = newestFirst.slice(start, start + size);
      send(res, 200, {
        versions: page.map((v) => versionJson(project, name, v)),
        ...(start + size < newestFirst.length && {
          nextPageToken: String(start + size),
        }),
      });
      return;
    }
    send(res, 200, {
      name: `projects/${project}/secrets/${name}`,
      labels: secret.labels,
    });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const handler = url.pathname.startsWith('/v1/')
      ? handleSecretManager
      : handleOauth;
    handler(url, req, res).catch((error: unknown) => {
      sendError(res, 500, 'INTERNAL', String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null
      ? (address satisfies AddressInfo).port
      : 0;
  const origin = `http://127.0.0.1:${port}`;

  return {
    baseUrl: `${origin}/v1`,
    origin,
    oauth,
    requests,
    secrets,
    deny: (project: string) => deniedProjects.add(project),
    denySecret: (project: string, name: string) =>
      deniedSecrets.add(`${project}/${name}`),
    // the next request whose path ends with `path` (any request, for '') goes wrong this way
    injectFault: (fault: Fault, path = '') => faults.push({ path, fault }),
    failNext: (code: number, path = '') =>
      faults.push({ path, fault: { kind: 'status', code } }),
    acceptToken: (newToken: string) => acceptedTokens.add(newToken),
    revokeToken: (oldToken: string) => acceptedTokens.delete(oldToken),
    reset: () => {
      secrets.clear();
      requests.length = 0;
      deniedProjects.clear();
      deniedSecrets.clear();
      faults.length = 0;
      acceptedTokens.clear();
      acceptedTokens.add(token);
      clock = 0;
    },
    // puts a value straight into the store, as another tool would have
    seed: (
      project: string,
      name: string,
      value: string | Buffer,
      state: State = 'ENABLED',
      labels: Record<string, string> = {},
    ) => {
      const secret = secrets.get(`${project}/${name}`) ?? {
        labels,
        versions: [],
      };
      secrets.set(`${project}/${name}`, secret);
      secret.versions.push({
        number: secret.versions.length + 1,
        data: Buffer.from(value),
        state,
        created: created(++clock),
      });
    },
    value: (project: string, name: string) =>
      secrets.get(`${project}/${name}`)?.versions.at(-1)?.data.toString('utf8'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export type Fake = Awaited<ReturnType<typeof fakeSecretManager>>;
