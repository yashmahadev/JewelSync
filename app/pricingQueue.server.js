import { Queue } from "bullmq";
import { redis } from "./redis.server";

let pricingQueue;

if (process.env.NODE_ENV === "production") {
  pricingQueue = new Queue("pricing-sync", { connection: redis });
} else {
  if (!global.__pricingQueue) {
    global.__pricingQueue = new Queue("pricing-sync", { connection: redis });
  }
  pricingQueue = global.__pricingQueue;
}

export async function enqueuePricingSync(shop, jobId) {
  console.log(`[Queue] Enqueuing pricing sync for shop: ${shop}, Job ID: ${jobId}`);
  const job = await pricingQueue.add(
    "sync-job",
    { shop, jobId },
    {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
  return job;
}

export { pricingQueue };
