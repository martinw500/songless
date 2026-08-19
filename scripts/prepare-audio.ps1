[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputDirectory,

    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\public\media\audio"),

    [string]$ArtworkDirectory = (Join-Path $PSScriptRoot "..\public\media\artwork"),

    [string]$CandidateFile = (Join-Path $PSScriptRoot "..\data\song-candidates.json"),

    [ValidateRange(30, 60)]
    [int]$MaxSeconds = 60,

    [ValidateRange(64, 320)]
    [int]$BitrateKbps = 96
)

$ErrorActionPreference = "Stop"
$supportedExtensions = @(".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac")

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw "ffmpeg was not found on PATH. Install ffmpeg, reopen PowerShell, and try again."
}

if (-not (Test-Path -LiteralPath $InputDirectory -PathType Container)) {
    throw "Input directory does not exist: $InputDirectory"
}
if (-not (Test-Path -LiteralPath $CandidateFile -PathType Leaf)) {
    throw "Candidate file does not exist: $CandidateFile"
}

$inputRoot = (Resolve-Path -LiteralPath $InputDirectory).Path
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
if (-not (Test-Path -LiteralPath $ArtworkDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $ArtworkDirectory -Force | Out-Null
}
$artworkRoot = (Resolve-Path -LiteralPath $ArtworkDirectory).Path
$candidateRoot = Get-Content -LiteralPath $CandidateFile -Raw | ConvertFrom-Json
$candidatesById = @{}
foreach ($candidate in $candidateRoot.songs) {
    $candidatesById[$candidate.id] = $candidate
}

$files = Get-ChildItem -LiteralPath $inputRoot -Recurse -File |
    Where-Object { $supportedExtensions -contains $_.Extension.ToLowerInvariant() }

if ($files.Count -eq 0) {
    Write-Host "No supported audio files found in $inputRoot"
    exit 0
}

$prepared = 0
$skipped = 0

foreach ($file in $files) {
    $candidateId = $file.BaseName.ToLowerInvariant()
    if (-not $candidatesById.ContainsKey($candidateId)) {
        Write-Warning "SKIP $($file.Name): rename it to a candidate id from data/song-candidates.json."
        $skipped += 1
        continue
    }

    $candidate = $candidatesById[$candidateId]
    $target = Join-Path $outputRoot $candidate.media.audioFile
    if (Test-Path -LiteralPath $target) {
        Write-Host "SKIP  $($file.Name) -> $([IO.Path]::GetFileName($target))"
        $skipped += 1
        continue
    }

    & ffmpeg -hide_banner -loglevel error -n -i $file.FullName -t $MaxSeconds -vn -map_metadata -1 -codec:a libmp3lame -b:a "${BitrateKbps}k" -ar 44100 -ac 2 $target
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed while processing: $($file.FullName)"
    }

    Write-Host "READY $($file.Name) -> $([IO.Path]::GetFileName($target))"

    $artworkTarget = Join-Path $artworkRoot $candidate.media.artworkFile
    if (-not (Test-Path -LiteralPath $artworkTarget)) {
        & ffmpeg -hide_banner -loglevel error -n -i $file.FullName -an -map "0:v:0?" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" -frames:v 1 -q:v 3 $artworkTarget
        if (Test-Path -LiteralPath $artworkTarget) {
            Write-Host "COVER $($candidate.media.artworkFile)"
        }
    }
    $prepared += 1
}

Write-Host "Prepared $prepared clip(s); skipped $skipped existing clip(s)."
Write-Host "Each 60-second 96 kbps clip is approximately 720 KB."
Write-Host "Review each exact intro, then run npm run approve:song -- --id <id> --intro <0-100>."
