module.exports = {
  apps: [{
    name: 'neon-goals-service',
    script: './dist/src/src/main.js',
    cwd: '/var/www/Neon-Goals-Service',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
