@echo off
setlocal EnableDelayedExpansion

:: ============================================================================
:: install-mcp.cmd
:: Installs the cf-oauth-mcp-proxy as a GitHub MCP server in Claude Code.
:: Run from cmd.exe — does NOT require PowerShell or admin rights.
::
:: Usage:
::   install-mcp.cmd
::   install-mcp.cmd https://your-worker-domain.com
:: ============================================================================

echo.
echo  cf-oauth-mcp-proxy ^| Claude Code MCP Installer
echo  ================================================
echo.

:: -- Resolve Worker URL -------------------------------------------------------
if "%~1"=="" (
    set /p WORKER_URL="Enter your Worker URL (e.g. https://github-mcp.yourdomain.com): "
) else (
    set WORKER_URL=%~1
)

if "%WORKER_URL%"=="" (
    echo  ERROR: No Worker URL provided.
    exit /b 1
)

:: Strip trailing slash if present
if "%WORKER_URL:~-1%"=="/" set WORKER_URL=%WORKER_URL:~0,-1%

set MCP_URL=%WORKER_URL%/mcp

echo.
echo  Worker URL : %WORKER_URL%
echo  MCP URL    : %MCP_URL%
echo.

:: -- Check claude is installed ------------------------------------------------
where claude >nul 2>&1
if errorlevel 1 (
    echo  ERROR: claude CLI not found in PATH.
    echo  Install Claude Code from: https://claude.ai/download
    echo.
    exit /b 1
)

:: -- Remove any existing github MCP entry -------------------------------------
echo  Removing any existing 'github' MCP entry...
claude mcp remove github >nul 2>&1

:: -- Try add-json first (Claude Code 2.1.1+) ----------------------------------
echo  Attempting claude mcp add-json...
echo.

claude mcp add-json github "{\"type\":\"http\",\"url\":\"%MCP_URL%\"}" >nul 2>&1

if errorlevel 1 (
    echo  add-json failed ^(older Claude Code^) -- trying legacy transport flag...
    echo.
    claude mcp add --transport http github %MCP_URL%
    if errorlevel 1 (
        echo.
        echo  ERROR: Both install methods failed.
        echo  Try running manually:
        echo    claude mcp add --transport http github %MCP_URL%
        echo.
        exit /b 1
    )
)

:: -- Verify -------------------------------------------------------------------
echo.
echo  Verifying installation...
echo.
claude mcp list

echo.
echo  ============================================================
echo   SUCCESS — GitHub MCP server installed.
echo  ============================================================
echo.
echo   Next steps:
echo   1. Restart Claude Code
echo   2. Run /mcp inside Claude Code to trigger OAuth auth
echo   3. Your browser will open: %WORKER_URL%/authorize
echo   4. Enter your AUTH_PIN to authorize access
echo   5. You will be redirected back -- done!
echo.
echo   To verify tools are available, run inside Claude Code:
echo     /mcp
echo.
echo   To remove:
echo     claude mcp remove github
echo.
echo   Docs: https://github.com/LIFEAI/cf-oauth-mcp-proxy
echo.

endlocal
