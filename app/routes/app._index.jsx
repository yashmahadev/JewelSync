import { useFetcher } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { syncProductVariantPrices } from "../pricing.server";

// Sample jewelry SKUs matching Glemzee.xlsx catalog
const SAMPLE_PRODUCTS = [
  {
    sku: "CAD-237",
    title: "Diamond Solitaire Engagement Ring - CAD-237",
    productType: "Ring",
    description: "Elegant diamond solitaire engagement ring available in multiple gold purities and ring sizes.",
    tags: ["ring", "diamond", "gold", "jewelry"],
  },
  {
    sku: "CAD-240",
    title: "Classic Gold Band Ring - CAD-240",
    productType: "Ring",
    description: "Classic gold band ring with diamond accents, crafted in premium gold purities.",
    tags: ["ring", "gold", "band", "jewelry"],
  },
  {
    sku: "CAD-243",
    title: "Diamond Halo Ring - CAD-243",
    productType: "Ring",
    description: "Stunning halo-style diamond ring, available in various purities and sizes.",
    tags: ["ring", "diamond", "halo", "jewelry"],
  },
  {
    sku: "CAD-246",
    title: "Twisted Band Diamond Ring - CAD-246",
    productType: "Ring",
    description: "Intricate twisted band design ring with diamond settings.",
    tags: ["ring", "diamond", "twisted", "jewelry"],
  },
  {
    sku: "CAD-248",
    title: "Eternity Diamond Ring - CAD-248",
    productType: "Ring",
    description: "Full eternity band with brilliant-cut diamonds set across the complete band.",
    tags: ["ring", "diamond", "eternity", "jewelry"],
  },
];

const GOLD_PURITIES = ["9K", "14K", "18K"];
const RING_SIZES = ["12", "14", "16", "18"];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch the first location to set inventory
  const locationRes = await admin.graphql(
    `#graphql
    query {
      locations(first: 1) {
        edges {
          node {
            id
          }
        }
      }
    }`
  );
  const locationData = await locationRes.json();
  const locationId = locationData.data?.locations?.edges[0]?.node?.id;

  const created = [];
  const failed = [];

  for (const product of SAMPLE_PRODUCTS) {
    // Build all combinations of (Purity, Ring Size) as variants
    const variantInputs = [];
    for (const purity of GOLD_PURITIES) {
      for (const size of RING_SIZES) {
         variantInputs.push({
          optionValues: [
            { optionName: "Gold Purity", name: purity },
            { optionName: "Ring Size", name: size },
          ],
          price: "10000.00",
          sku: `${product.sku}-${purity}-${size}`,
          inventoryQuantities: locationId ? [
            { locationId: locationId, name: "available", quantity: 1000 }
          ] : [],
        });
      }
    }

    try {
      const response = await admin.graphql(
        `#graphql
        mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
          productSet(input: $input, synchronous: $synchronous) {
            product {
              id
              title
              handle
              variants(first: 250) {
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
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            synchronous: true,
            input: {
              title: product.title,
              descriptionHtml: `<p>${product.description}</p>`,
              productType: product.productType,
              tags: product.tags,
              status: "ACTIVE",
              productOptions: [
                {
                  name: "Gold Purity",
                  values: GOLD_PURITIES.map((p) => ({ name: p })),
                },
                {
                  name: "Ring Size",
                  values: RING_SIZES.map((s) => ({ name: s })),
                },
              ],
              variants: variantInputs,
            },
          },
        }
      );

      const data = await response.json();
      const errors = data.data?.productSet?.userErrors || [];

      if (errors.length > 0) {
        failed.push({ sku: product.sku, error: errors[0].message });
        console.error(`Failed to create product ${product.sku}:`, errors);
      } else {
        const productData = data.data.productSet.product;
        created.push({
          sku: product.sku,
          title: product.title,
          id: productData.id,
          variantCount: productData.variants.edges.length,
        });

        // Add random purity, gold weight, diamond ct, color, clarity to VariantWeightConfig
        const variants = productData.variants.edges || [];
        for (const edge of variants) {
          const variant = edge.node;
          const variantId = variant.id;
          const variantSku = variant.sku;

          // Parse purity from SKU (format: CAD-XXX-PURITY-SIZE)
          let purity = "18K";
          for (const p of GOLD_PURITIES) {
            if (variantSku.includes(`-${p}-`)) {
              purity = p;
              break;
            }
          }

          // Generate random metal weight between 2.500g and 6.500g
          const metalWeight = parseFloat((2.5 + Math.random() * 4).toFixed(3));
          
          // Generate random diamond weight (carat) between 0.050 and 0.450
          const diamondCarat = parseFloat((0.05 + Math.random() * 0.4).toFixed(3));
          
          // Select random diamond color and clarity
          const colors = ["D", "E", "F", "G", "H", "I"];
          const clarities = ["VVS1", "VVS2", "VS1", "VS2", "SI1", "SI2"];
          const diamondColor = colors[Math.floor(Math.random() * colors.length)];
          const diamondClarity = clarities[Math.floor(Math.random() * clarities.length)];

          const dbConfig = await prisma.variantWeightConfig.upsert({
            where: { variant_id: variantId },
            update: {
              sku: variantSku,
              metal_type: "gold",
              purity: purity,
              metal_weight: metalWeight,
              diamond_color: diamondColor,
              diamond_clarity: diamondClarity,
              diamond_carat: diamondCarat,
            },
            create: {
              shop,
              variant_id: variantId,
              sku: variantSku,
              metal_type: "gold",
              purity: purity,
              metal_weight: metalWeight,
              diamond_color: diamondColor,
              diamond_clarity: diamondClarity,
              diamond_carat: diamondCarat,
            },
          });

          // Delete old diamonds if any
          await prisma.variantDiamondConfig.deleteMany({
            where: { variant_config_id: dbConfig.id }
          });

          // Create Row 1 (Solitaire/Main stone)
          const mainShape = product.sku === "CAD-237" ? "Oval" : "Round";
          const mainType = product.sku === "CAD-237" ? "Solitaire" : "Accent Diamond";
          
          await prisma.variantDiamondConfig.create({
            data: {
              variant_config_id: dbConfig.id,
              diamond_type: mainType,
              shape: mainShape,
              color: diamondColor,
              clarity: diamondClarity,
              count: 1,
              total_weight: diamondCarat,
            }
          });

          // Create Row 2 for specific product SKUs to demonstrate multiple diamond configs
          if (product.sku === "CAD-237" || product.sku === "CAD-243" || product.sku === "CAD-246") {
            const row2Weight = parseFloat((0.05 + Math.random() * 0.15).toFixed(3));
            const row2Count = Math.floor(Math.random() * 12) + 4;
            
            await prisma.variantDiamondConfig.create({
              data: {
                variant_config_id: dbConfig.id,
                diamond_type: "Small Diamond",
                shape: "Round",
                color: "EF",
                clarity: "VVS-VS",
                count: row2Count,
                total_weight: row2Weight,
              }
            });

            // Update the flat summary diamond carat on the parent configuration
            await prisma.variantWeightConfig.update({
              where: { id: dbConfig.id },
              data: {
                diamond_carat: diamondCarat + row2Weight
              }
            });
          }
        }

        console.log(`✅ Created product: ${product.title} with ${variantInputs.length} variants and random specifications`);
      }
    } catch (err) {
      console.error(`Error creating product ${product.sku}:`, err);
      failed.push({ sku: product.sku, error: err.message });
    }
  }

  // Automatically trigger recalculation & sync so that prices and variant metafields are synced instantly!
  if (created.length > 0) {
    try {
      console.log(`Automatically recalculating & syncing prices and metafields for newly created products...`);
      for (const p of created) {
        await syncProductVariantPrices(shop, p.id, admin.graphql);
      }
    } catch (syncErr) {
      console.error(`Automatic sync failed:`, syncErr);
    }
  }

  return { created, failed };
};

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isCreating =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const result = fetcher.data;

  useEffect(() => {
    if (result?.created?.length > 0) {
      shopify.toast.show(`✅ ${result.created.length} products created successfully!`);
    }
    if (result?.failed?.length > 0) {
      shopify.toast.show(`⚠️ ${result.failed.length} products failed to create`, { isError: true });
    }
  }, [result, shopify]);

  return (
    <s-page heading="Welcome to JewelSync 💎" inline-size="large">
      <style>{`
        s-page {
          --pc-page-max-width: 100% !important;
          max-width: 100% !important;
        }
        .home-grid {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: 24px;
          margin-top: 24px;
          align-items: start;
        }
        @media (max-width: 800px) {
          .home-grid {
            grid-template-columns: 1fr;
          }
        }
        .card {
          background: #ffffff;
          border: 1px solid #e1e3e5;
          border-radius: 8px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }
        .card-title {
          font-size: 16px;
          font-weight: 600;
          margin: 0 0 20px 0;
          color: #202223;
          border-bottom: 1px solid #f1f2f3;
          padding-bottom: 12px;
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
          margin: 0 0 12px 0;
          color: #202223;
          border-bottom: 1px solid #e1e3e5;
          padding-bottom: 8px;
        }
        .step {
          display: flex;
          gap: 16px;
          margin-bottom: 20px;
          padding-bottom: 20px;
          border-bottom: 1px solid #f1f2f3;
        }
        .step:last-child {
          border-bottom: none;
          margin-bottom: 0;
          padding-bottom: 0;
        }
        .step-number {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: #008060;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 14px;
          flex-shrink: 0;
        }
        .step-content h3 {
          margin: 0 0 6px 0;
          font-size: 14px;
          font-weight: 600;
          color: #202223;
        }
        .step-content p {
          margin: 0;
          font-size: 13px;
          color: #6d7175;
          line-height: 1.5;
        }
        .formula-box {
          background: #f6f6f7;
          border: 1px solid #e1e3e5;
          border-radius: 6px;
          padding: 16px;
          font-family: monospace;
          font-size: 12px;
          line-height: 1.6;
          color: #202223;
          white-space: pre-wrap;
        }
        .cta-row {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          margin-top: 20px;
        }
        .result-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          margin-top: 12px;
        }
        .result-table th {
          padding: 8px;
          text-align: left;
          font-weight: 600;
          background: #f6f6f7;
          border-bottom: 2px solid #e1e3e5;
        }
        .result-table td {
          padding: 8px;
          border-bottom: 1px solid #f1f2f3;
          color: #4f5357;
        }
        .badge-success {
          background: #d4edda;
          color: #155724;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }
        .badge-fail {
          background: #f8d7da;
          color: #721c24;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
        }
      `}</style>

      <div className="home-grid">
        <div>
          {/* Introduction */}
          <div className="card">
            <h2 className="card-title">🏠 What does this app do?</h2>
            <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#4f5357", lineHeight: "1.6" }}>
              <strong>JewelSync</strong> eliminates manual price updates for complex jewelry catalogs.
              When gold/silver rates change daily, you update the rate once — and the app automatically
              recalculates and syncs prices for every variant across all your products.
            </p>
            <div className="cta-row">
              <s-link href="/app/pricing-dashboard">
                <s-button variant="primary">Go to Pricing Dashboard →</s-button>
              </s-link>
              <s-link href="/app/diamond-rates">
                <s-button>Manage Diamond Rates →</s-button>
              </s-link>
            </div>
          </div>

          {/* Step by step guide */}
          <div className="card">
            <h2 className="card-title">📖 Step-by-Step Setup Guide</h2>
            <div className="step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>Set Daily Metal & Labour Rates</h3>
                <p>Navigate to <strong>Pricing Dashboard</strong> and input your current daily retail rates for Gold (9K, 14K, 18K, 22K), Silver, and making (labour) charges per gram. Click <strong>Save Rates Settings</strong>.</p>
              </div>
            </div>
            <div className="step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>Upload your Diamond Price Grid</h3>
                <p>Go to the <strong>Diamond Rates</strong> tab. Upload your wholesale diamond pricing sheet with columns: <code>Color, Clarity, Size, Price</code>. The app auto-generates carat range brackets.</p>
              </div>
            </div>
            <div className="step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>Configure Product Variant Specifications</h3>
                <p>In <strong>Pricing Dashboard → Configure Product Specifications</strong>, search for your jewelry products. Expand any product to enter the exact metal type, purity, metal weights, and diamond grades for each of its variants directly inside the grid.</p>
              </div>
            </div>
            <div className="step">
              <div className="step-number">4</div>
              <div className="step-content">
                <h3>Sync Shopify Prices in One Click</h3>
                <p>Click <strong>Recalculate & Sync Shopify Prices</strong>. The engine calculates every variant's price using the formula below and updates them live on your Shopify store!</p>
              </div>
            </div>
          </div>
        </div>

        <div>
          {/* Formula */}
          <div className="card">
            <h2 className="card-title">🧮 Pricing Formula</h2>
            <div className="formula-box">{`Final Price =
  Metal Cost
  + Making Charges
  + Diamond Cost
  + GST (3%)

Metal Cost:
  Gold Weight × Gold Rate/g

Making Charges:
  Metal Weight × Charge/g

Diamond Cost:
  Carat Wt × Price/Carat
  (from Diamond Grid lookup)`}</div>
          </div>

          {/* Test Data Generator */}
          <div className="sidebar-card">
            <h3 className="sidebar-card-title">🧪 Create Test Products</h3>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#6d7175", lineHeight: "1.5" }}>
              Click below to generate <strong>5 sample jewelry ring products</strong> with realistic SKUs (<code>CAD-237</code> to <code>CAD-248</code>) and full variant combinations:
              <br /><br />
              <strong>3 Gold Purities</strong> (9K, 14K, 18K) ×<br />
              <strong>4 Ring Sizes</strong> (12, 14, 16, 18)<br />
              = <strong>12 variants per product</strong>
            </p>
            <fetcher.Form method="post">
              <s-button
                type="submit"
                variant="primary"
                {...(isCreating ? { loading: true } : {})}
              >
                {isCreating ? "Creating products..." : "Create 5 Test Products"}
              </s-button>
            </fetcher.Form>

            {/* Results */}
            {result && (
              <div style={{ marginTop: "16px" }}>
                {result.created?.length > 0 && (
                  <>
                    <p style={{ margin: "0 0 8px 0", fontSize: "13px", fontWeight: 600, color: "#155724" }}>
                      ✅ {result.created.length} Products Created:
                    </p>
                    <table className="result-table">
                      <thead>
                        <tr>
                          <th>SKU</th>
                          <th>Variants</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.created.map((p) => (
                          <tr key={p.sku}>
                            <td><code>{p.sku}</code></td>
                            <td><span className="badge-success">{p.variantCount} variants</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
                {result.failed?.length > 0 && (
                  <div style={{ marginTop: "12px" }}>
                    <p style={{ margin: "0 0 8px 0", fontSize: "13px", fontWeight: 600, color: "#721c24" }}>
                      ⚠️ {result.failed.length} Products Failed:
                    </p>
                    {result.failed.map((f) => (
                      <p key={f.sku} style={{ fontSize: "12px", margin: "4px 0", color: "#721c24" }}>
                        <code>{f.sku}</code>: {f.error}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </s-page>
  );
}
