$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$channelUrl = if ($env:RAI_AGENT_CHANNEL_URL) { $env:RAI_AGENT_CHANNEL_URL } else { 'https://github.com/Rick-953/RAI/releases/latest/download/local-agent-channel.json' }
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rai-agent-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
    $channelPath = Join-Path $tempDir 'channel.json'
    Invoke-WebRequest -UseBasicParsing -Uri $channelUrl -OutFile $channelPath
    $channel = Get-Content -Raw -Path $channelPath | ConvertFrom-Json
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'RAI Agent requires 64-bit Windows' }
    $artifact = $channel.artifacts.'windows-x86_64'
    $chromeId = [string]$channel.extensions.chrome
    $edgeId = [string]$channel.extensions.edge
    if ($chromeId -notmatch '^[a-p]{32}$' -or $edgeId -notmatch '^[a-p]{32}$') {
        throw 'The RAI Connect store IDs are not configured in this release channel'
    }

    $archive = Join-Path $tempDir 'rai-agent.zip'
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$artifact.url) -OutFile $archive
    $actualSha = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
    if ($actualSha -ne ([string]$artifact.sha256).ToLowerInvariant()) { throw 'RAI Agent checksum mismatch' }

    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        & $gh.Source attestation verify $archive --repo 'Rick-953/RAI' --signer-workflow 'Rick-953/RAI/.github/workflows/local-agent-release.yml' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'RAI Agent provenance verification failed' }
    } elseif ($env:RAI_REQUIRE_ATTESTATION -eq '1') {
        throw 'gh is required when RAI_REQUIRE_ATTESTATION=1'
    }

    $installRoot = if ($env:RAI_AGENT_INSTALL_ROOT) { $env:RAI_AGENT_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'RAI\Agent' }
    $versions = Join-Path $installRoot 'versions'
    $target = Join-Path $versions ([string]$channel.version)
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Expand-Archive -Force -Path $archive -DestinationPath $target
    $binary = Join-Path $target 'rai-agent.exe'
    if (-not (Test-Path $binary -PathType Leaf)) { throw 'RAI Agent binary missing from archive' }

    $currentFile = Join-Path $installRoot 'current.txt'
    $currentTemp = Join-Path $installRoot 'current.tmp'
    [System.IO.File]::WriteAllText($currentTemp, $target, [System.Text.UTF8Encoding]::new($false))
    Move-Item -Force -Path $currentTemp -Destination $currentFile

    Get-ChildItem -Path $versions -Directory | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object {
        if ($_.FullName.StartsWith($versions, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
    }

    & $binary install --chrome-id $chromeId --edge-id $edgeId
    if ($LASTEXITCODE -ne 0) { throw 'Native Messaging registration failed' }
    Write-Host "RAI Agent $($channel.version) installed. Confirm the extension installation in the browser, then bind this device in RAI Settings > Security."
} finally {
    if (Test-Path $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
