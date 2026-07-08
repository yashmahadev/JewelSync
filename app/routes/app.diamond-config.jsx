import { useLoaderData, useSubmit, useActionData, useNavigation } from "react-router";
import { useState, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let dynamicShapes = await prisma.dynamicDiamondShape.findMany({
    where: { shop },
    orderBy: { name: "asc" }
  });

  if (dynamicShapes.length === 0) {
    const defaultShapes = [
      "Asscher", "Baguette", "Briolette", "Bullets", "Calf", "Cushion",
      "Cushion Brilliant", "Cushion Modified", "Emerald", "European Cut",
      "Flanders", "Half Moon", "Heart", "Hexagonal", "Kite", "Lozenge",
      "Marquise", "Octagonal", "Old Miner", "Oval", "Pear", "Pears",
      "Pentagonal", "Polki", "Princess", "Radiant", "Rose", "Round",
      "Shield", "Single Cut", "Square", "Square Emerald", "Square Radiant",
      "Star", "Tabered Baguette", "Tapered Bullet", "Trapezoid", "Triangle",
      "Trilliant", "Other"
    ];
    await prisma.dynamicDiamondShape.createMany({
      data: defaultShapes.map(name => ({ shop, name })),
      skipDuplicates: true
    });
    dynamicShapes = await prisma.dynamicDiamondShape.findMany({
      where: { shop },
      orderBy: { name: "asc" }
    });
  }

  let dynamicTypes = await prisma.dynamicDiamondType.findMany({
    where: { shop },
    orderBy: { name: "asc" }
  });

  if (dynamicTypes.length === 0) {
    const defaultTypes = [
      "Solitaire", "Small Diamond", "Accent Diamond", "Halo Diamond", "Side Diamond"
    ];
    await prisma.dynamicDiamondType.createMany({
      data: defaultTypes.map(name => ({ shop, name })),
      skipDuplicates: true
    });
    dynamicTypes = await prisma.dynamicDiamondType.findMany({
      where: { shop },
      orderBy: { name: "asc" }
    });
  }

  return {
    dynamicShapes: dynamicShapes.map(s => ({ id: s.id, name: s.name })),
    dynamicTypes: dynamicTypes.map(t => ({ id: t.id, name: t.name }))
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const actionType = formData.get("actionType");

  if (actionType === "add_diamond_shape") {
    const shapeName = formData.get("shapeName")?.toString().trim();
    if (!shapeName) {
      return { success: false, error: "Shape name is required." };
    }
    try {
      await prisma.dynamicDiamondShape.create({
        data: { shop, name: shapeName }
      });
      return { success: true, message: `Shape "${shapeName}" added successfully!` };
    } catch (err) {
      console.error("Add diamond shape error:", err);
      return { success: false, error: err.message.includes("Unique") ? "This shape already exists." : err.message };
    }
  }

  if (actionType === "delete_diamond_shape") {
    const shapeId = Number(formData.get("shapeId"));
    try {
      await prisma.dynamicDiamondShape.delete({
        where: { id: shapeId, shop }
      });
      return { success: true, message: "Shape deleted successfully!" };
    } catch (err) {
      console.error("Delete diamond shape error:", err);
      return { success: false, error: err.message };
    }
  }

  if (actionType === "add_diamond_type") {
    const typeName = formData.get("typeName")?.toString().trim();
    if (!typeName) {
      return { success: false, error: "Type name is required." };
    }
    try {
      await prisma.dynamicDiamondType.create({
        data: { shop, name: typeName }
      });
      return { success: true, message: `Type "${typeName}" added successfully!` };
    } catch (err) {
      console.error("Add diamond type error:", err);
      return { success: false, error: err.message.includes("Unique") ? "This type already exists." : err.message };
    }
  }

  if (actionType === "delete_diamond_type") {
    const typeId = Number(formData.get("typeId"));
    try {
      await prisma.dynamicDiamondType.delete({
        where: { id: typeId, shop }
      });
      return { success: true, message: "Type deleted successfully!" };
    } catch (err) {
      console.error("Delete diamond type error:", err);
      return { success: false, error: err.message };
    }
  }

  return null;
};

export default function DiamondConfig() {
  const { dynamicShapes, dynamicTypes } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const navigation = useNavigation();

  const [newShapeName, setNewShapeName] = useState("");
  const [newTypeName, setNewTypeName] = useState("");

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message);
    } else if (actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  const handleAddShape = (e) => {
    e.preventDefault();
    if (!newShapeName.trim()) return;
    const formData = new FormData();
    formData.append("actionType", "add_diamond_shape");
    formData.append("shapeName", newShapeName.trim());
    submit(formData, { method: "post" });
    setNewShapeName("");
  };

  const handleDeleteShape = (id) => {
    if (!confirm("Are you sure you want to delete this shape?")) return;
    const formData = new FormData();
    formData.append("actionType", "delete_diamond_shape");
    formData.append("shapeId", id.toString());
    submit(formData, { method: "post" });
  };

  const handleAddType = (e) => {
    e.preventDefault();
    if (!newTypeName.trim()) return;
    const formData = new FormData();
    formData.append("actionType", "add_diamond_type");
    formData.append("typeName", newTypeName.trim());
    submit(formData, { method: "post" });
    setNewTypeName("");
  };

  const handleDeleteType = (id) => {
    if (!confirm("Are you sure you want to delete this type?")) return;
    const formData = new FormData();
    formData.append("actionType", "delete_diamond_type");
    formData.append("typeId", id.toString());
    submit(formData, { method: "post" });
  };

  return (
    <div style={{ padding: "20px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <h1 style={{ fontSize: "20px", fontWeight: "600", color: "#1a1a1a" }}>💎 Diamond Configuration Manager</h1>
      </div>

      <div className="form-card" style={{ background: "#fff", padding: "24px", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px" }}>
          
          {/* Types Column */}
          <div>
            <h2 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#333" }}>Diamond Types</h2>
            
            {/* Add Type Form */}
            <form onSubmit={handleAddType} style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
              <input
                type="text"
                placeholder="Enter type (e.g. Accent)..."
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "1px solid #ccc",
                  fontSize: "12px",
                  outline: "none"
                }}
              />
              <s-button type="submit" variant="primary">Add Type</s-button>
            </form>

            {/* Types List */}
            <div style={{ maxHeight: "350px", overflowY: "auto", border: "1px solid #eee", borderRadius: "6px", padding: "8px" }}>
              {dynamicTypes.length === 0 ? (
                <div style={{ padding: "8px", color: "#888", fontSize: "12px" }}>No types configured</div>
              ) : (
                dynamicTypes.map((t) => (
                  <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f9f9f9" }}>
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>{t.name}</span>
                    <button
                      type="button"
                      onClick={() => handleDeleteType(t.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#d32f2f",
                        cursor: "pointer",
                        fontSize: "12px",
                        padding: "4px"
                      }}
                    >
                      ❌ Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Shapes Column */}
          <div>
            <h2 style={{ fontSize: "15px", fontWeight: "600", marginBottom: "12px", color: "#333" }}>Diamond Shapes</h2>
            
            {/* Add Shape Form */}
            <form onSubmit={handleAddShape} style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
              <input
                type="text"
                placeholder="Enter shape (e.g. Kite)..."
                value={newShapeName}
                onChange={(e) => setNewShapeName(e.target.value)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "1px solid #ccc",
                  fontSize: "12px",
                  outline: "none"
                }}
              />
              <s-button type="submit" variant="primary">Add Shape</s-button>
            </form>

            {/* Shapes List */}
            <div style={{ maxHeight: "350px", overflowY: "auto", border: "1px solid #eee", borderRadius: "6px", padding: "8px" }}>
              {dynamicShapes.length === 0 ? (
                <div style={{ padding: "8px", color: "#888", fontSize: "12px" }}>No shapes configured</div>
              ) : (
                dynamicShapes.map((s) => (
                  <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f9f9f9" }}>
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>{s.name}</span>
                    <button
                      type="button"
                      onClick={() => handleDeleteShape(s.id)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#d32f2f",
                        cursor: "pointer",
                        fontSize: "12px",
                        padding: "4px"
                      }}
                    >
                      ❌ Delete
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
