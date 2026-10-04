/**
 * Windows 原生文件夹选择窗口。
 *
 * 使用 Windows PowerShell STA 模式承载 FolderBrowserDialog，并通过 Win32
 * API 将窗口提升到最前，避免被浏览器窗口遮挡。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PICKER_TIMEOUT_MS = 10 * 60 * 1000;
let activePicker = null;

const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DeltaHighlightNativeFolder
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_SHOWWINDOW = 0x0040;

    public static bool PromoteDialog(uint processId)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint windowProcessId;
            GetWindowThreadProcessId(hWnd, out windowProcessId);
            if (windowProcessId != processId || !IsWindowVisible(hWnd)) return true;

            StringBuilder title = new StringBuilder(256);
            GetWindowText(hWnd, title, title.Capacity);
            string text = title.ToString();
            if (text.IndexOf("文件夹", StringComparison.OrdinalIgnoreCase) >= 0 ||
                text.IndexOf("Folder", StringComparison.OrdinalIgnoreCase) >= 0 ||
                text.IndexOf("Browse", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return false;
        SetWindowPos(found, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        SetForegroundWindow(found);
        return true;
    }

    public static void KeepTopMost(uint processId, int durationMs)
    {
        Thread thread = new Thread(delegate()
        {
            int end = Environment.TickCount + durationMs;
            while (Environment.TickCount < end)
            {
                try { PromoteDialog(processId); } catch { }
                Thread.Sleep(120);
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@

$initialPath = $env:DF_INITIAL_DIR
if ([string]::IsNullOrWhiteSpace($initialPath) -or -not (Test-Path -LiteralPath $initialPath -PathType Container)) {
    $initialPath = [Environment]::GetFolderPath('MyDocuments')
}

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '请选择素材文件夹'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = $initialPath
$currentProcessId = [uint32][System.Diagnostics.Process]::GetCurrentProcess().Id
[DeltaHighlightNativeFolder]::KeepTopMost($currentProcessId, 600000)
$result = $dialog.ShowDialog()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $selectedPath = [System.IO.Path]::GetFullPath($dialog.SelectedPath)
    $pathBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($selectedPath))
    [pscustomobject]@{ cancelled = $false; path = $selectedPath; pathUtf8Base64 = $pathBase64 } | ConvertTo-Json -Compress
} else {
    [pscustomobject]@{ cancelled = $true; path = $null; pathUtf8Base64 = $null } | ConvertTo-Json -Compress
}
`;

function isDirectory(targetPath) {
  try {
    return !!targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch (_) {
    return false;
  }
}

function getPowerShellPath() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function isPickerActive() {
  return !!activePicker;
}

function selectDirectory(initialPath, fallbackPath) {
  if (process.platform !== 'win32') {
    const err = new Error('当前系统不支持原生文件夹选择窗口');
    err.code = 'UNSUPPORTED_PLATFORM';
    return Promise.reject(err);
  }
  if (activePicker) {
    const err = new Error('文件夹选择窗口已经打开');
    err.code = 'PICKER_BUSY';
    return Promise.reject(err);
  }

  let resolvedInitialPath = typeof initialPath === 'string' ? initialPath.trim() : '';
  if (!isDirectory(resolvedInitialPath)) resolvedInitialPath = fallbackPath;
  if (!isDirectory(resolvedInitialPath)) resolvedInitialPath = process.cwd();
  resolvedInitialPath = path.resolve(resolvedInitialPath);

  return new Promise((resolve, reject) => {
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn(getPowerShellPath(), [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedScript
      ], {
        windowsHide: true,
        env: { ...process.env, DF_INITIAL_DIR: resolvedInitialPath }
      });
    } catch (err) {
      reject(err);
      return;
    }

    activePicker = child;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activePicker === child) activePicker = null;
      if (err) reject(err);
      else resolve(value);
    };

    const timeout = setTimeout(() => {
      const err = new Error('文件夹选择窗口等待超时');
      err.code = 'PICKER_TIMEOUT';
      settle(err);
      if (child.exitCode === null) child.kill();
    }, PICKER_TIMEOUT_MS);

    child.stdout.on('data', data => { stdout += data.toString('utf8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf8'); });

    child.on('error', err => settle(err));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        const reason = stderr.trim() || ('PowerShell exited with code ' + code);
        const err = new Error('文件夹选择窗口启动失败: ' + reason);
        err.code = 'PICKER_FAILED';
        settle(err);
        return;
      }

      try {
        const lines = stdout
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);
        const data = JSON.parse(lines[lines.length - 1] || '{}');
        if (data.cancelled) {
          settle(null, null);
          return;
        }

        const selectedPath = data.pathUtf8Base64
          ? Buffer.from(data.pathUtf8Base64, 'base64').toString('utf8')
          : data.path;
        if (!selectedPath || !path.isAbsolute(selectedPath) || !isDirectory(selectedPath)) {
          const err = new Error('选择的文件夹无效');
          err.code = 'INVALID_DIRECTORY';
          settle(err);
          return;
        }
        settle(null, path.resolve(selectedPath));
      } catch (err) {
        err.code = 'PICKER_RESULT_INVALID';
        settle(err);
      }
    });
  });
}

module.exports = {
  isPickerActive,
  selectDirectory,
  script
};
