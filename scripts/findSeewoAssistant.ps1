$root = $env:SEEWOSERVICE_ROOT

if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) {
  exit 0
}

$candidate = Get-ChildItem -LiteralPath $root -Directory -Filter 'SeewoService_*' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $assistantDir = Join-Path $_.FullName 'SeewoServiceAssistant'
    $exePath = Join-Path $assistantDir 'SeewoServiceAssistant.exe'
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
      return
    }

    try {
      $exe = Get-Item -LiteralPath $exePath -ErrorAction Stop
    } catch {
      return
    }

    [pscustomobject]@{
      Path = $assistantDir
      LastWriteTimeUtc = $exe.LastWriteTimeUtc
    }
  } |
  Sort-Object `
    @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, `
    @{ Expression = 'Path'; Descending = $true } |
  Select-Object -First 1

if ($candidate) {
  [Console]::WriteLine($candidate.Path)
}
