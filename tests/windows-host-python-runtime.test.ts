import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getWindowsHostPythonRuntimeLayout,
  isWindowsHostPythonRuntimeReady,
  resolveWindowsHostPythonRuntime,
} from '../src/main/python/windows-host-runtime';

describe('windows-host-runtime', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds layout from the official python.org FTP base URL', () => {
    const layout = getWindowsHostPythonRuntimeLayout('C:\\Users\\tester\\AppData\\Roaming\\open-cowork', '3.11.13');

    expect(layout.downloadUrl).toBe(
      'https://www.python.org/ftp/python/3.11.13/python-3.11.13-embed-amd64.zip'
    );
    expect(layout.runtimeRoot).toContain(path.join('runtimes', 'python', 'windows-x64', '3.11.13'));
    expect(path.basename(layout.pthFile)).toBe('python311._pth');
  });

  it('treats the runtime as ready only when python.exe and the runtime marker exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-win-python-'));
    tempDirs.push(tempDir);

    const layout = getWindowsHostPythonRuntimeLayout(tempDir, '3.11.13');
    fs.mkdirSync(layout.runtimeRoot, { recursive: true });
    fs.writeFileSync(layout.pythonExe, '');

    expect(isWindowsHostPythonRuntimeReady(layout)).toBe(false);

    fs.writeFileSync(
      layout.markerFile,
      '3.11.13|pillow|markitdown[pptx]|pypdf|pdfplumber|reportlab|defusedxml|python-pptx'
    );

    expect(isWindowsHostPythonRuntimeReady(layout)).toBe(true);
  });

  it('resolves the installed runtime metadata from disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-win-python-'));
    tempDirs.push(tempDir);

    const layout = getWindowsHostPythonRuntimeLayout(tempDir, '3.11.13');
    fs.mkdirSync(layout.runtimeRoot, { recursive: true });
    fs.writeFileSync(layout.pythonExe, '');
    fs.writeFileSync(layout.python3Exe, '');
    fs.writeFileSync(layout.pipCmd, '');
    fs.writeFileSync(layout.pip3Cmd, '');
    fs.writeFileSync(
      layout.markerFile,
      '3.11.13|pillow|markitdown[pptx]|pypdf|pdfplumber|reportlab|defusedxml|python-pptx'
    );

    const resolved = resolveWindowsHostPythonRuntime(tempDir);

    expect(resolved).not.toBeNull();
    expect(resolved?.root).toBe(layout.runtimeRoot);
    expect(resolved?.python).toBe(layout.pythonExe);
    expect(resolved?.python3).toBe(layout.python3Exe);
    expect(resolved?.pip).toBe(layout.pipCmd);
    expect(resolved?.pip3).toBe(layout.pip3Cmd);
    expect(resolved?.sitePackages).toBe(layout.sitePackagesDir);
  });
});