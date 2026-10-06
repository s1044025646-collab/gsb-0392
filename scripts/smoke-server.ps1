$env:PORT = "8123"
$p = Start-Process node -ArgumentList "dist/src/server.js" -PassThru -WindowStyle Hidden
Start-Sleep 2
try {
  $c = Invoke-RestMethod -Uri http://127.0.0.1:8123/api/carriers/1/capacity
  $c | ConvertTo-Json -Compress
  $e = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8123/api/carriers/1/embed -ContentType "application/json" -Body '{"text":"接口测试"}'
  $e | ConvertTo-Json -Compress
  $x = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8123/api/outputs/$($e.outputId)/extract"
  $x | ConvertTo-Json -Compress
} finally {
  Stop-Process -Id $p.Id -Force
}
