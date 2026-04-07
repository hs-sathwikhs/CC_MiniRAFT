#!/bin/bash
# =============================================================================
# MiniRAFT Project - Quick Start Script (Bash)
# =============================================================================
# Starts all components: 3 replicas + gateway + frontend
# Use: ./start.sh
# Stop: Press Ctrl+C
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  MiniRAFT Collaborative Drawing Board - Quick Start${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Check if Node.js is installed
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓ Node.js detected: $NODE_VERSION${NC}"
else
    echo -e "${RED}✗ Node.js is not installed!${NC}"
    echo -e "${YELLOW}  Please install Node.js 18+ from https://nodejs.org${NC}"
    exit 1
fi

# Check if npm is installed
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}✓ npm detected: $NPM_VERSION${NC}"
else
    echo -e "${RED}✗ npm is not installed!${NC}"
    exit 1
fi

echo ""

# Function to check and install dependencies
install_deps_if_needed() {
    local path=$1
    local name=$2
    
    if [ -d "$path/node_modules" ]; then
        echo -e "${GREEN}✓ $name dependencies already installed${NC}"
    else
        echo -e "${YELLOW}⚙ Installing $name dependencies...${NC}"
        cd "$path"
        npm install --silent
        cd - > /dev/null
        echo -e "${GREEN}✓ $name dependencies installed${NC}"
    fi
}

# Install dependencies for all components
echo -e "${CYAN}Checking dependencies...${NC}"
install_deps_if_needed "replica1" "Replica 1"
install_deps_if_needed "replica2" "Replica 2"
install_deps_if_needed "replica3" "Replica 3"
install_deps_if_needed "gateway" "Gateway"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Starting All Services...${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Create logs directory
mkdir -p logs

# Store PIDs for cleanup
REPLICA1_PID=""
REPLICA2_PID=""
REPLICA3_PID=""
GATEWAY_PID=""
FRONTEND_PID=""

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}  Stopping All Services...${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    
    if [ ! -z "$REPLICA1_PID" ]; then
        echo -e "${YELLOW}⏹ Stopping Replica 1...${NC}"
        kill $REPLICA1_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$REPLICA2_PID" ]; then
        echo -e "${YELLOW}⏹ Stopping Replica 2...${NC}"
        kill $REPLICA2_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$REPLICA3_PID" ]; then
        echo -e "${YELLOW}⏹ Stopping Replica 3...${NC}"
        kill $REPLICA3_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$GATEWAY_PID" ]; then
        echo -e "${YELLOW}⏹ Stopping Gateway...${NC}"
        kill $GATEWAY_PID 2>/dev/null || true
    fi
    
    if [ ! -z "$FRONTEND_PID" ]; then
        echo -e "${YELLOW}⏹ Stopping Frontend...${NC}"
        kill $FRONTEND_PID 2>/dev/null || true
    fi
    
    echo ""
    echo -e "${GREEN}✓ All services stopped${NC}"
    echo ""
    exit 0
}

# Register cleanup on Ctrl+C
trap cleanup SIGINT SIGTERM

# Start replicas
echo -e "${BLUE}🔷 Starting Replica 1 (port 5001)...${NC}"
cd replica1
npm start > ../logs/replica1.log 2> ../logs/replica1-error.log &
REPLICA1_PID=$!
cd - > /dev/null
sleep 2

echo -e "${BLUE}🔷 Starting Replica 2 (port 5002)...${NC}"
cd replica2
npm start > ../logs/replica2.log 2> ../logs/replica2-error.log &
REPLICA2_PID=$!
cd - > /dev/null
sleep 2

echo -e "${BLUE}🔷 Starting Replica 3 (port 5003)...${NC}"
cd replica3
npm start > ../logs/replica3.log 2> ../logs/replica3-error.log &
REPLICA3_PID=$!
cd - > /dev/null
sleep 3

echo -e "${MAGENTA}🌐 Starting Gateway (port 8080)...${NC}"
cd gateway
npm start > ../logs/gateway.log 2> ../logs/gateway-error.log &
GATEWAY_PID=$!
cd - > /dev/null
sleep 3

# Start frontend with simple HTTP server
echo -e "${YELLOW}🎨 Starting Frontend (port 3000)...${NC}"

# Check if http-server is available
if command -v npx &> /dev/null; then
    npx http-server frontend -p 3000 -c-1 --silent > logs/frontend.log 2> logs/frontend-error.log &
    FRONTEND_PID=$!
else
    echo -e "${YELLOW}  ⚠ npx not available, frontend must be opened directly${NC}"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✓ All Services Started!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Services:${NC}"
echo -e "${WHITE}  Replica 1:  http://localhost:5001/health${NC}"
echo -e "${WHITE}  Replica 2:  http://localhost:5002/health${NC}"
echo -e "${WHITE}  Replica 3:  http://localhost:5003/health${NC}"
echo -e "${WHITE}  Gateway:    http://localhost:8080/health${NC}"
if [ ! -z "$FRONTEND_PID" ]; then
    echo -e "${WHITE}  Frontend:   http://localhost:3000${NC}"
else
    echo -e "${WHITE}  Frontend:   Open frontend/index.html in browser${NC}"
fi
echo ""
echo -e "${CYAN}Stats & Monitoring:${NC}"
echo -e "${WHITE}  Gateway Stats:        http://localhost:8080/stats${NC}"
echo -e "${WHITE}  Leader Discovery:     http://localhost:8080/discover-leader${NC}"
echo ""
echo -e "${CYAN}Logs:${NC}"
echo -e "${WHITE}  All logs are in the ./logs/ directory${NC}"
echo ""
echo -e "${YELLOW}To stop all services: Press Ctrl+C${NC}"
echo ""
echo -e "${GRAY}Monitoring services...${NC}"
echo ""

# Keep script running
wait
