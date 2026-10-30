# BuildBrowser Translation - layout override bootstrap
#
# Takes decompiled game layouts (exported with Source 2 Viewer) and turns them
# into working BBT overrides in one step:
#   1. finds each requested layout in the decompiled tree
#   2. runs tools/inject_scripts.js (adds the bba_* <scripts> includes)
#   3. verifies the result and prints the next build step
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\get_layouts.ps1 `
#     -S2VDir "<path where S2V exported the decompiled layouts>" `
#     -Names citadel_ui_build_details `
#     [-NoTm] [-GameCitadel "<Deadlock>\game\citadel"]
#
# How to get the decompiled layouts (one-off, 30 seconds):
#   1. Open the game's citadel VPKs (game\citadel\*.vpk) in Source 2 Viewer
#      (see https://deadlockmodding.pages.dev/modding-tools/source-2-viewer)
#   2. In the search box type each layout name, e.g. citadel_ui_build_details
#   3. Right-click -> "Decompile & Export" -> pick a folder, tick the option to
#      keep the original file path
#   4. Run this script pointing at that folder
param(
  [Parameter(Mandatory = $true)] [string]$S2VDir,
  [Parameter(Mandatory = $true)] [string]$Names,
  [switch]$NoTm,
  [string]$GameCitadel = ""
)
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { Write-Error "node is required"; exit 1 }

$request = $Names -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$NoTmFlag = if ($NoTm) { @("--no-tm") } else { @() }

$made = @()
foreach ($name in $request) {
  # S2V export may keep the game path (...\panorama\layout\name.xml) or be flat.
  $hits = Get-ChildItem -Path $S2VDir -Recurse -File `
    -Filter "$name.*" |
    Where-Object { $_.Extension -in ".xml", ".vxml" } |
    Select-Object -First 1
  if (-not $hits) {
    Write-Warning ("layout '{0}' not found under {1} (S2V export keeps the original path; " +
      "search case-insensitively for '{0}.xml')" -f $name, $S2VDir, $name)
    continue
  }
  Write-Host ("[{0}] found: {1}" -f $name, $hits.FullName)
  & $Node.Source (Join-Path $ProjectRoot "tools/inject_scripts.js") $hits.FullName @NoTmFlag
  $made += $name
}

if ($made.Count -eq 0) {
  Write-Error "no layouts were found; nothing to do"
  exit 1
}

Write-Host ""
Write-Host "wrote overrides for: $($made -join ', ')" -ForegroundColor Green
Write-Host "next:"
Write-Host "  1. verify:  node tests\scene_verify.js"
Write-Host "  2. rebuild: powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root `"<CSDK>`""
if ($GameCitadel) {
  Write-Host "  3. terms: node tools\build_glossary.js --game-root `"$GameCitadel`" (game updated? refresh the glossary)"
}
