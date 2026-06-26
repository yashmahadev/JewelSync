import prisma from "../db.server";
import { calculatePrice } from "../pricing.server";
import { unauthenticated } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const variantId = url.searchParams.get("variantId");

  if (!shop) {
    return Response.json({ error: "Missing parameter: shop" }, { status: 400 });
  }
  if (!variantId) {
    return Response.json({ error: "Missing parameter: variantId" }, { status: 400 });
  }

  try {
    // 1. Fetch variant config from database
    const dbConfig = await prisma.variantWeightConfig.findUnique({
      where: { variant_id: variantId },
    });

    if (!dbConfig) {
      return Response.json({ error: `Variant configuration not found for variantId: ${variantId}` }, { status: 404 });
    }

    // 2. Fetch product details from Shopify via GraphQL
    const { admin } = await unauthenticated.admin(shop);
    const graphqlClient = admin.graphql;

    const response = await graphqlClient(
      `#graphql
      query getVariantAndProduct($variantId: ID!) {
        productVariant(id: $variantId) {
          selectedOptions {
            name
            value
          }
          product {
            id
            productType
          }
        }
      }`,
      {
        variables: { variantId },
      }
    );

    const resJson = await response.json();
    const productVariant = resJson.data?.productVariant;

    if (!productVariant) {
      return Response.json({ error: `Product variant ${variantId} not found on Shopify.` }, { status: 404 });
    }

    const productInfo = {
      productId: productVariant.product.id,
      productType: productVariant.product.productType,
      selectedOptions: productVariant.selectedOptions,
    };

    // 3. Perform price calculation
    const calcResult = await calculatePrice(shop, dbConfig, productInfo);

    // 4. Return extended fields as requested
    return {
      baseWeight: calcResult.baseWeight,
      selectedSize: calcResult.selectedSize,
      adjustedWeight: calcResult.adjustedWeight,
      weightAdded: calcResult.weightAdded,
      goldPrice: calcResult.goldPrice,
    };
  } catch (err) {
    console.error("API pricing calculation error:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
};
