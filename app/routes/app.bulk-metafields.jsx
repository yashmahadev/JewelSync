import { useLoaderData, useSubmit, useActionData, Form, useNavigation } from "react-router";
import { useState, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { createAuditLog, updateAuditLog } from "../audit.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const searchQ = url.searchParams.get("q") || "";
  const selectedProductId = url.searchParams.get("productId") || "";

  // 1. Fetch active products list for the selector
  let shopifyQuery = "status:active";
  if (searchQ) {
    shopifyQuery += ` AND title:*${searchQ}*`;
  }

  let productsList = [];
  try {
    const productsRes = await admin.graphql(
      `#graphql
      query getProductsList($query: String!) {
        products(first: 50, query: $query) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }`,
      { variables: { query: shopifyQuery } }
    );
    const productsJson = await productsRes.json();
    productsList = productsJson.data?.products?.edges?.map((e) => e.node) || [];
  } catch (err) {
    console.error("Error fetching products list:", err);
  }

  // 2. Fetch metafield definitions on Store
  let productDefinitions = [];
  let variantDefinitions = [];
  try {
    const defsRes = await admin.graphql(
      `#graphql
      query getMetafieldDefinitions {
        productDefinitions: metafieldDefinitions(first: 100, ownerType: PRODUCT) {
          edges {
            node {
              name
              namespace
              key
              type {
                name
              }
            }
          }
        }
        variantDefinitions: metafieldDefinitions(first: 100, ownerType: PRODUCTVARIANT) {
          edges {
            node {
              name
              namespace
              key
              type {
                name
              }
            }
          }
        }
      }`
    );
    const defsJson = await defsRes.json();
    productDefinitions = defsJson.data?.productDefinitions?.edges?.map((e) => e.node) || [];
    variantDefinitions = defsJson.data?.variantDefinitions?.edges?.map((e) => e.node) || [];
  } catch (err) {
    console.error("Error fetching metafield definitions:", err);
  }

  // 3. Fetch detailed metafield values if product selected
  let selectedProduct = null;
  if (selectedProductId) {
    try {
      const productDetailsRes = await admin.graphql(
        `#graphql
        query getProductMetafields($productId: ID!) {
          product(id: $productId) {
            id
            title
            metafields(first: 100) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
            variants(first: 250) {
              edges {
                node {
                  id
                  title
                  sku
                  metafields(first: 100) {
                    edges {
                      node {
                        id
                        namespace
                        key
                        value
                        type
                      }
                    }
                  }
                }
              }
            }
          }
        }`,
        { variables: { productId: selectedProductId } }
      );
      const productDetailsJson = await productDetailsRes.json();
      selectedProduct = productDetailsJson.data?.product || null;
    } catch (err) {
      console.error("Error fetching product details:", err);
    }
  }

  return {
    shop,
    productsList,
    productDefinitions,
    variantDefinitions,
    selectedProduct,
    searchQ,
    selectedProductId,
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "save_metafields") {
    const updatesJson = formData.get("updates");
    const logId = await createAuditLog(shop, "foreground_job", "bulkMetafieldsSave", updatesJson ? JSON.parse(updatesJson) : {});

    try {
      if (!updatesJson) {
        await updateAuditLog(logId, "failed", { error: "Missing metafields updates payload" });
        return { success: false, error: "Missing metafields updates payload" };
      }

      const updates = JSON.parse(updatesJson); // array of { ownerId, namespace, key, value, type }
      if (updates.length === 0) {
        await updateAuditLog(logId, "success", { message: "No changes to save" });
        return { success: true, message: "No changes to save!" };
      }

      // Chunk updates to avoid payload size or query complexity limits
      const chunkSize = 25;
      const errors = [];

      for (let i = 0; i < updates.length; i += chunkSize) {
        const chunk = updates.slice(i, i + chunkSize);
        
        const response = await admin.graphql(
          `#graphql
          mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
                namespace
                key
                value
              }
              userErrors {
                field
                message
              }
            }
          }`,
          { variables: { metafields: chunk } }
        );

        const resJson = await response.json();
        const userErrors = resJson.data?.metafieldsSet?.userErrors || [];
        if (userErrors.length > 0) {
          errors.push(...userErrors);
        }
      }

      if (errors.length > 0) {
        console.error("Errors setting metafields:", errors);
        const errMsg = `Saved with errors: ${errors.map(e => `${e.field.join(".")}: ${e.message}`).join("; ")}`;
        await updateAuditLog(logId, "failed", { error: errMsg, userErrors: errors });
        return { 
          success: false, 
          error: errMsg
        };
      }

      await updateAuditLog(logId, "success", { message: "Metafields updated successfully on Shopify!", count: updates.length });
      return { success: true, message: "Metafields updated successfully on Shopify!" };
    } catch (err) {
      console.error("Action error:", err);
      await updateAuditLog(logId, "failed", { error: err.message });
      return { success: false, error: err.message };
    }
  }

  return null;
};

export default function BulkMetafields() {
  const {
    productsList,
    productDefinitions,
    variantDefinitions,
    selectedProduct,
    searchQ,
    selectedProductId,
  } = useLoaderData();

  const actionData = useActionData();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting" && navigation.formData?.get("actionType") === "save_metafields";

  const [searchVal, setSearchVal] = useState(searchQ);
  const [localMetafields, setLocalMetafields] = useState({}); // maps ownerId -> { [namespace_key]: value }

  // Reset local changes when selected product changes
  useEffect(() => {
    setLocalMetafields({});
  }, [selectedProductId]);

  // Show status toasts
  useEffect(() => {
    if (actionData) {
      if (actionData.success) {
        shopify.toast.show(actionData.message || "Saved successfully!");
        setLocalMetafields({}); // Clear dirty local changes after save
      } else if (actionData.error) {
        shopify.toast.show(actionData.error, { isError: true });
      }
    }
  }, [actionData, shopify]);

  // Helper to extract value
  const getMetafieldValue = (owner, namespace, key) => {
    const ownerId = owner.id;
    const nsKey = `${namespace}.${key}`;
    
    // Check local changes first
    if (localMetafields[ownerId]?.[nsKey] !== undefined) {
      return localMetafields[ownerId][nsKey];
    }
    
    // Fallback to Shopify saved value
    const edges = owner.metafields?.edges || [];
    const found = edges.find((e) => e.node.namespace === namespace && e.node.key === key);
    return found ? found.node.value : "";
  };

  const handleValueChange = (ownerId, namespace, key, value) => {
    const nsKey = `${namespace}.${key}`;
    setLocalMetafields((prev) => ({
      ...prev,
      [ownerId]: {
        ...(prev[ownerId] || {}),
        [nsKey]: value,
      },
    }));
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    submit({ q: searchVal, productId: selectedProductId }, { method: "GET", replace: true });
  };

  const handleProductSelectChange = (e) => {
    const pId = e.target.value;
    submit({ q: searchVal, productId: pId }, { method: "GET", replace: true });
  };

  // Check if a metafield key belongs to our autocalculated pricing engine keys
  const isAutocalculated = (key) => {
    const pricingKeys = [
      "total_price", "gst", "making_charges", "diamond_price", "gold_price", 
      "gold_weight", "diamond_weight", "total_weight", "gold_title", "diamond_title", 
      "variant_info", "gold_label", "diamond_label", "making_label", "gst_label",
      "making_discount", "diamond_discount",
      "original_making_charges", "original_diamond_price",
      "diamond_details", "diamond_row_1_type", "diamond_row_1_shape", "diamond_row_1_count", "diamond_row_1_total_wt",
      "diamond_row_2_type", "diamond_row_2_shape", "diamond_row_2_count", "diamond_row_2_total_wt",
      "diamond_row_3_type", "diamond_row_3_shape", "diamond_row_3_count", "diamond_row_3_total_wt"
    ];
    return pricingKeys.includes(key);
  };

  const handleSave = () => {
    const updates = [];
    
    // Process local modifications
    Object.keys(localMetafields).forEach((ownerId) => {
      const ownerChanges = localMetafields[ownerId];
      
      // Determine if product or variant
      let ownerObject = null;
      let definitions = [];
      
      if (selectedProduct && selectedProduct.id === ownerId) {
        ownerObject = selectedProduct;
        definitions = productDefinitions;
      } else if (selectedProduct) {
        const foundVariant = selectedProduct.variants.edges.find((e) => e.node.id === ownerId);
        if (foundVariant) {
          ownerObject = foundVariant.node;
          definitions = variantDefinitions;
        }
      }
      
      if (!ownerObject) return;

      Object.keys(ownerChanges).forEach((nsKey) => {
        const [namespace, key] = nsKey.split(".");
        const value = ownerChanges[nsKey];
        
        // Find definition to know the type
        const def = definitions.find((d) => d.namespace === namespace && d.key === key);
        const type = def ? def.type.name : "single_line_text_field";
        
        updates.push({
          ownerId,
          namespace,
          key,
          value,
          type,
        });
      });
    });

    submit(
      {
        actionType: "save_metafields",
        updates: JSON.stringify(updates),
      },
      { method: "POST" }
    );
  };

  // Has dirty local changes?
  const hasChanges = Object.keys(localMetafields).some(
    (ownerId) => Object.keys(localMetafields[ownerId]).length > 0
  );

  return (
    <s-page heading="Bulk Metafields Editor" inline-size="large">
      {hasChanges && (
        <s-button
          slot="primary-action"
          onClick={handleSave}
          disabled={isSaving ? true : undefined}
          variant="primary"
          {...(isSaving ? { loading: true } : {})}
        >
          Save Metafield Updates
        </s-button>
      )}

      <style>{`
        s-page {
          --pc-page-max-width: 100% !important;
          max-width: 100% !important;
        }
        body {
          background-color: #f6f6f7;
          color: #202223;
        }
        .form-card {
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(0, 0, 0, 0.08);
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03);
        }
        .form-card-title {
          font-size: 16px;
          font-weight: 600;
          color: #202223;
          margin-top: 0;
          margin-bottom: 16px;
          border-bottom: 1px solid #e1e3e5;
          padding-bottom: 12px;
        }
        .grid-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 20px;
          margin-bottom: 20px;
        }
        .search-input {
          padding: 8px 12px;
          border: 1px solid #c4cdd5;
          border-radius: 5px;
          font-size: 14px;
          width: 100%;
        }
        .select-input {
          padding: 8px 12px;
          border: 1px solid #c4cdd5;
          border-radius: 5px;
          font-size: 14px;
          width: 100%;
          background: white;
          color: #202223;
          height: 38px;
        }
        .field-label {
          font-size: 12px;
          font-weight: 500;
          color: #6d7175;
          margin-bottom: 6px;
          display: block;
        }
        .warning-banner {
          background-color: #fff4e5;
          border-left: 4px solid #ff9800;
          color: #663c00;
          padding: 12px;
          margin-bottom: 20px;
          border-radius: 0 6px 6px 0;
          font-size: 13px;
        }
        .warning-text {
          font-weight: 600;
        }
        .metafield-row {
          display: flex;
          gap: 16px;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid #f1f2f4;
        }
        .metafield-info {
          flex: 1;
        }
        .metafield-name {
          font-size: 14px;
          font-weight: 600;
          color: #202223;
        }
        .metafield-key {
          font-size: 12px;
          color: #6d7175;
          font-family: monospace;
        }
        .metafield-input-container {
          flex: 2;
        }
        .metafield-input {
          padding: 8px 12px;
          border: 1px solid #c4cdd5;
          border-radius: 5px;
          font-size: 14px;
          width: 100%;
        }
        .metafield-input.autocalc {
          background-color: #f1f2f4;
          cursor: not-allowed;
          border-color: #e1e3e5;
          color: #6d7175;
        }
        .badge-calc {
          background-color: #e2f1e8;
          color: #108043;
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          font-weight: 600;
          margin-left: 8px;
        }
        .spec-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 12px;
        }
        .spec-table th {
          background: #f1f2f4;
          padding: 10px 12px;
          text-align: left;
          font-size: 12px;
          font-weight: 600;
          color: #6d7175;
          border-bottom: 2px solid #e1e3e5;
        }
        .spec-table td {
          padding: 12px;
          border-bottom: 1px solid #e1e3e5;
          font-size: 13px;
        }
        .badge-opt {
          background: #e4e6e7;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          color: #202223;
          font-weight: 500;
        }
        .dirty-input {
          border-color: #008060 !important;
          box-shadow: 0 0 0 1px #008060;
        }
      `}</style>

      <div className="form-card">
        <h2 className="form-card-title">🔍 Select Product to Edit Metafields</h2>
        <div className="grid-layout">
          <div>
            <label className="field-label">Search Shopify Products</label>
            <form onSubmit={handleSearchSubmit} style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                className="search-input"
                placeholder="Type product title..."
                value={searchVal}
                onChange={(e) => setSearchVal(e.target.value)}
              />
              <s-button type="submit">Filter</s-button>
            </form>
          </div>
          <div>
            <label className="field-label">Select Active Product</label>
            <select
              className="select-input"
              value={selectedProductId}
              onChange={handleProductSelectChange}
            >
              <option value="">-- Select a product --</option>
              {productsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {selectedProduct ? (
        <>
          <div className="warning-banner">
            <span className="warning-text">⚠️ Autocalculation Warning:</span> Metafields marked with <span className="badge-calc">Autocalc</span> are managed dynamically by the pricing engine. Manually editing these values will cause them to be overwritten on the next pricing sync or webhook save. Use the Pricing Dashboard instead for specifications.
          </div>

          {/* Product Level Metafields */}
          <div className="form-card">
            <h2 className="form-card-title">📦 Product-Level Metafields: {selectedProduct.title}</h2>
            {productDefinitions.length > 0 ? (
              productDefinitions.map((def) => {
                const isCalc = isAutocalculated(def.key);
                const val = getMetafieldValue(selectedProduct, def.namespace, def.key);
                const isDirty = localMetafields[selectedProduct.id]?.[`${def.namespace}.${def.key}`] !== undefined;
                return (
                  <div className="metafield-row" key={`${def.namespace}.${def.key}`}>
                    <div className="metafield-info">
                      <div className="metafield-name">
                        {def.name}
                        {isCalc && <span className="badge-calc">Autocalc</span>}
                      </div>
                      <div className="metafield-key">
                        {def.namespace}.{def.key} ({def.type.name})
                      </div>
                    </div>
                    <div className="metafield-input-container">
                      <input
                        type="text"
                        disabled={isCalc ? true : undefined}
                        className={`metafield-input ${isCalc ? "autocalc" : ""} ${isDirty ? "dirty-input" : ""}`}
                        value={val}
                        onChange={(e) => handleValueChange(selectedProduct.id, def.namespace, def.key, e.target.value)}
                        placeholder="Empty"
                      />
                    </div>
                  </div>
                );
              })
            ) : (
              <p style={{ color: "#6d7175", fontSize: "14px" }}>No product-level metafield definitions configured in your store.</p>
            )}
          </div>

          {/* Variant Level Metafields */}
          <div className="form-card" style={{ overflowX: "auto" }}>
            <h2 className="form-card-title">💎 Variant-Level Metafields</h2>
            {variantDefinitions.length > 0 ? (
              <table className="spec-table">
                <thead>
                  <tr>
                    <th style={{ width: "20%" }}>Variant Option / SKU</th>
                    {variantDefinitions.map((def) => (
                      <th key={`${def.namespace}.${def.key}`} style={{ minWidth: "180px" }}>
                        <div>{def.name}</div>
                        <div style={{ fontSize: "10px", fontWeight: "normal", color: "#6d7175", fontFamily: "monospace" }}>
                          {def.namespace}.{def.key}
                          {isAutocalculated(def.key) && <span className="badge-calc">Autocalc</span>}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedProduct.variants?.edges?.map((edge) => {
                    const v = edge.node;
                    return (
                      <tr key={v.id}>
                        <td>
                          <div style={{ fontWeight: "600" }}>{v.title}</div>
                          {v.sku && <div style={{ fontSize: "11px", color: "#6d7175" }}>SKU: {v.sku}</div>}
                        </td>
                        {variantDefinitions.map((def) => {
                          const isCalc = isAutocalculated(def.key);
                          const val = getMetafieldValue(v, def.namespace, def.key);
                          const isDirty = localMetafields[v.id]?.[`${def.namespace}.${def.key}`] !== undefined;
                          return (
                            <td key={`${def.namespace}.${def.key}`}>
                              <input
                                type="text"
                                disabled={isCalc ? true : undefined}
                                className={`metafield-input ${isCalc ? "autocalc" : ""} ${isDirty ? "dirty-input" : ""}`}
                                value={val}
                                onChange={(e) => handleValueChange(v.id, def.namespace, def.key, e.target.value)}
                                placeholder="Empty"
                                style={{ fontSize: "12px", padding: "6px 10px" }}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p style={{ color: "#6d7175", fontSize: "14px" }}>No variant-level metafield definitions configured in your store.</p>
            )}
          </div>
        </>
      ) : (
        selectedProductId && (
          <div className="form-card" style={{ textAlign: "center", color: "#6d7175", padding: "40px" }}>
            Loading selected product details and metafield values...
          </div>
        )
      )}
    </s-page>
  );
}
