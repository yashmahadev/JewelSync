import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

let redis;

if (process.env.NODE_ENV === "production") {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
} else {
  if (!global.__redis) {
    global.__redis = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  redis = global.__redis;
}

console.log(`[Redis] Connected/Reused connection for: ${redisUrl}`);

export { redis };
