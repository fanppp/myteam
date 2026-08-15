<#
.SYNOPSIS
  myteam Runtime environment manager (production-like, passive-freeze)

.DESCRIPTION
  Runtime is the online service. Never auto-restart. Never modify code directly.
  All changes must go through feature -> PR -> main -> runtime sync.

.EXAMPLE
  .\scripts\runtime-worktree.ps1 init     # Create runtime worktree
  .\scripts\runtime-worktree.ps1 sync     # Sync from origin/main (ff-only)
  .\scripts\runtime-worktree.ps1 start    # Start API+Web (no watch)
  .\scripts\runtime-worktree.ps1 status   # Show status
  .\scripts\runtime-worktree.ps1 stop     # Stop services
#>

param([string]$Action = 'status')

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $PSCommandPath
. (Join-Path $ScriptDir "worktree-helpers.ps1")

$ProjectRoot = Get-ProjectRoot
$RuntimeDir = Join-Path (Split-Path -Parent $ProjectRoot) "myteam-runtime"
$Branch = "runtime/main-sync"
$ApiPort = 3001
$WebPort = 5173
$EnvName = "runtime"

function Invoke-RuntimeInit {
    Write-Step "Runtime init"
    if (Test-Path $RuntimeDir) {
        $wt = git -C $RuntimeDir rev-parse --is-inside-work-tree 2>$null
        if ($wt -eq 'true') {
            Write-Ok "Runtime worktree already exists at $RuntimeDir"
            return
        }
    }
    Write-Host "  Fetching origin/main..."
    git -C $ProjectRoot fetch origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git fetch failed"; exit 1 }
    Write-Host "  Creating worktree at $RuntimeDir on branch $Branch..."
    git -C $ProjectRoot worktree add "$RuntimeDir" -b $Branch origin/main
    if ($LASTEXITCODE -ne 0) { Write-Err "git worktree add failed"; exit 1 }
    Write-Host "  Installing dependencies..."
    Push-Location $RuntimeDir
    try { pnpm install } catch { Write-Warn "pnpm install failed" }
    Pop-Location
    Write-Ok "Runtime worktree created at $RuntimeDir"
}

function Invoke-RuntimeSync {
    Write-Step "Runtime sync (ff-only from origin/main)"
    if (-not (Test-Path $RuntimeDir)) { Write-Err "Runtime worktree not found. Run 'init' first."; exit 1 }
    git -C $ProjectRoot fetch origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git fetch failed"; exit 1 }
    git -C $RuntimeDir merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) {
        Write-Err "ff-only merge failed. Runtime has local changes or diverged."
        Write-Host "  Resolve manually or reset: git -C $RuntimeDir reset --hard origin/main"
        exit 1
    }
    Write-Ok "Runtime synced to origin/main"
}

function Invoke-RuntimeStart {
    Write-Step "Runtime start"
    if (-not (Test-Path $RuntimeDir)) { Write-Err "Runtime worktree not found. Run 'init' first."; exit 1 }

    $dataDir = Get-MyTeamDataDir -EnvName $EnvName
    $nodeBin = Get-NodeBin
    $tsxCli = Get-TsxCli
    $viteBin = Get-ViteBin

    if (-not $tsxCli) { Write-Err "tsx not found"; exit 1 }
    if (-not $viteBin) { Write-Err "vite not found"; exit 1 }

    if (Test-PortListening -Port $ApiPort) {
        if ($env:MYTEAM_RUNTIME_RESTART_OK -ne '1') {
            Write-Err "Port $ApiPort (API) is in use. Runtime is a production service."
            Write-Host "  Set MYTEAM_RUNTIME_RESTART_OK=1 to override."
            exit 1
        }
        Stop-PortProcess -Port $ApiPort -Name "API"
    }
    if (Test-PortListening -Port $WebPort) {
        if ($env:MYTEAM_RUNTIME_RESTART_OK -ne '1') {
            Write-Err "Port $WebPort (Web) is in use. Runtime is a production service."
            Write-Host "  Set MYTEAM_RUNTIME_RESTART_OK=1 to override."
            exit 1
        }
        Stop-PortProcess -Port $WebPort -Name "Web"
    }

    $env:MYTEAM_ENV = $EnvName
    $env:MYTEAM_API_PORT = $ApiPort
    $env:MYTEAM_WEB_PORT = $WebPort
    $env:MYTEAM_DB_PATH = $dataDir

    Write-Host "  Starting API (port $ApiPort, no watch)..."
    $apiJob = Start-Job -Name "myteam-runtime-api" -ScriptBlock {
        param($root, $nodeBin, $tsxCli, $dataDir, $ApiPort, $WebPort, $EnvName)
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $env:MYTEAM_ENV = $EnvName
        $env:MYTEAM_API_PORT = $ApiPort
        $env:MYTEAM_WEB_PORT = $WebPort
        $env:MYTEAM_DB_PATH = $dataDir
        Set-Location (Join-Path $root "packages/api")
        & $nodeBin $tsxCli src/index.ts 2>&1
    } -ArgumentList $RuntimeDir, $nodeBin, $tsxCli, $dataDir, $ApiPort, $WebPort, $EnvName

    Start-Sleep -Seconds 3

    Write-Host "  Starting Web (port $WebPort)..."
    $webJob = Start-Job -Name "myteam-runtime-web" -ScriptBlock {
        param($root, $nodeBin, $viteBin, $ApiPort, $WebPort)
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $env:MYTEAM_API_PORT = $ApiPort
        $env:MYTEAM_WEB_PORT = $WebPort
        Set-Location (Join-Path $root "packages/web")
        & $nodeBin $viteBin --port $WebPort --host 2>&1
    } -ArgumentList $RuntimeDir, $nodeBin, $viteBin, $ApiPort, $WebPort

    Start-Sleep -Seconds 3

    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  myteam runtime started!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Web:  http://localhost:$WebPort"
    Write-Host "  API:  http://localhost:$ApiPort"
    Write-Host "  DB:   $dataDir"
    Write-Host "  Dir:  $RuntimeDir"
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
        Write-Host "`nRuntime stopped." -ForegroundColor Cyan
    }
}

function Invoke-RuntimeStatus {
    Write-Step "Runtime status"
    Write-Host "  Worktree: $RuntimeDir"
    if (Test-Path $RuntimeDir) {
        $branch = git -C $RuntimeDir branch --show-current 2>$null
        $commit = git -C $RuntimeDir rev-parse --short HEAD 2>$null
        Write-Ok "Exists (branch=$branch, commit=$commit)"
    } else {
        Write-Warn "Not initialized. Run 'init' first."
    }
    $apiUp = Test-PortListening -Port $ApiPort
    $webUp = Test-PortListening -Port $WebPort
    Write-Host "  API ($ApiPort): $(if ($apiUp) {'RUNNING'} else {'stopped'})"
    Write-Host "  Web ($WebPort): $(if ($webUp) {'RUNNING'} else {'stopped'})"
    $dataDir = Get-MyTeamDataDir -EnvName $EnvName
    Write-Host "  DB: $dataDir\data.sqlite"
}

function Invoke-RuntimeStop {
    Write-Step "Stopping runtime services"
    Stop-PortProcess -Port $ApiPort -Name "API"
    Stop-PortProcess -Port $WebPort -Name "Web"
    Get-Job -Name "myteam-runtime-*" -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Job -Job $_ -ErrorAction SilentlyContinue
        Remove-Job -Job $_ -Force -ErrorAction SilentlyContinue
    }
    Write-Ok "Runtime services stopped"
}

switch ($Action) {
    'init'   { Invoke-RuntimeInit }
    'sync'   { Invoke-RuntimeSync }
    'start'  { Invoke-RuntimeStart }
    'status' { Invoke-RuntimeStatus }
    'stop'   { Invoke-RuntimeStop }
    default  { Write-Err "Unknown action: $Action. Use: init, sync, start, status, stop"; exit 1 }
}
