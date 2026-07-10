import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAuditLog, updateAuditLog } from "../audit.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const logId = await createAuditLog(shop, "webhook", topic || "app_subscriptions/update", payload);

  try {
    const appSubscription = payload.app_subscription || {};
    const subscriptionId = appSubscription.admin_graphql_api_id || String(appSubscription.id || "");
    const status = appSubscription.status || "UNKNOWN";
    const planName = appSubscription.name || "";
    const isTest = !!appSubscription.test;
    const amount = parseFloat(appSubscription.line_items?.[0]?.plan?.pricing_details?.price?.amount || "0");

    console.log(`Upserting subscription record in database for shop ${shop}: status=${status}, amount=${amount}`);

    await db.storeSubscription.upsert({
      where: { shop },
      update: {
        subscriptionId,
        status,
        planName,
        amount,
        isTest,
      },
      create: {
        shop,
        subscriptionId,
        status,
        planName,
        amount,
        isTest,
      },
    });

    console.log(`Successfully updated local store subscription record for ${shop}`);
    await updateAuditLog(logId, "success", { message: `Successfully upserted store subscription. Status: ${status}` });
  } catch (err) {
    console.error(`Error processing APP_SUBSCRIPTIONS_UPDATE webhook for shop ${shop}:`, err);
    await updateAuditLog(logId, "failed", { error: err.message });
  }

  return new Response();
};
