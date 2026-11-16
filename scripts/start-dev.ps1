# 启动开发环境（前端 + 后端）
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 中执行 .\scripts\start-dev.ps1
#
# 说明：WorkBuddy 宿主会注入 NODE_OPTIONS 指向旧版 shim 脚本路径，
# 该路径在新版本中已不存在，会导致 node 启动报 EPERM / ENOENT。
# 这里在启动前清空该变量，避免子进程继承。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:NODE_OPTIONS = ""

Write-Host "项目根目录: $root" -ForegroundColor Cyan

# 检查依赖
if (-not (Test-Path "$root\node_modules")) {
    Write-Host "未安装依赖，正在安装..." -ForegroundColor Yellow
    Push-Location $root
    npm install
    Pop-Location
}

# 启动后端
Write-Host "启动后端 (http://localhost:4000)..." -ForegroundColor Green
$server = Start-Process -FilePath "node" -ArgumentList "src/index.js" `
    -WorkingDirectory "$root\server" -PassThru -NoNewWindow

# 启动前端
Write-Host "启动前端 (http://localhost:5173)..." -ForegroundColor Green
$client = Start-Process -FilePath "node" -ArgumentList "..\node_modules\vite\bin\vite.js","--host" `
    -WorkingDirectory "$root\client" -PassThru -NoNewWindow

Write-Host ""
Write-Host "服务已启动：" -ForegroundColor Cyan
Write-Host "  前端  http://localhost:5173/" -ForegroundColor White
Write-Host "  后端  http://localhost:4000/api/health" -ForegroundColor White
Write-Host ""
Write-Host "按 Ctrl+C 或关闭此窗口停止服务（PID: $($server.Id) / $($client.Id)）" -ForegroundColor DarkGray

# 等待任一进程退出
Wait-Process -Id $server.Id, $client.Id -ErrorAction SilentlyContinue
