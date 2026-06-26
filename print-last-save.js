import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Fetching latest save_variant_specs logs...");
  const logs = await prisma.auditLog.findMany({
    where: {
      name: { in: ["save_variant_specs", "syncProductVariantPrices"] }
    },
    orderBy: { created_at: "desc" },
    take: 4,
  });

  for (const log of logs) {
    console.log(`\n======================================================`);
    console.log(`[${log.created_at.toISOString()}] ID: ${log.id} | Name: ${log.name} | Status: ${log.status}`);
    console.log("Request:", log.request);
    console.log("Response:", log.response);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
