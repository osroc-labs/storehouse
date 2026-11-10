import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

// a Mac's and Windows' usual disks ignore letter case, so Config/x and config/x are one file there
const isCaseInsensitive =
  process.platform === 'darwin' || process.platform === 'win32';

const getComparable = (path: string) =>
  isCaseInsensitive ? path.toLowerCase() : path;

// a path as it really is: the nearest part that exists through its symlinks, plus the rest
const getRealPath = (path: string): string => {
  if (existsSync(path)) return realpathSync.native(path);
  if (dirname(path) === path) return path;
  return join(getRealPath(dirname(path)), basename(path));
};

// whether path is root or somewhere below it, both already real paths
const isInside = (root: string, path: string) => {
  const fromRoot = relative(getComparable(root), getComparable(path));
  return (
    fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot)
  );
};

// whether two real paths name the same file, as the disk compares them
const isSame = (a: string, b: string) => getComparable(a) === getComparable(b);

// whether a file name is name, as the disk compares them
const isNamed = (path: string, name: string) =>
  getComparable(basename(path)) === getComparable(name);

export const pathService = {
  getReal: getRealPath,
  isInside,
  isSame,
  isNamed,
  isCaseInsensitive,
};
