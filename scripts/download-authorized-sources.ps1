[CmdletBinding()]
param(
    [string]$ManifestFile,
    [string]$OutputDirectory,
    [string]$CandidateFile
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ManifestFile)) { $ManifestFile = Join-Path $PSScriptRoot "..\data\song-download-sources.local.json" }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $PSScriptRoot "..\private-media\source" }
if ([string]::IsNullOrWhiteSpace($CandidateFile)) { $CandidateFile = Join-Path $PSScriptRoot "..\data\song-candidates.json" }
$downloader = Get-Command yt-dlp -ErrorAction SilentlyContinue
if (-not $downloader) { throw "yt-dlp was not found on PATH." }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 22 or newer is required for YouTube challenge handling." }
function Find-FfmpegDirectory {
    $command = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($command) { return Split-Path -Parent $command.Source }
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $wingetPackages -PathType Container) {
        $match = Get-ChildItem -LiteralPath $wingetPackages -Directory -Filter "Gyan.FFmpeg*" -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($match) { return $match.DirectoryName }
    }
    return $null
}
$ffmpegDirectory = Find-FfmpegDirectory
if (-not $ffmpegDirectory) { throw "ffmpeg was not found on PATH or in the WinGet package directory." }
if (-not (Test-Path -LiteralPath $ManifestFile -PathType Leaf)) {
    throw "Create $ManifestFile from data/song-download-sources.example.json and add explicitly authorized source URLs."
}
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}

$candidateRoot = Get-Content -LiteralPath $CandidateFile -Raw | ConvertFrom-Json
$candidateIds = @{}
foreach ($candidate in $candidateRoot.songs) { $candidateIds[$candidate.id] = $true }
$manifest = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json
foreach ($entry in $manifest.songs) {
    if (-not $candidateIds.ContainsKey($entry.id)) { throw "Unknown candidate id in source manifest: $($entry.id)" }
    if ([string]::IsNullOrWhiteSpace($entry.url)) {
        Write-Host "PENDING $($entry.id): no authorized source URL yet."
        continue
    }
    if ($entry.url -notmatch '^https://') { throw "Source URL for $($entry.id) must use HTTPS." }
    $outputTemplate = Join-Path $OutputDirectory "$($entry.id).%(ext)s"
    & $downloader.Source --no-playlist --no-overwrites --js-runtimes "node:$($node.Source)" --remote-components "ejs:github" --ffmpeg-location $ffmpegDirectory --format "bestaudio/best" --write-thumbnail --convert-thumbnails jpg --output $outputTemplate -- $entry.url
    if ($LASTEXITCODE -ne 0) { throw "Source download failed for $($entry.id)." }
}
Write-Host "Authorized sources are ready in $OutputDirectory. Run npm run prepare:r2 next."
