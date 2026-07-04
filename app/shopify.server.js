import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Resolve API version dynamically from environment
function getApiVersion() {
  const envVal = process.env.SHOPIFY_API_VERSION;
  if (!envVal) return ApiVersion.October25;

  if (ApiVersion[envVal]) {
    return ApiVersion[envVal];
  }

  const found = Object.values(ApiVersion).find((v) => v === envVal);
  if (found) return found;

  const matchingKey = Object.keys(ApiVersion).find(
    (k) => k.toLowerCase() === envVal.toLowerCase()
  );
  if (matchingKey) return ApiVersion[matchingKey];

  return envVal;
}

const resolvedApiVersion = getApiVersion();

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: resolvedApiVersion,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = resolvedApiVersion;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

