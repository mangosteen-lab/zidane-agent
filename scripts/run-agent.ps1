$ErrorActionPreference = "Stop"
$configPath = Join-Path $env:ProgramData "Zidane Agent\environment.json"
$config = Get-Content -Raw $configPath | ConvertFrom-Json
$config.PSObject.Properties | ForEach-Object {
    [Environment]::SetEnvironmentVariable($_.Name, [string]$_.Value, "Process")
}
& "C:\Program Files\nodejs\node.exe" "C:\Program Files\Zidane Agent\src\index.mjs"
exit $LASTEXITCODE
