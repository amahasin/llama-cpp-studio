# src/tray.ps1 - llama.cpp Studio Windows System Tray Companion
# Keeps llama.cpp Studio and the router running in the background even if the console is closed.

param(
    [switch]$NoBrowser,
    [string]$Port = "8770",
    [string]$HostAddr = "127.0.0.1",
    # Set by the setup program when it restarts the app after an update.
    [switch]$Updated
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Resolve-Path (Join-Path $ScriptDir "..")
$AppRootPath = $AppRoot.ProviderPath

. (Join-Path $ScriptDir 'update.ps1')

# One tray per folder. Starting with Windows and a click on the Start menu
# entry would otherwise give two icons for one server; the second launch hands
# its job to the first instead ("open the UI") and leaves. The same names let
# the setup program ask a running copy to close before it replaces its files.
$InstanceKey = Get-InstanceKey $AppRootPath
$InstanceMutex = New-Object System.Threading.Mutex($false, "Local\llama.cpp-Studio-$InstanceKey")
$ShowSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\llama.cpp-Studio-show-$InstanceKey")
$QuitSignal = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, "Local\llama.cpp-Studio-quit-$InstanceKey")
$OwnsInstance = $false
try {
    $OwnsInstance = $InstanceMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    # The previous tray died without letting go; the folder is ours now.
    $OwnsInstance = $true
}
if (-not $OwnsInstance) {
    if (-not $NoBrowser) { [void]$ShowSignal.Set() }
    exit 0
}

$Package = $null
try { $Package = Get-Content -Raw -LiteralPath (Join-Path $AppRootPath 'package.json') | ConvertFrom-Json } catch {}
$AppVersion = if ($Package -and $Package.version) { [string]$Package.version } else { '0.0.0' }
$UpdateRepo = Get-UpdateRepository $Package
$UserAgent = "llama-cpp-studio/$AppVersion (update check)"

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

# $State drives a small status dot in the corner: the tooltip only appears on
# hover, so the icon itself should say whether anything is actually serving.
#   running  green    starting amber    stopped grey    offline hollow
function Create-AppIcon([string]$State = 'stopped') {
    # 32px is what the notification area asks for at 100% scale; GetHicon
    # downsamples cleanly for smaller, and this stays crisp on a 150% display.
    $size = 32
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # The rounded accent-blue tile, matching web/icon.svg.
    $accent = [System.Drawing.Color]::FromArgb(255, 0, 95, 184)
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [int]($size * 0.235)   # the SVG's rx=15 of 64
    $d = $r * 2
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc($size - $d, 0, $d, $d, 270, 90)
    $tile.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $tile.AddArc(0, $size - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $tileBrush = New-Object System.Drawing.SolidBrush($accent)
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

    # The status dot, bottom-right, ringed so it reads against the tile.
    $dotColour = switch ($State) {
        'running'  { [System.Drawing.Color]::FromArgb(255, 34, 197, 94) }   # green
        'starting' { [System.Drawing.Color]::FromArgb(255, 245, 158, 11) }  # amber
        'offline'  { [System.Drawing.Color]::FromArgb(255, 120, 120, 130) } # grey
        default    { [System.Drawing.Color]::FromArgb(255, 160, 160, 172) } # stopped
    }
    $dot = [int]($size * 0.375)
    $dotX = $size - $dot - 1
    $dotY = $size - $dot - 1
    $ringBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillEllipse($ringBrush, $dotX - 1, $dotY - 1, $dot + 2, $dot + 2)
    $dotBrush = New-Object System.Drawing.SolidBrush($dotColour)
    if ($State -eq 'offline') {
        # Hollow: nothing is answering, which is not the same as "stopped".
        $pen = New-Object System.Drawing.Pen($dotColour, 2)
        $g.DrawEllipse($pen, $dotX + 1, $dotY + 1, $dot - 2, $dot - 2)
        $pen.Dispose()
    } else {
        $g.FillEllipse($dotBrush, $dotX, $dotY, $dot, $dot)
    }

    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)

    $tileBrush.Dispose(); $white.Dispose(); $tile.Dispose(); $llama.Dispose()
    $ringBrush.Dispose(); $dotBrush.Dispose(); $m.Dispose(); $g.Dispose()
    return $icon
}

# One icon per state, built once. GetHicon() hands back an unmanaged handle
# every time it is called, so building these on each poll would leak one every
# few seconds for as long as the tray is up.
$Icons = @{
    running  = Create-AppIcon 'running'
    starting = Create-AppIcon 'starting'
    stopped  = Create-AppIcon 'stopped'
    offline  = Create-AppIcon 'offline'
}

# 3. Ask the app what is actually happening
#
# The tray used to assert "Router Running" in its tooltip and its menu from the
# moment it started, and never revisit it: the only update looked at whether
# the *Node backend* had exited, which is a different question, and did not run
# at all when the tray had attached to an instance somebody else started. So it
# reported a running router whether or not one was.
#
# The token is read out of the page the app serves, which is where the browser
# gets it too — anything that can reach the port can read it, and that is by
# design; the token exists to stop other *websites* driving the app, not other
# local processes.

$script:Token = $null

function Get-SessionToken {
    if ($script:Token) { return $script:Token }
    try {
        $html = (Invoke-WebRequest -Uri $WebUrl -UseBasicParsing -TimeoutSec 2).Content
        if ($html -match 'data-llama-token="([a-f0-9]+)"') { $script:Token = $Matches[1] }
    } catch {
        $script:Token = $null
    }
    return $script:Token
}

# The llama-server lifecycle state, or $null when the app itself is unreachable.
function Get-ServerState {
    $t = Get-SessionToken
    if (-not $t) { return $null }
    try {
        $body = '{"channel":"llama.call","payload":{"method":"server.status","args":{}}}'
        $res = Invoke-RestMethod -Uri ($WebUrl + 'api/rpc') -Method Post -TimeoutSec 2 `
            -ContentType 'application/json' -Headers @{ 'X-Llama-Token' = $t } -Body $body
        if ($res.ok -ne $true) { return $null }
        return $res.server
    } catch {
        # A restarted app mints a new token; drop ours and pick it up next tick.
        $script:Token = $null
        return $null
    }
}

# Returns @{ key; label } — `key` selects the icon, `label` is the tooltip.
function Get-StatusText([object]$server) {
    if ($null -eq $server) {
        return @{ key = 'offline'; label = 'llama.cpp Studio - not running' }
    }
    $state = [string]$server.state
    $mode = [string]$server.mode
    $what = if ($mode -eq 'router') { 'Router' } else { 'Server' }

    switch ($state) {
        'RUNNING' {
            $where = if ($server.port) { " on port $($server.port)" } else { '' }
            return @{ key = 'running'; label = "llama.cpp Studio - $what running$where" }
        }
        'STARTING' { return @{ key = 'starting'; label = "llama.cpp Studio - $what starting..." } }
        'STOPPING' { return @{ key = 'starting'; label = "llama.cpp Studio - $what stopping..." } }
        'FAILED'   { return @{ key = 'stopped';  label = "llama.cpp Studio - $what failed to start" } }
        default    { return @{ key = 'stopped';  label = "llama.cpp Studio - $what stopped" } }
    }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $Icons.offline
# NotifyIcon.Text throws above 63 characters, so everything assigned to it goes
# through here.
$notifyIcon.Text = 'llama.cpp Studio - checking...'
$notifyIcon.Visible = $true

# Context Menu
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$menuTitle = New-Object System.Windows.Forms.ToolStripMenuItem('llama.cpp Studio - checking...')
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

$autostartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Start with Windows")
$autostartItem.add_Click({
    try {
        Set-Autostart -AppRoot $AppRootPath -Enabled (-not $autostartItem.Checked)
    } catch {
        Show-Balloon 'Could not change the startup setting' $_.Exception.Message 'Error'
    }
    Update-AutostartItem
})
$contextMenu.Items.Add($autostartItem) | Out-Null

$updateItem = New-Object System.Windows.Forms.ToolStripMenuItem("Check for Updates...")
$updateItem.add_Click({
    if ($script:Offer) { Confirm-Update $script:Offer } else { Start-UpdateCheck -Manual }
})
$contextMenu.Items.Add($updateItem) | Out-Null

$versionItem = New-Object System.Windows.Forms.ToolStripMenuItem("Version $AppVersion")
$versionItem.Enabled = $false
$contextMenu.Items.Add($versionItem) | Out-Null

$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Exit llama.cpp Studio")
$exitItem.add_Click({
    $notifyIcon.Visible = $false
    if ($NodeProcess) {
        Stop-Backend
    } else {
        # Attached to a copy someone else started: there is no stdin to close.
        try {
            Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force
        } catch {}
    }
    Close-Tray
})
$contextMenu.Items.Add($exitItem) | Out-Null

$contextMenu.ShowItemToolTips = $true
$contextMenu.add_Opening({ Update-AutostartItem })
$notifyIcon.ContextMenuStrip = $contextMenu

# 4. Closing, starting with Windows, and updating

# Ask the backend we started to stop, and wait for it: closing its stdin is a
# clean shutdown, which stops llama-server and gives its VRAM back. Waiting
# 400ms and then killing Node, as Exit used to, could orphan llama-server with
# a model still loaded.
function Stop-Backend([int]$TimeoutMs = 15000) {
    if (-not $NodeProcess -or $NodeProcess.HasExited) { return }
    try { $NodeProcess.StandardInput.Close() } catch {}
    if (-not $NodeProcess.WaitForExit($TimeoutMs)) {
        try { $NodeProcess.Kill() } catch {}
    }
}

function Close-Tray {
    $timer.Stop(); $signalTimer.Stop(); $updateTimer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
}

# A message box with no owner can open behind whatever has focus, which from a
# tray icon is everything. A hidden topmost form keeps it in front.
function Show-Message([string]$Text, [string]$Buttons = 'OK', [string]$Icon = 'Information') {
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = 'Manual'
    $owner.Location = New-Object System.Drawing.Point(-32000, -32000)
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Show()
    try {
        return [System.Windows.Forms.MessageBox]::Show($owner, $Text, 'llama.cpp Studio', $Buttons, $Icon)
    } finally {
        $owner.Dispose()
    }
}

# What a click on the balloon does, if anything.
$script:BalloonAction = $null

function Show-Balloon([string]$Title, [string]$Text, [string]$Icon = 'Info', [string]$Action = $null) {
    $script:BalloonAction = $Action
    if (-not $Text) { $Text = ' ' }
    if ($Text.Length -gt 250) { $Text = $Text.Substring(0, 247) + '...' }
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Text
    $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$Icon
    $notifyIcon.ShowBalloonTip(8000)
}

function Update-AutostartItem {
    $state = Get-AutostartState -AppRoot $AppRootPath
    $autostartItem.Checked = ($state -eq 'on')
    $autostartItem.ToolTipText = switch ($state) {
        'blocked' { 'Turned off under Settings > Apps > Startup. Click to turn it back on.' }
        'other'   { 'A different copy of llama.cpp Studio starts with Windows. Click to start this one instead.' }
        default   { '' }
    }
}

# Update checks and downloads run in a runspace of their own, polled from the
# UI timer: the tray never waits on the network. The runspace is handed the
# text of update.ps1 rather than its path, so the execution policy has no say.
$UpdateFunctions = [System.IO.File]::ReadAllText((Join-Path $ScriptDir 'update.ps1'))
$script:Job = $null
# A newer release the last check found, and the menu item then installs it.
$script:Offer = $null

function Start-UpdateJob([string]$Kind, [string]$Command, [hashtable]$Arguments, [bool]$Manual) {
    $ps = [powershell]::Create()
    [void]$ps.AddScript($UpdateFunctions + "`n" + '$__a = $args[1]; & $args[0] @__a')
    [void]$ps.AddArgument($Command).AddArgument($Arguments)
    $script:Job = @{ kind = $Kind; ps = $ps; handle = $ps.BeginInvoke(); manual = $Manual }
}

function Get-InnermostMessage($Exception) {
    while ($Exception.InnerException) { $Exception = $Exception.InnerException }
    return $Exception.Message
}

function Receive-UpdateJob {
    $job = $script:Job
    if (-not $job -or -not $job.handle.IsCompleted) { return }
    $script:Job = $null
    $result = $null
    $failure = $null
    try {
        $out = $job.ps.EndInvoke($job.handle)
        if ($out.Count -gt 0) { $result = $out[$out.Count - 1] }
        elseif ($job.ps.Streams.Error.Count -gt 0) { $failure = Get-InnermostMessage $job.ps.Streams.Error[0].Exception }
        else { $failure = 'No answer.' }
    } catch {
        $failure = Get-InnermostMessage $_.Exception
    } finally {
        $job.ps.Dispose()
    }
    if ($job.kind -eq 'check') { Complete-UpdateCheck $result $failure $job.manual }
    else { Complete-UpdateDownload $result $failure }
}

function Reset-UpdateItem {
    $updateItem.Enabled = $true
    if ($script:Offer) {
        $updateItem.Text = "Install Update $($script:Offer.Version)..."
    } else {
        $updateItem.Text = 'Check for Updates...'
    }
}

function Start-UpdateCheck([switch]$Manual) {
    if ($script:Job) { return }
    if (-not $UpdateRepo) {
        if ($Manual) { Show-Balloon 'Updates are not set up' 'package.json names no GitHub repository to take releases from.' 'Warning' }
        return
    }
    if ($Manual) {
        $updateItem.Enabled = $false
        $updateItem.Text = 'Checking for Updates...'
    }
    Start-UpdateJob 'check' 'Get-LatestRelease' @{ Repo = $UpdateRepo; UserAgent = $UserAgent } $Manual.IsPresent
}

function Complete-UpdateCheck($Release, [string]$Failure, [bool]$Manual) {
    if ($Failure) {
        Reset-UpdateItem
        if ($Manual) { Show-Balloon 'Could not check for updates' $Failure 'Warning' }
        return
    }
    if (-not (Test-UpdateAvailable $AppVersion $Release.Tag)) {
        $script:Offer = $null
        Reset-UpdateItem
        if ($Manual) { Show-Balloon 'llama.cpp Studio is up to date' "You have the latest version, $AppVersion." 'Info' }
        return
    }
    if (-not $Release.AssetUrl) {
        Reset-UpdateItem
        if ($Manual) {
            Show-Balloon "llama.cpp Studio $($Release.Version) is out" 'It has no setup program attached. Click to open the release page.' 'Info' "open:$($Release.Url)"
        }
        return
    }
    $script:Offer = $Release
    Reset-UpdateItem
    if ($Manual) {
        Confirm-Update $Release
    } else {
        Show-Balloon "llama.cpp Studio $($Release.Version) is available" 'Click to install it, or choose Install Update from this icon''s menu.' 'Info' 'update'
    }
}

# The first lines of the release notes, without the Markdown punctuation.
function Format-ReleaseNotes([string]$Notes) {
    if (-not $Notes) { return '' }
    $lines = @($Notes -split "`r?`n" | ForEach-Object { ($_ -replace '^\s*#+\s*', '' -replace '\*\*', '').TrimEnd() } |
        Where-Object { $_ -ne '' } | Select-Object -First 8)
    $text = $lines -join "`n"
    if ($text.Length -gt 600) { $text = $text.Substring(0, 597) + '...' }
    return $text
}

function Confirm-Update($Release) {
    if (Test-Path -LiteralPath (Join-Path $AppRootPath '.git')) {
        Show-Message ("This copy runs from a git checkout, so it is updated with git pull rather than " +
            "the setup program.`n`nVersion $($Release.Version) is at $($Release.Url)") | Out-Null
        return
    }
    $notes = Format-ReleaseNotes $Release.Notes
    if ($notes) { $notes = "`n`n$notes" }
    $text = "llama.cpp Studio $($Release.Version) is available. You have $AppVersion.$notes`n`n" +
        "Download and install it now? The app closes while it updates and starts again afterwards. " +
        "Your models and settings are kept."
    if ((Show-Message $text 'YesNo' 'Question') -ne 'Yes') { return }

    $updateItem.Enabled = $false
    $updateItem.Text = "Downloading Update $($Release.Version)..."
    Show-Balloon "Downloading llama.cpp Studio $($Release.Version)" 'It installs as soon as the download has been verified.' 'Info'
    Start-UpdateJob 'download' 'Save-ReleaseAsset' @{
        Url = $Release.AssetUrl; Name = $Release.AssetName; Size = $Release.AssetSize
        Sha256 = $Release.Sha256; SumsUrl = $Release.SumsUrl; UserAgent = $UserAgent
        Directory = (Join-Path $env:TEMP 'llama-cpp-studio-update')
    } $true
}

function Complete-UpdateDownload([string]$Setup, [string]$Failure) {
    if ($Failure -or -not $Setup -or -not (Test-Path -LiteralPath $Setup)) {
        Reset-UpdateItem
        if (-not $Failure) { $Failure = 'The download went missing.' }
        Show-Balloon 'The update was not installed' $Failure 'Error'
        return
    }
    # Setup unpacks the new version beside the old one while this keeps
    # running, then waits for this process to leave before swapping them.
    try {
        Start-Process -FilePath $Setup -ArgumentList ('/update /dir="' + $AppRootPath + '" /waitpid=' + $PID) -ErrorAction Stop
    } catch {
        Reset-UpdateItem
        Show-Balloon 'The update was not installed' (Get-InnermostMessage $_.Exception) 'Error'
        return
    }
    $notifyIcon.Visible = $false
    Stop-Backend
    Close-Tray
}

$notifyIcon.add_BalloonTipClicked({
    $action = $script:BalloonAction
    $script:BalloonAction = $null
    if ($action -eq 'update' -and $script:Offer) { Confirm-Update $script:Offer }
    elseif ($action -and $action.StartsWith('open:https://')) { Start-Process $action.Substring(5) }
})

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

# Reflect the real state, on a timer.
#
# This runs on the UI thread, so the calls inside Get-ServerState are given
# short timeouts: a tray icon that stops responding to a right-click while it
# waits on a socket is worse than one that is a few seconds out of date. When
# the backend we started has exited there is nothing to ask, and we say so
# without going near the network.
function Update-TrayStatus {
    $server = $null
    if (-not ($NodeProcess -and $NodeProcess.HasExited)) {
        $server = Get-ServerState
    }
    $status = Get-StatusText $server

    $label = $status.label
    if ($label.Length -gt 63) { $label = $label.Substring(0, 60) + '...' }
    if ($notifyIcon.Text -ne $label) { $notifyIcon.Text = $label }
    if ($menuTitle.Text -ne $status.label) { $menuTitle.Text = $status.label }

    $next = $Icons[$status.key]
    if ($next -and $notifyIcon.Icon -ne $next) { $notifyIcon.Icon = $next }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({ Update-TrayStatus })
$timer.Start()

# A second launch asking for the UI, the setup program asking us to close so
# it can replace these files, and a finished update job. Every half second:
# each check is a kernel-object poll, so this costs nothing.
$signalTimer = New-Object System.Windows.Forms.Timer
$signalTimer.Interval = 500
$signalTimer.add_Tick({
    if ($ShowSignal.WaitOne(0)) { Start-Process $WebUrl }
    if ($QuitSignal.WaitOne(0)) {
        $notifyIcon.Visible = $false
        Stop-Backend
        Close-Tray
        return
    }
    Receive-UpdateJob
})
$signalTimer.Start()

# Look for a release a few minutes after starting, then once a day. This only
# ever offers: nothing is downloaded until you say so.
$updateTimer = New-Object System.Windows.Forms.Timer
$updateTimer.Interval = 3 * 60 * 1000
$updateTimer.add_Tick({
    $updateTimer.Interval = 24 * 60 * 60 * 1000
    if (-not $script:Offer) { Start-UpdateCheck }
})
if ($UpdateRepo) { $updateTimer.Start() }

# Say something true before the first tick.
Update-TrayStatus

if ($Updated) {
    Show-Balloon 'llama.cpp Studio was updated' "You are now on version $AppVersion." 'Info'
}

# Run the Windows Forms message pump
[System.Windows.Forms.Application]::Run()

# Cleanup on exit
$notifyIcon.Visible = $false
$notifyIcon.Dispose()
try { $InstanceMutex.ReleaseMutex() } catch {}
