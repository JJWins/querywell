# Generates public/og-image.png at exactly 1200x630 using the QueryWell logo
# and brand colors. Requires Windows System.Drawing (no extra packages).
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logoPath = Join-Path $root "public\QueryWell_Logo.png"
$outPath = Join-Path $root "public\og-image.png"
$width = 1200
$height = 630

function New-Color([int]$r, [int]$g, [int]$b, [int]$a = 255) {
  return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
}

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($radius * 2, [Math]::Min($w, $h))
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Font([string]$family, [float]$sizePx, [System.Drawing.FontStyle]$style) {
  return New-Object System.Drawing.Font($family, $sizePx, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

$navy = New-Color 7 21 44
$body = New-Color 20 50 92
$muted = New-Color 59 92 134
$primary = New-Color 8 112 253
$cyan = New-Color 0 212 247
$success = New-Color 21 128 61
$terminal = New-Color 7 20 34
$terminalHeader = New-Color 11 28 48
$keyword = New-Color 125 211 252
$ident = New-Color 226 239 255
$string = New-Color 103 232 249
$chipBg = New-Color 230 243 255
$chipBorder = New-Color 183 220 255
$white = [System.Drawing.Color]::White

$bmp = New-Object System.Drawing.Bitmap $width, $height
$bmp.SetResolution(72, 72)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point $width, $height),
  (New-Color 244 249 255),
  (New-Color 214 236 255)
)
$g.FillRectangle($bgBrush, 0, 0, $width, $height)

$blob = New-Object System.Drawing.Drawing2D.GraphicsPath
$blob.AddEllipse(820, -80, 520, 420)
$blobBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $blob
$blobBrush.CenterColor = New-Color 0 212 247 42
$blobBrush.SurroundColors = [System.Drawing.Color[]]@(New-Color 8 112 253 0)
$g.FillPath($blobBrush, $blob)

$blob2 = New-Object System.Drawing.Drawing2D.GraphicsPath
$blob2.AddEllipse(-180, 360, 520, 380)
$blob2Brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $blob2
$blob2Brush.CenterColor = New-Color 8 112 253 28
$blob2Brush.SurroundColors = [System.Drawing.Color[]]@(New-Color 244 249 255 0)
$g.FillPath($blob2Brush, $blob2)

$bar = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 0, 0),
  (New-Object System.Drawing.Point 0, $height),
  $primary,
  $cyan
)
$g.FillRectangle($bar, 0, 0, 8, $height)

$logo = [System.Drawing.Image]::FromFile($logoPath)
$g.DrawImage($logo, 64, 58, 58, 58)

$brandFont = New-Font "Segoe UI Variable Display" 34 ([System.Drawing.FontStyle]::Bold)
$queryBrush = New-Object System.Drawing.SolidBrush $navy
$wellBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 180, 68),
  (New-Object System.Drawing.Point 320, 68),
  $primary,
  $cyan
)
$typographic = [System.Drawing.StringFormat]::GenericTypographic
$g.DrawString("Query", $brandFont, $queryBrush, 132, 68, $typographic)
$querySize = $g.MeasureString("Query", $brandFont, [System.Drawing.PointF]::new(0, 0), $typographic)
$g.DrawString("Well", $brandFont, $wellBrush, 132 + $querySize.Width, 68, $typographic)

$headlineFont = New-Font "Segoe UI Variable Display" 48 ([System.Drawing.FontStyle]::Bold)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.DrawString("Ask Your Database", $headlineFont, $queryBrush, 60, 150)
$g.DrawString("in Plain English", $headlineFont, $queryBrush, 60, 208)

$subFont = New-Font "Segoe UI" 22 ([System.Drawing.FontStyle]::Regular)
$subBrush = New-Object System.Drawing.SolidBrush $muted
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$g.DrawString("Turn natural-language questions into SQL", $subFont, $subBrush, 64, 286)
$g.DrawString("and actionable results.", $subFont, $subBrush, 64, 316)

function Draw-Chip($text, $x, $y) {
  $chipFont = New-Font "Segoe UI Semibold" 15 ([System.Drawing.FontStyle]::Regular)
  $size = $g.MeasureString($text, $chipFont)
  $w = $size.Width + 22
  $h = 32
  $path = New-RoundRect $x $y $w $h 16
  $fill = New-Object System.Drawing.SolidBrush $chipBg
  $pen = New-Object System.Drawing.Pen $chipBorder, 1
  $textBrush = New-Object System.Drawing.SolidBrush $body
  $g.FillPath($fill, $path)
  $g.DrawPath($pen, $path)
  $g.DrawString($text, $chipFont, $textBrush, $x + 10, $y + 5)
  $chipFont.Dispose()
  $fill.Dispose()
  $pen.Dispose()
  $textBrush.Dispose()
  $path.Dispose()
  return $w
}

$chip1 = Draw-Chip "Read-only MySQL" 64 372
[void](Draw-Chip "Schema metadata only" (64 + $chip1 + 12) 372)

# SQL Studio visualization, matching product chrome (not customer data)
$panelX = 668
$panelY = 86
$panelW = 472
$panelH = 458
$panel = New-RoundRect $panelX $panelY $panelW $panelH 18
$panelBrush = New-Object System.Drawing.SolidBrush $terminal
$g.FillPath($panelBrush, $panel)

$header = New-RoundRect $panelX $panelY $panelW 52 18
$region = New-Object System.Drawing.Region $header
$clipRect = New-Object System.Drawing.RectangleF $panelX, $panelY, $panelW, 44
$g.SetClip($clipRect)
$headerBrush = New-Object System.Drawing.SolidBrush $terminalHeader
$g.FillPath($headerBrush, $header)
$g.ResetClip()

$dotBrush = New-Object System.Drawing.SolidBrush $success
$g.FillEllipse($dotBrush, $panelX + 22, $panelY + 18, 12, 12)
$headerFont = New-Font "Segoe UI Semibold" 15 ([System.Drawing.FontStyle]::Regular)
$headerText = New-Object System.Drawing.SolidBrush (New-Color 186 214 240)
$g.DrawString("SQL Studio  |  read-only replica", $headerFont, $headerText, $panelX + 44, $panelY + 14)

$bubble = New-RoundRect ($panelX + 20) ($panelY + 68) 432 58 12
$bubbleBrush = New-Object System.Drawing.SolidBrush (New-Color 15 36 64)
$g.FillPath($bubbleBrush, $bubble)
$qFont = New-Font "Segoe UI" 16 ([System.Drawing.FontStyle]::Regular)
$qBrush = New-Object System.Drawing.SolidBrush (New-Color 210 228 248)
$g.DrawString('"How many paid orders are there?"', $qFont, $qBrush, $panelX + 34, $panelY + 84)

$codeFont = New-Font "Cascadia Code" 16 ([System.Drawing.FontStyle]::Regular)
$kw = New-Object System.Drawing.SolidBrush $keyword
$id = New-Object System.Drawing.SolidBrush $ident
$st = New-Object System.Drawing.SolidBrush $string
$mutedCode = New-Object System.Drawing.SolidBrush (New-Color 122 154 186)
function Draw-CodeLine($parts, $x, $y) {
  foreach ($part in $parts) {
    $g.DrawString($part.text, $codeFont, $part.brush, $x, $y, $typographic)
    $x += $g.MeasureString($part.text, $codeFont, [System.Drawing.PointF]::new(0, 0), $typographic).Width
    if ($part.space) { $x += 12 }
  }
}
$x0 = $panelX + 36
$y0 = $panelY + 154
Draw-CodeLine @(
  @{ text = "SELECT"; brush = $kw; space = $true },
  @{ text = "COUNT(*)"; brush = $id; space = $true },
  @{ text = "AS"; brush = $kw; space = $true },
  @{ text = "paid_orders"; brush = $id; space = $false }
) $x0 $y0
Draw-CodeLine @(
  @{ text = "FROM"; brush = $kw; space = $true },
  @{ text = "orders"; brush = $id; space = $false }
) $x0 ($y0 + 32)
Draw-CodeLine @(
  @{ text = "WHERE"; brush = $kw; space = $true },
  @{ text = "status"; brush = $id; space = $true },
  @{ text = "="; brush = $mutedCode; space = $true },
  @{ text = "'paid'"; brush = $st; space = $false }
) $x0 ($y0 + 64)
Draw-CodeLine @(
  @{ text = "LIMIT"; brush = $kw; space = $true },
  @{ text = "100"; brush = $id; space = $false },
  @{ text = ";"; brush = $mutedCode; space = $false }
) $x0 ($y0 + 96)

$result = New-RoundRect ($panelX + 20) ($panelY + 330) 432 102 12
$resultBrush = New-Object System.Drawing.SolidBrush (New-Color 10 28 48)
$g.FillPath($resultBrush, $result)
$labelFont = New-Font "Segoe UI Semibold" 13 ([System.Drawing.FontStyle]::Regular)
$resultLabel = New-Object System.Drawing.SolidBrush (New-Color 122 154 186)
$g.DrawString("VERIFIED SELECT", $labelFont, $resultLabel, $panelX + 36, $panelY + 348)
$noteFont = New-Font "Segoe UI" 16 ([System.Drawing.FontStyle]::Regular)
$noteBrush = New-Object System.Drawing.SolidBrush (New-Color 210 228 248)
$g.DrawString("Read-only query. Rows stay on your server.", $noteFont, $noteBrush, $panelX + 36, $panelY + 378)

$bottom = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
  (New-Object System.Drawing.Point 0, 622),
  (New-Object System.Drawing.Point $width, 630),
  $primary,
  $cyan
)
$g.FillRectangle($bottom, 0, 622, $width, 8)

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

$logo.Dispose()
$g.Dispose()
$bmp.Dispose()

$check = [System.Drawing.Bitmap]::FromFile($outPath)
if ($check.Width -ne 1200 -or $check.Height -ne 630) {
  throw "og-image.png is $($check.Width)x$($check.Height), expected 1200x630"
}
$check.Dispose()
Write-Host "Wrote $outPath (1200x630 PNG)"
