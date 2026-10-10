# Copies a screenshot into the guide, optionally cropped to a rectangle (pixels).
# Usage: pwsh crop.ps1 -Source <png> -Name <name> [-X 320] [-Y 0] [-Width 0] [-Height 0]
param(
  [Parameter(Mandatory)] [string] $Source,
  [Parameter(Mandatory)] [string] $Name,
  [int] $X = 0, [int] $Y = 0, [int] $Width = 0, [int] $Height = 0
)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "screenshots") | Out-Null
$target = Join-Path $PSScriptRoot "screenshots\$Name.png"
$image = [System.Drawing.Image]::FromFile($Source)
try {
  if ($Width -le 0) { $Width = $image.Width - $X }
  if ($Height -le 0) { $Height = $image.Height - $Y }
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.DrawImage($image, (New-Object System.Drawing.Rectangle 0, 0, $Width, $Height), (New-Object System.Drawing.Rectangle $X, $Y, $Width, $Height), [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose()
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
} finally { $image.Dispose() }
"saved $target ($Width x $Height)"
