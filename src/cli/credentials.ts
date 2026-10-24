import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { CliError } from './errors.js';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

function directory() {
  const value = process.env.MC_CONFIG_DIR ?? join(homedir(), '.config', 'mission-control');
  if (!isAbsolute(value)) throw new CliError('MC_CONFIG_DIR must be an absolute path.', 'STORAGE_ERROR');
  return value;
}

const filename = () => join(directory(), 'session.json');

const storedSession = z.strictObject({ apiUrl: z.string().url(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime() });

export type Credentials = z.infer<typeof storedSession>;

function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

async function checkDirectory() {
  const info = await lstat(directory());
  const fromProject = relative(await realpath(projectRoot), await realpath(directory()));
  if (fromProject !== '..' && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject)) {
    throw new CliError('Credential directory must be outside the project.', 'STORAGE_ERROR');
  }

  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) {
    throw new CliError('Credential directory must be owned by you with permissions 700 and must not be a symlink.', 'STORAGE_ERROR');
  }
}

export async function loadCredentials(): Promise<Credentials | undefined> {
  try {
    await checkDirectory();
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }

  let file;
  try {
    file = await open(filename(), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return;
    throw new CliError('Cannot safely open credential file. Check ownership and remove any session.json symlink.', 'STORAGE_ERROR');
  }

  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 4096
      || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe credential file.');
    return storedSession.parse(JSON.parse(await file.readFile('utf8')));
  } catch {
    throw new CliError('Invalid credential file. Check ownership/permissions (600), or remove its session.json and log in again.', 'STORAGE_ERROR');
  } finally {
    await file.close();
  }
}

export async function saveCredentials(value: Credentials) {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  await checkDirectory();

  const temporary = join(directory(), `${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename());
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearCredentials() {
  try {
    await checkDirectory();
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  await rm(filename(), { force: true });
}
