# Deployment Guide

## Critical: Always Build After Pulling Code

**This project uses TypeScript**, which compiles to JavaScript in the `dist/` folder. When you pull code changes, the `dist/` folder becomes **stale** (outdated) and **MUST be rebuilt**.

### Why This Happens

- Source files: `src/**/*.ts` (TypeScript)
- Compiled files: `dist/**/*.js` (JavaScript from compilation)
- When you modify `.ts` files, `dist/*.js` files **do not auto-update**
- PM2 runs the **stale `dist/` files** unless you rebuild

### Correct Deployment Process

#### For EC2 (Backend):
```bash
./scripts/deploy-ec2.sh
```

Or manually:
```bash
ssh ec2 "cd /var/www/Neon-Goals-Service && git pull && npm run build && pm2 restart neon-goals-service"
```

#### For Gilbert (Worker):
```bash
./scripts/deploy-worker.sh
```

Or manually:
```bash
ssh gilbert "cd /home/alpha/Development/Neon-Goals-Service && git pull && sudo systemctl restart scraper-worker.service"
```

### What Each Step Does

| Step | Purpose |
|------|---------|
| `git pull` | Downloads latest source code (`.ts` files) |
| `npm run build` | Compiles TypeScript → JavaScript (updates `dist/`) |
| `pm2 restart` | Restarts service with fresh `dist/` files |

### Signs of Stale Dist Files

If you see errors like:
- `Error: Cannot find module 'X'` (but the file exists in `src/`)
- Old function behavior after code changes
- Hardcoded paths like `/home/trill/Development/` instead of dynamic paths
- Python script not found errors (wrong path)

**The fix is always: `npm run build`**

### Quick Verification

After deployment, verify the build time:
```bash
ls -la dist/src/modules/scraper/vehicle-filter.service.js
```

The timestamp should match when you last deployed.

---

**Rule of thumb:** After ANY `git pull`, ALWAYS run `npm run build` before restarting the service.
