import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

/**
 * Calculates the final price of a jewelry item variant.
 * Formula:
 *   Gold Cost = Weight * GoldRateForPurity
 *   Silver Cost = Weight * SilverRate
 *   Making Charge = Weight * MakingChargeRate
 *   Diamond Cost = DiamondCarats * PricePerCarat
 *   Subtotal = Metal Cost + Making Charge + Diamond Cost
 *   GST = Subtotal * GST_Percentage / 100
 *   Final Price = Subtotal + GST
 */
export async function calculatePrice(shop, variant) {
  // 1. Fetch store configurations
  const config = await prisma.storeConfig.findUnique({
    where: { shop },
  });

  if (!config) {
    throw new Error(`Store configuration not found for shop: ${shop}`);
  }

  // 2. Calculate Metal Cost
  let metalCost = 0;
  const weight = Number(variant.metal_weight);

  if (variant.metal_type === "gold") {
    let rate = 0;
    const purity = variant.purity.toLowerCase();
    
    if (purity.includes("9k") || purity.includes("9kt")) {
      rate = Number(config.gold_rate_9k);
    } else if (purity.includes("14k") || purity.includes("14kt")) {
      rate = Number(config.gold_rate_14k);
    } else if (purity.includes("18k") || purity.includes("18kt")) {
      rate = Number(config.gold_rate_18k);
    } else if (purity.includes("22k") || purity.includes("22kt")) {
      rate = Number(config.gold_rate_22k);
    } else {
      // Fallback if purity isn't explicitly matched
      rate = Number(config.gold_rate_18k);
    }
    metalCost = weight * rate;
  } else if (variant.metal_type === "silver") {
    metalCost = weight * Number(config.silver_rate);
  }

  // 3. Calculate Making Charges
  let makingCharge = 0;
  if (variant.metal_type === "gold") {
    makingCharge = weight * Number(config.making_charge_gold);
  } else if (variant.metal_type === "silver") {
    makingCharge = weight * Number(config.making_charge_silver);
  }

  // 4. Calculate Diamond Cost
  let diamondCost = 0;
  const carat = Number(variant.diamond_carat);

  if (carat > 0 && variant.diamond_color && variant.diamond_clarity) {
    // Look up the diamond rate based on Color, Clarity, and Carat Size
    const match = await prisma.diamondRate.findFirst({
      where: {
        shop,
        color: variant.diamond_color,
        clarity: variant.diamond_clarity,
        size_min: { lte: carat },
        size_max: { gte: carat },
      },
    });

    if (match) {
      const pricePerCarat = Number(match.price_per_carat);
      diamondCost = carat * pricePerCarat;
    } else {
      console.warn(
        `No diamond price match found for: ${variant.diamond_color} / ${variant.diamond_clarity} / ${carat}ct`
      );
    }
  }

  // 5. Total calculations
  const subtotal = metalCost + makingCharge + diamondCost;
  const gst = subtotal * (Number(config.gst_percentage) / 100);
  const finalPrice = Math.round(subtotal + gst); // Rounding off to nearest integer

  return {
    metalCost,
    makingCharge,
    diamondCost,
    gst,
    finalPrice,
  };
}

/**
 * Programmatically ensures that custom metafield definitions exist for variants in Shopify.
 */
export async function ensureMetafieldDefinitions(graphqlClient) {
  const definitions = [
    {
      name: "Metal Type",
      namespace: "custom",
      key: "metal_type",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Purity",
      namespace: "custom",
      key: "purity",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Metal Weight (g)",
      namespace: "custom",
      key: "metal_weight",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Carat (ct)",
      namespace: "custom",
      key: "diamond_carat",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Color",
      namespace: "custom",
      key: "diamond_color",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Clarity",
      namespace: "custom",
      key: "diamond_clarity",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
  ];

  for (const def of definitions) {
    try {
      const response = await graphqlClient(
        `#graphql
        mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition {
              id
            }
            userErrors {
              field
              message
              code
            }
          }
        }`,
        {
          variables: { definition: def },
        }
      );
      const res = await response.json();
      const errors = res.data?.metafieldDefinitionCreate?.userErrors || [];
      if (errors.length > 0) {
        // Ignore if already exists (TAKEN)
        const isAlreadyExists = errors.some(
          (e) => e.code === "TAKEN" || e.message.includes("taken") || e.message.includes("already exists")
        );
        if (!isAlreadyExists) {
          console.warn(`Could not create metafield definition for ${def.key}:`, errors);
        }
      } else {
        console.log(`✅ Created metafield definition for ${def.key}`);
      }
    } catch (err) {
      console.error(`Error ensuring metafield definition for ${def.key}:`, err);
    }
  }
}

/**
 * Recalculates and syncs prices for all variants of a shop to Shopify.
 */
export async function syncAllVariantPrices(shop, graphqlClient) {
  // Ensure metafield definitions exist on variant owner
  await ensureMetafieldDefinitions(graphqlClient);

  // Fetch all configured variants for this store
  const variants = await prisma.variantWeightConfig.findMany({
    where: { shop },
  });

  console.log(`Recalculating prices for ${variants.length} variants on shop ${shop}`);

  // 1. Fetch all products and their variants to build a variantId -> productId mapping
  const productMapping = {};
  try {
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const queryResponse = await graphqlClient(
        `#graphql
        query getProductsWithVariants($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                variants(first: 100) {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          }
        }`,
        {
          variables: { cursor },
        }
      );

      const queryData = await queryResponse.json();
      const productsEdges = queryData.data?.products?.edges || [];
      for (const productEdge of productsEdges) {
        const productId = productEdge.node.id;
        const variantEdges = productEdge.node.variants.edges || [];
        for (const variantEdge of variantEdges) {
          const variantId = variantEdge.node.id;
          productMapping[variantId] = productId;
        }
      }

      hasNextPage = queryData.data?.products?.pageInfo?.hasNextPage || false;
      cursor = queryData.data?.products?.pageInfo?.endCursor || null;
    }
  } catch (err) {
    console.error("Failed to build product variant mapping:", err);
    throw new Error(`Failed to fetch shop product mapping: ${err.message}`);
  }

  // 2. Group updates by Product ID
  const updatesByProduct = {}; // productId -> array of { id: variantId, price: finalPrice.toString(), metafields: [...] }
  const skuMap = {}; // variantId -> sku
  const results = [];

  for (const variant of variants) {
    const variantId = variant.variant_id;
    const productId = productMapping[variantId];
    if (!productId) {
      console.warn(`Variant ${variantId} (SKU: ${variant.sku}) not found on Shopify, skipping sync.`);
      results.push({ sku: variant.sku, success: false, error: "Variant not found on Shopify" });
      continue;
    }

    try {
      const { finalPrice } = await calculatePrice(shop, variant);
      
      // Build metafields array for the variant
      const metafields = [
        {
          namespace: "custom",
          key: "metal_type",
          value: variant.metal_type || "gold",
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: "purity",
          value: variant.purity || "18K",
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: "metal_weight",
          value: Number(variant.metal_weight || 0).toFixed(3),
          type: "number_decimal",
        },
      ];

      metafields.push({
        namespace: "custom",
        key: "diamond_carat",
        value: Number(variant.diamond_carat || 0).toFixed(3),
        type: "number_decimal",
      });
      if (variant.diamond_color) {
        metafields.push({
          namespace: "custom",
          key: "diamond_color",
          value: variant.diamond_color,
          type: "single_line_text_field",
        });
      }
      if (variant.diamond_clarity) {
        metafields.push({
          namespace: "custom",
          key: "diamond_clarity",
          value: variant.diamond_clarity,
          type: "single_line_text_field",
        });
      }

      if (!updatesByProduct[productId]) {
        updatesByProduct[productId] = [];
      }
      updatesByProduct[productId].push({
        id: variantId,
        price: finalPrice.toString(),
        metafields: metafields,
      });
      skuMap[variantId] = variant.sku;
    } catch (err) {
      console.error(`Error calculating price for SKU ${variant.sku}:`, err);
      results.push({ sku: variant.sku, success: false, error: err.message });
    }
  }

  // 3. Execute bulk update per product
  for (const [productId, variantUpdates] of Object.entries(updatesByProduct)) {
    try {
      const response = await graphqlClient(
        `#graphql
        mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              price
            }
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

      const resData = await response.json();
      const errors = resData.data?.productVariantsBulkUpdate?.userErrors || [];

      if (errors.length > 0) {
        console.error(`Shopify bulk update error for product ${productId}:`, errors);
        for (const update of variantUpdates) {
          const sku = skuMap[update.id] || update.id;
          results.push({ sku, success: false, error: errors[0].message });
        }
      } else {
        const updatedVariants = resData.data?.productVariantsBulkUpdate?.productVariants || [];
        const updatedIds = new Set(updatedVariants.map((v) => v.id));
        for (const update of variantUpdates) {
          const sku = skuMap[update.id] || update.id;
          if (updatedIds.has(update.id)) {
            results.push({ sku, success: true, price: Number(update.price) });
          } else {
            results.push({ sku, success: false, error: "Variant update failed or not returned by Shopify" });
          }
        }
      }
    } catch (err) {
      console.error(`Failed to bulk sync variants for product ${productId}:`, err);
      for (const update of variantUpdates) {
        const sku = skuMap[update.id] || update.id;
        results.push({ sku, success: false, error: err.message });
      }
    }
  }

  return results;
}

/**
 * Executes a full store variant price and specifications sync in the background.
 * Processes chunk-by-chunk (product-by-product) updating SyncJob status.
 */
export async function runBackgroundSync(shop, jobId) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) {
    console.error(`[BackgroundSync] Job ${jobId} not found in database.`);
    return;
  }

  try {
    const { admin } = await unauthenticated.admin(shop);
    const graphqlClient = admin.graphql;

    // 1. Update job to running
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: "running",
        errors: "Initialising sync... Ensuring metafield definitions exist on Shopify.",
      },
    });

    // 2. Ensure metafield definitions exist
    await ensureMetafieldDefinitions(graphqlClient);

    // Fetch existing variant configurations in DB to prevent overwrites with stale values
    const existingDbConfigs = await prisma.variantWeightConfig.findMany({
      where: { shop },
      select: { variant_id: true },
    });
    const existingDbVariantIds = new Set(existingDbConfigs.map((c) => c.variant_id));

    // 3. Fetch Shopify variant-to-product mappings & metafields first
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        errors: "Fetching product variants and specifications from Shopify...",
      },
    });

    const productMapping = {};
    let hasNextPage = true;
    let cursor = null;
    let fetchedPages = 0;

    while (hasNextPage) {
      const queryResponse = await graphqlClient(
        `#graphql
        query getProductsWithVariants($cursor: String) {
          products(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                variants(first: 100) {
                  edges {
                    node {
                      id
                      sku
                      title
                      selectedOptions {
                        name
                        value
                      }
                      metafields(first: 10) {
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
            }
          }
        }`,
        {
          variables: { cursor },
        }
      );

      const queryData = await queryResponse.json();
      const productsEdges = queryData.data?.products?.edges || [];
      for (const productEdge of productsEdges) {
        const productId = productEdge.node.id;
        const variantEdges = productEdge.node.variants.edges || [];
        for (const variantEdge of variantEdges) {
          const v = variantEdge.node;
          productMapping[v.id] = productId;

          // Check if variant has custom metafields configured on Shopify
          const mEdges = v.metafields?.edges || [];
          const mFields = {};
          mEdges.forEach((mEdge) => {
            if (mEdge.node.namespace === "custom") {
              mFields[mEdge.node.key] = mEdge.node.value;
            }
          });

          // Rebuild DB specification if missing on Shopify AND not present in our database
          if (!existingDbVariantIds.has(v.id) && (mFields.metal_weight !== undefined || mFields.metal_type !== undefined || mFields.purity !== undefined)) {
            const weight = Number(mFields.metal_weight || 0);
            const dCarat = Number(mFields.diamond_carat || 0);
            const metalType = mFields.metal_type || "gold";
            const purity = mFields.purity || "18K";
            const dColor = mFields.diamond_color || "";
            const dClarity = mFields.diamond_clarity || "";

            await prisma.variantWeightConfig.create({
              data: {
                shop,
                variant_id: v.id,
                sku: v.sku || "",
                metal_type: metalType,
                purity: purity,
                metal_weight: weight,
                diamond_color: dColor || null,
                diamond_clarity: dClarity || null,
                diamond_carat: dCarat,
              },
            });
            existingDbVariantIds.add(v.id);
          }
        }
      }

      hasNextPage = queryData.data?.products?.pageInfo?.hasNextPage || false;
      cursor = queryData.data?.products?.pageInfo?.endCursor || null;
      
      fetchedPages++;
      if (fetchedPages % 5 === 0) {
        await sleep(100);
      }
    }

    // 4. Now load all variant configurations from database
    const variants = await prisma.variantWeightConfig.findMany({
      where: { shop },
    });

    if (variants.length === 0) {
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          total: 0,
          processed: 0,
          errors: "No variant specifications found in the database or Shopify variant metafields. Sync completed with 0 variants.",
        },
      });
      return;
    }

    // 5. Filter variants that exist in Shopify mapping and group by Product ID
    const updatesByProduct = {};
    const skuMap = {};
    let skippedCount = 0;
    let skippedLog = "";

    for (const variant of variants) {
      const variantId = variant.variant_id;
      const productId = productMapping[variantId];
      if (!productId) {
        skippedCount++;
        if (skippedCount <= 5) {
          skippedLog += `SKU ${variant.sku} not found on Shopify. `;
        }
        continue;
      }

      try {
        const { finalPrice } = await calculatePrice(shop, variant);
        
        const metafields = [
          {
            namespace: "custom",
            key: "metal_type",
            value: variant.metal_type || "gold",
            type: "single_line_text_field",
          },
          {
            namespace: "custom",
            key: "purity",
            value: variant.purity || "18K",
            type: "single_line_text_field",
          },
          {
            namespace: "custom",
            key: "metal_weight",
            value: Number(variant.metal_weight || 0).toFixed(3),
            type: "number_decimal",
          },
        ];

        metafields.push({
          namespace: "custom",
          key: "diamond_carat",
          value: Number(variant.diamond_carat || 0).toFixed(3),
          type: "number_decimal",
        });
        if (variant.diamond_color) {
          metafields.push({
            namespace: "custom",
            key: "diamond_color",
            value: variant.diamond_color,
            type: "single_line_text_field",
          });
        }
        if (variant.diamond_clarity) {
          metafields.push({
            namespace: "custom",
            key: "diamond_clarity",
            value: variant.diamond_clarity,
            type: "single_line_text_field",
          });
        }

        if (!updatesByProduct[productId]) {
          updatesByProduct[productId] = [];
        }
        updatesByProduct[productId].push({
          id: variantId,
          price: finalPrice.toString(),
          metafields: metafields,
        });
        skuMap[variantId] = variant.sku;
      } catch (err) {
        console.error(`Error calculating price for SKU ${variant.sku}:`, err);
      }
    }

    const totalVariantsToProcess = Object.values(updatesByProduct).reduce((sum, list) => sum + list.length, 0);

    // Update job metadata
    let initialErrorMsg = skippedCount > 0 ? `Skipped ${skippedCount} variants not matching Shopify products. ` : "";
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        total: totalVariantsToProcess,
        errors: initialErrorMsg || null,
      },
    });

    let currentErrors = initialErrorMsg;

    // 6. Execute bulk updates chunk by chunk
    const productEntries = Object.entries(updatesByProduct);
    
    for (let i = 0; i < productEntries.length; i++) {
      const [productId, variantUpdates] = productEntries[i];
      let successCount = 0;
      let failCount = 0;

      try {
        const response = await graphqlClient(
          `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
                price
              }
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

        const resData = await response.json();
        const errors = resData.data?.productVariantsBulkUpdate?.userErrors || [];

        if (errors.length > 0) {
          console.error(`[BackgroundSync] Shopify error for product ${productId}:`, errors);
          failCount = variantUpdates.length;
          const errSnippet = `Product ${productId} failed: ${errors[0].message}. `;
          if (currentErrors.length < 3000) {
            currentErrors += errSnippet;
          }
        } else {
          const updatedVariants = resData.data?.productVariantsBulkUpdate?.productVariants || [];
          const updatedIds = new Set(updatedVariants.map((v) => v.id));
          
          for (const update of variantUpdates) {
            if (updatedIds.has(update.id)) {
              successCount++;
            } else {
              failCount++;
            }
          }
          if (failCount > 0) {
            const errSnippet = `Product ${productId}: Some variants failed to update. `;
            if (currentErrors.length < 3000) {
              currentErrors += errSnippet;
            }
          }
        }
      } catch (err) {
        console.error(`[BackgroundSync] Exception for product ${productId}:`, err);
        failCount = variantUpdates.length;
        const errSnippet = `Product ${productId} error: ${err.message}. `;
        if (currentErrors.length < 3000) {
          currentErrors += errSnippet;
        }
      }

      // Update incremental progress
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          processed: { increment: variantUpdates.length },
          successful: { increment: successCount },
          failed: { increment: failCount },
          errors: currentErrors || null,
        },
      });

      // Throttle calls to respect Shopify GraphQL limits
      await sleep(150);
    }

    // 7. Complete job successfully
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: "completed",
      },
    });

    console.log(`[BackgroundSync] Job ${jobId} completed successfully.`);

  } catch (err) {
    console.error(`[BackgroundSync] Fatal error in job ${jobId}:`, err);
    try {
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          errors: `Fatal Sync Exception: ${err.message}. ${job.errors || ""}`,
        },
      });
    } catch (dbErr) {
      console.error("[BackgroundSync] Failed to mark job as failed in DB:", dbErr);
    }
  }
}

/**
 * Recalculates and syncs prices/metafields for a single product's variants to Shopify.
 */
export async function syncProductVariantPrices(shop, productId, graphqlClient) {
  // Ensure metafield definitions exist
  await ensureMetafieldDefinitions(graphqlClient);

  // Fetch all variants of this product from Shopify
  const response = await graphqlClient(
    `#graphql
    query getProductVariants($id: ID!) {
      product(id: $id) {
        variants(first: 100) {
          edges {
            node {
              id
              sku
            }
          }
        }
      }
    }`,
    {
      variables: { id: productId },
    }
  );

  const resJson = await response.json();
  const product = resJson.data?.product;
  if (!product) {
    throw new Error(`Product ${productId} not found on Shopify.`);
  }

  const variantEdges = product.variants.edges || [];
  const variantIds = variantEdges.map((edge) => edge.node.id);

  // Fetch configs from database for these variants
  const dbConfigs = await prisma.variantWeightConfig.findMany({
    where: {
      variant_id: { in: variantIds },
    },
  });

  const dbConfigsMap = {};
  dbConfigs.forEach((c) => {
    dbConfigsMap[c.variant_id] = c;
  });

  const variantUpdates = [];

  for (const edge of variantEdges) {
    const v = edge.node;
    const dbConfig = dbConfigsMap[v.id];
    if (!dbConfig) continue;

    const { finalPrice } = await calculatePrice(shop, dbConfig);

    const metafields = [
      {
        namespace: "custom",
        key: "metal_type",
        value: dbConfig.metal_type || "gold",
        type: "single_line_text_field",
      },
      {
        namespace: "custom",
        key: "purity",
        value: dbConfig.purity || "18K",
        type: "single_line_text_field",
      },
      {
        namespace: "custom",
        key: "metal_weight",
        value: Number(dbConfig.metal_weight || 0).toFixed(3),
        type: "number_decimal",
      },
    ];

    metafields.push({
      namespace: "custom",
      key: "diamond_carat",
      value: Number(dbConfig.diamond_carat || 0).toFixed(3),
      type: "number_decimal",
    });
    if (dbConfig.diamond_color) {
      metafields.push({
        namespace: "custom",
        key: "diamond_color",
        value: dbConfig.diamond_color,
        type: "single_line_text_field",
      });
    }
    if (dbConfig.diamond_clarity) {
      metafields.push({
        namespace: "custom",
        key: "diamond_clarity",
        value: dbConfig.diamond_clarity,
        type: "single_line_text_field",
      });
    }

    variantUpdates.push({
      id: v.id,
      price: finalPrice.toString(),
      metafields: metafields,
    });
  }

  if (variantUpdates.length > 0) {
    const updateResponse = await graphqlClient(
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
    const updateJson = await updateResponse.json();
    const errors = updateJson.data?.productVariantsBulkUpdate?.userErrors || [];
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }
  }
}


