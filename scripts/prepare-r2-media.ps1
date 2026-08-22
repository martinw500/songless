[CmdletBinding()]
param(
    [string]$InputDirectory = "private-media\source",

    [string]$OutputRoot = "private-media\r2",

    [string]$CandidateFile = "data\song-candidates.json",

    [string]$FfmpegDirectory,

    [ValidateRange(64, 192)]
    [int]$BitrateKbps = 128,

    [ValidateRange(20, 60)]
    [int]$ClueSeconds = 30,

    [long]$MaxPreparedBytes = 8500000000,

    [switch]$Force
)

$ErrorActionPreference = "Stop"
$supportedExtensions = @(".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac", ".webm", ".mp4")
function Find-MediaTool([string]$Name) {
    if (-not [string]::IsNullOrWhiteSpace($FfmpegDirectory)) {
        $explicit = Join-Path $FfmpegDirectory "$Name.exe"
        if (Test-Path -LiteralPath $explicit -PathType Leaf) { return $explicit }
    }
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $wingetPackages -PathType Container) {
        $match = Get-ChildItem -LiteralPath $wingetPackages -Directory -Filter "Gyan.FFmpeg*" -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Filter "$Name.exe" -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($match) { return $match.FullName }
    }
    return $null
}
$ffmpeg = Find-MediaTool "ffmpeg"
$ffprobe = Find-MediaTool "ffprobe"
if (-not $ffmpeg -or -not $ffprobe) {
    throw "ffmpeg and ffprobe were not found on PATH. Reopen PowerShell after installing ffmpeg, then try again."
}
if (-not (Test-Path -LiteralPath $InputDirectory -PathType Container)) {
    throw "Input directory does not exist: $InputDirectory"
}
if (-not (Test-Path -LiteralPath $CandidateFile -PathType Leaf)) {
    throw "Candidate file does not exist: $CandidateFile"
}

$inputRoot = (Resolve-Path -LiteralPath $InputDirectory).Path
$fullRoot = Join-Path $OutputRoot "full"
$clueRoot = Join-Path $OutputRoot "clues"
$artworkRoot = Join-Path $OutputRoot "artwork"
foreach ($directory in @($OutputRoot, $fullRoot, $clueRoot, $artworkRoot)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
}

$candidateRoot = Get-Content -LiteralPath $CandidateFile -Raw | ConvertFrom-Json
$candidatesById = @{}
foreach ($candidate in $candidateRoot.songs) { $candidatesById[$candidate.id] = $candidate }
$sourceFiles = @(Get-ChildItem -LiteralPath $inputRoot -Recurse -File |
    Where-Object { $supportedExtensions -contains $_.Extension.ToLowerInvariant() })
if ($sourceFiles.Count -eq 0) {
    Write-Host "No supported source files found in $inputRoot"
    exit 0
}
$duplicateSources = @($sourceFiles | Group-Object { $_.BaseName.ToLowerInvariant() } | Where-Object { $_.Count -gt 1 })
if ($duplicateSources.Count -gt 0) {
    $labels = $duplicateSources | ForEach-Object { "$($_.Name) ($($_.Count) files)" }
    throw "Each candidate must have exactly one source media file. Resolve duplicates: $($labels -join ', ')"
}

function Get-LeadingSilenceSeconds([string]$InputFile) {
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $ffmpeg
    $processInfo.Arguments = "-hide_banner -nostats -y -i `"$InputFile`" -af silencedetect=noise=-45dB:d=0.02 -t 30 -f null -"
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $processInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $processInfo
    [void]$process.Start()
    $analysisText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "ffmpeg silence analysis failed for $InputFile" }
    if ($analysisText -match 'silence_start:\s*0(?:\.0+)?') {
        if ($analysisText -notmatch 'silence_end:\s*([0-9]+(?:\.[0-9]+)?)') {
            throw "Source remains silent through the 30-second inspection window: $InputFile"
        }
        $detected = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
        return [Math]::Min(30, [Math]::Max(0, $detected - 0.03))
    }
    return 0
}

$prepared = 0
$trimById = @{}
foreach ($file in $sourceFiles) {
    $candidateId = $file.BaseName.ToLowerInvariant()
    if (-not $candidatesById.ContainsKey($candidateId)) {
        Write-Warning "SKIP $($file.Name): rename it to a candidate id from data/song-candidates.json."
        continue
    }

    Write-Host "Analyzing $($file.FullName)..."; $trimSeconds = Get-LeadingSilenceSeconds $file.FullName; Write-Host "Analyzed!"
    $trimById[$candidateId] = [Math]::Round($trimSeconds * 1000)
    $seekArgs = @()
    if ($trimSeconds -gt 0.02) {
        $seekArgs = @("-ss", $trimSeconds.ToString("0.###", [Globalization.CultureInfo]::InvariantCulture))
    }

    $fullTarget = Join-Path $fullRoot "$candidateId.mp3"
    $clueTarget = Join-Path $clueRoot "$candidateId.mp3"
    if ($Force -or -not (Test-Path -LiteralPath $fullTarget)) {
        $overwrite = if ($Force) { "-y" } else { "-n" }
        & $ffmpeg -hide_banner -loglevel error $overwrite @seekArgs -i $file.FullName -vn -map_metadata -1 -codec:a libmp3lame -b:a "${BitrateKbps}k" -ar 44100 -ac 2 $fullTarget
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed while encoding the full track: $($file.FullName)" }
    }
    if ($Force -or -not (Test-Path -LiteralPath $clueTarget)) {
        $overwrite = if ($Force) { "-y" } else { "-n" }
        & $ffmpeg -hide_banner -loglevel error $overwrite @seekArgs -i $file.FullName -t $ClueSeconds -vn -map_metadata -1 -codec:a libmp3lame -b:a "${BitrateKbps}k" -ar 44100 -ac 2 $clueTarget
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed while encoding the clue asset: $($file.FullName)" }
    }

    $durationText = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $fullTarget
    $durationSeconds = [double]::Parse($durationText.Trim(), [Globalization.CultureInfo]::InvariantCulture)
    $trimMessage = if ($trimSeconds -gt 0.02) { "; trimmed $([Math]::Round($trimSeconds, 3))s leading silence" } else { "" }
    Write-Host "READY $candidateId ($([Math]::Round($durationSeconds, 1))s full + ${ClueSeconds}s clue$trimMessage)"
    $prepared += 1
}

$allPreparedFiles = @(Get-ChildItem -LiteralPath $OutputRoot -Recurse -File | Where-Object { $_.Name -ne "manifest.json" })
$totalBytes = ($allPreparedFiles | Measure-Object -Property Length -Sum).Sum
if ($null -eq $totalBytes) { $totalBytes = 0 }
if ($totalBytes -gt $MaxPreparedBytes) {
    throw "Prepared media is $totalBytes bytes, above the local safety ceiling of $MaxPreparedBytes. Nothing has been uploaded."
}

$manifestSongs = @()
foreach ($fullFile in @(Get-ChildItem -LiteralPath $fullRoot -Filter *.mp3 -File)) {
    $candidateId = $fullFile.BaseName
    $clueFile = Join-Path $clueRoot "$candidateId.mp3"
    if (-not (Test-Path -LiteralPath $clueFile -PathType Leaf)) { continue }
    $durationText = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $fullFile.FullName
    $durationMs = [Math]::Round([double]::Parse($durationText.Trim(), [Globalization.CultureInfo]::InvariantCulture) * 1000)
    $manifestSongs += [ordered]@{
        id = $candidateId
        durationMs = $durationMs
        leadingSilenceTrimMs = $(if ($trimById.ContainsKey($candidateId)) { $trimById[$candidateId] } else { 0 })
        fullFile = "full/$candidateId.mp3"
        clueFile = "clues/$candidateId.mp3"
    }
}

$manifest = [ordered]@{
    version = 1
    bitrateKbps = $BitrateKbps
    clueSeconds = $ClueSeconds
    totalBytes = $totalBytes
    songs = $manifestSongs
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutputRoot "manifest.json"), $manifestJson, $utf8NoBom)
Write-Host "Prepared $prepared source track(s); manifest contains $($manifestSongs.Count) complete track(s)."
Write-Host "Local prepared size: $([Math]::Round($totalBytes / 1GB, 3)) GiB. Uploading is a separate guarded step."
