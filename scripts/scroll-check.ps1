# Message-stream stick-to-bottom check in headless Edge (demo ?s=long). See scroll-check.mjs for expectations.
# Usage: pcrun "powershell -ExecutionPolicy Bypass -File scripts\scroll-check.ps1 [-Size 1200,800] [-Rounds 5]"
param([string]$Size = "1200,800", [int]$Rounds = 5, [string]$Theme = "light")
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
New-Item -ItemType Directory -Force ".cc" | Out-Null
$p = Start-Process -PassThru -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c npx vite --host 127.0.0.1 --port 5198 --strictPort > ..\.cc\vite-scroll.log 2>&1" -WorkingDirectory "web"
for ($i = 0; $i -lt 80; $i++) { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5198/ -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
$prof = Join-Path $env:TEMP ("cchub-scroll-" + [guid]::NewGuid())
$e = Start-Process -PassThru -FilePath $edge -ArgumentList "--headless=new","--disable-gpu","--remote-debugging-port=9333","--user-data-dir=$prof","--window-size=$Size","http://127.0.0.1:5198/?s=long&theme=$Theme&pane="
Start-Sleep -Seconds 4
node scripts\scroll-check.mjs 9333 $Rounds $Theme
Stop-Process -Id $e.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*cchub-scroll-*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
taskkill /PID $p.Id /T /F | Out-Null
Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
