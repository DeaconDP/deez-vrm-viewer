@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 goto install_node
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if %NODE_MAJOR% LSS 20 goto install_node
goto dependencies

:install_node
where winget.exe >nul 2>&1
if errorlevel 1 goto no_node
echo Installing Node.js LTS. Windows may ask for permission...
winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto failed
set "PATH=%ProgramFiles%\nodejs;%PATH%"
goto dependencies

:no_node
start "" "https://nodejs.org/en/download"
mshta "javascript:alert('Deez VRM Viewer needs Node.js 20 or newer. The download page has been opened for you. Install Node.js, then double-click this file again.');close()"
exit /b 1

:dependencies
if exist "node_modules\.package-lock.json" goto launch
echo Setting up Deez VRM Viewer for the first time...
call npm.cmd install
if errorlevel 1 goto failed

:launch
start "Deez VRM Viewer" /min cmd /c "npm.cmd run dev -- --open"
exit /b 0

:failed
mshta "javascript:alert('Setup could not finish. Check your internet connection, then run Deez VRM Viewer again.');close()"
exit /b 1
