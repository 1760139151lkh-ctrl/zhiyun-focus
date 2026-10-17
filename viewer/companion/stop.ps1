$ErrorActionPreference='Stop'
$headers=@{'Origin'='http://127.0.0.1:8769';'X-ZJF-Protocol'='1'}
try {
  $hello=Invoke-RestMethod -Uri 'http://127.0.0.1:8772/hello' -Headers $headers -TimeoutSec 3
  if ($hello.engine -ne 'zjf-companion') { throw '端口不是沉浸助手。' }
  $headers['X-ZJF-Companion']=$hello.token
  $reply=Invoke-RestMethod -Uri 'http://127.0.0.1:8772/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -Headers $headers -TimeoutSec 20
  if ($reply.ok -ne $true) { throw '助手没有确认完成保存与退出。' }
} catch {
  Write-Error ('助手退出尚未确认；请保留当前实例并核对保存状态。'+$_.Exception.Message)
  exit 1
}
