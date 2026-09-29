# Deploy from Windows PowerShell (built-in OpenSSH client). Same as deploy.sh:
#   .\deploy\deploy.ps1 -Target time2live            # the checked-out commit (must be pushed)
#   .\deploy\deploy.ps1 -Target time2live -Ref main  # latest origin/main, or any pushed SHA
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Ref = '',
  [string]$SrcDir = '/opt/time2live/src'
)
$ErrorActionPreference = 'Stop'

if ($Ref -eq '') {
  $Ref = (git rev-parse HEAD).Trim()
  git fetch --quiet origin
  if (-not (git branch -r --contains $Ref)) {
    throw "commit $($Ref.Substring(0, 12)) is not on origin - push it first (the server fetches from GitHub)"
  }
  if (git status --porcelain) {
    Write-Warning "uncommitted local changes are NOT deployed; deploying $($Ref.Substring(0, 12))"
  }
}
if ($Ref -notmatch '^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$') { throw "invalid ref: $Ref" }

ssh $Target "$SrcDir/deploy/update.sh '$Ref'"
if ($LASTEXITCODE -ne 0) { throw "deploy failed with exit code $LASTEXITCODE" }
