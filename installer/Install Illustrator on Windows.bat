@echo off
rem One-click install of Sudo Liquid Glass into Illustrator (Windows): the plug-in (LiquidGlass.aip) into every
rem Illustrator's Plug-ins folder, then the panel (.zxp) with Adobe's own installer. Windows asks once for admin rights.
tasklist /fi "imagename eq Illustrator.exe" | "%SystemRoot%\System32\find.exe" /i "Illustrator.exe" >nul
if not errorlevel 1 (
  echo Please close Illustrator first, then run this again.
  pause
  exit /b 1
)
if not exist "%~dp0LiquidGlass.aip" goto missing
if not exist "%~dp0SudoLiquidGlassPanel.zxp" goto missing
rem Not elevated yet: start this same file again as administrator, then stop here.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
set "FOUND="
for /d %%A in ("%ProgramFiles%\Adobe\Adobe Illustrator *") do (
  mkdir "%%A\Plug-ins\Liquid Glass" 2>nul
  copy /y "%~dp0LiquidGlass.aip" "%%A\Plug-ins\Liquid Glass\" >nul && echo Installed the plug-in into %%A && set "FOUND=1"
)
if not defined FOUND echo No Illustrator was found in "%ProgramFiles%\Adobe".
set "UPIA=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if exist "%UPIA%" (
  "%UPIA%" /install "%~dp0SudoLiquidGlassPanel.zxp"
) else (
  echo The Creative Cloud desktop app was not found, so the panel wasn't installed.
)
echo.
echo Done. Start Illustrator, then open Window ^> Extensions ^> Sudo Liquid Glass.
pause
exit /b 0
:missing
echo LiquidGlass.aip or SudoLiquidGlassPanel.zxp is missing. Unzip the whole download first.
pause
exit /b 1
