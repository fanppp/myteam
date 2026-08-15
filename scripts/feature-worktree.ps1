<#
.SYNOPSIS
  myteam Feature environment manager (development worktrees)

.DESCRIPTION
  All code changes happen in feature worktrees. After completion, PR to main.
  Runtime and alpha cannot be modified directly.

.EXAMPLE
  .\scripts\feature-worktree.ps1 create myfeature   # Create worktree
  .\scripts\feature-worktree.ps1 start myfeature    # Start dev servers
  .\scripts\feature-worktree.ps1 list               # List all worktrees
  .\scripts\feature-worktree.ps1 remove myfeature  # Remove worktree
#>

param(
    [string]$Action = 'list',
    [string]$FeatureName
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $PSCommandPath
. (Join-Path $ScriptDir "worktree-helpers.ps1")

$ProjectRoot = Get-ProjectRoot

function Get-FeatureDir { param([string]$name) return (Join-Path (Split-Path -Parent $ProjectRoot) "myteam-$name") }
function Get-FeatureOffset { param([string]$name)
    $hash = 0
    foreach ($c in $name.ToCharArray()) { $hash = ($hash * 31 + [int]$c) % 100 }
    $offset = -($hash % 10 + 1) * 10
    return $offset
}

function Invoke-FeatureCreate {
    param([string]$name)
    if (-not $name) { Write-Err "Feature name required: feature-worktree.ps1 create <name>"; exit 1 }
    $dir = Get-FeatureDir $name
    $branch = "feat/$name"

    if (Test-Path $dir) { Write-Err "Directory already exists: $dir"; exit 1 }

    Write-Step "Feature create: $name"
    Write-Host "  Syncing from origin/main..."
    git -C $ProjectRoot fetch origin main
    if ($LASTEXITCODE -ne 0) { Write-Warn "git fetch failed, using local master" }
    $baseRef = if ($LASTEXITCODE -eq 0) { 'origin/main' } else { 'master' }

    Write-Host "  Creating worktree at $dir on branch $branch..."
    git -C $ProjectRoot worktree add "$dir" -b $branch $baseRef
    if ($LASTEXITCODE -ne 0) { Write-Err "git worktree add failed"; exit 1 }

    Write-Host "  Installing dependencies..."
    Push-Location $dir
    try { pnpm install } catch { Write-Warn "pnpm install failed" }
    Pop-Location

    $offset = Get-FeatureOffset $name
    $apiPort = 3102 - $offset
    $webPort = 5102 - $offset
    $envName = "feature-$name"
    $dataDir = Get-MyTeamDataDir -EnvName $envName

    Write-Host "  Writing .env (offset=$offset, API=$apiPort, Web=$webPort)..."
    $envContent = @"
MYTEAM_ENV=$envName
MYTEAM_API_PORT=$apiPort
MYTEAM_WEB_PORT=$webPort
MYTEAM_DB_PATH=$dataDir
WORKTREE_PORT_OFFSET=$offset
"@
    Set-Content -Path (Join-Path $dir ".env") -Value $envContent -Encoding UTF8

    Write-Ok "Feature '$name' created at $dir (offset=$offset)"
    Write-Host "  Branch: $branch"
    Write-Host "  Ports: API=$apiPort Web=$webPort"
    Write-Host "  Start: pnpm feature:start $name"
}

function Invoke-FeatureStart {
    param([string]$name)
    if (-not $name) { Write-Err "Feature name required: feature-worktree.ps1 start <name>"; exit 1 }
    $dir = Get-FeatureDir $name
    if (-not (Test-Path $dir)) { Write-Err "Feature worktree not found: $dir"; exit 1 }

    # Load .env from worktree
    $envFile = Join-Path $dir ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $parts = $line -split "=", 2
                if ($parts.Count -eq 2) {
                    $key = $parts[0].Trim()
                    $val = $parts[1].Trim().Trim('"').Trim("'")
                    [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
                }
            }
        }
        Write-Ok ".env loaded from $envFile"
    } else {
        Write-Warn ".env not found, deriving ports from name"
        $offset = Get-FeatureOffset $name
        $env:MYTEAM_ENV = "feature-$name"
        $env:MYTEAM_API_PORT = 3102 - $offset
        $env:MYTEAM_WEB_PORT = 5102 - $offset
        $env:MYTEAM_DB_PATH = (Get-MyTeamDataDir -EnvName "feature-$name")
    }

    # Delegate to start-dev.ps1 (runs in worktree dir, has guards)
    $startScript = Join-Path $ScriptDir "start-dev.ps1"
    & powershell -ExecutionPolicy Bypass -File $startScript -Quick
}

function Invoke-FeatureList {
    Write-Step "Feature worktrees"
    $worktrees = git -C $ProjectRoot worktree list 2>$null
    $features = $worktrees | Where-Object { $_ -match 'myteam-(?!runtime|alpha)' }
    if (-not $features) {
        Write-Host "  No feature worktrees found."
        Write-Host "  Create one: .\scripts\feature-worktree.ps1 create <name>"
        return
    }
    foreach ($wt in $features) {
        $parts = $wt -split '\s+'
        $dir = $parts[0]
        $branch = $parts[2]
        $name = [System.IO.Path]::GetFileName($dir) -replace '^myteam-', ''

        # Read ports from .env
        $envFile = Join-Path $dir ".env"
        $apiPort = $null; $webPort = $null
        if (Test-Path $envFile) {
            Get-Content $envFile | ForEach-Object {
                if ($_ -match '^MYTEAM_API_PORT=(\d+)') { $apiPort = $Matches[1] }
                if ($_ -match '^MYTEAM_WEB_PORT=(\d+)') { $webPort = $Matches[1] }
            }
        }
        if (-not $apiPort -or -not $webPort) {
            $offset = Get-FeatureOffset $name
            $apiPort = 3102 - $offset
            $webPort = 5102 - $offset
        }

        $running = Test-PortListening -Port $apiPort
        Write-Host "  $name" -ForegroundColor $(if ($running) {'Green'} else {'Gray'})
        Write-Host "    dir:    $dir"
        Write-Host "    branch: $branch"
        Write-Host "    ports:  API=$apiPort Web=$webPort"
        Write-Host "    status: $(if ($running) {'RUNNING'} else {'stopped'})"
    }
}

function Invoke-FeatureRemove {
    param([string]$name)
    if (-not $name) { Write-Err "Feature name required: feature-worktree.ps1 remove <name>"; exit 1 }
    $dir = Get-FeatureDir $name
    if (-not (Test-Path $dir)) { Write-Err "Feature worktree not found: $dir"; exit 1 }

    Write-Step "Removing feature: $name"
    # Read ports from .env
    $envFile = Join-Path $dir ".env"
    $apiPort = $null; $webPort = $null
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^MYTEAM_API_PORT=(\d+)') { $apiPort = [int]$Matches[1] }
            if ($_ -match '^MYTEAM_WEB_PORT=(\d+)') { $webPort = [int]$Matches[1] }
        }
    }
    if (-not $apiPort -or -not $webPort) {
        $offset = Get-FeatureOffset $name
        $apiPort = 3102 - $offset
        $webPort = 5102 - $offset
    }
    Stop-PortProcess -Port $apiPort -Name "Feature API"
    Stop-PortProcess -Port $webPort -Name "Feature Web"

    git -C $ProjectRoot worktree remove "$dir" --force
    if ($LASTEXITCODE -ne 0) { Write-Warn "git worktree remove failed, trying manual cleanup"; Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }

    $branch = "feat/$name"
    git -C $ProjectRoot branch -D $branch 2>$null
    Write-Ok "Feature '$name' removed"
}

switch ($Action) {
    'create' { Invoke-FeatureCreate -name $FeatureName }
    'start'  { Invoke-FeatureStart -name $FeatureName }
    'list'   { Invoke-FeatureList }
    'remove' { Invoke-FeatureRemove -name $FeatureName }
    default  { Write-Err "Unknown action: $Action. Use: create, start, list, remove"; exit 1 }
}
