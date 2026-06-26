import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Searching variantWeightConfig for SKU or variant ID...");
  const configs = await prisma.variantWeightConfig.findMany({
    include: { diamonds: true },
  });
  console.log(`Found ${configs.length} configs in database.`);
  for (const c of configs) {
    if (c.sku.toLowerCase().includes("emerald") || c.sku.toLowerCase().includes("stud") || c.sku.toLowerCase().includes("earring")) {
      console.log(`Match: ID: ${c.id} | VariantId: ${c.variant_id} | SKU: ${c.sku} | Metal: ${c.metal_type} | Purity: ${c.purity} | Weight: ${c.metal_weight}`);
    }
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
