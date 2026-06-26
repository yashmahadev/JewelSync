import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAuditLog, updateAuditLog } from "../audit.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const logId = await createAuditLog(shop, "webhook", topic || "app/uninstalled", { shop });

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // We clean up all shop data for GDPR compliance and database space saving.
  try {
    console.log(`Cleaning up database records for shop: ${shop}`);
    await db.$transaction([
      db.storeConfig.deleteMany({ where: { shop } }),
      db.diamondRate.deleteMany({ where: { shop } }),
      db.variantWeightConfig.deleteMany({ where: { shop } }),
      db.syncJob.deleteMany({ where: { shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
    console.log(`Successfully cleared all database entries for shop: ${shop}`);
    await updateAuditLog(logId, "success", { message: "Uninstall cleanup transaction completed successfully." });
  } catch (err) {
    console.error(`Error during uninstall cleanup transaction for shop ${shop}:`, err);
    await updateAuditLog(logId, "failed", { error: err.message });
  }

  return new Response();
};
