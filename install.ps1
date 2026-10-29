# Packages the Photoshop plugin as dist\LiquidGlass.ccx and installs it with Adobe's installer (UPIA).
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-NoInstall]
# Illustrator is a separate native plug-in: see illustrator-native\build.ps1.
param([switch]$NoInstall)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# Photoshop: package the UXP plugin (a .ccx is a zip of the plugin folder).
$stage = Join-Path $env:TEMP "lg-ccx"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $root "photoshop\*") $stage -Exclude *.test.js
New-Item -ItemType Directory -Force (Join-Path $root "dist") | Out-Null
$zip = Join-Path $root "dist\SudoLiquidGlass.zip"
Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
$ccx = [IO.Path]::ChangeExtension($zip, ".ccx")
Move-Item $zip $ccx -Force
Write-Host "Packaged $ccx"
if ($NoInstall) { return }
$upia = "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
& $upia /install $ccx

