param(
    [string]$OutputDirectory = "resources/driver-helper/win32-x64"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "invoke-msbuild.ps1")
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$libwdi = Join-Path $repo "native/vendor/libwdi"
$wdk = Join-Path $libwdi "wdk"
$msbuild = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $msbuild)) { throw "Visual Studio Build Tools are required" }
$installation = & $msbuild -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $installation) { throw "MSBuild is unavailable" }
$builder = Join-Path $installation "MSBuild/Current/Bin/MSBuild.exe"
$toolset = Get-ChildItem -LiteralPath (Join-Path $installation "MSBuild/Microsoft/VC") -Directory -Recurse |
    Where-Object { $_.Parent.Name -eq "PlatformToolsets" -and $_.FullName -match '\\Platforms\\x64\\' -and $_.Name -match '^v14\d$' } |
    Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
if (-not $toolset) { throw "MSVC x64 platform toolset is unavailable" }
$installer = Join-Path $wdk "Windows Kits/8.0/redist/wdf/x64/WdfCoInstaller01011.dll"
if (-not (Test-Path -LiteralPath $installer)) {
    New-Item -ItemType Directory -Force -Path $wdk | Out-Null
    $download = Join-Path $env:TEMP "emberprobe-wdk-redist.msi"
    & curl.exe -fL "https://go.microsoft.com/fwlink/p/?LinkID=253170" -o $download
    if ($LASTEXITCODE -ne 0) { throw "WDK redistributable download failed" }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne "29314207814CE9D5D73695F7E9239539CF37C79E750B9D5EA5A5EF5487A583D6") {
        throw "WDK redistributable hash mismatch"
    }
    $packageSignature = Get-AuthenticodeSignature -LiteralPath $download
    if ($packageSignature.Status -ne "Valid" -or $packageSignature.SignerCertificate.Subject -notmatch "Microsoft") {
        throw "WDK redistributable signature verification failed"
    }
    $process = Start-Process -FilePath "msiexec.exe" -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
        "/a", "`"$download`"", "/qn", "TARGETDIR=`"$wdk`""
    )
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $installer)) {
        throw "WDK redistributable extraction failed: $($process.ExitCode)"
    }
}
foreach ($name in @("WdfCoInstaller01011.dll", "winusbcoinstaller2.dll")) {
    $file = Join-Path $wdk "Windows Kits/8.0/redist/wdf/x64/$name"
    if (-not (Test-Path -LiteralPath $file)) { throw "WDK redistributable is incomplete: $name" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Microsoft") {
        throw "WDK redistributable signature verification failed: $name"
    }
}
$wdkRoot = (Resolve-Path -LiteralPath (Join-Path $wdk "Windows Kits/8.0")).Path
$cEscapedWdk = $wdkRoot.Replace('\', '\\')
$configTemplate = Join-Path $libwdi "msvc/config.h.in"
if (-not (Test-Path -LiteralPath $configTemplate)) { throw "Missing config.h template: $configTemplate" }
$configHeader = Join-Path $libwdi "msvc/config.h"
$templateContent = [IO.File]::ReadAllText($configTemplate)
$generatedContent = $templateContent.Replace('@WDK_DIR@', $cEscapedWdk)
[IO.File]::WriteAllText($configHeader, $generatedContent, [Text.Encoding]::ASCII)
if (-not (Test-Path -LiteralPath $configHeader)) { throw "Failed to generate $configHeader" }

$installerProject = Join-Path $libwdi "libwdi/.msvc/installer_x64.vcxproj"
Invoke-EmberProbeMsBuild $builder @($installerProject, "/m", "/p:Configuration=Release", "/p:Platform=x64", "/p:PlatformToolset=$toolset", "/p:SolutionDir=$libwdi/") "libwdi x64 installer build failed"
$embedderProject = Join-Path $libwdi "libwdi/.msvc/embedder.vcxproj"
Invoke-EmberProbeMsBuild $builder @($embedderProject, "/m", "/p:Configuration=Release", "/p:Platform=Win32", "/p:PlatformToolset=$toolset", "/p:SolutionDir=$libwdi/") "libwdi embedder build failed"
$libProject = Join-Path $libwdi "libwdi/.msvc/libwdi_dll.vcxproj"
Invoke-EmberProbeMsBuild $builder @($libProject, "/m", "/p:Configuration=Release", "/p:Platform=x64", "/p:PlatformToolset=$toolset", "/p:EmberProbeStandaloneBuild=true", "/p:SolutionDir=$libwdi/") "libwdi build failed"
$helperProject = Join-Path $repo "native/driver-helper/driver-helper.vcxproj"
$library = Join-Path $libwdi "x64/Release/dll/libwdi.dll"
$hashHeader = Join-Path $repo "native/driver-helper/libwdi_hash.h"
$originalHeader = [IO.File]::ReadAllText($hashHeader)
try {
    $libraryHash = (Get-FileHash -LiteralPath $library -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($hashHeader, "#define EMBERPROBE_LIBWDI_SHA256 `"$libraryHash`"`n", [Text.Encoding]::ASCII)
    Invoke-EmberProbeMsBuild $builder @($helperProject, "/t:Rebuild", "/m", "/p:Configuration=Release", "/p:Platform=x64", "/p:PlatformToolset=$toolset") "Driver helper build failed"
} finally {
    [IO.File]::WriteAllText($hashHeader, $originalHeader, [Text.Encoding]::ASCII)
}
$output = Join-Path $repo $OutputDirectory
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath $library -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $repo "native/driver-helper/x64/Release/emberprobe-driver-helper.exe") -Destination $output -Force
$helper = Join-Path $output "emberprobe-driver-helper.exe"
if (-not [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($helper)).Contains($libraryHash)) {
    throw "Development helper does not pin the bundled libwdi DLL hash"
}
& $helper status 'USB\VID_1366&PID_FFFF\UNKNOWN'
if ($LASTEXITCODE -ne 3) { throw "Driver helper rejected-device smoke test failed" }
& $helper arbitrary 'USB\VID_1366&PID_0101\TEST'
if ($LASTEXITCODE -ne 2) { throw "Driver helper rejected-action smoke test failed" }
$inventoryJson = & $helper list
if ($LASTEXITCODE -ne 0 -or -not $inventoryJson.TrimStart().StartsWith("[")) {
    throw "Driver helper read-only inventory smoke test failed"
}
$null = ConvertFrom-Json -InputObject $inventoryJson
Get-ChildItem -LiteralPath $output | Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash
