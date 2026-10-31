# BuildBrowser Translation - build script
# ------------------------------------------------------------------
# Pipeline: mod/panorama sources -> resourcecompiler -> vpkeditcli -> dist/pak13_dir.vpk
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "<Reduced_CSDK_12 root>"
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root "..." -Deploy
#
# Parameters:
#   -Csdk12Root   Reduced CSDK 12 root (must contain resourcecompiler.exe)
#   -AddonName    temporary addon name, default bbt (lowercase)
#   -SkipPack     compile only
#   -Deploy       copy the built VPK into the game's addons folder
#   -GameCitadel  game/citadel path (used by -Deploy), auto-detected when omitted
# ------------------------------------------------------------------
[CmdletBinding()]
param(
  [string]$Csdk12Root = "",
  [string]$AddonName = "bbt",
  [string]$PakName = "pak13_dir.vpk",
  [switch]$SkipPack,
  [switch]$Deploy,
  [string]$GameCitadel = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ModDir = Join-Path $ProjectRoot "mod"
$DistDir = Join-Path $ProjectRoot "dist"
$ToolsDir = Join-Path $ProjectRoot "tools"
if (-not $PakName) { $PakName = "pak13_dir.vpk" }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[build] ERROR: $msg" -ForegroundColor Red; exit 1 }

function Find-ResourceCompiler {
  if (-not $Csdk12Root -or -not (Test-Path $Csdk12Root)) { return "" }
  $candidates = @(
    (Join-Path $Csdk12Root "game\bin_cs2\win64\resourcecompiler.exe"),
    (Join-Path $Csdk12Root "game\bin_tools\win64\resourcecompiler.exe"),
    (Join-Path $Csdk12Root "game\bin\win64\resourcecompiler.exe"),
    (Join-Path $Csdk12Root "game\bin_server\win64\resourcecompiler.exe")
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return ""
}

function Find-VpkEdit {
  $local = Join-Path $ToolsDir "vpkeditcli.exe"
  if (Test-Path $local) { return $local }
  $cmd = Get-Command vpkedit -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

function Get-CompiledExtension($ext) {
  switch ($ext.ToLower()) {
    ".xml" { return "vxml_c" }
    ".js"  { return "vjs_c" }
    ".css" { return "vcss_c" }
    default { return $ext.TrimStart(".") + "_c" }
  }
}

function Compile-File($compiler, $contentFile, $gameFile) {
  $outDir = Split-Path -Parent $gameFile
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $contentFile = [System.IO.Path]::GetFullPath($contentFile)
  $gameFile = [System.IO.Path]::GetFullPath($gameFile)
  & $compiler -i $contentFile -o $gameFile | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "resourcecompiler failed: $contentFile (exit=$LASTEXITCODE)" }
  if (-not (Test-Path $gameFile)) { Fail "no compiled output: $gameFile" }
  Write-Host "   ok: $([System.IO.Path]::GetFileName($gameFile))"
}

Write-Step "BuildBrowser Translation build (Addon=$AddonName)"

$compiler = Find-ResourceCompiler
if (-not $compiler) { Fail "resourcecompiler.exe not found, pass -Csdk12Root" }
Write-Step "resourcecompiler: $compiler"

$contentAddon = Join-Path $Csdk12Root "content\citadel_addons\$AddonName"
$gameAddon = Join-Path $Csdk12Root "game\citadel_addons\$AddonName"

New-Item -ItemType Directory -Path $contentAddon -Force | Out-Null
# Wipe the staging copy first so deleted/renamed mod files never survive
# into the compiled game addon and the packed VPK.
$contentPanoStaging = Join-Path $contentAddon "panorama"
if (Test-Path $contentPanoStaging) { Remove-Item $contentPanoStaging -Recurse -Force }
Copy-Item "$ModDir\*" $contentAddon -Recurse -Force
Write-Step "sources synced to $contentAddon"

# Remove stale compiled files so the VPK never contains removed layouts.
if (Test-Path $gameAddon) { Remove-Item $gameAddon -Recurse -Force }

$contentPano = Join-Path $contentAddon "panorama"
if (-not (Test-Path $contentPano)) { Fail "no panorama directory in content addon" }

$files = Get-ChildItem $contentPano -Recurse -File | Where-Object {
  $_.Extension -in @(".xml", ".js", ".css")
}
if ($files.Count -eq 0) { Fail "nothing to compile" }
Write-Step "compiling $($files.Count) files..."

foreach ($f in $files) {
  $rel = $f.FullName.Substring($contentPano.Length).TrimStart("\")
  $outRel = [System.IO.Path]::ChangeExtension($rel, (Get-CompiledExtension $f.Extension))
  $gameFile = Join-Path (Join-Path $gameAddon "panorama") $outRel
  Compile-File $compiler $f.FullName $gameFile
}

if ($SkipPack) {
  Write-Step "skipped packing (-SkipPack), output in $gameAddon"
  exit 0
}

$vpkEdit = Find-VpkEdit
if (-not $vpkEdit) { Fail "vpkeditcli.exe not found (put it in tools\ or PATH)" }
Write-Step "vpkedit: $vpkEdit"
New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
$vpkOut = Join-Path $DistDir $PakName
if (Test-Path $vpkOut) { Remove-Item $vpkOut -Force }

& $vpkEdit $gameAddon -o $vpkOut --single-file --no-progress 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "vpkedit failed (exit=$LASTEXITCODE)" }
if (-not (Test-Path $vpkOut)) { Fail "no VPK produced: $vpkOut" }

Write-Step "verifying VPK..."
$listing = & $vpkEdit $vpkOut --file-tree 2>&1 | Out-String
$required = @(
  "citadel_ui_build_selector.vxml_c",
  "citadel_ui_build_details.vxml_c",
  "citadel_shop_mods_build.vxml_c",
  "citadel_shop_mods_build_category.vxml_c",
  "citadel_tooltip_build_details.vxml_c",
  "citadel_tooltip_mod_details.vxml_c",
  "bba_translate.vjs_c",
  "bba_tm.vjs_c",
  "bba_glossary.vjs_c",
  "bba_layout_tokens.vjs_c",
  # .css compiles to .vcss_c; accept either spelling so the check does not depend
  # on how the packer records the extension.
  "bba.vcss_c"
)
foreach ($r in $required) {
  if (-not ($listing -match [regex]::Escape($r))) { Fail "missing asset in VPK: $r" }
}

Write-Step "built: $vpkOut"

if ($Deploy) {
  if (-not $GameCitadel) {
    $candidates = @(
      (Join-Path ${env:ProgramFiles(x86)} "Steam\steamapps\common\Deadlock\game\citadel"),
      (Join-Path $env:ProgramFiles "Steam\steamapps\common\Deadlock\game\citadel")
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $GameCitadel = $c; break } }
  }
  if (-not $GameCitadel) { Fail "game citadel path not found, pass -GameCitadel" }
  if (-not (Test-Path $GameCitadel)) { Fail "game citadel path not found: $GameCitadel" }
  $target = Join-Path $GameCitadel ("addons\" + $PakName)
  if (Test-Path $target) { Copy-Item $target ($target + ".bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")) -Force }
  Copy-Item $vpkOut $target -Force
  Write-Step "deployed: $target (restart Deadlock to load it)"
}
