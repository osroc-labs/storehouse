import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeCliBehaviour, createFakeCliForTest } from '../testing/fake-cli.ts';
import { fakeSecretManager } from '../testing/fake-secret-manager.ts';
import type { Fake } from '../testing/fake-secret-manager.ts';
import { CliError } from '../errors.ts';
import { createCredentials } from './credentials.ts';

let fake: Fake;

before(async () => {
  fake = await fakeSecretManager();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  fake.oauth.accessToken = 'oauth-token';
  fake.oauth.expiresIn = 3600;
});

// an env with no credentials anywhere: no gcloud on PATH, an empty HOME, no metadata server
const emptyEnvForTest = () => {
  const home = mkdtempSync(join(tmpdir(), 'storehouse-home-'));
  return {
    PATH: join(home, 'no-bin'),
    HOME: home,
    GCE_METADATA_HOST: '127.0.0.1:9',
  };
};

const writeJsonForTest = (dir: string, name: string, json: unknown) => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(json));
  return path;
};

const writeAdcFileForTest = (home: string, json: unknown) =>
  writeJsonForTest(
    join(home, '.config', 'gcloud'),
    'application_default_credentials.json',
    json,
  );

describe('createCredentials', () => {
  it('uses GOOGLE_OAUTH_ACCESS_TOKEN first, and never refreshes it', async () => {
    const credentials = createCredentials({
      env: { ...emptyEnvForTest(), GOOGLE_OAUTH_ACCESS_TOKEN: ' tok \n' },
    });
    assert.equal((await credentials.getToken()).token, 'tok');
    assert.equal(await credentials.refreshToken(), undefined);
    assert.equal(
      (await credentials.describe()).source,
      'GOOGLE_OAUTH_ACCESS_TOKEN',
    );
  });

  it('signs a JWT for a service account key in GOOGLE_APPLICATION_CREDENTIALS', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    fake.oauth.servicePublicKey = publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const env = emptyEnvForTest();
    const keyPath = writeJsonForTest(env.HOME, 'key.json', {
      type: 'service_account',
      client_email: 'ci@acme.iam.gserviceaccount.com',
      private_key: privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      private_key_id: 'k1',
      token_uri: `${fake.origin}/oauth/token`,
    });
    const credentials = createCredentials({
      env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: keyPath },
    });
    assert.equal(
      (await credentials.getToken()).token,
      'oauth-token-for-ci@acme.iam.gserviceaccount.com',
    );
    const found = await credentials.describe();
    assert.equal(found.source, 'GOOGLE_APPLICATION_CREDENTIALS');
    assert.match(found.detail, /service account ci@acme/);
  });

  it("refreshes gcloud's application default credentials, with their quota project", async () => {
    const env = emptyEnvForTest();
    writeAdcFileForTest(env.HOME, {
      type: 'authorized_user',
      client_id: 'id',
      client_secret: 'secret',
      refresh_token: 'refresh-me',
      quota_project_id: 'acme-billing',
    });
    const credentials = createCredentials({
      env,
      oauthUrl: `${fake.origin}/oauth`,
    });
    const foundToken = await credentials.getToken();
    assert.equal(foundToken.token, 'oauth-token');
    assert.equal(foundToken.quotaProject, 'acme-billing');
    assert.equal(
      (await credentials.describe()).source,
      'application default credentials',
    );
  });

  it('exchanges a workload identity token and impersonates a service account', async () => {
    const env = emptyEnvForTest();
    const configPath = writeJsonForTest(env.HOME, 'wif.json', {
      type: 'external_account',
      audience:
        '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/gh',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: `${fake.origin}/sts/v1/token`,
      service_account_impersonation_url: `${fake.origin}/iam/sa:generateAccessToken`,
      credential_source: {
        url: `${fake.origin}/oidc`,
        headers: { Authorization: 'bearer gh' },
        format: { type: 'json', subject_token_field_name: 'value' },
      },
    });
    const credentials = createCredentials({
      env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: configPath },
    });
    assert.equal((await credentials.getToken()).token, 'oauth-token');
    assert.match((await credentials.describe()).detail, /workload identity/);
  });

  it('asks the metadata server last, on Google Cloud', async () => {
    const credentials = createCredentials({
      env: {
        ...emptyEnvForTest(),
        GCE_METADATA_HOST: fake.origin.replace('http://', ''),
      },
    });
    assert.equal((await credentials.getToken()).token, 'metadata-token');
  });

  it('says everything it tried when nothing has credentials', async () => {
    const credentials = createCredentials({ env: emptyEnvForTest() });
    await assert.rejects(credentials.getToken(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /found no Google credentials\. It tried:/);
      assert.match(error.message, /GOOGLE_OAUTH_ACCESS_TOKEN \(not set\)/);
      assert.match(error.message, /gcloud \(not installed\)/);
      assert.match(
        error.message,
        /application_default_credentials\.json \(none\)/,
      );
      assert.match(error.message, /the metadata server/);
      assert.match(error.message, /Run `gcloud auth login`/);
      return true;
    });
  });

  it("refuses a credentials file it can't use, naming it", async () => {
    const env = emptyEnvForTest();
    const path = writeJsonForTest(env.HOME, 'odd.json', { type: 'mystery' });
    const credentials = createCredentials({
      env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: path },
    });
    await assert.rejects(
      credentials.getToken(),
      /odd\.json isn't a credentials file storehouse can use/,
    );
  });

  it('finds a token again once it is about to expire', async () => {
    const env = emptyEnvForTest();
    writeAdcFileForTest(env.HOME, {
      type: 'authorized_user',
      client_id: 'i',
      client_secret: 's',
      refresh_token: 'refresh-me',
    });
    let clock = 0;
    fake.oauth.expiresIn = 120;
    const credentials = createCredentials({
      env,
      oauthUrl: `${fake.origin}/oauth`,
      now: () => clock,
    });
    assert.equal((await credentials.getToken()).token, 'oauth-token');
    fake.oauth.accessToken = 'second-token';
    clock = 30_000;
    assert.equal((await credentials.getToken()).token, 'oauth-token');
    clock = 70_000;
    assert.equal((await credentials.getToken()).token, 'second-token');
  });

  it("uses gcloud's login, and says why when gcloud has none", async () => {
    const env = emptyEnvForTest();
    createFakeCliForTest({
      binDir: env.PATH,
      name: 'gcloud',
      successText: 'gcloud-token',
    });
    const credentials = createCredentials({ env });
    assert.equal((await credentials.getToken()).token, 'gcloud-token');
    assert.equal((await credentials.describe()).source, 'gcloud');

    const loggedOut = emptyEnvForTest();
    createFakeCliForTest({
      binDir: loggedOut.PATH,
      name: 'gcloud',
      behaviour: FakeCliBehaviour.notLoggedIn,
    });
    await assert.rejects(
      createCredentials({ env: loggedOut }).getToken(),
      /gcloud \(You are not logged in\. Run the login command\.\)/,
    );
  });

  it('reads a workload identity token from a file, as text', async () => {
    const env = emptyEnvForTest();
    const tokenPath = join(env.HOME, 'oidc.txt');
    writeFileSync(tokenPath, 'oidc-token\n');
    const configPath = writeJsonForTest(env.HOME, 'wif.json', {
      type: 'external_account',
      audience: 'aud',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: `${fake.origin}/sts/v1/token`,
      credential_source: { file: tokenPath },
    });
    const credentials = createCredentials({
      env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: configPath },
    });
    assert.equal((await credentials.getToken()).token, 'federated-token');
  });

  it('names what failed in a workload identity exchange', async () => {
    const env = emptyEnvForTest();
    const wrongTokenPath = join(env.HOME, 'wrong.txt');
    writeFileSync(wrongTokenPath, 'wrong-token');
    const base = {
      type: 'external_account',
      audience: 'aud',
      subject_token_type: 'jwt',
      token_url: `${fake.origin}/sts/v1/token`,
    };
    const cases = [
      [
        { ...base, credential_source: { executable: { command: 'x' } } },
        /gets its token from a program or from AWS/,
      ],
      [
        { ...base, credential_source: { file: wrongTokenPath } },
        /Google refused to exchange the workload identity token \(400\)/,
      ],
      [
        {
          ...base,
          credential_source: {
            url: `${fake.origin}/oidc`,
            format: { type: 'json', subject_token_field_name: 'nope' },
          },
        },
        /has no "nope" field/,
      ],
      [
        {
          ...base,
          token_url: `${fake.origin}/sts/v1/token`,
          service_account_impersonation_url: `${fake.origin}/iam/sa:generateAccessToken`,
          credential_source: { url: `${fake.origin}/missing-token` },
        },
        /The workload identity token at .*missing-token didn't come \(400\)/,
      ],
    ] as const;
    for (const [config, message] of cases) {
      const path = writeJsonForTest(env.HOME, 'wif.json', config);
      await assert.rejects(
        createCredentials({
          env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: path },
        }).getToken(),
        message,
      );
    }
  });

  it("names a service account key that can't sign", async () => {
    const env = emptyEnvForTest();
    const keyPath = writeJsonForTest(env.HOME, 'key.json', {
      type: 'service_account',
      client_email: 'ci@acme.iam.gserviceaccount.com',
      private_key: 'not a key',
    });
    await assert.rejects(
      createCredentials({
        env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: keyPath },
      }).getToken(),
      /The service account key for ci@acme\.iam\.gserviceaccount\.com couldn't sign a token/,
    );
  });

  it("names a credentials file that isn't JSON", async () => {
    const env = emptyEnvForTest();
    const path = join(env.HOME, 'broken.json');
    writeFileSync(path, '{');
    await assert.rejects(
      createCredentials({
        env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: path },
      }).getToken(),
      /The credentials file .*broken\.json isn't JSON/,
    );
  });

  it("names a refresh Google won't take", async () => {
    const env = emptyEnvForTest();
    writeAdcFileForTest(env.HOME, {
      type: 'authorized_user',
      client_id: 'i',
      client_secret: 's',
      refresh_token: 'revoked',
    });
    await assert.rejects(
      createCredentials({ env, oauthUrl: `${fake.origin}/oauth` }).getToken(),
      /Google refused to refresh your application default credentials \(400\)/,
    );
  });

  it('names an unreachable token URL, as a failure rather than a bug', async () => {
    const env = emptyEnvForTest();
    for (const source of [
      { credential_source: { url: 'http://127.0.0.1:9/token' } },
      {
        credential_source: {
          url: `${fake.origin}/oidc`,
          format: { type: 'json', subject_token_field_name: 'value' },
        },
        service_account_impersonation_url:
          'http://127.0.0.1:9/sa:generateAccessToken',
      },
    ]) {
      const path = writeJsonForTest(env.HOME, 'wif.json', {
        type: 'external_account',
        audience: 'aud',
        subject_token_type: 'jwt',
        token_url: `${fake.origin}/sts/v1/token`,
        ...source,
      });
      await assert.rejects(
        createCredentials({
          env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: path },
        }).getToken(),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.match(
            error.message,
            /^Couldn't reach 127\.0\.0\.1:9 to .*Check your connection/,
          );
          return true;
        },
      );
    }
  });

  it("never quotes a credentials file that isn't JSON", async () => {
    const env = emptyEnvForTest();
    const path = join(env.HOME, 'token.txt');
    writeFileSync(path, 'ya29.a0SECRETTOKENVALUE');
    await assert.rejects(
      createCredentials({
        env: { ...env, GOOGLE_APPLICATION_CREDENTIALS: path },
      }).getToken(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /isn't JSON/);
        assert.doesNotMatch(error.message, /ya29|SECRET/);
        return true;
      },
    );
  });

  it('shares one refresh among requests refused at the same time', async () => {
    const env = emptyEnvForTest();
    const getRuns = createFakeCliForTest({
      binDir: env.PATH,
      name: 'gcloud',
      successText: 'gcloud-token',
    });
    const credentials = createCredentials({ env });
    await credentials.getToken();
    await Promise.all(
      Array.from({ length: 8 }, () => credentials.refreshToken()),
    );
    assert.equal(getRuns().length, 2);
  });

  it('refuses a GCE_METADATA_HOST that is more than a host and port', async () => {
    for (const host of [
      'evil.example/steal?x=',
      'http://evil.example',
      'a b',
    ]) {
      await assert.rejects(
        createCredentials({
          env: { ...emptyEnvForTest(), GCE_METADATA_HOST: host },
        }).getToken(),
        /GCE_METADATA_HOST must be a bare host or host:port/,
      );
    }
  });
});
