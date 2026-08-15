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
    Write-Ok "Feature '$name' created at $dir (offset=$offset)"
    Write-Host "  Branch: $branch"
    Write-Host "  Start with: .\scripts\feature-worktree.ps1 start $name"
}

function Invoke-FeatureStart {
    param([string]$name)
    if (-not $name) { Write-Err "Feature name required: feature-worktree.ps1 start <name>"; exit 1 }
    $dir = Get-FeatureDir $name
    if (-not (Test-Path $dir)) { Write-Err "Feature worktree not found: $dir"; exit 1 }

    $offset = Get-FeatureOffset $name
    $envName = "feature-$name"
    $dataDir = Get-MyTeamDataDir -EnvName $envName

    Write-Step "Feature start: $name (offset=$offset)"

    $deriveResult = node -e "
        const { deriveWorktreePorts } = require(join(process.argv[1], '..', 'scripts', 'derive-ports.mjs'));
        try {
            const ports = deriveWorktreePorts($offset);
            console.log(ports.api + ' ' + ports.web);
        } catch(e) { console.error(e.message); process.exit(1); }
    " "$ProjectRoot" 2>&1
    # Fallback if require doesn't work with ESM
    if ($LASTEXITCODE -ne 0 -or -not $deriveResult) {
        $apiPort = 3102 - $offset
        $webPort = 5102 - $offset
    } else {
        $parts = $deriveResult -split ' '
        $apiPort = [int]$parts[0]
        $webPort = [int]$parts[1]
    }

    $nodeBin = Get-NodeBin
    $tsxCli = Get-TsxCli
    $viteBin = Get-ViteBin

    if (-not $tsxCli) { Write-Err "tsx not found"; exit 1 }
    if (-not $viteBin) { Write-Err "vite not found"; exit 1 }

    Stop-PortProcess -Port $apiPort -Name "Feature API"
    Stop-PortProcess -Port $webPort -Name "Feature Web"

    Write-Host "  Starting API (port $apiPort, watch mode)..."
    $apiJob = Start-Job -Name "myteam-feature-$name-api" -ScriptBlock {
        param($root, $nodeBin, $tsxCli, $dataDir, $apiPort, $webPort, $envName)
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $env:MYTEAM_ENV = $envName
        $env:MYTEAM_API_PORT = $apiPort
        $env:MYTEAM_WEB_PORT = $webPort
        $env:MYTEAM_DB_PATH = $dataDir
        Set-Location (Join-Path $root "packages/api")
        & $nodeBin $tsxCli watch src/index.ts 2>&1
    } -ArgumentList $dir, $nodeBin, $tsxCli, $dataDir, $apiPort, $webPort, $envName

    Start-Sleep -Seconds 3

    Write-Host "  Starting Web (port $webPort, dev mode)..."
    $webJob = Start-Job -Name "myteam-feature-$name-web" -ScriptBlock {
        param($root, $nodeBin, $viteBin, $apiPort, $webPort)
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $env:MYTEAM_API_PORT = $apiPort
        $env:MYTEAM_WEB_PORT = $webPort
        Set-Location (Join-Path $root "packages/web")
        & $nodeBin $viteBin --port $webPort --host 2>&1
    } -ArgumentList $dir, $nodeBin, $viteBin, $apiPort, $webPort

    Start-Sleep -Seconds 3

    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  myteam feature '$name' started!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Web:  http://localhost:$webPort"
    Write-Host "  API:  http://localhost:$apiPort"
    Write-Host "  DB:   $dataDir"
    Write-Host "  Dir:  $dir"
    Write-Host ""
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
    Write-Host ""

    $jobs = @($apiJob, $webJob)
    try {
        while ($true) {
            foreach ($job in $jobs) {
                $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
                if ($output) { $output | ForEach-Object { Write-Host $_ } }
            }
            $stopped = $jobs | Where-Object { $_.State -ne 'Running' }
            if ($stopped.Count -gt 0) {
                foreach ($job in $stopped) { Write-Warn "Job '$($job.Name)' stopped ($($job.State))" }
                break
            }
            Start-Sleep -Seconds 2
        }
    } finally {
        foreach ($job in $jobs) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        Write-Host "`nFeature '$name' stopped." -ForegroundColor Cyan
    }
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
        $offset = Get-FeatureOffset $name
        $apiPort = 3102 - $offset
        $webPort = 5102 - $offset
        $running = Test-PortListening -Port $apiPort
        Write-Host "  $name" -ForegroundColor $(if ($running) {'Green'} else {'Gray'})
        Write-Host "    dir:   $dir"
        Write-Host "    branch: $branch"
        Write-Host "    ports: API=$apiPort Web=$webPort"
        Write-Host "    status: $(if ($running) {'RUNNING'} else {'stopped'})"
    }
}

function Invoke-FeatureRemove {
    param([string]$name)
    if (-not $name) { Write-Err "Feature name required: feature-worktree.ps1 remove <name>"; exit 1 }
    $dir = Get-FeatureDir $name
    if (-not (Test-Path $dir)) { Write-Err "Feature worktree not found: $dir"; exit 1 }

    Write-Step "Removing feature: $name"
    $offset = Get-FeatureOffset $name
    $apiPort = 3102 - $offset
    $webPort = 5102 - $offset
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
