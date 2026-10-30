# Builds the Illustrator plug-in (build\LiquidGlass.aip) and the panel (build\SudoLiquidGlassPanel.zxp), then installs both.
#   powershell -ExecutionPolicy Bypass -File build.ps1 [-SDK <unzipped Illustrator SDK>] [-ZXPSignCmd <path>] [-NoInstall]
# ZXPSignCmd: github.com/Adobe-CEP/CEP-Resources (ZXPSignCMD/4.1.3/x64). The panel is signed with a fresh self-signed
# certificate each build, so no signing secret is stored anywhere.
param(
    [string]$SDK = "E:\AI\SDK\AI_2026_SDK_Win\Adobe Illustrator 2026 SDK",
    [string]$ZXPSignCmd = "E:\AI\SDK\zxpsign\ZXPSignCmd.exe",
    [switch]$NoInstall
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

# Rust engine as a static lib (MSVC, /MD).
cargo build -p glass_core --release --manifest-path (Join-Path $here "..\Cargo.toml")
if ($LASTEXITCODE) { throw "cargo build failed" }

# PIPL resource, same bytes as the SDK's tools/pipl/create_pipl.py (big-endian ints): kind SPEA, ivrs 2, entry PluginMain, name.
function New-Pipl($name, $out) {
    $ms = New-Object IO.MemoryStream
    function U32($v) { $b = [BitConverter]::GetBytes([uint32]$v); [Array]::Reverse($b); $ms.Write($b, 0, 4) }
    function Str($s) { $b = [Text.Encoding]::ASCII.GetBytes($s); $ms.Write($b, 0, $b.Length) }
    function Pad($s) { $s + ("`0" * ((4 - $s.Length % 4) % 4)) }
    U32 1; U32 0; U32 4
    Str "ADBEkind"; U32 0; U32 4; Str "SPEA"
    Str "ADBEivrs"; U32 0; U32 4; U32 2
    $e = Pad "PluginMain`0`0`0`0"; Str "ADBEwx86"; U32 0; U32 $e.Length; Str $e
    $n = Pad $name; Str "ADBEpinm"; U32 0; U32 $n.Length; Str $n
    [IO.File]::WriteAllBytes($out, $ms.ToArray())
}
New-Pipl "LiquidGlass" (Join-Path $here "plugin.pipl")

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
$toolset = if ((& $vswhere -latest -products * -property catalog_productLineVersion) -ge 2022) { "v143" } else { "v142" }
$winsdk = (Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Include" -Directory | Sort-Object Name | Select-Object -Last 1).Name
& $msbuild (Join-Path $here "LiquidGlass.vcxproj") /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=$toolset `
    /p:WindowsTargetPlatformVersion=$winsdk "/p:AISDK=$SDK" /m /v:m /nologo
if ($LASTEXITCODE) { throw "msbuild failed" }
$aip = Join-Path $here "build\LiquidGlass.aip"
Write-Host "Built $aip"

# Panel: stage (shared looks + logo), then sign as a .zxp.
$stage = Join-Path $here "build\cep"
node (Join-Path $here "cep\stage.js") $stage
if ($LASTEXITCODE) { throw "panel staging failed" }
$zxp = Join-Path $here "build\SudoLiquidGlassPanel.zxp"
$cert = Join-Path $here "build\cert.p12"
$pass = [Guid]::NewGuid().ToString("N")
Remove-Item -Force -ErrorAction SilentlyContinue $zxp, $cert
& $ZXPSignCmd -selfSignedCert US CA CGSudo "Sudo Liquid Glass" $pass $cert | Out-Null
& $ZXPSignCmd -sign $stage $zxp $cert $pass | Out-Null
Remove-Item -Force $cert
& $ZXPSignCmd -verify $zxp | Out-Null
if ($LASTEXITCODE) { throw "panel signing failed" }
Write-Host "Built $zxp"
if ($NoInstall) { return }

# Plug-in: Program Files needs admin, so one elevated copy (UAC prompt). Illustrator must be closed (file lock).
foreach ($ai in Get-ChildItem "C:\Program Files\Adobe\Adobe Illustrator *" -Directory) {
    $dest = Join-Path $ai.FullName "Plug-ins\Liquid Glass"
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command New-Item -ItemType Directory -Force '$dest' | Out-Null; Copy-Item -LiteralPath '$aip' -Destination '$dest' -Force"
    Write-Host "Installed -> $dest"
}
# Panel: Adobe's own installer (comes with Creative Cloud).
$upia = "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
& $upia /install $zxp
