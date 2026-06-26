import { useLoaderData, useSubmit, useActionData, Form, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createAuditLog, updateAuditLog } from "../audit.server";
import { runBackgroundSync, syncProductVariantPrices } from "../pricing.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // 1. Load or create store config
  let config = await prisma.storeConfig.findUnique({
    where: { shop },
  });

  if (!config) {
    config = await prisma.storeConfig.create({
      data: {
        shop,
        gold_rate_9k: 4000.00,
        gold_rate_14k: 4800.00,
        gold_rate_18k: 5500.00,
        gold_rate_22k: 6500.00,
        silver_rate: 110.00,
        making_charge_gold: 500.00,
        making_charge_silver: 50.00,
        gst_percentage: 3.00,
      },
    });
  }

  // 2. Fetch search queries
  const url = new URL(request.url);
  const searchQ = url.searchParams.get("q") || "";

  // Build shopify query
  let shopifyQuery = "status:active";
  if (searchQ) {
    shopifyQuery += ` AND title:*${searchQ}*`;
  }

  // 3. Query products from Shopify
  let products = [];
  try {
    const response = await admin.graphql(
      `#graphql
      query getProducts($query: String!) {
        products(first: 25, query: $query) {
          edges {
            node {
              id
              title
              handle
              featuredImage {
                url
              }
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
        variables: {
          query: shopifyQuery,
        },
      }
    );

    const resJson = await response.json();
    products = resJson.data?.products?.edges?.map((edge) => edge.node) || [];
  } catch (err) {
    console.error("Shopify product fetch error:", err);
  }

  const variantIds = [];
  for (const product of products) {
    if (product.variants?.edges) {
      for (const edge of product.variants.edges) {
        if (edge.node?.id) {
          variantIds.push(edge.node.id);
        }
      }
    }
  }

  // 4. Fetch existing database configurations for the returned variants including diamonds
  const savedConfigs = await prisma.variantWeightConfig.findMany({
    where: {
      variant_id: { in: variantIds },
    },
    include: {
      diamonds: true,
    },
  });

  // Count total configs globally
  const variantCount = await prisma.variantWeightConfig.count({
    where: { shop },
  });

  // Convert Decimal objects to numbers for serialization
  const serializedConfig = {
    ...config,
    gold_rate_9k: Number(config.gold_rate_9k),
    gold_rate_14k: Number(config.gold_rate_14k),
    gold_rate_18k: Number(config.gold_rate_18k),
    gold_rate_22k: Number(config.gold_rate_22k),
    gold_rate_24k: Number(config.gold_rate_24k || 0),
    silver_rate: Number(config.silver_rate),
    making_charge_gold: Number(config.making_charge_gold),
    making_charge_silver: Number(config.making_charge_silver),
    gst_percentage: Number(config.gst_percentage),
  };

  const serializedConfigsMap = {};
  savedConfigs.forEach((c) => {
    serializedConfigsMap[c.variant_id] = {
      id: c.id,
      metal_type: c.metal_type,
      purity: c.purity,
      metal_weight: Number(c.metal_weight),
      diamond_color: c.diamond_color || "",
      diamond_clarity: c.diamond_clarity || "",
      diamond_carat: Number(c.diamond_carat),
      diamonds: c.diamonds.map((d) => ({
        id: d.id,
        diamond_type: d.diamond_type,
        shape: d.shape,
        color: d.color,
        clarity: d.clarity,
        count: d.count,
        total_weight: Number(d.total_weight),
      })),
    };
  });

  // Re-populate DB configs from Shopify metafields if missing (e.g. on reinstall)
  for (const product of products) {
    const variants = product.variants.edges || [];
    for (const edge of variants) {
      const v = edge.node;
      if (!serializedConfigsMap[v.id]) {
        const mEdges = v.metafields?.edges || [];
        const mFields = {};
        mEdges.forEach((mEdge) => {
          if (mEdge.node.namespace === "custom") {
            mFields[mEdge.node.key] = mEdge.node.value;
          }
        });

        if (mFields.metal_weight !== undefined || mFields.metal_type !== undefined || mFields.purity !== undefined) {
          const weight = Number(mFields.metal_weight || 0);
          const dCarat = Number(mFields.diamond_carat || 0);
          const metalType = mFields.metal_type || "gold";
          const purity = mFields.purity || "18K";
          const dColor = mFields.diamond_color || "";
          const dClarity = mFields.diamond_clarity || "";

          const createdConfig = await prisma.variantWeightConfig.upsert({
            where: { variant_id: v.id },
            update: {
              sku: v.sku || "",
              metal_type: metalType,
              purity: purity,
              metal_weight: weight,
              diamond_color: dColor || null,
              diamond_clarity: dClarity || null,
              diamond_carat: dCarat,
            },
            create: {
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

          // Check if there are dynamic diamonds in Shopify metafield JSON
          let createdDiamonds = [];
          if (mFields.diamond_details) {
            try {
              const parsed = JSON.parse(mFields.diamond_details);
              if (Array.isArray(parsed)) {
                for (const d of parsed) {
                  const newD = await prisma.variantDiamondConfig.create({
                    data: {
                      variant_config_id: createdConfig.id,
                      diamond_type: d.type || "Diamonds",
                      shape: d.shape || "Round",
                      color: d.color || "",
                      clarity: d.clarity || "",
                      count: Number(d.count || 1),
                      total_weight: Number(d.total_weight || d.carat || 0),
                    },
                  });
                  createdDiamonds.push({
                    id: newD.id,
                    diamond_type: newD.diamond_type,
                    shape: newD.shape,
                    color: newD.color,
                    clarity: newD.clarity,
                    count: newD.count,
                    total_weight: Number(newD.total_weight),
                  });
                }
              }
            } catch (err) {
              console.error("Error parsing diamond_details JSON during reinstall repopulate:", err);
            }
          }

          if (createdDiamonds.length === 0 && dCarat > 0 && dColor && dClarity) {
            const newD = await prisma.variantDiamondConfig.create({
              data: {
                variant_config_id: createdConfig.id,
                diamond_type: "Diamonds",
                shape: "Round",
                color: dColor,
                clarity: dClarity,
                count: 1,
                total_weight: dCarat,
              },
            });
            createdDiamonds.push({
              id: newD.id,
              diamond_type: newD.diamond_type,
              shape: newD.shape,
              color: newD.color,
              clarity: newD.clarity,
              count: newD.count,
              total_weight: Number(newD.total_weight),
            });
          }

          serializedConfigsMap[v.id] = {
            id: createdConfig.id,
            metal_type: metalType,
            purity: purity,
            metal_weight: weight,
            diamond_color: dColor,
            diamond_clarity: dClarity,
            diamond_carat: dCarat,
            diamonds: createdDiamonds,
          };
        }
      }
    }
  }

  const sizeRules = await prisma.productSizeWeightRule.findMany({
    where: { shop_id: shop },
  });

  const serializedRulesMap = {};
  sizeRules.forEach((r) => {
    serializedRulesMap[r.product_id] = {
      enabled: r.enabled,
      base_size_start: Number(r.base_size_start),
      base_size_end: Number(r.base_size_end),
      base_gold_weight: Number(r.base_gold_weight),
      base_gold_weight_9k: r.base_gold_weight_9k !== null ? Number(r.base_gold_weight_9k) : 0,
      base_gold_weight_14k: r.base_gold_weight_14k !== null ? Number(r.base_gold_weight_14k) : 0,
      base_gold_weight_18k: r.base_gold_weight_18k !== null ? Number(r.base_gold_weight_18k) : 0,
      base_gold_weight_22k: r.base_gold_weight_22k !== null ? Number(r.base_gold_weight_22k) : 0,
      base_gold_weight_24k: r.base_gold_weight_24k !== null ? Number(r.base_gold_weight_24k) : 0,
      increment_weight_per_size: Number(r.increment_weight_per_size),
    };
  });

  const diamondRates = await prisma.diamondRate.findMany({
    where: { shop },
    select: { color: true, clarity: true, price_per_carat: true },
  });

  const uniqueColors = [...new Set(diamondRates.map((r) => r.color.toUpperCase()))].sort();
  const uniqueClarities = [...new Set(diamondRates.map((r) => r.clarity.toUpperCase()))].sort();

  // Full diamond rates for client-side price preview
  const allDiamondRates = diamondRates.map((r) => ({
    color: r.color.toUpperCase(),
    clarity: r.clarity.toUpperCase(),
    price_per_carat: Number(r.price_per_carat),
  }));

  const latestJob = await prisma.syncJob.findFirst({
    where: { shop },
    orderBy: { created_at: "desc" },
  });

  return {
    config: serializedConfig,
    variantCount,
    products,
    savedConfigsMap: serializedConfigsMap,
    savedRulesMap: serializedRulesMap,
    searchQ,
    uniqueColors,
    uniqueClarities,
    allDiamondRates,
    latestJob: latestJob ? {
      id: latestJob.id,
      status: latestJob.status,
      total: latestJob.total,
      processed: latestJob.processed,
      successful: latestJob.successful,
      failed: latestJob.failed,
      errors: latestJob.errors || "",
      created_at: latestJob.created_at.toISOString(),
      updated_at: latestJob.updated_at.toISOString(),
    } : null,
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "save_rates") {
    const gold_9k = Number(formData.get("gold_9k"));
    const gold_14k = Number(formData.get("gold_14k"));
    const gold_18k = Number(formData.get("gold_18k"));
    const gold_22k = Number(formData.get("gold_22k"));
    const gold_24k = Number(formData.get("gold_24k"));
    const silver = Number(formData.get("silver"));
    const making_gold = Number(formData.get("making_gold"));
    const making_silver = Number(formData.get("making_silver"));
    const gst = Number(formData.get("gst"));

    const logId = await createAuditLog(shop, "foreground_job", "save_rates", {
      gold_9k, gold_14k, gold_18k, gold_22k, gold_24k, silver, making_gold, making_silver, gst
    });

    try {
      await prisma.storeConfig.update({
        where: { shop },
        data: {
          gold_rate_9k: gold_9k,
          gold_rate_14k: gold_14k,
          gold_rate_18k: gold_18k,
          gold_rate_22k: gold_22k,
          gold_rate_24k: gold_24k,
          silver_rate: silver,
          making_charge_gold: making_gold,
          making_charge_silver: making_silver,
          gst_percentage: gst,
        },
      });

      await updateAuditLog(logId, "success", { message: "Settings saved successfully!" });
      return { success: true, message: "Settings saved successfully!" };
    } catch (err) {
      await updateAuditLog(logId, "failed", { error: err.message });
      return { success: false, error: err.message };
    }
  }

  if (actionType === "save_variant_specs") {
    const specsJson = formData.get("specs");
    const productId = formData.get("productId");
    const logId = await createAuditLog(shop, "foreground_job", "save_variant_specs", { productId, specs: specsJson ? JSON.parse(specsJson) : [] });

    try {
      if (!specsJson) {
        await updateAuditLog(logId, "failed", { error: "Missing specifications payload" });
        return { success: false, error: "Missing specifications payload" };
      }

      const specs = JSON.parse(specsJson);

      // Save size weight rule
      const ruleEnabled = formData.get("ruleEnabled") === "true";
      const baseSizeStartVal = formData.get("baseSizeStart");
      const baseSizeEndVal = formData.get("baseSizeEnd");
      const baseGoldWeightVal = formData.get("baseGoldWeight");
      const baseGoldWeight9kVal = formData.get("baseGoldWeight9k");
      const baseGoldWeight14kVal = formData.get("baseGoldWeight14k");
      const baseGoldWeight18kVal = formData.get("baseGoldWeight18k");
      const baseGoldWeight22kVal = formData.get("baseGoldWeight22k");
      const baseGoldWeight24kVal = formData.get("baseGoldWeight24k");
      const incrementWeightPerSizeVal = formData.get("incrementWeightPerSize");

      if (!productId) {
        return { success: false, error: "Validation failed: Null Product" };
      }

      const baseSizeStart = Number(baseSizeStartVal || 0);
      const baseSizeEnd = Number(baseSizeEndVal || 0);
      const baseGoldWeight = Number(baseGoldWeightVal || 0);
      
      const baseGoldWeight9k = baseGoldWeight9kVal !== null && baseGoldWeight9kVal !== "" ? Number(baseGoldWeight9kVal) : null;
      const baseGoldWeight14k = baseGoldWeight14kVal !== null && baseGoldWeight14kVal !== "" ? Number(baseGoldWeight14kVal) : null;
      const baseGoldWeight18k = baseGoldWeight18kVal !== null && baseGoldWeight18kVal !== "" ? Number(baseGoldWeight18kVal) : null;
      const baseGoldWeight22k = baseGoldWeight22kVal !== null && baseGoldWeight22kVal !== "" ? Number(baseGoldWeight22kVal) : null;
      const baseGoldWeight24k = baseGoldWeight24kVal !== null && baseGoldWeight24kVal !== "" ? Number(baseGoldWeight24kVal) : null;
      
      const incrementWeightPerSize = Number(incrementWeightPerSizeVal || 0);

      // Backend validations
      if (baseSizeEnd < baseSizeStart) {
        return { success: false, error: "Validation failed: Base Size End cannot be less than Base Size Start" };
      }
      if (baseGoldWeight < 0 || (baseGoldWeight9k !== null && baseGoldWeight9k < 0) || (baseGoldWeight14k !== null && baseGoldWeight14k < 0) || (baseGoldWeight18k !== null && baseGoldWeight18k < 0) || (baseGoldWeight22k !== null && baseGoldWeight22k < 0) || (baseGoldWeight24k !== null && baseGoldWeight24k < 0)) {
        return { success: false, error: "Validation failed: Base Gold Weight cannot be negative" };
      }
      if (incrementWeightPerSize < 0) {
        return { success: false, error: "Validation failed: Weight Increment cannot be negative" };
      }

      // Upsert rule
      await prisma.productSizeWeightRule.upsert({
        where: { product_id: productId },
        update: {
          enabled: ruleEnabled,
          base_size_start: baseSizeStart,
          base_size_end: baseSizeEnd,
          base_gold_weight: baseGoldWeight,
          base_gold_weight_9k: baseGoldWeight9k,
          base_gold_weight_14k: baseGoldWeight14k,
          base_gold_weight_18k: baseGoldWeight18k,
          base_gold_weight_22k: baseGoldWeight22k,
          base_gold_weight_24k: baseGoldWeight24k,
          increment_weight_per_size: incrementWeightPerSize,
        },
        create: {
          shop_id: shop,
          product_id: productId,
          enabled: ruleEnabled,
          base_size_start: baseSizeStart,
          base_size_end: baseSizeEnd,
          base_gold_weight: baseGoldWeight,
          base_gold_weight_9k: baseGoldWeight9k,
          base_gold_weight_14k: baseGoldWeight14k,
          base_gold_weight_18k: baseGoldWeight18k,
          base_gold_weight_22k: baseGoldWeight22k,
          base_gold_weight_24k: baseGoldWeight24k,
          increment_weight_per_size: incrementWeightPerSize,
        },
      });

      for (const spec of specs) {
        const totalCarat = spec.diamonds ? spec.diamonds.reduce((sum, d) => sum + Number(d.total_weight || 0), 0) : 0;
        const dColor = (spec.diamonds && spec.diamonds.length > 0) ? spec.diamonds[0].color : null;
        const dClarity = (spec.diamonds && spec.diamonds.length > 0) ? spec.diamonds[0].clarity : null;

        const dbVariant = await prisma.variantWeightConfig.upsert({
          where: { variant_id: spec.variantId },
          update: {
            sku: spec.sku || "",
            metal_type: spec.metalType,
            purity: spec.purity,
            metal_weight: Number(spec.weight || 0),
            diamond_color: dColor || null,
            diamond_clarity: dClarity || null,
            diamond_carat: totalCarat,
          },
          create: {
            shop,
            variant_id: spec.variantId,
            sku: spec.sku || "",
            metal_type: spec.metalType,
            purity: spec.purity,
            metal_weight: Number(spec.weight || 0),
            diamond_color: dColor || null,
            diamond_clarity: dClarity || null,
            diamond_carat: totalCarat,
          },
        });

        // Sync VariantDiamondConfig records
        if (spec.diamonds && Array.isArray(spec.diamonds)) {
          await prisma.variantDiamondConfig.deleteMany({
            where: { variant_config_id: dbVariant.id },
          });

          for (const d of spec.diamonds) {
            await prisma.variantDiamondConfig.create({
              data: {
                variant_config_id: dbVariant.id,
                diamond_type: d.diamond_type || "Diamonds",
                shape: d.shape || "Round",
                color: d.color || "",
                clarity: d.clarity || "",
                count: Number(d.count || 1),
                total_weight: Number(d.total_weight || d.carat || 0),
              },
            });
          }
        }
      }

      if (productId) {
        await syncProductVariantPrices(shop, productId, admin.graphql);
      }

      await updateAuditLog(logId, "success", { message: "Specifications and Size Weight rules saved and synced successfully!", variantsCount: specs.length });
      return { success: true, message: "Specifications and Size Weight rules saved and synced successfully!", actionType: "save_variant_specs" };
    } catch (err) {
      console.error("Save specs error:", err);
      await updateAuditLog(logId, "failed", { error: err.message });
      return { success: false, error: `Failed to save specs: ${err.message}` };
    }
  }

  if (actionType === "sync_prices") {
    const logId = await createAuditLog(shop, "foreground_job", "sync_prices_action", {});
    try {
      const activeJob = await prisma.syncJob.findFirst({
        where: {
          shop,
          status: { in: ["pending", "running"] },
        },
      });

      if (activeJob) {
        await updateAuditLog(logId, "failed", { error: "A synchronization job is already running in the background." });
        return { success: false, error: "A synchronization job is already running in the background." };
      }

      const newJob = await prisma.syncJob.create({
        data: {
          shop,
          status: "pending",
          total: 0,
          processed: 0,
          successful: 0,
          failed: 0,
        },
      });

      // Execute asynchronously in background
      runBackgroundSync(shop, newJob.id).catch((err) => {
        console.error(`[DashboardSync] Async runBackgroundSync error:`, err);
      });

      await updateAuditLog(logId, "success", { message: "Background price recalculation and sync started!", jobId: newJob.id });
      return {
        success: true,
        message: "Background price recalculation and sync started!",
      };
    } catch (err) {
      console.error("Price sync error:", err);
      await updateAuditLog(logId, "failed", { error: err.message });
      return { success: false, error: `Sync failed: ${err.message}` };
    }
  }

  if (actionType === "clear_sync_jobs") {
    try {
      await prisma.syncJob.deleteMany({
        where: { shop },
      });
      return { success: true, message: "Sync job logs cleared!" };
    } catch (err) {
      console.error("Clear sync jobs error:", err);
      return { success: false, error: `Failed to clear logs: ${err.message}` };
    }
  }

  return null;
};

export default function PricingDashboard() {
  const { config, variantCount, products, savedConfigsMap, savedRulesMap, searchQ, uniqueColors, uniqueClarities, allDiamondRates, latestJob } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const navigation = useNavigation();

  // Local state for daily settings
  const [gold9k, setGold9k] = useState(config.gold_rate_9k);
  const [gold14k, setGold14k] = useState(config.gold_rate_14k);
  const [gold18k, setGold18k] = useState(config.gold_rate_18k);
  const [gold22k, setGold22k] = useState(config.gold_rate_22k);
  const [gold24k, setGold24k] = useState(config.gold_rate_24k || 0);
  const [silver, setSilver] = useState(config.silver_rate);
  const [makingGold, setMakingGold] = useState(config.making_charge_gold);
  const [makingSilver, setMakingSilver] = useState(config.making_charge_silver);
  const [gst, setGst] = useState(config.gst_percentage);

  // Search input query state
  const [searchVal, setSearchVal] = useState(searchQ);

  // Expands/collapses products
  const [expandedProduct, setExpandedProduct] = useState(null);

  // Tracks local unsaved changes for variant specs per product
  const [localSpecs, setLocalSpecs] = useState({});
  // Tracks local unsaved changes for size weight rules per product
  const [localRules, setLocalRules] = useState({});

  // Modal state for dynamic diamonds configuration
  const [activeVariantForDiamonds, setActiveVariantForDiamonds] = useState(null);
  const [activeProductForBulkDiamonds, setActiveProductForBulkDiamonds] = useState(null);
  const [modalDiamonds, setModalDiamonds] = useState([]);

  // Price Preview Modal state
  const [pricePreviewProduct, setPricePreviewProduct] = useState(null);
  const [pricePreviewData, setPricePreviewData] = useState([]);

  const openDiamondModal = (variant) => {
    setActiveVariantForDiamonds(variant);
    const existingDiamonds = getVariantField(variant, "diamonds", []);
    setModalDiamonds(existingDiamonds.map((d) => ({ ...d })));
  };

  const openBulkDiamondModal = (product) => {
    setActiveProductForBulkDiamonds(product);
    const firstVariant = product.variants?.edges?.[0]?.node;
    const existingDiamonds = firstVariant ? getVariantField(firstVariant, "diamonds", []) : [];
    setModalDiamonds(existingDiamonds.map((d) => ({ ...d })));
  };

  const updateModalDiamondRow = (index, field, value) => {
    const updated = [...modalDiamonds];
    if (field === "count") {
      updated[index][field] = Math.max(1, parseInt(value) || 1);
    } else if (field === "total_weight") {
      updated[index][field] = Math.max(0, parseFloat(value) || 0);
    } else {
      updated[index][field] = value;
    }
    setModalDiamonds(updated);
  };

  const addModalDiamondRow = () => {
    const defaultColor = uniqueColors.length > 0 ? uniqueColors[0] : "EF";
    const defaultClarity = uniqueClarities.length > 0 ? uniqueClarities[0] : "VVS-VS";
    setModalDiamonds([
      ...modalDiamonds,
      {
        diamond_type: "Small Diamond",
        shape: "Round",
        color: defaultColor,
        clarity: defaultClarity,
        count: 1,
        total_weight: 0.10,
      },
    ]);
  };

  const deleteModalDiamondRow = (index) => {
    setModalDiamonds(modalDiamonds.filter((_, i) => i !== index));
  };

  const applyModalDiamonds = () => {
    if (activeProductForBulkDiamonds) {
      // Bulk apply mode for all variants of the active product
      const newLocalSpecs = { ...localSpecs };
      const variants = activeProductForBulkDiamonds.variants?.edges || [];
      const totalWt = modalDiamonds.reduce((sum, d) => sum + Number(d.total_weight || 0), 0);
      const color = modalDiamonds.length > 0 ? (modalDiamonds[0].color || "") : "";
      const clarity = modalDiamonds.length > 0 ? (modalDiamonds[0].clarity || "") : "";

      variants.forEach((edge) => {
        const v = edge.node;
        const vId = v.id;
        const existing = newLocalSpecs[vId] || savedConfigsMap[vId] || {};
        newLocalSpecs[vId] = {
          ...existing,
          metal_type: existing.metal_type || getSmartMetalTypeFallback(v),
          purity: existing.purity || getSmartPurityFallback(v),
          diamonds: modalDiamonds.map((d) => ({ ...d })),
          diamond_carat: totalWt,
          diamond_color: color,
          diamond_clarity: clarity,
        };
      });

      setLocalSpecs(newLocalSpecs);
      setActiveProductForBulkDiamonds(null);
      shopify.toast.show("Applied bulk diamond configuration to all variants locally! Click 'Save Specs' to save to the database.");
    } else {
      // Single variant mode
      handleFieldChange(activeVariantForDiamonds, "diamonds", modalDiamonds);
      const totalWt = modalDiamonds.reduce((sum, d) => sum + Number(d.total_weight || 0), 0);
      handleFieldChange(activeVariantForDiamonds, "diamond_carat", totalWt.toFixed(3));
      if (modalDiamonds.length > 0) {
        handleFieldChange(activeVariantForDiamonds, "diamond_color", modalDiamonds[0].color || "");
        handleFieldChange(activeVariantForDiamonds, "diamond_clarity", modalDiamonds[0].clarity || "");
      }
      setActiveVariantForDiamonds(null);
      shopify.toast.show("Applied diamond rows locally! Remember to save specs.");
    }
  };

  const isSubmitting = navigation.state === "submitting";
  const isSyncActive = latestJob && (latestJob.status === "pending" || latestJob.status === "running");

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show(actionData.message);
      if (actionData.actionType === "save_variant_specs") {
        setLocalSpecs({});
        setLocalRules({});
      }
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  useEffect(() => {
    if (!isSyncActive) return;

    const interval = setInterval(() => {
      submit({ q: searchVal, poll: "true" }, { method: "GET", replace: true });
    }, 2000);

    return () => clearInterval(interval);
  }, [isSyncActive, submit, searchVal]);

  const getSmartMetalTypeFallback = (variant) => {
    const options = variant.selectedOptions || [];
    for (const opt of options) {
      const val = opt.value.toLowerCase();
      if (val.includes("silver")) return "silver";
    }
    return "gold";
  };

  const getSmartPurityFallback = (variant) => {
    const options = variant.selectedOptions || [];
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

  const isExcludedFromSizeRules = (productType) => {
    const type = (productType || "").toLowerCase();
    return type.includes("chain") || type.includes("bracelet") || type.includes("earring") || type.includes("pendant");
  };

  const getCalculatedWeight = (product, variant) => {
    const ruleEnabled = getRuleField(product.id, "enabled");
    if (!ruleEnabled) return null;

    const metalType = getVariantField(variant, "metal_type", "gold");
    if (metalType !== "gold") return null;

    if (isExcludedFromSizeRules(product.productType)) return null;

    // Find size option
    const sizeOption = (variant.selectedOptions || []).find((opt) => {
      const name = opt.name.toLowerCase();
      return name === "size" || name === "ring size" || name.includes("size");
    });
    if (!sizeOption) return null;

    const match = sizeOption.value.match(/(\d+(\.\d+)?)/);
    if (!match) return null;
    const selectedSize = parseFloat(match[1]);

    const baseSizeStart = Number(getRuleField(product.id, "base_size_start"));
    const baseSizeEnd = Number(getRuleField(product.id, "base_size_end"));
    const incrementWeightPerSize = Number(getRuleField(product.id, "increment_weight_per_size"));

    // Karat base weights
    const purity = getVariantField(variant, "purity", "18K").toLowerCase();
    let baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight"));
    if ((purity.includes("9k") || purity.includes("9kt")) && Number(getRuleField(product.id, "base_gold_weight_9k")) > 0) {
      baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight_9k"));
    } else if ((purity.includes("14k") || purity.includes("14kt")) && Number(getRuleField(product.id, "base_gold_weight_14k")) > 0) {
      baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight_14k"));
    } else if ((purity.includes("18k") || purity.includes("18kt")) && Number(getRuleField(product.id, "base_gold_weight_18k")) > 0) {
      baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight_18k"));
    } else if ((purity.includes("22k") || purity.includes("22kt")) && Number(getRuleField(product.id, "base_gold_weight_22k")) > 0) {
      baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight_22k"));
    } else if ((purity.includes("24k") || purity.includes("24kt")) && Number(getRuleField(product.id, "base_gold_weight_24k")) > 0) {
      baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight_24k"));
    }

    let adjustedWeight = baseGoldWeight;
    if (selectedSize <= baseSizeEnd) {
      adjustedWeight = baseGoldWeight;
    } else {
      adjustedWeight = baseGoldWeight + ((selectedSize - baseSizeEnd) * incrementWeightPerSize);
    }
    return Number(adjustedWeight.toFixed(3));
  };

  // Initializing local inputs from loaded database mappings or smart fallbacks
  const getVariantField = (variant, field, fallback = "") => {
    const variantId = variant.id;
    if (localSpecs[variantId]?.[field] !== undefined) {
      return localSpecs[variantId][field];
    }
    if (savedConfigsMap[variantId]?.[field] !== undefined) {
      return savedConfigsMap[variantId][field];
    }
    if (field === "metal_type") {
      return getSmartMetalTypeFallback(variant);
    }
    if (field === "purity") {
      return getSmartPurityFallback(variant);
    }
    if (field === "diamonds") {
      return savedConfigsMap[variantId]?.diamonds || [];
    }
    return fallback;
  };

  const handleFieldChange = (variant, field, value) => {
    const variantId = variant.id;
    setLocalSpecs((prev) => ({
      ...prev,
      [variantId]: {
        ...(prev[variantId] || savedConfigsMap[variantId] || {
          metal_type: getSmartMetalTypeFallback(variant),
          purity: getSmartPurityFallback(variant),
          metal_weight: 0,
          diamond_color: "",
          diamond_clarity: "",
          diamond_carat: 0,
          diamonds: [],
        }),
        [field]: value,
      },
    }));
  };

  /**
   * When a user changes the metal_weight for any variant, auto-propagate
   * the same weight to ALL other gold variants of the same product.
   * Physical reality: all karats (9K/14K/18K/22K) of the same jewelry piece
   * have the same gram weight; only the price differs.
   */
  const handleWeightChange = (product, variant, value) => {
    const variants = product.variants?.edges || [];
    const changedMetalType = (localSpecs[variant.id]?.metal_type ||
      savedConfigsMap[variant.id]?.metal_type ||
      getSmartMetalTypeFallback(variant));

    setLocalSpecs((prev) => {
      const updated = { ...prev };
      variants.forEach((edge) => {
        const v = edge.node;
        const vMetalType = (prev[v.id]?.metal_type ||
          savedConfigsMap[v.id]?.metal_type ||
          getSmartMetalTypeFallback(v));
        // Only propagate to variants with the same metal type (gold-to-gold, silver-to-silver)
        if (vMetalType === changedMetalType) {
          updated[v.id] = {
            ...(prev[v.id] || savedConfigsMap[v.id] || {
              metal_type: getSmartMetalTypeFallback(v),
              purity: getSmartPurityFallback(v),
              metal_weight: 0,
              diamond_color: "",
              diamond_clarity: "",
              diamond_carat: 0,
              diamonds: [],
            }),
            metal_weight: value,
          };
        }
      });
      return updated;
    });
  };

  const handleBulkApply = (product, w, targetPurity) => {
    const newLocalSpecs = { ...localSpecs };
    const variants = product.variants.edges || [];

    variants.forEach((edge) => {
      const v = edge.node;
      const vId = v.id;

      const existing = newLocalSpecs[vId] || savedConfigsMap[vId] || {};
      const variantPurity = (existing.purity || getSmartPurityFallback(v)).toLowerCase();
      const variantMetalType = (existing.metal_type || getSmartMetalTypeFallback(v)).toLowerCase();

      let isMatch = false;
      if (targetPurity === "all") {
        isMatch = true;
      } else if (targetPurity === "silver") {
        isMatch = variantMetalType === "silver";
      } else {
        // targetPurity is e.g. "9k", "14k", "18k", "22k", "24k"
        isMatch = variantMetalType === "gold" && variantPurity.includes(targetPurity.toLowerCase());
      }

      if (isMatch) {
        newLocalSpecs[vId] = {
          ...existing,
          metal_type: existing.metal_type || getSmartMetalTypeFallback(v),
          purity: existing.purity || getSmartPurityFallback(v),
          metal_weight: w !== "" ? Number(w) : (existing.metal_weight || 0),
        };
      }
    });

    setLocalSpecs(newLocalSpecs);
    shopify.toast.show(`Applied metal weight to matching variants locally! Click 'Save Specs' to save to the database.`);
  };

  const handleSaveRates = () => {
    submit(
      {
        actionType: "save_rates",
        gold_9k: gold9k,
        gold_14k: gold14k,
        gold_18k: gold18k,
        gold_22k: gold22k,
        gold_24k: gold24k,
        silver: silver,
        making_gold: makingGold,
        making_silver: makingSilver,
        gst: gst,
      },
      { method: "POST" }
    );
  };

  const handleSync = () => {
    submit({ actionType: "sync_prices" }, { method: "POST" });
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    submit({ q: searchVal }, { method: "GET", replace: true });
  };

  const getRuleField = (productId, field, fallback = "") => {
    if (localRules[productId]?.[field] !== undefined) {
      return localRules[productId][field];
    }
    if (savedRulesMap?.[productId]?.[field] !== undefined) {
      return savedRulesMap[productId][field];
    }
    if (field === "enabled") return false;
    if (field === "base_size_start") return 8;
    if (field === "base_size_end") return 12;
    if (field === "base_gold_weight") return 5.00;
    if (field === "base_gold_weight_9k") return 0;
    if (field === "base_gold_weight_14k") return 0;
    if (field === "base_gold_weight_18k") return 0;
    if (field === "base_gold_weight_22k") return 0;
    if (field === "base_gold_weight_24k") return 0;
    if (field === "increment_weight_per_size") return 0.10;
    return fallback;
  };

  const handleRuleFieldChange = (productId, field, value) => {
    setLocalRules((prev) => ({
      ...prev,
      [productId]: {
        ...(prev[productId] || savedRulesMap?.[productId] || {
          enabled: false,
          base_size_start: 8,
          base_size_end: 12,
          base_gold_weight: 5.00,
          base_gold_weight_9k: 0,
          base_gold_weight_14k: 0,
          base_gold_weight_18k: 0,
          base_gold_weight_22k: 0,
          base_gold_weight_24k: 0,
          increment_weight_per_size: 0.10,
        }),
        [field]: value,
      },
    }));
  };

  /**
   * Client-side price calculator — mirrors calculatePrice() server logic.
   * Uses current local specs (unsaved) to preview prices before saving.
   */
  const calculatePreviewPrices = (product) => {
    const variants = product.variants?.edges || [];
    const results = [];

    for (const edge of variants) {
      const v = edge.node;

      // Determine effective weight
      const calcW = getCalculatedWeight(product, v);
      const weight = calcW !== null ? calcW : Number(getVariantField(v, "metal_weight", 0));
      const metalType = getVariantField(v, "metal_type", "gold");
      const purity = (getVariantField(v, "purity", "18K") || "18K").toLowerCase();

      // Gold rate lookup
      let metalRate = 0;
      if (metalType === "gold") {
        if (purity.includes("9k")) metalRate = Number(config.gold_rate_9k);
        else if (purity.includes("14k")) metalRate = Number(config.gold_rate_14k);
        else if (purity.includes("18k")) metalRate = Number(config.gold_rate_18k);
        else if (purity.includes("22k")) metalRate = Number(config.gold_rate_22k);
        else if (purity.includes("24k")) metalRate = Number(config.gold_rate_24k || 0);
        else metalRate = Number(config.gold_rate_18k);
      } else if (metalType === "silver") {
        metalRate = Number(config.silver_rate);
      }

      const metalCost = weight * metalRate;

      // Making charges
      let makingCharge = 0;
      if (metalType === "gold") makingCharge = weight * Number(config.making_charge_gold);
      else if (metalType === "silver") makingCharge = weight * Number(config.making_charge_silver);

      // Diamond cost
      const diamonds = getVariantField(v, "diamonds", []);
      let diamondCost = 0;
      const diamondBreakdown = [];
      for (const d of diamonds) {
        const totalWeight = Number(d.total_weight || 0);
        if (totalWeight > 0 && d.color && d.clarity) {
          const rateMatch = (allDiamondRates || []).find(
            (r) => r.color.toUpperCase() === d.color.toUpperCase() &&
                   r.clarity.toUpperCase() === d.clarity.toUpperCase()
          );
          const ppc = rateMatch ? rateMatch.price_per_carat : 0;
          const rowCost = totalWeight * ppc;
          diamondCost += rowCost;
          diamondBreakdown.push({
            type: d.diamond_type || "Diamonds",
            color: d.color,
            clarity: d.clarity,
            totalWeight,
            ppc,
            cost: rowCost,
          });
        }
      }

      // GST & Final
      const subtotal = metalCost + makingCharge + diamondCost;
      const gstAmt = subtotal * (Number(config.gst_percentage) / 100);
      const finalPrice = Math.round(subtotal + gstAmt);

      results.push({
        variantId: v.id,
        label: v.selectedOptions?.map((o) => o.value).join(" / ") || v.sku || v.id,
        purity: getVariantField(v, "purity", "18K"),
        metalType,
        weight,
        metalRate,
        metalCost,
        makingCharge,
        diamondCost,
        diamondBreakdown,
        gst: gstAmt,
        subtotal,
        finalPrice,
        isCalculatedWeight: calcW !== null,
        missingRate: metalType === "gold" && metalRate === 0,
        missingDiamondRate: diamonds.length > 0 && diamondCost === 0 && diamonds.some(d => d.total_weight > 0),
      });
    }

    return results;
  };

  const handlePreviewPrices = (product) => {
    const preview = calculatePreviewPrices(product);
    setPricePreviewData(preview);
    setPricePreviewProduct(product);
  };

  const handleSaveProductSpecs = (product) => {
    const baseSizeStart = Number(getRuleField(product.id, "base_size_start"));
    const baseSizeEnd = Number(getRuleField(product.id, "base_size_end"));
    const baseGoldWeight = Number(getRuleField(product.id, "base_gold_weight"));
    
    const baseGoldWeight9k = Number(getRuleField(product.id, "base_gold_weight_9k"));
    const baseGoldWeight14k = Number(getRuleField(product.id, "base_gold_weight_14k"));
    const baseGoldWeight18k = Number(getRuleField(product.id, "base_gold_weight_18k"));
    const baseGoldWeight22k = Number(getRuleField(product.id, "base_gold_weight_22k"));
    const baseGoldWeight24k = Number(getRuleField(product.id, "base_gold_weight_24k"));
    
    const incrementWeightPerSize = Number(getRuleField(product.id, "increment_weight_per_size"));

    if (baseSizeEnd < baseSizeStart) {
      shopify.toast.show("Base Size End cannot be less than Base Size Start", { isError: true });
      return;
    }
    if (baseGoldWeight < 0 || baseGoldWeight9k < 0 || baseGoldWeight14k < 0 || baseGoldWeight18k < 0 || baseGoldWeight22k < 0 || baseGoldWeight24k < 0) {
      shopify.toast.show("Base Gold Weight cannot be negative", { isError: true });
      return;
    }
    if (incrementWeightPerSize < 0) {
      shopify.toast.show("Weight Increment cannot be negative", { isError: true });
      return;
    }

    const payload = product.variants.edges.map((edge) => {
      const v = edge.node;
      const calcW = getCalculatedWeight(product, v);
      const weight = calcW !== null ? calcW : Number(getVariantField(v, "metal_weight", 0));
      return {
        variantId: v.id,
        sku: v.sku || "",
        metalType: getVariantField(v, "metal_type", "gold"),
        purity: getVariantField(v, "purity", "18K"),
        weight: weight,
        diamonds: getVariantField(v, "diamonds", []),
      };
    });

    submit(
      {
        actionType: "save_variant_specs",
        productId: product.id,
        specs: JSON.stringify(payload),
        ruleEnabled: String(getRuleField(product.id, "enabled")),
        baseSizeStart: String(baseSizeStart),
        baseSizeEnd: String(baseSizeEnd),
        baseGoldWeight: String(baseGoldWeight),
        baseGoldWeight9k: String(baseGoldWeight9k),
        baseGoldWeight14k: String(baseGoldWeight14k),
        baseGoldWeight18k: String(baseGoldWeight18k),
        baseGoldWeight22k: String(baseGoldWeight22k),
        baseGoldWeight24k: String(baseGoldWeight24k),
        incrementWeightPerSize: String(incrementWeightPerSize),
      },
      { method: "POST" }
    );
  };
  return (
    <s-page heading="Jewelry Pricing & Inventory Dashboard" inline-size="large">
      <s-button
        slot="primary-action"
        onClick={handleSync}
        disabled={isSyncActive ? true : undefined}
        {...(isSubmitting ? { loading: true } : {})}
      >
        {isSyncActive ? "Syncing in Background..." : "Recalculate & Sync Shopify Prices"}
      </s-button>

      <style>{`
        s-page {
          --pc-page-max-width: 100% !important;
          max-width: 100% !important;
        }
        .layout-grid {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: 24px;
          margin-top: 24px;
          align-items: start;
        }
        @media (max-width: 800px) {
          .layout-grid {
            grid-template-columns: 1fr;
          }
        }
        .form-card {
          background: #ffffff;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
        }
        .form-card-title {
          font-size: 16px;
          font-weight: 600;
          margin-top: 0;
          margin-bottom: 20px;
          color: #202223;
          border-bottom: 1px solid #f1f2f3;
          padding-bottom: 12px;
        }
        .grid-2 {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 16px;
          margin-bottom: 16px;
        }
        .sidebar-card {
          background: #f6f6f7;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 24px;
        }
        .sidebar-card-title {
          font-size: 14px;
          font-weight: 600;
          margin-top: 0;
          margin-bottom: 12px;
          color: #202223;
          border-bottom: 1px solid #e1e3e5;
          padding-bottom: 8px;
        }
        .form-group {
          margin-bottom: 16px;
        }
        
        /* Spec Manager Styling */
        .product-item {
          border: 1px solid #e1e3e5;
          border-radius: 6px;
          margin-bottom: 12px;
          background: #ffffff;
          overflow: hidden;
        }
        .product-header {
          display: flex;
          align-items: center;
          padding: 12px 16px;
          background: #fafbfb;
          cursor: pointer;
          user-select: none;
          justify-content: space-between;
        }
        .product-header:hover {
          background: #f1f2f3;
        }
        .product-meta {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .product-thumbnail {
          width: 40px;
          height: 40px;
          border-radius: 4px;
          background: #f0f0f0;
          object-fit: cover;
          border: 1px solid #e1e3e5;
        }
        .product-title {
          font-size: 14px;
          font-weight: 500;
          color: #202223;
        }
        .variants-container {
          padding: 16px;
          border-top: 1px solid #e1e3e5;
          background: #ffffff;
        }
        .spec-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          margin-bottom: 16px;
        }
        .spec-table th {
          text-align: left;
          padding: 8px;
          background: #f6f6f7;
          border-bottom: 2px solid #e1e3e5;
          font-weight: 600;
          color: #202223;
        }
        .spec-table td {
          padding: 8px;
          border-bottom: 1px solid #e1e3e5;
          vertical-align: middle;
        }
        .cell-input {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 12px;
          box-sizing: border-box;
          outline: none;
          background: #fff;
        }
        .cell-input:focus {
          border-color: #008060;
        }
        .cell-select {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 12px;
          background: #fff;
          box-sizing: border-box;
          outline: none;
          cursor: pointer;
        }
        .cell-select:focus {
          border-color: #008060;
        }
        .badge-opt {
          display: inline-block;
          background: #e4e6e7;
          color: #202223;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 500;
        }

        /* Modal Overlay */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          backdrop-filter: blur(2px);
        }
        .modal-container {
          background: #ffffff;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          width: 90%;
          max-width: 850px;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .modal-header {
          padding: 16px 24px;
          border-bottom: 1px solid #e1e3e5;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #fafbfb;
        }
        .modal-title {
          font-size: 16px;
          font-weight: 600;
          color: #202223;
          margin: 0;
        }
        .modal-close-btn {
          background: transparent;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #6d7175;
        }
        .modal-close-btn:hover {
          color: #202223;
        }
        .modal-body {
          padding: 24px;
          overflow-y: auto;
          flex: 1;
        }
        .modal-footer {
          padding: 16px 24px;
          border-top: 1px solid #e1e3e5;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          background: #fafbfb;
        }
        
        /* Table / row styling in modal */
        .diamond-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 16px;
        }
        .diamond-table th {
          text-align: left;
          padding: 8px 12px;
          background: #f1f2f3;
          font-size: 12px;
          font-weight: 600;
          color: #6d7175;
          border-bottom: 1px solid #e1e3e5;
        }
        .diamond-table td {
          padding: 8px 12px;
          border-bottom: 1px solid #f1f2f3;
          vertical-align: middle;
        }
        .diamond-input-select {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          font-size: 13px;
          background: #fff;
          outline: none;
        }
        .btn-add-row {
          background: #f1f2f3;
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          padding: 6px 12px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          color: #202223;
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 10px;
        }
        .btn-add-row:hover {
          background: #e2e8f0;
        }
        .btn-delete-row {
          background: transparent;
          border: none;
          color: #ff0000;
          cursor: pointer;
          padding: 4px;
          font-size: 16px;
        }
        .btn-delete-row:hover {
          color: #cc0000;
        }
        .btn-configure-diamonds {
          background: #f1f2f3;
          border: 1px solid #cbd5e1;
          border-radius: 4px;
          padding: 6px 12px;
          font-size: 11px;
          cursor: pointer;
          font-weight: 500;
          color: #202223;
          transition: all 0.2s ease;
          width: 100%;
          text-align: center;
        }
        .btn-configure-diamonds:hover {
          background: #e2e8f0;
          border-color: #94a3b8;
        }
        /* Price Preview Modal */
        .preview-modal-container {
          background: #ffffff;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
          width: 96%;
          max-width: 1100px;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: slideUp 0.22s ease;
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .preview-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .preview-table thead tr {
          background: linear-gradient(135deg, #1a1f36 0%, #2d3561 100%);
          color: #ffffff;
        }
        .preview-table thead th {
          padding: 11px 14px;
          text-align: right;
          font-weight: 600;
          font-size: 11.5px;
          letter-spacing: 0.3px;
          white-space: nowrap;
        }
        .preview-table thead th:first-child { text-align: left; }
        .preview-table thead th:nth-child(2) { text-align: left; }
        .preview-table tbody tr {
          border-bottom: 1px solid #eef0f2;
          transition: background 0.15s;
        }
        .preview-table tbody tr:hover { background: #f7f8fc; }
        .preview-table tbody td {
          padding: 10px 14px;
          text-align: right;
          color: #374151;
          font-size: 13px;
        }
        .preview-table tbody td:first-child { text-align: left; font-weight: 500; }
        .preview-table tbody td:nth-child(2) { text-align: left; }
        .preview-table tfoot tr {
          background: #f0fdf4;
          font-weight: 700;
          border-top: 2px solid #10b981;
        }
        .preview-table tfoot td {
          padding: 11px 14px;
          text-align: right;
          color: #065f46;
          font-size: 13px;
        }
        .preview-table tfoot td:first-child { text-align: left; color: #065f46; }
        .final-price-badge {
          display: inline-block;
          background: linear-gradient(135deg, #10b981, #059669);
          color: #fff;
          padding: 4px 12px;
          border-radius: 20px;
          font-weight: 700;
          font-size: 14px;
          letter-spacing: 0.3px;
        }
        .preview-warning-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          background: #fff3cd;
          color: #856404;
          border: 1px solid #ffc107;
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 11px;
          font-weight: 600;
        }
        .preview-diamond-pill {
          display: inline-block;
          background: #ede9fe;
          color: #5b21b6;
          border-radius: 4px;
          padding: 1px 6px;
          font-size: 10.5px;
          font-weight: 500;
          margin-bottom: 2px;
        }
        .preview-summary-bar {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          padding: 14px 24px;
          background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
          border-top: 1px solid #a7f3d0;
        }
        .preview-summary-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }
        .preview-summary-label {
          font-size: 10.5px;
          color: #6b7280;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }
        .preview-summary-value {
          font-size: 16px;
          font-weight: 700;
          color: #065f46;
        }
      `}</style>

      {latestJob && (
        <div className="sync-job-card" style={{
          background: latestJob.status === "failed" ? "#fff5f5" : latestJob.status === "completed" ? "#f4fcf9" : "#f0f4f9",
          border: `1px solid ${latestJob.status === "failed" ? "#ffc1c1" : latestJob.status === "completed" ? "#a3e2cb" : "#b0cdeb"}`,
          borderRadius: "8px",
          padding: "20px",
          marginBottom: "24px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
          transition: "all 0.3s ease"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>
                {latestJob.status === "running" && "🔄"}
                {latestJob.status === "pending" && "⏳"}
                {latestJob.status === "completed" && "✅"}
                {latestJob.status === "failed" && "❌"}
              </span>
              <strong style={{ fontSize: "14px", textTransform: "capitalize", color: "#202223" }}>
                Sync Job Status: {latestJob.status}
              </strong>
            </div>
            <span style={{ fontSize: "12px", color: "#6d7175", display: "flex", alignItems: "center", gap: "12px" }}>
              {latestJob.status === "completed" && `Completed: ${new Date(latestJob.updated_at).toLocaleString()}`}
              {latestJob.status === "failed" && `Failed: ${new Date(latestJob.updated_at).toLocaleString()}`}
              {(latestJob.status === "running" || latestJob.status === "pending") && `Started: ${new Date(latestJob.created_at).toLocaleTimeString()}`}
              <button
                type="button"
                onClick={() => {
                  submit({ actionType: "clear_sync_jobs" }, { method: "POST" });
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#6d7175",
                  cursor: "pointer",
                  fontSize: "18px",
                  fontWeight: "bold",
                  padding: "0 4px",
                  display: "inline-flex",
                  alignItems: "center",
                  lineHeight: "1",
                  marginTop: "-2px"
                }}
                title="Dismiss / Clear Sync Job Log"
              >
                &times;
              </button>
            </span>
          </div>

          <div style={{ display: "flex", gap: "24px", marginBottom: "12px", fontSize: "13px" }}>
            <div>Processed: <strong>{latestJob.processed}</strong> / <strong>{latestJob.total}</strong></div>
            <div style={{ color: "#008060" }}>Successful: <strong>{latestJob.successful}</strong></div>
            <div style={{ color: "#bf0711" }}>Failed: <strong>{latestJob.failed}</strong></div>
          </div>

          {(latestJob.status === "running" || latestJob.status === "pending") && latestJob.total > 0 && (
            <div style={{ width: "100%", background: "#e1e3e5", borderRadius: "10px", height: "12px", overflow: "hidden", marginBottom: "8px" }}>
              <div style={{
                width: `${Math.min(100, Math.round((latestJob.processed / latestJob.total) * 100))}%`,
                background: "#005ea2",
                height: "100%",
                borderRadius: "10px",
                transition: "width 0.4s ease-in-out"
              }} />
            </div>
          )}

          {latestJob.errors && (
            <div style={{
              marginTop: "12px",
              padding: "10px",
              background: "#ffffff",
              border: "1px solid #e1e3e5",
              borderRadius: "6px",
              fontSize: "11px",
              fontFamily: "monospace",
              maxHeight: "150px",
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              color: latestJob.status === "failed" ? "#bf0711" : "#5c5f62"
            }}>
              <strong>Job Logs / Errors:</strong>
              <div>{latestJob.errors}</div>
            </div>
          )}
        </div>
      )}

      <div className="layout-grid">
        <div className="main-content">
          {/* Metal Prices Section */}
          <div className="form-card">
            <h2 className="form-card-title">💰 Metal Rates (per gram)</h2>
            <div className="grid-2">
              <s-text-field
                name="gold_9k"
                label="Gold Rate 9K (₹)"
                type="number"
                value={gold9k}
                onChange={(e) => setGold9k(e.currentTarget.value)}
              />
              <s-text-field
                name="gold_14k"
                label="Gold Rate 14K (₹)"
                type="number"
                value={gold14k}
                onChange={(e) => setGold14k(e.currentTarget.value)}
              />
            </div>
            <div className="grid-2">
              <s-text-field
                name="gold_18k"
                label="Gold Rate 18K (₹)"
                type="number"
                value={gold18k}
                onChange={(e) => setGold18k(e.currentTarget.value)}
              />
              <s-text-field
                name="gold_22k"
                label="Gold Rate 22K (₹)"
                type="number"
                value={gold22k}
                onChange={(e) => setGold22k(e.currentTarget.value)}
              />
            </div>
            <div className="grid-2" style={{ marginTop: "16px" }}>
              <s-text-field
                name="gold_24k"
                label="Gold Rate 24K (₹)"
                type="number"
                value={gold24k}
                onChange={(e) => setGold24k(e.currentTarget.value)}
              />
              <s-text-field
                name="silver"
                label="Silver Rate (₹/g)"
                type="number"
                value={silver}
                onChange={(e) => setSilver(e.currentTarget.value)}
              />
            </div>
          </div>

          {/* Charges and Taxes */}
          <div className="form-card">
            <h2 className="form-card-title">🔨 Labour (Making) Charges & Taxes</h2>
            <div className="grid-2">
              <s-text-field
                name="making_gold"
                label="Gold Making Charge (₹/g)"
                type="number"
                value={makingGold}
                onChange={(e) => setMakingGold(e.currentTarget.value)}
              />
              <s-text-field
                name="making_silver"
                label="Silver Making Charge (₹/g)"
                type="number"
                value={makingSilver}
                onChange={(e) => setMakingSilver(e.currentTarget.value)}
              />
            </div>
            <div className="form-group" style={{ maxWidth: "50%", marginTop: "16px", marginBottom: "24px" }}>
              <s-text-field
                name="gst"
                label="GST Percentage (%)"
                type="number"
                value={gst}
                onChange={(e) => setGst(e.currentTarget.value)}
              />
            </div>
            <s-button onClick={handleSaveRates} variant="primary" {...(isSubmitting ? { loading: true } : {})}>
              Save Rates Settings
            </s-button>
          </div>

          {/* Product Specifications Manager */}
          <div className="form-card">
            <h2 className="form-card-title">📐 Configure Product Specifications</h2>
            
            {/* Search Form */}
            <form onSubmit={handleSearchSubmit} style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
              <input
                type="text"
                placeholder="Search products by title..."
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
                style={{
                  flex: 1,
                  padding: "10px 14px",
                  borderRadius: "6px",
                  border: "1px solid #ccc",
                  fontSize: "13px",
                  outline: "none",
                }}
              />
              <s-button type="submit">Search</s-button>
            </form>

            {/* List Products */}
            {products.length === 0 ? (
              <p style={{ color: "#6d7175", textAlign: "center", padding: "20px 0" }}>
                No active Shopify products found. Try creating some test products from the Home Page first.
              </p>
            ) : (
              <div>
                {products.map((product) => {
                  const isExpanded = expandedProduct === product.id;
                  const variants = product.variants.edges || [];
                  const isExcluded = isExcludedFromSizeRules(product.productType);
                  const isRuleActive = getRuleField(product.id, "enabled") && !isExcluded;

                  return (
                    <div className="product-item" key={product.id}>
                      <div
                        className="product-header"
                        onClick={() => setExpandedProduct(isExpanded ? null : product.id)}
                      >
                        <div className="product-meta">
                          <img
                            src={product.featuredImage?.url || "https://placehold.co/80?text=Ring"}
                            alt={product.title}
                            className="product-thumbnail"
                          />
                          <div>
                            <div className="product-title">{product.title}</div>
                            <div style={{ fontSize: "11px", color: "#6d7175", marginTop: "2px" }}>
                              {variants.length} variant(s)
                            </div>
                          </div>
                        </div>
                        <s-button variant={isExpanded ? "secondary" : "primary"}>
                          {isExpanded ? "Hide Specs ▲" : "Configure Specs ▼"}
                        </s-button>
                      </div>

                      {isExpanded && (
                        <div className="variants-container">
                          {/* Size Weight Adjustment Section */}
                          {isExcluded ? (
                            <div style={{
                              marginTop: "12px",
                              marginBottom: "20px",
                              padding: "14px 16px",
                              background: "#f4f6f8",
                              border: "1px dashed #c4cdd5",
                              borderRadius: "8px",
                              color: "#6d7175",
                              fontSize: "13px",
                              lineHeight: "1.5",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "12px",
                              flexWrap: "wrap",
                            }}>
                              <span>📏 Size-based weight adjustment is not applicable for <strong>{product.productType || "this product type"}</strong> (Chains, Bracelets, Earrings, and Pendants are excluded). Please specify metal weights directly in the variants table below.</span>
                              <s-button
                                variant="secondary"
                                onClick={() => handlePreviewPrices(product)}
                              >
                                📊 Preview Prices
                              </s-button>
                            </div>
                          ) : (
                            <div style={{
                              marginTop: "12px",
                              marginBottom: "20px",
                              padding: "20px",
                              background: "linear-gradient(135deg, #f9fafb 0%, #f4f6f8 100%)",
                              border: "1px solid #c4cdd5",
                              borderRadius: "8px",
                              boxShadow: "0 2px 5px rgba(0,0,0,0.02)"
                            }}>
                              <h3 style={{ fontSize: "14px", fontWeight: "600", marginBottom: "16px", color: "#202223", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                                <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>📏 Size Based Gold Weight Adjustment</span>
                                <s-button
                                  variant="secondary"
                                  onClick={() => handlePreviewPrices(product)}
                                >
                                  📊 Preview Prices
                                </s-button>
                              </h3>
                              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
                                <input
                                  type="checkbox"
                                  id={`rule-enabled-${product.id}`}
                                  checked={getRuleField(product.id, "enabled")}
                                  onChange={(e) => handleRuleFieldChange(product.id, "enabled", e.target.checked)}
                                  style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "#008060" }}
                                />
                                <label htmlFor={`rule-enabled-${product.id}`} style={{ fontSize: "13px", fontWeight: "500", cursor: "pointer", color: "#202223" }}>
                                  Enable Size Weight Adjustment
                                </label>
                              </div>
                              
                              <div style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                                gap: "16px",
                                opacity: getRuleField(product.id, "enabled") ? 1 : 0.5,
                                pointerEvents: getRuleField(product.id, "enabled") ? "auto" : "none",
                                transition: "all 0.2s ease"
                              }}>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Size Start</label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={getRuleField(product.id, "base_size_start")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_size_start", e.target.value)}
                                    className="cell-input"
                                    placeholder="8"
                                    style={{ padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Size End</label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={getRuleField(product.id, "base_size_end")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_size_end", e.target.value)}
                                    className="cell-input"
                                    placeholder="12"
                                    style={{ padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Gold Weight (General) (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "base_gold_weight")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_gold_weight", e.target.value)}
                                    className="cell-input"
                                    placeholder="5.00"
                                    style={{ padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Weight 9K (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "base_gold_weight_9k")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_gold_weight_9k", e.target.value)}
                                    className="cell-input"
                                    placeholder="0.00"
                                    style={{ padding: "8px 12px", border: "1px solid #c4c5c6", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Weight 14K (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "base_gold_weight_14k")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_gold_weight_14k", e.target.value)}
                                    className="cell-input"
                                    placeholder="0.00"
                                    style={{ padding: "8px 12px", border: "1px solid #c4c5c6", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Weight 18K (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "base_gold_weight_18k")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_gold_weight_18k", e.target.value)}
                                    className="cell-input"
                                    placeholder="0.00"
                                    style={{ padding: "8px 12px", border: "1px solid #c4c5c6", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Weight 22K (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "base_gold_weight_22k")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_gold_weight_22k", e.target.value)}
                                    className="cell-input"
                                    placeholder="0.00"
                                    style={{ padding: "8px 12px", border: "1px solid #c4c5c6", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Base Weight 24K (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "base_gold_weight_24k")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "base_gold_weight_24k", e.target.value)}
                                    className="cell-input"
                                    placeholder="0.00"
                                    style={{ padding: "8px 12px", border: "1px solid #c4c5c6", borderRadius: "5px" }}
                                  />
                                </div>
                                <div>
                                  <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px", fontWeight: "500" }}>Weight Increment Per Size (g)</label>
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={getRuleField(product.id, "increment_weight_per_size")}
                                    onChange={(e) => handleRuleFieldChange(product.id, "increment_weight_per_size", e.target.value)}
                                    className="cell-input"
                                    placeholder="0.10"
                                    style={{ padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "5px" }}
                                  />
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Bulk Apply Row */}
                          <div style={{
                            display: "flex",
                            gap: "12px",
                            alignItems: "flex-end",
                            flexWrap: "wrap",
                            marginBottom: "16px",
                            padding: "12px",
                            background: "#f9fafb",
                            border: "1px dashed #c4cdd5",
                            borderRadius: "6px"
                          }}>
                            <div style={{ fontSize: "13px", fontWeight: "600", color: "#202223", width: "100%", marginBottom: "-4px" }}>
                              ⚡ Bulk Apply Specs to All Variants of this Product
                            </div>
                            <div style={{ flex: "1 1 150px" }}>
                              <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px" }}>Target Purity</label>
                              <select
                                id={`bulk-purity-${product.id}`}
                                disabled={isRuleActive ? true : undefined}
                                style={{ padding: "8px 12px", border: "1px solid #c4cdd5", borderRadius: "5px", width: "100%", height: "36px", background: isRuleActive ? "#f1f2f4" : "white", color: isRuleActive ? "#6d7175" : "#202223", cursor: isRuleActive ? "not-allowed" : "pointer" }}
                              >
                                <option value="all">All Purities (Gold/Silver)</option>
                                <option value="9k">9K Gold Only</option>
                                <option value="14k">14K Gold Only</option>
                                <option value="18k">18K Gold Only</option>
                                <option value="22k">22K Gold Only</option>
                                <option value="24k">24K Gold Only</option>
                                <option value="silver">Silver Only</option>
                              </select>
                            </div>
                            <div style={{ flex: "1 1 200px" }}>
                              <label style={{ fontSize: "11px", color: isRuleActive ? "#b85c00" : "#6d7175", display: "block", marginBottom: "4px", fontWeight: isRuleActive ? "600" : "normal" }}>
                                Metal Weight (g) {isRuleActive && "(Managed by Size Rule)"}
                              </label>
                              <input
                                id={`bulk-w-${product.id}`}
                                type="number"
                                step="0.001"
                                placeholder={isRuleActive ? "N/A" : "e.g. 3.5"}
                                className="cell-input"
                                disabled={isRuleActive ? true : undefined}
                                style={{ height: "36px", backgroundColor: isRuleActive ? "#f1f2f4" : "white", cursor: isRuleActive ? "not-allowed" : "text", color: isRuleActive ? "#6d7175" : "#202223" }}
                              />
                            </div>
                            <div style={{ flex: "1 1 120px" }}>
                              <s-button
                                disabled={isRuleActive ? true : undefined}
                                onClick={() => {
                                  const w = document.getElementById(`bulk-w-${product.id}`)?.value || "";
                                  const purity = document.getElementById(`bulk-purity-${product.id}`)?.value || "all";
                                  handleBulkApply(product, w, purity);
                                }}
                              >
                                Apply Metal Weight
                              </s-button>
                            </div>
                            
                            <div style={{ flex: "2 1 240px", borderLeft: "1px solid #c4cdd5", paddingLeft: "12px", display: "flex", gap: "12px", alignItems: "flex-end" }}>
                              <div style={{ flex: "1" }}>
                                <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px" }}>Diamonds Configuration</label>
                                <span style={{ fontSize: "12px", color: "#202223", display: "block", height: "36px", alignContent: "center" }}>
                                  {(() => {
                                    const firstVariant = product.variants?.edges?.[0]?.node;
                                    const vDiamonds = firstVariant ? getVariantField(firstVariant, "diamonds", []) : [];
                                    const totalCarats = vDiamonds.reduce((sum, d) => sum + Number(d.total_weight || 0), 0);
                                    return vDiamonds.length > 0 
                                      ? `Bulk Config: ${vDiamonds.length} rows (${totalCarats.toFixed(2)}ct)`
                                      : "No bulk config set yet";
                                  })()}
                                </span>
                              </div>
                              <s-button
                                onClick={() => openBulkDiamondModal(product)}
                                variant="primary"
                              >
                                💎 Configure Diamonds (Bulk)
                              </s-button>
                            </div>
                          </div>

                          <table className="spec-table">
                            <thead>
                              <tr>
                                <th style={{ width: "20%" }}>Variant Options</th>
                                <th style={{ width: "15%" }}>SKU</th>
                                <th style={{ width: "15%" }}>Metal Type</th>
                                <th style={{ width: "15%" }}>Purity</th>
                                <th style={{ width: "15%" }}>Weight (g)</th>
                                <th style={{ width: "20%" }}>Diamonds</th>
                              </tr>
                            </thead>
                            <tbody>
                              {variants.map((edge) => {
                                const v = edge.node;
                                const diamondsList = getVariantField(v, "diamonds", []);
                                return (
                                  <tr key={v.id}>
                                    <td>
                                      <span className="badge-opt">
                                        {v.selectedOptions.map((o) => o.value).join(" / ")}
                                      </span>
                                    </td>
                                    <td>
                                      <code style={{ fontSize: "11px" }}>{v.sku || "N/A"}</code>
                                    </td>
                                    <td>
                                      <select
                                        className="cell-select"
                                        value={getVariantField(v, "metal_type", "gold")}
                                        onChange={(e) => handleFieldChange(v, "metal_type", e.target.value)}
                                      >
                                        <option value="gold">Gold 🟡</option>
                                        <option value="silver">Silver ⚪</option>
                                      </select>
                                    </td>
                                    <td>
                                      <select
                                        className="cell-select"
                                        value={getVariantField(v, "purity", "18K")}
                                        onChange={(e) => handleFieldChange(v, "purity", e.target.value)}
                                      >
                                        <option value="9K">9K</option>
                                        <option value="14K">14K</option>
                                        <option value="18K">18K</option>
                                        <option value="22K">22K</option>
                                        <option value="24K">24K</option>
                                        <option value="Silver">Silver</option>
                                      </select>
                                    </td>
                                    <td>
                                      {(() => {
                                        const calcW = getCalculatedWeight(product, v);
                                        const displayW = calcW !== null ? calcW : getVariantField(v, "metal_weight", 0);
                                        const isCalculated = calcW !== null;
                                        return (
                                          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                            <input
                                              type="number"
                                              step="0.001"
                                              className="cell-input"
                                              placeholder="0.000"
                                              value={displayW}
                                              disabled={isCalculated ? true : undefined}
                                              style={isCalculated ? { backgroundColor: "#e2f1e8", color: "#108043", fontWeight: "600", borderColor: "#a3d7b5", cursor: "not-allowed" } : {}}
                                              onChange={(e) => handleWeightChange(product, v, e.target.value)}
                                            />
                                            {isCalculated && (
                                              <span style={{ fontSize: "9px", color: "#108043", fontWeight: "500", display: "block", textAlign: "left" }}>✓ Size Rule Calc</span>
                                            )}
                                            {!isCalculated && (
                                              <span style={{ fontSize: "9px", color: "#6d7175", display: "block", textAlign: "left" }}>Auto-syncs all karats</span>
                                            )}
                                          </div>
                                        );
                                      })()}
                                    </td>
                                    <td>
                                      <button
                                        type="button"
                                        className="btn-configure-diamonds"
                                        onClick={() => openDiamondModal(v)}
                                      >
                                        💎 Config ({diamondsList.length} rows - {Number(getVariantField(v, "diamond_carat", 0)).toFixed(2)}ct)
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <s-button
                              variant="primary"
                              onClick={() => handleSaveProductSpecs(product)}
                              {...(isSubmitting ? { loading: true } : {})}
                            >
                              💾 Save Specs for this Product
                            </s-button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-content">
          {/* Statistics Card */}
          <div className="sidebar-card">
            <h3 className="sidebar-card-title">📈 App Data Status</h3>
            <p style={{ margin: "0 0 8px 0", fontSize: "13px" }}>
              <strong>Shop:</strong> {config.shop}
            </p>
            <p style={{ margin: 0, fontSize: "13px" }}>
              <strong>Configured Variants Count:</strong> {variantCount} variants mapped.
            </p>
          </div>
        </div>
      </div>

      {/* ====== PRICE PREVIEW MODAL ====== */}
      {pricePreviewProduct && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPricePreviewProduct(null); }}>
          <div className="preview-modal-container">
            {/* Header */}
            <div className="modal-header" style={{ background: "linear-gradient(135deg, #1a1f36 0%, #2d3561 100%)", padding: "18px 24px" }}>
              <div>
                <h3 className="modal-title" style={{ color: "#fff", fontSize: "17px", marginBottom: "4px" }}>
                  📊 Price Preview — {pricePreviewProduct.title}
                </h3>
                <p style={{ color: "rgba(255,255,255,0.65)", fontSize: "12px", margin: 0 }}>
                  Based on current (unsaved) specs. Prices update after clicking Save.
                </p>
              </div>
              <button type="button" className="modal-close-btn" style={{ color: "rgba(255,255,255,0.8)", fontSize: "22px" }} onClick={() => setPricePreviewProduct(null)}>&times;</button>
            </div>

            {/* Summary Bar */}
            {pricePreviewData.length > 0 && (() => {
              const totals = pricePreviewData.reduce((acc, r) => ({
                metal: acc.metal + r.metalCost,
                making: acc.making + r.makingCharge,
                diamond: acc.diamond + r.diamondCost,
                gst: acc.gst + r.gst,
                final: acc.final + r.finalPrice,
              }), { metal: 0, making: 0, diamond: 0, gst: 0, final: 0 });
              const fmt = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
              return (
                <div className="preview-summary-bar">
                  <div className="preview-summary-item">
                    <span className="preview-summary-label">Total Variants</span>
                    <span className="preview-summary-value">{pricePreviewData.length}</span>
                  </div>
                  <div style={{ width: "1px", background: "#a7f3d0", margin: "0 4px" }} />
                  <div className="preview-summary-item">
                    <span className="preview-summary-label">Metal Cost (All)</span>
                    <span className="preview-summary-value" style={{ fontSize: "13px" }}>{fmt(totals.metal)}</span>
                  </div>
                  <div className="preview-summary-item">
                    <span className="preview-summary-label">Making (All)</span>
                    <span className="preview-summary-value" style={{ fontSize: "13px" }}>{fmt(totals.making)}</span>
                  </div>
                  <div className="preview-summary-item">
                    <span className="preview-summary-label">Diamond (All)</span>
                    <span className="preview-summary-value" style={{ fontSize: "13px", color: "#5b21b6" }}>{fmt(totals.diamond)}</span>
                  </div>
                  <div className="preview-summary-item">
                    <span className="preview-summary-label">GST (All)</span>
                    <span className="preview-summary-value" style={{ fontSize: "13px", color: "#b45309" }}>{fmt(totals.gst)}</span>
                  </div>
                  <div style={{ width: "1px", background: "#a7f3d0", margin: "0 4px" }} />
                  <div className="preview-summary-item">
                    <span className="preview-summary-label">💰 Grand Total</span>
                    <span className="preview-summary-value" style={{ fontSize: "20px", color: "#047857" }}>{fmt(totals.final)}</span>
                  </div>
                </div>
              );
            })()}

            {/* Table Body */}
            <div className="modal-body" style={{ padding: "0" }}>
              <div style={{ overflowX: "auto" }}>
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: "160px" }}>Variant</th>
                      <th style={{ minWidth: "80px" }}>Purity</th>
                      <th>Weight (g)</th>
                      <th>Rate (₹/g)</th>
                      <th>Metal Cost</th>
                      <th>Making</th>
                      <th>Diamonds</th>
                      <th>Diamond Cost</th>
                      <th>Subtotal</th>
                      <th>GST ({config.gst_percentage}%)</th>
                      <th style={{ minWidth: "120px" }}>Final Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricePreviewData.map((row) => {
                      const fmt = (n) => `₹${Math.round(n).toLocaleString("en-IN")}`;
                      const fmtDec = (n) => `₹${Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
                      return (
                        <tr key={row.variantId}>
                          <td>
                            <span className="badge-opt" style={{ fontSize: "12px" }}>{row.label}</span>
                          </td>
                          <td>
                            <span style={{ fontWeight: "600", color: row.metalType === "gold" ? "#92400e" : "#374151" }}>
                              {row.purity}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontWeight: "600" }}>{Number(row.weight).toFixed(3)}g</span>
                            {row.isCalculatedWeight && <span style={{ fontSize: "10px", color: "#059669", display: "block" }}>📏 Rule</span>}
                          </td>
                          <td style={{ color: "#6b7280" }}>
                            {row.missingRate ? <span className="preview-warning-badge">⚠ No Rate</span> : fmt(row.metalRate)}
                          </td>
                          <td>{fmtDec(row.metalCost)}</td>
                          <td>{fmtDec(row.makingCharge)}</td>
                          <td style={{ minWidth: "140px", textAlign: "left" }}>
                            {row.diamondBreakdown.length === 0 ? (
                              <span style={{ color: "#9ca3af", fontSize: "11px" }}>None</span>
                            ) : (
                              row.diamondBreakdown.map((d, i) => (
                                <div key={i} style={{ marginBottom: "2px" }}>
                                  <span className="preview-diamond-pill">
                                    {d.color}/{d.clarity} {Number(d.totalWeight).toFixed(2)}ct
                                    {d.ppc === 0 && " ⚠"}
                                  </span>
                                </div>
                              ))
                            )}
                          </td>
                          <td>
                            {row.missingDiamondRate ? (
                              <span className="preview-warning-badge">⚠ Rate Missing</span>
                            ) : fmtDec(row.diamondCost)}
                          </td>
                          <td style={{ color: "#374151" }}>{fmtDec(row.subtotal)}</td>
                          <td style={{ color: "#b45309" }}>{fmtDec(row.gst)}</td>
                          <td>
                            {row.finalPrice === 0 ? (
                              <span className="preview-warning-badge">⚠ ₹0 — Check Config</span>
                            ) : (
                              <span className="final-price-badge">₹{row.finalPrice.toLocaleString("en-IN")}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {pricePreviewData.some(r => r.missingRate || r.missingDiamondRate || r.finalPrice === 0) && (
                <div style={{ margin: "16px 24px", padding: "12px 16px", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: "8px", fontSize: "13px", color: "#78350f" }}>
                  ⚠️ <strong>Some variants show warnings.</strong> Possible reasons:
                  <ul style={{ marginTop: "6px", marginBottom: 0, paddingLeft: "20px" }}>
                    <li>Metal weight is 0 — enter a weight in the variants table.</li>
                    <li>No gold rate found for that purity — check Metal Rates settings.</li>
                    <li>Diamond color/clarity not found in Diamond Rates — add the rate first.</li>
                  </ul>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="modal-footer">
              <s-button onClick={() => setPricePreviewProduct(null)}>Close Preview</s-button>
              <s-button
                variant="primary"
                onClick={() => { setPricePreviewProduct(null); handleSaveProductSpecs(pricePreviewProduct); }}
                {...(isSubmitting ? { loading: true } : {})}
              >
                💾 Save Specs Now
              </s-button>
            </div>
          </div>
        </div>
      )}

      {(activeVariantForDiamonds || activeProductForBulkDiamonds) && (
        <div className="modal-overlay">
          <div className="modal-container">
            <div className="modal-header">
              <h3 className="modal-title">
                {activeProductForBulkDiamonds
                  ? `Configure Diamonds in Bulk for Product: ${activeProductForBulkDiamonds.title}`
                  : `Configure Diamonds for Variant: ${activeVariantForDiamonds?.title || activeVariantForDiamonds?.sku}`}
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => {
                  setActiveVariantForDiamonds(null);
                  setActiveProductForBulkDiamonds(null);
                }}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <table className="diamond-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Shape</th>
                    <th>Color</th>
                    <th>Clarity</th>
                    <th>Count</th>
                    <th>Total Carat (wt)</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {modalDiamonds.map((d, index) => (
                    <tr key={index}>
                      <td>
                        <select
                          className="diamond-input-select"
                          value={d.diamond_type || "Small Diamond"}
                          onChange={(e) => updateModalDiamondRow(index, "diamond_type", e.target.value)}
                        >
                          <option value="Solitaire">Solitaire</option>
                          <option value="Small Diamond">Small Diamond</option>
                          <option value="Accent Diamond">Accent Diamond</option>
                          <option value="Halo Diamond">Halo Diamond</option>
                          <option value="Side Diamond">Side Diamond</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="diamond-input-select"
                          value={d.shape || "Round"}
                          onChange={(e) => updateModalDiamondRow(index, "shape", e.target.value)}
                        >
                          <option value="Oval">Oval</option>
                          <option value="Round">Round</option>
                          <option value="Marquise">Marquise</option>
                          <option value="Princess">Princess</option>
                          <option value="Pear">Pear</option>
                          <option value="Emerald">Emerald</option>
                          <option value="Cushion">Cushion</option>
                        </select>
                      </td>
                      <td>
                        <select
                          className="diamond-input-select"
                          value={d.color || ""}
                          onChange={(e) => updateModalDiamondRow(index, "color", e.target.value)}
                        >
                          <option value="">-- Select Color --</option>
                          {uniqueColors.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                          {d.color && !uniqueColors.includes(d.color.toUpperCase()) && (
                            <option value={d.color}>
                              {d.color}
                            </option>
                          )}
                        </select>
                      </td>
                      <td>
                        <select
                          className="diamond-input-select"
                          value={d.clarity || ""}
                          onChange={(e) => updateModalDiamondRow(index, "clarity", e.target.value)}
                        >
                          <option value="">-- Select Clarity --</option>
                          {uniqueClarities.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                          {d.clarity && !uniqueClarities.includes(d.clarity.toUpperCase()) && (
                            <option value={d.clarity}>
                              {d.clarity}
                            </option>
                          )}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          className="diamond-input-select"
                          placeholder="Count"
                          value={d.count || 1}
                          onChange={(e) => updateModalDiamondRow(index, "count", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          className="diamond-input-select"
                          placeholder="0.000"
                          value={d.total_weight || 0}
                          onChange={(e) => updateModalDiamondRow(index, "total_weight", e.target.value)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-delete-row"
                          onClick={() => deleteModalDiamondRow(index)}
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                  {modalDiamonds.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: "16px", color: "#6d7175" }}>
                        No diamond configuration rows. Click Add Diamond to add one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <button
                type="button"
                className="btn-add-row"
                onClick={addModalDiamondRow}
              >
                ➕ Add Diamond Row
              </button>
            </div>
            <div className="modal-footer">
              <s-button
                onClick={() => {
                  setActiveVariantForDiamonds(null);
                  setActiveProductForBulkDiamonds(null);
                }}
              >
                Cancel
              </s-button>
              <s-button
                variant="primary"
                onClick={applyModalDiamonds}
              >
                Apply Configurations
              </s-button>
            </div>
          </div>
        </div>
      )}
    </s-page>
  );
}
