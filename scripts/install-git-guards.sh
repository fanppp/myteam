#!/bin/sh
# Install git hooks for myteam
# Sets core.hooksPath to .githooks so pre-commit and pre-push hooks are active

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

if [ -z "$REPO_ROOT" ]; then
    echo "Not in a git repository."
    exit 1
fi

git config --local core.hooksPath .githooks
echo "[myteam] Git hooks installed: core.hooksPath = .githooks"
echo "  pre-commit: rejects commits on protected branches (main, runtime/main-sync, alpha/main-sync)"
echo "  pre-push:   rejects pushes from protected worktrees"
