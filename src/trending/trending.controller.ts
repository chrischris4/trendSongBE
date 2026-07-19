import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
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

  @Get('stats')
  getStats() {
    return this.trendingService.getStats();
  }
}
