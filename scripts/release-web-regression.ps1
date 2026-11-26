#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$release = Join-Path $PSScriptRoot 'release-web.ps1'
$reviewed = 'a' * 40
$merged = 'b' * 40
$params = @{ PullRequest = 163; HeadSha = $reviewed; Version = '0.13.58'; Build = 'offline-test-build' }
$history = [System.Collections.Generic.List[string]]::new()
$fixture = @{}
$payload = 'offline asset fixture'
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($payload))).Replace('-', '').ToLowerInvariant()
} finally { $sha256.Dispose() }

function gh {
    $global:LASTEXITCODE = 0
    $command = $args -join ' '
    $history.Add($command)
    switch -Wildcard ($command) {
        'pr view *' {
            @{
                baseRefName = 'main'; headRefOid = $fixture.head; isDraft = $false; reviewDecision = 'APPROVED'
                state = $fixture.prState; mergeCommit = @{ oid = $merged }
                statusCheckRollup = @(
                    @{ workflowName = 'Security gates'; name = 'Security gate summary'; status = 'COMPLETED'; conclusion = $fixture.gateResult }
                    @{ workflowName = 'Security gates'; name = 'Package deterministic Web release artifact'; status = $fixture.otherStatus; conclusion = 'SKIPPED' }
                )
            } | ConvertTo-Json -Depth 4 -Compress
        }
        'pr merge *' {
            if ($command -notlike "*--match-head-commit $reviewed") { throw 'Merge did not pin the reviewed head.' }
            $fixture.prState = 'MERGED'
        }
        'api */contents/package.json?ref=*' { '{'; '  "version": "0.13.58"'; '}' }
        'api */contents/public/index.html?ref=*' { '<script defer src="app.js?v=offline-test-build"></script>' }
        'api */git/ref/heads/main *' { $fixture.mainSha }
        default { throw "Unexpected gh call: $command" }
    }
}

function ssh {
    $global:LASTEXITCODE = 0
    $command = $args[-1]
    $history.Add($command)
    switch -Wildcard ($command) {
        'test -x /opt/rai/deploy.sh' {}
        '/opt/rai/deploy.sh formal' { $global:LASTEXITCODE = $fixture.deployExit }
        'cd /opt/rai/apps/formal && *' {
            $merged
            foreach ($asset in @('index.html', 'app.js', 'styles.css', 'sw.js')) { "$hash  public/$asset" }
        }
        default { throw "Unexpected ssh call: $command" }
    }
}

function Invoke-RestMethod($Uri, $Headers, $TimeoutSec, $MaximumRedirection) {
    $history.Add($Uri)
    if ($Uri -like 'https://rai.rick.sarl/api/health?t=*') { return @{ ok = $true } }
    if ($Uri -like 'https://rai.rick.sarl/api/version?t=*') {
        return @{ success = $true; version = $params.Version; build = $fixture.liveBuild }
    }
    throw "Unexpected REST call: $Uri"
}

function Invoke-WebRequest($Uri, $Headers, $TimeoutSec, $MaximumRedirection, $OutFile, [switch]$UseBasicParsing) {
    $history.Add($Uri)
    if ($Uri -notmatch '^https://rai\.rick\.sarl/(?:(?:sw\.js)?\?|(?:app\.js|styles\.css)\?v=offline-test-build&)t=[a-f0-9]{32}$') {
        throw "Unexpected asset URL: $Uri"
    }
    [IO.File]::WriteAllText($OutFile, $fixture.livePayload)
}

function Reset-Fixture {
    $fixture.head = $reviewed
    $fixture.prState = 'OPEN'
    $fixture.gateResult = 'SUCCESS'
    $fixture.otherStatus = 'COMPLETED'
    $fixture.mainSha = $merged
    $fixture.deployExit = 0
    $fixture.liveBuild = $params.Build
    $fixture.livePayload = $payload
    $history.Clear()
}

function Assert-ReleaseFailure([string]$Expected) {
    try {
        & $release @params -Mode Release -DeployHost offline-host
    } catch {
        if ($_.Exception.Message -like "*$Expected*") { return }
        throw
    }
    throw "Expected failure: $Expected"
}

Reset-Fixture
& $release @params
if ($history.Count -ne 3) { throw 'Check mode should read only PR and source metadata.' }

Reset-Fixture
& $release @params -Mode Release -DeployHost offline-host
if ($history.IndexOf('/opt/rai/deploy.sh formal') -lt 0 -or @($history -like 'https://rai.rick.sarl/*').Count -ne 6) { throw 'Release did not execute deployment and verify all public URLs.' }
$history.Clear()
& $release @params -Mode Verify -DeployHost offline-host
if ($history -match '^pr merge |^/opt/rai/deploy\.sh') { throw 'Verify mode must not merge or deploy.' }

Reset-Fixture
$fixture.head = 'c' * 40
Assert-ReleaseFailure 'match the reviewed head'
if ($history -match '^pr merge ') { throw 'Moved head was merged.' }

Reset-Fixture
$fixture.gateResult = 'FAILURE'
Assert-ReleaseFailure 'successful Security gate summary'
if ($history -match '^pr merge ') { throw 'Failed gate was merged.' }

Reset-Fixture
$fixture.otherStatus = 'IN_PROGRESS'
Assert-ReleaseFailure 'pending or unsuccessful check'
if ($history -match '^pr merge ') { throw 'Pending check was merged.' }

Reset-Fixture
$fixture.mainSha = 'd' * 40
Assert-ReleaseFailure 'not the merge commit'
if ($history.Contains('/opt/rai/deploy.sh formal')) { throw 'Moved main was deployed.' }

Reset-Fixture
$fixture.deployExit = 1
Assert-ReleaseFailure 'failed with exit code 1'
if ($history -like 'https://rai.rick.sarl/*') { throw 'Failed deploy proceeded to public verification.' }

Reset-Fixture
$fixture.liveBuild = 'stale-build'
Assert-ReleaseFailure 'Public health or version verification failed'

Reset-Fixture
$fixture.livePayload = 'stale asset'
Assert-ReleaseFailure 'Public SHA-256 mismatch'
Write-Host 'Offline Web release regression passed.'
