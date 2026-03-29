# awacs - lightweight CLI client for AWACS (Windows)
# Usage: pwsh awacs.ps1 <command> [options]

$ErrorActionPreference = "Stop"
$AwacsUrl = if ($env:AWACS_URL) { $env:AWACS_URL } else { "http://localhost:7777" }

function Show-Usage {
    Write-Host @"
Usage: awacs <command> [options]

Commands:
  ls, list          List running services (default)
  watch             Live-stream service updates
  kill <pid|name>   Kill a service by PID or docker name
  restart <pid>     Restart a service by PID

Options:
  --local           Only show local services
  --json            Output raw JSON
  --host <url>      Override AWACS server (default: `$env:AWACS_URL or $AwacsUrl)
"@
    exit 0
}

# --- Parse args ---
$Local = ""
$Json = $false
$Cmd = ""
$CmdArgs = @()

$i = 0
while ($i -lt $args.Count) {
    switch ($args[$i]) {
        "--local"  { $Local = "?local=1" }
        "--json"   { $Json = $true }
        "--host"   { $i++; $AwacsUrl = $args[$i] }
        { $_ -in "-h","--help","help" } { Show-Usage }
        default {
            if ($args[$i].StartsWith("-")) {
                Write-Error "Unknown flag: $($args[$i])"
                exit 1
            }
            if (-not $Cmd) { $Cmd = $args[$i] }
            else { $CmdArgs += $args[$i] }
        }
    }
    $i++
}

if (-not $Cmd) { $Cmd = "ls" }

# --- Helpers ---
function Format-Rss($kb) {
    if ($kb -gt 1048576) { return "{0:N1} GB" -f ($kb / 1048576) }
    if ($kb -gt 1024)    { return "{0:N0} MB" -f ($kb / 1024) }
    return "$kb KB"
}

function Invoke-Awacs {
    param([string]$Path, [string]$Method = "GET", $Body = $null)
    $uri = "$AwacsUrl$Path"
    $params = @{ Uri = $uri; Method = $Method; ContentType = "application/json"; UseBasicParsing = $true }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10) }
    try {
        return Invoke-RestMethod @params
    } catch {
        Write-Error "Error: cannot reach $AwacsUrl"
        exit 1
    }
}

# --- Commands ---
function Invoke-List {
    $services = Invoke-Awacs "/api/services$Local"
    if (-not $services -or $services.Count -eq 0) {
        Write-Host "No services found."
        return
    }
    if ($Json) {
        $services | ConvertTo-Json -Depth 10
        return
    }

    $fmt = "{0,-7} {1,-6} {2,-14} {3,-40} {4,-8} {5,-10} {6}"
    Write-Host ($fmt -f "PORT","PID","COMMAND","ARGS","CPU%","MEM","PROJECT") -ForegroundColor White

    foreach ($s in $services) {
        $port = if ($s.port) { ":$($s.port)" } else { "-" }
        $sPid = if ($s.pid) { $s.pid } else { "-" }
        $isDocker = $s.source -eq "docker"
        $cmd = if ($isDocker) { "docker" } else { $s.command }
        $sArgs = if ($isDocker) { $s.dockerImage } else { $s.args }
        $sArgs = $sArgs -replace '(?i)[A-Z]:\\Users\\[^\\]+', '~' -replace '/Users/[^/\s]+', '~'
        if ($sArgs.Length -gt 38) { $sArgs = $sArgs.Substring(0, 37) + "..." }
        $cpu = if ($isDocker) { $s.dockerStatus } else { "{0:N1}%" -f $s.cpu }
        $mem = if ($isDocker) { "" } else { Format-Rss $s.rss }
        $proj = if ($s.projectName) { $s.projectName } else { "-" }

        $line = $fmt -f $port, $sPid, $cmd, $sArgs, $cpu, $mem, $proj
        if ($s.peerHostname) { $line += " [$($s.peerHostname)]" }
        Write-Host $line
    }
}

function Invoke-Watch {
    $tuiScript = Join-Path $PSScriptRoot "tui.ts"
    $tuiArgs = @()
    if ($AwacsUrl -ne "http://localhost:7777") { $tuiArgs += "--host", $AwacsUrl }
    if ($Local) { $tuiArgs += "--local" }
    & bun $tuiScript @tuiArgs
}

function Invoke-Kill {
    $target = $CmdArgs[0]
    if (-not $target) { Write-Error "Usage: awacs kill <pid|docker-name>"; exit 1 }

    if ($target -match '^\d+$') {
        $body = @{ services = @(@{ pid = [int]$target; source = "process" }) }
    } else {
        $body = @{ services = @(@{ pid = 0; source = "docker"; dockerName = $target }) }
    }

    $resp = Invoke-Awacs "/api/kill" -Method "POST" -Body $body
    if ($resp.ok) {
        Write-Host "Killed: $target"
        if ($resp.results) { $resp.results | ForEach-Object { Write-Host $_ } }
    } else {
        Write-Error "Failed: $($resp.error)"
        exit 1
    }
}

function Invoke-Restart {
    $target = $CmdArgs[0]
    if (-not $target) { Write-Error "Usage: awacs restart <pid>"; exit 1 }

    $body = @{ services = @(@{ pid = [int]$target; source = "process" }) }
    $resp = Invoke-Awacs "/api/restart" -Method "POST" -Body $body
    if ($resp.ok) {
        Write-Host "Restarted: $target"
        if ($resp.results) { $resp.results | ForEach-Object { Write-Host $_ } }
    } else {
        Write-Error "Failed: $($resp.error)"
        exit 1
    }
}

# --- Dispatch ---
switch ($Cmd) {
    { $_ -in "ls","list" } { Invoke-List }
    "watch"   { Invoke-Watch }
    "kill"    { Invoke-Kill }
    "restart" { Invoke-Restart }
    default   { Write-Error "Unknown command: $Cmd"; Show-Usage }
}
