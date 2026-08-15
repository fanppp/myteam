<#
.SYNOPSIS
  myteam feature PR flow — push + create PR + (after merge) cleanup

.DESCRIPTION
  Equivalent to clowder-ai's merge-gate skill (simplified).
  Flow: push feature branch → create PR → wait for merge → sync main → cleanup worktree.

.EXAMPLE
  .\scripts\feature-pr.ps1 dev-fixes              # Push + create PR
  .\scripts\feature-pr.ps1 dev-fixes -Merge       # Merge + cleanup (after review)
  .\scripts\feature-pr.ps1 dev-fixes -Status      # Check PR status
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$FeatureName,
    [switch]$Merge,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $PSCommandPath
. (Join-Path $ScriptDir "worktree-helpers.ps1")

$ProjectRoot = Get-ProjectRoot
$FeatureDir = Get-FeatureDir $FeatureName
$Branch = "feat/$FeatureName"

if (-not (Test-Path $FeatureDir)) {
    Write-Err "Feature worktree not found: $FeatureDir"
    Write-Host "  Create first: pnpm feature:create $FeatureName"
    exit 1
}

# -- PR create flow --
if (-not $Merge -and -not $Status) {
    Write-Step "PR create: $FeatureName"

    # Check for uncommitted changes
    $dirty = git -C $FeatureDir status --porcelain 2>$null
    if ($dirty) {
        Write-Err "Uncommitted changes in feature worktree."
        Write-Host "  Commit first:"
        Write-Host "    cd $FeatureDir"
        Write-Host "    git add -A && git commit -m `"feat: ...`""
        exit 1
    }

    # Push branch
    Write-Host "  Pushing $Branch to origin..."
    git -C $FeatureDir push -u origin "$Branch" 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Err "git push failed"
        exit 1
    }
    Write-Ok "Pushed $Branch"

    # Create PR
    Write-Host "  Creating PR..."
    $prTitle = "feat: $FeatureName"

    # Get last commit message for PR body
    $commitMsg = git -C $FeatureDir log -1 --format="%B" 2>$null

    $prBody = @"
## Summary

$commitMsg

## Changes

$(git -C $FeatureDir diff origin/main --stat 2>$null)

## Checklist

- [ ] Code changes are in feature worktree (not runtime)
- [ ] No direct modifications to runtime/alpha worktrees
- [ ] Pre-commit hooks passed
- [ ] Ready for review
"@

    $prUrl = gh pr create --repo "fanppp/myteam" --base main --head $Branch --title $prTitle --body $prBody 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "gh pr create failed (may already exist)"
        Write-Host "  Check existing PRs: gh pr list --repo fanppp/myteam"
    } else {
        Write-Ok "PR created: $prUrl"
    }
}

# -- PR status flow --
if ($Status) {
    Write-Step "PR status: $FeatureName"
    gh pr list --repo "fanppp/myteam" --head $Branch --json number,title,state,url 2>$null | ForEach-Object { Write-Host $_ }
}

# -- Merge + cleanup flow --
if ($Merge) {
    Write-Step "Merge + cleanup: $FeatureName"

    # Find PR number
    $prJson = gh pr list --repo "fanppp/myteam" --head $Branch --json number,state 2>$null | ConvertFrom-Json
    if (-not $prJson -or $prJson.Count -eq 0) {
        Write-Err "No PR found for branch $Branch"
        Write-Host "  Create first: pnpm feature:pr $FeatureName"
        exit 1
    }

    $prNumber = $prJson[0].number
    $prState = $prJson[0].state

    if ($prState -ne 'OPEN') {
        Write-Warn "PR #$prNumber is $prState (not OPEN)"
    }

    # Squash merge
    Write-Host "  Squash merging PR #$prNumber..."
    gh pr merge $prNumber --repo "fanppp/myteam" --squash --delete-branch 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Err "PR merge failed"
        exit 1
    }
    Write-Ok "PR #$prNumber merged"

    # Sync main
    Write-Host "  Syncing main repo..."
    git -C $ProjectRoot fetch origin main
    git -C $ProjectRoot merge --ff-only origin/main
    Write-Ok "Main synced"

    # Cleanup feature worktree
    Write-Host "  Removing feature worktree..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "feature-worktree.ps1") remove $FeatureName

    # Sync runtime
    Write-Host "  Syncing runtime..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "runtime-worktree.ps1") sync
    Write-Ok "Runtime synced"

    Write-Host ""
    Write-Host "  Done! Changes are now live in runtime after restart." -ForegroundColor Green
    Write-Host "  Restart runtime: pnpm runtime:start (with MYTEAM_RUNTIME_RESTART_OK=1)"
}
