import { Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TrendingService } from './trending.service';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';

@Controller('trending')
export class TrendingController {
  constructor(private readonly trendingService: TrendingService) {}

  @Post('sync')
  @UseGuards(ApiKeyGuard)
  async sync() {
    await this.trendingService.syncAll();
    return { synced: true };
  }

  @Get()
  getTrending(
    @Query('type') type: string = 'all',
    @Query('country') country: string = 'US',
    @Query('limit') limit: string = '100',
  ) {
    const t = ['songs', 'albums'].includes(type) ? (type as 'songs' | 'albums') : 'all';
    return this.trendingService.getTrending(t, country, parseInt(limit));
  }

  // Recalcule les statistiques sans relancer une synchronisation Apple complete,
  // utile pour valider le calcul juste apres un deploiement.
  @Post('stats/compute')
  @UseGuards(ApiKeyGuard)
  async computeStats() {
    await this.trendingService.computeDaysOnChart();
    await this.trendingService.computeDailyStats();
    await this.trendingService.computeTrackReach();
    return { computed: true };
  }

  @Get('stats')
  getStats() {
    return this.trendingService.getStats();
  }

  // Fiches dont la trajectoire est assez fournie pour meriter d'etre indexees.
  // Les seuils sont fournis par l'appelant plutot que codes ici : c'est le
  // front qui decide ce qu'il marque robots.index, et le sitemap doit dire
  // exactement la meme chose. Deux constantes separees finiraient par deriver.
  @Get('indexable')
  getIndexable(
    @Query('minDays') minDays: string = '14',
    @Query('minCountries') minCountries: string = '3',
  ) {
    return this.trendingService.getIndexableTracks(
      parseInt(minDays) || 14,
      parseInt(minCountries) || 3,
    );
  }

  // Trajectoire d'un titre : pic, duree de presence, pays traverses.
  @Get('history/:appleId')
  async getHistory(@Param('appleId') appleId: string) {
    const history = await this.trendingService.getTrackHistory(appleId);
    if (!history) throw new NotFoundException(`Aucun historique pour ${appleId}`);
    return history;
  }

  // Renouvellement quotidien d'un classement national, precalcule par le cron.
  @Get('evolution/:country')
  async getEvolution(
    @Param('country') country: string,
    @Query('type') type: string = 'songs',
    @Query('days') days: string = '7',
  ) {
    const t = type === 'albums' ? 'albums' : 'songs';
    const stats = await this.trendingService.getDailyStats(country, t, parseInt(days));
    return { country: country.toUpperCase(), type: t, total: stats.length, stats };
  }
}
