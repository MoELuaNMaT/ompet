# ompet 标签切换：按会话级终端标题匹配 Windows Terminal 标签并选中。
# 由 focus_ompi_terminal 调用（include_str! 嵌入，运行时写临时文件执行）。
# 输出：switched=已切换 / nomatch=未匹配到（多候选窗口时调用方返回失败）。
# 注意：单标签窗口也走名称匹配（不特判 single）——Windows Terminal 是单进程多窗口，
# 多个单标签窗口必须靠标签名区分目标窗口，特判会导致选错窗口。
param([int]$WtHwnd, [string]$Title)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WtHwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem)
$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($null -eq $tabs -or $tabs.Count -le 0) {
  Write-Output "notabs"
  exit 0
}
for ($i = 0; $i -lt $tabs.Count; $i++) {
  $t = $tabs.Item($i)
  if ($t.Current.Name -eq $Title) {
    $sel = $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $sel.Select()
    Write-Output "switched"
    exit 0
  }
}
Write-Output "nomatch"
exit 0
