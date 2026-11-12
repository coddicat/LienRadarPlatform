import { prisma } from "@lienradar/db";
import { enrichPropertyAppraiser } from "./enrichment/propertyAppraiser.js";

const byChannel = await prisma.lot.groupBy({ by: ["channel"], _count: true });
console.log("lots by channel", byChannel);
const sample = await prisma.lot.findMany({ take: 5, orderBy: { createdAt: "desc" } });
for (const lot of sample) {
  const r = await enrichPropertyAppraiser(lot.folio);
  console.log({ channel: lot.channel, case: lot.caseNumber, folio: lot.folio, status: r.status, error: r.error, found: (r.payload as { found?: boolean }).found });
}
await prisma.$disconnect();
