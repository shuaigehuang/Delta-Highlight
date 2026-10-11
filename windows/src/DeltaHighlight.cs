using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Delta Highlight")]
[assembly: System.Reflection.AssemblyProduct("Delta Highlight")]
[assembly: System.Reflection.AssemblyCompany("Delta Highlight")]
[assembly: System.Reflection.AssemblyVersion("2.0.9.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.0.9.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("2.0.9")]


namespace DeltaHighlight
{
    internal static class Program
    {
        internal const string ExitEventName = @"Local\DeltaHighlight.Exit.2.0.0";
        private static Mutex singleInstance;

        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length > 0 && string.Equals(args[0], "--exit", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    using (EventWaitHandle exitEvent = EventWaitHandle.OpenExisting(ExitEventName))
                        exitEvent.Set();
                }
                catch
                {
                }
                return;
            }

            bool createdNew;
            singleInstance = new Mutex(true, @"Local\DeltaHighlight.Tray.2.0.0", out createdNew);

            if (!createdNew)
            {
                OpenBrowser(GetExistingPort());
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApplicationContext());
            GC.KeepAlive(singleInstance);
        }

        internal static int GetExistingPort()
        {
            try
            {
                string configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app", "config.json");
                if (File.Exists(configPath))
                {
                    string text = File.ReadAllText(configPath, Encoding.UTF8);
                    int index = text.IndexOf("\"port\"", StringComparison.OrdinalIgnoreCase);
                    if (index >= 0)
                    {
                        index = text.IndexOf(':', index);
                        if (index >= 0)
                        {
                            int end = text.IndexOfAny(new char[] { ',', '}', '\r', '\n' }, index + 1);
                            string value = end >= 0 ? text.Substring(index + 1, end - index - 1) : text.Substring(index + 1);
                            int port;
                            if (int.TryParse(value.Trim(), out port))
                                return port;
                        }
                    }
                }
            }
            catch
            {
            }

            return 3456;
        }

        internal static void OpenBrowser(int port)
        {
            try
            {
                Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port.ToString()) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("无法打开浏览器：" + ex.Message, "Delta Highlight", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        internal static void OpenFolder(string path)
        {
            try
            {
                if (!Directory.Exists(path))
                    Directory.CreateDirectory(path);
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + path + "\"") { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show("无法打开目录：" + ex.Message, "Delta Highlight", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        internal static Icon CreateAppIcon()
        {
            Bitmap bitmap = new Bitmap(32, 32);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.FromArgb(28, 31, 34));
                using (Pen outer = new Pen(Color.FromArgb(255, 147, 33), 3))
                using (Pen inner = new Pen(Color.White, 2))
                {
                    graphics.DrawEllipse(outer, 6, 6, 20, 20);
                    graphics.DrawLine(inner, 16, 4, 16, 11);
                    graphics.DrawLine(inner, 16, 21, 16, 28);
                    graphics.DrawLine(inner, 4, 16, 11, 16);
                    graphics.DrawLine(inner, 21, 16, 28, 16);
                    graphics.FillEllipse(Brushes.White, 14, 14, 4, 4);
                }
            }

            return Icon.FromHandle(bitmap.GetHicon());
        }
    }

    internal sealed class TrayApplicationContext : ApplicationContext
    {
        private readonly string baseDir;
        private readonly string appDir;
        private readonly string outputDir;
        private readonly string materialDir;
        private readonly string logDir;
        private readonly NotifyIcon notifyIcon;
        private readonly Icon appIcon;
        private readonly EventWaitHandle exitSignal;
        private readonly System.Windows.Forms.Timer exitTimer;
        private Process serverProcess;
        private StreamWriter logWriter;
        private readonly object logLock = new object();
        private bool logClosed;
        private bool exitMonitorClosed;
        private int port;
        private bool exiting;

        public TrayApplicationContext()
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            appDir = Path.Combine(baseDir, "app");
            outputDir = Path.Combine(baseDir, "output");
            materialDir = Path.Combine(baseDir, "material");
            logDir = Path.Combine(baseDir, "logs");

            Directory.CreateDirectory(outputDir);
            Directory.CreateDirectory(materialDir);
            Directory.CreateDirectory(logDir);
            File.WriteAllText(Path.Combine(logDir, "launcher.pid"), Process.GetCurrentProcess().Id.ToString(), new UTF8Encoding(false));

            appIcon = Program.CreateAppIcon();
            ContextMenu menu = new ContextMenu();
            menu.MenuItems.Add("打开网页", delegate { Program.OpenBrowser(port); });
            menu.MenuItems.Add("打开素材文件夹", delegate { Program.OpenFolder(materialDir); });
            menu.MenuItems.Add("打开输出文件夹", delegate { Program.OpenFolder(outputDir); });
            menu.MenuItems.Add("打开日志", delegate { Program.OpenFolder(logDir); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("退出", delegate { ExitApplication(); });

            notifyIcon = new NotifyIcon();
            notifyIcon.Icon = appIcon;
            notifyIcon.Text = "Delta Highlight";
            notifyIcon.ContextMenu = menu;
            notifyIcon.Visible = true;
            notifyIcon.DoubleClick += delegate { Program.OpenBrowser(port); };

            bool exitEventCreated;
            exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ExitEventName, out exitEventCreated);
            exitTimer = new System.Windows.Forms.Timer();
            exitTimer.Interval = 500;
            exitTimer.Tick += delegate
            {
                if (exitSignal.WaitOne(0))
                    ExitApplication();
            };
            exitTimer.Start();

            try
            {
                StartServer();
            }
            catch (Exception ex)
            {
                if (logWriter != null)
                {
                    Log("[fatal] " + ex.ToString());
                    CloseLog();
                }
                try
                {
                    File.AppendAllText(
                        Path.Combine(logDir, "launcher.log"),
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [fatal] " + ex.ToString() + Environment.NewLine,
                        new UTF8Encoding(false));
                }
                catch
                {
                }
                MessageBox.Show(
                    "Delta Highlight 启动失败。\r\n\r\n" + ex.Message + "\r\n\r\n日志目录：" + logDir,
                    "启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                ExitThread();
            }
        }

        private void StartServer()
        {
            string nodePath = Path.Combine(baseDir, "runtime", "node", "node.exe");
            string pythonPath = Path.Combine(baseDir, "runtime", "python", "python.exe");
            string ffmpegPath = Path.Combine(baseDir, "runtime", "ffmpeg", "ffmpeg.exe");

            EnsureFile(nodePath, "Node.js");
            EnsureFile(pythonPath, "Python");
            EnsureFile(ffmpegPath, "ffmpeg");
            EnsureFile(Path.Combine(appDir, "src", "server.js"), "Web 服务入口");

            port = FindAvailablePort(3456);
            WriteConfig(ffmpegPath, pythonPath);

            logWriter = new StreamWriter(
                new FileStream(Path.Combine(logDir, "launcher.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                new UTF8Encoding(false));
            logWriter.AutoFlush = true;
            Log("==================================================");
            Log("启动 Delta Highlight");
            Log("安装目录: " + baseDir);
            Log("端口: " + port.ToString());

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = nodePath;
            startInfo.Arguments = "\"" + Path.Combine(appDir, "src", "server.js") + "\"";
            startInfo.WorkingDirectory = appDir;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.StandardOutputEncoding = Encoding.UTF8;
            startInfo.StandardErrorEncoding = Encoding.UTF8;

            serverProcess = new Process();
            serverProcess.StartInfo = startInfo;
            serverProcess.EnableRaisingEvents = true;
            serverProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null)
                    Log("[server] " + args.Data);
            };
            serverProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null)
                    Log("[error] " + args.Data);
            };
            serverProcess.Exited += delegate
            {
                int exitCode = -1;
                try
                {
                    exitCode = serverProcess.ExitCode;
                }
                catch
                {
                }
                Log("服务进程已退出，退出码: " + exitCode.ToString());
                if (!exiting)
                {
                    notifyIcon.BalloonTipTitle = "Delta Highlight";
                    notifyIcon.BalloonTipText = "服务已停止，请双击退出后重新启动。";
                    notifyIcon.ShowBalloonTip(5000);
                }
            };

            if (!serverProcess.Start())
                throw new Exception("无法启动服务进程。");

            serverProcess.BeginOutputReadLine();
            serverProcess.BeginErrorReadLine();

            if (!WaitForServer(90000))
            {
                StopServer();
                throw new Exception("服务启动超时，请查看日志文件。");
            }

            Log("服务启动完成: http://127.0.0.1:" + port.ToString());
            notifyIcon.BalloonTipTitle = "Delta Highlight 已启动";
            notifyIcon.BalloonTipText = "双击托盘图标即可打开网页。";
            notifyIcon.ShowBalloonTip(3000);
            Program.OpenBrowser(port);
        }

        private void WriteConfig(string ffmpegPath, string pythonPath)
        {
            string config = "{\r\n" +
                "  \"ffmpegPath\": \"" + JsonEscape(ffmpegPath) + "\",\r\n" +
                "  \"pythonPath\": \"" + JsonEscape(pythonPath) + "\",\r\n" +
                "  \"outputDir\": \"" + JsonEscape(outputDir) + "\",\r\n" +
                "  \"materialDir\": \"" + JsonEscape(materialDir) + "\",\r\n" +
                "  \"port\": " + port.ToString() + "\r\n" +
                "}";
            File.WriteAllText(Path.Combine(appDir, "config.json"), config, new UTF8Encoding(false));
        }

        private bool WaitForServer(int timeoutMilliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
            string url = "http://127.0.0.1:" + port.ToString() + "/api/config";

            while (DateTime.UtcNow < deadline)
            {
                if (serverProcess.HasExited)
                    return false;

                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Timeout = 1500;
                    request.ReadWriteTimeout = 1500;
                    request.Method = "GET";
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 300)
                            return true;
                    }
                }
                catch
                {
                }

                Thread.Sleep(500);
            }

            return false;
        }

        private static int FindAvailablePort(int startPort)
        {
            for (int candidate = startPort; candidate < startPort + 100; candidate++)
            {
                TcpListener listener = null;
                try
                {
                    listener = new TcpListener(IPAddress.Loopback, candidate);
                    listener.Start();
                    return candidate;
                }
                catch
                {
                }
                finally
                {
                    if (listener != null)
                        listener.Stop();
                }
            }

            throw new Exception("没有可用的本地端口。");
        }

        private void ExitApplication()
        {
            exiting = true;
            StopServer();
            CloseExitMonitor();
            notifyIcon.Visible = false;
            notifyIcon.Dispose();
            CloseLog();
            ExitThread();
        }

        protected override void ExitThreadCore()
        {
            exiting = true;
            StopServer();
            CloseExitMonitor();
            if (notifyIcon != null)
            {
                notifyIcon.Visible = false;
                notifyIcon.Dispose();
            }
            if (logWriter != null)
            {
                CloseLog();
            }
            base.ExitThreadCore();
        }

        private void StopServer()
        {
            if (serverProcess == null || serverProcess.HasExited)
                return;

            try
            {
                ProcessStartInfo taskKill = new ProcessStartInfo("taskkill.exe", "/PID " + serverProcess.Id.ToString() + " /T /F");
                taskKill.UseShellExecute = false;
                taskKill.CreateNoWindow = true;
                Process.Start(taskKill).WaitForExit(5000);
            }
            catch
            {
                try { serverProcess.Kill(); }
                catch { }
            }
        }

        private void Log(string message)
        {
            lock (logLock)
            {
                if (logClosed || logWriter == null)
                    return;

                try
                {
                    logWriter.WriteLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message);
                }
                catch (ObjectDisposedException)
                {
                }
                catch (IOException)
                {
                }
            }
        }

        private void CloseLog()
        {
            lock (logLock)
            {
                if (logClosed)
                    return;

                logClosed = true;
                if (logWriter != null)
                {
                    try
                    {
                        logWriter.Flush();
                        logWriter.Dispose();
                    }
                    catch
                    {
                    }
                    logWriter = null;
                }
            }
        }

        private void CloseExitMonitor()
        {
            if (exitMonitorClosed)
                return;
            exitMonitorClosed = true;

            try
            {
                if (exitTimer != null)
                {
                    exitTimer.Stop();
                    exitTimer.Dispose();
                }
                if (exitSignal != null)
                    exitSignal.Close();
            }
            catch
            {
            }
        }

        private static void EnsureFile(string path, string name)
        {
            if (!File.Exists(path))
                throw new Exception(name + " 文件缺失：" + path);
        }

        private static string JsonEscape(string value)
        {
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }
    }
}
