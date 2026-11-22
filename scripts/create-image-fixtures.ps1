$ErrorActionPreference='Stop'
$out=Join-Path (Split-Path $PSScriptRoot) 'work\image-fixtures'
New-Item -ItemType Directory -Path $out -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$b=New-Object Drawing.Bitmap 1100,650
$g=[Drawing.Graphics]::FromImage($b)
$g.Clear([Drawing.Color]::White)
$g.SmoothingMode='AntiAlias'
$font=New-Object Drawing.Font 'Arial',42
$code='Q7M9-'+(Get-Random -Minimum 1000 -Maximum 9999)
$g.DrawString($code,$font,[Drawing.Brushes]::Black,35,25)
$g.FillRectangle([Drawing.Brushes]::Red,70,200,160,160)
$g.FillEllipse([Drawing.Brushes]::Blue,410,200,160,160)
$pts=[Drawing.Point[]]@((New-Object Drawing.Point 850,190),(New-Object Drawing.Point 740,380),(New-Object Drawing.Point 960,380))
$g.FillPolygon([Drawing.Brushes]::Green,$pts)
$b.Save((Join-Path $out 'shapes.png'),[Drawing.Imaging.ImageFormat]::Png)
[IO.File]::WriteAllText((Join-Path $out 'expected.json'),(ConvertTo-Json @{code=$code}),[Text.UTF8Encoding]::new($false))
$g.Dispose();$b.Dispose();$font.Dispose()
$b=New-Object Drawing.Bitmap 1280,650
$g=[Drawing.Graphics]::FromImage($b)
$g.Clear([Drawing.Color]::FromArgb(244,245,247))
$g.TextRenderingHint=[Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$font=New-Object Drawing.Font 'Microsoft YaHei',28
$g.DrawString('聊天记录（合成测试）',$font,[Drawing.Brushes]::Black,40,30)
$g.DrawString('用户：周言初',$font,[Drawing.Brushes]::DarkBlue,40,140)
$g.FillRectangle([Drawing.Brushes]::White,40,195,1190,100)
$g.DrawString('我说的是图片里的角色，不是我。',$font,[Drawing.Brushes]::Black,65,220)
$g.DrawString('助手：林阅心',$font,[Drawing.Brushes]::DarkGreen,40,370)
$g.FillRectangle([Drawing.Brushes]::White,40,425,1190,100)
$g.DrawString('那你今晚几点睡？',$font,[Drawing.Brushes]::Black,65,450)
$b.Save((Join-Path $out 'chinese-chat.png'),[Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$b.Dispose();$font.Dispose()
Write-Output 'Created synthetic fixtures (no user data).'
