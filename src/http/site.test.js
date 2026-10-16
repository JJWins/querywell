import assert from "node:assert/strict";
import { test } from "node:test";
import { renderView } from "./render.js";
import {
  HOME_DESCRIPTION,
  HOME_TITLE,
  canonicalUrl,
  pageMeta,
  publicOrigin,
} from "./site.js";

const beta = { PUBLIC_SITE_URL: "https://beta.querywell.in" };

test("public origin defaults to the beta site", () => {
  assert.equal(publicOrigin({}), "https://beta.querywell.in");
});

test("canonical homepage URL uses HTTPS and a trailing slash", () => {
  assert.equal(canonicalUrl("/", beta), "https://beta.querywell.in/");
  assert.equal(canonicalUrl("/docs", beta), "https://beta.querywell.in/docs");
});

test("homepage metadata uses the large image card and absolute image URL", () => {
  const meta = pageMeta({ pathname: "/", env: beta });
  assert.equal(meta.title, HOME_TITLE);
  assert.equal(meta.description, HOME_DESCRIPTION);
  assert.equal(meta.canonicalUrl, "https://beta.querywell.in/");
  assert.equal(meta.ogImageUrl, "https://beta.querywell.in/og-image.png");
  assert.equal(meta.ogImageWidth, "1200");
  assert.equal(meta.ogImageHeight, "630");
  assert.equal(meta.ogImageType, "image/png");
  assert.equal(meta.twitterCard, "summary_large_image");
});

test("home HTML includes crawler-readable Open Graph and Twitter tags", async () => {
  const html = await renderView("home", pageMeta({ pathname: "/", env: beta }), { layout: "main" });
  assert.match(html, /<link rel="canonical" href="https:\/\/beta\.querywell\.in\/">/);
  assert.match(html, /property="og:type" content="website"/);
  assert.match(html, /property="og:site_name" content="QueryWell"/);
  assert.match(html, /property="og:url" content="https:\/\/beta\.querywell\.in\/"/);
  assert.match(html, /property="og:image" content="https:\/\/beta\.querywell\.in\/og-image\.png"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /property="og:image:type" content="image\/png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="twitter:image" content="https:\/\/beta\.querywell\.in\/og-image\.png"/);
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((html.match(/property="og:url"/g) || []).length, 1);
});

test("docs metadata does not reuse the homepage title or canonical URL", async () => {
  const html = await renderView(
    "docs",
    pageMeta({
      title: "Ask API — QueryWell",
      description: "Send a plain-English question to the Ask API.",
      pathname: "/docs",
      env: beta,
    }),
    { layout: "main" }
  );
  assert.match(html, /<title>Ask API — QueryWell<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/beta\.querywell\.in\/docs"/);
  assert.doesNotMatch(html, /rel="canonical" href="https:\/\/beta\.querywell\.in\/"/);
});
