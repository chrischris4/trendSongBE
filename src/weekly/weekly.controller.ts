import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { WeeklyService } from './weekly.service';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';

@Controller('weekly')
export class WeeklyController {
  constructor(private readonly weeklyService: WeeklyService) {}

  @Get()
  findAll() {
    return this.weeklyService.findAll();
  }

  // Declare avant ':slug', sinon Nest ferait correspondre « generate » au
  // parametre. Sert a amorcer la premiere semaine et a rattraper un cron
  // manque : `week` accepte n'importe quelle date de la semaine visee.
  @Post('generate')
  @UseGuards(ApiKeyGuard)
  generate(@Body() body: { week?: string }) {
    const target = body?.week ? new Date(body.week) : new Date();
    return this.weeklyService.generateFor(target);
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    return this.weeklyService.findOne(slug);
  }
}
