'use strict';

/**
 * config/redis.js
 * IORedis client configured from environment variables.
 * Used by Bull job queues.
 */

require('dotenv').config();
const Redis = require('ioredis');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Bull requires maxRetriesPerRequest = null for blocking operations
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
  lazyConnect:          false,
};

let client = null;

/**
 * Get (or create) the shared Redis client.
 * @returns {Redis}
 */
function getRedisClient() {
  if (!client) {
    client = new Redis(redisConfig);

    client.on('connect', () => {
      console.log('[redis] Connected to Redis at', redisConfig.host, ':', redisConfig.port);
    });
    client.on('error', (err) => {
      console.error('[redis] Error:', err.message);
    });
  }
  return client;
}

/**
 * Returns a fresh Redis connection (Bull requires separate connections
 * for subscriber and main client).
 * @returns {Redis}
 */
function createRedisConnection() {
  return new Redis(redisConfig);
}

module.exports = { getRedisClient, createRedisConnection, redisConfig };
