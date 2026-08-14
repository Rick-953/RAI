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
    $extensionId = [string]$channel.extensions.id
    $extensionDistribution = [string]$channel.extensions.distribution
    $extensionArtifact = $channel.extensions.artifact
    if ($extensionDistribution -ne 'github-unpacked') { throw 'Unsupported extension distribution' }
    if ($extensionId -notmatch '^[a-p]{32}$' -or $chromeId -ne $extensionId -or $edgeId -ne $extensionId) {
        throw 'The RAI Connect extension origins do not match the stable manifest ID'
    }
    if (([Uri]([string]$artifact.url)).Scheme -ne 'https' -or ([Uri]([string]$extensionArtifact.url)).Scheme -ne 'https') {
        throw 'Release artifacts must use HTTPS'
    }

    $archive = Join-Path $tempDir 'rai-agent.zip'
    $extensionArchive = Join-Path $tempDir 'rai-connect-extension.zip'
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$artifact.url) -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$extensionArtifact.url) -OutFile $extensionArchive
    $actualSha = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
    if ($actualSha -ne ([string]$artifact.sha256).ToLowerInvariant()) { throw 'RAI Agent checksum mismatch' }
    $extensionSha = (Get-FileHash -Algorithm SHA256 -Path $extensionArchive).Hash.ToLowerInvariant()
    if ($extensionSha -ne ([string]$extensionArtifact.sha256).ToLowerInvariant()) { throw 'RAI Connect checksum mismatch' }

    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
        & $gh.Source attestation verify $archive --repo 'Rick-953/RAI' --signer-workflow 'Rick-953/RAI/.github/workflows/local-agent-release.yml' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'RAI Agent provenance verification failed' }
        & $gh.Source attestation verify $extensionArchive --repo 'Rick-953/RAI' --signer-workflow 'Rick-953/RAI/.github/workflows/local-agent-release.yml' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'RAI Connect provenance verification failed' }
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

    $extensionTarget = Join-Path $installRoot 'extension'
    $extensionStaging = Join-Path $installRoot ('.extension-' + [Guid]::NewGuid().ToString('N'))
    $extensionBackup = Join-Path $installRoot ('.extension-previous-' + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -Path $extensionArchive -DestinationPath $extensionStaging
    $extensionManifestPath = Join-Path $extensionStaging 'manifest.json'
    if (-not (Test-Path $extensionManifestPath -PathType Leaf)) { throw 'RAI Connect manifest missing from archive' }
    $extensionManifest = Get-Content -Raw -Path $extensionManifestPath | ConvertFrom-Json
    if ([string]$extensionManifest.version -ne [string]$channel.version) { throw 'RAI Connect version mismatch' }
    if (Test-Path $extensionTarget) { Move-Item -Path $extensionTarget -Destination $extensionBackup }
    try {
        Move-Item -Path $extensionStaging -Destination $extensionTarget
    } catch {
        if (Test-Path $extensionBackup) { Move-Item -Path $extensionBackup -Destination $extensionTarget }
        throw
    }
    if (Test-Path $extensionBackup) { Remove-Item -LiteralPath $extensionBackup -Recurse -Force }

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

    function Open-ExtensionPage([string]$CommandName, [string[]]$Paths, [string]$Page) {
        $command = Get-Command $CommandName -ErrorAction SilentlyContinue
        if ($command) {
            Start-Process -FilePath $command.Source -ArgumentList $Page
            return
        }
        foreach ($candidate in $Paths) {
            if ($candidate -and (Test-Path $candidate -PathType Leaf)) {
                Start-Process -FilePath $candidate -ArgumentList $Page
                return
            }
        }
    }

    $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
    Open-ExtensionPage 'chrome.exe' @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    ) 'chrome://extensions'
    Open-ExtensionPage 'msedge.exe' @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe')
    ) 'edge://extensions'
    Start-Process 'https://rai.rick.sarl/?local-agent=connect'

    Write-Host "RAI Agent $($channel.version) and RAI Connect were downloaded and verified."
    Write-Host 'In chrome://extensions or edge://extensions, enable Developer mode, choose Load unpacked, and select:'
    Write-Host "  $extensionTarget"
    Write-Host 'Then bind this device in RAI Settings > Capabilities > RAI Local Agent.'
} finally {
    if (Test-Path $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
