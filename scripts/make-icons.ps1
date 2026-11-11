# 从 desktop\icons\source.svg 重新生成入库的桌面端图标。Android 的图标不入库，由 CI 在 android init 之后生成（见 ci.yml）。
# 用法：pcrun "powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1"
$root = Split-Path -Parent $PSScriptRoot
$icons = Join-Path $root "desktop\icons"
$out = Join-Path $env:TEMP "cchub-icons"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
Push-Location $root
# 经 cmd 调用：tauri 把进度写到 stderr，PowerShell 5 会把它当成错误。
cmd /c "npx tauri icon desktop\icons\icon-manifest.json -o `"$out`" > nul 2>&1"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "tauri icon 失败（$LASTEXITCODE）" }
cmd /c "npx tauri icon desktop\icons\source.svg -p 1024 -o `"$out`" > nul 2>&1"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "tauri icon -p 1024 失败（$LASTEXITCODE）" }
Pop-Location
# tauri.conf.json 只引用这几个；其余平台的产物不入库。
foreach ($f in "32x32.png", "128x128.png", "icon.png", "icon.ico", "icon.icns") {
  Copy-Item (Join-Path $out $f) (Join-Path $icons $f) -Force
}
Copy-Item (Join-Path $out "1024x1024.png") (Join-Path $icons "source.png") -Force
Get-ChildItem $icons | Format-Table Name, Length, LastWriteTime -AutoSize | Out-String
