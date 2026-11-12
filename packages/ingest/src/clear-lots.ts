import { prisma } from "@lienradar/db";

await prisma.deal.deleteMany();
await prisma.lotEvent.deleteMany();
await prisma.bidCeiling.deleteMany();
await prisma.bidGate.deleteMany();
await prisma.riskCheck.deleteMany();
await prisma.mortgageAssessment.deleteMany();
await prisma.debtItem.deleteMany();
await prisma.document.deleteMany();
await prisma.enrichmentLayer.deleteMany();
await prisma.rawObservation.deleteMany();
await prisma.lot.deleteMany();
await prisma.auctionEvent.deleteMany();
await prisma.property.deleteMany();
console.log("cleared lots and related rows");
await prisma.$disconnect();
