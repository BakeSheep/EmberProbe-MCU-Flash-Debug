param([string]$Directory = "resources/driver-helper/win32-x64")

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "invoke-msbuild.ps1")
if (-not $env:EMBERPROBE_SIGNING_PFX_BASE64 -or -not $env:EMBERPROBE_SIGNING_PFX_PASSWORD) {
    throw "Signed driver helper release requires EMBERPROBE_SIGNING_PFX_BASE64 and EMBERPROBE_SIGNING_PFX_PASSWORD"
}
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$output = (Resolve-Path -LiteralPath (Join-Path $repo $Directory)).Path
$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $signTool) { throw "Windows SDK SignTool is unavailable" }
$pfx = Join-Path $env:RUNNER_TEMP "emberprobe-signing.pfx"
$store = "Cert:\CurrentUser\My"
$existingThumbprints = @(Get-ChildItem -Path $store | ForEach-Object Thumbprint)
$importedCertificates = @()
try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:EMBERPROBE_SIGNING_PFX_BASE64))
    $pfxPassword = ConvertTo-SecureString $env:EMBERPROBE_SIGNING_PFX_PASSWORD -AsPlainText -Force
    $env:EMBERPROBE_SIGNING_PFX_BASE64 = $null
    $env:EMBERPROBE_SIGNING_PFX_PASSWORD = $null
    $importedCertificates = @(Import-PfxCertificate -FilePath $pfx -CertStoreLocation $store -Password $pfxPassword)
    $signingCertificates = @($importedCertificates | Where-Object HasPrivateKey)
    if ($signingCertificates.Count -ne 1) { throw "Signing PFX must contain exactly one certificate with a private key" }
    $thumbprint = $signingCertificates[0].Thumbprint
    $library = Join-Path $output "libwdi.dll"
    if (-not (Test-Path -LiteralPath $library)) { throw "Missing native release file: libwdi.dll" }
    & $signTool sign /fd SHA256 /sha1 $thumbprint /s My /tr http://timestamp.digicert.com /td SHA256 $library
    if ($LASTEXITCODE -ne 0) { throw "Signing failed: libwdi.dll" }
    & $signTool verify /pa /tw $library
    if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: libwdi.dll" }

    # The elevated helper pins the exact signed DLL bytes before loading code from the extension directory.
    $libraryHash = (Get-FileHash -LiteralPath $library -Algorithm SHA256).Hash.ToLowerInvariant()
    $header = Join-Path $repo "native/driver-helper/libwdi_hash.h"
    Set-Content -LiteralPath $header -Encoding ascii -Value "#define EMBERPROBE_LIBWDI_SHA256 `"$libraryHash`""
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $installation = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
    if (-not $installation) { throw "MSBuild is unavailable for the pinned helper rebuild" }
    $builder = Join-Path $installation "MSBuild/Current/Bin/MSBuild.exe"
    $toolset = Get-ChildItem -LiteralPath (Join-Path $installation "MSBuild/Microsoft/VC") -Directory -Recurse |
        Where-Object { $_.Parent.Name -eq "PlatformToolsets" -and $_.FullName -match '\\Platforms\\x64\\' -and $_.Name -match '^v14\d$' } |
        Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
    if (-not $toolset) { throw "MSVC x64 platform toolset is unavailable" }
    Invoke-EmberProbeMsBuild $builder @((Join-Path $repo "native/driver-helper/driver-helper.vcxproj"), "/t:Rebuild", "/p:Configuration=Release", "/p:Platform=x64", "/p:PlatformToolset=$toolset") "Pinned driver helper rebuild failed"
    Copy-Item -LiteralPath (Join-Path $repo "native/driver-helper/x64/Release/emberprobe-driver-helper.exe") -Destination $output -Force
    $helper = Join-Path $output "emberprobe-driver-helper.exe"
    if (-not [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($helper)).Contains($libraryHash)) {
        throw "Release helper does not pin the signed libwdi DLL hash"
    }

    foreach ($name in @("emberprobe-driver-helper.exe")) {
        $file = Join-Path $output $name
        if (-not (Test-Path -LiteralPath $file)) { throw "Missing native release file: $name" }
        & $signTool sign /fd SHA256 /sha1 $thumbprint /s My /tr http://timestamp.digicert.com /td SHA256 $file
        if ($LASTEXITCODE -ne 0) { throw "Signing failed: $name" }
        & $signTool verify /pa /tw $file
        if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: $name" }
    }
    $files = @("emberprobe-driver-helper.exe", "libwdi.dll") | ForEach-Object {
        $file = Join-Path $output $_
        @{ name = $_; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    @{ version = 1; files = $files } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output "manifest.json") -Encoding utf8
} finally {
    foreach ($certificate in $importedCertificates) {
        if ($certificate.Thumbprint -notin $existingThumbprints) {
            Remove-Item -LiteralPath (Join-Path $store $certificate.Thumbprint) -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
}
