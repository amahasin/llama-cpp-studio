# package-worker.ps1 - Packages worker launcher and necessary CUDA DLLs into dist/worker-package
param(
  [string]$OutDir = "$PSScriptRoot\dist\llama-studio-worker"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Find active build in data\bin
$cfgFile = "$ScriptDir\..\..\data\config.json"
$activeVer = $null
if (Test-Path $cfgFile) {
  try {
    $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
    $activeVer = $cfg.llamaCpp.activeVersion
  } catch {}
}

$activeBin = $null
if ($activeVer) {
  $activeBin = Resolve-Path "$ScriptDir\..\..\data\bin\$activeVer" -ErrorAction SilentlyContinue
}
if (-not $activeBin) {
  $activeBin = (Get-ChildItem "$ScriptDir\..\..\data\bin" -Directory | Sort-Object Name | Select-Object -Last 1).FullName
}

Write-Host "Packaging worker from: $activeBin" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Copy scripts
Copy-Item "$PSScriptRoot\start-worker.cmd" -Destination $OutDir -Force
Copy-Item "$PSScriptRoot\start-worker.ps1" -Destination $OutDir -Force
Copy-Item "$PSScriptRoot\setup-firewall.ps1" -Destination $OutDir -Force

# Copy executables and DLLs needed for RPC
$patterns = @(
  "ggml-rpc-server.exe",
  "ggml*.dll",
  "cuda*.dll",
  "cublas*.dll",
  "libomp.dll"
)

foreach ($pat in $patterns) {
  Get-ChildItem -Path $activeBin -Filter $pat | Copy-Item -Destination $OutDir -Force
}

Write-Host "Worker package created at: $OutDir" -ForegroundColor Green
Write-Host "Copy this folder to any office PC with an RTX 3060 and run start-worker.cmd!" -ForegroundColor Cyan
