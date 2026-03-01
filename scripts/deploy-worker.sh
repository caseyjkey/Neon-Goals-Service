#!/bin/bash
# Deploy worker to gilbert
set -e

echo "Deploying worker to gilbert..."

ssh gilbert << 'ENDSSH'
set -e  # Exit on error inside heredoc
cd /home/alpha/Development/Neon-Goals-Service
echo "Pulling latest code..."
# Stash any local changes before pulling
git stash -q || true
git pull

echo "Restarting worker service..."
sudo systemctl restart scraper-worker.service

echo "Waiting for service to start..."
sleep 2

echo "Worker status:"
sudo systemctl status scraper-worker.service --no-pager | head -15
ENDSSH

echo "Worker deployed successfully!"
