@echo off
REM post-commit: run autover across workspaces with guard and concise output
where npx >nul 2>nul
IF ERRORLEVEL 1 (
    echo npx not found. Install Node.js/npm to use autover.
    EXIT /B 0
)
npx autover
