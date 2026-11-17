# 在 Windows 设备上用无头 Edge 截 demo 界面，检查布局和弹出菜单。
# 用法：pcrun "powershell -ExecutionPolicy Bypass -File scripts\ui-shots.ps1"，图片在 .cc\shots\。
# 只截名称以某前缀开头的几张: -Only usage-
# 每项是 名称、地址、窗口尺寸。demo 参数：?s=会话 ?theme= ?scene=tasks|offline|conn ?pane=窗格（空值关闭）?click=加载后点击的选择器。
# 改版后的布局参数：?sidew= ?panew=（宽度 px）?collapsed=1（收起会话栏）?frame=custom（模拟无边框窗口按钮）?then=（点完 click 后再点的第二个元素）；
# 每次加载不带 sidew / panew / collapsed 就回到默认，不会把上一张的设置带过来。layout-* 是改版的一组。
# ?click 触发的内层滚动在截图里看不到；要验证滚动，用 --dump-dom --enable-logging=stderr 看 console 输出。
# 无头 Edge 窗口最窄约 500px，更窄的截图只会裁切，不能用来判断窄屏布局。
param([string]$Out = ".cc\shots", [string]$Only = "", [switch]$NoMotion)
$ErrorActionPreference = "Continue"
$shots = @(
  @("rich-light", "/?s=rich&theme=light&pane=", "1440,900"),
  @("rich-dark", "/?s=rich&theme=dark&pane=", "1440,900"),
  @("rich-changes", "/?s=rich&theme=light&pane=changes", "1440,900"),
  @("pin-on", "/?s=rich&theme=dark&pane=&click=.icon.pin", "1200,700"),
  @("tasks-1200", "/?s=rich&scene=tasks&theme=light&pane=tasks", "1200,800"),
  @("welcome", "/?theme=light&pane=", "1440,900"),
  # 新会话页内容窄：主区域要撑满面板，不能按内容缩（曾经右侧空出一大片）
  @("devices-light", "/?s=rich&scene=devices&theme=light&pane=&frame=custom", "1200,800"),
  @("devices-dark", "/?s=rich&scene=devices&theme=dark&pane=&frame=custom", "1200,800"),
  @("devices-cool", "/?s=rich&scene=devices&theme=cool&pane=&frame=custom", "1200,800"),
  @("workspace-devices", "/?scene=devices&theme=light&pane=&frame=custom&click=.chip-btn", "1200,800"),
  @("devices-menu", "/?s=rich&scene=devices&theme=light&pane=&frame=custom&click=.dev-switch%20.dd-btn", "1200,800"),
  @("devices-pick", "/?s=rich&scene=devices&theme=light&pane=&frame=custom&device=laptop", "1200,800"),
  @("welcome-wide", "/?theme=dark&pane=&frame=custom", "1500,940"),
  @("approval", "/?s=approval&theme=light&pane=", "1200,800"),
  @("small", "/?s=rich&theme=light&pane=", "900,460"),
  @("menu-pane", "/?s=rich&theme=light&pane=&click=.pane-menu%20.dd-btn", "1200,700"),
  @("menu-usage", "/?theme=light&pane=&click=.usage%20.dd-btn", "900,460"),
  @("turns", "/?s=turns&theme=light&pane=", "1200,800"),
  @("menu-model", "/?s=rich&theme=light&pane=&click=.tools%20.model", "1200,800"),
  @("menu-effort", "/?s=rich&scene=effort&theme=dark&pane=&click=.tools%20.model", "1200,800"),
  @("usage-light", "/?s=rich&theme=light&pane=usage&range=30d", "1440,900"),
  @("usage-dark", "/?theme=dark&pane=usage&range=30d", "1200,800"),
  @("usage-cost", "/?theme=light&pane=usage&range=30d&models=cost", "1200,1200"),
  @("usage-proj-tokens", "/?theme=dark&pane=usage&range=30d&models=tokens", "1200,1200"),
  @("usage-proj-narrow", "/?theme=dark&pane=usage&range=30d&models=tokens&panew=300", "1200,1200"),
  @("usage-proj-wide", "/?theme=dark&pane=usage&range=30d&models=tokens&panew=640", "1440,1200"),
  @("usage-proj-old", "/?scene=usage-old&theme=light&pane=usage&range=30d&models=tokens", "1200,1200"),
  @("usage-small", "/?s=rich&theme=light&pane=usage&range=30d", "900,460"),
  @("usage-hover-heat", "/?theme=light&pane=usage&range=30d&hover=.heat-grid%20i.today", "1200,800"),
  @("usage-hover-bar", "/?theme=dark&pane=usage&range=30d&hover=.bars%20.bar:nth-last-child(2)", "1200,800"),
  @("usage-today", "/?theme=light&pane=usage&range=today&hover=.bars%20.bar.today", "1200,800"),
  @("layout-1440-light", "/?s=rich&theme=light&pane=&frame=custom", "1440,900"),
  @("layout-1440-dark", "/?s=rich&theme=dark&pane=&frame=custom", "1440,900"),
  @("layout-pane", "/?s=rich&theme=light&pane=changes&frame=custom", "1200,800"),
  @("layout-pane-wide", "/?s=rich&theme=dark&pane=tasks&scene=tasks&panew=640&sidew=220&frame=custom", "1440,900"),
  @("layout-900", "/?s=rich&theme=light&pane=&sidew=420&frame=custom", "900,460"),
  @("layout-collapsed", "/?s=rich&theme=light&pane=&collapsed=1&frame=custom", "1200,800"),
  @("layout-float", "/?s=rich&theme=light&pane=&sidew=420&frame=custom&click=.titlebar-nav%20button:last-child", "900,460"),
  @("layout-gear", "/?s=rich&theme=light&pane=&frame=custom&click=.rail-gear%20.rail-btn", "1200,700"),
  @("layout-look", "/?s=rich&theme=dark&pane=&frame=custom&click=.rail-gear%20.rail-btn&then=.menu%20.mi:first-child", "1200,800"),
  @("layout-look-small", "/?s=rich&theme=light&pane=&frame=custom&click=.rail-gear%20.rail-btn&then=.menu%20.mi:first-child", "900,460"),
  @("layout-gear-small", "/?s=rich&theme=light&pane=&frame=custom&click=.rail-gear%20.rail-btn", "900,460"),
  @("layout-narrow", "/?s=rich&theme=light&pane=&frame=custom", "820,700"),
  @("layout-drawer", "/?s=rich&theme=light&pane=&frame=custom&click=.drawer-open", "820,700"),
  @("layout-drawer-plain", "/?s=rich&theme=light&pane=&click=.drawer-open", "820,700")
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
  if ($Only -and -not $s[0].StartsWith($Only)) { continue }
  $file = Join-Path $full ($s[0] + ".png")
  # 独立的用户目录：设备上开着 Edge 时，共用目录的无头实例会把请求交给已开的浏览器后直接退出，截不到图。
  # -NoMotion：按“减少动画”渲染（styles.css 会关掉过渡），排除主题切换时颜色过渡没走完造成的发暗。
  $motion = if ($NoMotion) { "--force-prefers-reduced-motion" } else { "--no-first-run" }
  & $edge --headless=new "--user-data-dir=$env:TEMP\cchub-shots-edge" --disable-gpu --hide-scrollbars $motion --virtual-time-budget=4000 "--window-size=$($s[2])" "--screenshot=$file" "http://127.0.0.1:5199$($s[1])" 2>$null | Out-Null
}
Get-ChildItem $full -Filter *.png | Select-Object Name, Length
taskkill /PID $p.Id /T /F 2>$null | Out-Null
