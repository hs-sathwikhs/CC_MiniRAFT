#!/usr/bin/env pwsh
# =============================================================================
# MiniRAFT Project - Quick Start Script (PowerShell)
# =============================================================================
# Starts: 3 replicas (Docker optional) + gateway + frontend
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

# Check if Docker is available
$dockerAvailable = $false
try {
    $dockerVersion = docker --version 2>$null
    if ($dockerVersion) {
        $dockerAvailable = $true
        Write-Host "✓ Docker detected: $dockerVersion" -ForegroundColor Green
    }
} catch {
    $dockerAvailable = $false
}

# Determine execution mode
$useDocker = $false
if ($dockerAvailable) {
    Write-Host ""
    Write-Host "Choose execution mode:" -ForegroundColor Cyan
    Write-Host "  1) Docker (replicas in containers)" -ForegroundColor White
    Write-Host "  2) Local (all services locally)" -ForegroundColor White
    $choice = Read-Host "Enter choice (1 or 2, default: 1)"
    $useDocker = ($choice -eq "1" -or $choice -eq "")
}

Write-Host ""

# Function to install dependencies
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

# Create logs directory
if (-not (Test-Path "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Starting Services (Mode: $(if ($useDocker) { 'DOCKER' } else { 'LOCAL' }))" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Initialize process handles
$replica1 = $null
$replica2 = $null
$replica3 = $null
$gateway = $null
$frontend = $null
$dockerProcess = $null

if ($useDocker) {
    Write-Host "🐳 Starting Docker containers..." -ForegroundColor Cyan
    try {
        # Start docker-compose
        $dockerProcess = Start-Process -FilePath "docker-compose" -ArgumentList "up" -WindowStyle Hidden -RedirectStandardOutput "logs/docker.log" -RedirectStandardError "logs/docker-error.log" -PassThru
        Write-Host "✓ Docker containers started" -ForegroundColor Green
        Start-Sleep -Seconds 3
    } catch {
        Write-Host "✗ Failed to start Docker containers: $_" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "Checking dependencies..." -ForegroundColor Cyan
    Install-DependenciesIfNeeded -Path "replica1" -Name "Replica 1"
    Install-DependenciesIfNeeded -Path "replica2" -Name "Replica 2"
    Install-DependenciesIfNeeded -Path "replica3" -Name "Replica 3"
    Install-DependenciesIfNeeded -Path "gateway" -Name "Gateway"

    Write-Host ""

    # Start replicas locally
    Write-Host "🔷 Starting Replica 1 (port 5001)..." -ForegroundColor Blue
    $replica1 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory "replica1" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/replica1.log" -RedirectStandardError "logs/replica1-error.log"
    Start-Sleep -Seconds 2

    Write-Host "🔷 Starting Replica 2 (port 5002)..." -ForegroundColor Blue
    $replica2 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory "replica2" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/replica2.log" -RedirectStandardError "logs/replica2-error.log"
    Start-Sleep -Seconds 2

    Write-Host "🔷 Starting Replica 3 (port 5003)..." -ForegroundColor Blue
    $replica3 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory "replica3" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/replica3.log" -RedirectStandardError "logs/replica3-error.log"
    Start-Sleep -Seconds 3
}

# Always start gateway locally
Write-Host "🌐 Starting Gateway (port 8080)..." -ForegroundColor Magenta
$gateway = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start" -WorkingDirectory "gateway" -PassThru -WindowStyle Hidden -RedirectStandardOutput "logs/gateway.log" -RedirectStandardError "logs/gateway-error.log"
Start-Sleep -Seconds 3

# Start frontend with simple HTTP server
Write-Host "🎨 Starting Frontend (port 3000)..." -ForegroundColor Yellow
try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $frontendPath = Join-Path $scriptDir "frontend"

    # Use cmd.exe to ensure PATH is properly resolved
    $frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npx http-server '$frontendPath' -p 3000 -c-1" -PassThru -RedirectStandardOutput "logs/frontend.log" -RedirectStandardError "logs/frontend-error.log"
    Write-Host "✓ Frontend started (PID: $($frontend.Id))" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Failed to start frontend: $_" -ForegroundColor Red
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
Write-Host "  Dashboard:  http://localhost:8080/dashboard" -ForegroundColor White
if ($frontend) {
    Write-Host "  Frontend:   http://localhost:3000" -ForegroundColor White
} else {
    Write-Host "  Frontend:   Open frontend/index.html in browser" -ForegroundColor White
}
Write-Host ""
Write-Host "To stop all services: Press Ctrl+C" -ForegroundColor Yellow
Write-Host ""

# Function to stop all services
function Stop-AllServices {
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host "  Stopping All Services..." -ForegroundColor Yellow
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Yellow
    Write-Host ""

    if ($useDocker -and $dockerProcess -and !$dockerProcess.HasExited) {
        Write-Host "⏹ Stopping Docker containers..." -ForegroundColor Yellow
        & docker-compose down 2>$null
    }

    if ($replica1 -and !$replica1.HasExited) {
        Stop-Process -Id $replica1.Id -Force -ErrorAction SilentlyContinue
    }
    if ($replica2 -and !$replica2.HasExited) {
        Stop-Process -Id $replica2.Id -Force -ErrorAction SilentlyContinue
    }
    if ($replica3 -and !$replica3.HasExited) {
        Stop-Process -Id $replica3.Id -Force -ErrorAction SilentlyContinue
    }
    if ($gateway -and !$gateway.HasExited) {
        Stop-Process -Id $gateway.Id -Force -ErrorAction SilentlyContinue
    }
    if ($frontend -and !$frontend.HasExited) {
        Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
    }

    Write-Host "✓ All services stopped" -ForegroundColor Green
    Write-Host ""
}

# Register cleanup on Ctrl+C
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    Stop-AllServices
} | Out-Null

# Monitor services
try {
    Write-Host "Monitoring services (Ctrl+C to stop)..." -ForegroundColor Gray
    Write-Host ""

    while ($true) {
        if (-not $useDocker) {
            $anyExited = $false
            if ($replica1 -and $replica1.HasExited) {
                Write-Host "✗ Replica 1 crashed" -ForegroundColor Red
                $anyExited = $true
            }
            if ($replica2 -and $replica2.HasExited) {
                Write-Host "✗ Replica 2 crashed" -ForegroundColor Red
                $anyExited = $true
            }
            if ($replica3 -and $replica3.HasExited) {
                Write-Host "✗ Replica 3 crashed" -ForegroundColor Red
                $anyExited = $true
            }
            if ($gateway -and $gateway.HasExited) {
                Write-Host "✗ Gateway crashed" -ForegroundColor Red
                $anyExited = $true
            }
            if ($anyExited) {
                break
            }
        }

        Start-Sleep -Seconds 5
    }
} finally {
    Stop-AllServices
}
