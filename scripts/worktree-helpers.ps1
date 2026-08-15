# Shared helpers for myteam worktree scripts

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Get-ProjectRoot {
    $ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
    if (-not $ScriptPath) { Write-Err "Could not resolve script path"; exit 1 }
    return (Split-Path -Parent (Split-Path -Parent $ScriptPath))
}

function Get-NodeBin { return (Get-Command node -ErrorAction SilentlyContinue).Source }

function Get-TsxCli {
    $root = Get-ProjectRoot
    $p = Join-Path $root "node_modules\.pnpm\tsx@4.23.12\node_modules\tsx\dist\cli.mjs"
    if (Test-Path $p) { return $p }
    $alt = Join-Path $root "node_modules\.bin\tsx.cmd"
    if (Test-Path $alt) { return $alt }
    return $null
}

function Get-ViteBin {
    $root = Get-ProjectRoot
    $p = Join-Path $root "node_modules\.pnpm\vite@5.4.21\node_modules\vite\bin\vite.js"
    if (Test-Path $p) { return $p }
    $alt = Join-Path $root "node_modules\.bin\vite.cmd"
    if (Test-Path $alt) { return $alt }
    return $null
}

function Get-MyTeamDataDir {
    param([string]$EnvName)
    $home = [System.Environment]::GetFolderPath('UserProfile')
    $base = Join-Path $home ".myteam"
    if ($EnvName -and $EnvName -ne 'default') {
        $dir = Join-Path $base $EnvName
    } else {
        $dir = $base
    }
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return $dir
}

function Stop-PortProcess {
    param([int]$Port, [string]$Name)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($conn in $conns) {
            Write-Warn "Port $Port ($Name) in use by PID $($conn.OwningProcess) - stopping"
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
}

function Test-PortListening {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}
