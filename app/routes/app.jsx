import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate, MONTHLY_PLAN } from "../shopify.server";
import { createAuditLog, updateAuditLog } from "../audit.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { billing, session, admin } = await authenticate.admin(request);

  // Check if charge_id is present in query parameters (redirected back from Shopify approval)
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");

  if (chargeId) {
    const logId = await createAuditLog(
      session.shop,
      "foreground_job",
      "billing_completion",
      { chargeId, url: request.url }
    );
    if (logId) {
      await updateAuditLog(logId, "success", { message: `Merchant approved subscription charge. Charge ID: ${chargeId}` });
    }

    try {
      const response = await admin.graphql(
        `#graphql
        query getSubscription($id: ID!) {
          node(id: $id) {
            ... on AppSubscription {
              id
              name
              status
              test
              lineItems {
                plan {
                  pricingDetails {
                    ... on AppRecurringPricing {
                      price {
                        amount
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
            id: `gid://shopify/AppSubscription/${chargeId}`,
          },
        }
      );
      const resData = await response.json();
      const appSubscription = resData.data?.node;
      if (appSubscription) {
        const amount = parseFloat(appSubscription.lineItems?.[0]?.plan?.pricingDetails?.price?.amount || "8.99");
        await db.storeSubscription.upsert({
          where: { shop: session.shop },
          update: {
            subscriptionId: appSubscription.id,
            status: appSubscription.status,
            planName: appSubscription.name,
            amount: amount,
            isTest: !!appSubscription.test,
          },
          create: {
            shop: session.shop,
            subscriptionId: appSubscription.id,
            status: appSubscription.status,
            planName: appSubscription.name,
            amount: amount,
            isTest: !!appSubscription.test,
          },
        });
      }
    } catch (e) {
      console.error("[Billing] Failed to sync subscription in loader:", e);
    }
  }

  // Check local database first for an ACTIVE subscription (allows manual database updates/bypass)
  const localSubscription = await db.storeSubscription.findUnique({
    where: { shop: session.shop },
  });

  const hasLocalActiveSubscription = localSubscription && localSubscription.status === "ACTIVE";

  if (!hasLocalActiveSubscription) {
    await billing.require({
      plans: [MONTHLY_PLAN],
      isTest: process.env.SHOPIFY_BILLING_IS_TEST !== "false",
      onFailure: async () => {
        const logId = await createAuditLog(
          session.shop,
          "foreground_job",
          "billing_redirect",
          { plan: MONTHLY_PLAN, isTest: process.env.SHOPIFY_BILLING_IS_TEST !== "false" }
        );
        if (logId) {
          await updateAuditLog(logId, "success", { message: "Merchant has no active plan locally or on Shopify. Redirecting to subscription approval screen." });
        }

        return billing.request({
          plan: MONTHLY_PLAN,
          isTest: process.env.SHOPIFY_BILLING_IS_TEST !== "false",
        });
      },
    });
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/pricing-dashboard">Pricing Dashboard</s-link>
        <s-link href="/app/diamond-rates">Diamond Rates</s-link>
        <s-link href="/app/diamond-config">Diamond Configuration</s-link>
        {/* <s-link href="/app/bulk-metafields">Bulk Metafields</s-link> */}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
