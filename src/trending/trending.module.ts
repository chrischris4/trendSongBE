import { Module } from '@nestjs/common';
import { TrendingService } from './trending.service';
import { TrendingController } from './trending.controller';
import { MusicModule } from '../music/music.module';

@Module({
  imports: [MusicModule],
  providers: [TrendingService],
  controllers: [TrendingController],
})
export class TrendingModule {}
