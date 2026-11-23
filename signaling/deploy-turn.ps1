# Deploy the signaling Lambda with Cloudflare TURN credentials taken from
# ../.env.production, without ever printing them. Then checks /ice.
#
#   pwsh signaling/deploy-turn.ps1
#
# Accepted names in .env.production (first one found wins):
#   key id:    CF_TURN_KEY_ID, CLOUDFLARE_TURN_KEY_ID, TURN_KEY_ID, CF_TURN_TOKEN_ID, TURN_TOKEN_ID, CLOUDFLARE_APP_ID
#   api token: CF_TURN_API_TOKEN, CLOUDFLARE_TURN_API_TOKEN, TURN_API_TOKEN, CF_API_TOKEN, TURN_TOKEN, CLOUDFLARE_API_TOKEN
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$envFile = Join-Path $here "..\.env.production"
if (-not (Test-Path $envFile)) { throw ".env.production not found" }

$vars = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $v = $Matches[2]
    if ($v -match '^"(.*)"$' -or $v -match "^'(.*)'$") { $v = $Matches[1] }
    $vars[$Matches[1]] = $v
  }
}

function Pick([string[]]$names) {
  foreach ($base in $names) {
    foreach ($n in @($base, "VITE_$base")) {
      if ($vars.ContainsKey($n) -and $vars[$n]) { return @{ name = $n; value = $vars[$n] } }
    }
  }
  return $null
}
$keyId = Pick @("CF_TURN_KEY_ID", "CLOUDFLARE_TURN_KEY_ID", "TURN_KEY_ID", "CF_TURN_TOKEN_ID", "TURN_TOKEN_ID", "CLOUDFLARE_APP_ID")
$token = Pick @("CF_TURN_API_TOKEN", "CLOUDFLARE_TURN_API_TOKEN", "TURN_API_TOKEN", "CF_API_TOKEN", "TURN_TOKEN", "CLOUDFLARE_API_TOKEN")
if (-not $keyId -or -not $token) {
  Write-Host "Not found in .env.production. Variable names present (values hidden):"
  $vars.Keys | Sort-Object | ForEach-Object { Write-Host "  $_" }
  throw "Add CF_TURN_KEY_ID=... and CF_TURN_API_TOKEN=... to .env.production"
}
Write-Host "Using $($keyId.name) and $($token.name) (values hidden)."
foreach ($p in @($keyId, $token)) {
  if ($p.name -like "VITE_*") {
    Write-Warning "$($p.name) starts with VITE_: Vite bakes such variables into the installer. Rename it without the VITE_ prefix."
  }
}

# Never let a secret reach the console.
$secrets = @($keyId.value, $token.value)
function Mask([string]$s) { foreach ($x in $secrets) { if ($x) { $s = $s.Replace($x, "***") } }; $s }

# Prove the credentials work before touching the Lambda.
try {
  $cf = Invoke-RestMethod -Method Post `
    -Uri "https://rtc.live.cloudflare.com/v1/turn/keys/$($keyId.value)/credentials/generate-ice-servers" `
    -Headers @{ Authorization = "Bearer $($token.value)" } -ContentType "application/json" -Body '{"ttl":300}'
  Write-Host "Cloudflare accepted the TURN key." -ForegroundColor Green
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  throw "Cloudflare rejected the credentials (HTTP $code). They must be a TURN key (Realtime -> TURN Server): its 'Turn Token ID' and 'API Token', not an SFU app id/secret or an account API token. Nothing was deployed."
}

$sam = (Get-Command sam -ErrorAction SilentlyContinue).Source
if (-not $sam) { $sam = "C:\Program Files\Amazon\AWSSAMCLI\bin\sam.cmd" }

Push-Location $here
try {
  & $sam build 2>&1 | ForEach-Object { Mask "$_" }
  if ($LASTEXITCODE) { throw "sam build failed" }
  $overrides = @("RoomTtlSeconds=3600", "CloudflareTurnKeyId=$($keyId.value)", "CloudflareTurnApiToken=$($token.value)")
  & $sam deploy --no-confirm-changeset --no-fail-on-empty-changeset --parameter-overrides @overrides 2>&1 | ForEach-Object { Mask "$_" }
  if ($LASTEXITCODE) { throw "sam deploy failed" }
} finally {
  Pop-Location
}

# Check: ask for ICE servers the way a host does (any 16+ char room key).
$url = aws cloudformation describe-stacks --stack-name live-app --region eu-central-1 `
  --query "Stacks[0].Outputs[?OutputKey=='SignalingUrl'].OutputValue" --output text
$url = $url.Trim().TrimEnd("/")
$room = -join ((1..10) | ForEach-Object { "abcdefghjkmnpqrstuvwxyz23456789"[(Get-Random -Maximum 31)] })
$key = [guid]::NewGuid().ToString("N")
try {
  $r = Invoke-RestMethod -Uri "$url/rooms/$room/ice" -Headers @{ "x-room-key" = $key }
} catch {
  throw "ICE check failed: $(Mask $_.Exception.Message)"
}
$turnUrls = @($r.iceServers | ForEach-Object { $_.urls } | Where-Object { $_ -match '^turns?:' })
$withCreds = @($r.iceServers | Where-Object { $_.username -and $_.credential }).Count
Write-Host ""
Write-Host "ICE servers from $url :"
$r.iceServers | ForEach-Object { Write-Host ("  " + (@($_.urls) -join ", ") + ($(if ($_.username) { "  [credentials: yes]" } else { "" }))) }
if ($turnUrls.Count -and $withCreds) { Write-Host "OK: TURN is on ($($turnUrls.Count) TURN URLs)." -ForegroundColor Green }
else { throw "No TURN servers returned" }
