# BuildBrowser Translation - refresh the offline translation memory
# ------------------------------------------------------------------
# 1) regenerate the official EN->CN glossary from the local game files (optional, needs -GameCitadel)
# 2) fetch public builds from deadlock-api (weekly/all-time ranking + recently
#    updated + optionally your own --author builds)
# 3) translate every new text and rewrite mod/panorama/scripts/bba_tm.js
# 4) optionally compile + pack the VPK
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\refresh_tm.ps1 -GameCitadel "<Deadlock>/game/citadel"
#   powershell -ExecutionPolicy Bypass -File scripts\refresh_tm.ps1 -GameCitadel "..." -Build -Csdk12Root "<CSDK>"
# ------------------------------------------------------------------
[CmdletBinding()]
param(
  [string]$GameCitadel = "",
  [int]$Weekly = 100,
  [int]$AllTime = 60,
  [int]$Recent = 40,
  [string]$Author = "",
  [string]$Lang = "English",
  [string]$Seed = "samples/sample-build-code.txt,tools/cache/local_seed.txt",
  [switch]$Build,
  [string]$Csdk12Root = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[refresh] ERROR: $msg" -ForegroundColor Red; exit 1 }

Set-Location $ProjectRoot

if ($GameCitadel) {
  if (-not (Test-Path $GameCitadel)) { Fail "game citadel path not found: $GameCitadel" }
  Write-Step "regenerating glossary from $GameCitadel"
  node tools\build_glossary.js --game-root $GameCitadel
} else {
  Write-Step "skipping glossary (pass -GameCitadel to refresh it)"
}

$fetchArgs = @("--weekly", $Weekly, "--alltime", $AllTime, "--recent", $Recent, "--lang", $Lang)
if ($Author) { $fetchArgs += @("--author", $Author) }
Write-Step "fetching builds (weekly=$Weekly, alltime=$AllTime, recent=$Recent, lang=$Lang$(if ($Author) { ", author=$Author" }))"
node tools\fetch_builds.js @fetchArgs
if ($LASTEXITCODE -ne 0) { Fail "fetch_builds failed" }

Write-Step "translating + writing bba_tm.js"
node tools\build_tm.js --seed $Seed
if ($LASTEXITCODE -ne 0) { Fail "build_tm failed" }

if ($Build) {
  if (-not $Csdk12Root) { Fail "-Build needs -Csdk12Root" }
  Write-Step "building VPK"
  & (Join-Path $PSScriptRoot "build.ps1") -Csdk12Root $Csdk12Root
}

Write-Step "done"
