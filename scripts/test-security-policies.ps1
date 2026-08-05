param(
  [string]$PostgresBin = "C:\Program Files\PostgreSQL\17\bin"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tempRootBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$runRoot = Join-Path $tempRootBase ("dealershot-security-{0}-{1}" -f $PID, [guid]::NewGuid().ToString("N"))
$dataDir = Join-Path $runRoot "data"
$logPath = Join-Path $runRoot "postgres.log"
$port = Get-Random -Minimum 55432 -Maximum 55999
$started = $false

$initdb = Join-Path $PostgresBin "initdb.exe"
$pgCtl = Join-Path $PostgresBin "pg_ctl.exe"
$createdb = Join-Path $PostgresBin "createdb.exe"
$psql = Join-Path $PostgresBin "psql.exe"
$postgres = Join-Path $PostgresBin "postgres.exe"
$pgIsReady = Join-Path $PostgresBin "pg_isready.exe"

foreach ($executable in @($initdb, $pgCtl, $createdb, $psql, $postgres, $pgIsReady)) {
  if (-not (Test-Path -LiteralPath $executable)) {
    throw "Required PostgreSQL executable not found: $executable"
  }
}

New-Item -ItemType Directory -Path $runRoot | Out-Null

try {
  & $initdb -D $dataDir --auth=trust --encoding=UTF8 --no-locale --username=postgres | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE" }

  # Launch postgres directly. Waiting on pg_ctl can wait on its detached child
  # process tree indefinitely in Windows PowerShell.
  $postgresProcess = Start-Process `
    -FilePath $postgres `
    -ArgumentList @("-D", $dataDir, "-p", "$port", "-h", "127.0.0.1") `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput $logPath `
    -RedirectStandardError (Join-Path $runRoot "postgres-error.log")
  $started = $true

  $ready = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    & $pgIsReady -h 127.0.0.1 -p $port -U postgres *> $null
    if ($LASTEXITCODE -eq 0) {
      $ready = $true
      break
    }
    if ($postgresProcess.HasExited) {
      throw "postgres exited before becoming ready"
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $ready) { throw "postgres did not become ready on port $port" }

  & $createdb -h 127.0.0.1 -p $port -U postgres dealershot_security | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "createdb failed with exit code $LASTEXITCODE" }

  $connectionArgs = @("-h", "127.0.0.1", "-p", "$port", "-U", "postgres", "-d", "dealershot_security", "-v", "ON_ERROR_STOP=1")
  & $psql @connectionArgs -f (Join-Path $repoRoot "supabase\tests\support\portable_supabase.sql") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Supabase compatibility bootstrap failed" }

  Get-ChildItem (Join-Path $repoRoot "supabase\migrations") -Filter "*.sql" |
    Sort-Object Name |
    ForEach-Object {
      Write-Host "Applying $($_.Name)"
      & $psql @connectionArgs -f $_.FullName | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($_.Name)" }
    }

  & $psql @connectionArgs -f (Join-Path $repoRoot "supabase\tests\portable\authorization_assertions.sql") | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Authorization assertions failed" }
}
finally {
  if ($started) {
    & $pgCtl -D $dataDir -m fast stop
  }

  $resolvedRunRoot = [System.IO.Path]::GetFullPath($runRoot)
  if ($resolvedRunRoot.StartsWith($tempRootBase, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedRunRoot -Leaf).StartsWith("dealershot-security-")) {
    Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
