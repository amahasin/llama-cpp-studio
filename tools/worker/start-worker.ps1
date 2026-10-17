# start-worker.ps1 - Starts llama.cpp RPC server on an office worker PC with RTX 3060
param(
  [string]$HostAddress = "0.0.0.0",
  [int]$Port = 50052,
  [int]$DiscoveryPort = 50055,
  [switch]$NoCache
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Look for ggml-rpc-server.exe either in the same folder or in bin/ or local studio data/
$RpcExe = $null
$candidates = @(
  (Join-Path $ScriptDir "ggml-rpc-server.exe"),
  (Join-Path $ScriptDir "bin\ggml-rpc-server.exe"),
  (Join-Path $ScriptDir "..\..\data\bin\b11200\ggml-rpc-server.exe"),
  (Join-Path $ScriptDir "..\..\data\bin\*\ggml-rpc-server.exe")
)

foreach ($c in $candidates) {
  $resolved = Resolve-Path $c -ErrorAction SilentlyContinue
  if ($resolved) {
    $RpcExe = $resolved[0].Path
    break
  }
}

if (-not $RpcExe -or -not (Test-Path $RpcExe)) {
  Write-Host "Error: Could not locate ggml-rpc-server.exe." -ForegroundColor Red
  Write-Host "Please ensure ggml-rpc-server.exe and its companion CUDA DLLs are present." -ForegroundColor Yellow
  exit 1
}

$ExeDir = Split-Path -Parent $RpcExe

# Detect GPU and VRAM
$gpuName = "NVIDIA GeForce RTX 3060"
$gpuVramMiB = 12288

try {
  $smi = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
  if ($smi) {
    $parts = $smi[0].Split(',')
    if ($parts.Count -ge 2) {
      $gpuName = $parts[0].Trim()
      $gpuVramMiB = [int]($parts[1].Trim())
    }
  } else {
    $wmi = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1
    if ($wmi) {
      $gpuName = $wmi.Name
      if ($wmi.AdapterRAM -gt 0) {
        $gpuVramMiB = [math]::Round($wmi.AdapterRAM / 1MB)
      }
    }
  }
} catch {}

# Get local IP addresses for easy copy-paste
$ips = @()
try {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -notmatch '^169\.254\.' } | Select-Object -ExpandProperty IPAddress
} catch {}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "        llama.cpp Studio - Remote GPU Worker Node        " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Computer Name     : $env:COMPUTERNAME"
Write-Host "Detected GPU      : $gpuName ($gpuVramMiB MiB VRAM)" -ForegroundColor Green
Write-Host "Worker Executable : $RpcExe"
Write-Host "Binding Host      : $HostAddress"
Write-Host "Listening Port    : $Port (TCP)"
Write-Host "Discovery Beacon  : $DiscoveryPort (UDP)"
Write-Host "Cache Enabled     : $(-not $NoCache)"
Write-Host "Local LAN IP(s)   : $($ips -join ', ')" -ForegroundColor Yellow
Write-Host ""
Write-Host "-> Enter this into llama-studio Master (Server Config > Cluster):" -ForegroundColor Cyan
foreach ($ip in $ips) {
  Write-Host "   $ip`:$Port" -ForegroundColor Green
}
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Auto-discovery beacon active. Press Ctrl+C to stop worker.`n"

# Start background UDP beacon & discovery responder
$beaconScript = {
  param($Port, $DiscoveryPort, $GpuName, $GpuVramMiB)
  $endpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, $DiscoveryPort)
  $udp = $null
  try {
    $udp = New-Object System.Net.Sockets.UdpClient($endpoint)
    $udp.EnableBroadcast = $true
    $udp.Client.ReceiveTimeout = 2000
  } catch {
    return
  }

  $hostname = $env:COMPUTERNAME
  $payload = @{
    type = "llama-worker-beacon"
    hostname = $hostname
    rpcPort = $Port
    gpu = $GpuName
    vramMiB = $GpuVramMiB
  } | ConvertTo-Json -Compress

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $bcastEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Broadcast, $DiscoveryPort)

  while ($true) {
    try {
      [void]$udp.Send($bytes, $bytes.Length, $bcastEp)
    } catch {}

    $queryEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    try {
      $received = $udp.Receive([ref]$queryEp)
      $msgStr = [System.Text.Encoding]::UTF8.GetString($received)
      if ($msgStr -match 'llama-discover') {
        $pongPayload = @{
          type = "llama-worker-pong"
          hostname = $hostname
          rpcPort = $Port
          gpu = $GpuName
          vramMiB = $GpuVramMiB
        } | ConvertTo-Json -Compress
        $pongBytes = [System.Text.Encoding]::UTF8.GetBytes($pongPayload)
        [void]$udp.Send($pongBytes, $pongBytes.Length, $queryEp)
      }
    } catch [System.Net.Sockets.SocketException] {
      # Timeout expected
    } catch {
      Start-Sleep -Seconds 2
    }
  }
}

$beaconJob = $null
try {
  $beaconJob = Start-Job -ScriptBlock $beaconScript -ArgumentList $Port, $DiscoveryPort, $gpuName, $gpuVramMiB
} catch {}

$argsList = @("-H", $HostAddress, "-p", $Port)
if (-not $NoCache) {
  $argsList += "-c"
}

Push-Location $ExeDir
try {
  & $RpcExe @argsList
} finally {
  if ($beaconJob) {
    Stop-Job -Job $beaconJob -ErrorAction SilentlyContinue
    Remove-Job -Job $beaconJob -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
