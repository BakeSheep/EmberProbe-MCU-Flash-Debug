param(
    [Parameter(Mandatory=$true)][string]$Workspace,
    [string]$Elf,
    [string]$Target,
    [string]$Probe,
    [string]$OpenOcd,
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
function ConvertTo-TclQuotedWord([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$').Replace('[', '\[').Replace(']', '\]')
    $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n')
    return '"' + $escaped + '"'
}
function Get-FileSha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}
function Get-EmberProbeConfiguration([string]$Root) {
    $configScript = Join-Path $PSScriptRoot '..\..\mcu-config\scripts\config.js'
    if (-not (Test-Path -LiteralPath $configScript -PathType Leaf)) { return $null }
    try {
        $lines = @(& node $configScript --workspace $Root --get 2>$null)
        if ($LASTEXITCODE -ne 0) { return $null }
        $json = $lines | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") } | Select-Object -Last 1
        if (-not $json) { return $null }
        return $json | ConvertFrom-Json -ErrorAction Stop
    } catch { return $null }
}
$root = (Resolve-Path -LiteralPath $Workspace).Path
$emberProbeConfig = Get-EmberProbeConfiguration $root
if (-not $Elf -and $emberProbeConfig.elf) { $Elf = [string]$emberProbeConfig.elf }
if (-not $Target -and $emberProbeConfig.mcu) { $Target = [string]$emberProbeConfig.mcu }
if (-not $Probe -and $emberProbeConfig.debugger) { $Probe = [string]$emberProbeConfig.debugger }
if (-not $OpenOcd -and $emberProbeConfig.openocdPath) { $OpenOcd = [string]$emberProbeConfig.openocdPath }
if (-not $OpenOcd) { $OpenOcd = 'openocd' }
if (-not $Elf) {
    $candidate = Get-ChildItem -LiteralPath $root -Filter *.elf -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '[\\/](node_modules|\.git)[\\/]' } |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($candidate) { $Elf = $candidate.FullName }
}
if (-not $Target) {
    $text = Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.ioc','.cmake','.ld' -or $_.Name -eq 'CMakeLists.txt' } |
        Select-Object -First 80 | ForEach-Object { $_.Name; Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }
    $joined = ($text -join "`n").ToLowerInvariant()
    $rules = [ordered]@{
        'apm32f0'='geehy/apm32f0x.cfg'; 'apm32f1'='geehy/apm32f1x.cfg'; 'apm32f4'='geehy/apm32f4x.cfg';
        'stm32f0'='stm32f0x.cfg'; 'stm32f1'='stm32f1x.cfg'; 'stm32f2'='stm32f2x.cfg'; 'stm32f3'='stm32f3x.cfg';
        'stm32f4'='stm32f4x.cfg'; 'stm32f7'='stm32f7x.cfg'; 'stm32g0'='stm32g0x.cfg'; 'stm32g4'='stm32g4x.cfg';
        'stm32h7'='stm32h7x.cfg'; 'stm32l0'='stm32l0.cfg'; 'stm32l1'='stm32l1.cfg'; 'stm32l4'='stm32l4x.cfg';
        'stm32l5'='stm32l5x.cfg'; 'stm32u5'='stm32u5x.cfg'; 'stm32wb'='stm32wbx.cfg'; 'stm32wl'='stm32wlx.cfg';
        'gd32vf103'='gd32vf103.cfg'; 'gd32e23'='gd32e23x.cfg'; 'nrf51'='nordic/nrf51.cfg'; 'nrf52'='nordic/nrf52.cfg'; 'rp2040'='rp2040.cfg';
        'esp32s3'='esp32s3.cfg'; 'esp32s2'='esp32s2.cfg'; 'esp32'='esp32.cfg'
    }
    foreach ($key in $rules.Keys) { if ($joined.Contains($key)) { $Target = $rules[$key]; break } }
}
if (-not $Probe) {
    $devices = if ($IsLinux) { (& lsusb 2>$null) -join "`n" } elseif ($IsMacOS) { (& system_profiler SPUSBDataType 2>$null) -join "`n" } else {
        $pnp = try { (Get-PnpDevice -PresentOnly -ErrorAction Stop | Select-Object -ExpandProperty FriendlyName) -join "`n" } catch { '' }
        if ($pnp) { $pnp } else { (& pnputil.exe /enum-devices /connected 2>$null) -join "`n" }
    }
    if ($devices -match '(?i)ST-?LINK') { $Probe='stlink.cfg' }
    elseif ($devices -match '(?i)J-?LINK|SEGGER') { $Probe='jlink.cfg' }
    elseif ($devices -match '(?i)CMSIS[- _]?DAP|CMSISDAP|DAPLink|Pico\s?probe|MCU[- ]?Link') { $Probe='cmsis-dap.cfg' }
    elseif ($devices -match '(?i)XDS110') { $Probe='xds110.cfg' }
    elseif ($devices -match '(?i)Nu-?Link') { $Probe='nulink.cfg' }
}
$elfInfo = if ($Elf -and (Test-Path -LiteralPath $Elf -PathType Leaf)) { Get-Item -LiteralPath $Elf } else { $null }
$elfSha256 = if ($elfInfo) { Get-FileSha256 $Elf } else { '' }
$result = [ordered]@{ workspace=$root; elf=$Elf; elfSha256=$elfSha256; elfMtimeUtc=if($elfInfo){$elfInfo.LastWriteTimeUtc.ToString('o')}else{''}; target=$Target; probe=$Probe; openocd=$OpenOcd; ready=[bool]($Elf -and $Target -and $Probe) }
$result | ConvertTo-Json -Compress
if (-not $result.ready) { Write-Error 'Detection incomplete. Provide or select ELF, target, and probe.' }
if (-not (Test-Path -LiteralPath $Elf -PathType Leaf)) { Write-Error "ELF not found: $Elf" }
function Test-SafeCfgPath([string]$Value) {
    if (-not $Value -or $Value -notmatch '\.cfg$' -or $Value.Contains('\') -or $Value.StartsWith('/')) { return $false }
    if ($Value.IndexOf([char]0) -ge 0 -or $Value.IndexOf([char]10) -ge 0 -or $Value.IndexOf([char]13) -ge 0 -or $Value.Contains(':')) { return $false }
    foreach ($part in $Value.Split('/')) {
        if (-not $part -or $part -eq '.' -or $part -eq '..') { return $false }
    }
    return $true
}
if (-not (Test-SafeCfgPath $Target) -or -not (Test-SafeCfgPath $Probe)) { Write-Error 'Unsafe OpenOCD configuration path.' }
if ($Execute) {
    $currentHash = Get-FileSha256 $Elf
    if ($currentHash -ne $elfSha256) { Write-Error 'ELF changed during verify preflight. Retry so the comparison stays consistent.' }
    $elfWord = ConvertTo-TclQuotedWord $Elf.Replace('\','/')
    # 单条 Tcl 块：记录原状态 → 非 halted 则 halt → verify_image → 按原状态 resume → shutdown，
    # EP_VERIFY 标记行用于机器判定结果（verify_image 的比对失败通过 catch 捕获）
    $verify = 'set o [[target current] curstate]; set h 0; if {$o ne "halted"} { if {![catch {halt}]} { set h 1 } }; ' +
        'set rc [catch { verify_image ' + $elfWord + ' } msg]; ' +
        'if {$rc} { echo "EP_VERIFY FAIL $msg" } else { echo "EP_VERIFY OK" }; ' +
        'if {$h} { catch { resume } }; shutdown'
    $output = & $OpenOcd '-f' "interface/$Probe" '-f' "target/$Target" '-c' 'init' '-c' $verify 2>&1 | ForEach-Object { "$_" }
    $output | ForEach-Object { Write-Host $_ }
    $okLine = $output | Where-Object { $_ -match 'EP_VERIFY OK' } | Select-Object -First 1
    $failLine = $output | Where-Object { $_ -match 'EP_VERIFY FAIL' } | Select-Object -First 1
    $verified = [bool]$okLine -and -not $failLine
    $detail = if ($failLine) { ($failLine -replace '^.*EP_VERIFY FAIL\s*', '').Trim() } else { '' }
    [ordered]@{ verified=$verified; elf=$Elf; elfSha256=$elfSha256; detail=$detail } | ConvertTo-Json -Compress
    if (-not $okLine -and -not $failLine) { Write-Error 'OpenOCD did not reach the verification step. Check probe connection and target power.' }
    exit $(if ($verified) { 0 } else { 1 })
}
