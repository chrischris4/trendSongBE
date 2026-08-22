import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

// Lundi de la semaine contenant `d`, a minuit UTC. Les DailyChartStat sont
// ecrits avec setUTCHours(0,0,0,0) : on reste sur la meme base horaire.
function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay(); // 0 = dimanche
  x.setUTCDate(x.getUTCDate() - (day === 0 ? 6 : day - 1));
  return x;
}

// Numerotation ISO 8601 : la semaine 1 est celle qui contient le premier jeudi
// de l'annee. Sans cette regle, une semaine a cheval sur deux annees
// produirait deux slugs differents pour la meme periode.
function isoWeek(d: Date): { year: number; week: number } {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((x.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: x.getUTCFullYear(), week };
}

function slugOf(monday: Date): string {
  const { year, week } = isoWeek(monday);
  return `${year}-w${String(week).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

interface CountryRow {
  countryCode: string;
  churn: number;
  newEntries: number;
  droppedOut: number;
  uniqueArtists: number;
  days: number;
  samples: number;
}

interface GainerRow {
  id: string;
  name: string;
  artist: string;
  delta: number;
  country: string;
}

interface TenureRow {
  id: string;
  name: string;
  artist: string;
  days: number;
}

interface ItemRow {
  appleId: string;
  type: string;
  name: string;
  artistName: string;
  artworkUrl: string | null;
  countryCount: number;
  bestRank: number;
}

@Injectable()
export class WeeklyService {
  private readonly logger = new Logger(WeeklyService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Lundi 10h UTC. La synchronisation de 1h a deja ecrit les statistiques du
  // dimanche : la semaine ecoulee est complete au moment de l'agregation.
  @Cron('0 10 * * 1')
  async publishLastWeek() {
    const lastMonday = addDays(mondayOf(new Date()), -7);
    const report = await this.generateFor(lastMonday);
    if (report) this.logger.log(`Bilan hebdomadaire publie : ${report.slug}`);
  }

  async findAll() {
    return this.prisma.weeklyReport.findMany({
      where: { published: true },
      orderBy: { weekStart: 'desc' },
      include: { items: { orderBy: { position: 'asc' } } },
    });
  }

  async findOne(slug: string) {
    const report = await this.prisma.weeklyReport.findUnique({
      where: { slug },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    if (!report || !report.published) throw new NotFoundException(`Bilan ${slug} introuvable`);
    return report;
  }

  // Agrege les DailyChartStat de la semaine commencant a `monday` et fige le
  // resultat. Rejouable : un second appel sur la meme semaine recalcule et
  // remplace la ligne, ce qui permet de rattraper un cron manque.
  async generateFor(monday: Date) {
    const weekStart = mondayOf(monday);
    const weekEnd = addDays(weekStart, 6);
    const slug = slugOf(weekStart);

    const byCountry = await this.prisma.$queryRaw<CountryRow[]>`
      SELECT "countryCode",
             AVG("churnPct")::float             AS churn,
             SUM("newEntries")::int             AS "newEntries",
             SUM("droppedOut")::int             AS "droppedOut",
             AVG("uniqueArtists")::float        AS "uniqueArtists",
             COUNT(DISTINCT "day")::int         AS days,
             COUNT(*)::int                      AS samples
      FROM daily_chart_stats
      WHERE "day" >= ${weekStart} AND "day" <= ${weekEnd}
      GROUP BY "countryCode"`;

    if (!byCountry.length) {
      this.logger.warn(`Bilan ${slug} : aucun releve sur la periode, generation ignoree`);
      return null;
    }

    const samples = byCountry.reduce((s, r) => s + r.samples, 0);
    const churnAvg = Math.round(byCountry.reduce((s, r) => s + r.churn * r.samples, 0) / samples);
    const newEntries = byCountry.reduce((s, r) => s + r.newEntries, 0);
    const droppedOut = byCountry.reduce((s, r) => s + r.droppedOut, 0);
    const uniqueArtists = Math.round(
      byCountry.reduce((s, r) => s + r.uniqueArtists * r.samples, 0) / samples,
    );
    const daysCovered = Math.max(...byCountry.map(r => r.days));

    // Un pays releve un ou deux jours seulement donnerait un extreme trompeur :
    // on n'oppose que des marches observes sur au moins trois jours.
    const ranked = byCountry.filter(r => r.days >= 3).sort((a, b) => a.churn - b.churn);
    const stable = ranked.length >= 2 ? ranked[0] : null;
    const volatile = ranked.length >= 2 ? ranked[ranked.length - 1] : null;

    const [gainer] = await this.prisma.$queryRaw<GainerRow[]>`
      SELECT "topGainerId" AS id, "topGainerName" AS name, "topGainerArtist" AS artist,
             "topGainerDelta" AS delta, "countryCode" AS country
      FROM daily_chart_stats
      WHERE "day" >= ${weekStart} AND "day" <= ${weekEnd} AND "topGainerDelta" IS NOT NULL
      ORDER BY "topGainerDelta" DESC
      LIMIT 1`;

    const [tenure] = await this.prisma.$queryRaw<TenureRow[]>`
      SELECT "topTenureId" AS id, "topTenureName" AS name, "topTenureArtist" AS artist,
             "topTenureDays" AS days
      FROM daily_chart_stats
      WHERE "day" >= ${weekStart} AND "day" <= ${weekEnd} AND "topTenureDays" IS NOT NULL
      ORDER BY "topTenureDays" DESC
      LIMIT 1`;

    const previous = await this.prisma.weeklyReport.findUnique({
      where: { slug: slugOf(addDays(weekStart, -7)) },
      select: { churnAvg: true },
    });
    const churnPrev = previous?.churnAvg ?? null;

    // Etendue geographique sur la semaine : combien de pays ont classe le meme
    // titre. Apple publie un classement par pays, jamais leur recoupement.
    const items = await this.prisma.$queryRaw<ItemRow[]>`
      SELECT "appleId", "type",
             MIN("name")                        AS name,
             MIN("artistName")                  AS "artistName",
             MIN("artworkUrl")                  AS "artworkUrl",
             COUNT(DISTINCT "countryCode")::int AS "countryCount",
             MIN("rank")::int                   AS "bestRank"
      FROM trending_tracks
      WHERE "fetchedAt" >= ${weekStart} AND "fetchedAt" < ${addDays(weekEnd, 1)}
      GROUP BY "appleId", "type"
      ORDER BY "countryCount" DESC, "bestRank" ASC
      LIMIT 5`;

    const data = {
      weekStart,
      weekEnd,
      churnAvg,
      churnPrev,
      newEntries,
      droppedOut,
      uniqueArtists,
      mostStableCountry: stable?.countryCode ?? null,
      mostStableChurn: stable ? Math.round(stable.churn) : null,
      mostVolatileCountry: volatile?.countryCode ?? null,
      mostVolatileChurn: volatile ? Math.round(volatile.churn) : null,
      topGainerId: gainer?.id ?? null,
      topGainerName: gainer?.name ?? null,
      topGainerArtist: gainer?.artist ?? null,
      topGainerDelta: gainer?.delta ?? null,
      topGainerCountry: gainer?.country ?? null,
      topTenureId: tenure?.id ?? null,
      topTenureName: tenure?.name ?? null,
      topTenureArtist: tenure?.artist ?? null,
      topTenureDays: tenure?.days ?? null,
      headline: this.buildHeadline({ churnAvg, churnPrev, charts: byCountry.length, daysCovered, gainer }),
      daysCovered,
    };

    // Les items sont remplaces en bloc plutot que diffes : la liste est courte,
    // et une regeneration doit produire exactement le meme etat qu'une creation.
    return this.prisma.weeklyReport.upsert({
      where: { slug },
      create: {
        slug,
        ...data,
        items: { create: items.map((it, i) => ({ ...it, position: i + 1 })) },
      },
      update: {
        ...data,
        items: { deleteMany: {}, create: items.map((it, i) => ({ ...it, position: i + 1 })) },
      },
      include: { items: { orderBy: { position: 'asc' } } },
    });
  }

  // L'accroche commente la variation plutot que le chiffre seul : un
  // renouvellement de 43 % ne veut rien dire sans la semaine precedente.
  private buildHeadline(o: {
    churnAvg: number;
    churnPrev: number | null;
    charts: number;
    daysCovered: number;
    gainer?: GainerRow;
  }): string {
    const scope = `across ${o.charts} country charts`;

    let lead: string;
    if (o.churnPrev === null) {
      lead = `${o.churnAvg}% of the entries we track were replaced this week ${scope}.`;
    } else if (o.churnAvg > o.churnPrev + 2) {
      lead = `Charts moved faster this week: ${o.churnAvg}% of entries were replaced ${scope}, up from ${o.churnPrev}% the week before.`;
    } else if (o.churnAvg < o.churnPrev - 2) {
      lead = `Charts settled this week: ${o.churnAvg}% of entries were replaced ${scope}, down from ${o.churnPrev}% the week before.`;
    } else {
      lead = `Turnover held steady at ${o.churnAvg}% ${scope}, a second week at the same pace.`;
    }

    const gain = o.gainer
      ? ` Biggest climb: ${o.gainer.name} by ${o.gainer.artist}, up ${o.gainer.delta} places.`
      : '';
    // Les premieres semaines sont partielles : l'archive quotidienne n'a
    // demarre que le 10/08/2026. La page doit le dire plutot que de laisser
    // croire a une semaine complete.
    const partial = o.daysCovered < 7 ? ` Based on ${o.daysCovered} days of readings.` : '';
    return lead + gain + partial;
  }
}
