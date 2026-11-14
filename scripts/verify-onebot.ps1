param(
  [string]$ConfigFile = "$env:USERPROFILE\.dsh\qq-plugin\config.json",
  [int]$HttpPort = 3000
)
$ErrorActionPreference = 'Stop'
$token = ''
if (Test-Path -LiteralPath $ConfigFile) {
  $config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
  $token = [string]$config.onebot.accessToken
  Write-Output "config: $ConfigFile"
  Write-Output "account: $($config.account)"
  Write-Output "owner: $($config.owner)"
} else {
  Write-Output "config missing: $ConfigFile"
}
$ports = @(3000, 3001, 5099)
foreach ($port in $ports) {
  $open = $false
  try { $open = (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
  Write-Output "port $port listening: $open"
}
$body = @{ action = 'get_login_info'; params = @{}; echo = 'qq-doctor' } | ConvertTo-Json -Depth 6 -Compress
$headers = @{}
if ($token) { $headers.Authorization = "Bearer $token" }
try {
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$HttpPort/" -ContentType 'application/json' -Headers $headers -Body $body -TimeoutSec 10
  $response | ConvertTo-Json -Depth 8
} catch {
  Write-Output "OneBot HTTP check failed: $($_.Exception.Message)"
  if ($_.ErrorDetails) { Write-Output $_.ErrorDetails.Message }
  exit 1
}
