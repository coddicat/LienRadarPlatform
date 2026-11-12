#Requires -Version 5.1
<#
.SYNOPSIS
  One-command local control for LienRadar Platform (web + worker + Postgres).

.EXAMPLE
  .\scripts\lienradar.ps1 start
  .\scripts\lienradar.ps1 stop
  .\scripts\lienradar.ps1 restart
  .\scripts\lienradar.ps1 status
  .\scripts\lienradar.ps1 setup
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "restart", "status", "setup")]
  [string]$Command = "start",

  [switch]$NoWorker,
  [switch]$NoDocker,
  [switch]$SkipSeed,
  [switch]$StopDb,
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$StateDir = Join-Path $Root ".cache\lienradar"
$WebPidFile = Join-Path $StateDir "web.pid"
$WorkerPidFile = Join-Path $StateDir "worker.pid"
$WebLog = Join-Path $StateDir "web.log"
$WorkerLog = Join-Path $StateDir "worker.log"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

function Write-WarnLine([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Yellow
}

function Ensure-StateDir {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
}

function Get-PidFromFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $raw = (Get-Content $Path -Raw).Trim()
  if (-not $raw) { return $null }
  $id = 0
  if (-not [int]::TryParse($raw, [ref]$id)) { return $null }
  return $id
}

function Test-ProcessAlive([int]$ProcessId) {
  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Stop-ProcessTree([int]$RootId) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree -RootId ([int]$child.ProcessId)
  }
  if (Test-ProcessAlive $RootId) {
    Stop-Process -Id $RootId -Force -ErrorAction SilentlyContinue
  }
}

function Stop-TrackedProcess([string]$Name, [string]$PidFile) {
  $id = Get-PidFromFile $PidFile
  if ($null -eq $id) {
    Write-Host "    ${Name}: not tracked"
    return
  }
  if (Test-ProcessAlive $id) {
    Write-Host "    ${Name}: stopping process tree from PID $id"
    try {
      Stop-ProcessTree -RootId $id
    } catch {
      Write-WarnLine "${Name}: could not stop PID $id ($($_.Exception.Message))"
    }
  } else {
    Write-Host "    ${Name}: PID $id already gone"
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Stop-PortListeners([int]$ListenPort) {
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue)
  } catch {
    $conns = @()
  }
  foreach ($c in $conns) {
    $owningPid = $c.OwningProcess
    if ($owningPid -and (Test-ProcessAlive $owningPid)) {
      Write-Host "    freeing port $ListenPort (PID $owningPid)"
      Stop-Process -Id $owningPid -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-OrphanWorkers {
  # Kill any Node still loaded from this repo (worker/dev/tsx one-shots) that hold
  # query_engine-windows.dll.node. Never touch Cursor's helper node.exe.
  $rootEscaped = [regex]::Escape($Root)
  Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -match $rootEscaped -and
      $_.CommandLine -notmatch 'cursor\\resources|Cursor\\User' -and
      (
        $_.CommandLine -match 'packages\\ingest\\src\\worker\.ts' -or
        $_.CommandLine -match '@lienradar[/\\]ingest' -or
        $_.CommandLine -match 'worker\.ts' -or
        $_.CommandLine -match 'next (dev|start)' -or
        $_.CommandLine -match '\\apps\\web' -or
        $_.CommandLine -match 'tsx' -or
        $_.CommandLine -match 'npm run (worker|dev|once)' -or
        ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'npm (run )?(worker|dev)')
      )
    } |
    ForEach-Object {
      Write-Host "    stopping orphan $($_.Name) PID $($_.ProcessId)"
      try {
        Stop-ProcessTree -RootId ([int]$_.ProcessId)
      } catch {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
}

function Ensure-EnvFile {
  $envPath = Join-Path $Root ".env"
  $example = Join-Path $Root ".env.example"
  if (Test-Path $envPath) {
    Write-Ok ".env present"
    return
  }
  if (-not (Test-Path $example)) {
    throw ".env missing and .env.example not found"
  }
  Copy-Item $example $envPath
  Write-WarnLine "Created .env from .env.example - set NEXTAUTH_SECRET before production use"
}

function Ensure-Docker {
  if ($NoDocker) {
    Write-WarnLine "Skipping Docker (-NoDocker)"
    return
  }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found - install Docker Desktop or pass -NoDocker if Postgres is already running"
  }
  Write-Step "Postgres + Redis (docker compose)"
  Push-Location $Root
  try {
    docker compose up -d | Out-Host
    $deadline = (Get-Date).AddSeconds(60)
    do {
      $dbOk = $false
      $redisOk = $false
      try {
        $raw = docker compose ps --format json 2>$null
        foreach ($line in @($raw)) {
          if (-not $line) { continue }
          $obj = $line | ConvertFrom-Json
          $name = [string]$obj.Service
          $healthy = ($obj.Health -eq "healthy") -or ($obj.State -eq "running")
          if ($name -eq "db" -and $healthy) { $dbOk = $true }
          if ($name -eq "redis" -and $healthy) { $redisOk = $true }
        }
      } catch {
        $dbOk = $false
        $redisOk = $false
      }
      if ($dbOk -and $redisOk) { break }
      Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    Write-Ok "Postgres + Redis containers are up"
  } finally {
    Pop-Location
  }
}

function Ensure-Dependencies {
  Write-Step "Dependencies"
  Push-Location $Root
  try {
    if (-not (Test-Path (Join-Path $Root "node_modules"))) {
      npm install
    } else {
      Write-Ok "node_modules present"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-PrismaGenerate {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    npm run db:generate
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -ge 3) {
      throw "prisma generate failed after 3 attempts (exit $LASTEXITCODE). Stop any Node holding query_engine-windows.dll.node and retry."
    }
    Write-WarnLine "prisma generate failed (likely DLL lock) - retry $attempt/3 after stop..."
    Stop-TrackedProcess "web" $WebPidFile
    Stop-TrackedProcess "worker" $WorkerPidFile
    Stop-OrphanWorkers
    Stop-PortListeners $Port
    Start-Sleep -Seconds (2 * $attempt)
  }
}

function Ensure-BuildAndDb([switch]$ForceSeed) {
  Write-Step "Packages + database"
  Push-Location $Root
  try {
    Invoke-PrismaGenerate
    npm run build -w @lienradar/shared
    npm run build -w @lienradar/cache
    npm run build -w @lienradar/method
    npm run build -w @lienradar/db
    npm run build -w @lienradar/ingest
    npm run db:push
    if ((-not $SkipSeed) -or $ForceSeed) {
      npm run db:seed
    } else {
      Write-WarnLine "Skipping seed (-SkipSeed)"
    }
  } finally {
    Pop-Location
  }
}

function Ensure-Playwright {
  Write-Step "Playwright Chromium (REO / RealAuction)"
  Push-Location $Root
  try {
    npx playwright install chromium
    Write-Ok "Chromium ready"
  } catch {
    Write-WarnLine "Playwright install failed - live collectors may not work: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

function Start-BackgroundNpm([string]$Name, [string]$NpmArgs, [string]$PidFile, [string]$LogFile) {
  Ensure-StateDir
  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
  }

  # Keep a root cmd process alive for the whole npm session so stop can kill the tree.
  $cmdLine = "npm $NpmArgs >> `"$LogFile`" 2>&1"
  $proc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList @("/c", $cmdLine) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Seconds 2
  if (-not (Test-ProcessAlive $proc.Id)) {
    Write-WarnLine "${Name} exited early - see $LogFile"
  }

  Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
  Write-Ok "${Name} started (root PID $($proc.Id)) - log: $LogFile"
}

function Wait-Http([string]$Url, [int]$Seconds = 45) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) {
        return $true
      }
    } catch {
      # keep waiting
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Invoke-Setup {
  Ensure-StateDir
  Ensure-EnvFile
  Ensure-Docker
  Ensure-Dependencies
  Ensure-BuildAndDb -ForceSeed
  Ensure-Playwright
  Write-Step "Setup complete"
  Write-Ok "Run: .\scripts\lienradar.ps1 start"
}

function Invoke-Stop {
  Write-Step "Stopping LienRadar"
  Ensure-StateDir
  Stop-TrackedProcess "web" $WebPidFile
  Stop-TrackedProcess "worker" $WorkerPidFile
  Stop-OrphanWorkers
  Stop-PortListeners $Port

  if ($StopDb -and (-not $NoDocker)) {
    Write-Step "Stopping Postgres container"
    Push-Location $Root
    try {
      docker compose stop | Out-Host
    } finally {
      Pop-Location
    }
    Write-Ok "Postgres stopped (data volume kept)"
  } else {
    Write-Ok "Postgres left running (pass -StopDb to stop it)"
  }
  Write-Ok "Stopped"
}

function Invoke-Start {
  Ensure-StateDir
  Ensure-EnvFile
  Ensure-Docker
  Ensure-Dependencies

  # Stop Node first so prisma generate can replace query_engine-windows.dll.node
  # (Windows EPERM rename if web/worker still have the DLL loaded).
  Write-Step "Stopping previous web/worker (keep DB)"
  Stop-TrackedProcess "web" $WebPidFile
  Stop-TrackedProcess "worker" $WorkerPidFile
  Stop-OrphanWorkers
  Stop-PortListeners $Port
  Start-Sleep -Seconds 1

  Ensure-BuildAndDb

  if (-not $NoWorker) {
    Write-Step "Starting ingest worker (cron)"
    Start-BackgroundNpm "worker" "run worker" $WorkerPidFile $WorkerLog
  } else {
    Write-WarnLine "Skipping worker (-NoWorker)"
  }

  Write-Step "Starting web (http://localhost:$Port)"
  Start-BackgroundNpm "web" "run dev" $WebPidFile $WebLog

  Write-Step "Waiting for web"
  if (Wait-Http "http://localhost:$Port" 60) {
    Write-Ok "Web is responding"
  } else {
    Write-WarnLine "Web did not respond in time - check $WebLog"
  }

  Write-Host ""
  Write-Host "LienRadar is up" -ForegroundColor Green
  Write-Host "  App:    http://localhost:$Port"
  Write-Host "  Login:  owner@lienradar.local / lienradar"
  Write-Host "  Admin:  http://localhost:$Port/admin"
  Write-Host "  Logs:   $StateDir"
  Write-Host "  Stop:   .\scripts\lienradar.ps1 stop"
}

function Invoke-Status {
  Ensure-StateDir
  Write-Step "Status"

  $webId = Get-PidFromFile $WebPidFile
  $workerId = Get-PidFromFile $WorkerPidFile

  if ($webId -and (Test-ProcessAlive $webId)) {
    Write-Ok "web: running (PID $webId)"
  } else {
    Write-WarnLine "web: not running"
  }

  if ($workerId -and (Test-ProcessAlive $workerId)) {
    Write-Ok "worker: running (PID $workerId)"
  } else {
    Write-WarnLine "worker: not running"
  }

  try {
    $res = Invoke-WebRequest -Uri "http://localhost:$Port" -UseBasicParsing -TimeoutSec 3
    Write-Ok "http://localhost:$Port -> HTTP $($res.StatusCode)"
  } catch {
    Write-WarnLine "http://localhost:$Port -> not reachable"
  }

  if ((-not $NoDocker) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
    Push-Location $Root
    try {
      docker compose ps | Out-Host
    } finally {
      Pop-Location
    }
  }
}

switch ($Command) {
  "setup" { Invoke-Setup }
  "start" { Invoke-Start }
  "stop" { Invoke-Stop }
  "restart" {
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  }
  "status" { Invoke-Status }
}
