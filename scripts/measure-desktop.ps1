# 量桌面端资源：沿 cchub-desktop 的进程树（含 WebView2 子进程）汇总私有工作集，并采样一段时间的 CPU。
# 用法：pcrun "powershell -ExecutionPolicy Bypass -File scripts\measure-desktop.ps1 -Seconds 10"
# 工作集含共享内存、设备上还有别的程序的 WebView，所以只按父进程树汇总私有工作集。
# 本文件存成带 BOM 的 UTF-8: PowerShell 5 否则按 GBK 读。
param([int]$Seconds = 10)
$ErrorActionPreference = "Stop"
$root = Get-Process cchub-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $root) { Write-Output "cchub-desktop 没有运行"; exit 1 }
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
$tree = @($root.Id)
do {
  # 只算 WebView2 自己的进程：输入法（如搜狗的 SGTool、SogouCloud）会挂在 WebView 下面，不是 cchub 的。
  $added = @($all | Where-Object { $tree -contains $_.ParentProcessId -and $tree -notcontains $_.ProcessId -and $_.Name -eq "msedgewebview2.exe" } | ForEach-Object { $_.ProcessId })
  $tree += $added
} while ($added.Count)

function Kind($p) {
  if ($p.Name -eq "cchub-desktop.exe") { return "cchub-desktop" }
  if ($p.CommandLine -match "--type=([\w-]+)") { return $Matches[1] }
  return "browser"
}
function Cpu { $t = 0; foreach ($id in $tree) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p) { $t += $p.TotalProcessorTime.TotalMilliseconds } }; $t }

$before = Cpu
Start-Sleep -Seconds $Seconds
$after = Cpu
$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $tree -contains $_.IDProcess }
$rows = foreach ($r in $perf) {
  $p = $all | Where-Object { $_.ProcessId -eq $r.IDProcess }
  [pscustomobject]@{ pid = $r.IDProcess; kind = Kind $p; privateMB = [math]::Round($r.WorkingSetPrivate / 1MB, 1) }
}
$rows | Sort-Object privateMB -Descending | Format-Table -AutoSize | Out-String
$total = ($rows | Measure-Object privateMB -Sum).Sum
# 经 SSH 运行时看不到桌面上的窗口（不在同一个窗口会话），窗口开着还是在托盘要由用户告知。
Write-Output ("进程 {0} 个；私有工作集合计 {1} MB；{2} 秒内 CPU {3} ms（约单核 {4}%）" -f $rows.Count, $total, $Seconds, [math]::Round($after - $before), [math]::Round(($after - $before) / ($Seconds * 10), 1))
