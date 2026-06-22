import { useLoaderData, useSubmit, useActionData, Form, useNavigation } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
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
              variants(first: 50) {
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

  // 4. Fetch existing database configurations for the returned variants
  const variantIds = products.flatMap((p) => p.variants.edges.map((v) => v.node.id));

  const savedConfigs = await prisma.variantWeightConfig.findMany({
    where: {
      variant_id: { in: variantIds },
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
    silver_rate: Number(config.silver_rate),
    making_charge_gold: Number(config.making_charge_gold),
    making_charge_silver: Number(config.making_charge_silver),
    gst_percentage: Number(config.gst_percentage),
  };

  const serializedConfigsMap = {};
  savedConfigs.forEach((c) => {
    serializedConfigsMap[c.variant_id] = {
      metal_type: c.metal_type,
      purity: c.purity,
      metal_weight: Number(c.metal_weight),
      diamond_color: c.diamond_color || "",
      diamond_clarity: c.diamond_clarity || "",
      diamond_carat: Number(c.diamond_carat),
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

          await prisma.variantWeightConfig.upsert({
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

          serializedConfigsMap[v.id] = {
            metal_type: metalType,
            purity: purity,
            metal_weight: weight,
            diamond_color: dColor,
            diamond_clarity: dClarity,
            diamond_carat: dCarat,
          };
        }
      }
    }
  }

  const latestJob = await prisma.syncJob.findFirst({
    where: { shop },
    orderBy: { created_at: "desc" },
  });

  return {
    config: serializedConfig,
    variantCount,
    products,
    savedConfigsMap: serializedConfigsMap,
    searchQ,
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
    const silver = Number(formData.get("silver"));
    const making_gold = Number(formData.get("making_gold"));
    const making_silver = Number(formData.get("making_silver"));
    const gst = Number(formData.get("gst"));

    await prisma.storeConfig.update({
      where: { shop },
      data: {
        gold_rate_9k: gold_9k,
        gold_rate_14k: gold_14k,
        gold_rate_18k: gold_18k,
        gold_rate_22k: gold_22k,
        silver_rate: silver,
        making_charge_gold: making_gold,
        making_charge_silver: making_silver,
        gst_percentage: gst,
      },
    });

    return { success: true, message: "Settings saved successfully!" };
  }

  if (actionType === "save_variant_specs") {
    try {
      const specsJson = formData.get("specs");
      const productId = formData.get("productId");
      if (!specsJson) return { success: false, error: "Missing specifications payload" };

      const specs = JSON.parse(specsJson);

      for (const spec of specs) {
        await prisma.variantWeightConfig.upsert({
          where: { variant_id: spec.variantId },
          update: {
            sku: spec.sku || "",
            metal_type: spec.metalType,
            purity: spec.purity,
            metal_weight: Number(spec.weight || 0),
            diamond_color: spec.dColor || null,
            diamond_clarity: spec.dClarity || null,
            diamond_carat: Number(spec.dCarat || 0),
          },
          create: {
            shop,
            variant_id: spec.variantId,
            sku: spec.sku || "",
            metal_type: spec.metalType,
            purity: spec.purity,
            metal_weight: Number(spec.weight || 0),
            diamond_color: spec.dColor || null,
            diamond_clarity: spec.dClarity || null,
            diamond_carat: Number(spec.dCarat || 0),
          },
        });
      }

      if (productId) {
        await syncProductVariantPrices(shop, productId, admin.graphql);
      }

      return { success: true, message: "Variant specifications saved and synced successfully!", actionType: "save_variant_specs" };
    } catch (err) {
      console.error("Save specs error:", err);
      return { success: false, error: `Failed to save specs: ${err.message}` };
    }
  }

  if (actionType === "sync_prices") {
    try {
      const activeJob = await prisma.syncJob.findFirst({
        where: {
          shop,
          status: { in: ["pending", "running"] },
        },
      });

      if (activeJob) {
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

      return {
        success: true,
        message: "Background price recalculation and sync started!",
      };
    } catch (err) {
      console.error("Price sync error:", err);
      return { success: false, error: `Sync failed: ${err.message}` };
    }
  }

  return null;
};

export default function PricingDashboard() {
  const { config, variantCount, products, savedConfigsMap, searchQ, latestJob } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const navigation = useNavigation();

  // Local state for daily settings
  const [gold9k, setGold9k] = useState(config.gold_rate_9k);
  const [gold14k, setGold14k] = useState(config.gold_rate_14k);
  const [gold18k, setGold18k] = useState(config.gold_rate_18k);
  const [gold22k, setGold22k] = useState(config.gold_rate_22k);
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

  const isSubmitting = navigation.state === "submitting";
  const isSyncActive = latestJob && (latestJob.status === "pending" || latestJob.status === "running");

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show(actionData.message);
      if (actionData.actionType === "save_variant_specs") {
        setLocalSpecs({});
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
        }),
        [field]: value,
      },
    }));
  };

  const handleBulkApply = (product, w, c, col, cla) => {
    const newLocalSpecs = { ...localSpecs };
    const variants = product.variants.edges || [];

    variants.forEach((edge) => {
      const v = edge.node;
      const vId = v.id;

      const existing = newLocalSpecs[vId] || savedConfigsMap[vId] || {};

      newLocalSpecs[vId] = {
        ...existing,
        metal_type: existing.metal_type || getSmartMetalTypeFallback(v),
        purity: existing.purity || getSmartPurityFallback(v),
        metal_weight: w !== "" ? Number(w) : (existing.metal_weight || 0),
        diamond_carat: c !== "" ? Number(c) : (existing.diamond_carat || 0),
        diamond_color: col !== "" ? col : (existing.diamond_color || ""),
        diamond_clarity: cla !== "" ? cla : (existing.diamond_clarity || ""),
      };
    });

    setLocalSpecs(newLocalSpecs);
    shopify.toast.show("Applied specifications to all variants locally! Click 'Save Specs' to save to the database.");
  };

  const handleSaveRates = () => {
    submit(
      {
        actionType: "save_rates",
        gold_9k: gold9k,
        gold_14k: gold14k,
        gold_18k: gold18k,
        gold_22k: gold22k,
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

  const handleSaveProductSpecs = (product) => {
    const payload = product.variants.edges.map((edge) => {
      const v = edge.node;
      return {
        variantId: v.id,
        sku: v.sku || "",
        metalType: getVariantField(v, "metal_type", "gold"),
        purity: getVariantField(v, "purity", "18K"),
        weight: Number(getVariantField(v, "metal_weight", 0)),
        dColor: getVariantField(v, "diamond_color", ""),
        dClarity: getVariantField(v, "diamond_clarity", ""),
        dCarat: Number(getVariantField(v, "diamond_carat", 0)),
      };
    });

    submit(
      {
        actionType: "save_variant_specs",
        productId: product.id,
        specs: JSON.stringify(payload),
      },
      { method: "POST" }
    );
  };
  return (
    <s-page heading="Jewelry Pricing & Inventory Dashboard">
      <s-button
        slot="primary-action"
        onClick={handleSync}
        disabled={isSyncActive ? true : undefined}
        {...(isSubmitting ? { loading: true } : {})}
      >
        {isSyncActive ? "Syncing in Background..." : "Recalculate & Sync Shopify Prices"}
      </s-button>

      <style>{`
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
            <span style={{ fontSize: "12px", color: "#6d7175" }}>
              {latestJob.status === "completed" && `Completed: ${new Date(latestJob.updated_at).toLocaleString()}`}
              {latestJob.status === "failed" && `Failed: ${new Date(latestJob.updated_at).toLocaleString()}`}
              {(latestJob.status === "running" || latestJob.status === "pending") && `Started: ${new Date(latestJob.created_at).toLocaleTimeString()}`}
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
            <div className="form-group" style={{ maxWidth: "50%", marginTop: "16px" }}>
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
                            <div style={{ flex: "1 1 120px" }}>
                              <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px" }}>Metal Weight (g)</label>
                              <input
                                id={`bulk-w-${product.id}`}
                                type="number"
                                step="0.001"
                                placeholder="e.g. 3.5"
                                className="cell-input"
                              />
                            </div>
                            <div style={{ flex: "1 1 120px" }}>
                              <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px" }}>Diamond Carat (ct)</label>
                              <input
                                id={`bulk-c-${product.id}`}
                                type="number"
                                step="0.001"
                                placeholder="e.g. 0.15"
                                className="cell-input"
                              />
                            </div>
                            <div style={{ flex: "1 1 80px" }}>
                              <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px" }}>Color</label>
                              <input
                                id={`bulk-col-${product.id}`}
                                type="text"
                                placeholder="e.g. G"
                                className="cell-input"
                              />
                            </div>
                            <div style={{ flex: "1 1 80px" }}>
                              <label style={{ fontSize: "11px", color: "#6d7175", display: "block", marginBottom: "4px" }}>Clarity</label>
                              <input
                                id={`bulk-cla-${product.id}`}
                                type="text"
                                placeholder="e.g. VS1"
                                className="cell-input"
                              />
                            </div>
                            <s-button
                              onClick={() => {
                                const w = document.getElementById(`bulk-w-${product.id}`)?.value || "";
                                const c = document.getElementById(`bulk-c-${product.id}`)?.value || "";
                                const col = document.getElementById(`bulk-col-${product.id}`)?.value || "";
                                const cla = document.getElementById(`bulk-cla-${product.id}`)?.value || "";
                                handleBulkApply(product, w, c, col, cla);
                              }}
                            >
                              Apply to All
                            </s-button>
                          </div>

                          <table className="spec-table">
                            <thead>
                              <tr>
                                <th style={{ width: "15%" }}>Variant Options</th>
                                <th style={{ width: "15%" }}>SKU</th>
                                <th style={{ width: "14%" }}>Metal Type</th>
                                <th style={{ width: "14%" }}>Purity</th>
                                <th style={{ width: "14%" }}>Weight (g)</th>
                                <th style={{ width: "14%" }}>Diamond Ct</th>
                                <th style={{ width: "7%" }}>Color</th>
                                <th style={{ width: "7%" }}>Clarity</th>
                              </tr>
                            </thead>
                            <tbody>
                              {variants.map((edge) => {
                                const v = edge.node;
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
                                        <option value="Silver">Silver</option>
                                      </select>
                                    </td>
                                    <td>
                                      <input
                                        type="number"
                                        step="0.001"
                                        className="cell-input"
                                        placeholder="0.000"
                                        value={getVariantField(v, "metal_weight", 0)}
                                        onChange={(e) => handleFieldChange(v, "metal_weight", e.target.value)}
                                      />
                                    </td>
                                    <td>
                                      <input
                                        type="number"
                                        step="0.001"
                                        className="cell-input"
                                        placeholder="0.000"
                                        value={getVariantField(v, "diamond_carat", 0)}
                                        onChange={(e) => handleFieldChange(v, "diamond_carat", e.target.value)}
                                      />
                                    </td>
                                    <td>
                                      <input
                                        type="text"
                                        className="cell-input"
                                        placeholder="Color"
                                        value={getVariantField(v, "diamond_color", "")}
                                        onChange={(e) => handleFieldChange(v, "diamond_color", e.target.value)}
                                      />
                                    </td>
                                    <td>
                                      <input
                                        type="text"
                                        className="cell-input"
                                        placeholder="Clarity"
                                        value={getVariantField(v, "diamond_clarity", "")}
                                        onChange={(e) => handleFieldChange(v, "diamond_clarity", e.target.value)}
                                      />
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
                              Save Specs for this Product
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
    </s-page>
  );
}
