import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MusicService } from './music.service';

@Module({
  imports: [HttpModule],
  providers: [MusicService],
  exports: [MusicService],
})
export class MusicModule {}
