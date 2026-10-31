@echo off
REM BuildBrowser Translation - remove the logon autostart entry.
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "BBTBridge" /f >nul 2>&1
if errorlevel 1 (
  echo [bbt] was not installed
  exit /b 0
)
echo [bbt] autostart removed (a running bridge keeps running until you close it)
