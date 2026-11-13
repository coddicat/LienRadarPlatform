$ErrorActionPreference = "Stop"
$base = "https://lienradar-jvqlm.ondigitalocean.app"
$jar = Join-Path $env:TEMP "lr-cookies.txt"
$jobsFile = Join-Path $env:TEMP "lr-jobs.json"

for ($i = 0; $i -lt 90; $i++) {
  curl.exe -sS -c $jar -b $jar "$base/api/jobs" -o $jobsFile | Out-Null
  $j = Get-Content $jobsFile -Raw | ConvertFrom-Json
  $running = @($j.jobs | Where-Object { $_.lastStatus -eq "RUNNING" })
  $summary = ($j.jobs | ForEach-Object { "$($_.key)=$($_.lastStatus)" }) -join " | "
  Write-Output "[$i] running=$($running.Count) :: $summary"
  if ($running.Count -eq 0) { break }
  Start-Sleep -Seconds 30
}

Write-Output "==== FINAL ===="
$j = Get-Content $jobsFile -Raw | ConvertFrom-Json
foreach ($job in $j.jobs) {
  $err = if ($job.lastError) { $job.lastError } else { "" }
  $counts = if ($job.lastCounts) { ($job.lastCounts | ConvertTo-Json -Compress) } else { "" }
  Write-Output ("--- {0} enabled={1} status={2}" -f $job.key, $job.enabled, $job.lastStatus)
  if ($err) { Write-Output ("  error: {0}" -f $err) }
  if ($counts) { Write-Output ("  counts: {0}" -f $counts) }
}
