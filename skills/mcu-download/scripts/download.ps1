param(
    [Parameter(Mandatory=$true)][string]$Workspace,
    [string]$Elf,
    [string]$Target,
    [string]$Probe,
    [string]$OpenOcd = 'openocd',
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
function ConvertTo-TclQuotedWord([string]$Value) {
    $escaped = $Value.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$').Replace('[', '\[').Replace(']', '\]')
    $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n')
    return '"' + $escaped + '"'
}
$root = (Resolve-Path -LiteralPath $Workspace).Path
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
        'stm32f0'='stm32f0x.cfg'; 'stm32f1'='stm32f1x.cfg'; 'stm32f2'='stm32f2x.cfg'; 'stm32f3'='stm32f3x.cfg';
        'stm32f4'='stm32f4x.cfg'; 'stm32f7'='stm32f7x.cfg'; 'stm32g0'='stm32g0x.cfg'; 'stm32g4'='stm32g4x.cfg';
        'stm32h7'='stm32h7x.cfg'; 'stm32l0'='stm32l0.cfg'; 'stm32l1'='stm32l1.cfg'; 'stm32l4'='stm32l4x.cfg';
        'stm32l5'='stm32l5x.cfg'; 'stm32u5'='stm32u5x.cfg'; 'stm32wb'='stm32wbx.cfg'; 'stm32wl'='stm32wlx.cfg';
        'gd32vf103'='gd32vf103.cfg'; 'gd32e23'='gd32e23x.cfg'; 'nrf51'='nrf51.cfg'; 'nrf52'='nrf52.cfg'; 'rp2040'='rp2040.cfg';
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
$elfSha256 = if ($elfInfo) { (Get-FileHash -LiteralPath $Elf -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
$result = [ordered]@{ workspace=$root; elf=$Elf; elfSha256=$elfSha256; elfMtimeUtc=if($elfInfo){$elfInfo.LastWriteTimeUtc.ToString('o')}else{''}; target=$Target; probe=$Probe; openocd=$OpenOcd; ready=[bool]($Elf -and $Target -and $Probe) }
$result | ConvertTo-Json -Compress
if (-not $result.ready) { Write-Error 'Detection incomplete. Provide or select ELF, target, and probe.' }
if (-not (Test-Path -LiteralPath $Elf -PathType Leaf)) { Write-Error "ELF not found: $Elf" }
if ($Target -notmatch '^[^\\/]+\.cfg$' -or $Target -match '\.\.' -or $Probe -notmatch '^[^\\/]+\.cfg$' -or $Probe -match '\.\.') { Write-Error 'Unsafe OpenOCD configuration name.' }
if ($Execute) {
    $currentHash = (Get-FileHash -LiteralPath $Elf -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -ne $elfSha256) { Write-Error 'ELF changed during download preflight. Retry so addresses and firmware stay consistent.' }
    $program = 'program {0} verify reset exit' -f (ConvertTo-TclQuotedWord $Elf.Replace('\','/'))
    & $OpenOcd '-f' "interface/$Probe" '-f' "target/$Target" '-c' $program
    exit $LASTEXITCODE
}
