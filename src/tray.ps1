# src/tray.ps1 - llama.cpp Studio Windows System Tray Companion
# Keeps llama.cpp Studio and the router running in the background even if the console is closed.

param(
    [switch]$NoBrowser,
    [string]$Port = "8770",
    [string]$HostAddr = "127.0.0.1"
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Resolve-Path (Join-Path $ScriptDir "..")

# Where the backend says it ended up. The tray used to assume it got $Port,
# sleep 800ms and open a browser regardless: if the port was taken the tray
# pointed at whatever else owned it, and on a cold start (config load, then a
# CIM hardware probe) 800ms was routinely too early either way. main.js writes
# this file once it is actually listening, and deletes it when it stops.
$EndpointFile = Join-Path $env:TEMP ("llama-studio-" + [guid]::NewGuid().ToString("N") + ".json")

# How long to wait for the backend to come up before giving up on it.
$StartupTimeoutSec = 90

function Get-NodeExe {
    $bundled = Join-Path $AppRoot "runtime\node.exe"
    if (Test-Path $bundled) { return $bundled }
    return "node"
}

# Start the backend and wait for it to publish its endpoint. Returns
# @{ proc; url } or $null. `PortArg` of 0 lets the OS pick a free port.
function Start-Backend([string]$PortArg) {
    if (Test-Path $EndpointFile) { Remove-Item $EndpointFile -Force -ErrorAction SilentlyContinue }

    $mainJs = Join-Path $ScriptDir "main.js"
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-NodeExe)
    $startInfo.Arguments = "`"$mainJs`" --port $PortArg --host $HostAddr --no-open --endpoint-file `"$EndpointFile`""
    $startInfo.WorkingDirectory = $AppRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    # Held open for the life of the tray: closing it is how Exit asks for a
    # clean shutdown, so llama-server releases its VRAM before we go.
    $startInfo.RedirectStandardInput = $true

    $proc = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $proc) { return $null }

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) { return $null }
        if (Test-Path $EndpointFile) {
            try {
                $info = Get-Content -Raw -LiteralPath $EndpointFile | ConvertFrom-Json
                if ($info.url) { return @{ proc = $proc; url = [string]$info.url } }
            } catch {
                # Written but not yet flushed — look again on the next tick.
            }
        }
        Start-Sleep -Milliseconds 200
    }

    # Never came up. Do not leave it running behind the tray.
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    return $null
}

# 1. Is one already running on the usual port? If so, just attach to it.
$NodeProcess = $null
$WebUrl = "http://${HostAddr}:${Port}/"
$IsRunning = $false

try {
    $resp = Invoke-RestMethod -Uri "${WebUrl}api/health" -TimeoutSec 1 -ErrorAction SilentlyContinue
    if ($resp.ok -eq $true) { $IsRunning = $true }
} catch {}

if (-not $IsRunning) {
    # Preferred port first, so the URL stays the familiar one. If that fails —
    # most often because something else holds it — let the OS choose instead of
    # showing a tray icon for a server that never started.
    $started = Start-Backend $Port
    if ($null -eq $started) { $started = Start-Backend "0" }

    if ($null -eq $started) {
        [System.Windows.Forms.MessageBox]::Show(
            "llama.cpp Studio could not start.`n`nRun start.cmd --console to see why.",
            "llama.cpp Studio", 'OK', 'Error') | Out-Null
        exit 1
    }

    $NodeProcess = $started.proc
    $WebUrl = $started.url
}

if (-not $NoBrowser) {
    Start-Process $WebUrl
}

# 2. Build the System Tray Icon
#
# The mark is a llama in profile — the same geometry as web/icon.svg and the
# sidebar mark inside the app, drawn here with GDI+ because the tray wants an
# Icon, not an SVG. It replaces a "🦙" drawn as text, which depended on an
# emoji font being present and rendered as a hollow box where it was not.
#
# Coordinates are the SVG path's, in its 64x64 space, scaled at the end.

function New-LlamaPath {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    # Back of the neck, rising into the head.
    $p.AddBezier(23, 57, 23, 45, 25, 35, 30, 29)
    $p.AddBezier(30, 29, 32, 25, 32.5, 22, 33, 19)
    # Rear ear.
    $p.AddLine(33, 19, 31.2, 10)
    $p.AddBezier(31.2, 10, 30.6, 5, 35.2, 4.4, 36.2, 9.4)
    $p.AddLine(36.2, 9.4, 37.5, 18)
    # Between the ears, then the front ear.
    $p.AddLine(37.5, 18, 42, 17)
    $p.AddLine(42, 17, 43, 7.6)
    $p.AddBezier(43, 7.6, 43.6, 2.6, 48.2, 3.2, 48.2, 8.2)
    $p.AddLine(48.2, 8.2, 48, 19.5)
    # Head into the muzzle, and back along the jaw.
    $p.AddBezier(48, 19.5, 52.5, 21.5, 57, 24.5, 58, 28)
    $p.AddBezier(58, 28, 58.8, 30.5, 57, 33, 54, 33)
    $p.AddLine(54, 33, 45, 33.5)
    $p.AddBezier(45, 33.5, 41, 34, 38.5, 37, 38, 42)
    # Front of the neck, back down to the start.
    $p.AddLine(38, 42, 37.5, 57)
    $p.CloseFigure()
    return $p
}

function Create-AppIcon {
    # 32px is what the notification area asks for at 100% scale; GetHicon
    # downsamples cleanly for smaller, and this stays crisp on a 150% display.
    $size = 32
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # The rounded indigo tile, matching web/icon.svg.
    $indigo = [System.Drawing.Color]::FromArgb(255, 99, 102, 241)
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int]($size * 0.235)   # the SVG's rx=15 of 64
    $d = $r * 2
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc($size - $d, 0, $d, $d, 270, 90)
    $tile.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $tile.AddArc(0, $size - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $tileBrush = New-Object System.Drawing.SolidBrush($indigo)
    $g.FillPath($tileBrush, $tile)

    # The llama, fitted into the tile the same way the SVG does it.
    $llama = New-LlamaPath
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Scale($size / 64.0, $size / 64.0)
    $m.Translate(-2.1, 5.2)
    $m.Scale(0.855, 0.855)
    $llama.Transform($m)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPath($white, $llama)

    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)

    $tileBrush.Dispose(); $white.Dispose(); $tile.Dispose(); $llama.Dispose()
    $m.Dispose(); $g.Dispose()
    return $icon
}

$icon = Create-AppIcon

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $icon
$notifyIcon.Text = "llama.cpp Studio (Router Running)"
$notifyIcon.Visible = $true

# Context Menu
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$menuTitle = New-Object System.Windows.Forms.ToolStripMenuItem("llama.cpp Studio (Router Active)")
$menuTitle.Enabled = $false
$contextMenu.Items.Add($menuTitle) | Out-Null
$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$openUiItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Web UI")
$openUiItem.Font = New-Object System.Drawing.Font($openUiItem.Font, [System.Drawing.FontStyle]::Bold)
$openUiItem.add_Click({
    Start-Process $WebUrl
})
$contextMenu.Items.Add($openUiItem) | Out-Null

$openModelsItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Models Folder")
$openModelsItem.add_Click({
    $modelsPath = Join-Path $AppRoot "data\models"
    if (-not (Test-Path $modelsPath)) { New-Item -ItemType Directory -Path $modelsPath -Force | Out-Null }
    Start-Process explorer.exe -ArgumentList "`"$modelsPath`""
})
$contextMenu.Items.Add($openModelsItem) | Out-Null

$openDataItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Data Folder")
$openDataItem.add_Click({
    $dataPath = Join-Path $AppRoot "data"
    Start-Process explorer.exe -ArgumentList "`"$dataPath`""
})
$contextMenu.Items.Add($openDataItem) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Exit llama.cpp Studio")
$exitItem.add_Click({
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()

    if ($NodeProcess -and -not $NodeProcess.HasExited) {
        try {
            $NodeProcess.StandardInput.Close()
        } catch {}
        Start-Sleep -Milliseconds 400
        if (-not $NodeProcess.HasExited) {
            try { $NodeProcess.Kill() } catch {}
        }
    } else {
        # Fallback: stop via api or find process
        try {
            Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force
        } catch {}
    }

    [System.Windows.Forms.Application]::Exit()
})
$contextMenu.Items.Add($exitItem) | Out-Null

$notifyIcon.ContextMenuStrip = $contextMenu

# Left click or double click opens Web UI
$notifyIcon.add_Click({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process $WebUrl
    }
})
$notifyIcon.add_DoubleClick({
    Start-Process $WebUrl
})

# Background monitor timer: verify Node is still running
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
    if ($NodeProcess -and $NodeProcess.HasExited) {
        $notifyIcon.Text = "llama.cpp Studio (Stopped)"
    }
})
$timer.Start()

# Run the Windows Forms message pump
[System.Windows.Forms.Application]::Run()

# Cleanup on exit
$notifyIcon.Visible = $false
$notifyIcon.Dispose()
