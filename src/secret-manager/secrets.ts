import type { SecretManagerApi, SecretVersion } from './secret-manager-api.ts';

// Secrets and their versions in storehouse's own types, whatever Secret Manager's replies look like.

const transformSecretVersionToVersion = (version: SecretVersion) => ({
  number: Number(version.name.split('/').at(-1)),
  created: version.createTime,
  state: version.state,
});

export type Version = ReturnType<typeof transformSecretVersionToVersion>;

// set puts this label on a protected env's secrets, so the rules hold even when no manifest says so
export const protectedLabel = 'storehouse-protected';

const isLabelledProtected = (labels: Record<string, string> | undefined) =>
  labels?.[protectedLabel] === 'true';

export const createSecretService = (
  api: SecretManagerApi,
  // runs the protected-env rules once a secret turns out to carry protectedLabel
  { onProtectedSecret }: { onProtectedSecret: () => Promise<void> },
) => {
  // the secret's labels, or undefined when it doesn't exist; a protected label applies the rules
  const getLabels = async (project: string, secret: string) => {
    const labels = await api.secrets.get(project, secret);
    if (isLabelledProtected(labels)) await onProtectedSecret();
    return labels;
  };

  // The latest version's metadata, or undefined when the secret or its versions don't exist.
  const getLatestVersion = async (project: string, secret: string) => {
    const latestVersion = await api.versions.getLatest(project, secret);
    return latestVersion && transformSecretVersionToVersion(latestVersion);
  };

  // Every version, newest first, or undefined when the secret doesn't exist.
  const getVersions = async (project: string, secret: string) => {
    const allVersions: Version[] = [];
    let pageToken = '';
    do {
      const page = await api.versions.list({ project, secret, pageToken });
      if (!page) return undefined;
      allVersions.push(
        ...(page.versions ?? []).map(transformSecretVersionToVersion),
      );
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return allVersions.toSorted((a, b) => b.number - a.number);
  };

  // The latest value's bytes, or undefined when there's no enabled latest version.
  const getValue = async (project: string, secret: string) => {
    await getLabels(project, secret);
    const data = await api.versions.accessLatest(project, secret);
    return data === undefined ? undefined : Buffer.from(data, 'base64');
  };

  const addVersion = async ({
    project,
    secret,
    value,
  }: {
    project: string;
    secret: string;
    value: Uint8Array;
  }) =>
    transformSecretVersionToVersion(
      await api.versions.add({
        project,
        secret,
        data: Buffer.from(value).toString('base64'),
      }),
    );

  return {
    getLatestVersion,
    getVersions,
    getValue,
    getLabels,
    create: api.secrets.create,
    updateLabels: api.secrets.updateLabels,
    addVersion,
  };
};

export type SecretService = ReturnType<typeof createSecretService>;
