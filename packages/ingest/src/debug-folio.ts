import { prisma } from "@lienradar/db";

const lot = await prisma.lot.findFirst({
  where: { folio: "UNKNOWN" },
  include: { observations: { orderBy: { fetchedAt: "desc" }, take: 1 } },
});
console.log({
  case: lot?.caseNumber,
  folio: lot?.folio,
  channel: lot?.channel,
  raw: lot?.observations[0]?.payload,
});
const withFolio = await prisma.lot.count({ where: { NOT: { folio: "UNKNOWN" } } });
const unknown = await prisma.lot.count({ where: { folio: "UNKNOWN" } });
console.log({ withFolio, unknown });
await prisma.$disconnect();
