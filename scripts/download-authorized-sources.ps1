[CmdletBinding()]
param(
    [string]$ManifestFile,
    [string]$OutputDirectory,
    [string]$CandidateFile,
    [string[]]$Ids,
    [switch]$Replace,
    [switch]$ContinueOnError
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
$selectedIds = @{}
foreach ($id in $Ids) {
    foreach ($part in $id.Split(',')) {
        if (-not [string]::IsNullOrWhiteSpace($part)) { $selectedIds[$part.Trim()] = $true }
    }
}
$matchingEntries = @($manifest.songs | Where-Object { $selectedIds.Count -eq 0 -or $selectedIds.ContainsKey($_.id) })
$entriesById = @{}
foreach ($entry in $matchingEntries) {
    if ($entriesById.ContainsKey($entry.id)) {
        $previous = $entriesById[$entry.id]
        if (-not [string]::IsNullOrWhiteSpace($previous.url) -and
            -not [string]::IsNullOrWhiteSpace($entry.url) -and
            $previous.url -ne $entry.url) {
            throw "Conflicting duplicate source rows for $($entry.id): $($previous.url) and $($entry.url)"
        }
        if ([string]::IsNullOrWhiteSpace($previous.url) -or ($entry.youtube -and -not $previous.youtube)) {
            $entriesById[$entry.id] = $entry
        }
    } else {
        $entriesById[$entry.id] = $entry
    }
}
$entries = @($entriesById.Values)
$failedDownloads = @()
$missing = @()
if ($selectedIds.Count -gt 0) {
    $missing = @($selectedIds.Keys | Where-Object { -not $entriesById.ContainsKey($_) })
}
if ($missing.Count -gt 0) {
    throw "Selected source ids are missing from the manifest: $($missing -join ', ')"
}
$backupDirectory = $null
if ($Replace) {
    $backupDirectory = Join-Path (Split-Path -Parent $OutputDirectory) ("replaced-backup\" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
}
foreach ($entry in $entries) {
    if (-not $candidateIds.ContainsKey($entry.id)) { throw "Unknown candidate id in source manifest: $($entry.id)" }
    if ([string]::IsNullOrWhiteSpace($entry.url)) {
        Write-Host "PENDING $($entry.id): no authorized source URL yet."
        continue
    }
    if ($entry.url -notmatch '^https://') { throw "Source URL for $($entry.id) must use HTTPS." }
    if ($Replace) {
        $existingFiles = @(Get-ChildItem -LiteralPath $OutputDirectory -File | Where-Object { $_.BaseName -eq $entry.id })
        foreach ($existingFile in $existingFiles) {
            Move-Item -LiteralPath $existingFile.FullName -Destination (Join-Path $backupDirectory $existingFile.Name)
        }
    }
    $outputTemplate = Join-Path $OutputDirectory "$($entry.id).%(ext)s"
    $overwrite = if ($Replace) { "--force-overwrites" } else { "--no-overwrites" }
    & $downloader.Source --no-playlist $overwrite --newline --socket-timeout 20 --retries 2 --fragment-retries 2 --extractor-retries 2 --js-runtimes "node:$($node.Source)" --remote-components "ejs:github" --ffmpeg-location $ffmpegDirectory --format "bestaudio/best" --write-thumbnail --convert-thumbnails jpg --output $outputTemplate -- $entry.url
    if ($LASTEXITCODE -ne 0) {
        if (-not $ContinueOnError) { throw "Source download failed for $($entry.id)." }
        $failedDownloads += $entry.id
        Write-Warning "FAILED $($entry.id): source download did not complete."
    }
}
if ($Replace) { Write-Host "Previous exact-id source files were backed up to $backupDirectory." }
if ($failedDownloads.Count -gt 0) { Write-Warning "Failed source ids: $($failedDownloads -join ', ')" }
Write-Host "Authorized sources are ready in $OutputDirectory. Run npm run prepare:r2 next."
