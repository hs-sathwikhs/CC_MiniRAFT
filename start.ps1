#!/usr/bin/env pwsh
# =============================================================================
# MiniRAFT Project - Quick Start Script (PowerShell)
# Starts: 3 replicas (Docker) + gateway + frontend
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host "`n═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MiniRAFT Collaborative Drawing Board - Quick Start" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════`n" -ForegroundColor Cyan

# 1. Check Dependencies
foreach ($cmd in "node", "npm", "docker", "docker-compose") {
    try { 
        $null = Get-Command $cmd -ErrorAction Stop 
        Write-Host "✓ $cmd detected" -ForegroundColor Green
    } catch { 
        Write-Host "✗ $cmd is not installed or not in PATH!" -ForegroundColor Red; exit 1 
    }
}

# 2. Cleanup old processes
Write-Host "`n Cleaning up old processes..." -ForegroundColor Yellow
taskkill /F /IM node.exe 2>$null | Out-Null
docker-compose down -v --remove-orphans 2>$null | Out-Null

if (Test-Path "logs") { Remove-Item "logs" -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path "logs" -Force | Out-Null

# 3. Install Gateway Dependencies
Write-Host " Installing Gateway dependencies..." -ForegroundColor Yellow
Push-Location "gateway"; npm install --silent; Pop-Location

# 4. Start Services
Write-Host "`n Starting Docker Backend (Replicas + Gateway) - booting silently..." -ForegroundColor Cyan
docker-compose up -d --build *> "logs/docker.log"

Write-Host "`n Starting Frontend Server (port 3000)..." -ForegroundColor Yellow    
$frontendPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "frontend"
$frontend = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-Command", "cd '$frontendPath'; npx http-server -p 3000" -WindowStyle Minimized -PassThru

Write-Host "`n═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✓ Backend & Frontend Booting!" -ForegroundColor Green
Write-Host "  Frontend App:      http://localhost:3000" -ForegroundColor White  
Write-Host "  Gateway/Dashboard: http://localhost:8080/dashboard" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════`n" -ForegroundColor Green

Write-Host "Press Ctrl+C to stop all services." -ForegroundColor Yellow

# 5. Wait for exit
try {
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    Write-Host "`n Stopping All Services..." -ForegroundColor Yellow
    docker-compose down 2>$null | Out-Null
    if ($frontend -and !$frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
}
