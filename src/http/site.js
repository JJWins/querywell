const DEFAULT_ORIGIN = "https://beta.querywell.in";

export const SITE_NAME = "QueryWell";
export const HOME_TITLE = "QueryWell — Ask your database in plain English";
export const HOME_DESCRIPTION =
  "Turn plain-English questions into verified, read-only SQL. QueryWell runs SELECT queries on your MySQL replica and returns the rows without storing them.";
export const OG_IMAGE_PATH = "/og-image.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_TYPE = "image/png";
export const OG_IMAGE_ALT = "QueryWell — Ask your database in plain English";

export function publicOrigin(env = process.env) {
  return String(env.PUBLIC_SITE_URL || DEFAULT_ORIGIN).replace(/\/$/, "");
}

export function canonicalUrl(pathname = "/", env = process.env) {
  const origin = publicOrigin(env);
  if (!pathname || pathname === "/") return `${origin}/`;
  return `${origin}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

export function pageMeta({
  title = HOME_TITLE,
  description = HOME_DESCRIPTION,
  pathname = "/",
  env = process.env,
} = {}) {
  const origin = publicOrigin(env);
  return {
    title,
    description,
    siteName: SITE_NAME,
    canonicalUrl: canonicalUrl(pathname, env),
    ogImageUrl: `${origin}${OG_IMAGE_PATH}`,
    ogImageWidth: String(OG_IMAGE_WIDTH),
    ogImageHeight: String(OG_IMAGE_HEIGHT),
    ogImageType: OG_IMAGE_TYPE,
    ogImageAlt: OG_IMAGE_ALT,
    twitterCard: "summary_large_image",
  };
}
