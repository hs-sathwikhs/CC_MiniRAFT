#!/usr/bin/env pwsh
# =============================================================================
# MiniRAFT Project - Quick Start Script (PowerShell)
# =============================================================================
# Starts all components: 3 replicas + gateway + frontend
# Use: ./start.ps1
# Stop: Press Ctrl+C
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MiniRAFT Collaborative Drawing Board - Quick Start" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Check if Node.js is installed
try {
    $nodeVersion = node --version
    Write-Host "✓ Node.js detected: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Node.js is not installed!" -ForegroundColor Red
    Write-Host "  Please install Node.js 18+ from https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

# Check if npm is installed
try {
    $npmVersion = npm --version
    Write-Host "✓ npm detected: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ npm is not installed!" -ForegroundColor Red
    exit 1
}

Write-Host ""

# Function to check and install dependencies
function Install-DependenciesIfNeeded {
    param($Path, $Name)
    
    if (Test-Path "$Path/node_modules") {
        Write-Host "✓ $Name dependencies already installed" -ForegroundColor Green
    } else {
        Write-Host "⚙ Installing $Name dependencies..." -ForegroundColor Yellow
        Push-Location $Path
        npm install --silent
        Pop-Location
        Write-Host "✓ $Name dependencies installed" -ForegroundColor Green
    }
}

# Install dependencies for all components
Write-Host "Checking dependencies..." -ForegroundColor Cyan
Install-DependenciesIfNeeded -Path "replica1" -Name "Replica 1"
Install-DependenciesIfNeeded -Path "replica2" -Name "Replica 2"
Install-DependenciesIfNeeded -Path "replica3" -Name "Replica 3"
Install-DependenciesIfNeeded -Path "gateway" -Name "Gateway"

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Starting All Services..." -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Create logs directory
if (-not (Test-Path "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
}

# Start replicas
Write-Host "🔷 Starting Replica 1 (port 5001)..." -ForegroundColor Blue
$replica1 = Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory "replica1" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/replica1.log" -RedirectStandardError "logs/replica1-error.log"
Start-Sleep -Seconds 2

Write-Host "🔷 Starting Replica 2 (port 5002)..." -ForegroundColor Blue
$replica2 = Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory "replica2" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/replica2.log" -RedirectStandardError "logs/replica2-error.log"
Start-Sleep -Seconds 2

Write-Host "🔷 Starting Replica 3 (port 5003)..." -ForegroundColor Blue
$replica3 = Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory "replica3" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/replica3.log" -RedirectStandardError "logs/replica3-error.log"
Start-Sleep -Seconds 3

Write-Host "🌐 Starting Gateway (port 8080)..." -ForegroundColor Magenta
$gateway = Start-Process -FilePath "npm" -ArgumentList "start" -WorkingDirectory "gateway" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/gateway.log" -RedirectStandardError "logs/gateway-error.log"
Start-Sleep -Seconds 3

# Start frontend with simple HTTP server
Write-Host "🎨 Starting Frontend (port 3000)..." -ForegroundColor Yellow

# Check if http-server is installed globally
try {
    npx http-server --version | Out-Null
    $frontend = Start-Process -FilePath "npx" -ArgumentList "http-server","frontend","-p","3000","-c-1","--silent" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/frontend.log" -RedirectStandardError "logs/frontend-error.log"
} catch {
    Write-Host "  ⚠ http-server not available, frontend must be opened directly" -ForegroundColor Yellow
    $frontend = $null
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✓ All Services Started!" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "Services:" -ForegroundColor Cyan
Write-Host "  Replica 1:  http://localhost:5001/health" -ForegroundColor White
Write-Host "  Replica 2:  http://localhost:5002/health" -ForegroundColor White
Write-Host "  Replica 3:  http://localhost:5003/health" -ForegroundColor White
Write-Host "  Gateway:    http://localhost:8080/health" -ForegroundColor White
if ($frontend) {
    Write-Host "  Frontend:   http://localhost:3000" -ForegroundColor White
} else {
    Write-Host "  Frontend:   Open frontend/index.html in browser" -ForegroundColor White
}
Write-Host ""
Write-Host "Stats & Monitoring:" -ForegroundColor Cyan
Write-Host "  Gateway Stats:        http://localhost:8080/stats" -ForegroundColor White
Write-Host "  Leader Discovery:     http://localhost:8080/discover-leader" -ForegroundColor White
Write-Host ""
Write-Host "Logs:" -ForegroundColor Cyan
Write-Host "  All logs are in the ./logs/ directory" -ForegroundColor White
Write-Host ""
Write-Host "To stop all services: Press Ctrl+C" -ForegroundColor Yellow
Write-Host ""

# Function to stop all processes
function Stop-AllServices {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "  Stopping All Services..." -ForegroundColor Yellow
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host ""
    
    if ($replica1 -and !$replica1.HasExited) {
        Write-Host "⏹ Stopping Replica 1..." -ForegroundColor Yellow
        Stop-Process -Id $replica1.Id -Force -ErrorAction SilentlyContinue
    }
    
    if ($replica2 -and !$replica2.HasExited) {
        Write-Host "⏹ Stopping Replica 2..." -ForegroundColor Yellow
        Stop-Process -Id $replica2.Id -Force -ErrorAction SilentlyContinue
    }
    
    if ($replica3 -and !$replica3.HasExited) {
        Write-Host "⏹ Stopping Replica 3..." -ForegroundColor Yellow
        Stop-Process -Id $replica3.Id -Force -ErrorAction SilentlyContinue
    }
    
    if ($gateway -and !$gateway.HasExited) {
        Write-Host "⏹ Stopping Gateway..." -ForegroundColor Yellow
        Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue
    }
    
    if ($frontend -and !$frontend.HasExited) {
        Write-Host "⏹ Stopping Frontend..." -ForegroundColor Yellow
        Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
    }
    
    Write-Host ""
    Write-Host "✓ All services stopped" -ForegroundColor Green
    Write-Host ""
}

# Register cleanup on Ctrl+C
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Stop-AllServices
}

# Keep script running and monitor processes
try {
    Write-Host "Monitoring services (Ctrl+C to stop)..." -ForegroundColor Gray
    Write-Host ""
    
    while ($true) {
        # Check if any process has exited
        $anyExited = $false
        
        if ($replica1.HasExited) {
            Write-Host "✗ Replica 1 has stopped unexpectedly!" -ForegroundColor Red
            $anyExited = $true
        }
        if ($replica2.HasExited) {
            Write-Host "✗ Replica 2 has stopped unexpectedly!" -ForegroundColor Red
            $anyExited = $true
        }
        if ($replica3.HasExited) {
            Write-Host "✗ Replica 3 has stopped unexpectedly!" -ForegroundColor Red
            $anyExited = $true
        }
        if ($gateway.HasExited) {
            Write-Host "✗ Gateway has stopped unexpectedly!" -ForegroundColor Red
            $anyExited = $true
        }
        
        if ($anyExited) {
            Write-Host "Check logs in ./logs/ directory for errors" -ForegroundColor Yellow
            break
        }
        
        Start-Sleep -Seconds 5
    }
} finally {
    Stop-AllServices
}
