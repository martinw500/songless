$ffmpeg = 'C:\Users\marti\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe'
$tmp = 'D:\Documents D-Drive\Coding Projects\songless\private-media\__test_probe.raw'

& $ffmpeg -hide_banner -loglevel error -y -i 'private-media\r2\clues\p-nk-try.mp3' -t 2.0 -ac 1 -ar 44100 -f f32le -acodec pcm_f32le $tmp
$bytes = [IO.File]::ReadAllBytes($tmp)
$count = $bytes.Length / 4
$windowSize = 441
$threshold = 0.01
$found = -1

$maxRms = 0.0
for ($i = 0; $i -lt ($count - $windowSize); $i += 441) { # 10ms steps
    $sumSq = 0.0
    for ($w = 0; $w -lt $windowSize; $w++) {
        $v = [BitConverter]::ToSingle($bytes, ($i + $w) * 4)
        $sumSq += $v * $v
    }
    $rms = [Math]::Sqrt($sumSq / $windowSize)
    if ($rms -gt $maxRms) { $maxRms = $rms }
    if ($rms -gt $threshold -and $found -eq -1) {
        $found = $i
    }
    $ms = [Math]::Floor(($i / 44100.0) * 1000)
    if ($ms -lt 1000) {
        Write-Host "RMS at ${ms}ms : $rms"
    }
}
Write-Host "Max RMS in first chunk: $maxRms"
Write-Host "Onset Ms: " ([Math]::Floor(($found / 44100.0) * 1000))
Remove-Item $tmp
