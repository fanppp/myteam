<#
.SYNOPSIS
  myteam unified dev launcher (feature worktree dev mode)

.DESCRIPTION
  Equivalent to clowder-ai's `pnpm dev:direct` (start-dev.sh).
  Launches API (tsx watch) + Web (vite dev) with port isolation.
  Guards: refuses to start on main branch (guard_main_branch_start),
  refuses to kill processes owned by other worktrees (guard_port_kill_ownership).

.EXAMPLE
  .\scripts\start-dev.ps1                # Start dev in current worktree
  .\scripts\start-dev.ps1 -Quick         # Skip build
#>

param([switch]$Quick)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $PSCommandPath
. (Join-Path $ScriptDir "worktree-helpers.ps1")

$ProjectRoot = Get-ProjectRoot

# -- Guard: main branch start --
function Guard-MainBranchStart {
    $branch = git -C $ProjectRoot branch --show-current 2>$null
    $repoName = (Get-Item $ProjectRoot).Name

    if ($branch -eq 'master' -or $branch -eq 'main') {
        if ($env:MYTEAM_ALLOW_MAIN_DEV -ne '1') {
            Write-Err "Refusing to start dev on '$branch' branch of '$repoName'."
            Write-Host "  Use a feature worktree instead:"
            Write-Host "    pnpm feature:create <name>"
            Write-Host "    pnpm feature:start <name>"
            Write-Host ""
            Write-Host "  Or override with MYTEAM_ALLOW_MAIN_DEV=1 (not recommended)."
            exit 1
        } else {
            Write-Warn "MYTEAM_ALLOW_MAIN_DEV=1 set — starting on main (not recommended)"
        }
    }
}

# -- Guard: port kill ownership --
function Guard-PortKillOwnership {
    param([int]$Port, [string]$Name)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { return }

    foreach ($conn in $conns) {
        $pid = $conn.OwningProcess
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pid" -ErrorAction Stop
            $cmdLine = $proc.CommandLine
            if (-not $cmdLine) { continue }

            $normalizedRoot = $ProjectRoot.TrimEnd('\', '/') + '\'
            $isOwned = ($cmdLine -like "*$normalizedRoot*") -or ($cmdLine -like "*$ProjectRoot*")

            if (-not $isOwned) {
                Write-Err "Port $Port ($Name) is in use by PID $pid (cwd outside this worktree)."
                Write-Host "  Refusing to kill — may belong to runtime/alpha or another worktree."
                Write-Host "  Override with MYTEAM_RUNTIME_RESTART_OK=1 (only if you know what you're doing)."
                exit 1
            }

            Write-Warn "Port $Port ($Name) in use by PID $pid (owned) - stopping"
            Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Warn "Could not inspect PID $pid on port $Port — skipping"
        }
    }
    Start-Sleep -Seconds 1
}

# -- Main --
Guard-MainBranchStart

$envName = $env:MYTEAM_ENV ?? 'default'
$apiPort = [int]($env:MYTEAM_API_PORT ?? 3001)
$webPort = [int]($env:MYTEAM_WEB_PORT ?? 5173)
$dataDir = $env:MYTEAM_DB_PATH
if (-not $dataDir) { $dataDir = (Get-MyTeamDataDir -EnvName $envName) }

Write-Step "myteam dev:direct"
Write-Host "  Env:   $envName"
Write-Host "  API:   $apiPort"
Write-Host "  Web:   $webPort"
Write-Host "  DB:    $dataDir"
Write-Host "  Root:  $ProjectRoot"

$nodeBin = Get-NodeBin
$tsxCli = Get-TsxCli
$viteBin = Get-ViteBin

if (-not $tsxCli) { Write-Err "tsx not found"; exit 1 }
if (-not $viteBin) { Write-Err "vite not found"; exit 1 }

# Kill managed ports (with ownership guard)
Guard-PortKillOwnership -Port $apiPort -Name "API"
Guard-PortKillOwnership -Port $webPort -Name "Web"

$env:MYTEAM_ENV = $envName
$env:MYTEAM_API_PORT = $apiPort
$env:MYTEAM_WEB_PORT = $webPort
$env:MYTEAM_DB_PATH = $dataDir

Write-Host "  Starting API (port $apiPort, watch mode)..."
$apiJob = Start-Job -Name "myteam-dev-api" -ScriptBlock {
    param($root, $nodeBin, $tsxCli, $dataDir, $apiPort, $webPort, $envName)
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $env:MYTEAM_ENV = $envName
    $env:MYTEAM_API_PORT = $apiPort
    $env:MYTEAM_WEB_PORT = $webPort
    $env:MYTEAM_DB_PATH = $dataDir
    Set-Location (Join-Path $root "packages/api")
    & $nodeBin $tsxCli watch src/index.ts 2>&1
} -ArgumentList $ProjectRoot, $nodeBin, $tsxCli, $dataDir, $apiPort, $webPort, $envName

Start-Sleep -Seconds 3

Write-Host "  Starting Web (port $webPort, dev mode)..."
$webJob = Start-Job -Name "myteam-dev-web" -ScriptBlock {
    param($root, $nodeBin, $viteBin, $apiPort, $webPort)
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $env:MYTEAM_API_PORT = $apiPort
    $env:MYTEAM_WEB_PORT = $webPort
    Set-Location (Join-Path $root "packages/web")
    & $nodeBin $viteBin --port $webPort --host 2>&1
} -ArgumentList $ProjectRoot, $nodeBin, $viteBin, $apiPort, $webPort

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  myteam dev started!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  Web:  http://localhost:$webPort"
Write-Host "  API:  http://localhost:$apiPort"
Write-Host "  DB:   $dataDir"
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
    Write-Host "`nDev stopped." -ForegroundColor Cyan
}
