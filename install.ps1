# Packages the Photoshop plugin as dist\LiquidGlass.ccx and installs it with Adobe's installer (UPIA).
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-NoInstall]
# If the Illustrator script is present (illustrator\ + target\release\lgcli.exe), it's installed too.
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

# Illustrator script: renderer to %APPDATA%\LiquidGlass and the Scripts menu (Program Files needs an elevated shell).
$cli = Join-Path $root "target\release\lgcli.exe"
$jsx = Join-Path $root "illustrator\Liquid Glass.jsx"
if (!(Test-Path $cli) -or !(Test-Path $jsx)) { return }
$dest = Join-Path $env:APPDATA "LiquidGlass"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item $cli $dest -Force
foreach ($scripts in Get-ChildItem "C:\Program Files\Adobe\Adobe Illustrator *\Presets\*\Scripts" -Directory -ErrorAction SilentlyContinue) {
    try {
        Copy-Item $jsx, $cli $scripts.FullName -Force
        Write-Host "Illustrator script -> $($scripts.FullName)"
    } catch {
        Write-Warning "No write access to $($scripts.FullName): run elevated, or use File > Scripts > Other Script."
    }
}
