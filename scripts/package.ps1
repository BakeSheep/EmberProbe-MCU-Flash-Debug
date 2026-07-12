$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    npm run check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    npm run package
    exit $LASTEXITCODE
}
finally { Pop-Location }
