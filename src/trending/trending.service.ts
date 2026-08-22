import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MusicService } from '../music/music.service';
import { COUNTRIES, COUNTRY_CODES } from '../countries/countries.data';

// Fenetre d'historique conservee. 90 jours permettent des analyses d'evolution
// sur un trimestre glissant pour ~1 $/mois de stockage supplementaire ; les
// articles publies survivent de toute facon a la purge.
const RETENTION_DAYS = 90;

const CACHE_TTL = 60 * 60 * 1000;
const SYNC_CHUNK = 3;

@Injectable()
export class TrendingService implements OnModuleInit {
  private readonly logger = new Logger(TrendingService.name);
  private cache = new Map<string, { data: unknown; ts: number }>();

  constructor(private prisma: PrismaService, private music: MusicService) {}

  private fromCache<T>(key: string): T | null {
    const hit = this.cache.get(key);
    return hit && Date.now() - hit.ts < CACHE_TTL ? hit.data as T : null;
  }

  private toCache(key: string, data: unknown) {
    this.cache.set(key, { data, ts: Date.now() });
  }

  async onModuleInit() {
    const count = await this.prisma.trendingTrack.count();
    if (count === 0) {
      this.logger.log('DB vide - sync initial...');
      await this.syncAll();
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async syncAll() {
    this.logger.log(`Synchronisation Apple Music (${COUNTRIES.length} pays)...`);
    const fetchedAt = new Date();
    let total = 0;

    for (let i = 0; i < COUNTRIES.length; i += SYNC_CHUNK) {
      const chunk = COUNTRIES.slice(i, i + SYNC_CHUNK);
      const results = await Promise.all(
        chunk.flatMap(c => [
          this.syncCountry(c.code, 'songs', fetchedAt),
          this.syncCountry(c.code, 'albums', fetchedAt),
        ]),
      );
      total += results.reduce((s, n) => s + n, 0);
    }

    await this.cleanOld();
    // Le calcul des statistiques ne doit jamais faire echouer la synchronisation :
    // les releves du jour sont deja en base a ce stade.
    try {
      await this.computeDaysOnChart();
      await this.computeDailyStats();
      await this.computeTrackReach();
    } catch (e) {
      this.logger.error(`Statistiques quotidiennes non calculées : ${(e as Error).message}`);
    }
    this.cache.clear();
    this.logger.log(`Synchronisation terminée — ${total} entrées`);
  }

  /**
   * Anciennete de chaque titre du releve du jour, en jours distincts passes
   * dans ce classement.
   *
   * Apple affiche un rang, jamais depuis combien de temps un titre s'y
   * accroche. La valeur est ecrite sur les lignes du dernier relevé en une
   * seule instruction, pour que la lecture reste un simple SELECT.
   */
  async computeDaysOnChart() {
    const updated = await this.prisma.$executeRaw`
      WITH tenure AS (
        SELECT "countryCode", "type", "appleId",
               COUNT(DISTINCT ("fetchedAt" AT TIME ZONE 'UTC')::date)::int AS days
        FROM trending_tracks
        GROUP BY "countryCode", "type", "appleId"
      )
      UPDATE trending_tracks t
      SET "daysOnChart" = tenure.days
      FROM tenure
      WHERE t."countryCode" = tenure."countryCode"
        AND t."type" = tenure."type"
        AND t."appleId" = tenure."appleId"
        AND (t."fetchedAt" AT TIME ZONE 'UTC')::date =
            (SELECT MAX(("fetchedAt" AT TIME ZONE 'UTC')::date) FROM trending_tracks)`;

    this.logger.log(`Anciennete calculée pour ${updated} entrées`);
  }

  /**
   * Renouvellement quotidien de chaque classement, calcule une fois par jour.
   *
   * Apple publie le classement du moment, jamais la part qui a survecu depuis
   * la veille ni depuis combien de jours un titre s'y accroche. Ces deux
   * mesures n'existent que parce qu'on conserve 90 jours de releves, et elles
   * sont precalculees ici pour qu'aucune page ne declenche d'agregation.
   */
  async computeDailyStats() {
    const rows = await this.prisma.$queryRaw<Array<{
      countryCode: string; type: string; entriesTotal: number; newEntries: number;
      droppedOut: number; uniqueArtists: number; topGainerId: string | null;
      topGainerName: string | null; topGainerArtist: string | null; topGainerDelta: number | null;
      topTenureId: string | null; topTenureName: string | null; topTenureArtist: string | null;
      topTenureDays: number | null;
    }>>`
      WITH snap AS (
        SELECT "countryCode", "type", "appleId", "name", "artistName", "rank",
               ("fetchedAt" AT TIME ZONE 'UTC')::date AS d
        FROM trending_tracks
      ),
      today AS (SELECT * FROM snap WHERE d = (SELECT MAX(d) FROM snap)),
      prev  AS (SELECT * FROM snap WHERE d = (SELECT MAX(d) FROM snap WHERE d < (SELECT MAX(d) FROM snap))),
      tenure AS (
        SELECT "countryCode", "type", "appleId", COUNT(DISTINCT d)::int AS days
        FROM snap GROUP BY "countryCode", "type", "appleId"
      ),
      gain AS (
        SELECT DISTINCT ON (t."countryCode", t."type")
               t."countryCode", t."type", t."appleId", t."name", t."artistName",
               (p."rank" - t."rank")::int AS delta
        FROM today t JOIN prev p
          ON p."countryCode" = t."countryCode" AND p."type" = t."type" AND p."appleId" = t."appleId"
        WHERE p."rank" > t."rank"
        ORDER BY t."countryCode", t."type", (p."rank" - t."rank") DESC
      ),
      best AS (
        SELECT DISTINCT ON (t."countryCode", t."type")
               t."countryCode", t."type", t."appleId", t."name", t."artistName", te.days
        FROM today t JOIN tenure te
          ON te."countryCode" = t."countryCode" AND te."type" = t."type" AND te."appleId" = t."appleId"
        ORDER BY t."countryCode", t."type", te.days DESC, t."rank" ASC
      )
      SELECT
        t."countryCode", t."type",
        COUNT(*)::int AS "entriesTotal",
        COUNT(*) FILTER (WHERE p."appleId" IS NULL)::int AS "newEntries",
        (SELECT COUNT(*) FROM prev p2
          WHERE p2."countryCode" = t."countryCode" AND p2."type" = t."type"
            AND NOT EXISTS (SELECT 1 FROM today t2
                            WHERE t2."countryCode" = p2."countryCode" AND t2."type" = p2."type"
                              AND t2."appleId" = p2."appleId")
        )::int AS "droppedOut",
        COUNT(DISTINCT t."artistName")::int AS "uniqueArtists",
        MIN(g."appleId") AS "topGainerId", MIN(g."name") AS "topGainerName",
        MIN(g."artistName") AS "topGainerArtist", MIN(g.delta)::int AS "topGainerDelta",
        MIN(b."appleId") AS "topTenureId", MIN(b."name") AS "topTenureName",
        MIN(b."artistName") AS "topTenureArtist", MIN(b.days)::int AS "topTenureDays"
      FROM today t
      LEFT JOIN prev p ON p."countryCode" = t."countryCode" AND p."type" = t."type" AND p."appleId" = t."appleId"
      LEFT JOIN gain g ON g."countryCode" = t."countryCode" AND g."type" = t."type"
      LEFT JOIN best b ON b."countryCode" = t."countryCode" AND b."type" = t."type"
      GROUP BY t."countryCode", t."type"`;

    if (!rows.length) {
      this.logger.warn('Statistiques quotidiennes : aucun relevé à analyser');
      return;
    }

    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    for (const r of rows) {
      const churnPct = r.entriesTotal > 0 ? Math.round((r.newEntries / r.entriesTotal) * 100) : 0;
      const data = { ...r, churnPct, day };
      await this.prisma.dailyChartStat.upsert({
        where: { day_countryCode_type: { day, countryCode: r.countryCode, type: r.type } },
        create: data,
        update: data,
      });
    }

    this.logger.log(`Statistiques quotidiennes calculées pour ${rows.length} classements`);
  }

  /**
   * Portee globale de chaque titre, ecrite dans track_reach. Memes definitions
   * que getTrackHistory : `daysOnChart` compte les jours distincts tous pays
   * confondus, `countryCount` les pays distincts sur la fenetre conservee. La
   * colonne TrendingTrack.daysOnChart ne convient pas ici, elle mesure une
   * tenure par pays et non la presence globale.
   *
   * C'est la seule agregation sur la fenetre complete, et elle appartient au
   * cron : aucune requete visiteur ne doit la declencher.
   */
  async computeTrackReach() {
    // Reecriture complete plutot qu'un upsert : un titre sorti de la fenetre de
    // retention doit disparaitre de la table, sinon le sitemap continuerait a
    // declarer des fiches qui renvoient desormais 404.
    await this.prisma.$transaction([
      this.prisma.$executeRaw`DELETE FROM track_reach`,
      this.prisma.$executeRaw`
        INSERT INTO track_reach
          ("appleId", "type", "name", "artistName", "daysOnChart", "countryCount", "lastSeen", "computedAt")
        SELECT "appleId", "type",
               MIN("name"), MIN("artistName"),
               COUNT(DISTINCT DATE("fetchedAt"))::int,
               COUNT(DISTINCT "countryCode")::int,
               MAX("fetchedAt"), NOW()
        FROM trending_tracks
        GROUP BY "appleId", "type"`,
    ]);
    const n = await this.prisma.trackReach.count();
    this.logger.log(`Portee des titres recalculee : ${n} fiches`);
  }

  // Lecture indexee sur quelques milliers de lignes. Les seuils restent des
  // parametres : c'est le front qui decide ce qu'il marque robots.index, et le
  // sitemap doit dire exactement la meme chose.
  async getIndexableTracks(minDays: number, minCountries: number) {
    return this.prisma.trackReach.findMany({
      where: {
        daysOnChart: { gte: minDays },
        countryCount: { gte: minCountries },
      },
      orderBy: [{ countryCount: 'desc' }, { daysOnChart: 'desc' }],
      select: {
        appleId: true,
        type: true,
        name: true,
        artistName: true,
        daysOnChart: true,
        countryCount: true,
        lastSeen: true,
      },
    });
  }

  // Simple lecture des lignes precalculees, sans aucune agregation.
  async getDailyStats(countryCode: string, type: 'songs' | 'albums', days = 7) {
    return this.prisma.dailyChartStat.findMany({
      where: { countryCode: countryCode.toUpperCase(), type },
      orderBy: { day: 'desc' },
      take: Math.min(days, 90),
    });
  }

  private async syncCountry(countryCode: string, type: 'songs' | 'albums', fetchedAt: Date): Promise<number> {
    const items = await this.music.fetchMostPlayed(countryCode, type, 100);
    if (!items.length) return 0;
    await this.prisma.trendingTrack.createMany({
      data: items.map((item, i) => ({ ...item, rank: i + 1, countryCode, fetchedAt })),
    });
    return items.length;
  }

  private async cleanOld() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.trendingTrack.deleteMany({ where: { fetchedAt: { lt: cutoff } } });
    if (count > 0) this.logger.log(`${count} anciennes entrées supprimées`);
  }

  private async latestBatchStart(where: Record<string, unknown> = {}): Promise<Date | null> {
    const latest = await this.prisma.trendingTrack.findFirst({
      where,
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    if (!latest) return null;
    return new Date(latest.fetchedAt.getTime() - 60_000);
  }

  async getTrending(type: 'songs' | 'albums' | 'all', country: string, limit = 100) {
    const cc = COUNTRY_CODES.includes(country.toUpperCase()) ? country.toUpperCase() : 'US';
    const key = `trending:${type}:${cc}:${limit}`;
    const cached = this.fromCache<unknown[]>(key);
    if (cached) return cached;

    const typeWhere = type === 'all' ? {} : { type };
    const batchStart = await this.latestBatchStart({ countryCode: cc, ...typeWhere });
    if (!batchStart) return [];

    const result = await this.prisma.trendingTrack.findMany({
      where: {
        countryCode: cc,
        ...typeWhere,
        fetchedAt: { gte: batchStart },
      },
      orderBy: [{ type: 'asc' }, { rank: 'asc' }],
      take: limit,
    });
    this.toCache(key, result);
    return result;
  }

  /**
   * Trajectoire complete d'un titre sur la fenetre conservee.
   *
   * Apple expose un classement instantane : ni le pic atteint, ni la duree de
   * presence, ni les pays traverses. Tout cela se deduit de nos releves
   * successifs, et c'est la seule chose qu'une fiche titre peut apporter qu'on
   * ne trouve pas a la source. La requete est servie par l'index sur appleId.
   */
  async getTrackHistory(appleId: string) {
    const key = `history:${appleId}`;
    const cached = this.fromCache<unknown>(key);
    if (cached) return cached;

    const rows = await this.prisma.trendingTrack.findMany({
      where: { appleId },
      orderBy: { fetchedAt: 'asc' },
    });
    if (!rows.length) return null;

    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const latest = rows[rows.length - 1];

    // Un pays peut apparaitre plusieurs fois par jour si une synchro est rejouee :
    // on raisonne en jours distincts, jamais en nombre de lignes.
    const byCountry = new Map<string, { days: Set<string>; bestRank: number; lastDay: string; lastRank: number }>();
    const byDay = new Map<string, { bestRank: number; countries: Set<string> }>();
    let peak = { rank: Number.MAX_SAFE_INTEGER, countryCode: '', day: '' };

    for (const row of rows) {
      const day = dayOf(row.fetchedAt);

      const country = byCountry.get(row.countryCode) ?? { days: new Set(), bestRank: row.rank, lastDay: day, lastRank: row.rank };
      country.days.add(day);
      country.bestRank = Math.min(country.bestRank, row.rank);
      if (day >= country.lastDay) { country.lastDay = day; country.lastRank = row.rank; }
      byCountry.set(row.countryCode, country);

      const daily = byDay.get(day) ?? { bestRank: row.rank, countries: new Set() };
      daily.bestRank = Math.min(daily.bestRank, row.rank);
      daily.countries.add(row.countryCode);
      byDay.set(day, daily);

      if (row.rank < peak.rank) peak = { rank: row.rank, countryCode: row.countryCode, day };
    }

    const days = [...byDay.keys()].sort();
    const lastDay = days[days.length - 1];

    const result = {
      appleId,
      type: latest.type,
      name: latest.name,
      artistName: latest.artistName,
      artworkUrl: latest.artworkUrl,
      url: latest.url,
      releaseDate: latest.releaseDate,
      genreNames: latest.genreNames,
      explicit: latest.explicit,
      firstSeen: days[0],
      lastSeen: lastDay,
      daysOnChart: days.length,
      countryCount: byCountry.size,
      peak,
      countries: [...byCountry.entries()]
        .map(([countryCode, c]) => ({
          countryCode,
          days: c.days.size,
          bestRank: c.bestRank,
          // Rang actuel seulement si le titre figure encore au dernier releve.
          currentRank: c.lastDay === lastDay ? c.lastRank : null,
        }))
        .sort((a, b) => a.bestRank - b.bestRank),
      timeline: days.map(day => ({
        day,
        bestRank: byDay.get(day)!.bestRank,
        countryCount: byDay.get(day)!.countries.size,
      })),
    };

    this.toCache(key, result);
    return result;
  }

  async getStats() {
    const cached = this.fromCache<unknown>('stats');
    if (cached) return cached;

    const latest = await this.prisma.trendingTrack.findFirst({ orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
    if (!latest) return null;
    const batchStart = new Date(latest.fetchedAt.getTime() - 60_000);

    const prevBatch = await this.prisma.trendingTrack.findFirst({
      where: { fetchedAt: { lt: batchStart } },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    const prevBatchStart = prevBatch ? new Date(prevBatch.fetchedAt.getTime() - 60_000) : null;

    const [allItems, prevItems] = await Promise.all([
      this.prisma.trendingTrack.findMany({
        where: { fetchedAt: { gte: batchStart } },
        select: {
          appleId: true, type: true, name: true, artistName: true, artworkUrl: true,
          genreIds: true, genreNames: true, rank: true, countryCode: true, releaseDate: true,
        },
      }),
      prevBatchStart ? this.prisma.trendingTrack.findMany({
        where: { fetchedAt: { gte: prevBatchStart, lt: batchStart } },
        select: { appleId: true },
      }) : Promise.resolve([] as { appleId: string }[]),
    ]);

    const songs = allItems.filter(i => i.type === 'songs');
    const albums = allItems.filter(i => i.type === 'albums');
    const countries = new Set(allItems.map(i => i.countryCode)).size;

    // Global top = items charting in the most countries, ties broken by best average rank
    const computeGlobalTop = (items: typeof allItems, top = 5) => {
      const byId = new Map<string, { name: string; artistName: string; artworkUrl: string | null; countries: number; rankSum: number }>();
      for (const item of items) {
        const entry = byId.get(item.appleId) ?? { name: item.name, artistName: item.artistName, artworkUrl: item.artworkUrl, countries: 0, rankSum: 0 };
        entry.countries += 1;
        entry.rankSum += item.rank;
        byId.set(item.appleId, entry);
      }
      return [...byId.entries()]
        .map(([appleId, e]) => ({ appleId, name: e.name, artistName: e.artistName, artworkUrl: e.artworkUrl, countryCount: e.countries, avgRank: +(e.rankSum / e.countries).toFixed(1) }))
        .sort((a, b) => b.countryCount - a.countryCount || a.avgRank - b.avgRank)
        .slice(0, top);
    };

    // Genre distribution over songs (ids are stable across storefronts, names may be localized)
    const genreCounts = new Map<string, { count: number; name: string }>();
    for (const item of songs) {
      item.genreIds.forEach((gId, idx) => {
        const entry = genreCounts.get(gId) ?? { count: 0, name: item.genreNames[idx] ?? gId };
        entry.count += 1;
        genreCounts.set(gId, entry);
      });
    }
    const topGenres = [...genreCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6)
      .map(([genreId, { count, name }]) => ({ genreId, name, count, pct: Math.round((count / (songs.length || 1)) * 100) }));

    // Artists with the most chart entries worldwide
    const artistCounts = new Map<string, number>();
    for (const item of songs) {
      if (item.artistName) artistCounts.set(item.artistName, (artistCounts.get(item.artistName) ?? 0) + 1);
    }
    const topArtists = [...artistCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([artist, count]) => ({ artist, count, pct: Math.round((count / (songs.length || 1)) * 100) }));

    // Release year distribution over songs
    const yearCounts = new Map<string, number>();
    for (const item of songs) {
      const year = item.releaseDate?.substring(0, 4);
      if (year?.match(/^\d{4}$/)) yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
    const yearDistribution = [...yearCounts.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 6)
      .map(([year, count]) => ({ year, count, pct: Math.round((count / (songs.length || 1)) * 100) }));

    const prevIds = new Set(prevItems.map(i => i.appleId));
    const currentIds = new Set(allItems.map(i => i.appleId));
    const newToday = prevItems.length ? [...currentIds].filter(id => !prevIds.has(id)).length : 0;

    const result = {
      songs: songs.length,
      albums: albums.length,
      countries,
      topSongs: computeGlobalTop(songs),
      topAlbums: computeGlobalTop(albums),
      topGenres,
      topArtists,
      yearDistribution,
      newToday,
      lastUpdated: latest.fetchedAt.toISOString(),
    };
    this.toCache('stats', result);
    return result;
  }
}
