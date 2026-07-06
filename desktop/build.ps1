$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$output = Join-Path $env:TEMP ("deez-vrm-release-{0}" -f [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
$release = Join-Path $projectRoot 'release'

Push-Location $projectRoot
try {
  & npm.cmd run build:desktop
  if ($LASTEXITCODE -ne 0) { throw "Desktop web build failed with exit code $LASTEXITCODE." }

  & npx.cmd electron-builder --win nsis portable "--config.directories.output=$output"
  if ($LASTEXITCODE -ne 0) { throw "Windows packaging failed with exit code $LASTEXITCODE." }

  New-Item -ItemType Directory -Force -Path $release | Out-Null
  Get-ChildItem -LiteralPath $output -Filter '*.exe' | Copy-Item -Destination $release -Force
  Write-Host "Windows executables are ready in $release"
}
finally {
  Pop-Location
}
