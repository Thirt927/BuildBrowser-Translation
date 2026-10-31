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
#     -Names "citadel_ui_build_details,tooltips/citadel_tooltip_mod_details" `
#     [-NoTm] [-GameCitadel "<Deadlock>\game\citadel"]
#
# -Names may carry a subdirectory (e.g. "tooltips/citadel_tooltip_mod_details");
# the leaf name is matched anywhere in the export tree, the directory part only
# narrows the search when a matching subpath exists.
#
# Wildcards: a name may use * (e.g. -Names "*build*" injects into every layout
# whose file name contains "build"). This is the quick way to cover a panel that
# lives in a layout we did not know about -- for example the "Overview" tab of the
# build details, which is a separate layout file.
#
# How to get the decompiled layouts (one-off, 30 seconds):
#   1. Open the game's citadel VPKs (game\citadel\*.vpk) in Source 2 Viewer
#      (see https://deadlockmodding.pages.dev/modding-tools/source-2-viewer)
#   2. In the search box type each layout name, e.g. citadel_ui_build_details
#   3. Right-click -> "Decompile & Export" -> pick a folder, keep the original path
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

$request = @($Names -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$NoTmFlag = @()
if ($NoTm) { $NoTmFlag = @("--no-tm") }

$made = @()
foreach ($name in $request) {
  # S2V export may keep the game path (panorama/layout/name.xml) or be flat.
  # -Filter only matches the leaf name; a directory part ("tooltips/...")
  # constrains the search when a matching subpath exists.
  $parts = @(($name -replace "\\", "/") -split "/")
  $leaf = $parts[-1]
  $wantDir = $null
  if ($parts.Count -gt 1) { $wantDir = [string]::Join("/", $parts[0..($parts.Count - 2)]) }

  $filter = if ($leaf -match "[*?]") { $leaf } else { "$leaf.*" }
  $candidates = @(Get-ChildItem -Path $S2VDir -Recurse -File -Filter $filter |
    Where-Object { $_.Extension -in ".xml", ".vxml" })
  if ($candidates.Count -eq 0) {
    Write-Warning ("layout '{0}' not found under {1} (S2V export keeps the original path; search for '{2}.xml')") -f $name, $S2VDir, $leaf
    continue
  }
  if ($wantDir) {
    $inDir = @($candidates | Where-Object { ($_.FullName -ireplace "[\\]+", "/") -like "*/$wantDir/*" })
    if ($inDir.Count -gt 0) { $candidates = $inDir }
  }
  $inject = Join-Path $ProjectRoot "tools/inject_scripts.js"
  if ($leaf -match "[*?]" -and $candidates.Count -gt 1) {
    # Wildcard with several hits: inject into all of them.
    foreach ($c in $candidates) {
      Write-Host ("[{0}] found: {1}" -f $name, $c.FullName)
      & $Node.Source $inject $c.FullName @NoTmFlag
      if ($LASTEXITCODE -ne 0) { Write-Error ("inject_scripts.js failed for {0}" -f $c.Name); exit 1 }
      $made += $c.BaseName
    }
    continue
  }
  $hits = $candidates | Select-Object -First 1
  Write-Host ("[{0}] found: {1}" -f $name, $hits.FullName)
  & $Node.Source $inject $hits.FullName @NoTmFlag
  if ($LASTEXITCODE -ne 0) { Write-Error ("inject_scripts.js failed for {0}" -f $name); exit 1 }
  $made += $name
}

if ($made.Count -eq 0) {
  Write-Error "no layouts were found; nothing to do"
  exit 1
}

Write-Host ""
Write-Host ("wrote overrides for: {0}" -f ($made -join ", ")) -ForegroundColor Green
Write-Host "next:"
Write-Host "  1. verify:  node tests\scene_verify.js"
Write-Host "  2. rebuild: powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Csdk12Root `"<CSDK>`""
if ($GameCitadel) {
  Write-Host "  3. terms: node tools\build_glossary.js --game-root `"$GameCitadel`" (game updated? refresh the glossary)"
}
