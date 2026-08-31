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
function Create-AppIcon {
    $bmp = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(99, 102, 241)) # Indigo
    $g.FillEllipse($brush, 2, 2, 28, 28)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 1, 32, 30)
    $g.DrawString("🦙", $font, $textBrush, $rect, $sf)
    $hIcon = $bmp.GetHicon()
    return [System.Drawing.Icon]::FromHandle($hIcon)
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
