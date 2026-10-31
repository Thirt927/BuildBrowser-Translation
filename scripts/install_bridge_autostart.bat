@echo off
REM BuildBrowser Translation - start the live bridge at logon (no admin needed).
REM Writes a value under HKCU\...\Run, pointing at scripts\start_bridge_silent.vbs
setlocal
set "HERE=%~dp0"
set "VBS=%HERE%start_bridge_silent.vbs"
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "BBTBridge" /t REG_SZ /d "wscript.exe \"%VBS%\"" /f >nul
if errorlevel 1 (
  echo [bbt] failed to register autostart
  exit /b 1
)
echo [bbt] autostart installed: %VBS%
echo [bbt] start it now without rebooting:  wscript.exe "%VBS%"
endlocal
