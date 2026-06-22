import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calculatePrice } from "../pricing.server";

export const action = async ({ request }) => {
  const { shop, admin, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    console.error("No admin client found in webhook context. Skipping webhook processing.");
    return new Response();
  }

  try {
    const productId = payload.admin_graphql_api_id || `gid://shopify/Product/${payload.id}`;

    // 1. Fetch variant options, price, and metafields from Shopify via GraphQL
    const response = await admin.graphql(
      `#graphql
      query getProductVariantsMetafields($productId: ID!) {
        product(id: $productId) {
          id
          variants(first: 100) {
            edges {
              node {
                id
                sku
                price
                title
                selectedOptions {
                  name
                  value
                }
                metafields(first: 20) {
                  edges {
                    node {
                      namespace
                      key
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      {
        variables: { productId },
      }
    );

    const resJson = await response.json();
    const product = resJson.data?.product;

    if (!product) {
      console.warn(`Product ${productId} not found on Shopify.`);
      return new Response();
    }

    const variants = product.variants.edges || [];
    const variantUpdates = [];

    // Helper functions for fallbacks
    const getSmartMetalTypeFallback = (v) => {
      const options = v.selectedOptions || [];
      for (const opt of options) {
        const val = opt.value.toLowerCase();
        if (val.includes("silver")) return "silver";
      }
      return "gold";
    };

    const getSmartPurityFallback = (v) => {
      const options = v.selectedOptions || [];
      for (const opt of options) {
        const val = opt.value.toLowerCase();
        if (val.includes("9k") || val.includes("9kt")) return "9K";
        if (val.includes("14k") || val.includes("14kt")) return "14K";
        if (val.includes("18k") || val.includes("18kt")) return "18K";
        if (val.includes("22k") || val.includes("22kt")) return "22K";
        if (val.includes("silver")) return "Silver";
      }
      return "18K";
    };

    for (const edge of variants) {
      const v = edge.node;
      const variantId = v.id;

      // Extract metafields from custom namespace
      const mEdges = v.metafields?.edges || [];
      const mFields = {};
      mEdges.forEach((mEdge) => {
        const node = mEdge.node;
        if (node.namespace === "custom") {
          mFields[node.key] = node.value;
        }
      });

      console.log(`[Webhook] Variant: ${v.title} (${v.sku || "No SKU"}), ID: ${variantId}`);
      console.log(`[Webhook] Metafields parsed from Shopify:`, JSON.stringify(mFields));

      // Check if we have any custom metafields set
      const hasMetafields = Object.keys(mFields).length > 0;
      
      // Look up existing config in database
      const existing = await prisma.variantWeightConfig.findUnique({
        where: { variant_id: variantId },
      });

      // Skip if none of our custom metafields exist AND there is no existing DB record
      if (!existing && !hasMetafields) {
        console.log(`[Webhook] Skipping variant ${variantId} because no DB config and no Shopify metafields exist.`);
        continue;
      }

      // Determine values to save: prioritizing database configuration as absolute source of truth if exists
      const metalType = existing ? existing.metal_type : (mFields.metal_type || getSmartMetalTypeFallback(v));
      const purity = existing ? existing.purity : (mFields.purity || getSmartPurityFallback(v));
      
      const metalWeight = existing 
        ? Number(existing.metal_weight) 
        : (mFields.metal_weight !== undefined ? Number(mFields.metal_weight) : 0);

      const diamondCarat = existing 
        ? Number(existing.diamond_carat) 
        : (mFields.diamond_carat !== undefined ? Number(mFields.diamond_carat) : 0);

      const diamondColor = existing 
        ? existing.diamond_color 
        : (mFields.diamond_color !== undefined ? mFields.diamond_color : null);

      const diamondClarity = existing 
        ? existing.diamond_clarity 
        : (mFields.diamond_clarity !== undefined ? mFields.diamond_clarity : null);

      console.log(`[Webhook] Determined weights: metalWeight=${metalWeight}, carat=${diamondCarat}, color=${diamondColor}, clarity=${diamondClarity}`);

      // Upsert spec to database
      const dbVariant = await prisma.variantWeightConfig.upsert({
        where: { variant_id: variantId },
        update: {
          sku: v.sku || existing?.sku || "",
          metal_type: metalType,
          purity: purity,
          metal_weight: metalWeight,
          diamond_color: diamondColor,
          diamond_clarity: diamondClarity,
          diamond_carat: diamondCarat,
        },
        create: {
          shop,
          variant_id: variantId,
          sku: v.sku || "",
          metal_type: metalType,
          purity: purity,
          metal_weight: metalWeight,
          diamond_color: diamondColor,
          diamond_clarity: diamondClarity,
          diamond_carat: diamondCarat,
        },
      });

      // Recalculate price
      const { finalPrice } = await calculatePrice(shop, dbVariant);
      console.log(`[Webhook] Calculated finalPrice: ${finalPrice}, Current Shopify Price: ${v.price}`);

      // Only update if current price is different from the calculated one
      if (Math.round(Number(v.price)) !== finalPrice) {
        console.log(`[Webhook] Price mismatch! Queuing Shopify price update to ${finalPrice}`);
        variantUpdates.push({
          id: variantId,
          price: finalPrice.toString(),
        });
      } else {
        console.log(`[Webhook] Prices match. No price update needed.`);
      }
    }

    // Bulk update prices if changes exist
    if (variantUpdates.length > 0) {
      console.log(`Updating prices for ${variantUpdates.length} variants on Shopify for product ${productId} via webhook...`);
      await admin.graphql(
        `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            productId,
            variants: variantUpdates,
          },
        }
      );
    }
  } catch (err) {
    console.error(`Error processing products/update webhook:`, err);
  }

  return new Response();
};
