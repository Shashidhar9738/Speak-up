$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $projectRoot 'dist'

if (Test-Path $distPath) {
    Remove-Item -Path $distPath -Recurse -Force
}

New-Item -Path $distPath -ItemType Directory | Out-Null

# Application pages. index.html is the live dashboard; SPEAKU_2.HTM is the
# original static mock and is deliberately NOT shipped as index.html any more.
$pages = @('index.html', 'submit.html', 'login.html')
foreach ($page in $pages) {
    $source = Join-Path $projectRoot $page
    if (-not (Test-Path $source)) {
        throw "Missing required page: $page"
    }
    Copy-Item -Path $source -Destination $distPath -Force
}

# Shared client-side assets (api.js).
$assetsSource = Join-Path $projectRoot 'assets'
if (Test-Path $assetsSource) {
    Copy-Item -Path $assetsSource -Destination $distPath -Recurse -Force
}

# Reference documents.
$docs = @('SPEAKU_2.MD', 'SPEAKU_2_AGENT.md', 'SPEAKU_2_ARCHITECTURE.md', 'SPEAKU_2_PLANNING.md')
foreach ($doc in $docs) {
    $source = Join-Path $projectRoot $doc
    if (Test-Path $source) {
        Copy-Item -Path $source -Destination $distPath -Force
    }
}

Write-Host 'Build complete. Artifacts:'
Get-ChildItem -Path $distPath -Recurse | Select-Object FullName, Length
