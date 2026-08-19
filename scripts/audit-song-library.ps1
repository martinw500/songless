[CmdletBinding()]
param(
    [string]$CandidateFile = (Join-Path $PSScriptRoot "..\data\song-candidates.json"),
    [string]$AudioDirectory = (Join-Path $PSScriptRoot "..\public\media\audio"),
    [string]$ArtworkDirectory = (Join-Path $PSScriptRoot "..\public\media\artwork"),
    [string]$CatalogFile = (Join-Path $PSScriptRoot "..\public\catalog.json"),
    [string]$LonglistFile = (Join-Path $PSScriptRoot "..\data\song-longlist.json")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $CandidateFile -PathType Leaf)) {
    throw "Candidate file does not exist: $CandidateFile"
}

$libraryScript = Join-Path $PSScriptRoot "song-library.mjs"
& node $libraryScript audit --candidate-file $CandidateFile --audio-dir $AudioDirectory --artwork-dir $ArtworkDirectory --catalog-file $CatalogFile --longlist-file $LonglistFile
if ($LASTEXITCODE -ne 0) {
    throw "Song library audit failed."
}
