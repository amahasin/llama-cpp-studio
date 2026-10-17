// installer/Launcher.cs - llama-studio.exe, the app's front door.
//
// The app is a Node server behind a tray icon, and the tray is a PowerShell
// script (src\tray.ps1). Starting that through powershell.exe directly puts a
// console window on screen, however briefly, on every launch and at every
// sign-in. This starts it with no window at all, and gives the Start menu, the
// desktop and Windows' startup list something with the app's icon to point at.
//
//   llama-studio.exe                start the app (or bring it up) and open the UI
//   llama-studio.exe --background   start it without opening a browser (sign-in)
//
// It does nothing else and exits at once: one tray per folder is the tray's
// own business, so a second launch costs one PowerShell start and nothing more.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace LlamaStudio.Setup
{
    static class Launcher
    {
        [STAThread]
        static int Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string tray = Path.Combine(root, "src", "tray.ps1");
            if (!File.Exists(tray))
            {
                MessageBox.Show("This copy of llama.cpp Studio is incomplete: src\\tray.ps1 is missing.\n\n"
                    + "Install it again from the setup program.",
                    "llama.cpp Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            var extra = new List<string>();
            foreach (string arg in args)
            {
                string a = arg.ToLowerInvariant();
                if (a == "--background" || a == "/background") extra.Add("-NoBrowser");
                else if (a == "--updated" || a == "/updated") extra.Add("-Updated");
            }

            string powershell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo(powershell,
                "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + tray + "\" "
                + string.Join(" ", extra.ToArray()));
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = root;
            try
            {
                Process.Start(start);
            }
            catch (Exception e)
            {
                MessageBox.Show("llama.cpp Studio could not start Windows PowerShell:\n\n" + e.Message,
                    "llama.cpp Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            return 0;
        }
    }
}
