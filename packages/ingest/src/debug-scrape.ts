import { chromium } from "playwright";

const host = process.argv[2] || "miamidade.realforeclose.com";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});
const page = await context.newPage();
await page.goto(`https://${host}/index.cfm?zaction=USER&zmethod=CALENDAR`, {
  waitUntil: "domcontentloaded",
  timeout: 60_000,
});
await page.waitForTimeout(1500);
const dayids = await page.$$eval(".CALSELF", (els) =>
  els.map((el) => el.getAttribute("dayid")).filter(Boolean),
);
console.log("days", dayids.slice(0, 5));
const day = dayids.find((d) => d && new Date(d) >= new Date()) || dayids[0];
if (!day) {
  console.log("no day");
  await browser.close();
  process.exit(0);
}
const url = `https://${host}/index.cfm?zaction=AUCTION&Zmethod=PREVIEW&AUCTIONDATE=${day}`;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(2500);
const html = await page.content();
const texts = await page.$$eval("body *", (nodes) =>
  nodes
    .filter((n) => (n as HTMLElement).innerText && (n as HTMLElement).children.length < 8)
    .map((n) => (n as HTMLElement).innerText.trim())
    .filter((t) => /case|parcel|folio|address|bid|judgment/i.test(t) && t.length < 500)
    .slice(0, 40),
);
console.log("day", day);
console.log("sample texts", texts);
console.log("html has ParcelID", html.includes("ParcelID"), "Folio", /folio/i.test(html));
const area = await page.$eval("body", (b) => b.innerText.slice(0, 4000));
console.log("--- body text ---\n", area);
await browser.close();
