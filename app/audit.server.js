import prisma from "./db.server";

/**
 * Safely stringifies payloads to JSON, converting BigInts, Decimals, or other formats to string representations.
 */
function safeStringify(data) {
  if (data === undefined || data === null) return null;
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, (key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value && typeof value === "object" && value.constructor && value.constructor.name === "Decimal") {
        return Number(value);
      }
      return value;
    });
  } catch (err) {
    console.error("[AuditLog] safeStringify error:", err);
    return "[Unserializable payload]";
  }
}

/**
 * Creates a new audit log record with "running" status.
 * @returns {Promise<number|null>} The database ID of the created log entry.
 */
export async function createAuditLog(shop, type, name, requestData) {
  try {
    const log = await prisma.auditLog.create({
      data: {
        shop: shop || "unknown",
        type,
        name,
        status: "running",
        request: safeStringify(requestData),
      },
    });
    return log.id;
  } catch (err) {
    console.error(`[AuditLog] Failed to create audit log (${name}):`, err);
    return null;
  }
}

/**
 * Updates an existing audit log entry with status and response payload.
 */
export async function updateAuditLog(logId, status, responseData) {
  if (!logId) return;
  try {
    await prisma.auditLog.update({
      where: { id: logId },
      data: {
        status,
        response: safeStringify(responseData),
      },
    });
  } catch (err) {
    console.error(`[AuditLog] Failed to update audit log ID ${logId}:`, err);
  }
}
