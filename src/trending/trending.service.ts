import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MusicService } from '../music/music.service';
import { COUNTRIES, COUNTRY_CODES } from '../countries/countries.data';

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
    this.cache.clear();
    this.logger.log(`Synchronisation terminée — ${total} entrées`);
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
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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
