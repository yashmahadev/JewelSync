import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Searching all audit logs for Emerald-Cut...");
  const logs = await prisma.auditLog.findMany({
    orderBy: { created_at: "desc" },
  });
  console.log(`Checking ${logs.length} logs...`);
  let matches = 0;
  for (const log of logs) {
    if (log.request?.includes("Emerald-Cut") || log.response?.includes("Emerald-Cut") || log.request?.includes("Sustainable") || log.response?.includes("Sustainable")) {
      matches++;
      console.log(`\n[${log.created_at.toISOString()}] ID: ${log.id} | Name: ${log.name} | Status: ${log.status}`);
      console.log("  Request:", log.request ? log.request.substring(0, 1000) : "null");
      console.log("  Response:", log.response ? log.response.substring(0, 1000) : "null");
    }
  }
  console.log(`\nFound ${matches} matching logs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
