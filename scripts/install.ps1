<#
.SYNOPSIS
    Zidane agent installer for Windows.

.DESCRIPTION
    irm https://<backend>/install.ps1 | iex
    .\install.ps1 -Url wss://host:17001/ws/agent -Token zdn_...

    Installs into a versioned tree under C:\Program Files\zidane\zidane-agent so an
    upgrade can be rolled back, then registers a Windows service.

    -Interactive registers the agent to run in the logged-on desktop session instead of
    as a service. That is the only way GUI-driving steps work, and it is opt-in because
    it requires a logged-in user.
#>
[CmdletBinding()]
param(
    [string]$Url = $env:ZIDANE_BACKEND_WSS_URL,
    [string]$Token = $env:ZIDANE_BACKEND_API_KEY,
    [string]$Name = $env:COMPUTERNAME,
    [int]$Capacity = 4,
    [string]$Labels = "os=windows",
    [string]$Artifact = $env:ZIDANE_ARTIFACT_URL,
    [string]$Version = "0.1.0",
    [string]$InstallRoot = "$env:ProgramFiles\zidane\zidane-agent",
    [switch]$Interactive,
    [switch]$NoService
)

$ErrorActionPreference = "Stop"

function Info($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Die($message) { Write-Error $message; exit 1 }

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die "run this installer from an elevated PowerShell session"
}

if (-not $Url)   { $Url = Read-Host "Backend WebSocket URL" }
if (-not $Token) { $Token = Read-Host "Registration token" -AsSecureString |
                     ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                         [Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) } }
if (-not $Url)   { Die "-Url is required" }
if (-not $Token) { Die "-Token is required; create one under User tokens" }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Die "python 3.11+ is required and was not found on PATH" }
$minor = & $python -c "import sys; print(sys.version_info[1])"
if ([int]$minor -lt 11) { Die "python 3.11+ is required (found 3.$minor)" }

$versionDir = Join-Path $InstallRoot "versions\$Version"
Info "installing to $InstallRoot (version $Version)"
foreach ($dir in @($versionDir, "$InstallRoot\state", "$InstallRoot\work",
                   "$InstallRoot\logs", "$InstallRoot\conf")) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

if ($Artifact) {
    Info "downloading $Artifact"
    $temp = [IO.Path]::GetTempFileName() + ".zip"
    Invoke-WebRequest -Uri $Artifact -OutFile $temp -UseBasicParsing
    Expand-Archive -Path $temp -DestinationPath $versionDir -Force
    Remove-Item $temp -Force
} else {
    $source = Split-Path -Parent $PSScriptRoot
    Info "installing from $source"
    Copy-Item -Recurse -Force "$source\app" $versionDir
    Copy-Item -Force "$source\pyproject.toml" $versionDir
}

Info "creating the virtualenv"
& $python -m venv "$versionDir\.venv"
& "$versionDir\.venv\Scripts\pip.exe" install --quiet --upgrade pip
& "$versionDir\.venv\Scripts\pip.exe" install --quiet $versionDir

# Junction rather than a symlink: it needs no developer mode or extra privilege.
$current = Join-Path $InstallRoot "current"
if (Test-Path $current) { Remove-Item $current -Force -Recurse }
New-Item -ItemType Junction -Path $current -Target $versionDir | Out-Null

$config = Join-Path $InstallRoot "conf\config.ini"
if (Test-Path $config) {
    Info "keeping the existing $config"
} else {
    Info "writing $config"
    @"
[agent]
name = $Name
capacity = $Capacity
labels = $Labels
auto_upgrade = true
upgrade_channel = stable
state_dir = $InstallRoot\state
workdir_root = $InstallRoot\work
install_root = $InstallRoot

[backend]
wss_url = $Url
api_key = $Token

[logging]
file = $InstallRoot\logs\agent.log
level = INFO
"@ | Set-Content -Path $config -Encoding UTF8

    # The config holds a registration token; keep it off other users.
    $acl = Get-Acl $config
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        "BUILTIN\Administrators", "FullControl", "Allow")))
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        "NT AUTHORITY\SYSTEM", "FullControl", "Allow")))
    Set-Acl $config $acl
}

$exe = "$current\.venv\Scripts\python.exe"
$arguments = "-m app.main --config `"$config`""

if ($NoService) {
    Info "done (no service installed)"
    Write-Host "run: $exe $arguments"
    exit 0
}

if ($Interactive) {
    # Desktop session, not a service — required for GUI-driving steps.
    Info "registering a logon scheduled task (interactive desktop mode)"
    $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $current
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "ZidaneAgent" -Action $action -Trigger $trigger `
        -Settings $settings -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName "ZidaneAgent"
    Info "registered; the agent starts at logon and is running now"
} else {
    Info "registering the Windows service"
    $binPath = "`"$exe`" $arguments"
    sc.exe create ZidaneAgent binPath= $binPath start= auto DisplayName= "Zidane Agent" | Out-Null
    sc.exe description ZidaneAgent "Zidane orchestration worker" | Out-Null
    sc.exe failure ZidaneAgent reset= 60 actions= restart/5000/restart/5000/restart/5000 | Out-Null
    [Environment]::SetEnvironmentVariable("ZIDANE_MANAGED_BY_SERVICE", "1", "Machine")
    Start-Service ZidaneAgent
    Info "installed and started; logs at $InstallRoot\logs\agent.log"
}
