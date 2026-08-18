[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputDirectory,

    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\public\media\audio"),

    [ValidateRange(15, 60)]
    [int]$MaxSeconds = 20,

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

$inputRoot = (Resolve-Path -LiteralPath $InputDirectory).Path
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path

$files = Get-ChildItem -LiteralPath $inputRoot -Recurse -File |
    Where-Object { $supportedExtensions -contains $_.Extension.ToLowerInvariant() }

if ($files.Count -eq 0) {
    Write-Host "No supported audio files found in $inputRoot"
    exit 0
}

$prepared = 0
$skipped = 0

foreach ($file in $files) {
    $slug = $file.BaseName.ToLowerInvariant()
    $slug = [regex]::Replace($slug, "[^a-z0-9]+", "-").Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) {
        $slug = "track"
    }

    $target = Join-Path $outputRoot "$slug.mp3"
    if (Test-Path -LiteralPath $target) {
        Write-Host "SKIP  $($file.Name) -> $([IO.Path]::GetFileName($target))"
        $skipped += 1
        continue
    }

    & ffmpeg -hide_banner -loglevel error -n -i $file.FullName -t $MaxSeconds -vn -map_metadata -1 -codec:a libmp3lame -b:a "${BitrateKbps}k" $target
    if ($LASTEXITCODE -ne 0) {
        throw "ffmpeg failed while processing: $($file.FullName)"
    }

    Write-Host "READY $($file.Name) -> $([IO.Path]::GetFileName($target))"
    $prepared += 1
}

Write-Host "Prepared $prepared clip(s); skipped $skipped existing clip(s)."
Write-Host "Add each clip to public/catalog.json using /media/audio/<filename>.mp3."

