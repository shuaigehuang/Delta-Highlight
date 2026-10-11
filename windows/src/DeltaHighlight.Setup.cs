using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Delta Highlight Setup")]
[assembly: AssemblyProduct("Delta Highlight")]
[assembly: AssemblyCompany("Delta Highlight")]
[assembly: AssemblyVersion("2.0.9.0")]
[assembly: AssemblyFileVersion("2.0.9.0")]
[assembly: AssemblyInformationalVersion("2.0.9")]


namespace DeltaHighlight.Setup
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length >= 2 && string.Equals(args[0], "/silent", StringComparison.OrdinalIgnoreCase))
            {
                SetupForm form = new SetupForm();
                if (!form.InstallSilently(args[1]))
                    Environment.ExitCode = 1;
                return;
            }

            Application.Run(new SetupForm());
        }
    }

    internal sealed class SetupForm : Form
    {
        private const long PayloadTrailerSize = 16;
        private const int EmSetMargins = 0x00D3;
        private const int EcLeftMargin = 0x0001;
        private const int EcRightMargin = 0x0002;
        private static readonly byte[] PayloadMagic = Encoding.ASCII.GetBytes("DFPAY001");

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private readonly TextBox pathBox;
        private readonly CheckBox desktopShortcut;
        private readonly CheckBox launchAfterInstall;
        private readonly ProgressBar progressBar;
        private readonly Label statusLabel;
        private readonly Button installButton;
        private readonly Button cancelButton;
        private readonly Button browseButton;

        public SetupForm()
        {
            Text = "Delta Highlight 安装程序";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = true;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9.5F);
            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(680, 430);
            DoubleBuffered = true;

            try
            {
                Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
            }

            PictureBox appIcon = new PictureBox();
            appIcon.Location = new Point(24, 18);
            appIcon.Size = new Size(52, 52);
            appIcon.SizeMode = PictureBoxSizeMode.Zoom;
            try
            {
                using (System.Drawing.Icon executableIcon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath))
                {
                    if (executableIcon != null) appIcon.Image = executableIcon.ToBitmap();
                }
            }
            catch
            {
            }
            Controls.Add(appIcon);

            Label title = new Label();
            title.Text = "三角洲行动精彩镜头自动剪辑工具";
            title.Font = new Font(Font.FontFamily, 15F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(15, 23, 42);
            title.AutoSize = false;
            title.Location = new Point(88, 16);
            title.Size = new Size(560, 34);
            title.TextAlign = ContentAlignment.MiddleLeft;
            Controls.Add(title);

            Label description = new Label();
            description.Text = "安装包已包含 Node.js、Python、OpenCV 和 ffmpeg\r\n无需额外配置运行环境";
            description.ForeColor = Color.FromArgb(71, 85, 105);
            description.AutoSize = false;
            description.Location = new Point(90, 53);
            description.Size = new Size(558, 44);
            Controls.Add(description);

            GroupBox installLocationGroup = new GroupBox();
            installLocationGroup.Text = "安装位置";
            installLocationGroup.ForeColor = Color.FromArgb(51, 65, 85);
            installLocationGroup.Location = new Point(24, 104);
            installLocationGroup.Size = new Size(632, 88);
            Controls.Add(installLocationGroup);

            Label pathLabel = new Label();
            pathLabel.Text = "安装目录";
            pathLabel.AutoSize = true;
            pathLabel.Location = new Point(16, 41);
            installLocationGroup.Controls.Add(pathLabel);

            pathBox = new TextBox();
            pathBox.Text = GetDefaultInstallPath();
            Panel pathContainer = new Panel();
            pathContainer.Location = new Point(96, 35);
            pathContainer.Size = new Size(414, 30);
            pathContainer.BackColor = Color.White;
            pathContainer.BorderStyle = BorderStyle.FixedSingle;
            installLocationGroup.Controls.Add(pathContainer);

            pathBox.Location = new Point(4, 5);
            pathBox.Size = new Size(398, 20);
            pathBox.BorderStyle = BorderStyle.None;
            pathBox.BackColor = Color.White;
            pathContainer.Controls.Add(pathBox);

            browseButton = new Button();
            browseButton.Text = "浏览...";
            browseButton.Location = new Point(526, 35);
            browseButton.Size = new Size(92, 30);
            browseButton.Click += delegate { BrowseInstallPath(); };
            installLocationGroup.Controls.Add(browseButton);

            GroupBox optionsGroup = new GroupBox();
            optionsGroup.Text = "安装选项";
            optionsGroup.ForeColor = Color.FromArgb(51, 65, 85);
            optionsGroup.Location = new Point(24, 202);
            optionsGroup.Size = new Size(632, 72);
            Controls.Add(optionsGroup);

            desktopShortcut = new CheckBox();
            desktopShortcut.Text = "创建桌面快捷方式";
            desktopShortcut.Checked = true;
            desktopShortcut.AutoSize = true;
            desktopShortcut.Location = new Point(16, 31);
            optionsGroup.Controls.Add(desktopShortcut);

            launchAfterInstall = new CheckBox();
            launchAfterInstall.Text = "安装完成后启动";
            launchAfterInstall.Checked = true;
            launchAfterInstall.AutoSize = true;
            launchAfterInstall.Location = new Point(336, 31);
            optionsGroup.Controls.Add(launchAfterInstall);

            GroupBox progressGroup = new GroupBox();
            progressGroup.Text = "安装进度";
            progressGroup.ForeColor = Color.FromArgb(51, 65, 85);
            progressGroup.Location = new Point(24, 284);
            progressGroup.Size = new Size(632, 82);
            Controls.Add(progressGroup);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(14, 24);
            progressBar.Size = new Size(604, 20);
            progressBar.Style = ProgressBarStyle.Continuous;
            progressGroup.Controls.Add(progressBar);

            statusLabel = new Label();
            statusLabel.Text = "准备安装";
            statusLabel.AutoEllipsis = true;
            statusLabel.Location = new Point(14, 48);
            statusLabel.Size = new Size(604, 22);
            statusLabel.ForeColor = Color.FromArgb(71, 85, 105);
            progressGroup.Controls.Add(statusLabel);

            installButton = new Button();
            installButton.Text = "开始安装";
            installButton.Location = new Point(448, 382);
            installButton.Size = new Size(112, 34);
            installButton.FlatStyle = FlatStyle.Flat;
            installButton.FlatAppearance.BorderSize = 0;
            installButton.BackColor = Color.FromArgb(37, 99, 235);
            installButton.ForeColor = Color.White;
            installButton.Font = new Font(Font, FontStyle.Bold);
            installButton.UseVisualStyleBackColor = false;
            installButton.Click += delegate { Install(); };
            Controls.Add(installButton);

            cancelButton = new Button();
            cancelButton.Text = "取消";
            cancelButton.Location = new Point(568, 382);
            cancelButton.Size = new Size(88, 34);
            cancelButton.Click += delegate { Close(); };
            Controls.Add(cancelButton);

            AcceptButton = installButton;
            CancelButton = cancelButton;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ApplyPathBoxMargins();
            pathBox.SelectionStart = 0;
            pathBox.SelectionLength = 0;
            pathBox.ScrollToCaret();
            ActiveControl = pathBox;
            pathBox.Focus();
        }

        private void ApplyPathBoxMargins()
        {
            int left = Math.Max(10, 10 * DeviceDpi / 96);
            int right = Math.Max(6, 6 * DeviceDpi / 96);
            int margins = (left & 0xFFFF) | (right << 16);
            SendMessage(
                pathBox.Handle,
                EmSetMargins,
                (IntPtr)(EcLeftMargin | EcRightMargin),
                (IntPtr)margins);
        }

        private void BrowseInstallPath()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "请选择 Delta Highlight 安装目录";
                dialog.ShowNewFolderButton = true;
                if (Directory.Exists(pathBox.Text))
                    dialog.SelectedPath = pathBox.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                    pathBox.Text = dialog.SelectedPath;
            }
        }

        internal bool InstallSilently(string requestedPath)
        {
            try
            {
                string installDir = ValidateInstallPath(requestedPath);
                StopRunningApplication(installDir);
                Directory.CreateDirectory(installDir);
                ExtractPayload(installDir);
                GrantCurrentUserAccess(installDir);
                CreateShortcuts(installDir, true);
                SaveInstallInfo(installDir);
                return true;
            }
            catch (Exception ex)
            {
                try
                {
                    File.WriteAllText(Path.Combine(Path.GetTempPath(), "delta-highlight-setup-error.log"), ex.ToString(), Encoding.UTF8);
                }
                catch
                {
                }
                return false;
            }
        }

        private void Install()
        {
            string installDir;
            try
            {
                installDir = ValidateInstallPath(pathBox.Text);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "路径无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            SetBusy(true);
            try
            {
                StopRunningApplication(installDir);
                statusLabel.Text = "正在创建安装目录...";
                Directory.CreateDirectory(installDir);

                statusLabel.Text = "正在释放运行环境...";
                ExtractPayload(installDir);

                statusLabel.Text = "正在设置访问权限...";
                GrantCurrentUserAccess(installDir);

                statusLabel.Text = "正在创建快捷方式...";
                CreateShortcuts(installDir, desktopShortcut.Checked);

                SaveInstallInfo(installDir);
                statusLabel.Text = "安装完成";
                progressBar.Value = 100;

                if (launchAfterInstall.Checked)
                    Process.Start(new ProcessStartInfo(Path.Combine(installDir, "DeltaHighlight.exe")) { WorkingDirectory = installDir, UseShellExecute = true });

                MessageBox.Show(
                    this,
                    "Delta Highlight 已安装完成。\r\n\r\n安装目录：" + installDir,
                    "安装完成",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                Close();
            }
            catch (Exception ex)
            {
                statusLabel.Text = "安装失败";
                MessageBox.Show(this, ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                SetBusy(false);
            }
        }

        private void ExtractPayload(string installDir)
        {
            using (Stream payload = OpenPayload())
            using (ZipArchive archive = new ZipArchive(payload, ZipArchiveMode.Read, false, Encoding.UTF8))
            {
                    string root = Path.GetFullPath(installDir);
                    string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
                    int index = 0;

                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        index++;
                        progressBar.Value = Math.Min(95, index * 95 / Math.Max(1, archive.Entries.Count));
                        statusLabel.Text = "正在释放：" + entry.FullName;
                        Application.DoEvents();

                        string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string destination = Path.GetFullPath(Path.Combine(root, relative));
                        if (!destination.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) &&
                            !string.Equals(destination, root, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new Exception("安装包包含不安全的路径：" + entry.FullName);
                        }

                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(destination);
                            continue;
                        }

                        string parent = Path.GetDirectoryName(destination);
                        if (!Directory.Exists(parent))
                            Directory.CreateDirectory(parent);

                        entry.ExtractToFile(destination, true);
                    }
                }
        }

        private static Stream OpenPayload()
        {
            string externalPath = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "DeltaHighlight-Payload.zip");
            if (File.Exists(externalPath))
                return new FileStream(externalPath, FileMode.Open, FileAccess.Read, FileShare.Read);

            FileStream executable = new FileStream(Application.ExecutablePath, FileMode.Open, FileAccess.Read, FileShare.Read);
            try
            {
                if (executable.Length < PayloadTrailerSize + 4)
                    throw new Exception("安装程序没有包含运行环境数据。");

                executable.Position = executable.Length - PayloadTrailerSize;
                byte[] trailer = new byte[PayloadTrailerSize];
                ReadExactly(executable, trailer, 0, trailer.Length);

                byte[] magic = new byte[PayloadMagic.Length];
                Buffer.BlockCopy(trailer, 0, magic, 0, magic.Length);
                if (!BytesEqual(magic, PayloadMagic))
                    throw new Exception("安装程序的数据区无效。");

                long payloadLength = BitConverter.ToInt64(trailer, PayloadMagic.Length);
                long payloadStart = executable.Length - PayloadTrailerSize - payloadLength;
                if (payloadLength <= 0 || payloadStart <= 0)
                    throw new Exception("安装程序的数据长度无效。");

                SegmentStream payload = new SegmentStream(executable, payloadStart, payloadLength);
                executable = null;
                return payload;
            }
            finally
            {
                if (executable != null)
                    executable.Dispose();
            }
        }

        private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
        {
            while (count > 0)
            {
                int read = stream.Read(buffer, offset, count);
                if (read <= 0)
                    throw new EndOfStreamException();
                offset += read;
                count -= read;
            }
        }

        private static void CreateShortcuts(string installDir, bool createDesktopShortcut)
        {
            string target = Path.Combine(installDir, "DeltaHighlight.exe");
            string uninstaller = Path.Combine(installDir, "Uninstall.exe");
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string startMenuDir = Path.Combine(programs, "Delta Highlight");

            try
            {
                if (createDesktopShortcut)
                    CreateShortcut(Path.Combine(desktop, "Delta Highlight.lnk"), target, installDir, target);
            }
            catch
            {
            }

            try
            {
                Directory.CreateDirectory(startMenuDir);
                CreateShortcut(Path.Combine(startMenuDir, "Delta Highlight.lnk"), target, installDir, target);
                CreateShortcut(Path.Combine(startMenuDir, "卸载 Delta Highlight.lnk"), uninstaller, installDir, uninstaller);
            }
            catch
            {
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string iconPath)
        {
            string script =
                "$w=New-Object -ComObject WScript.Shell;" +
                "$s=$w.CreateShortcut('" + EscapePowerShell(shortcutPath) + "');" +
                "$s.TargetPath='" + EscapePowerShell(targetPath) + "';" +
                "$s.WorkingDirectory='" + EscapePowerShell(workingDirectory) + "';" +
                "$s.IconLocation='" + EscapePowerShell(iconPath) + ",0';" +
                "$s.Save();";

            string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            RunHidden("powershell.exe", "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + encoded);
        }

        private static void SaveInstallInfo(string installDir)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\DeltaHighlight"))
                {
                    key.SetValue("InstallDir", installDir);
            key.SetValue("Version", "2.0.9");
                }

                string uninstallString = "\"" + Path.Combine(installDir, "Uninstall.exe") + "\"";
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\DeltaHighlight"))
                {
                    key.SetValue("DisplayName", "Delta Highlight");
                key.SetValue("DisplayVersion", "2.0.9");
                    key.SetValue("InstallLocation", installDir);
                    key.SetValue("UninstallString", uninstallString);
                    key.SetValue("Publisher", "Delta Highlight");
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                }
            }
            catch
            {
            }
        }

        private static void GrantCurrentUserAccess(string installDir)
        {
            string identity = WindowsIdentity.GetCurrent().Name;
            RunHidden("icacls.exe", "\"" + installDir + "\" /grant \"" + identity + ":(OI)(CI)F\" /T /C /Q");
        }

        private static void StopRunningApplication(string installDir)
        {
            string pidFile = Path.Combine(installDir, "logs", "launcher.pid");
            if (File.Exists(pidFile))
            {
                string text = File.ReadAllText(pidFile).Trim();
                int processId;
                if (int.TryParse(text, out processId))
                {
                    try
                    {
                        Process process = Process.GetProcessById(processId);
                        string executable = process.MainModule.FileName;
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

        private static string ValidateInstallPath(string requestedPath)
        {
            if (string.IsNullOrWhiteSpace(requestedPath))
                throw new Exception("请输入安装目录。");

            string fullPath = Path.GetFullPath(requestedPath.Trim());
            string root = Path.GetPathRoot(fullPath);
            if (string.Equals(fullPath.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                throw new Exception("不能直接安装到磁盘根目录，请使用类似 D:\\DeltaHighlight 的目录。");

            return fullPath;
        }

        private static string GetDefaultInstallPath()
        {
            DriveInfo[] drives = DriveInfo.GetDrives();
            foreach (DriveInfo drive in drives)
            {
                if (drive.Name.StartsWith("D:", StringComparison.OrdinalIgnoreCase) && drive.IsReady)
                    return @"D:\DeltaHighlight";
            }

            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeltaHighlight");
        }

        private void SetBusy(bool busy)
        {
            installButton.Enabled = !busy;
            cancelButton.Enabled = !busy;
            pathBox.Enabled = !busy;
        }

        private static string EscapePowerShell(string value)
        {
            return value.Replace("'", "''");
        }

        private static bool BytesEqual(byte[] left, byte[] right)
        {
            if (left.Length != right.Length)
                return false;
            for (int i = 0; i < left.Length; i++)
            {
                if (left[i] != right[i])
                    return false;
            }
            return true;
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

    internal sealed class SegmentStream : Stream
    {
        private readonly Stream inner;
        private readonly long start;
        private readonly long length;
        private long position;

        public SegmentStream(Stream inner, long start, long length)
        {
            this.inner = inner;
            this.start = start;
            this.length = length;
            position = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }

        public override long Position
        {
            get { return position; }
            set { position = value; }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (position >= length)
                return 0;

            long remaining = length - position;
            int toRead = (int)Math.Min(count, remaining);
            inner.Position = start + position;
            int read = inner.Read(buffer, offset, toRead);
            position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long next;
            if (origin == SeekOrigin.Begin)
                next = offset;
            else if (origin == SeekOrigin.Current)
                next = position + offset;
            else
                next = length + offset;

            if (next < 0 || next > length)
                throw new IOException("Seek 超出范围。");
            position = next;
            return position;
        }

        public override void Flush()
        {
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            throw new NotSupportedException();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
