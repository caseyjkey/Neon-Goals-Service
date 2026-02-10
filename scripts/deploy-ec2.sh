#!/bin/bash
# Deploy backend to EC2 production
set -e

echo "Deploying to EC2 production..."

SSH_CMD="ssh ec2"

# Pull latest code
echo "Pulling latest code..."
$SSH_CMD "cd /var/www/Neon-Goals-Service && git pull"

# Rebuild TypeScript
echo "Building TypeScript (compiling src/ to dist/)..."
$SSH_CMD "cd /var/www/Neon-Goals-Service && npm run build"

# Restart backend
echo "Restarting backend service..."
$SSH_CMD "pm2 restart neon-goals-service"

# Wait for startup
echo "Waiting for service to start..."
sleep 3

# Check status
echo "Backend status:"
$SSH_CMD "pm2 status neon-goals-service --no-pager | head -10"

echo "✅ Deployment complete!"
