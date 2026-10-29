@echo off
rem One-click install of Sudo Liquid Glass into Illustrator (Windows): copies LiquidGlass.aip into the Plug-ins
rem folder of every installed Illustrator. Program Files needs admin rights, so Windows asks once.
tasklist /fi "imagename eq Illustrator.exe" | "%SystemRoot%\System32\find.exe" /i "Illustrator.exe" >nul
if not errorlevel 1 (
  echo Please close Illustrator first, then run this again.
  pause
  exit /b 1
)
if not exist "%~dp0LiquidGlass.aip" (
  echo LiquidGlass.aip was not found next to this file. Unzip the whole download first.
  pause
  exit /b 1
)
rem Not elevated yet: start this same file again as administrator, then stop here.
net session >nul 2>&1 || (powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
set "FOUND="
for /d %%A in ("%ProgramFiles%\Adobe\Adobe Illustrator *") do (
  mkdir "%%A\Plug-ins\Liquid Glass" 2>nul
  copy /y "%~dp0LiquidGlass.aip" "%%A\Plug-ins\Liquid Glass\" >nul && echo Installed into %%A && set "FOUND=1"
)
if not defined FOUND echo No Illustrator was found in "%ProgramFiles%\Adobe".
echo.
echo Done. Start Illustrator, select a shape and choose Effect ^> Stylize ^> Liquid Glass...
pause
