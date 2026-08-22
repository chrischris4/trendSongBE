import { Module } from '@nestjs/common';
import { WeeklyService } from './weekly.service';
import { WeeklyController } from './weekly.controller';

@Module({ providers: [WeeklyService], controllers: [WeeklyController] })
export class WeeklyModule {}
