// installer/Setup.cs - the setup program, and (built a second time with
// /define:UNINSTALLER) the uninstaller it leaves behind.
//
// C# 5, compiled by the csc.exe inside .NET Framework 4.x, which every Windows
// 10 and 11 machine already has: building a release needs Node and Windows and
// nothing else. No Visual Studio, no WiX, no Inno Setup download.
//
// It installs per user, into %LOCALAPPDATA%\Programs\llama.cpp Studio, with no
// UAC prompt. The app keeps its models, llama.cpp builds and settings in a data
// folder beside itself, and under Program Files that folder would not be
// writable without administrator rights. installer/app.manifest says
// asInvoker, which also stops Windows auto-elevating an exe called "setup".
//
//   setup.exe                                    the setup window
//   setup.exe /S [/dir=PATH] [/autostart=0|1] [/desktop=0|1] [/launch]
//   setup.exe /update /dir=PATH [/waitpid=N]     what the tray's Install Update runs
//   uninstall.exe [/S]                           remove it; data only if you say so
//
// An update unpacks the new version beside the old one first, while the app
// is still running, and only then stops it and swaps the two. A download that
// is damaged or a disk that is full therefore fails before anything changes,
// and the app is down for seconds rather than for the length of the unpack.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LlamaStudio.Setup
{
    static class Product
    {
        public const string Name = "llama.cpp Studio";
        public const string Id = "llama-cpp-studio";
        public const string Launcher = "llama-studio.exe";
        public const string Uninstaller = "uninstall.exe";
        public const string ManifestFile = ".install-manifest";
        public const string StagingDir = ".setup-new";
        public const string DataDir = "data";

        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Id;
        // Must match $StudioRunKey, $StudioApprovedKey and $StudioRunValue in src\update.ps1.
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
        public const string RunValue = "llama.cpp Studio";

        public static string DefaultDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Name); }
        }

        public static string StartMenuShortcut
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Name + ".lnk"); }
        }

        public static string DesktopShortcut
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Name + ".lnk"); }
        }
    }

    /// <summary>A failure whose message is already a sentence for the user.</summary>
    sealed class InstallException : Exception
    {
        public InstallException(string message) : base(message) { }
    }

    sealed class Options
    {
        public bool Silent, Update, Uninstall, Launch, Cleanup;
        public bool? Autostart, Desktop;
        public string Dir;
        public int WaitPid;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            foreach (string raw in args)
            {
                string arg = raw.Trim();
                if (arg.StartsWith("--")) arg = "/" + arg.Substring(2);
                string key = arg;
                string value = null;
                int eq = arg.IndexOf('=');
                if (eq > 0)
                {
                    key = arg.Substring(0, eq);
                    value = arg.Substring(eq + 1).Trim().Trim('"');
                }
                switch (key.ToLowerInvariant())
                {
                    case "/s": case "/silent": case "/quiet": o.Silent = true; break;
                    case "/update": o.Update = true; o.Silent = true; break;
                    case "/uninstall": o.Uninstall = true; break;
                    case "/launch": o.Launch = true; break;
                    case "/cleanup": o.Cleanup = true; break;
                    case "/dir": o.Dir = value; break;
                    case "/autostart": o.Autostart = IsOn(value); break;
                    case "/desktop": o.Desktop = IsOn(value); break;
                    case "/waitpid":
                    {
                        int pid;
                        if (int.TryParse(value, out pid)) o.WaitPid = pid;
                        break;
                    }
                }
            }
            return o;
        }

        static bool IsOn(string value)
        {
            return value == null || !(value == "0" || value.Equals("false", StringComparison.OrdinalIgnoreCase)
                || value.Equals("no", StringComparison.OrdinalIgnoreCase));
        }
    }

    static class Paths
    {
        public static string Normalize(string dir)
        {
            string expanded = Environment.ExpandEnvironmentVariables(dir.Trim().Trim('"'));
            return Path.GetFullPath(expanded).TrimEnd('\\');
        }

        public static bool IsInside(string path, string dir)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string full;
            try { full = Path.GetFullPath(path); } catch (Exception) { return false; }
            return full.StartsWith(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        public static bool Same(string a, string b)
        {
            if (a == null || b == null) return false;
            try { return string.Equals(Normalize(a), Normalize(b), StringComparison.OrdinalIgnoreCase); }
            catch (Exception) { return false; }
        }

        /// <summary>
        /// Names the mutex and events a running tray holds for its folder.
        /// Mirrors Get-InstanceKey in src\update.ps1: change one, change both.
        /// </summary>
        public static string InstanceKey(string dir)
        {
            string norm = Path.GetFullPath(dir).TrimEnd('\\').ToLowerInvariant();
            using (var sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(norm));
                var hex = new StringBuilder();
                for (int i = 0; i < 8; i++) hex.Append(hash[i].ToString("x2"));
                return hex.ToString();
            }
        }

        /// <summary>A copy of the app: installed by this program, or unpacked by hand.</summary>
        public static bool LooksInstalled(string dir)
        {
            return File.Exists(Path.Combine(dir, Product.ManifestFile))
                || (File.Exists(Path.Combine(dir, "package.json")) && File.Exists(Path.Combine(dir, "src", "tray.ps1")));
        }

        static bool IsEmptyDir(string dir)
        {
            return !Directory.EnumerateFileSystemEntries(dir).Any();
        }

        /// <summary>Why `dir` cannot take an installation, or null when it can.</summary>
        public static string CheckTarget(string dir)
        {
            if (!Path.IsPathRooted(dir) || Path.GetPathRoot(dir).TrimEnd('\\').Length >= dir.Length)
                return "Choose a folder for llama.cpp Studio, not the root of a drive.";
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (Same(dir, windows) || IsInside(dir, windows))
                return "Choose a folder outside the Windows folder.";
            // A source checkout looks like a copy of the app, but replacing its
            // src and web folders would throw away whatever is uncommitted.
            if (Directory.Exists(Path.Combine(dir, ".git")))
                return "That folder is a git checkout of llama.cpp Studio. Update it with git pull, "
                    + "or choose another folder to install into.";
            if (Directory.Exists(dir) && !IsEmptyDir(dir) && !LooksInstalled(dir))
                return "That folder already has other files in it. Choose an empty folder, "
                    + "or one that already holds llama.cpp Studio.";

            // Prove it is writable where it will be created, without leaving a
            // folder behind when the answer is no.
            string probeDir = dir;
            while (!Directory.Exists(probeDir))
            {
                string parent = Path.GetDirectoryName(probeDir);
                if (parent == null) return "That drive does not exist.";
                probeDir = parent;
            }
            string probe = Path.Combine(probeDir, ".llama-studio-setup-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.WriteAllText(probe, "");
                File.Delete(probe);
            }
            catch (Exception)
            {
                return "Setup cannot write to " + probeDir + " without administrator rights. It installs for "
                    + "your account only, so choose a folder you own, such as the one it suggests.";
            }
            return null;
        }

        public static long DirSize(string dir, string except)
        {
            long total = 0;
            if (!Directory.Exists(dir)) return 0;
            foreach (string file in Directory.EnumerateFiles(dir))
            {
                try { total += new FileInfo(file).Length; } catch (Exception) { }
            }
            foreach (string sub in Directory.EnumerateDirectories(dir))
            {
                if (except != null && Same(sub, except)) continue;
                try
                {
                    if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) != 0) continue;
                    total += DirSize(sub, null);
                }
                catch (Exception) { }
            }
            return total;
        }

        public static string FormatSize(long bytes)
        {
            if (bytes >= 1L << 30) return (bytes / (double)(1L << 30)).ToString("0.0") + " GB";
            if (bytes >= 1L << 20) return (bytes / (double)(1L << 20)).ToString("0") + " MB";
            return Math.Max(1, bytes / 1024) + " KB";
        }
    }

    static class Files
    {
        /// <summary>
        /// A top-level name setup may delete. The manifest is a file anyone can
        /// edit, so every name read from it goes through here: nothing with a
        /// path in it, and never the data folder.
        /// </summary>
        public static bool IsSafeTopName(string name)
        {
            if (string.IsNullOrEmpty(name) || name == "." || name == "..") return false;
            if (name.IndexOfAny(new[] { '\\', '/', ':', '*', '?', '"', '<', '>', '|' }) >= 0) return false;
            return !name.Equals(Product.DataDir, StringComparison.OrdinalIgnoreCase)
                && !name.Equals(Product.StagingDir, StringComparison.OrdinalIgnoreCase)
                && !name.Equals(Product.ManifestFile, StringComparison.OrdinalIgnoreCase);
        }

        static void ClearReadOnly(string dir)
        {
            foreach (string file in Directory.EnumerateFiles(dir))
                File.SetAttributes(file, FileAttributes.Normal);
            foreach (string sub in Directory.EnumerateDirectories(dir))
            {
                if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) == 0) ClearReadOnly(sub);
            }
        }

        // A process that has just exited can hold its files for a moment
        // longer, and so can an antivirus scan of a file just written.
        static void Retry(Action action)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    action();
                    return;
                }
                catch (IOException) { if (attempt >= 20) throw; }
                catch (UnauthorizedAccessException) { if (attempt >= 20) throw; }
                Thread.Sleep(250);
            }
        }

        public static void Remove(string path)
        {
            Retry(delegate
            {
                if (Directory.Exists(path))
                {
                    ClearReadOnly(path);
                    Directory.Delete(path, true);
                }
                else if (File.Exists(path))
                {
                    File.SetAttributes(path, FileAttributes.Normal);
                    File.Delete(path);
                }
            });
        }

        public static void Move(string from, string to)
        {
            Retry(delegate
            {
                if (Directory.Exists(from)) Directory.Move(from, to);
                else File.Move(from, to);
            });
        }
    }

    /// <summary>The list of top-level names setup put in a folder: exactly what uninstall removes.</summary>
    static class Manifest
    {
        public static List<string> Read(string dir)
        {
            string file = Path.Combine(dir, Product.ManifestFile);
            if (!File.Exists(file)) return new List<string>();
            return File.ReadAllLines(file)
                .Select(line => line.Trim())
                .Where(line => !line.StartsWith("#") && Files.IsSafeTopName(line))
                .ToList();
        }

        public static void Write(string dir, IEnumerable<string> names)
        {
            var lines = new List<string>
            {
                "# Installed by llama.cpp Studio " + BuildInfo.Version + " setup. Uninstall removes exactly these;",
                "# the data folder is only removed if you say so.",
            };
            lines.AddRange(names);
            File.WriteAllLines(Path.Combine(dir, Product.ManifestFile), lines);
        }
    }

    static class Payload
    {
        static Stream Open()
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
            if (s == null) throw new InstallException("This setup program carries no application files.");
            return s;
        }

        /// <summary>Unpack into `target` (emptied first). Returns the top-level names.</summary>
        public static List<string> ExtractTo(string target, Action<int> progress)
        {
            Files.Remove(target);
            Directory.CreateDirectory(target);
            string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";
            var tops = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            byte[] buffer = new byte[1 << 16];

            using (Stream stream = Open())
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                long total = 0;
                long done = 0;
                int last = -1;
                foreach (ZipArchiveEntry entry in zip.Entries) total += entry.Length;

                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = entry.FullName.Replace('\\', '/');
                    if (name.Length == 0) continue;
                    string top = name.Split('/')[0];
                    if (!Files.IsSafeTopName(top))
                        throw new InstallException("The application files in this setup program are damaged (" + name + ").");
                    if (seen.Add(top)) tops.Add(top);

                    string dest = Path.GetFullPath(Path.Combine(target, name.Replace('/', '\\')));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new InstallException("The application files in this setup program are damaged (" + name + ").");
                    if (name.EndsWith("/"))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (Stream input = entry.Open())
                    using (var output = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        int n;
                        while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            output.Write(buffer, 0, n);
                            done += n;
                            int pct = total > 0 ? (int)(done * 100 / total) : 100;
                            if (pct != last) { last = pct; progress(pct); }
                        }
                    }
                    File.SetLastWriteTimeUtc(dest, entry.LastWriteTime.UtcDateTime);
                }
            }
            return tops;
        }
    }

    /// <summary>Getting a running copy out of the way of its own files.</summary>
    static class Running
    {
        public static void Close(string dir, int waitPid)
        {
            if (waitPid > 0)
            {
                try
                {
                    using (Process p = Process.GetProcessById(waitPid)) p.WaitForExit(30000);
                }
                catch (ArgumentException) { /* already gone */ }
                catch (InvalidOperationException) { }
            }

            // Ask the tray to close: it stops llama-server cleanly, which gives
            // the GPU memory back, and then lets go of its mutex.
            string key = Paths.InstanceKey(dir);
            EventWaitHandle quit;
            if (EventWaitHandle.TryOpenExisting(@"Local\llama.cpp-Studio-quit-" + key, out quit))
            {
                using (quit) quit.Set();
            }
            Mutex mutex;
            if (Mutex.TryOpenExisting(@"Local\llama.cpp-Studio-" + key, out mutex))
            {
                using (mutex)
                {
                    bool owned;
                    try { owned = mutex.WaitOne(30000); }
                    catch (AbandonedMutexException) { owned = true; }
                    if (owned) mutex.ReleaseMutex();
                }
            }

            // Anything still running from the folder: Node from a copy started
            // with start.cmd, or llama-server out of data\bin.
            List<Process> left = Under(dir);
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            foreach (Process p in left)
            {
                try
                {
                    int wait = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                    if (!p.WaitForExit(wait)) p.Kill();
                    p.WaitForExit(5000);
                }
                catch (Exception) { }
                finally { p.Dispose(); }
            }
        }

        static List<Process> Under(string dir)
        {
            var found = new List<Process>();
            int self = Process.GetCurrentProcess().Id;
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath FROM Win32_Process"))
                using (ManagementObjectCollection results = searcher.Get())
                {
                    foreach (ManagementObject item in results)
                    {
                        using (item)
                        {
                            string path = item["ExecutablePath"] as string;
                            if (!Paths.IsInside(path, dir)) continue;
                            int pid = Convert.ToInt32(item["ProcessId"]);
                            if (pid == self) continue;
                            try { found.Add(Process.GetProcessById(pid)); } catch (ArgumentException) { }
                        }
                    }
                }
            }
            catch (ManagementException) { }
            catch (COMException) { }
            return found;
        }
    }

    /// <summary>Shortcuts through the shell's own COM object, which every Windows has.</summary>
    static class Shortcuts
    {
        public static void Create(string lnk, string target, string workDir, string description)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            try
            {
                object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                try
                {
                    Type t = link.GetType();
                    t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
                    t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { workDir });
                    t.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { description });
                    t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { target + ",0" });
                    t.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
                }
                finally { Marshal.FinalReleaseComObject(link); }
            }
            finally { Marshal.FinalReleaseComObject(shell); }
        }

        public static bool PointsInto(string lnk, string dir)
        {
            if (!File.Exists(lnk)) return false;
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                try
                {
                    object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                    try
                    {
                        string target = link.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, link, null) as string;
                        return Paths.IsInside(target, dir);
                    }
                    finally { Marshal.FinalReleaseComObject(link); }
                }
                finally { Marshal.FinalReleaseComObject(shell); }
            }
            catch (Exception) { return false; }
        }
    }

    /// <summary>Everything outside the folder: Apps list, shortcuts, starting with Windows. All HKCU.</summary>
    static class Registration
    {
        public static string InstalledAt()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Product.UninstallKey))
            {
                string dir = key == null ? null : key.GetValue("InstallLocation") as string;
                return !string.IsNullOrEmpty(dir) && Directory.Exists(dir) ? dir : null;
            }
        }

        public static string InstalledVersion()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Product.UninstallKey))
            {
                return key == null ? null : key.GetValue("DisplayVersion") as string;
            }
        }

        // Must equal Get-AutostartCommand in src\update.ps1, or the tray's
        // "Start with Windows" tick would read an installed entry as another copy's.
        public static string AutostartCommand(string dir)
        {
            return "\"" + Path.Combine(dir, Product.Launcher) + "\" --background";
        }

        static string RunEntry()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Product.RunKey))
            {
                return key == null ? null : key.GetValue(Product.RunValue) as string;
            }
        }

        public static bool StartsWithWindows(string dir)
        {
            string entry = RunEntry();
            return entry != null && entry.IndexOf(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static bool HasDesktopShortcut(string dir)
        {
            return Shortcuts.PointsInto(Product.DesktopShortcut, dir);
        }

        static void SetAutostart(string dir, bool on)
        {
            if (on)
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Product.RunKey))
                    key.SetValue(Product.RunValue, AutostartCommand(dir));
                // An earlier "off" under Settings > Apps > Startup would otherwise win.
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Product.ApprovedKey, true))
                    if (key != null) key.DeleteValue(Product.RunValue, false);
            }
            else if (StartsWithWindows(dir))
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Product.RunKey, true))
                    if (key != null) key.DeleteValue(Product.RunValue, false);
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(Product.ApprovedKey, true))
                    if (key != null) key.DeleteValue(Product.RunValue, false);
            }
        }

        public static void Apply(string dir, Options opt)
        {
            bool registered = Paths.Same(InstalledAt(), dir);

            if (opt.Update)
            {
                // Keep a startup entry pointing at this folder current. A
                // portable copy updating itself gets nothing else: it was
                // never registered, and an update should not change that.
                if (StartsWithWindows(dir)) SetAutostart(dir, true);
                if (!registered) return;
            }

            string launcher = Path.Combine(dir, Product.Launcher);
            WriteUninstallEntry(dir);
            Shortcuts.Create(Product.StartMenuShortcut, launcher, dir, "Run llama.cpp models locally");
            if (opt.Update) return;

            if (opt.Desktop ?? true)
                Shortcuts.Create(Product.DesktopShortcut, launcher, dir, "Run llama.cpp models locally");
            else if (Shortcuts.PointsInto(Product.DesktopShortcut, dir))
                Files.Remove(Product.DesktopShortcut);

            SetAutostart(dir, opt.Autostart ?? true);
        }

        static void WriteUninstallEntry(string dir)
        {
            string uninstaller = "\"" + Path.Combine(dir, Product.Uninstaller) + "\"";
            long size = Paths.DirSize(dir, Path.Combine(dir, Product.DataDir));
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Product.UninstallKey))
            {
                key.SetValue("DisplayName", Product.Name);
                key.SetValue("DisplayVersion", BuildInfo.Version);
                key.SetValue("DisplayIcon", Path.Combine(dir, Product.Launcher) + ",0");
                key.SetValue("InstallLocation", dir);
                key.SetValue("UninstallString", uninstaller);
                key.SetValue("QuietUninstallString", uninstaller + " /S");
                key.SetValue("URLInfoAbout", BuildInfo.RepositoryUrl);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, size / 1024), RegistryValueKind.DWord);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        public static void Remove(string dir)
        {
            if (Paths.Same(InstalledAt(), dir)) Registry.CurrentUser.DeleteSubKeyTree(Product.UninstallKey, false);
            if (Shortcuts.PointsInto(Product.StartMenuShortcut, dir)) Files.Remove(Product.StartMenuShortcut);
            if (Shortcuts.PointsInto(Product.DesktopShortcut, dir)) Files.Remove(Product.DesktopShortcut);
            SetAutostart(dir, false);
        }
    }

    sealed class Installer
    {
        readonly Options opt;
        readonly Action<int, string> report;

        public Installer(Options opt, Action<int, string> report)
        {
            this.opt = opt;
            this.report = report;
        }

        public void Run(string dir)
        {
            string problem = Paths.CheckTarget(dir);
            if (problem != null) throw new InstallException(problem);
            Directory.CreateDirectory(dir);

            string staging = Path.Combine(dir, Product.StagingDir);
            report(0, "Unpacking llama.cpp Studio " + BuildInfo.Version + "...");
            List<string> tops = Payload.ExtractTo(staging, delegate (int pct)
            {
                report(pct * 80 / 100, "Unpacking llama.cpp Studio " + BuildInfo.Version + "...");
            });

            report(82, "Closing llama.cpp Studio if it is running...");
            Running.Close(dir, opt.WaitPid);

            report(88, "Replacing the previous version...");
            foreach (string name in Manifest.Read(dir).Union(tops, StringComparer.OrdinalIgnoreCase))
                Files.Remove(Path.Combine(dir, name));
            foreach (string name in tops)
                Files.Move(Path.Combine(staging, name), Path.Combine(dir, name));
            Files.Remove(staging);
            Manifest.Write(dir, tops);

            report(95, "Adding it to Windows...");
            Registration.Apply(dir, opt);
            report(100, "Done.");
        }
    }

    static class Uninstaller
    {
        public static int Run(Options opt)
        {
            string self = Application.ExecutablePath;
            string selfDir = Path.GetDirectoryName(self);
            string target = opt.Dir ?? (Paths.LooksInstalled(selfDir) ? selfDir : Registration.InstalledAt());
            if (target == null)
            {
                if (!opt.Silent) Program.Error("llama.cpp Studio is not installed for this account.");
                return 1;
            }
            string dir = Paths.Normalize(target);

            // A running exe cannot delete itself, so carry on from a copy in %TEMP%.
            if (Paths.IsInside(self, dir))
            {
                string copy = Path.Combine(Path.GetTempPath(),
                    Product.Id + "-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                File.Copy(self, copy, true);
                string args = "/uninstall /cleanup /dir=\"" + dir + "\" /waitpid=" + Process.GetCurrentProcess().Id
                    + (opt.Silent ? " /S" : "");
                var start = new ProcessStartInfo(copy, args);
                start.UseShellExecute = false;
                Process.Start(start);
                return 0;
            }

            try
            {
                return Remove(opt, dir);
            }
            finally
            {
                if (opt.Cleanup) Program.DeleteSelfLater();
            }
        }

        static int Remove(Options opt, string dir)
        {
            if (!Directory.Exists(dir) || !Paths.LooksInstalled(dir))
            {
                if (!opt.Silent) Program.Error("There is no llama.cpp Studio installation in " + dir + ".");
                return 1;
            }

            string data = Path.Combine(dir, Product.DataDir);
            bool deleteData = false;
            if (!opt.Silent)
            {
                if (MessageBox.Show("Remove llama.cpp Studio from this PC?", Product.Name,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                    return 1;
                if (Directory.Exists(data) && Directory.EnumerateFileSystemEntries(data).Any())
                {
                    string size = Paths.FormatSize(Paths.DirSize(data, null));
                    deleteData = MessageBox.Show(
                        "Also delete your models, llama.cpp builds and settings?\n\n"
                        + "They are in " + data + " (" + size + ").\n\n"
                        + "Choose No to keep them. Installing llama.cpp Studio into the same folder again picks them up.",
                        Product.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                        MessageBoxDefaultButton.Button2) == DialogResult.Yes;
                }
            }

            Action work = delegate
            {
                Running.Close(dir, opt.WaitPid);
                List<string> names = Manifest.Read(dir);
                if (names.Count == 0) names = BuildInfo.PayloadTops.ToList();
                foreach (string name in names.Where(Files.IsSafeTopName))
                    Files.Remove(Path.Combine(dir, name));
                Files.Remove(Path.Combine(dir, Product.ManifestFile));
                Files.Remove(Path.Combine(dir, Product.StagingDir));
                if (deleteData) Files.Remove(data);
                Registration.Remove(dir);
                if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
            };

            Exception failure = opt.Silent ? Program.Try(work) : BusyForm.Run("Removing llama.cpp Studio...", work);
            if (failure != null)
            {
                Program.Log(failure);
                if (!opt.Silent) Program.Error("llama.cpp Studio could not be removed completely:\n\n" + failure.Message);
                return 1;
            }
            if (!opt.Silent)
            {
                string kept = Directory.Exists(data) ? "\n\nYour models and settings are still in " + data + "." : "";
                MessageBox.Show("llama.cpp Studio has been removed." + kept, Product.Name,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return 0;
        }
    }

    /// <summary>A small window with a moving bar while work runs on another thread.</summary>
    sealed class BusyForm : Form
    {
        readonly Action work;
        Exception failure;
        bool done;

        public static Exception Run(string text, Action work)
        {
            using (var form = new BusyForm(text, work))
            {
                Application.Run(form);
                return form.failure;
            }
        }

        BusyForm(string text, Action work)
        {
            this.work = work;
            Font = new Font("Segoe UI", 9F);
            AutoScaleDimensions = new SizeF(7F, 15F);
            AutoScaleMode = AutoScaleMode.Font;
            Text = Product.Name;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(380, 96);
            Program.SetIcon(this);

            var label = new Label { Text = text, Location = new Point(20, 20), Size = new Size(340, 20) };
            var bar = new ProgressBar { Style = ProgressBarStyle.Marquee, Location = new Point(20, 50), Size = new Size(340, 14) };
            Controls.Add(label);
            Controls.Add(bar);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Program.StartWorker(delegate
            {
                failure = Program.Try(work);
                BeginInvoke((Action)delegate { done = true; Close(); });
            });
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!done) e.Cancel = true;
            base.OnFormClosing(e);
        }
    }

    sealed class SetupForm : Form
    {
        static readonly Color Accent = Color.FromArgb(0, 95, 184);
        static readonly Color Muted = Color.FromArgb(96, 96, 96);

        readonly Options opt;
        readonly TextBox dirBox = new TextBox();
        readonly Button browseButton = new Button();
        readonly CheckBox autostartBox = new CheckBox();
        readonly CheckBox desktopBox = new CheckBox();
        readonly CheckBox launchBox = new CheckBox();
        readonly Label statusLabel = new Label();
        readonly ProgressBar progress = new ProgressBar();
        readonly Button installButton = new Button();
        readonly Button cancelButton = new Button();
        bool busy;

        public SetupForm(Options opt)
        {
            this.opt = opt;
            string existing = Registration.InstalledAt();
            string dir = opt.Dir != null ? Paths.Normalize(opt.Dir) : (existing ?? Product.DefaultDir);
            bool upgrading = Paths.Same(existing, dir);
            string from = upgrading ? Registration.InstalledVersion() : null;

            SuspendLayout();
            Font = new Font("Segoe UI", 9F);
            AutoScaleDimensions = new SizeF(7F, 15F);
            AutoScaleMode = AutoScaleMode.Font;
            Text = Product.Name + " " + BuildInfo.Version + " Setup";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 388);
            BackColor = Color.White;
            Program.SetIcon(this);

            var header = new Panel { Dock = DockStyle.Top, Height = 84, BackColor = Accent };
            var mark = new PictureBox { Location = new Point(22, 18), Size = new Size(48, 48), SizeMode = PictureBoxSizeMode.Zoom };
            Icon big = Program.AppIcon(48);
            if (big != null) mark.Image = big.ToBitmap();
            var title = new Label
            {
                Text = Product.Name, ForeColor = Color.White, AutoSize = true,
                Font = new Font("Segoe UI Semibold", 15F), Location = new Point(82, 14),
            };
            var subtitle = new Label
            {
                Text = upgrading && from != null && from != BuildInfo.Version
                    ? "Updates version " + from + " to " + BuildInfo.Version
                    : "Version " + BuildInfo.Version + " \u00b7 run llama.cpp models on this PC",
                ForeColor = Color.FromArgb(220, 235, 250), AutoSize = true, Location = new Point(84, 48),
            };
            header.Controls.Add(mark);
            header.Controls.Add(title);
            header.Controls.Add(subtitle);

            var dirLabel = new Label { Text = "Install to", AutoSize = true, Location = new Point(24, 102) };
            dirBox.Text = dir;
            dirBox.Location = new Point(24, 124);
            dirBox.Size = new Size(418, 23);
            browseButton.Text = "Browse...";
            browseButton.Location = new Point(450, 123);
            browseButton.Size = new Size(86, 25);
            browseButton.Click += OnBrowse;

            var note = new Label
            {
                Text = "For your account only, so no administrator rights are needed. Models, llama.cpp builds "
                    + "and settings live in a data folder inside it, and updates keep them.",
                ForeColor = Muted, Location = new Point(24, 154), Size = new Size(512, 36),
            };

            autostartBox.Text = "Start llama.cpp Studio when I sign in to Windows";
            autostartBox.Checked = opt.Autostart ?? (upgrading ? Registration.StartsWithWindows(dir) : true);
            autostartBox.Location = new Point(24, 200);
            autostartBox.Size = new Size(512, 22);
            desktopBox.Text = "Create a desktop shortcut";
            desktopBox.Checked = opt.Desktop ?? (upgrading ? Registration.HasDesktopShortcut(dir) : true);
            desktopBox.Location = new Point(24, 226);
            desktopBox.Size = new Size(512, 22);
            launchBox.Text = "Open llama.cpp Studio when setup finishes";
            launchBox.Checked = true;
            launchBox.Location = new Point(24, 252);
            launchBox.Size = new Size(512, 22);

            statusLabel.Location = new Point(24, 286);
            statusLabel.Size = new Size(512, 20);
            statusLabel.ForeColor = Muted;
            progress.Location = new Point(24, 308);
            progress.Size = new Size(512, 10);

            var footer = new Panel { Dock = DockStyle.Bottom, Height = 56, BackColor = Color.FromArgb(243, 243, 243) };
            installButton.Text = upgrading ? "Update" : "Install";
            installButton.Location = new Point(352, 14);
            installButton.Size = new Size(88, 28);
            installButton.Click += OnInstall;
            cancelButton.Text = "Cancel";
            cancelButton.Location = new Point(448, 14);
            cancelButton.Size = new Size(88, 28);
            cancelButton.Click += delegate { Close(); };
            footer.Controls.Add(installButton);
            footer.Controls.Add(cancelButton);

            Controls.Add(header);
            Controls.Add(dirLabel);
            Controls.Add(dirBox);
            Controls.Add(browseButton);
            Controls.Add(note);
            Controls.Add(autostartBox);
            Controls.Add(desktopBox);
            Controls.Add(launchBox);
            Controls.Add(statusLabel);
            Controls.Add(progress);
            Controls.Add(footer);
            AcceptButton = installButton;
            CancelButton = cancelButton;
            // Not the path box: a stray keystroke there would replace the whole path.
            ActiveControl = installButton;
            ResumeLayout(false);
            PerformLayout();
        }

        void OnBrowse(object sender, EventArgs e)
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Choose where to install llama.cpp Studio.";
                dialog.ShowNewFolderButton = true;
                if (Directory.Exists(dirBox.Text)) dialog.SelectedPath = dirBox.Text;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string chosen = dialog.SelectedPath;
                // Picking "D:\Apps" means "in D:\Apps", as with every other installer.
                if (Directory.Exists(chosen) && Directory.EnumerateFileSystemEntries(chosen).Any()
                    && !Paths.LooksInstalled(chosen))
                    chosen = Path.Combine(chosen, Product.Name);
                dirBox.Text = chosen;
            }
        }

        void OnInstall(object sender, EventArgs e)
        {
            string dir;
            try { dir = Paths.Normalize(dirBox.Text); }
            catch (Exception) { Program.Error("\"" + dirBox.Text + "\" is not a folder path.", this); return; }
            string problem = Paths.CheckTarget(dir);
            if (problem != null) { Program.Error(problem, this); return; }

            opt.Autostart = autostartBox.Checked;
            opt.Desktop = desktopBox.Checked;
            SetBusy(true);
            Program.StartWorker(delegate
            {
                Exception failure = Program.Try(delegate { new Installer(opt, Report).Run(dir); });
                BeginInvoke((Action)delegate { Finish(dir, failure); });
            });
        }

        void Report(int pct, string text)
        {
            BeginInvoke((Action)delegate
            {
                progress.Value = Math.Max(0, Math.Min(100, pct));
                statusLabel.Text = text;
            });
        }

        void SetBusy(bool on)
        {
            busy = on;
            foreach (Control c in new Control[] { dirBox, browseButton, autostartBox, desktopBox, launchBox, installButton, cancelButton })
                c.Enabled = !on;
            UseWaitCursor = on;
        }

        void Finish(string dir, Exception failure)
        {
            SetBusy(false);
            if (failure != null)
            {
                Program.Log(failure);
                statusLabel.Text = "Setup did not finish. Nothing you had is lost.";
                Program.Error(Program.Describe(failure), this);
                return;
            }
            progress.Value = 100;
            statusLabel.Text = Product.Name + " " + BuildInfo.Version + " is installed.";
            if (launchBox.Checked)
            {
                Program.Launch(dir, null);
                Close();
                return;
            }
            installButton.Visible = false;
            cancelButton.Text = "Close";
            foreach (Control c in new Control[] { dirBox, browseButton, autostartBox, desktopBox, launchBox })
                c.Enabled = false;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (busy) e.Cancel = true;
            base.OnFormClosing(e);
        }
    }

    static class Program
    {
        static string LogFile { get { return Path.Combine(Path.GetTempPath(), Product.Id + "-setup.log"); } }

        [STAThread]
        static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Options opt = Options.Parse(args);

            // One setup or uninstall at a time. A silent one, and the copy an
            // uninstaller hands over to, wait their turn instead of failing.
            using (var gate = new Mutex(false, @"Local\llama.cpp-Studio-setup"))
            {
                bool owned;
                try { owned = gate.WaitOne(opt.Silent || opt.WaitPid > 0 ? 120000 : 0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned)
                {
                    if (!opt.Silent) Error("Setup for llama.cpp Studio is already running.");
                    return 1;
                }
                try
                {
#if UNINSTALLER
                    return Uninstaller.Run(opt);
#else
                    if (opt.Uninstall) return Uninstaller.Run(opt);
                    if (opt.Silent) return InstallSilently(opt);
                    using (var form = new SetupForm(opt)) Application.Run(form);
                    return 0;
#endif
                }
                finally
                {
                    gate.ReleaseMutex();
                }
            }
        }

        /// <summary>
        /// Work off the UI thread, in a single-threaded apartment: the shortcut
        /// code talks to the shell's COM object, which wants one.
        /// </summary>
        public static void StartWorker(ThreadStart work)
        {
            var thread = new Thread(work);
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
        }

        static int InstallSilently(Options opt)
        {
            string dir = Paths.Normalize(opt.Dir ?? Registration.InstalledAt() ?? Product.DefaultDir);
            Exception failure = Try(delegate { new Installer(opt, delegate { }).Run(dir); });
            if (failure != null)
            {
                Log(failure);
                if (opt.Update)
                {
                    Error("llama.cpp Studio could not be updated:\n\n" + Describe(failure)
                        + "\n\nThe version you had is started again.");
                    Launch(dir, "--background");
                }
                return 1;
            }
            if (opt.Update)
            {
                Launch(dir, "--background --updated");
                // The tray downloaded this into its own folder in %TEMP%.
                string self = Application.ExecutablePath;
                if (Paths.IsInside(self, Path.Combine(Path.GetTempPath(), Product.Id + "-update"))) DeleteSelfLater();
            }
            else if (opt.Launch)
            {
                Launch(dir, null);
            }
            return 0;
        }

        public static Exception Try(Action action)
        {
            try
            {
                action();
                return null;
            }
            catch (Exception e)
            {
                return e;
            }
        }

        public static string Describe(Exception e)
        {
            if (e is InstallException) return e.Message;
            if (e is UnauthorizedAccessException || e is IOException)
                return e.Message + "\n\nIf llama.cpp Studio or a model is still in use, close it and try again.";
            return e.GetType().Name + ": " + e.Message;
        }

        public static void Error(string text, IWin32Window owner = null)
        {
            MessageBox.Show(owner, text, Product.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        public static void Log(Exception e)
        {
            try
            {
                File.AppendAllText(LogFile, DateTime.Now.ToString("s") + " " + BuildInfo.Version + "\r\n" + e + "\r\n\r\n");
            }
            catch (Exception) { }
        }

        public static void Launch(string dir, string args)
        {
            string launcher = Path.Combine(dir, Product.Launcher);
            if (!File.Exists(launcher)) return;
            var start = new ProcessStartInfo(launcher, args ?? "");
            start.WorkingDirectory = dir;
            start.UseShellExecute = false;
            try { Process.Start(start); } catch (Exception e) { Log(e); }
        }

        /// <summary>
        /// Delete this exe once it has exited: a copy in %TEMP% has done its job.
        /// It retries for half a minute rather than waiting a fixed time, because
        /// a process that has used WMI and the shell's COM objects can take a
        /// few seconds to finish exiting, and a delete that comes too early fails.
        /// </summary>
        public static void DeleteSelfLater()
        {
            string self = "\"" + Application.ExecutablePath + "\"";
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /c for /l %i in (1,1,30) do (ping -n 2 127.0.0.1 >nul & del /f /q " + self
                + " >nul 2>&1 & if not exist " + self + " exit /b 0)");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            try { Process.Start(start); } catch (Exception) { }
        }

        /// <summary>The app icon at `size` pixels, or all of it (for a window) when size is 0.</summary>
        public static Icon AppIcon(int size)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
            {
                if (s == null) return null;
                try { return size > 0 ? new Icon(s, size, size) : new Icon(s); } catch (Exception) { return null; }
            }
        }

        public static void SetIcon(Form form)
        {
            Icon icon = AppIcon(0);
            if (icon != null) form.Icon = icon;
        }
    }
}
