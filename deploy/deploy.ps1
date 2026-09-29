# Manual deploy from Windows PowerShell (uses the built-in OpenSSH client).
#   .\deploy\deploy.ps1 -Target deploy@time2live.xyz [-Tag <image-tag>]
# Same behaviour as deploy.sh; see that file for registry access notes.
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Tag = (git rev-parse HEAD),
  [string]$AppDir = '/opt/time2live'
)
$ErrorActionPreference = 'Stop'
if ($Tag -notmatch '^[A-Za-z0-9_.-]{1,128}$') { throw "invalid tag: $Tag" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Checked([string]$exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit code $LASTEXITCODE" }
}

Write-Host "==> uploading deployment files to ${Target}:$AppDir"
Invoke-Checked scp @('-q', "$here\docker-compose.prod.yml", "${Target}:$AppDir/docker-compose.yml")
Invoke-Checked scp @('-q', "$here\Caddyfile", "$here\remote-deploy.sh", "$here\backup.sh",
  "$here\restore.sh", "$here\.env.production.example", "${Target}:$AppDir/")
# Files checked out on Windows may have CRLF endings; strip them on the server just in case.
Invoke-Checked ssh @($Target, "sed -i 's/\r$//' $AppDir/*.sh && chmod 750 $AppDir/*.sh")

Write-Host "==> deploying $Tag"
Invoke-Checked ssh @($Target, "$AppDir/remote-deploy.sh '$Tag'")
