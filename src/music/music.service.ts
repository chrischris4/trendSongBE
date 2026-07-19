import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface MusicItem {
  appleId: string;
  type: string;
  name: string;
  artistName: string;
  artistId: string | null;
  artistUrl: string | null;
  artworkUrl: string | null;
  url: string | null;
  releaseDate: string | null;
  genreIds: string[];
  genreNames: string[];
  explicit: boolean;
}

// Apple's generic "Music" genre, present on every item — useless for stats/filters.
const GENERIC_GENRE_ID = '34';

@Injectable()
export class MusicService {
  private readonly logger = new Logger(MusicService.name);
  private readonly baseUrl = 'https://rss.marketingtools.apple.com/api/v2';

  constructor(private http: HttpService) {}

  async fetchMostPlayed(country: string, type: 'songs' | 'albums', limit = 100, retries = 3): Promise<MusicItem[]> {
    try {
      const { data } = await firstValueFrom(
        this.http.get(`${this.baseUrl}/${country.toLowerCase()}/music/most-played/${limit}/${type}.json`, { timeout: 15_000 }),
      );
      const results = data?.feed?.results ?? [];

      return results.map((item: any) => {
        const genres = (item.genres ?? []).filter((g: any) => g.genreId !== GENERIC_GENRE_ID);
        return {
          appleId: String(item.id),
          type,
          name: item.name ?? '',
          artistName: item.artistName ?? '',
          artistId: item.artistId ? String(item.artistId) : null,
          artistUrl: item.artistUrl ?? null,
          artworkUrl: item.artworkUrl100 ?? null,
          url: item.url ?? null,
          releaseDate: item.releaseDate ?? null,
          genreIds: genres.map((g: any) => String(g.genreId)),
          genreNames: genres.map((g: any) => g.name),
          // The feed spells it "Explict" — match both to be safe.
          explicit: ['Explicit', 'Explict'].includes(item.contentAdvisoryRating),
        };
      });
    } catch (err: any) {
      if (retries > 0) {
        this.logger.warn(`Apple RSS [${country}/${type}] a échoué (${err.message}), nouvelle tentative dans 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        return this.fetchMostPlayed(country, type, limit, retries - 1);
      }
      this.logger.error(`Erreur Apple RSS [${country}/${type}]: ${err.message}`);
      return [];
    }
  }
}
