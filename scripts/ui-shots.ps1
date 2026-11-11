# 在 Windows 设备上用无头 Edge 截 demo 界面，检查布局和弹出菜单。
# 用法：pcrun "powershell -ExecutionPolicy Bypass -File scripts\ui-shots.ps1"，图片在 .cc\shots\。
# 每项是 名称、地址、窗口尺寸。demo 参数：?s=会话 ?theme= ?scene=tasks|offline|conn ?pane=窗格（空值关闭）?click=加载后点击的选择器。
# ?click 触发的内层滚动在截图里看不到；要验证滚动，用 --dump-dom --enable-logging=stderr 看 console 输出。
# 无头 Edge 窗口最窄约 500px，更窄的截图只会裁切，不能用来判断窄屏布局。
param([string]$Out = ".cc\shots")
$ErrorActionPreference = "Continue"
$shots = @(
  @("rich-light", "/?s=rich&theme=light&pane=", "1440,900"),
  @("rich-dark", "/?s=rich&theme=dark&pane=", "1440,900"),
  @("rich-changes", "/?s=rich&theme=light&pane=changes", "1440,900"),
  @("tasks-1200", "/?s=rich&scene=tasks&theme=light&pane=tasks", "1200,800"),
  @("welcome", "/?theme=light&pane=", "1440,900"),
  @("approval", "/?s=approval&theme=light&pane=", "1200,800"),
  @("small", "/?s=rich&theme=light&pane=", "900,460"),
  @("menu-pane", "/?s=rich&theme=light&pane=&click=.pane-menu%20.dd-btn", "1200,700"),
  @("menu-usage", "/?theme=light&pane=&click=.usage%20.dd-btn", "900,460"),
  @("turns", "/?s=turns&theme=light&pane=", "1200,800")
)
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
New-Item -ItemType Directory -Force $Out | Out-Null
New-Item -ItemType Directory -Force ".cc" | Out-Null
# 开发服务器必须固定 127.0.0.1，并等端口就绪后再截图，否则拿到的是“拒绝连接”页面。
$p = Start-Process -PassThru -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c npx vite --host 127.0.0.1 --port 5199 --strictPort > ..\.cc\vite.log 2>&1" -WorkingDirectory "web"
for ($i = 0; $i -lt 80; $i++) { try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5199/ -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
$full = (Resolve-Path $Out).Path
foreach ($s in $shots) {
  $file = Join-Path $full ($s[0] + ".png")
  & $edge --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=4000 "--window-size=$($s[2])" "--screenshot=$file" "http://127.0.0.1:5199$($s[1])" 2>$null | Out-Null
}
Get-ChildItem $full -Filter *.png | Select-Object Name, Length
taskkill /PID $p.Id /T /F 2>$null | Out-Null
