// BuildBrowser Translation - generate the local certificate for the optional
// live translation bridge (tools/bridge/bridge.js).
//
// Why a certificate: the game renders our <HTML id="BBTBridgePanel"> through
// WebKit. It refuses plain http and refuses an untrusted https page
// (ERR_CERT_AUTHORITY_INVALID / neterror -202), so the page must be served over
// HTTPS with a certificate the engine trusts.
//
// What this script creates in -OutDir (default config/certs, gitignored):
//   bbt.pfx    PKCS#12 bundle with the private key, read by tools/bridge/bridge.js
//   bbt.pass   the passphrase for that pfx (plain text)
//   bbt.cer    DER certificate, this is what -Trust installs
//
// Certificate shape (same layout the engine accepts):
//   CN  = BBT-localhost
//   SAN = DNS:localhost + IP:127.0.0.1 + IP:::1   (the IPs must be IP SANs)
//   EKU = serverAuth, KU = DigitalSignature + KeyEncipherment
//
// Usage:
//   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust
//   powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Untrust
//
// Trust is opt-in and needs no administrator rights (CurrentUser\Root). Windows
// may show a security warning; confirm it. After adding/removing the certificate
// Steam must be fully restarted (tray icon too), not just the game.
//
// This file is ASCII-only on purpose (Windows PowerShell 5.1 would mis-read a
// UTF-8 file without a BOM).

[CmdletBinding()]
param(
    [string]$OutDir = "",
    [int]$Days = 1825,
    [switch]$Force,
    [switch]$Trust,
    [switch]$Untrust,
    [switch]$NoTrust
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $RepoRoot "config\certs"
} elseif (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $RepoRoot $OutDir
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$PfxPath = Join-Path $OutDir "bbt.pfx"
$PassFile = Join-Path $OutDir "bbt.pass"
$CerPath = Join-Path $OutDir "bbt.cer"

function Fail([string]$Message) {
    Write-Host ("ERROR: " + $Message)
    exit 1
}

function Write-Step([string]$Message) {
    Write-Host ("==> " + $Message) -ForegroundColor Cyan
}

if ($Untrust) {
    $found = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -like "*CN=BBT-localhost*" }
    if (-not $found) {
        Write-Host "no BBT-localhost certificate in CurrentUser\Root; nothing to remove"
        exit 0
    }
    foreach ($c in $found) {
        Write-Step ("removing trust for " + $c.Thumbprint)
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
        $store.Open("ReadWrite")
        try { $store.Remove($c) } finally { $store.Close() }
    }
    Write-Host "done - fully restart Steam so the engine drops the certificate"
    exit 0
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$needGenerate = $true
if ((Test-Path $PfxPath) -and -not $Force) {
    Write-Host ("existing certificate reused: " + $PfxPath + " (pass -Force to regenerate)")
    $needGenerate = $false
}

if ($needGenerate) {
    Write-Step "creating a self-signed certificate (CN=BBT-localhost, SAN localhost/127.0.0.1/::1)"

    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    $sha = [System.Security.Cryptography.HashAlgorithmName]::SHA256
    $pad = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1

    # SAN extension (2.5.29.17) with DNS:localhost, IP:127.0.0.1, IP:::1
    $sanNames = @(
        "localhost",
        "127.0.0.1",
        "::1"
    )
    $sanBuilder = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
    $sanBuilder.AddDnsName("localhost")
    $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
    $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("::1"))

    $req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
        "CN=BBT-localhost",
        $rsa,
        $sha,
        $pad)
    $req.CertificateExtensions.Add($sanBuilder.Build())
    $req.CertificateExtensions.Add(
        (New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension(
            (New-Object System.Security.Cryptography.OidCollection), $false)))
    $eku = $req.CertificateExtensions | Where-Object { $_.Oid.Value -eq "2.5.29.37" }
    $eku.OidCollection.Add((New-Object System.Security.Cryptography.Oid("1.3.6.1.5.5.7.3.1"))) | Out-Null
    $req.CertificateExtensions.Add(
        (New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
            [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $false)))

    $cert = $req.CreateSelfSigned([System.DateTimeOffset]::UtcNow.AddDays(-1), [System.DateTimeOffset]::UtcNow.AddDays($Days))

    # random passphrase, written next to the pfx (both gitignored)
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $pass = [System.Convert]::ToBase64String($bytes)
    Set-Content -Path $PassFile -Value $pass -NoNewline -Encoding ASCII

    $pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pass)
    [System.IO.File]::WriteAllBytes($PfxPath, $pfxBytes)
    [System.IO.File]::WriteAllBytes($CerPath, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))

    Write-Step ("wrote " + $PfxPath)
    Write-Step ("wrote " + $PassFile)
    Write-Step ("wrote " + $CerPath)
}

if ($Trust -and -not $NoTrust) {
    if (-not (Test-Path $CerPath)) { Fail ("certificate not found: " + $CerPath) }
    Write-Step "installing the certificate into CurrentUser\Root (trust store the engine reads)"
    # certutil instead of Import-Certificate: the latter refuses to run from a
    # non-interactive process ("UI is not allowed in this operation").
    & certutil.exe -user -addstore -f Root $CerPath | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "certutil failed to add the certificate" }
    Write-Host ""
    Write-Host "trusted. NOW: fully quit Steam (including the tray icon) and start it again." -ForegroundColor Yellow
    Write-Host "then start the bridge:  node tools\bridge\bridge.js"
}

Write-Host ""
Write-Host "next:"
Write-Host "  node tools\bridge\bridge.js        (keep it running while playing)"
if (-not $Trust) {
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\gen_bridge_cert.ps1 -Trust"
}
