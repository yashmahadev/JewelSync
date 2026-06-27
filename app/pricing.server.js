import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";
import { createAuditLog, updateAuditLog } from "./audit.server";

/**
 * Helper to call Shopify GraphQL with exponential backoff retry for throttling.
 */
async function callGraphQLWithRetry(graphqlClient, query, variables, retries = 5, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await graphqlClient(query, variables);

      // Clone response to check status and check for GraphQL throttled error safely
      let clonedResponse = response;
      if (typeof response.clone === "function") {
        clonedResponse = response.clone();
      }

      if (clonedResponse.status === 429 || clonedResponse.status === 430) {
        console.warn(`[Shopify API] Throttled (HTTP ${clonedResponse.status}). Retrying attempt ${attempt}/${retries} after ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2.5; // exponential backoff with factor of 2.5
        continue;
      }

      const resJson = await clonedResponse.json();
      if (resJson.errors && resJson.errors.length > 0) {
        const isThrottled = resJson.errors.some(e => 
          e.message?.toLowerCase().includes("throttled") || 
          e.message?.toLowerCase().includes("throttle") ||
          e.message?.toLowerCase().includes("cost limit") ||
          e.message?.toLowerCase().includes("rate limit")
        );
        if (isThrottled) {
          console.warn(`[Shopify API] Throttled (GraphQL Error). Retrying attempt ${attempt}/${retries} after ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2.5;
          continue;
        }
      }

      return response;
    } catch (err) {
      const errMsg = err.message || "";
      const isThrottled = errMsg.toLowerCase().includes("throttled") || 
                          errMsg.toLowerCase().includes("throttle") || 
                          errMsg.toLowerCase().includes("429") ||
                          errMsg.toLowerCase().includes("rate limit");
      
      if (isThrottled && attempt < retries) {
        console.warn(`[Shopify API] Caught Throttled error: "${errMsg}". Retrying attempt ${attempt}/${retries} after ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2.5;
        continue;
      }
      
      throw err;
    }
  }
  throw new Error("Shopify GraphQL request failed after maximum retries due to throttling.");
}

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
export async function calculatePrice(shop, variant, productInfo = {}) {
  // 1. Fetch store configurations
  const config = await prisma.storeConfig.findUnique({
    where: { shop },
  });

  if (!config) {
    throw new Error(`Store configuration not found for shop: ${shop}`);
  }

  // 2. Fetch size weight rule if enabled and applicable
  let baseWeight = Number(variant.metal_weight);
  let adjustedWeight = baseWeight;
  let weightAdded = 0;
  let selectedSize = null;

  const productTypeLower = (productInfo.productType || "").toLowerCase();
  const isExcludedType =
    productTypeLower.includes("chain") ||
    productTypeLower.includes("bracelet") ||
    productTypeLower.includes("earring") ||
    productTypeLower.includes("pendant");

  const sizeOption = (productInfo.selectedOptions || []).find((opt) => {
    const name = opt.name.toLowerCase();
    return name === "size" || name === "ring size" || name.includes("size");
  });

  let sizeWeightRule = null;
  if (productInfo.productId) {
    sizeWeightRule = await prisma.productSizeWeightRule.findUnique({
      where: { product_id: productInfo.productId },
    });
  }

  if (
    variant.metal_type === "gold" &&
    !isExcludedType &&
    sizeOption &&
    sizeWeightRule &&
    sizeWeightRule.enabled
  ) {
    // Extract size
    const match = sizeOption.value.match(/(\d+(\.\d+)?)/);
    if (match) {
      selectedSize = parseFloat(match[1]);
    }

    if (selectedSize !== null) {
      const baseSizeEnd = Number(sizeWeightRule.base_size_end);
      let baseGoldWeight = Number(sizeWeightRule.base_gold_weight);
      const purityLower = (variant.purity || "").toLowerCase();
      if ((purityLower.includes("9k") || purityLower.includes("9kt")) && sizeWeightRule.base_gold_weight_9k !== null && Number(sizeWeightRule.base_gold_weight_9k) > 0) {
        baseGoldWeight = Number(sizeWeightRule.base_gold_weight_9k);
      } else if ((purityLower.includes("14k") || purityLower.includes("14kt")) && sizeWeightRule.base_gold_weight_14k !== null && Number(sizeWeightRule.base_gold_weight_14k) > 0) {
        baseGoldWeight = Number(sizeWeightRule.base_gold_weight_14k);
      } else if ((purityLower.includes("18k") || purityLower.includes("18kt")) && sizeWeightRule.base_gold_weight_18k !== null && Number(sizeWeightRule.base_gold_weight_18k) > 0) {
        baseGoldWeight = Number(sizeWeightRule.base_gold_weight_18k);
      } else if ((purityLower.includes("22k") || purityLower.includes("22kt")) && sizeWeightRule.base_gold_weight_22k !== null && Number(sizeWeightRule.base_gold_weight_22k) > 0) {
        baseGoldWeight = Number(sizeWeightRule.base_gold_weight_22k);
      } else if ((purityLower.includes("24k") || purityLower.includes("24kt")) && sizeWeightRule.base_gold_weight_24k !== null && Number(sizeWeightRule.base_gold_weight_24k) > 0) {
        baseGoldWeight = Number(sizeWeightRule.base_gold_weight_24k);
      }
      
      const incrementWeightPerSize = Number(sizeWeightRule.increment_weight_per_size);

      baseWeight = baseGoldWeight;

      if (selectedSize <= baseSizeEnd) {
        adjustedWeight = baseGoldWeight;
      } else {
        adjustedWeight = baseGoldWeight + ((selectedSize - baseSizeEnd) * incrementWeightPerSize);
      }
      weightAdded = Number((adjustedWeight - baseGoldWeight).toFixed(3));
    }
  } else if (sizeOption) {
    // If not gold or rule not enabled, still extract size for API response metadata
    const match = sizeOption.value.match(/(\d+(\.\d+)?)/);
    if (match) {
      selectedSize = parseFloat(match[1]);
    }
  }

  // 3. Calculate Metal Cost using adjustedWeight
  let metalCost = 0;

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
    } else if (purity.includes("24k") || purity.includes("24kt")) {
      rate = Number(config.gold_rate_24k);
    } else {
      rate = Number(config.gold_rate_18k);
    }
    metalCost = adjustedWeight * rate;
  } else if (variant.metal_type === "silver") {
    metalCost = adjustedWeight * Number(config.silver_rate);
  }

  // 4. Calculate Making Charges using adjustedWeight
  let makingCharge = 0;
  if (variant.metal_type === "gold") {
    makingCharge = adjustedWeight * Number(config.making_charge_gold);
  } else if (variant.metal_type === "silver") {
    makingCharge = adjustedWeight * Number(config.making_charge_silver);
  }

  // Apply making charge discount
  const makingChargeDiscount = Number(config.making_charge_discount_percentage || 0);
  if (makingChargeDiscount > 0) {
    makingCharge = makingCharge * (1 - makingChargeDiscount / 100);
  }

  // 5. Fetch associated diamonds (dynamic diamond rows)
  let diamonds = variant.diamonds;
  if (!diamonds) {
    diamonds = await prisma.variantDiamondConfig.findMany({
      where: { variant_config_id: variant.id },
    });
  }

  // Fallback for backward compatibility
  if (
    (!diamonds || diamonds.length === 0) &&
    Number(variant.diamond_carat) > 0 &&
    variant.diamond_color &&
    variant.diamond_clarity
  ) {
    diamonds = [
      {
        diamond_type: "Diamonds",
        shape: "Round",
        color: variant.diamond_color,
        clarity: variant.diamond_clarity,
        count: 1,
        total_weight: variant.diamond_carat,
      },
    ];
  }

  // Calculate Diamond Cost
  let diamondCost = 0;
  let totalDiamondCarats = 0;
  const diamondDetails = [];

  if (diamonds && diamonds.length > 0) {
    for (const d of diamonds) {
      const count = Number(d.count || 1);
      const totalWeight = Number(d.total_weight || 0);
      totalDiamondCarats += totalWeight;

      let rowCost = 0;
      let pricePerCarat = 0;

      if (totalWeight > 0 && d.color && d.clarity) {
        const individualCarat = totalWeight / count;

        const colorVal = d.color ? d.color.toUpperCase() : "*";
        const clarityVal = d.clarity ? d.clarity.toUpperCase() : "*";

        let match = await prisma.diamondRate.findFirst({
          where: {
            shop,
            color: colorVal,
            clarity: clarityVal,
            size_min: { lte: individualCarat },
            size_max: { gte: individualCarat },
          },
        });

        if (!match) {
          match = await prisma.diamondRate.findFirst({
            where: {
              shop,
              color: "*",
              clarity: "*",
              size_min: { lte: individualCarat },
              size_max: { gte: individualCarat },
            },
          });
        }

        if (!match) {
          match = await prisma.diamondRate.findFirst({
            where: {
              shop,
              color: colorVal,
              clarity: clarityVal,
            },
          });
        }

        if (match) {
          pricePerCarat = Number(match.price_per_carat);
          const rawRowCost = totalWeight * pricePerCarat;
          if (makingChargeDiscount > 0) {
            rowCost = rawRowCost * (1 - makingChargeDiscount / 100);
          } else {
            rowCost = rawRowCost;
          }
          diamondCost += rowCost;
        } else {
          console.warn(
            `No diamond price match found for color ${d.color}, clarity ${d.clarity}, size ${individualCarat.toFixed(4)}`
          );
        }
      }

      diamondDetails.push({
        type: d.diamond_type || "Diamonds",
        shape: d.shape || "Round",
        color: d.color || "",
        clarity: d.clarity || "",
        count,
        total_weight: totalWeight,
        price_per_carat: pricePerCarat,
        price: Math.round(rowCost),
      });
    }
  }

  // 6. Total calculations
  const subtotal = metalCost + makingCharge + diamondCost;
  const gst = subtotal * (Number(config.gst_percentage) / 100);
  const finalPrice = Math.round(subtotal + gst);

  // 7. Construct dynamic title and description labels
  let metalColor = "Yellow Gold";
  const options = productInfo.selectedOptions || [];
  for (const opt of options) {
    const val = opt.value.toLowerCase();
    if (val.includes("white")) metalColor = "White Gold";
    else if (val.includes("rose")) metalColor = "Rose Gold";
    else if (val.includes("yellow")) metalColor = "Yellow Gold";
    else if (val.includes("platinum")) metalColor = "Platinum";
    else if (val.includes("silver")) metalColor = "Silver";
  }

  const purityStr = variant.purity ? variant.purity.toUpperCase().replace("K", "KT") : "18KT";
  const goldTitle = variant.metal_type === "silver" ? "Sterling Silver" : `${purityStr} ${metalColor}`;
  
  const titleLower = (productInfo.title || "").toLowerCase();
  const diamondTitle = titleLower.includes("natural") 
    ? "Natural Brilliance Diamonds" 
    : "Lab Grown CVD Type IIA Diamonds";

  const variantInfo = variant.metal_type === "silver"
    ? `This piece features sterling silver with elegant everyday shine.`
    : `This piece features ${purityStr} gold with elegant everyday shine.`;

  // 8. Build variant metafield array
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
    {
      namespace: "custom",
      key: "total_price",
      value: finalPrice.toString(),
      type: "number_integer",
    },
    {
      namespace: "custom",
      key: "gst",
      value: gst.toFixed(2),
      type: "number_decimal",
    },
    {
      namespace: "custom",
      key: "making_charges",
      value: makingCharge.toFixed(2),
      type: "number_decimal",
    },
    {
      namespace: "custom",
      key: "diamond_price",
      value: diamondCost.toFixed(2),
      type: "number_decimal",
    },
    {
      namespace: "custom",
      key: "gold_price",
      value: (variant.metal_type === "gold" ? metalCost : 0).toFixed(2),
      type: "number_decimal",
    },
    {
      namespace: "custom",
      key: "diamond_weight",
      value: `${totalDiamondCarats.toFixed(2)} Ct.`,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "gold_weight",
      value: `${baseWeight.toFixed(2)} Grams`,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "total_weight",
      value: `${(adjustedWeight + totalDiamondCarats * 0.2).toFixed(3)} Grams`,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "gold_title",
      value: goldTitle,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "diamond_title",
      value: diamondTitle,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "variant_info",
      value: variantInfo,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "gold_label",
      value: goldTitle,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "diamond_label",
      value: `Diamonds (${totalDiamondCarats.toFixed(2)} Ct)`,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "making_label",
      value: "Making Charges",
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "gst_label",
      value: `GST (${Number(config.gst_percentage)}%)`,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "diamond_details",
      value: JSON.stringify(diamondDetails),
      type: "json",
    },
  ];

  // Old flat metafield values for compatibility
  metafields.push({
    namespace: "custom",
    key: "diamond_carat",
    value: totalDiamondCarats.toFixed(3),
    type: "number_decimal",
  });
  if (diamonds[0]?.color) {
    metafields.push({
      namespace: "custom",
      key: "diamond_color",
      value: diamonds[0].color,
      type: "single_line_text_field",
    });
  }
  if (diamonds[0]?.clarity) {
    metafields.push({
      namespace: "custom",
      key: "diamond_clarity",
      value: diamonds[0].clarity,
      type: "single_line_text_field",
    });
  }

  // Add row-specific metafields for the first 3 rows
  for (let i = 0; i < 3; i++) {
    const rowNum = i + 1;
    if (i < diamondDetails.length) {
      const d = diamondDetails[i];
      const shapeDisplay = `${d.shape} ${d.color} - ${d.clarity}`;
      metafields.push(
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_type`,
          value: d.type || "Diamonds",
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_shape`,
          value: shapeDisplay,
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_count`,
          value: Number(d.count || 1).toString(),
          type: "number_integer",
        },
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_total_wt`,
          value: Number(d.total_weight || 0).toFixed(2),
          type: "number_decimal",
        },
      );
    } else {
      metafields.push(
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_type`,
          value: "",
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_shape`,
          value: "",
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_count`,
          value: "0",
          type: "number_integer",
        },
        {
          namespace: "custom",
          key: `diamond_row_${rowNum}_total_wt`,
          value: "0.00",
          type: "number_decimal",
        },
      );
    }
  }

  return {
    metalCost,
    makingCharge,
    diamondCost,
    gst,
    finalPrice,
    baseWeight,
    selectedSize,
    adjustedWeight,
    weightAdded,
    goldPrice: variant.metal_type === "gold" ? metalCost : 0,
    metafields,
    diamondDetails,
    totalDiamondCarats,
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
      name: "Total Price",
      namespace: "custom",
      key: "total_price",
      type: "number_integer",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "GST Amount",
      namespace: "custom",
      key: "gst",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Making Charges",
      namespace: "custom",
      key: "making_charges",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Price",
      namespace: "custom",
      key: "diamond_price",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Gold Price",
      namespace: "custom",
      key: "gold_price",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Total Weight",
      namespace: "custom",
      key: "total_weight",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Gold Weight Text",
      namespace: "custom",
      key: "gold_weight",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Weight Text",
      namespace: "custom",
      key: "diamond_weight",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Gold Title",
      namespace: "custom",
      key: "gold_title",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Title",
      namespace: "custom",
      key: "diamond_title",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Variant Info",
      namespace: "custom",
      key: "variant_info",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Gold Label",
      namespace: "custom",
      key: "gold_label",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Label",
      namespace: "custom",
      key: "diamond_label",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Making Label",
      namespace: "custom",
      key: "making_label",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "GST Label",
      namespace: "custom",
      key: "gst_label",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Details JSON",
      namespace: "custom",
      key: "diamond_details",
      type: "json",
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
    {
      name: "Diamond Row 1 Type",
      namespace: "custom",
      key: "diamond_row_1_type",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 1 Shape",
      namespace: "custom",
      key: "diamond_row_1_shape",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 1 Count",
      namespace: "custom",
      key: "diamond_row_1_count",
      type: "number_integer",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 1 Total Wt",
      namespace: "custom",
      key: "diamond_row_1_total_wt",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 2 Type",
      namespace: "custom",
      key: "diamond_row_2_type",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 2 Shape",
      namespace: "custom",
      key: "diamond_row_2_shape",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 2 Count",
      namespace: "custom",
      key: "diamond_row_2_count",
      type: "number_integer",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 2 Total Wt",
      namespace: "custom",
      key: "diamond_row_2_total_wt",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 3 Type",
      namespace: "custom",
      key: "diamond_row_3_type",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 3 Shape",
      namespace: "custom",
      key: "diamond_row_3_shape",
      type: "single_line_text_field",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 3 Count",
      namespace: "custom",
      key: "diamond_row_3_count",
      type: "number_integer",
      ownerType: "PRODUCTVARIANT",
    },
    {
      name: "Diamond Row 3 Total Wt",
      namespace: "custom",
      key: "diamond_row_3_total_wt",
      type: "number_decimal",
      ownerType: "PRODUCTVARIANT",
    },
  ];

  for (const def of definitions) {
    try {
      const response = await callGraphQLWithRetry(
        graphqlClient,
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

export async function syncAllVariantPrices(shop, graphqlClient) {
  const logId = await createAuditLog(shop, "foreground_job", "syncAllVariantPrices", {});
  try {
  // Ensure metafield definitions exist on variant owner
  await ensureMetafieldDefinitions(graphqlClient);

  // Fetch all configured variants for this store, including diamonds
  const variants = await prisma.variantWeightConfig.findMany({
    where: { shop },
    include: { diamonds: true },
  });

  console.log(`Recalculating prices for ${variants.length} variants on shop ${shop}`);

  // 1. Fetch all products and their variants to build a variantId -> productInfo mapping
  const productMapping = {};
  try {
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const queryResponse = await callGraphQLWithRetry(
        graphqlClient,
        `#graphql
        query getProductsWithVariants($cursor: String, $query: String) {
          products(first: 50, after: $cursor, query: $query) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                productType
                variants(first: 250) {
                  edges {
                    node {
                      id
                      selectedOptions {
                        name
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
          variables: { cursor, query: "status:active" },
        }
      );

      const queryData = await queryResponse.json();
      const productsEdges = queryData.data?.products?.edges || [];
      for (const productEdge of productsEdges) {
        const productId = productEdge.node.id;
        const productTitle = productEdge.node.title;
        const productType = productEdge.node.productType;
        const variantEdges = productEdge.node.variants.edges || [];
        for (const variantEdge of variantEdges) {
          const variantId = variantEdge.node.id;
          productMapping[variantId] = {
            productId,
            productType,
            title: productTitle,
            selectedOptions: variantEdge.node.selectedOptions,
          };
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
    const mappedInfo = productMapping[variantId];
    if (!mappedInfo) {
      console.warn(`Variant ${variantId} (SKU: ${variant.sku}) not found on Shopify, skipping sync.`);
      results.push({ sku: variant.sku, success: false, error: "Variant not found on Shopify" });
      continue;
    }

    const productId = mappedInfo.productId;

    try {
      await correctVariantPurityAndMetalType(prisma, variant, mappedInfo.selectedOptions);
      const { finalPrice, metafields } = await calculatePrice(shop, variant, mappedInfo);
      
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
      const CHUNK_SIZE = 2;
      let allUpdatedVariants = [];
      let hasError = false;
      let errorMessage = "";

      for (let i = 0; i < variantUpdates.length; i += CHUNK_SIZE) {
        const chunk = variantUpdates.slice(i, i + CHUNK_SIZE);
        const response = await callGraphQLWithRetry(
          graphqlClient,
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
              variants: chunk,
            },
          }
        );

        const resData = await response.json();
        const errors = resData.data?.productVariantsBulkUpdate?.userErrors || [];

        if (errors.length > 0) {
          console.error(`Shopify bulk update error for product ${productId}:`, errors);
          hasError = true;
          errorMessage = errors[0].message;
          break;
        } else {
          const updated = resData.data?.productVariantsBulkUpdate?.productVariants || [];
          allUpdatedVariants = allUpdatedVariants.concat(updated);
        }

        // Delay to avoid Shopify database locks on sequential updates
        if (i + CHUNK_SIZE < variantUpdates.length) {
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }

      if (hasError) {
        for (const update of variantUpdates) {
          const sku = skuMap[update.id] || update.id;
          results.push({ sku, success: false, error: errorMessage });
        }
      } else {
        const updatedIds = new Set(allUpdatedVariants.map((v) => v.id));
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

  await updateAuditLog(logId, "success", { message: "Successfully synced all variant prices", resultsCount: results.length });
  return results;
  } catch (err) {
    await updateAuditLog(logId, "failed", { error: err.message });
    throw err;
  }
}

/**
 * Executes a full store variant price and specifications sync in the background.
 * Processes chunk-by-chunk (product-by-product) updating SyncJob status.
 */
export async function runBackgroundSync(shop, jobId) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const logId = await createAuditLog(shop, "background_job", "runBackgroundSync", { jobId });

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
      const queryResponse = await callGraphQLWithRetry(
        graphqlClient,
        `#graphql
        query getProductsWithVariants($cursor: String, $query: String) {
          products(first: 50, after: $cursor, query: $query) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                title
                productType
                variants(first: 250) {
                  edges {
                    node {
                      id
                      sku
                      title
                      selectedOptions {
                        name
                        value
                      }
                      metafields(first: 50) {
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
          variables: { cursor, query: "status:active" },
        }
      );

      const queryData = await queryResponse.json();
      const productsEdges = queryData.data?.products?.edges || [];
      for (const productEdge of productsEdges) {
        const productId = productEdge.node.id;
        const productTitle = productEdge.node.title;
        const productType = productEdge.node.productType;
        const variantEdges = productEdge.node.variants.edges || [];
        for (const variantEdge of variantEdges) {
          const v = variantEdge.node;
          productMapping[v.id] = {
            productId,
            productType,
            title: productTitle,
            selectedOptions: v.selectedOptions,
          };

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
            const metalType = mFields.metal_type || getSmartMetalTypeFallback(v.selectedOptions);
            const purity = mFields.purity || getSmartPurityFallback(v.selectedOptions);
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

    // 4. Now load all variant configurations from database including diamonds
    const variants = await prisma.variantWeightConfig.findMany({
      where: { shop },
      include: { diamonds: true },
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
      const mappedInfo = productMapping[variantId];
      if (!mappedInfo) {
        skippedCount++;
        if (skippedCount <= 5) {
          skippedLog += `SKU ${variant.sku} not found on Shopify. `;
        }
        continue;
      }

      const productId = mappedInfo.productId;

      try {
        await correctVariantPurityAndMetalType(prisma, variant, mappedInfo.selectedOptions);
        const { finalPrice, metafields } = await calculatePrice(shop, variant, mappedInfo);
        
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
    let initialErrorMsg = skippedCount > 0 ? `Skipped ${skippedCount} variants not matching Shopify products. Details: ${skippedLog}` : "";
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
        const CHUNK_SIZE = 2;
        let allUpdatedVariants = [];
        let hasError = false;
        let errorMessage = "";

        for (let j = 0; j < variantUpdates.length; j += CHUNK_SIZE) {
          const chunk = variantUpdates.slice(j, j + CHUNK_SIZE);
          const response = await callGraphQLWithRetry(
            graphqlClient,
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
                variants: chunk,
              },
            }
          );

          const resData = await response.json();
          const errors = resData.data?.productVariantsBulkUpdate?.userErrors || [];

          if (errors.length > 0) {
            console.error(`[BackgroundSync] Shopify error for product ${productId}:`, errors);
            hasError = true;
            errorMessage = errors[0].message;
            break;
          } else {
            const updated = resData.data?.productVariantsBulkUpdate?.productVariants || [];
            allUpdatedVariants = allUpdatedVariants.concat(updated);
          }

          // Delay to avoid Shopify database locks on sequential updates
          if (j + CHUNK_SIZE < variantUpdates.length) {
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }

        if (hasError) {
          failCount = variantUpdates.length;
          const errSnippet = `Product ${productId} failed: ${errorMessage}. `;
          if (currentErrors.length < 3000) {
            currentErrors += errSnippet;
          }
        } else {
          const updatedIds = new Set(allUpdatedVariants.map((v) => v.id));
          
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
    await updateAuditLog(logId, "success", { message: "Background sync completed successfully", total: totalVariantsToProcess });

  } catch (err) {
    console.error(`[BackgroundSync] Fatal error in job ${jobId}:`, err);
    await updateAuditLog(logId, "failed", { error: err.message });
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

export async function syncProductVariantPrices(shop, productId, graphqlClient) {
  const logId = await createAuditLog(shop, "foreground_job", "syncProductVariantPrices", { productId });
  try {
  // Ensure metafield definitions exist
  await ensureMetafieldDefinitions(graphqlClient);

  // Fetch all variants of this product from Shopify
  const response = await callGraphQLWithRetry(
    graphqlClient,
    `#graphql
    query getProductVariants($id: ID!) {
      product(id: $id) {
        id
        title
        status
        productType
        variants(first: 250) {
          edges {
            node {
              id
              sku
              selectedOptions {
                name
                value
              }
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

  if (product.status !== "ACTIVE") {
    console.warn(`[syncProductVariantPrices] Product ${product.title} (ID: ${productId}) status is ${product.status}, skipping price sync.`);
    await updateAuditLog(logId, "success", { message: "Skipped price sync because product is not ACTIVE", status: product.status });
    return;
  }

  const variantEdges = product.variants.edges || [];
  const variantIds = variantEdges.map((edge) => edge.node.id);

  // Fetch configs from database for these variants including diamonds
  const dbConfigs = await prisma.variantWeightConfig.findMany({
    where: {
      variant_id: { in: variantIds },
    },
    include: { diamonds: true },
  });

  const dbConfigsMap = {};
  dbConfigs.forEach((c) => {
    dbConfigsMap[c.variant_id] = c;
  });

  const productInfo = {
    productId: product.id,
    productType: product.productType,
    title: product.title,
  };

  const variantUpdates = [];

  for (const edge of variantEdges) {
    const v = edge.node;
    const dbConfig = dbConfigsMap[v.id];
    if (!dbConfig) continue;

    const mappedInfo = {
      ...productInfo,
      selectedOptions: v.selectedOptions,
    };

    await correctVariantPurityAndMetalType(prisma, dbConfig, v.selectedOptions);
    const { finalPrice, metafields } = await calculatePrice(shop, dbConfig, mappedInfo);

    variantUpdates.push({
      id: v.id,
      price: finalPrice.toString(),
      metafields: metafields,
    });
  }

  if (variantUpdates.length > 0) {
    const CHUNK_SIZE = 2;
    for (let i = 0; i < variantUpdates.length; i += CHUNK_SIZE) {
      const chunk = variantUpdates.slice(i, i + CHUNK_SIZE);
      const updateResponse = await callGraphQLWithRetry(
        graphqlClient,
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
            variants: chunk,
          },
        }
      );
      const updateJson = await updateResponse.json();
      const errors = updateJson.data?.productVariantsBulkUpdate?.userErrors || [];
      if (errors.length > 0) {
        throw new Error(errors[0].message);
      }
      
      // Delay to avoid Shopify database locks on sequential updates
      if (i + CHUNK_SIZE < variantUpdates.length) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }
  await updateAuditLog(logId, "success", { message: "Single product sync completed successfully", updatedVariantsCount: variantUpdates.length });
  } catch (err) {
    await updateAuditLog(logId, "failed", { error: err.message });
    throw err;
  }
}

// Standalone Helper Functions for Smart Fallbacks & Purity/Metal Type Validation
export function getSmartMetalTypeFallback(selectedOptions) {
  const options = selectedOptions || [];
  for (const opt of options) {
    const val = opt.value.toLowerCase();
    if (val.includes("silver")) return "silver";
  }
  return "gold";
}

export function getSmartPurityFallback(selectedOptions) {
  const options = selectedOptions || [];
  for (const opt of options) {
    const val = opt.value.toLowerCase();
    if (val.includes("9k") || val.includes("9kt")) return "9K";
    if (val.includes("14k") || val.includes("14kt")) return "14K";
    if (val.includes("18k") || val.includes("18kt")) return "18K";
    if (val.includes("22k") || val.includes("22kt")) return "22K";
    if (val.includes("24k") || val.includes("24kt")) return "24K";
    if (val.includes("silver")) return "Silver";
  }
  return "18K";
}

export function hasOptionPurity(selectedOptions) {
  const options = selectedOptions || [];
  for (const opt of options) {
    const val = opt.value.toLowerCase();
    if (
      val.includes("9k") || val.includes("9kt") ||
      val.includes("14k") || val.includes("14kt") ||
      val.includes("18k") || val.includes("18kt") ||
      val.includes("22k") || val.includes("22kt") ||
      val.includes("24k") || val.includes("24kt") ||
      val.includes("silver")
    ) {
      return true;
    }
  }
  return false;
}

export function hasOptionMetalType(selectedOptions) {
  const options = selectedOptions || [];
  for (const opt of options) {
    const val = opt.value.toLowerCase();
    if (val.includes("silver")) return true;
  }
  return false;
}

export async function correctVariantPurityAndMetalType(prisma, dbConfig, selectedOptions) {
  if (!dbConfig || !selectedOptions) return false;

  let needsUpdate = false;
  const updateData = {};

  if (hasOptionPurity(selectedOptions)) {
    const smartPurity = getSmartPurityFallback(selectedOptions);
    if (dbConfig.purity !== smartPurity) {
      dbConfig.purity = smartPurity;
      updateData.purity = smartPurity;
      needsUpdate = true;
    }
  }

  if (hasOptionMetalType(selectedOptions)) {
    const smartMetalType = getSmartMetalTypeFallback(selectedOptions);
    if (dbConfig.metal_type !== smartMetalType) {
      dbConfig.metal_type = smartMetalType;
      updateData.metal_type = smartMetalType;
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    try {
      await prisma.variantWeightConfig.update({
        where: { id: dbConfig.id },
        data: updateData,
      });
      return true;
    } catch (err) {
      console.error(`[correctVariantPurityAndMetalType] Failed to update config ID ${dbConfig.id}:`, err);
    }
  }
  return false;
}


