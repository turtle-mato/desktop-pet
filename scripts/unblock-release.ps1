# 清掉 release 目录下所有文件的“来自 Internet”标记（Mark-of-the-Web）。
# 不清的话双击 exe 会弹“打开文件 - 安全警告：无法验证发布者”。
# 用法：在 pet 目录执行  powershell -ExecutionPolicy Bypass -File scripts\unblock-release.ps1

param(
    [string]$Path = (Join-Path $PSScriptRoot '..\release')
)

$resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
$count = 0

Get-ChildItem -LiteralPath $resolved.Path -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    $motw = Get-Item -LiteralPath $_.FullName -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue
    if ($motw) {
        Unblock-File -LiteralPath $_.FullName
        Write-Host "已清除标记: $($_.FullName)"
        $count++
    }
}

if ($count -eq 0) {
    Write-Host "没有发现被标记的文件，目录是干净的: $($resolved.Path)"
} else {
    Write-Host "完成，共清除 $count 个文件。"
}
