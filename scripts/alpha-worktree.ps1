<#
.SYNOPSIS
  myteam Alpha environment manager (staging/test, mirrors origin/main)

.DESCRIPTION
  Alpha is for verifying already-merged changes. Not for development.
  All development happens in feature worktrees.

.EXAMPLE
  .\scripts\alpha-worktree.ps1 init     # Create alpha worktree
  .\scripts\alpha-worktree.ps1 sync     # Sync from origin/main (ff-only)
  .\scripts\alpha-worktree.ps1 start    # Start API+Web (watch mode)
  .\scripts\alpha-worktree.ps1 status   # Show status
#>

param([string]$Action = 'status')

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $PSCommandPath
. (Join-Path $ScriptDir "worktree-helpers.ps1")

$ProjectRoot = Get-ProjectRoot
$AlphaDir = Join-Path (Split-Path -Parent $ProjectRoot) "myteam-alpha"
$Branch = "alpha/main-sync"
$ApiPort = 3011
$WebPort = 5183
$EnvName = "alpha"

function Invoke-AlphaInit {
    Write-Step "Alpha init"
    if (Test-Path $AlphaDir) {
        $wt = git -C $AlphaDir rev-parse --is-inside-work-tree 2>$null
        if ($wt -eq 'true') { Write-Ok "Alpha worktree already exists at $AlphaDir"; return }
    }
    Write-Host "  Fetching origin/main..."
    git -C $ProjectRoot fetch origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git fetch failed"; exit 1 }
    Write-Host "  Creating worktree at $AlphaDir on branch $Branch..."
    git -C $ProjectRoot worktree add "$AlphaDir" -b $Branch origin/main
    if ($LASTEXITCODE -ne 0) { Write-Err "git worktree add failed"; exit 1 }
    Write-Host "  Installing dependencies..."
    Push-Location $AlphaDir
    try { pnpm install } catch { Write-Warn "pnpm install failed" }
    Pop-Location
    Write-Ok "Alpha worktree created at $AlphaDir"
}

function Invoke-AlphaSync {
    Write-Step "Alpha sync (ff-only from origin/main)"
    if (-not (Test-Path $AlphaDir)) { Write-Err "Alpha worktree not found. Run 'init' first."; exit 1 }
    git -C $ProjectRoot fetch origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git fetch failed"; exit 1 }
    git -C $AlphaDir merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) {
        Write-Err "ff-only merge failed. Alpha has local changes or diverged."
        Write-Host "  Reset: git -C $AlphaDir reset --hard origin/main"
        exit 1
    }
    Write-Ok "Alpha synced to origin/main"
}

function Invoke-AlphaStart {
    Write-Step "Alpha start"
    if (-not (Test-Path $AlphaDir)) { Write-Err "Alpha worktree not found. Run 'init' first."; exit 1 }

    $dataDir = Get-MyTeamDataDir -EnvName $EnvName
    $nodeBin = Get-NodeBin
    $tsxCli = Get-TsxCli
    $viteBin = Get-ViteBin

    if (-not $tsxCli) { Write-Err "tsx not found"; exit 1 }
    if (-not $viteBin) { Write-Err "vite not found"; exit 1 }

    Stop-PortProcess -Port $ApiPort -Name "Alpha API"
    Stop-PortProcess -Port $WebPort -Name "Alpha Web"

    Write-Host "  Starting API (port $ApiPort, watch mode)..."
    $apiJob = Start-Job -Name "myteam-alpha-api" -ScriptBlock {
        param($root, $nodeBin, $tsxCli, $dataDir, $ApiPort, $WebPort, $EnvName)
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $env:MYTEAM_ENV = $EnvName
        $env:MYTEAM_API_PORT = $ApiPort
        $env:MYTEAM_WEB_PORT = $WebPort
        $env:MYTEAM_DB_PATH = $dataDir
        Set-Location (Join-Path $root "packages/api")
        & $nodeBin $tsxCli watch src/index.ts 2>&1
    } -ArgumentList $AlphaDir, $nodeBin, $tsxCli, $dataDir, $ApiPort, $WebPort, $EnvName

    Start-Sleep -Seconds 3

    Write-Host "  Starting Web (port $WebPort, dev mode)..."
    $webJob = Start-Job -Name "myteam-alpha-web" -ScriptBlock {
        param($root, $nodeBin, $viteBin, $ApiPort, $WebPort)
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $env:MYTEAM_API_PORT = $ApiPort
        $env:MYTEAM_WEB_PORT = $WebPort
        Set-Location (Join-Path $root "packages/web")
        & $nodeBin $viteBin --port $WebPort --host 2>&1
    } -ArgumentList $AlphaDir, $nodeBin, $viteBin, $ApiPort, $WebPort

    Start-Sleep -Seconds 3

    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  myteam alpha started!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Web:  http://localhost:$WebPort"
    Write-Host "  API:  http://localhost:$ApiPort"
    Write-Host "  DB:   $dataDir"
    Write-Host "  Dir:  $AlphaDir"
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
        Write-Host "`nAlpha stopped." -ForegroundColor Cyan
    }
}

function Invoke-AlphaStatus {
    Write-Step "Alpha status"
    Write-Host "  Worktree: $AlphaDir"
    if (Test-Path $AlphaDir) {
        $branch = git -C $AlphaDir branch --show-current 2>$null
        $commit = git -C $AlphaDir rev-parse --short HEAD 2>$null
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

switch ($Action) {
    'init'   { Invoke-AlphaInit }
    'sync'   { Invoke-AlphaSync }
    'start'  { Invoke-AlphaStart }
    'status' { Invoke-AlphaStatus }
    default  { Write-Err "Unknown action: $Action. Use: init, sync, start, status"; exit 1 }
}
