// PM2 process definition. Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'newsweb-monitor',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // single instance — the poller must not run in parallel
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 3000,
      max_memory_restart: '300M',
      // Timestamped logs; PM2 stores them under ~/.pm2/logs by default.
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1',
        POLL_INTERVAL_MS: 15000,
        NEWSWEB_LIMIT: 50,
        TZ_NAME: 'Europe/Oslo',
        // IMPORTANT: set this to your Vercel dashboard origin(s) before going live.
        ALLOWED_ORIGINS: 'https://YOUR-DASHBOARD.vercel.app',
      },
    },
  ],
};
