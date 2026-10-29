@echo off
rem One-click install of Sudo Liquid Glass into Photoshop, using Adobe's own plugin installer (comes with Creative Cloud).
set "UPIA=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" (
  echo The Creative Cloud desktop app was not found. Install it, or double-click SudoLiquidGlass.ccx instead.
  pause
  exit /b 1
)
rem Remove any older copy first so upgrades always apply.
"%UPIA%" /remove "Sudo Liquid Glass" >nul 2>&1
"%UPIA%" /install "%~dp0SudoLiquidGlass.ccx"
echo.
echo Done. Restart Photoshop and open Plugins ^> Sudo Liquid Glass.
pause
