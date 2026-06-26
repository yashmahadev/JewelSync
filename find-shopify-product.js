import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const session = await prisma.session.findFirst();
  if (!session) {
    console.error("No Shopify session found in database.");
    return;
  }

  const { shop, accessToken } = session;
  console.log(`Using shop: ${shop}`);

  const graphqlUrl = `https://${shop}/admin/api/2026-07/graphql.json`;
  const query = {
    query: `#graphql
    query getProducts($query: String!) {
      products(first: 5, query: $query) {
        edges {
          node {
            id
            title
            productType
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                  title
                  price
                }
              }
            }
          }
        }
      }
    }`,
    variables: {
      query: "title:*Emerald-Cut*",
    }
  };

  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify(query),
  });

  const resJson = await response.json();
  const products = resJson.data?.products?.edges?.map((edge) => edge.node) || [];
  
  console.log(`Found ${products.length} products on Shopify:`);
  for (const p of products) {
    console.log(`\nProduct: ${p.title} (${p.id})`);
    console.log(`Type: ${p.productType}`);
    const variantEdges = p.variants?.edges || [];
    console.log(`Variants count: ${variantEdges.length}`);
    for (const vEdge of variantEdges) {
      const v = vEdge.node;
      const dbConfig = await prisma.variantWeightConfig.findUnique({
        where: { variant_id: v.id },
        include: { diamonds: true },
      });
      console.log(`  - Variant: ${v.title} | ID: ${v.id} | SKU: ${v.sku} | Price: ${v.price}`);
      if (dbConfig) {
        console.log(`    DB Config: Metal: ${dbConfig.metal_type} | Purity: ${dbConfig.purity} | Weight: ${dbConfig.metal_weight} | Diamonds Carats: ${dbConfig.diamond_carat}`);
      } else {
        console.log(`    DB Config: NOT FOUND in database!`);
      }
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
