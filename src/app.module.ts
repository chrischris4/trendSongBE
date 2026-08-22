import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { TrendingModule } from './trending/trending.module';
import { BlogModule } from './blog/blog.module';
import { DetailsModule } from './details/details.module';
import { CountriesModule } from './countries/countries.module';
import { WeeklyModule } from './weekly/weekly.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    TrendingModule,
    BlogModule,
    DetailsModule,
    CountriesModule,
    WeeklyModule,
  ],
})
export class AppModule {}
