import { useLoaderData, useSubmit, useActionData, Form, useNavigation } from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import * as xlsx from "xlsx";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const diamondRates = await prisma.diamondRate.findMany({
    where: { shop },
    orderBy: [
      { color: "asc" },
      { clarity: "asc" },
      { size_min: "asc" }
    ],
    take: 100 // show first 100 entries
  });

  const totalCount = await prisma.diamondRate.count({
    where: { shop }
  });

  const serializedRates = diamondRates.map((rate) => ({
    ...rate,
    size_min: Number(rate.size_min),
    size_max: Number(rate.size_max),
    price_per_carat: Number(rate.price_per_carat),
  }));

  return { diamondRates: serializedRates, totalCount };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const formData = await request.formData();
    const file = formData.get("diamond_file");

    if (!file || !(file instanceof File) || file.size === 0) {
      return { success: false, error: "Please upload a valid Excel or CSV file." };
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Parse using SheetJS (which handles CSV and Excel files out of the box)
    const wb = xlsx.read(buffer, { type: "buffer" });
    const firstSheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[firstSheetName];
    
    // Parse sheet to JSON array
    const rawRows = xlsx.utils.sheet_to_json(sheet);
    
    if (rawRows.length === 0) {
      return { success: false, error: "The uploaded file is empty." };
    }

    // Clean keys: remove UTF-8 BOM, spaces, and make lowercase
    const cleanRows = rawRows.map(row => {
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        const cleanKey = key.replace(/^\uFEFF/, "").trim().toLowerCase();
        cleanRow[cleanKey] = row[key];
      });
      return cleanRow;
    });

    // Extract records mapping keys robustly
    const records = cleanRows.map(row => {
      const color = row.color || row.colour || row.col;
      const clarity = row.clarity || row.clar;
      const sizeVal = row.size || row.carat || row.wt || row['weight(ct)'] || row.weight || row.range;
      const price = row.price || row.rate || row.cost;

      const colorClean = color ? String(color).trim().toUpperCase() : "*";
      const clarityClean = clarity ? String(clarity).trim().toUpperCase() : "*";

      let min = 0.0;
      let max = 0.0;
      let hasExplicitRange = false;

      if (sizeVal !== undefined && sizeVal !== null && sizeVal !== "") {
        const str = String(sizeVal).trim();
        if (str.includes("-")) {
          const parts = str.split("-").map(p => parseFloat(p.trim()));
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            min = parts[0];
            max = parts[1];
            hasExplicitRange = true;
          }
        } else {
          const val = parseFloat(str);
          if (!isNaN(val)) {
            min = val;
            max = val;
          }
        }
      }

      return {
        color: colorClean,
        clarity: clarityClean,
        size: min,
        min,
        max,
        hasExplicitRange,
        price: price !== undefined ? Number(price) : NaN
      };
    }).filter(r => !isNaN(r.price));

    if (records.length === 0) {
      return { 
        success: false, 
        error: "Missing required columns or no valid records. Please ensure your file has Price and either Weight/Size or Color/Clarity columns." 
      };
    }

    // Sort unique sizes to build dynamic ranges (tiers) for records without explicit range
    const recordsWithoutExplicitRange = records.filter(r => !r.hasExplicitRange);
    if (recordsWithoutExplicitRange.length > 0) {
      const uniqueSizes = [...new Set(recordsWithoutExplicitRange.map(r => r.size))].sort((a, b) => a - b);
      const sizeRanges = {};
      for (let i = 0; i < uniqueSizes.length; i++) {
        const size = uniqueSizes[i];
        const minVal = i === 0 ? 0.000 : (uniqueSizes[i - 1] + size) / 2 + 0.001;
        const maxVal = i === uniqueSizes.length - 1 ? 99.999 : (size + uniqueSizes[i + 1]) / 2;
        sizeRanges[size] = { min: minVal, max: maxVal };
      }
      records.forEach(r => {
        if (!r.hasExplicitRange) {
          const range = sizeRanges[r.size];
          r.min = range.min;
          r.max = range.max;
        }
      });
    }

    // Delete old rates and bulk insert new rates
    await prisma.diamondRate.deleteMany({
      where: { shop }
    });

    const createData = records.map(r => {
      return {
        shop,
        color: r.color,
        clarity: r.clarity,
        size_min: r.min,
        size_max: r.max,
        price_per_carat: r.price
      };
    });

    await prisma.diamondRate.createMany({
      data: createData
    });

    return { 
      success: true, 
      message: `Successfully uploaded ${createData.length} diamond rate mappings!` 
    };

  } catch (err) {
    console.error("Diamond rates upload error:", err);
    return { success: false, error: `Failed to process file: ${err.message}` };
  }
};

export default function DiamondRates() {
  const { diamondRates, totalCount } = useLoaderData();
  const actionData = useActionData();
  const shopify = useAppBridge();
  const navigation = useNavigation();

  const isSaving = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.success) {
      shopify.toast.show(actionData.message);
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Diamond Pricing Matrix" inline-size="large">
      {/* Premium UI/UX styling for layout, table spacing, and cards */}
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
        .diamond-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
        }
        .diamond-table th {
          padding: 10px 8px;
          font-weight: 600;
          color: #202223;
          border-bottom: 2px solid #e1e3e5;
        }
        .diamond-table td {
          padding: 10px 8px;
          color: #4f5357;
          border-bottom: 1px solid #e1e3e5;
        }
        .diamond-table tr:hover td {
          background-color: #fafbfb;
        }
      `}</style>

      <div className="layout-grid">
        <div className="main-content">
          {/* List of current diamond rates */}
          <div className="form-card">
            <h2 className="form-card-title">💎 Diamond Rates Table ({totalCount} mappings total)</h2>
            {diamondRates.length === 0 ? (
              <p style={{ color: "#6d7175", margin: 0 }}>No diamond rates uploaded yet. Please upload your diamond rate sheet on the right.</p>
            ) : (
              <s-stack direction="block" gap="base">
                <table className="diamond-table">
                  <thead>
                    <tr>
                      <th>Weight Range (CT)</th>
                      <th>Color</th>
                      <th>Clarity</th>
                      <th>Price Per Carat (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diamondRates.map((rate) => (
                      <tr key={rate.id}>
                        <td>{rate.size_min.toFixed(3)} - {rate.size_max.toFixed(3)} ct</td>
                        <td>{rate.color}</td>
                        <td>{rate.clarity}</td>
                        <td><strong>₹{Number(rate.price_per_carat).toLocaleString()}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {totalCount > 100 && (
                  <p style={{ fontSize: "12px", color: "#6d7175", margin: "12px 0 0 0", fontStyle: "italic" }}>
                    Showing first 100 entries. Upload a new sheet to replace them.
                  </p>
                )}
              </s-stack>
            )}
          </div>
        </div>

        <div className="sidebar-content">
          {/* File Upload Section */}
          <div className="sidebar-card">
            <h3 className="sidebar-card-title">📤 Upload Diamond Rates Grid</h3>
            <p style={{ margin: "0 0 8px 0", fontSize: "13px", color: "#6d7175", lineHeight: "1.4" }}>
              Upload an Excel (.xlsx) or CSV file with your diamond pricing matrix.
            </p>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px", color: "#6d7175" }}>
              <strong>Required columns:</strong> <code>Color</code>, <code>Clarity</code>, and <code>Price</code> (<code>Size</code> is optional).
            </p>
            <p style={{ margin: "0 0 16px 0", fontSize: "13px" }}>
              <a 
                href="/sample-diamond-rates.csv" 
                download 
                style={{ 
                  color: "#008060", 
                  textDecoration: "none", 
                  fontWeight: "600",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px"
                }}
                onMouseOver={(e) => e.target.style.textDecoration = "underline"}
                onMouseOut={(e) => e.target.style.textDecoration = "none"}
              >
                📥 Download Sample CSV file
              </a>
            </p>
            <div style={{
              background: "#fff9e6",
              border: "1px solid #ffe399",
              borderRadius: "6px",
              padding: "12px",
              marginBottom: "16px",
              fontSize: "12px",
              color: "#8a6d3b",
              lineHeight: "1.5"
            }}>
              <strong>⚠️ Important:</strong> Uploading a new rate sheet will **permanently delete all existing diamond rates** for this store and replace them with the new CSV/Excel data. Please make sure the uploaded data is proper.
            </div>
            <Form method="post" encType="multipart/form-data">
              <s-stack direction="block" gap="base">
                <input 
                  type="file" 
                  name="diamond_file" 
                  accept=".xlsx, .xls, .csv" 
                  style={{
                    border: "1px solid #ccc",
                    padding: "8px",
                    borderRadius: "4px",
                    width: "100%",
                    fontSize: "13px",
                    background: "#ffffff",
                    boxSizing: "border-box"
                  }}
                  required
                />
                <s-button type="submit" {...(isSaving ? { loading: true } : {})}>
                  Upload & Update Matrix
                </s-button>
              </s-stack>
            </Form>
          </div>
        </div>
      </div>
    </s-page>
  );
}
