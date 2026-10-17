# setup-firewall.ps1 - Opens TCP port 50052 and UDP port 50055 for llama.cpp RPC server on Private network
param(
  [int]$Port = 50052,
  [int]$DiscoveryPort = 50055
)

$ruleNameTcp = "llama.cpp Studio RPC Worker ($Port TCP)"
$ruleNameUdp = "llama.cpp Studio Discovery Beacon ($DiscoveryPort UDP)"
Write-Host "Configuring Windows Defender Firewall for TCP $Port and UDP $DiscoveryPort..." -ForegroundColor Cyan

# Check for Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Requesting Administrator privileges..." -ForegroundColor Yellow
  Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port -DiscoveryPort $DiscoveryPort" -Verb RunAs
  exit
}

# Remove existing rules if present
Get-NetFirewallRule -DisplayName $ruleNameTcp -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName $ruleNameUdp -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

# Create inbound TCP rule for private network
New-NetFirewallRule -DisplayName $ruleNameTcp `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -Profile Private,Domain `
  -Description "Allows incoming tensor RPC requests from llama-studio master workstation."

# Create inbound UDP rule for discovery
New-NetFirewallRule -DisplayName $ruleNameUdp `
  -Direction Inbound `
  -Action Allow `
  -Protocol UDP `
  -LocalPort $DiscoveryPort `
  -Profile Private,Domain `
  -Description "Allows auto-discovery UDP beacon ping from llama-studio master workstation."

Write-Host "Success! Firewall rules added for TCP $Port and UDP $DiscoveryPort." -ForegroundColor Green
Write-Host "Worker PC is now ready for auto-discovery and clustering on private LAN." -ForegroundColor Green
Start-Sleep -Seconds 3
