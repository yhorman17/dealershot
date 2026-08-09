import { getRequestUrl } from "@tanstack/react-start/server";

const productionOrigin = "https://dealershot.studiogecko.dev";

export function getApplicationOrigin() {
  const configured = process.env.DEALERSHOT_PUBLIC_URL?.trim();
  const candidate =
    configured ||
    (process.env.NODE_ENV === "production" ? productionOrigin : getRequestUrl().origin);
  const url = new URL(candidate);
  const isLocalDevelopment =
    url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !isLocalDevelopment)
  ) {
    throw new Error("DealerShot public URL is invalid.");
  }
  return url.origin;
}
