// exec.js — subprocess/fs execution layer. Every external process is spawned
// through the harness `subprocess` service with a structured argv array; no
// shell strings are ever assembled. Helper PowerShell scripts are embedded
// here, written into the managed scripts/ directory on first use, content-
// verified on every use, and invoked with `-File` + structured arguments.
'use strict'
;(function (LLAMA) {
  'use strict'

  const util = LLAMA.util

  const SCRIPT_SYS_INFO = [
    "param([switch]$Lite)",
    "$ErrorActionPreference = 'Stop'",
    "function Rnd($v) { if ($null -eq $v) { return $null }; $n = [double]$v; if ([double]::IsNaN($n)) { return $null }; return [math]::Round($n) }",
    "$out = @{}",
    "try {",
    "  $os = Get-CimInstance Win32_OperatingSystem",
    "  $out.os = @{ caption = [string]$os.Caption; version = [string]$os.Version; arch = [string]$os.OSArchitecture; totalVisibleMemoryKB = (Rnd $os.TotalVisibleMemorySize); freePhysicalMemoryKB = (Rnd $os.FreePhysicalMemory) }",
    "  $cs = Get-CimInstance Win32_ComputerSystem",
    "  $out.system = @{ manufacturer = [string]$cs.Manufacturer; model = [string]$cs.Model; totalPhysicalBytes = (Rnd $cs.TotalPhysicalMemory) }",
    "  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
    "  $out.cpu = @{ name = [string]$cpu.Name; vendor = [string]$cpu.Manufacturer; logicalCores = (Rnd $cpu.NumberOfLogicalProcessors); physicalCores = (Rnd $cpu.NumberOfCores); maxClockMhz = (Rnd $cpu.MaxClockSpeed) }",
    "} catch { $out.cimError = [string]$_.Exception.Message }",
    "if ([string]$os.OSArchitecture -like '*64*') { $out.cpu.arch = 'x64' } elseif ($out.cpu) { $out.cpu.arch = 'x86' }",
    "$gpuClass = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    "$regVram = @{}",
    "foreach ($k in (Get-ChildItem $gpuClass -ErrorAction SilentlyContinue)) {",
    "  try {",
    "    $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue",
    "    if ($p -and $p.DriverDesc) {",
    "      $v = $null",
    "      if ($p.'HardwareInformation.qwMemorySize') { $v = [double]$p.'HardwareInformation.qwMemorySize' }",
    "      $regVram[[string]$p.DriverDesc] = $v",
    "    }",
    "  } catch {}",
    "}",
    "$gpus = @()",
    "try {",
    "  foreach ($g in (Get-CimInstance Win32_VideoController)) {",
    "    $vram = $g.AdapterRAM",
    "    foreach ($k in $regVram.Keys) { if ([string]$g.Name -like ($k + '*')) { $vram = $regVram[$k] } }",
    "    $gpus += @{ name = [string]$g.Name; driverVersion = [string]$g.DriverVersion; vramBytes = (Rnd $vram) }",
    "  }",
    "} catch { $out.gpuError = [string]$_.Exception.Message }",
    "$out.gpus = $gpus",
    "$sys32 = [Environment]::GetFolderPath('System')",
    "$out.dlls = @{",
    "  vulkan = (Test-Path (Join-Path $sys32 'vulkan-1.dll'))",
    "  hip = (Test-Path (Join-Path $sys32 'amdhip64.dll'))",
    "  sycl = (Test-Path (Join-Path $sys32 'sycl7.dll'))",
    "}",
    "$cuda = @()",
    "foreach ($v in (Get-ChildItem 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA' -ErrorAction SilentlyContinue)) { $cuda += [string]$v.Name }",
    "$out.cudaToolkits = $cuda",
    "if (-not $Lite) {",
    "  $smi = 'C:\\Windows\\System32\\nvidia-smi.exe'",
    "  if (-not (Test-Path $smi)) { $smi = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe' }",
    "  if (Test-Path $smi) {",
    "    try {",
    "      $csv = & $smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version,utilization.gpu --format=csv,noheader,nounits 2>$null",
    "      $nv = @()",
    "      foreach ($line in $csv) {",
    "        $p = $line -split ','",
    "        if ($p.Count -ge 6) { $nv += @{ name = $p[0].Trim(); vramTotalMiB = (Rnd $p[1]); vramUsedMiB = (Rnd $p[2]); vramFreeMiB = (Rnd $p[3]); driverVersion = $p[4].Trim(); utilPercent = (Rnd $p[5]) } }",
    "      }",
    "      $out.nvidia = $nv",
    "    } catch { $out.nvidiaError = [string]$_.Exception.Message }",
    "  } else { $out.nvidia = @() }",
    "}",
    "$out | ConvertTo-Json -Depth 6 -Compress",
  ].join('\n')

  const SCRIPT_GPU = [
    "param()",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$smi = 'C:\\Windows\\System32\\nvidia-smi.exe'",
    "if (-not (Test-Path $smi)) { $smi = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe' }",
    "$out = @{ available = $false; gpus = @() }",
    "if (Test-Path $smi) {",
    "  $csv = & $smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version,utilization.gpu --format=csv,noheader,nounits 2>$null",
    "  $gpus = @()",
    "  foreach ($line in $csv) {",
    "    $p = $line -split ','",
    "    if ($p.Count -ge 6) {",
    "      $gpus += @{ name = $p[0].Trim(); vramTotalMiB = [int]$p[1]; vramUsedMiB = [int]$p[2]; vramFreeMiB = [int]$p[3]; driverVersion = $p[4].Trim(); utilPercent = [int]$p[5] }",
    "    }",
    "  }",
    "  if ($gpus.Count -gt 0) { $out.available = $true; $out.gpus = $gpus }",
    "}",
    "$out | ConvertTo-Json -Depth 4 -Compress",
  ].join('\n')

  const SCRIPT_PROC = [
    "param([int]$ProcessId)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$out = @{ found = $false }",
    "$p = Get-Process -Id $ProcessId",
    "if ($p) {",
    "  $cpu = $p.CPU",
    "  $out = @{ found = $true; cpuSeconds = [double]$cpu; workingSetBytes = [double]$p.WorkingSet64; privateBytes = [double]$p.PrivateMemorySize64; threads = $p.Threads.Count; startTimeUtc = $p.StartTime.ToUniversalTime().ToString('o') }",
    "}",
    "$os = Get-CimInstance Win32_OperatingSystem",
    "if ($os) {",
    "  $out.totalVisibleKB = [double]$os.TotalVisibleMemorySize",
    "  $out.freePhysicalKB = [double]$os.FreePhysicalMemory",
    "}",
    "$out | ConvertTo-Json -Depth 3 -Compress",
  ].join('\n')

  const SCRIPT_PORT = [
    "param([int]$Port)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen)",
    "$out = @{ port = $Port; open = ($conns.Count -gt 0); pids = @() }",
    "foreach ($c in $conns) { $out.pids += [int]$c.OwningProcess }",
    "$out | ConvertTo-Json -Compress",
  ].join('\n')

  const SCRIPT_FILE_OPS = [
    "param([string]$Op, [string]$A, [string]$B)",
    "$ErrorActionPreference = 'Stop'",
    "function Out($obj) { $obj | ConvertTo-Json -Depth 4 -Compress }",
    "try {",
    "  switch ($Op) {",
    "    'exists' { Out @{ op='exists'; path=$A; exists=(Test-Path -LiteralPath $A) } }",
    "    'size' { $i = Get-Item -LiteralPath $A; Out @{ op='size'; path=$A; size=[double]$i.Length; lastWriteUtc=$i.LastWriteTimeUtc.ToString('o') } }",
    "    'mkdir' { $null = New-Item -ItemType Directory -Force -Path $A | Out-Null; Out @{ op='mkdir'; path=$A; ok=$true } }",
    "    'move' { if (Test-Path -LiteralPath $B) { Out @{ op='move'; ok=$false; error='DEST_EXISTS'; dest=$B } } else { Move-Item -LiteralPath $A -Destination $B; Out @{ op='move'; ok=$true; dest=$B } } }",
    "    'copy' { Copy-Item -LiteralPath $A -Destination $B -Force; Out @{ op='copy'; ok=$true; dest=$B } }",
    "    'delete' { if (Test-Path -LiteralPath $A) { Remove-Item -LiteralPath $A -Recurse -Force }; Out @{ op='delete'; ok=$true; path=$A } }",
    "    'list' { $items = @(); foreach ($i in (Get-ChildItem -LiteralPath $A -Force | Sort-Object Name)) { $items += @{ name=[string]$i.Name; size=if($i.PSIsContainer){$null}else{[double]$i.Length}; isDir=[bool]$i.PSIsContainer; lastWriteUtc=$i.LastWriteTimeUtc.ToString('o') } }; Out @{ op='list'; path=$A; ok=$true; items=$items } }",
    "    'roots' {",
    "      $out = @()",
    "      foreach ($d in (Get-PSDrive -PSProvider FileSystem)) {",
    "        $free = $null; if ($d.Free -ne $null) { $free = [double]$d.Free }",
    "        $total = $null; if (($d.Free -ne $null) -and ($d.Used -ne $null)) { $total = [double]($d.Free + $d.Used) }",
    "        $out += @{ name = [string]$d.Name + ':'; path = [string]$d.Root; kind = 'drive'; freeBytes = $free; totalBytes = $total }",
    "      }",
    "      $known = @{ 'Home Directory' = 'UserProfile'; 'Desktop' = 'Desktop'; 'Documents' = 'MyDocuments' }",
    "      foreach ($label in @('Home Directory','Desktop','Documents')) {",
    "        $p = [Environment]::GetFolderPath($known[$label])",
    "        if ($p -and (Test-Path -LiteralPath $p)) { $out += @{ name = $label; path = [string]$p; kind = 'folder' } }",
    "      }",
    "      $dl = Join-Path $env:USERPROFILE 'Downloads'",
    "      if (Test-Path -LiteralPath $dl) { $out += @{ name = 'Downloads'; path = [string]$dl; kind = 'folder' } }",
    "      Out @{ op='roots'; ok=$true; roots=$out }",
    "    }",
    "    'stat' { if (Test-Path -LiteralPath $A) { $i = Get-Item -LiteralPath $A; Out @{ op='stat'; path=$A; exists=$true; isDir=[bool]$i.PSIsContainer; size=if($i.PSIsContainer){$null}else{[double]$i.Length}; lastWriteUtc=$i.LastWriteTimeUtc.ToString('o') } } else { Out @{ op='stat'; path=$A; exists=$false } } }",
    "    default { Out @{ op=$Op; ok=$false; error='UNKNOWN_OP' } }",
    "  }",
    "} catch { Out @{ op=$Op; ok=$false; error=[string]$_.Exception.Message } }",
  ].join('\n')

  const SCRIPT_FILE_HEAD = [
    "param([string]$Path, [int]$MaxBytes)",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $fs = [System.IO.File]::OpenRead($Path)",
    "  try {",
    "    $buf = New-Object byte[] $MaxBytes",
    "    $n = $fs.Read($buf, 0, $MaxBytes)",
    "    if ($n -lt $buf.Length) { $buf = $buf[0..($n-1)] }",
    "    [Convert]::ToBase64String($buf)",
    "  } finally { $fs.Dispose() }",
    "} catch { Write-Error ('HEAD_FAILED: ' + $_.Exception.Message); exit 1 }",
  ].join('\n')

  const SCRIPT_FILE_HASH = [
    "param([string]$Path, [string]$Algorithm)",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $h = Get-FileHash -LiteralPath $Path -Algorithm $Algorithm",
    "  [string]$h.Hash.ToLowerInvariant()",
    "} catch { Write-Error ('HASH_FAILED: ' + $_.Exception.Message); exit 1 }",
  ].join('\n')

  // GGUF header scanner: reads the metadata region incrementally and emits a
  // compact JSON summary. Handles multi-GB files without loading them.
  const SCRIPT_GGUF_SCAN = [
    "param([string]$Path)",
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $fs = [System.IO.File]::OpenRead($Path)",
    "  $br = New-Object System.IO.BinaryReader($fs)",
    "  function RdU32 { $br.ReadUInt32() }",
    "  function RdI32 { $br.ReadInt32() }",
    "  function RdU64 { $br.ReadUInt64() }",
    "  function RdI64 { $br.ReadInt64() }",
    "  function RdF32 { $br.ReadSingle() }",
    "  function RdF64 { $br.ReadDouble() }",
    "  function RdStr { $n = $br.ReadUInt64(); if ($n -gt 128MB) { throw 'string too long' }; $bytes = $br.ReadBytes([int]$n); [System.Text.Encoding]::UTF8.GetString($bytes) }",
    "  function RdScalar($t) {",
    "    switch ($t) {",
    "      0 { return [double]$br.ReadByte() } 1 { return [double]$br.ReadSByte() }",
    "      2 { return [double]$br.ReadUInt16() } 3 { return [double]$br.ReadInt16() }",
    "      4 { return [double]$br.ReadUInt32() } 5 { return [double]$br.ReadInt32() }",
    "      6 { return [double]$br.ReadSingle() } 7 { if ($br.ReadByte() -ne 0) { return $true } else { return $false } }",
    "      8 { return RdStr }",
    "      10 { return [double]$br.ReadUInt64() } 11 { return [double]$br.ReadInt64() }",
    "      12 { return [double]$br.ReadDouble() }",
    "      default { throw ('bad value type ' + $t) }",
    "    }",
    "  }",
    "  function RdArray($t) {",
    "    $itemType = RdU32",
    "    $len = RdU64",
    "    if ($itemType -eq 8) {",
    "      $n = 0; for ($i = 0; $i -lt $len; $i++) { $null = RdStr; $n++ }; return @{ arrayLength = $n; first = $null }",
    "    }",
    "    $size = @(1,1,2,2,4,4,4,1,0,0,8,8,8)[$itemType]",
    "    if ($size -gt 0) { $null = $br.ReadBytes([int][math]::Min($len * $size, 1GB)); return @{ arrayLength = $len; first = $null } }",
    "    for ($i = 0; $i -lt $len; $i++) { $null = RdScalar $itemType }; return @{ arrayLength = $len; first = $null }",
    "  }",
    "  function RdValue($t) {",
    "    if ($t -eq 9) { return RdArray $t }",
    "    return RdScalar $t",
    "  }",
    "  $magic = RdU32",
    "  if ($magic -ne 0x46554747) { throw ('bad magic ' + $magic) }",
    "  $version = RdU32",
    "  $tensorCount = RdU64",
    "  $kvCount = RdU64",
    "  $interesting = @('general.architecture','general.name','general.basename','general.quantization_version','general.file_type','general.parameters','general.alignment','tokenizer.ggml.model','tokenizer.ggml.tokens','tokenizer.ggml.bos_token_id','tokenizer.ggml.eos_token_id','tokenizer.chat_template','tokenizer.ggml.padding_token_id')",
    "  $kv = @{}",
    "  for ($i = 0; $i -lt $kvCount; $i++) {",
    "    $key = RdStr",
    "    $t = RdU32",
    "    $want = ($interesting -contains $key) -or ($key -like '*.context_length') -or ($key -like '*.embedding_length') -or ($key -like '*.block_count') -or ($key -like '*.attention.head_count') -or ($key -like '*.attention.head_count_kv') -or ($key -like '*.attention.key_length') -or ($key -like '*.attention.value_length')",
    "    if ($want) {",
    "      $v = RdValue $t",
    "      if ($key -eq 'tokenizer.chat_template' -and $v) { $kv[$key] = @{ chatTemplateLength = [int]$v.Length } }",
    "      elseif ($v -is [System.Collections.Hashtable] -and $v.ContainsKey('arrayLength')) { $kv[$key] = @{ arrayLength = [double]$v.arrayLength } }",
    "      else { $kv[$key] = @{ value = $v } }",
    "    } else { $null = RdValue $t }",
    "  }",
    "  $weightTensors = 0; $firstTensor = ''; $scanned = 0",
    "  try {",
    "    for ($i = 0; $i -lt $tensorCount; $i++) {",
    "      $name = RdStr",
    "      if ($i -eq 0) { $firstTensor = $name }",
    "      if ($name -like '*.weight') { $weightTensors++ }",
    "      $nDims = RdU32",
    "      $null = $br.ReadBytes([int]($nDims * 8))",
    "      $null = RdU32",
    "      $null = RdU64",
    "      $scanned++",
    "    }",
    "  } catch {}",
    "  $out = @{ ok = $true; magic = 'GGUF'; version = $version; tensorCount = [double]$tensorCount; kvCount = [double]$kvCount; kv = $kv; weightTensors = $weightTensors; firstTensor = $firstTensor; tensorsScanned = $scanned; headerBytes = [double]$fs.Position }",
    "  $out | ConvertTo-Json -Depth 5 -Compress",
    "} catch { Write-Error ('GGUF_FAILED: ' + $_.Exception.Message); exit 1 }",
    "finally { if ($fs) { $fs.Dispose() } }",
  ].join('\n')

  // Native file/folder pickers. Common dialogs need an STA apartment, which
  // Windows PowerShell already uses by default; when it does not (pwsh, or a
  // host that started MTA) the script re-launches itself with -STA. A script
  // block cannot simply be run on a hand-made thread — it has no runspace
  // there, which is why the dialog silently never appeared that way.
  const SCRIPT_PICK = [
    "param([string]$Mode, [string]$Title, [string]$Start, [string]$Filter, [string]$FileName)",
    "$ErrorActionPreference = 'Stop'",
    "if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {",
    "  $self = $MyInvocation.MyCommand.Path",
    "  $relaunch = @('-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',$self,$Mode,$Title,$Start,$Filter,$FileName)",
    "  & \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" @relaunch",
    "  exit $LASTEXITCODE",
    "}",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$picked = ''",
    "try {",
    "  if ($Mode -eq 'folder') {",
    "    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
    "    $dlg.Description = $Title",
    "    $dlg.ShowNewFolderButton = $true",
    "    if ($Start -and (Test-Path -LiteralPath $Start)) { $dlg.SelectedPath = $Start }",
    "    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dlg.SelectedPath }",
    "  } elseif ($Mode -eq 'save') {",
    "    $dlg = New-Object System.Windows.Forms.SaveFileDialog",
    "    $dlg.Title = $Title",
    "    if ($Filter) { $dlg.Filter = $Filter }",
    "    if ($FileName) { $dlg.FileName = $FileName }",
    "    if ($Start -and (Test-Path -LiteralPath $Start)) { $dlg.InitialDirectory = $Start }",
    "    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dlg.FileName }",
    "  } else {",
    "    $dlg = New-Object System.Windows.Forms.OpenFileDialog",
    "    $dlg.Title = $Title",
    "    $dlg.Multiselect = $false",
    "    if ($Filter) { $dlg.Filter = $Filter }",
    "    if ($Start) {",
    "      $startDir = $Start",
    "      if (Test-Path -LiteralPath $startDir -PathType Leaf) { $startDir = [System.IO.Path]::GetDirectoryName($startDir) }",
    "      if ($startDir -and (Test-Path -LiteralPath $startDir)) { $dlg.InitialDirectory = $startDir }",
    "    }",
    "    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $dlg.FileName }",
    "  }",
    "  @{ ok = $true; cancelled = ($picked -eq ''); path = [string]$picked } | ConvertTo-Json -Compress",
    "} catch {",
    "  @{ ok = $false; cancelled = $true; path = ''; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress",
    "}",
  ].join('\n')

  // Open Explorer at a path: files are revealed and selected, folders opened.
  const SCRIPT_REVEAL = [
    "param([string]$Path)",
    "$ErrorActionPreference = 'Stop'",
    "$out = @{ ok = $false; path = $Path }",
    "try {",
    "  if (Test-Path -LiteralPath $Path) {",
    "    $item = Get-Item -LiteralPath $Path",
    "    if ($item.PSIsContainer) { Start-Process explorer.exe -ArgumentList $item.FullName }",
    "    else { Start-Process explorer.exe -ArgumentList ('/select,' + '\"' + $item.FullName + '\"') }",
    "    $out.ok = $true",
    "  } else {",
    // Split-Path cannot combine -LiteralPath with -Parent on PS 5.1.
    "    $parent = [System.IO.Path]::GetDirectoryName($Path)",
    "    if ($parent -and (Test-Path -LiteralPath $parent)) {",
    "      Start-Process explorer.exe -ArgumentList $parent",
    "      $out.ok = $true; $out.fellBackToParent = $true",
    "    } else { $out.error = 'PATH_NOT_FOUND' }",
    "  }",
    "} catch { $out.error = [string]$_.Exception.Message }",
    "$out | ConvertTo-Json -Compress",
  ].join('\n')

  const SCRIPT_SYS_METRICS = [
    "param([int]$ProcessId = 0)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$out = @{}",
    "$cpu = Get-CimInstance Win32_Processor",
    "if ($cpu) {",
    "  $out.cpuLoadPercent = [double](($cpu | Measure-Object -Property LoadPercentage -Average).Average)",
    "  $out.logicalProcessors = [int](($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)",
    "}",
    "$os = Get-CimInstance Win32_OperatingSystem",
    "if ($os) {",
    "  $out.totalVisibleKB = [double]$os.TotalVisibleMemorySize",
    "  $out.freePhysicalKB = [double]$os.FreePhysicalMemory",
    "}",
    "if ($ProcessId -gt 0) {",
    "  $proc = Get-Process -Id $ProcessId",
    "  if ($proc) {",
    "    $out.process = @{ found = $true; cpuSeconds = [double]$proc.CPU; workingSetBytes = [double]$proc.WorkingSet64; privateBytes = [double]$proc.PrivateMemorySize64; threads = [int]$proc.Threads.Count }",
    "  } else {",
    "    $out.process = @{ found = $false }",
    "  }",
    "}",
    "$smi = 'C:\\Windows\\System32\\nvidia-smi.exe'",
    "if (-not (Test-Path $smi)) { $smi = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe' }",
    "$gpu = @{ available = $false; gpus = @() }",
    "if (Test-Path $smi) {",
    "  $csv = & $smi --query-gpu=name,memory.total,memory.used,memory.free,driver_version,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null",
    "  $gpus = @()",
    "  foreach ($line in $csv) {",
    "    $p = $line -split ','",
    "    if ($p.Count -ge 6) {",
    "      $gpus += @{ name = $p[0].Trim(); vramTotalMiB = [int]$p[1]; vramUsedMiB = [int]$p[2]; vramFreeMiB = [int]$p[3]; driverVersion = $p[4].Trim(); utilPercent = [int]$p[5] }",
    "    }",
    "  }",
    "  if ($gpus.Count -gt 0) { $gpu.available = $true; $gpu.gpus = $gpus }",
    "}",
    "$out.gpu = $gpu",
    "$out | ConvertTo-Json -Depth 6 -Compress",
  ].join('\n')

  const SCRIPTS = {
    'sys-info.ps1': SCRIPT_SYS_INFO,
    'sys-metrics.ps1': SCRIPT_SYS_METRICS,
    'gpu.ps1': SCRIPT_GPU,
    'proc.ps1': SCRIPT_PROC,
    'port.ps1': SCRIPT_PORT,
    'file-ops.ps1': SCRIPT_FILE_OPS,
    'file-head.ps1': SCRIPT_FILE_HEAD,
    'file-hash.ps1': SCRIPT_FILE_HASH,
    'gguf-scan.ps1': SCRIPT_GGUF_SCAN,
    'pick.ps1': SCRIPT_PICK,
    'reveal.ps1': SCRIPT_REVEAL,
  }

  const SYS32 = 'C:\\Windows\\System32'
  const TOOLS = {
    powershell: SYS32 + '\\WindowsPowerShell\\v1.0\\powershell.exe',
    curl: SYS32 + '\\curl.exe',
    tar: SYS32 + '\\tar.exe',
  }

  /**
   * Exec — wraps the harness subprocess + fs services.
   * deps: { subprocess, fs, timers, scriptsDir, log(text) }
   */
  function Exec(deps) {
    this.deps = deps
    this.subprocess = deps.subprocess
    this.fs = deps.fs
    this.timers = deps.timers
    this.scriptsDir = deps.scriptsDir
    this.log = deps.log || function () {}
    this._toolPresence = {}
  }

  Exec.prototype.mkdirs = async function (dir) {
    const r = await this.fileOp('mkdir', dir, '')
    return r.ok === true
  }

  Exec.prototype.ensureDir = async function (dir) {
    const st = await this.fileOp('stat', dir, '')
    if (st.exists === true) return true
    return this.mkdirs(dir)
  }

  /**
   * Run a single process to completion. Structured argv only.
   * opts: { cwd, stdoutBytes, stderrBytes, timeoutMs, env, stdinData }
   */
  Exec.prototype.run = async function (argv, opts) {
    const o = opts || {}
    const collect = (bytes) => ({ maxBytes: bytes === undefined ? 1024 * 1024 : bytes })
    const spec = {
      argv,
      cwd: o.cwd || this.deps.cwd || this.scriptsDir,
      stdio: {
        stdin: o.stdinData !== undefined ? { data: o.stdinData } : 'ignore',
        stdout: collect(o.stdoutBytes),
        stderr: collect(o.stderrBytes),
      },
      graceMs: o.graceMs || 3000,
      env: o.env,
    }
    const makeAbort = (ms) => {
      if (ms === undefined || ms <= 0) return undefined
      if (typeof AbortController !== 'function') return undefined
      const ac = new AbortController()
      this.timers.timeout(() => {
        try { ac.abort() } catch (_e) { /* noop */ }
      }, ms)
      return ac.signal
    }
    const signal = makeAbort(o.timeoutMs)
    if (signal) spec.signal = signal
    let handle
    try {
      handle = this.subprocess.spawn(spec)
    } catch (err) {
      return { spawnFailed: true, error: String(err && err.message) }
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (err) {
      return { spawnFailed: true, error: String(err && err.message) }
    }
    let stdout = ''
    let stderr = ''
    if (handle.collected.stdout) stdout = handle.collected.stdout.readFrom(0).text
    if (handle.collected.stderr) stderr = handle.collected.stderr.readFrom(0).text
    return {
      spawnFailed: false,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      timedOut: outcome.exitCode === null && outcome.signal === 'SIGTERM' && signal !== undefined,
      aborted: signal !== undefined && outcome.exitCode === null && outcome.signal !== null,
    }
  }

  /**
   * Create the helper-scripts directory with a raw PowerShell one-liner.
   * Helper scripts live in this directory, so creating it must never go
   * through file-ops.ps1 — that dependency cycle made every exec call recurse
   * forever (see tests/exec.test.js). Structured argv only; the path is
   * single-quoted with embedded single quotes doubled for PowerShell.
   * Returns true when the directory exists afterwards.
   */
  Exec.prototype._ensureScriptsDirRaw = async function () {
    const dir = this.scriptsDir
    const quoted = "'" + String(dir).replace(/'/g, "''") + "'"
    const r = await this.run(
      [TOOLS.powershell, '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
        '-Command', 'New-Item -ItemType Directory -Force -Path ' + quoted + ' | Out-Null'],
      {
        cwd: this.deps.cwd || dir,
        stdoutBytes: 64 * 1024,
        stderrBytes: 64 * 1024,
        timeoutMs: 30000,
      },
    )
    if (r.spawnFailed || r.exitCode !== 0) return false
    try {
      const target = await this.fs.resolve(dir)
      const stat = await this.fs.stat(target)
      return stat !== undefined
    } catch (_e) {
      return false
    }
  }

  /**
   * Ensure a helper script exists with matching content, then run it.
   * Returns { exitCode, stdout, stderr, spawnFailed }.
   */
  Exec.prototype.ps = async function (name, args, opts) {
    const content = SCRIPTS[name]
    if (content === undefined) {
      throw new Error('unknown helper script ' + name)
    }
    const scriptPath = util.joinPath(this.scriptsDir, name)
    try {
      // Directory presence is checked through the harness fs service, never
      // through file-ops.ps1 (which lives in this directory) — see
      // _ensureScriptsDirRaw for the cycle this avoids.
      let dirReady = false
      try {
        const dirTarget = await this.fs.resolve(this.scriptsDir)
        const dirStat = await this.fs.stat(dirTarget)
        dirReady = dirStat !== undefined
      } catch (_e) { /* resolution failure: treat as missing */ }
      if (!dirReady) {
        const made = await this._ensureScriptsDirRaw()
        if (!made) {
          return {
            spawnFailed: true,
            error: 'could not create the helper scripts directory: ' + this.scriptsDir,
          }
        }
      }
      let needWrite = true
      try {
        const target = await this.fs.resolve(scriptPath)
        const existing = await this.fs.readText(target)
        if (util.hashStr(existing) === util.hashStr(content)) needWrite = false
      } catch (_err) { /* missing or unreadable: rewrite */ }
      if (needWrite) {
        const target = await this.fs.resolve(scriptPath)
        await this.fs.writeText(target, content)
        this.log('wrote helper script ' + name)
      }
    } catch (err) {
      return {
        spawnFailed: true,
        error: 'could not prepare helper script ' + name + ': ' + String(err && err.message),
      }
    }
    const argv = [
      TOOLS.powershell, '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ].concat(args || [])
    const o = opts || {}
    return this.run(argv, {
      cwd: this.scriptsDir,
      stdoutBytes: o.stdoutBytes || 2 * 1024 * 1024,
      stderrBytes: o.stderrBytes || 256 * 1024,
      timeoutMs: o.timeoutMs,
    })
  }

  /**
   * Run a PS helper and parse its JSON stdout. Returns { ok, data, error }.
   */
  Exec.prototype.psJson = async function (name, args, opts) {
    const r = await this.ps(name, args, opts)
    if (r.spawnFailed) return { ok: false, error: r.error }
    if (r.exitCode !== 0) {
      const errLine = (r.stderr || '').split(/\r?\n/).find((l) => l.trim() !== '') || 'exit ' + r.exitCode
      return { ok: false, error: errLine.trim(), stderr: r.stderr, stdout: r.stdout }
    }
    const probe = name === 'file-head.ps1' || name === 'file-hash.ps1' ? undefined : '"'
    const jsonText = util.extractJson(r.stdout, probe)
    const data = util.tryParseJson(jsonText)
    if (data === undefined) {
      return { ok: false, error: 'helper script ' + name + ' returned non-JSON output', stdout: r.stdout, stderr: r.stderr }
    }
    return { ok: true, data }
  }

  // ---------- file operations (PowerShell-backed; binary safe) ----------

  Exec.prototype.fileOp = async function (op, a, b) {
    const r = await this.psJson('file-ops.ps1', [op, a === undefined ? '' : a, b === undefined ? '' : b])
    if (!r.ok) return { ok: false, op, error: r.error }
    if (r.data.ok !== true) return { ok: false, op, error: r.data.error || 'file operation failed', data: r.data }
    return { ok: true, op, data: r.data }
  }

  Exec.prototype.pathExists = async function (p) {
    const r = await this.psJson('file-ops.ps1', ['exists', p, ''])
    return r.ok === true && r.data.exists === true
  }

  Exec.prototype.fileSize = async function (p) {
    const r = await this.psJson('file-ops.ps1', ['size', p, ''])
    if (r.ok !== true || r.data.size === undefined) return undefined
    return r.data.size
  }

  Exec.prototype.stat = async function (p) {
    const r = await this.psJson('file-ops.ps1', ['stat', p, ''])
    return r.ok === true ? r.data : { exists: false }
  }

  Exec.prototype.listDir = async function (p) {
    const r = await this.psJson('file-ops.ps1', ['list', p, ''])
    if (r.ok !== true) return undefined
    return r.data.items || []
  }

  Exec.prototype.move = async function (a, b) {
    return this.fileOp('move', a, b)
  }

  Exec.prototype.copy = async function (a, b) {
    return this.fileOp('copy', a, b)
  }

  Exec.prototype.removeTree = async function (p) {
    return this.fileOp('delete', p, '')
  }

  // Read the first `maxBytes` of a (possibly huge) file as a Uint8Array.
  Exec.prototype.headBytes = async function (p, maxBytes) {
    const r = await this.ps('file-head.ps1', [p, String(maxBytes)], {
      stdoutBytes: Math.ceil(maxBytes * 1.5) + 4096,
      timeoutMs: 60000,
    })
    if (r.spawnFailed || r.exitCode !== 0) {
      return { ok: false, error: 'file-head failed: ' + util.truncate(r.stderr || ('exit ' + r.exitCode), 300) }
    }
    const text = String(r.stdout).trim()
    if (text === '') return { ok: false, error: 'file-head returned no data' }
    try {
      return { ok: true, bytes: util.b64ToBytes(text) }
    } catch (err) {
      return { ok: false, error: 'bad base64 from file-head: ' + String(err && err.message) }
    }
  }

  Exec.prototype.sha256 = async function (p) {
    const r = await this.ps('file-hash.ps1', [p, 'SHA256'], { timeoutMs: 10 * 60 * 1000 })
    if (r.spawnFailed || r.exitCode !== 0) return undefined
    return (r.stdout || '').trim().toLowerCase()
  }

  /**
   * Scan a GGUF file's metadata region with the streaming PowerShell reader.
   * Handles headers whose KV region exceeds any head window (large BPE merge
   * tables, long chat templates) without loading the file. Returns { ok, ... }
   * with the compact scan summary, or { ok: false, error }.
   */
  Exec.prototype.ggufScan = async function (path) {
    const r = await this.ps('gguf-scan.ps1', [path], {
      stdoutBytes: 8 * 1024 * 1024,
      timeoutMs: 5 * 60 * 1000,
    })
    if (r.spawnFailed || r.exitCode !== 0) {
      const line = (r.stderr || '').split(/\r?\n/).find((l) => l.trim() !== '') || 'gguf-scan failed'
      return { ok: false, error: util.truncate(line.trim(), 300) }
    }
    const jsonText = util.extractJson(r.stdout, '"')
    const data = util.tryParseJson(jsonText)
    if (data === undefined || data.ok !== true) {
      return { ok: false, error: 'gguf-scan returned no valid result' }
    }
    return { ok: true, ...data }
  }

  // ---------- network helpers (curl.exe, structured argv) ----------

  /**
   * GET a URL with curl and split the trailing "\n<http_code>" writeout off the
   * body. Shared by httpGetText/httpGetJson.
   * opts: { headers: {K:V}, timeoutMs }
   */
  Exec.prototype._curlGet = async function (url, opts) {
    const o = opts || {}
    const timeoutMs = o.timeoutMs || 30000
    const args = ['-sS', '--connect-timeout', '15', '--max-time', String(Math.floor(timeoutMs / 1000)), '-L']
    const headers = o.headers || {}
    for (const k of Object.keys(headers)) args.push('-H', k + ': ' + headers[k])
    args.push('-w', '\n%{http_code}', url)
    const r = await this.run([TOOLS.curl].concat(args), {
      stdoutBytes: 8 * 1024 * 1024,
      stderrBytes: 256 * 1024,
      timeoutMs: timeoutMs + 5000,
      graceMs: 5000,
    })
    if (r.spawnFailed) return { ok: false, code: 'CURL_SPAWN', message: r.error }
    const out = (r.stdout || '').replace(/\r/g, '')
    const idx = out.lastIndexOf('\n')
    const body = idx === -1 ? out : out.slice(0, idx)
    const codeLine = idx === -1 ? '' : out.slice(idx + 1).trim()
    const status = parseInt(codeLine, 10)
    if (r.exitCode !== 0) {
      return {
        ok: false, code: 'CURL_EXIT_' + r.exitCode, status,
        message: 'network request failed (curl exit ' + r.exitCode + '): ' + util.truncate((r.stderr || '').trim(), 300),
      }
    }
    return { ok: true, status: status || 200, text: body }
  }

  /**
   * GET a URL and return parsed JSON + HTTP status.
   * opts: { headers: {K:V}, timeoutMs }
   */
  Exec.prototype.httpGetJson = async function (url, opts) {
    const r = await this._curlGet(url, opts)
    if (!r.ok) return r
    const data = util.tryParseJson(r.text)
    if (data === undefined) {
      return { ok: false, code: 'BAD_JSON', status: r.status, message: 'response was not JSON', body: util.truncate(r.text, 400) }
    }
    return { ok: true, status: r.status, data }
  }

  /**
   * GET a URL and return the raw text body + HTTP status (for text formats
   * like llama-server's Prometheus /metrics output).
   */
  Exec.prototype.httpGetText = async function (url, opts) {
    return this._curlGet(url, opts)
  }

  /**
   * POST a JSON body and return parsed JSON + HTTP status. The body goes in on
   * stdin rather than as an argument: it is data, and a request that grows past
   * the command-line length limit should not start failing on that account.
   * opts: { headers: {K:V}, timeoutMs }
   */
  Exec.prototype.httpPostJson = async function (url, body, opts) {
    const o = opts || {}
    const timeoutMs = o.timeoutMs || 30000
    const args = ['-sS', '--connect-timeout', '15', '--max-time', String(Math.floor(timeoutMs / 1000)),
      '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-']
    const headers = o.headers || {}
    for (const k of Object.keys(headers)) args.push('-H', k + ': ' + headers[k])
    args.push('-w', '\n%{http_code}', url)
    const r = await this.run([TOOLS.curl].concat(args), {
      stdinData: JSON.stringify(body === undefined ? {} : body),
      stdoutBytes: 2 * 1024 * 1024,
      stderrBytes: 256 * 1024,
      timeoutMs: timeoutMs + 5000,
      graceMs: 5000,
    })
    if (r.spawnFailed) return { ok: false, code: 'CURL_SPAWN', message: r.error }
    const out = (r.stdout || '').replace(/\r/g, '')
    const idx = out.lastIndexOf('\n')
    const text = idx === -1 ? out : out.slice(0, idx)
    const status = parseInt(idx === -1 ? '' : out.slice(idx + 1).trim(), 10)
    if (r.exitCode !== 0) {
      return {
        ok: false, code: 'CURL_EXIT_' + r.exitCode, status,
        message: 'network request failed (curl exit ' + r.exitCode + '): ' + util.truncate((r.stderr || '').trim(), 300),
      }
    }
    return { ok: true, status: status || 200, data: util.tryParseJson(text), body: text }
  }

  /**
   * Start a download with resume support and a live progress handle.
   * Returns { ok, handle, cancel(), done: Promise<...>, filePath }.
   * Cancellation terminates the curl process tree and deletes nothing
   * (the partial file stays for resume).
   */
  Exec.prototype.startDownload = function (url, filePath, expectedBytes, opts) {
    const o = opts || {}
    const args = ['-sS', '-L', '--fail', '--retry', '3', '--retry-delay', '1',
      '--connect-timeout', '20', '-C', '-', '-o', filePath]
    if (expectedBytes !== undefined && expectedBytes > 0) args.push('--max-filesize', String(expectedBytes))
    if (o.maxTimeSec) args.push('--max-time', String(o.maxTimeSec))
    args.push(url)
    let handle
    try {
      handle = this.subprocess.spawn({
        argv: [TOOLS.curl].concat(args),
        cwd: util.dirname(filePath),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 * 1024 },
          stderr: { maxBytes: 512 * 1024 },
        },
        graceMs: 5000,
      })
    } catch (err) {
      return { ok: false, message: String(err && err.message) }
    }
    const state = { cancelled: false, handle }
    return {
      ok: true,
      filePath,
      handle,
      cancel() {
        state.cancelled = true
        try { handle.terminate() } catch (_e) { /* noop */ }
      },
      cancelled: () => state.cancelled,
      done: handle.done.then((outcome) => ({
        cancelled: state.cancelled,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
      })).catch((err) => ({ spawnFailed: true, error: String(err && err.message) })),
    }
  }

  // ---------- desktop integration ----------

  /**
   * Show a native picker and return the chosen path.
   * opts: { mode: 'file'|'folder'|'save', title, startDir, filter, fileName }
   * Returns { ok, cancelled, path }.
   */
  Exec.prototype.pickPath = async function (opts) {
    const o = opts || {}
    const mode = o.mode === 'folder' || o.mode === 'save' ? o.mode : 'file'
    const r = await this.psJson('pick.ps1', [
      mode,
      String(o.title || (mode === 'folder' ? 'Select a folder' : 'Select a file')),
      String(o.startDir || ''),
      String(o.filter || ''),
      String(o.fileName || ''),
    ], { timeoutMs: 10 * 60 * 1000 }) // modal: wait for the user
    if (!r.ok) return { ok: false, cancelled: true, error: r.error }
    return { ok: true, cancelled: r.data.cancelled === true, path: r.data.path || undefined }
  }

  /**
   * Open Explorer at a path (files are revealed and selected).
   */
  Exec.prototype.reveal = async function (p) {
    const r = await this.psJson('reveal.ps1', [String(p || '')], { timeoutMs: 30000 })
    if (!r.ok) return { ok: false, error: r.error }
    return {
      ok: r.data.ok === true,
      path: p,
      fellBackToParent: r.data.fellBackToParent === true,
      error: r.data.error,
    }
  }

  // ---------- port helpers ----------

  Exec.prototype.portStatus = async function (port) {
    const r = await this.psJson('port.ps1', [String(port)])
    if (!r.ok) return { ok: false, error: r.error, port }
    return { ok: true, port, open: r.data.open === true, pids: r.data.pids || [] }
  }

  // ---------- tool presence ----------

  Exec.prototype.toolAvailable = async function (tool) {
    if (this._toolPresence[tool] !== undefined) return this._toolPresence[tool]
    const p = TOOLS[tool]
    let available = false
    if (p !== undefined) {
      const r = await this.psJson('file-ops.ps1', ['exists', p, ''])
      available = r.ok === true && r.data.exists === true
    }
    this._toolPresence[tool] = available
    return available
  }

  LLAMA.modules.push('exec')
  LLAMA.exec = { Exec, SCRIPTS, TOOLS }
})(globalThis.LLAMA)
