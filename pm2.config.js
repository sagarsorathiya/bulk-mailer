// pm2.config.js — Production deployment config for Bulk Mailer
'use strict';

module.exports = {
  apps: [
    {
      // ── Web server ──
      name:         'bulk-mailer',
      script:       './server.js',
      instances:    1,           // single instance (session is in-memory)
      exec_mode:    'fork',
      watch:        false,
      autorestart:  true,
      max_restarts: 10,          // stop restart-storm after 10 consecutive failures
      restart_delay: 4000,       // wait 4s between restarts
      kill_timeout:  5000,       // allow 5s for graceful SIGTERM before SIGKILL
      listen_timeout: 8000,      // wait up to 8s for app to bind its port
      merge_logs:    true,       // combine stdout+stderr into a single log stream per app
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      error_file: './logs/server-error.log',
      out_file:   './logs/server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      // ── Bull queue worker ──
      name:         'bulk-mailer-worker',
      script:       './services/jobProcessor.js',
      instances:    1,
      exec_mode:    'fork',
      watch:        false,
      autorestart:  true,
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout:  5000,
      listen_timeout: 8000,
      merge_logs:    true,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/worker-error.log',
      out_file:   './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],

  // ── Deploy config (optional — for pm2 deploy) ──
  // deploy: {
  //   production: {
  //     user:     'deploy',
  //     host:     process.env.DEPLOY_HOST,
  //     ref:      'origin/main',
  //     repo:     process.env.DEPLOY_REPO,
  //     path:     process.env.DEPLOY_PATH,
  //     'post-deploy': 'npm install && npm run migrate && pm2 reload pm2.config.js --env production',
  //   },
  // },
};
