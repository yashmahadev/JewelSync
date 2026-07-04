import { Worker } from "bullmq";
import { redis } from "./redis.server";
import { runBackgroundSync } from "./pricing.server";

let pricingWorker;

if (process.env.NODE_ENV === "production") {
  pricingWorker = new Worker(
    "pricing-sync",
    async (job) => {
      const { shop, jobId } = job.data;
      console.log(`[Worker] Processing job ${job.id} for shop ${shop}, Job ID: ${jobId}`);
      await runBackgroundSync(shop, jobId);
    },
    {
      connection: redis,
      concurrency: 1, // Run sequentially to avoid database lockups & Shopify limits
    }
  );
} else {
  if (!global.__pricingWorker) {
    global.__pricingWorker = new Worker(
      "pricing-sync",
      async (job) => {
        const { shop, jobId } = job.data;
        console.log(`[Worker] [DEV] Processing job ${job.id} for shop ${shop}, Job ID: ${jobId}`);
        await runBackgroundSync(shop, jobId);
      },
      {
        connection: redis,
        concurrency: 1,
      }
    );
  }
  pricingWorker = global.__pricingWorker;
}

pricingWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully`);
});

pricingWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed with error:`, err);
});

console.log("[Worker] Background sync worker initialized.");

export { pricingWorker };
