# Builds and runs dialog_test.exe (needs VS C++ Build Tools and the WebView2 package; run build.ps1 first for build\panel.html).
param([string]$WebView2 = "E:\AI\SDK\webview2\pkg", [string]$Shot = "$PSScriptRoot\panel.bmp")
$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -property installationPath
$out = "$PSScriptRoot\..\build\test"
New-Item -ItemType Directory -Force $out | Out-Null
$cmd = "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && cd /d `"$PSScriptRoot`" && rc /nologo /fo `"$out\test.res`" test.rc && " +
  "cl /nologo /std:c++17 /EHsc /O2 /MD /I`"$WebView2\build\native\include`" /Fo`"$out/`" /Fe`"$out\dialog_test.exe`" " +
  "dialog_test.cpp ..\Source\LiquidGlassDialog.cpp `"$out\test.res`" `"$WebView2\build\native\x64\WebView2LoaderStatic.lib`" " +
  "user32.lib gdi32.lib ole32.lib shell32.lib dwmapi.lib advapi32.lib"
cmd /c $cmd
if ($LASTEXITCODE) { throw "build failed" }
& "$out\dialog_test.exe" $Shot
exit $LASTEXITCODE
