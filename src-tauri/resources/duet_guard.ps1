# Duet terminal guard (loaded into every host PowerShell; see pty.rs).
#
# While the host lets the student type in terminals (the flag file
# $env:DUET_GUARD_FLAG exists), every command accepted at this prompt must stay
# inside the project folder: paths outside it, other drives, UNC/network
# paths, the home folder, environment variables, nested shells and a few
# escape hatches are refused, and the terminal is moved back into the project
# if it ended up outside. Tab completion of such paths is refused too.
#
# These are guardrails, not a sandbox: a program started from here (python,
# node, ...) can still open files elsewhere. Windows PowerShell 5.1 compatible.

try { Import-Module PSReadLine -ErrorAction Stop } catch {}

$global:DuetRoot = [IO.Path]::GetFullPath($env:DUET_ROOT).TrimEnd('\')
$global:DuetFlag = $env:DUET_GUARD_FLAG

function global:DuetGuardOn { return [IO.File]::Exists($global:DuetFlag) }

function global:DuetInside([string]$full) {
  $f = $full.TrimEnd('\')
  if ($f -ieq $global:DuetRoot) { return $true }
  return $f.StartsWith($global:DuetRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function global:DuetFull([string]$p) {
  try { return [IO.Path]::GetFullPath([IO.Path]::Combine($PWD.ProviderPath, $p)) } catch { return $null }
}

$global:DuetRules = @(
  @('(?<![\w.\-])(?!https?:)[a-z]\w+:(?=[\\/]|\s|$)', 'provider paths (HKLM:, Env:, Function:) are not allowed'),
  @('\\\\', 'network (UNC) paths are not allowed'),
  @('\$(env|home|pshome|profile|executioncontext|host)\b|\$\{', 'environment variables are not allowed'),
  @('(^|[\s''"(=,;])~', 'the home folder (~) is not allowed'),
  @('\[\s*(system\.)?(io\.|environment\b|convert\b|scriptblock\b|char\b|text\.)', 'building paths or code with .NET types is not allowed'),
  @('(^|[\s;|&({])(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe|wsl|wsl\.exe|bash|bash\.exe|iex|invoke-expression|invoke-command|icm|new-psdrive|ndr|start-process|saps|subst|mklink|runas|set-psreadlinekeyhandler|remove-psreadlinekeyhandler|set-psreadlineoption|unregister-event|remove-module|set-executionpolicy)(?=$|[\s;|&)])', 'this command is not allowed while the student can type'),
  @('\s-enc(odedcommand)?\b', 'encoded commands are not allowed'),
  @('duet(root|flag|rules|guardon|inside|full|check|accept|complete)', 'the guard cannot be changed from here')
)

# Returns why `line` is refused, or $null.
function global:DuetCheck([string]$line) {
  if ($PWD.Provider.Name -ne 'FileSystem') { return 'this terminal is not in a folder' }
  foreach ($r in $global:DuetRules) { if ($line -match $r[0]) { return $r[1] } }
  # Drive paths anywhere (also in -Path:C:\x or inside quotes): only inside the project.
  foreach ($m in [regex]::Matches($line, '(?<!\w)[a-z]:([\\/][^\s''"`;|&()<>,]*)?', 'IgnoreCase')) {
    $d = $m.Value
    if ($d.Length -le 2) { return "'$d' (another drive) is outside the project folder" }
    $f = DuetFull $d
    if (-not $f -or -not (DuetInside $f)) { return "'$d' is outside the project folder" }
  }
  $clean = $line -replace '[''"`]', ' '
  foreach ($t in ($clean -split '[\s;|&(){}<>,=]+')) {
    if (-not $t -or $t -match '^[a-z][\w+.\-]*://') { continue }
    if ($t.Contains('..') -or $t.StartsWith('\') -or $t.StartsWith('/') -or $t -match '^[a-z]:') {
      $f = DuetFull $t
      if (-not $f -or -not (DuetInside $f)) { return "'$t' is outside the project folder" }
    }
  }
  return $null
}

function global:DuetBack {
  if ($PWD.Provider.Name -ne 'FileSystem' -or -not (DuetInside $PWD.ProviderPath)) {
    Set-Location -LiteralPath $global:DuetRoot
    return $true
  }
  return $false
}

$global:DuetAccept = {
  param($key, $arg)
  if (DuetGuardOn) {
    $line = $null; $cursor = $null
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    $moved = DuetBack
    $why = DuetCheck $line
    if ($why -or $moved) {
      [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
      [Console]::WriteLine()
      if ($moved) { [Console]::WriteLine("Duet: back in the project folder ($global:DuetRoot).") }
      if ($why) { [Console]::WriteLine("Duet: blocked - $why. The student can only work inside the project folder.") }
      [Microsoft.PowerShell.PSConsoleReadLine]::InvokePrompt()
      return
    }
  }
  [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
}

if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
  $bound = @(Get-PSReadLineKeyHandler -Bound -ErrorAction SilentlyContinue)
  # Every key that runs a line goes through the check.
  $accept = @($bound | Where-Object { $_.Function -in 'AcceptLine', 'AcceptAndGetNext', 'ValidateAndAcceptLine' } | ForEach-Object { $_.Key })
  if ($accept -notcontains 'Enter') { $accept += 'Enter' }
  foreach ($k in $accept) {
    try { Set-PSReadLineKeyHandler -Chord $k -BriefDescription DuetAccept -ScriptBlock $global:DuetAccept } catch {}
  }
  # Completion must not list folders outside the project either.
  foreach ($b in @($bound | Where-Object { $_.Function -in 'TabCompleteNext', 'TabCompletePrevious', 'MenuComplete', 'Complete', 'PossibleCompletions' })) {
    $fn = $b.Function
    $sb = [scriptblock]::Create(@"
param(`$k, `$a)
if (DuetGuardOn) {
  `$l = `$null; `$c = `$null
  [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]`$l, [ref]`$c)
  if (DuetCheck `$l.Substring(0, `$c)) { [Microsoft.PowerShell.PSConsoleReadLine]::Ding(); return }
}
[Microsoft.PowerShell.PSConsoleReadLine]::$fn(`$k, `$a)
"@)
    try { Set-PSReadLineKeyHandler -Chord $b.Key -BriefDescription "Duet$fn" -ScriptBlock $sb } catch {}
  }
  # Tells Duet (pty.rs) the guard is active; without it the student cannot type here.
  [Console]::Write("$([char]27)]633;DuetGuard$([char]7)")
}
