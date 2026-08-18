[CmdletBinding()]
param(
    [string]$CandidateFile = (Join-Path $PSScriptRoot "..\data\song-candidates.json"),
    [string]$AudioDirectory = (Join-Path $PSScriptRoot "..\public\media\audio"),
    [string]$ArtworkDirectory = (Join-Path $PSScriptRoot "..\public\media\artwork")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $CandidateFile -PathType Leaf)) {
    throw "Candidate file does not exist: $CandidateFile"
}

$candidateRoot = Get-Content -LiteralPath $CandidateFile -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $candidateRoot.songs) {
    throw "Candidate file has no songs array: $CandidateFile"
}

$audioRoot = [IO.Path]::GetFullPath($AudioDirectory)
$artworkRoot = [IO.Path]::GetFullPath($ArtworkDirectory)
$artworkExtensions = @(".jpg", ".jpeg", ".png", ".webp", ".avif")
$rows = foreach ($song in $candidateRoot.songs) {
    $audioPath = Join-Path $audioRoot "$($song.id).mp3"
    $artworkPath = $null
    foreach ($extension in $artworkExtensions) {
        $candidateArtwork = Join-Path $artworkRoot "$($song.id)$extension"
        if (Test-Path -LiteralPath $candidateArtwork -PathType Leaf) {
            $artworkPath = $candidateArtwork
            break
        }
    }

    [PSCustomObject]@{
        Status = if (Test-Path -LiteralPath $audioPath -PathType Leaf) { "READY" } else { "NEEDS AUDIO" }
        Id = $song.id
        Title = $song.title
        Artist = $song.artist
        Artwork = if ($artworkPath) { "YES" } else { "OPTIONAL" }
    }
}

$rows | Format-Table Status, Id, Title, Artist, Artwork -AutoSize
$readyCount = @($rows | Where-Object { $_.Status -eq "READY" }).Count
$missingCount = $rows.Count - $readyCount

Write-Host ""
Write-Host "$readyCount candidate(s) have audio; $missingCount still need a clip."
Write-Host "Expected audio naming: public/media/audio/<candidate-id>.mp3"
