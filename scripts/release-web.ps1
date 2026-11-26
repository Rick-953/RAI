#Requires -Version 5.1
<#
.SYNOPSIS
Check a RAI Web pull request and optionally deploy it to formal.
.DESCRIPTION
Use the full reviewed PR head SHA. Check mode is read-only. Release mode merges
through GitHub and calls the server deploy script. Verify mode checks an already
merged and deployed PR. Set DeployHost to the SSH alias for the formal server.
Release and Verify require the merge commit to be at the tip of main.
.EXAMPLE
./scripts/release-web.ps1 -PullRequest 123 -HeadSha $reviewedSha -Version 0.13.58 -Build 20261126-one-model-per-answer
.EXAMPLE
./scripts/release-web.ps1 -PullRequest 123 -HeadSha $reviewedSha -Version 0.13.58 -Build 20261126-one-model-per-answer -Mode Release -DeployHost $formalSshAlias
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int]$PullRequest,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$HeadSha,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]*$')][string]$Build,
    [ValidateSet('Check', 'Release', 'Verify')][string]$Mode = 'Check',
    [ValidatePattern('^[a-z0-9][a-z0-9._-]*$')][string]$DeployHost
)

$ErrorActionPreference = 'Stop'
$repository = 'Rick-953/RAI'
$baseUrl = 'https://rai.rick.sarl'
$deployRoot = '/opt/rai/apps/formal'
$assets = @('index.html', 'app.js', 'styles.css', 'sw.js')
$sshOptions = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10')

function Invoke-CheckedCommand {
    param([string]$Executable, [string[]]$Arguments)
    $output = & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable $($Arguments[0]) failed with exit code $LASTEXITCODE." }
    $output
}

function Get-ReleasePullRequest {
    Invoke-CheckedCommand gh @('pr', 'view', "$PullRequest", '-R', $repository, '--json',
        'baseRefName,headRefOid,isDraft,mergeCommit,reviewDecision,state,statusCheckRollup') | ConvertFrom-Json
}

function Assert-ReleaseVersion([string]$Commit) {
    $package = Invoke-CheckedCommand gh @('api', "repos/$repository/contents/package.json?ref=$Commit", '-H', 'Accept: application/vnd.github.raw+json') | ConvertFrom-Json
    $index = (Invoke-CheckedCommand gh @('api', "repos/$repository/contents/public/index.html?ref=$Commit", '-H', 'Accept: application/vnd.github.raw+json')) -join "`n"
    if ($package.version -cne $Version -or !$index.Contains("src=`"app.js?v=$Build`"")) {
        throw "Commit $Commit does not contain release $Version ($Build)."
    }
}

if ($Mode -ne 'Check' -and !$DeployHost) { throw 'Specify the formal SSH alias with -DeployHost.' }
$pr = Get-ReleasePullRequest
if ($pr.baseRefName -cne 'main' -or $pr.headRefOid -cne $HeadSha -or $pr.isDraft -or $pr.state -notin @('OPEN', 'MERGED')) {
    throw "PR #$PullRequest must target main and match the reviewed head $HeadSha."
}
if ($pr.reviewDecision -in @('CHANGES_REQUESTED', 'REVIEW_REQUIRED')) { throw "PR #$PullRequest has an outstanding review." }
$gate = @($pr.statusCheckRollup | Where-Object { $_.workflowName -eq 'Security gates' -and $_.name -eq 'Security gate summary' })
if ($gate.Count -ne 1 -or $gate[0].status -ne 'COMPLETED' -or $gate[0].conclusion -ne 'SUCCESS') {
    throw "PR #$PullRequest needs a successful Security gate summary."
}
foreach ($check in $pr.statusCheckRollup) {
    if ($check.state -eq 'SUCCESS' -or ($check.status -eq 'COMPLETED' -and $check.conclusion -in @('SUCCESS', 'SKIPPED', 'NEUTRAL'))) { continue }
    throw "PR #$PullRequest has a pending or unsuccessful check: $($check.name)$($check.context)."
}
Assert-ReleaseVersion $HeadSha
Write-Host "PR #$PullRequest passed checks for $HeadSha and $Version ($Build)."
if ($Mode -eq 'Check') { return }

if ($Mode -eq 'Release' -and $pr.state -eq 'OPEN') {
    Invoke-CheckedCommand ssh ($sshOptions + @($DeployHost, 'test -x /opt/rai/deploy.sh'))
    Invoke-CheckedCommand gh @('pr', 'merge', "$PullRequest", '-R', $repository, '--merge', '--match-head-commit', $HeadSha)
    $pr = Get-ReleasePullRequest
}
$mergedSha = $pr.mergeCommit.oid
if ($pr.state -ne 'MERGED' -or $pr.headRefOid -cne $HeadSha -or $mergedSha -cnotmatch '^[a-f0-9]{40}$') {
    throw "PR #$PullRequest has not merged the reviewed head. Check GitHub before retrying."
}
Assert-ReleaseVersion $mergedSha
$main = Invoke-CheckedCommand gh @('api', "repos/$repository/git/ref/heads/main", '--jq', '.object.sha')
if ($main -cne $mergedSha) { throw "Main is at $main, not the merge commit $mergedSha." }

if ($Mode -eq 'Release') {
    Invoke-CheckedCommand ssh ($sshOptions + @($DeployHost, '/opt/rai/deploy.sh formal'))
}
$assetPaths = ($assets | ForEach-Object { "public/$_" }) -join ' '
$server = @(Invoke-CheckedCommand ssh ($sshOptions + @($DeployHost,
    "cd $deployRoot && git rev-parse HEAD && git diff HEAD --quiet && systemctl is-active --quiet rai.service && sha256sum $assetPaths")))
if ($server.Count -ne (1 + $assets.Count) -or $server[0] -cne $mergedSha) {
    throw "The formal server did not report commit $mergedSha and all expected asset hashes."
}

$headers = @{ 'Cache-Control' = 'no-cache'; 'Accept-Encoding' = 'identity' }
$nonce = [guid]::NewGuid().ToString('N')
$health = Invoke-RestMethod "$baseUrl/api/health?t=$nonce" -Headers $headers -TimeoutSec 30 -MaximumRedirection 0
$live = Invoke-RestMethod "$baseUrl/api/version?t=$nonce" -Headers $headers -TimeoutSec 30 -MaximumRedirection 0
if ($health.ok -ne $true -or $live.success -ne $true -or $live.version -cne $Version -or $live.build -cne $Build) {
    throw "Public health or version verification failed. Expected $Version ($Build), got $($live.version) ($($live.build))."
}

$download = [IO.Path]::GetTempFileName()
try {
    for ($index = 0; $index -lt $assets.Count; $index++) {
        $asset = $assets[$index]
        $hashLine = [regex]::Match($server[$index + 1], '^([a-f0-9]{64})  public/(.+)$')
        if (!$hashLine.Success -or $hashLine.Groups[2].Value -cne $asset) { throw "Missing server hash for $asset." }
        $route = if ($asset -eq 'index.html') { '' } else { $asset }
        $query = if ($asset -in @('app.js', 'styles.css')) { "v=$Build&t=$nonce" } else { "t=$nonce" }
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/${route}?$query" -Headers $headers -TimeoutSec 30 -MaximumRedirection 0 -OutFile $download
        $hash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
        if ($hash -ne $hashLine.Groups[1].Value) { throw "Public SHA-256 mismatch for $asset." }
        Write-Host "$asset $($hash.ToLowerInvariant())"
    }
} finally {
    Remove-Item -LiteralPath $download -Force
}
Write-Host "Verified formal $Version ($Build) at $mergedSha."
