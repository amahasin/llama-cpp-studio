# installer/make-icon.ps1 - render the app mark into a Windows .ico.
#
#   powershell -File installer\make-icon.ps1 -Out dist\build\app.ico
#
# The llama is not copied here: New-LlamaPath is parsed out of src\tray.ps1 and
# run, so the exe's icon cannot drift from the tray's, which already follows
# web/icon.svg. The tile is the same rounded accent square, without the tray's
# status dot.
#
# Sizes up to 64 are stored as 32-bit DIBs and 256 as PNG, which is what
# Explorer expects and what System.Drawing can read back for the setup window.
param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$tray = Join-Path $PSScriptRoot '..\src\tray.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $tray).ProviderPath, [ref]$tokens, [ref]$errors)
$fn = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-LlamaPath'
}, $true)
if (-not $fn) { throw 'New-LlamaPath was not found in src\tray.ps1' }
. ([scriptblock]::Create($fn.Extent.Text))

function New-MarkBitmap([int]$Size) {
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # The rounded tile: rx=15 in web/icon.svg's 64-unit box.
    $s = [single]$Size
    $d = $s * 30 / 64
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc($s - $d, 0, $d, $d, 270, 90)
    $tile.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
    $tile.AddArc(0, $s - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 95, 184))
    $g.FillPath($accent, $tile)

    $llama = New-LlamaPath
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Scale($s / 64.0, $s / 64.0)
    $m.Translate(-2.1, 5.2)
    $m.Scale(0.855, 0.855)
    $llama.Transform($m)
    $g.FillPath([System.Drawing.Brushes]::White, $llama)

    $accent.Dispose(); $tile.Dispose(); $llama.Dispose(); $m.Dispose(); $g.Dispose()
    return $bmp
}

# An icon-directory image: BITMAPINFOHEADER (height doubled for the mask),
# bottom-up BGRA rows, then an all-zero AND mask, since alpha does that job.
function Get-DibBytes([System.Drawing.Bitmap]$Bmp) {
    $w = $Bmp.Width
    $h = $Bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $Bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $raw = New-Object byte[] ($data.Stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $stride = $data.Stride
    $Bmp.UnlockBits($data)

    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $maskStride = [int]([math]::Ceiling($w / 32.0) * 4)
    $bw.Write([int]40); $bw.Write([int]$w); $bw.Write([int]($h * 2))
    $bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int]0)
    $bw.Write([int]($w * $h * 4 + $maskStride * $h))
    $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0); $bw.Write([int]0)
    for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($raw, $y * $stride, $w * 4) }
    $bw.Write((New-Object byte[] ($maskStride * $h)))
    $bw.Flush()
    return , $ms.ToArray()
}

function Get-PngBytes([System.Drawing.Bitmap]$Bmp) {
    $ms = New-Object System.IO.MemoryStream
    $Bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return , $ms.ToArray()
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 256)
$images = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($size in $sizes) {
    $bmp = New-MarkBitmap $size
    if ($size -ge 256) { $images.Add((Get-PngBytes $bmp)) } else { $images.Add((Get-DibBytes $bmp)) }
    $bmp.Dispose()
}

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([int16]0); $bw.Write([int16]1); $bw.Write([int16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([int16]1); $bw.Write([int16]32)
    $bw.Write([int]$images[$i].Length); $bw.Write([int]$offset)
    $offset += $images[$i].Length
}
foreach ($image in $images) { $bw.Write($image) }
$bw.Flush()

$target = [System.IO.Path]::GetFullPath($Out)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
[System.IO.File]::WriteAllBytes($target, $ms.ToArray())
Write-Output ("icon: " + $sizes.Count + " sizes -> " + $target)
