import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { findCountry } from '../countries/countries.data';

function bigArtwork(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace('100x100bb', '600x600bb');
}

@Injectable()
export class DetailsService {
  private readonly logger = new Logger(DetailsService.name);
  private readonly base = 'https://itunes.apple.com/lookup';

  constructor(private http: HttpService, private prisma: PrismaService) {}

  private async lookup(params: Record<string, string | number>): Promise<any[]> {
    try {
      const { data } = await firstValueFrom(this.http.get(this.base, { params }));
      return data?.results ?? [];
    } catch (err: any) {
      this.logger.error(`Erreur iTunes lookup [${JSON.stringify(params)}]: ${err.message}`);
      return [];
    }
  }

  // Countries where this item currently charts, with its rank there
  private async getChartPositions(appleId: string, type: 'songs' | 'albums') {
    const latest = await this.prisma.trendingTrack.findFirst({
      where: { appleId, type },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    if (!latest) return [];
    const batchStart = new Date(latest.fetchedAt.getTime() - 60_000);
    const rows = await this.prisma.trendingTrack.findMany({
      where: { appleId, type, fetchedAt: { gte: batchStart } },
      select: { countryCode: true, rank: true },
      orderBy: { rank: 'asc' },
    });
    return rows.map(r => {
      const c = findCountry(r.countryCode);
      return { countryCode: r.countryCode, name: c?.name ?? r.countryCode, flag: c?.flag ?? '🌍', rank: r.rank };
    });
  }

  private async getMoreFromArtist(artistId: number, entity: 'song' | 'album', excludeId: number) {
    if (!artistId) return [];
    const results = await this.lookup({ id: artistId, entity, limit: 13 });
    return results
      .filter(r => (r.wrapperType === 'track' || r.wrapperType === 'collection'))
      .filter(r => (r.trackId ?? r.collectionId) !== excludeId)
      .slice(0, 12)
      .map(r => ({
        appleId: String(r.trackId ?? r.collectionId),
        type: entity === 'song' ? 'songs' : 'albums',
        name: r.trackName ?? r.collectionName,
        artistName: r.artistName ?? '',
        artworkUrl: bigArtwork(r.artworkUrl100),
        url: r.trackViewUrl ?? r.collectionViewUrl ?? null,
        previewUrl: r.previewUrl ?? null,
      }));
  }

  async getSong(id: number, country = 'US') {
    const results = await this.lookup({ id, country: country.toLowerCase() });
    const track = results.find(r => r.wrapperType === 'track') ?? results[0];
    if (!track) return null;

    const [moreFromArtist, chartPositions] = await Promise.all([
      this.getMoreFromArtist(track.artistId, 'song', track.trackId),
      this.getChartPositions(String(id), 'songs'),
    ]);

    return {
      appleId: String(track.trackId),
      type: 'songs',
      name: track.trackName ?? '',
      artistName: track.artistName ?? '',
      artistId: track.artistId ? String(track.artistId) : null,
      albumId: track.collectionId ? String(track.collectionId) : null,
      albumName: track.collectionName ?? null,
      artworkUrl: bigArtwork(track.artworkUrl100),
      previewUrl: track.previewUrl ?? null,
      durationMs: track.trackTimeMillis ?? null,
      genre: track.primaryGenreName ?? null,
      releaseDate: track.releaseDate ?? null,
      url: track.trackViewUrl ?? null,
      explicit: track.trackExplicitness === 'explicit',
      trackNumber: track.trackNumber ?? null,
      trackCount: track.trackCount ?? null,
      price: track.trackPrice ?? null,
      currency: track.currency ?? null,
      tracks: [],
      moreFromArtist,
      chartPositions,
    };
  }

  async getAlbum(id: number, country = 'US') {
    const results = await this.lookup({ id, country: country.toLowerCase(), entity: 'song' });
    const album = results.find(r => r.wrapperType === 'collection');
    if (!album) return null;

    const tracks = results
      .filter(r => r.wrapperType === 'track')
      .map(r => ({
        appleId: String(r.trackId),
        name: r.trackName ?? '',
        trackNumber: r.trackNumber ?? null,
        durationMs: r.trackTimeMillis ?? null,
        previewUrl: r.previewUrl ?? null,
        url: r.trackViewUrl ?? null,
        explicit: r.trackExplicitness === 'explicit',
      }));

    const [moreFromArtist, chartPositions] = await Promise.all([
      this.getMoreFromArtist(album.artistId, 'album', album.collectionId),
      this.getChartPositions(String(id), 'albums'),
    ]);

    return {
      appleId: String(album.collectionId),
      type: 'albums',
      name: album.collectionName ?? '',
      artistName: album.artistName ?? '',
      artistId: album.artistId ? String(album.artistId) : null,
      albumId: null,
      albumName: null,
      artworkUrl: bigArtwork(album.artworkUrl100),
      previewUrl: null,
      durationMs: null,
      genre: album.primaryGenreName ?? null,
      releaseDate: album.releaseDate ?? null,
      url: album.collectionViewUrl ?? null,
      explicit: album.collectionExplicitness === 'explicit',
      trackNumber: null,
      trackCount: album.trackCount ?? tracks.length,
      price: album.collectionPrice ?? null,
      currency: album.currency ?? null,
      copyright: album.copyright ?? null,
      tracks,
      moreFromArtist,
      chartPositions,
    };
  }
}
