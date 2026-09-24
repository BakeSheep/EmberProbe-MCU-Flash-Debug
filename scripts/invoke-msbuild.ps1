function Invoke-EmberProbeMsBuild {
    param(
        [Parameter(Mandatory = $true)][string]$Builder,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    # Some extension hosts expose both Path and PATH. MSBuild's tool launcher rejects that
    # inherited environment, so pass a case-insensitive copy with one canonical Path entry.
    $start = [System.Diagnostics.ProcessStartInfo]::new($Builder)
    $start.UseShellExecute = $false
    $start.Environment.Clear()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($key in [Environment]::GetEnvironmentVariables("Process").Keys) {
        $name = [string]$key
        if ($name -ieq "Path") { continue }
        if ($seen.Add($name)) { $start.Environment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
    }
    $start.Environment["Path"] = $env:Path
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    if (-not $process) { throw "Could not start MSBuild" }
    try {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw $FailureMessage }
    } finally {
        $process.Dispose()
    }
}
