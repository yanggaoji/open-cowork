import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WINDOWS_HOST_PYTHON_VERSION =
  process.env.OPEN_COWORK_WINDOWS_PYTHON_VERSION || '3.11.13';

const WINDOWS_HOST_PYTHON_BASE_URL = (
  process.env.OPEN_COWORK_WINDOWS_PYTHON_BASE_URL || 'https://www.python.org/ftp/python/'
).replace(/\/+$/, '');

const GET_PIP_URL = process.env.OPEN_COWORK_WINDOWS_GET_PIP_URL || 'https://bootstrap.pypa.io/get-pip.py';
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 1000;

export const WINDOWS_HOST_PYTHON_PACKAGES = [
  'pillow',
  'markitdown[pptx]',
  'pypdf',
  'pdfplumber',
  'reportlab',
  'defusedxml',
  'python-pptx',
] as const;

const WINDOWS_HOST_PYTHON_FINGERPRINT = [
  WINDOWS_HOST_PYTHON_VERSION,
  ...WINDOWS_HOST_PYTHON_PACKAGES,
].join('|');

export interface WindowsHostPythonRuntimeLayout {
  baseDir: string;
  runtimesDir: string;
  downloadsDir: string;
  runtimeRoot: string;
  archivePath: string;
  downloadUrl: string;
  getPipPath: string;
  lockFile: string;
  markerFile: string;
  pythonExe: string;
  python3Exe: string;
  pipCmd: string;
  pip3Cmd: string;
  pthFile: string;
  sitePackagesDir: string;
}

export interface WindowsHostPythonRuntime {
  root: string;
  python: string;
  python3: string;
  pip: string | null;
  pip3: string | null;
  sitePackages: string;
}

type LogLevel = 'info' | 'warn' | 'error';
type LogFn = (level: LogLevel, message: string) => void;

type LockHandle = {
  path: string;
  handle: fs.promises.FileHandle | null;
  acquired: boolean;
};

const ensurePromises = new Map<string, Promise<WindowsHostPythonRuntime | null>>();

function defaultLog(level: LogLevel, message: string): void {
  const prefix = '[WindowsHostPython]';
  if (level === 'error') {
    console.error(prefix, message);
  } else if (level === 'warn') {
    console.warn(prefix, message);
  } else {
    console.log(prefix, message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getRuntimeTag(version: string): string {
  const [major, minor] = version.split('.');
  return `${major}${minor}`;
}

export function resolveOpenCoworkDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): string {
  const explicit = env.OPEN_COWORK_USER_DATA?.trim();
  if (explicit) {
    return explicit;
  }

  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'open-cowork');
  }

  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'open-cowork');
  }

  return path.join(homeDir, '.config', 'open-cowork');
}

export function getWindowsHostPythonRuntimeLayout(
  baseDir = resolveOpenCoworkDataDir('win32'),
  version = WINDOWS_HOST_PYTHON_VERSION
): WindowsHostPythonRuntimeLayout {
  const runtimesDir = path.join(baseDir, 'runtimes', 'python');
  const downloadsDir = path.join(runtimesDir, '.downloads');
  const runtimeRoot = path.join(runtimesDir, 'windows-x64', version);
  const archiveName = `python-${version}-embed-amd64.zip`;
  const runtimeTag = getRuntimeTag(version);

  return {
    baseDir,
    runtimesDir,
    downloadsDir,
    runtimeRoot,
    archivePath: path.join(downloadsDir, archiveName),
    downloadUrl: `${WINDOWS_HOST_PYTHON_BASE_URL}/${version}/${archiveName}`,
    getPipPath: path.join(downloadsDir, 'get-pip.py'),
    lockFile: path.join(runtimesDir, '.install.lock'),
    markerFile: path.join(runtimeRoot, 'runtime-version.txt'),
    pythonExe: path.join(runtimeRoot, 'python.exe'),
    python3Exe: path.join(runtimeRoot, 'python3.exe'),
    pipCmd: path.join(runtimeRoot, 'pip.cmd'),
    pip3Cmd: path.join(runtimeRoot, 'pip3.cmd'),
    pthFile: path.join(runtimeRoot, `python${runtimeTag}._pth`),
    sitePackagesDir: path.join(runtimeRoot, 'Lib', 'site-packages'),
  };
}

export function isWindowsHostPythonRuntimeReady(
  layout: WindowsHostPythonRuntimeLayout,
  existsSync: typeof fs.existsSync = fs.existsSync,
  readFileSync: typeof fs.readFileSync = fs.readFileSync
): boolean {
  if (!existsSync(layout.pythonExe)) {
    return false;
  }

  if (!existsSync(layout.markerFile)) {
    return false;
  }

  try {
    const marker = readFileSync(layout.markerFile, 'utf8').trim();
    return marker === WINDOWS_HOST_PYTHON_FINGERPRINT;
  } catch {
    return false;
  }
}

export function resolveWindowsHostPythonRuntime(
  baseDir = resolveOpenCoworkDataDir('win32')
): WindowsHostPythonRuntime | null {
  const layout = getWindowsHostPythonRuntimeLayout(baseDir);
  if (!isWindowsHostPythonRuntimeReady(layout)) {
    return null;
  }

  return {
    root: layout.runtimeRoot,
    python: layout.pythonExe,
    python3: fs.existsSync(layout.python3Exe) ? layout.python3Exe : layout.pythonExe,
    pip: fs.existsSync(layout.pipCmd) ? layout.pipCmd : null,
    pip3: fs.existsSync(layout.pip3Cmd) ? layout.pip3Cmd : null,
    sitePackages: layout.sitePackagesDir,
  };
}

function buildPythonEnv(layout: WindowsHostPythonRuntimeLayout): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONHOME: layout.runtimeRoot,
    PYTHONPATH: layout.sitePackagesDir,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
  };
}

function downloadFile(url: string, destination: string, onLog: LogFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const tempPath = `${destination}.tmp`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'open-cowork-windows-python-bootstrap',
          Accept: '*/*',
        },
      },
      (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirect = response.headers.location;
          response.resume();
          if (!redirect) {
            reject(new Error(`Download redirect missing Location header: ${url}`));
            return;
          }
          downloadFile(redirect, destination, onLog).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Download failed: HTTP ${response.statusCode} for ${url}`));
          return;
        }

        const file = fs.createWriteStream(tempPath);
        response.pipe(file);

        file.on('finish', () => {
          file.close((closeError) => {
            if (closeError) {
              reject(closeError);
              return;
            }

            try {
              if (fs.existsSync(destination)) {
                fs.rmSync(destination, { force: true });
              }
              fs.renameSync(tempPath, destination);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });

        file.on('error', (error) => {
          file.close(() => {
            fs.rm(tempPath, { force: true }, () => reject(error));
          });
        });
      }
    );

    request.on('error', (error) => {
      fs.rm(tempPath, { force: true }, () => reject(error));
    });

    onLog('info', `Downloading ${path.basename(destination)} from ${url}`);
  });
}

async function extractZipWithPowerShell(
  archivePath: string,
  destinationDir: string,
  onLog: LogFn
): Promise<void> {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  const psExe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

  const command = [
    '$ErrorActionPreference = "Stop"',
    `Expand-Archive -Path ${escapePowerShellLiteral(archivePath)} -DestinationPath ${escapePowerShellLiteral(destinationDir)} -Force`,
  ].join('; ');

  onLog('info', `Extracting ${path.basename(archivePath)} into ${destinationDir}`);
  await execFileAsync(psExe, ['-NoProfile', '-Command', command], {
    timeout: 180000,
    windowsHide: true,
  });
}

async function configureEmbeddedRuntime(
  layout: WindowsHostPythonRuntimeLayout,
  onLog: LogFn
): Promise<void> {
  if (!fs.existsSync(layout.pythonExe)) {
    throw new Error(`Extracted runtime is missing python.exe: ${layout.pythonExe}`);
  }

  fs.mkdirSync(layout.sitePackagesDir, { recursive: true });

  const runtimeTag = getRuntimeTag(WINDOWS_HOST_PYTHON_VERSION);
  const pthFile = fs.existsSync(layout.pthFile)
    ? layout.pthFile
    : path.join(layout.runtimeRoot, `python${runtimeTag}._pth`);

  const pthLines = [
    `python${runtimeTag}.zip`,
    '.',
    'Lib',
    'Lib/site-packages',
    'import site',
    '',
  ];
  fs.writeFileSync(pthFile, pthLines.join('\r\n'), 'utf8');

  if (!fs.existsSync(layout.python3Exe)) {
    fs.copyFileSync(layout.pythonExe, layout.python3Exe);
  }

  const pipWrapper = '@echo off\r\n"%~dp0python.exe" -m pip %*\r\n';
  fs.writeFileSync(layout.pipCmd, pipWrapper, 'utf8');
  fs.writeFileSync(layout.pip3Cmd, pipWrapper, 'utf8');

  onLog('info', `Configured embedded Python at ${layout.runtimeRoot}`);
}

async function ensurePip(layout: WindowsHostPythonRuntimeLayout, onLog: LogFn): Promise<void> {
  try {
    await execFileAsync(layout.pythonExe, ['-m', 'pip', '--version'], {
      cwd: layout.runtimeRoot,
      env: buildPythonEnv(layout),
      timeout: 15000,
      windowsHide: true,
    });
    return;
  } catch {
    // Continue to bootstrap pip.
  }

  await downloadFile(GET_PIP_URL, layout.getPipPath, onLog);
  onLog('info', 'Bootstrapping pip in embedded Python runtime');
  await execFileAsync(
    layout.pythonExe,
    [layout.getPipPath, '--disable-pip-version-check', '--no-warn-script-location'],
    {
      cwd: layout.runtimeRoot,
      env: buildPythonEnv(layout),
      timeout: 180000,
      windowsHide: true,
    }
  );

  await execFileAsync(layout.pythonExe, ['-m', 'pip', '--version'], {
    cwd: layout.runtimeRoot,
    env: buildPythonEnv(layout),
    timeout: 15000,
    windowsHide: true,
  });
}

async function installPackages(layout: WindowsHostPythonRuntimeLayout, onLog: LogFn): Promise<void> {
  onLog('info', `Installing Windows host Python packages into ${layout.sitePackagesDir}`);
  await execFileAsync(
    layout.pythonExe,
    [
      '-m',
      'pip',
      'install',
      '--upgrade',
      '--disable-pip-version-check',
      '--no-input',
      '--no-warn-script-location',
      '--target',
      layout.sitePackagesDir,
      ...WINDOWS_HOST_PYTHON_PACKAGES,
    ],
    {
      cwd: layout.runtimeRoot,
      env: buildPythonEnv(layout),
      timeout: 300000,
      windowsHide: true,
    }
  );
}

async function maybeClearStaleLock(lockFile: string, onLog: LogFn): Promise<void> {
  try {
    const stat = await fs.promises.stat(lockFile);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await fs.promises.rm(lockFile, { force: true });
      onLog('warn', `Removed stale Windows Python install lock: ${lockFile}`);
    }
  } catch {
    // Ignore races when the lock disappears between stat and rm.
  }
}

async function acquireInstallLock(
  layout: WindowsHostPythonRuntimeLayout,
  onLog: LogFn
): Promise<LockHandle> {
  await fs.promises.mkdir(layout.runtimesDir, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      const handle = await fs.promises.open(layout.lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
      return { path: layout.lockFile, handle, acquired: true };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'EEXIST') {
        throw error;
      }

      const existing = resolveWindowsHostPythonRuntime(layout.baseDir);
      if (existing) {
        return { path: layout.lockFile, handle: null, acquired: false };
      }

      if (Date.now() >= deadline) {
        await maybeClearStaleLock(layout.lockFile, onLog);
        if (Date.now() >= deadline + LOCK_POLL_MS) {
          throw new Error('Timed out waiting for Windows host Python runtime lock');
        }
      }

      await sleep(LOCK_POLL_MS);
    }
  }
}

async function releaseInstallLock(lock: LockHandle): Promise<void> {
  if (!lock.acquired || !lock.handle) {
    return;
  }

  try {
    await lock.handle.close();
  } catch {
    // Ignore close errors during cleanup.
  }

  try {
    await fs.promises.rm(lock.path, { force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

async function installWindowsHostPythonRuntime(
  layout: WindowsHostPythonRuntimeLayout,
  onLog: LogFn,
  force: boolean
): Promise<WindowsHostPythonRuntime | null> {
  const lock = await acquireInstallLock(layout, onLog);
  try {
    const existing = resolveWindowsHostPythonRuntime(layout.baseDir);
    if (existing && !force) {
      return existing;
    }

    await fs.promises.mkdir(layout.downloadsDir, { recursive: true });

    if (!fs.existsSync(layout.archivePath)) {
      await downloadFile(layout.downloadUrl, layout.archivePath, onLog);
    } else {
      onLog('info', `Reusing cached Python archive: ${layout.archivePath}`);
    }

    await extractZipWithPowerShell(layout.archivePath, layout.runtimeRoot, onLog);
    await configureEmbeddedRuntime(layout, onLog);
    await ensurePip(layout, onLog);
    await installPackages(layout, onLog);
    await fs.promises.writeFile(layout.markerFile, WINDOWS_HOST_PYTHON_FINGERPRINT, 'utf8');

    const resolved = resolveWindowsHostPythonRuntime(layout.baseDir);
    if (!resolved) {
      throw new Error('Windows host Python runtime installation completed but validation failed');
    }
    return resolved;
  } finally {
    await releaseInstallLock(lock);
  }
}

export async function ensureWindowsHostPythonRuntime(options?: {
  baseDir?: string;
  force?: boolean;
  onLog?: LogFn;
}): Promise<WindowsHostPythonRuntime | null> {
  if (process.platform !== 'win32') {
    return null;
  }

  const onLog = options?.onLog || defaultLog;
  const layout = getWindowsHostPythonRuntimeLayout(options?.baseDir);
  const cacheKey = `${layout.baseDir}::${options?.force ? 'force' : 'default'}`;

  if (!options?.force) {
    const existing = resolveWindowsHostPythonRuntime(layout.baseDir);
    if (existing) {
      return existing;
    }
  }

  const running = ensurePromises.get(cacheKey);
  if (running) {
    return running;
  }

  const promise = installWindowsHostPythonRuntime(layout, onLog, options?.force === true)
    .catch((error) => {
      onLog(
        'error',
        `Failed to provision Windows host Python runtime: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    })
    .finally(() => {
      ensurePromises.delete(cacheKey);
    });

  ensurePromises.set(cacheKey, promise);
  return promise;
}