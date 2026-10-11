using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Delta Highlight Uninstaller")]
[assembly: System.Reflection.AssemblyProduct("Delta Highlight")]
[assembly: System.Reflection.AssemblyCompany("Delta Highlight")]
[assembly: System.Reflection.AssemblyVersion("2.0.9.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.0.9.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("2.0.9")]


namespace DeltaHighlight.Uninstall
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            DialogResult keepData = MessageBox.Show(
                "是否保留“素材”和“成品”目录？\r\n\r\n是：保留数据，只删除程序\r\n否：删除全部文件和目录",
                "卸载 Delta Highlight",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Question);

            if (keepData == DialogResult.Cancel)
                return;

            try
            {
                StopRunningApplication(installDir);
                RemoveShortcuts();
                RemoveRegistryEntries();
                ScheduleDirectoryCleanup(installDir, keepData == DialogResult.Yes);
                MessageBox.Show("卸载完成。", "Delta Highlight", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("卸载失败：" + ex.Message, "Delta Highlight", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void StopRunningApplication(string installDir)
        {
            string pidFile = Path.Combine(installDir, "logs", "launcher.pid");
            if (File.Exists(pidFile))
            {
                int processId;
                if (int.TryParse(File.ReadAllText(pidFile).Trim(), out processId))
                {
                    try
                    {
                        Process process = Process.GetProcessById(processId);
                        string executable = Path.GetFullPath(process.MainModule.FileName);
                        string expected = Path.Combine(installDir, "DeltaHighlight.exe");
                        if (string.Equals(executable, expected, StringComparison.OrdinalIgnoreCase))
                            RunHidden("taskkill.exe", "/PID " + processId.ToString() + " /T /F");
                    }
                    catch
                    {
                    }
                }
            }
        }

        private static void RemoveShortcuts()
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string shortcut = Path.Combine(desktop, "Delta Highlight.lnk");
            string startMenuDir = Path.Combine(programs, "Delta Highlight");

            if (File.Exists(shortcut))
                File.Delete(shortcut);
            if (Directory.Exists(startMenuDir))
                Directory.Delete(startMenuDir, true);
        }

        private static void RemoveRegistryEntries()
        {
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\DeltaHighlight", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\DeltaHighlight", false);
        }

        private static void ScheduleDirectoryCleanup(string installDir, bool keepData)
        {
            string scriptPath = Path.Combine(Path.GetTempPath(), "delta-highlight-uninstall-" + Guid.NewGuid().ToString("N") + ".cmd");
            StringBuilder script = new StringBuilder();
            script.AppendLine("@echo off");
            script.AppendLine("timeout /t 2 /nobreak >nul");

            if (keepData)
            {
                script.AppendLine("for /d %%D in (\"" + EscapeBatch(installDir) + "\\*\") do (");
                script.AppendLine("  if /I not \"%%~nxD\"==\"material\" if /I not \"%%~nxD\"==\"output\" if /I not \"%%~nxD\"==\"work\" rd /s /q \"%%D\"");
                script.AppendLine(")");
                script.AppendLine("del /f /q \"" + EscapeBatch(installDir) + "\\*.*\" >nul 2>&1");
            }
            else
            {
                script.AppendLine("rmdir /s /q \"" + EscapeBatch(installDir) + "\"");
            }

            script.AppendLine("del /f /q \"%~f0\" >nul 2>&1");
            File.WriteAllText(scriptPath, script.ToString(), Encoding.Default);

            ProcessStartInfo info = new ProcessStartInfo("cmd.exe", "/c \"" + scriptPath + "\"");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
        }

        private static string EscapeBatch(string value)
        {
            return value.Replace("%", "%%");
        }

        private static void RunHidden(string fileName, string arguments)
        {
            ProcessStartInfo info = new ProcessStartInfo(fileName, arguments);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process process = Process.Start(info);
            process.WaitForExit();
        }
    }
}
