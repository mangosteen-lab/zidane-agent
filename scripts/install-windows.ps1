param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [Parameter(Mandatory = $true)][string]$ApiKey,
    [Parameter(Mandatory = $true)][string]$WinSWPath,
    [string]$AgentName = $env:COMPUTERNAME,
    [int]$Capacity = 1
)
$ErrorActionPreference = "Stop"
$nodeMajor = [int]((& "C:\Program Files\nodejs\node.exe" --version) -replace '^v([0-9]+).*$', '$1')
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required." }
$source = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$install = Join-Path $env:ProgramFiles "Zidane Agent"
$data = Join-Path $env:ProgramData "Zidane Agent"
New-Item -ItemType Directory -Force $install, $data | Out-Null
Copy-Item -Recurse -Force (Join-Path $source "src") $install
Copy-Item -Force (Join-Path $source "package.json"), (Join-Path $source "package-lock.json") $install
Copy-Item -Force (Join-Path $source "scripts\run-agent.ps1") $install
Push-Location $install
npm.cmd ci --omit=dev
Pop-Location
$environment = @{
    ZIDANE_AGENT_SERVER_URL = $ServerUrl
    ZIDANE_AGENT_API_KEY = $ApiKey
    ZIDANE_AGENT_NAME = $AgentName
    ZIDANE_AGENT_DESCRIPTION = "Autonomous Pi coding agent"
    ZIDANE_AGENT_CAPACITY = [string]$Capacity
    ZIDANE_AGENT_WORKING_DIRECTORY = $data
}
$environment | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $data "environment.json")
icacls.exe $data /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
Copy-Item -Force $WinSWPath (Join-Path $install "zidane-agent.exe")
Copy-Item -Force (Join-Path $source "services\zidane-agent.xml") (Join-Path $install "zidane-agent.xml")
& (Join-Path $install "zidane-agent.exe") install
& (Join-Path $install "zidane-agent.exe") start
Write-Host "Zidane Agent Windows service installed and started."
