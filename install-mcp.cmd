@echo off
setlocal EnableDelayedExpansion

:: ============================================================================
:: install-mcp.cmd
:: Installs cf-oauth-mcp-proxy as a GitHub MCP connector in any OAuth MCP client.
::
:: NOTE: Claude Code users do NOT need this.
::   Claude Code uses the gh CLI which is already pre-authenticated.
::   This installer is for claude.ai web and other OAuth MCP clients.
::
:: Usage:
::   install-mcp.cmd
::   install-mcp.cmd https://your-worker-domain.com
:: ============================================================================

echo.
echo  cf-oauth-mcp-proxy ^| MCP Client Installer
echo  ============================================
echo.
echo  NOTE: Claude Code users -- you don't need this.
echo  Claude Code uses the gh CLI which is already pre-authenticated.
echo  This is for claude.ai web and other OAuth MCP clients.
echo.


:: -- Generate an AUTH_PIN if you don't have one yet --------------------------
:: Run this in PowerShell to generate a random 8-char PIN:
::   -join ((65..90 + 48..57) | Get-Random -Count 8 | % {[char]$_})
:: Or from cmd.exe:
::   powershell -command "-join ((65..90 + 48..57) | Get-Random -Count 8 | % {[char]$_})"
::
:: Store the result in your password manager, then set it as a Worker secret:
::   wrangler secret put AUTH_PIN
:: -----------------------------------------------------------------------------

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
echo   SUCCESS -- MCP server installed.
echo  ============================================================
echo.
echo   Next steps:
echo   1. Restart Claude Code (or your MCP client)
echo   2. Run /mcp inside Claude Code to trigger OAuth auth
echo   3. Your browser will open: %WORKER_URL%/authorize
echo   4. Enter your AUTH_PIN to authorize access
echo   5. You will be redirected back -- done!
echo.
echo   To verify tools are available inside Claude Code:
echo     /mcp
echo.
echo   To remove:
echo     claude mcp remove github
echo.
echo   Docs: https://github.com/LIFEAI/cf-oauth-mcp-proxy
echo.

endlocal
