import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAuditLog, updateAuditLog } from "../audit.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  const logId = await createAuditLog(shop, "webhook", topic || "app/scopes_update", payload);

  try {
    if (session) {
      await db.session.update({
        where: {
          id: session.id,
        },
        data: {
          scope: current.toString(),
        },
      });
    }
    await updateAuditLog(logId, "success", { message: "App scopes updated successfully in database." });
  } catch (err) {
    console.error(`Error during app scopes update for shop ${shop}:`, err);
    await updateAuditLog(logId, "failed", { error: err.message });
  }

  return new Response();
};
