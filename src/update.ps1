# src/update.ps1 - updates from GitHub releases, and starting with Windows.
#
# Dot-sourced by tray.ps1, and kept apart from it for two reasons. The release
# check and the download run in a background runspace, which has to load these
# functions on its own: a tray that stopped answering right-clicks for the
# length of a 40 MB download would be worse than no update button at all. And
# tests/update.test.js can load them without putting an icon in the
# notification area.
#
# Nothing here installs anything. The tray downloads the setup program, checks
# it against the SHA-256 the release publishes, and hands over to it; the
# setup program owns stopping the app, replacing files and starting it again.

# ---- versions and the release feed -------------------------------------------

# "v1.2.3", "1.2" or "1.2.3.4" as a [version] with every missing part 0, so
# 1.2 and 1.2.0 compare equal. A pre-release tag ("v1.3.0-beta.1") is $null:
# /releases/latest never returns one, and nothing else is offered.
function ConvertTo-StudioVersion([string]$Text) {
    if (-not $Text) { return $null }
    $m = [regex]::Match($Text.Trim(), '^[vV]?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$')
    if (-not $m.Success) { return $null }
    $parts = @()
    for ($i = 1; $i -le 4; $i++) {
        $parts += if ($m.Groups[$i].Success) { [int]$m.Groups[$i].Value } else { 0 }
    }
    return New-Object System.Version($parts[0], $parts[1], $parts[2], $parts[3])
}

# Whether $Latest is a newer release than $Current. Anything unparseable is
# "no": an update is only ever offered for a version that is provably newer.
function Test-UpdateAvailable([string]$Current, [string]$Latest) {
    $c = ConvertTo-StudioVersion $Current
    $l = ConvertTo-StudioVersion $Latest
    if ($null -eq $c -or $null -eq $l) { return $false }
    return $l -gt $c
}

# "owner/name" from package.json's repository field, or $null. The release
# feed is whatever the app was built from: a fork publishes its own releases
# without touching this file.
function Get-UpdateRepository($Package) {
    if ($null -eq $Package -or $null -eq $Package.repository) { return $null }
    $url = if ($Package.repository -is [string]) { $Package.repository } else { [string]$Package.repository.url }
    if (-not $url) { return $null }
    $m = [regex]::Match($url, 'github\.com[/:]([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]+?)(?:\.git)?/?$')
    if (-not $m.Success) { return $null }
    return $m.Groups[1].Value + '/' + $m.Groups[2].Value
}

# The setup program among a release's assets. The name and the URL are both
# pinned: the name becomes a file in %TEMP%, and the URL must be this
# repository's own release download, not wherever an asset record points.
function Select-SetupAsset($Release, [string]$Repo) {
    $prefix = 'https://github.com/' + $Repo + '/releases/download/'
    foreach ($asset in @($Release.assets)) {
        if ($null -eq $asset) { continue }
        $name = [string]$asset.name
        $url = [string]$asset.browser_download_url
        if ($name -match '^[A-Za-z0-9._-]+-setup\.exe$' -and $url.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            return $asset
        }
    }
    return $null
}

# GitHub records a digest for every uploaded asset ("sha256:<hex>").
function Get-DigestSha256([string]$Digest) {
    if ($Digest -match '^sha256:([0-9a-fA-F]{64})$') { return $Matches[1].ToLowerInvariant() }
    return $null
}

# The hash for $Name in a SHA256SUMS file (`<hex>  <name>` or `<hex> *<name>`),
# the fallback for a release whose assets predate GitHub's digests.
function Find-Sha256InSums([string]$Sums, [string]$Name) {
    foreach ($line in ($Sums -split "`r?`n")) {
        $m = [regex]::Match($line, '^([0-9a-fA-F]{64}) [ *](.+?)\s*$')
        if ($m.Success -and $m.Groups[2].Value -eq $Name) { return $m.Groups[1].Value.ToLowerInvariant() }
    }
    return $null
}

function Enable-Tls12 {
    # Windows PowerShell 5.1 can still default to TLS 1.0, which GitHub refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

# The newest published release, reduced to what the tray needs. Throws with a
# sentence fit for a balloon tip when there is nothing usable.
function Get-LatestRelease([string]$Repo, [string]$UserAgent) {
    $ErrorActionPreference = 'Stop'
    Enable-Tls12
    try {
        $release = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $Repo + '/releases/latest') `
            -UserAgent $UserAgent -TimeoutSec 20
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        if ($status -eq 404) { throw 'No release of llama.cpp Studio has been published yet.' }
        if ($status -eq 403 -or $status -eq 429) { throw 'GitHub is rate-limiting update checks right now. Try again in an hour.' }
        throw ('Could not reach GitHub: ' + $_.Exception.Message)
    }

    $asset = Select-SetupAsset $release $Repo
    $sums = @($release.assets) | Where-Object { $_ -and [string]$_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
    $version = ConvertTo-StudioVersion ([string]$release.tag_name)

    return [pscustomobject]@{
        Tag       = [string]$release.tag_name
        Version   = if ($version) { '{0}.{1}.{2}' -f $version.Major, $version.Minor, $version.Build } else { $null }
        Url       = [string]$release.html_url
        Notes     = [string]$release.body
        AssetName = if ($asset) { [string]$asset.name } else { $null }
        AssetUrl  = if ($asset) { [string]$asset.browser_download_url } else { $null }
        AssetSize = if ($asset) { [long]$asset.size } else { 0 }
        Sha256    = if ($asset) { Get-DigestSha256 ([string]$asset.digest) } else { $null }
        SumsUrl   = if ($sums) { [string]$sums.browser_download_url } else { $null }
    }
}

# Download the setup program into $Directory and prove it is the published
# file. Returns its path. A file that does not match is deleted, never run.
function Save-ReleaseAsset {
    param(
        [string]$Url, [string]$Name, [long]$Size, [string]$Sha256, [string]$SumsUrl,
        [string]$UserAgent, [string]$Directory
    )
    $ErrorActionPreference = 'Stop'
    Enable-Tls12
    if ($Name -notmatch '^[A-Za-z0-9._-]+-setup\.exe$') { throw 'The release offers no setup program.' }

    $client = New-Object System.Net.WebClient
    $client.Headers['User-Agent'] = $UserAgent
    try {
        if (-not $Sha256 -and $SumsUrl) { $Sha256 = Find-Sha256InSums ($client.DownloadString($SumsUrl)) $Name }
        if (-not $Sha256) { throw ('The release publishes no checksum for ' + $Name + ', so it was not installed.') }

        New-Item -ItemType Directory -Force -Path $Directory | Out-Null
        $target = Join-Path $Directory $Name
        $partial = $target + '.partial'
        $client.DownloadFile($Url, $partial)
    } finally {
        $client.Dispose()
    }

    $length = (Get-Item -LiteralPath $partial).Length
    if ($Size -gt 0 -and $length -ne $Size) {
        Remove-Item -LiteralPath $partial -Force
        throw ('The download stopped short (' + $length + ' of ' + $Size + ' bytes). Nothing was installed.')
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
        Remove-Item -LiteralPath $partial -Force
        throw 'The download does not match the checksum published with the release. It was deleted and nothing was installed.'
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
    return $target
}

# ---- one instance per folder -------------------------------------------------

# Names the mutex and events that tie a running tray to the folder it runs
# from. installer/Setup.cs computes the same key from the folder it installs
# to, which is how setup asks a running copy to close before replacing it:
# change one, change the other.
function Get-InstanceKey([string]$Dir) {
    $norm = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\').ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($norm)) } finally { $sha.Dispose() }
    return -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
}

# ---- starting with Windows ---------------------------------------------------

$StudioRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$StudioApprovedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$StudioRunValue = 'llama.cpp Studio'

# What sign-in runs. The installed copy has llama-studio.exe, which starts the
# tray with no console window at all; a source checkout falls back to
# PowerShell, which flashes one briefly. --background / -NoBrowser: signing in
# should bring the server up, not throw a browser tab at you.
function Get-AutostartCommand([string]$AppRoot) {
    $launcher = Join-Path $AppRoot 'llama-studio.exe'
    if (Test-Path -LiteralPath $launcher) { return '"' + $launcher + '" --background' }
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $tray = Join-Path $AppRoot 'src\tray.ps1'
    return '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $tray + '" -NoBrowser'
}

# 'on', 'off', 'other' (the entry starts a different copy) or 'blocked' (the
# entry is there but switched off under Settings > Apps > Startup, which
# Windows records separately and honours over the Run key).
function Get-AutostartState {
    param([string]$AppRoot, [string]$RunKey = $StudioRunKey, [string]$ApprovedKey = $StudioApprovedKey)
    $value = $null
    try { $value = (Get-ItemProperty -LiteralPath $RunKey -Name $StudioRunValue -ErrorAction Stop).$StudioRunValue } catch {}
    if (-not $value) { return 'off' }
    if ($value -ne (Get-AutostartCommand $AppRoot)) { return 'other' }
    try {
        $approved = (Get-ItemProperty -LiteralPath $ApprovedKey -Name $StudioRunValue -ErrorAction Stop).$StudioRunValue
        # First byte 2 is enabled, 3 is disabled; Windows only ever sets odd to mean off.
        if ($approved -and $approved.Length -gt 0 -and ($approved[0] -band 1) -eq 1) { return 'blocked' }
    } catch {}
    return 'on'
}

function Set-Autostart {
    param([string]$AppRoot, [bool]$Enabled, [string]$RunKey = $StudioRunKey, [string]$ApprovedKey = $StudioApprovedKey)
    if ($Enabled) {
        if (-not (Test-Path -LiteralPath $RunKey)) { New-Item -Path $RunKey -Force | Out-Null }
        Set-ItemProperty -LiteralPath $RunKey -Name $StudioRunValue -Value (Get-AutostartCommand $AppRoot) -ErrorAction Stop
        # Turning it on here should win over an earlier "off" in Settings.
        Remove-ItemProperty -LiteralPath $ApprovedKey -Name $StudioRunValue -ErrorAction SilentlyContinue
    } else {
        Remove-ItemProperty -LiteralPath $RunKey -Name $StudioRunValue -ErrorAction SilentlyContinue
        Remove-ItemProperty -LiteralPath $ApprovedKey -Name $StudioRunValue -ErrorAction SilentlyContinue
    }
}
