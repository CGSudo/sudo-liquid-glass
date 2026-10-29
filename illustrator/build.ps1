# Builds LiquidGlass.aip (Illustrator Live Effect) and installs it into Illustrator's Plug-ins folder.
#   powershell -ExecutionPolicy Bypass -File build.ps1 [-SDK <unzipped Illustrator SDK>] [-NoInstall]
param(
    [string]$SDK = "E:\AI\SDK\AI_2026_SDK_Win\Adobe Illustrator 2026 SDK",
    # Unpacked Microsoft.Web.WebView2 NuGet package (nuget.org/packages/Microsoft.Web.WebView2).
    [string]$WebView2 = "E:\AI\SDK\webview2\pkg",
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

# Settings panel with the SUDO logo inlined (.NET byte I/O: PowerShell 5.1 text cmdlets corrupt UTF-8).
$logo = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $here "..\photoshop\logo.png")))
$looks = [IO.File]::ReadAllText((Join-Path $here "..\photoshop\looks.js"), [Text.Encoding]::UTF8) # looks and icons shared with Photoshop
$html = [IO.File]::ReadAllText((Join-Path $here "ui\panel.html"), [Text.Encoding]::UTF8).Replace("{{LOGO}}", "data:image/png;base64,$logo").Replace(
    '<script src="../../photoshop/looks.js"></script>', "<script>`n$looks</script>")
New-Item -ItemType Directory -Force (Join-Path $here "build") | Out-Null
[IO.File]::WriteAllText((Join-Path $here "build\panel.html"), $html, (New-Object Text.UTF8Encoding $false))

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
$toolset = if ((& $vswhere -latest -products * -property catalog_productLineVersion) -ge 2022) { "v143" } else { "v142" }
$winsdk = (Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Include" -Directory | Sort-Object Name | Select-Object -Last 1).Name
& $msbuild (Join-Path $here "LiquidGlass.vcxproj") /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=$toolset `
    /p:WindowsTargetPlatformVersion=$winsdk "/p:AISDK=$SDK" "/p:WV2=$WebView2" /m /v:m /nologo
if ($LASTEXITCODE) { throw "msbuild failed" }
$aip = Join-Path $here "build\LiquidGlass.aip"
Write-Host "Built $aip"
if ($NoInstall) { return }

# Program Files needs admin: copy through one elevated process (UAC prompt). Also removes the old
# File > Scripts prototype, so the Effect menu is the only Liquid Glass in Illustrator.
foreach ($ai in Get-ChildItem "C:\Program Files\Adobe\Adobe Illustrator *" -Directory) {
    $dest = Join-Path $ai.FullName "Plug-ins\Liquid Glass"
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command New-Item -ItemType Directory -Force '$dest' | Out-Null; Copy-Item -LiteralPath '$aip' -Destination '$dest' -Force; Remove-Item -Force -ErrorAction SilentlyContinue '$($ai.FullName)\Presets\*\Scripts\Liquid Glass.jsx', '$($ai.FullName)\Presets\*\Scripts\lgcli.exe'"
    Write-Host "Installed -> $dest"
}
