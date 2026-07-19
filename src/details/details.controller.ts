import { Controller, Get, Param, Query } from '@nestjs/common';
import { DetailsService } from './details.service';

@Controller('details')
export class DetailsController {
  constructor(private readonly detailsService: DetailsService) {}

  @Get('songs/:id')
  getSong(@Param('id') id: string, @Query('country') country: string = 'US') {
    return this.detailsService.getSong(parseInt(id), country);
  }

  @Get('albums/:id')
  getAlbum(@Param('id') id: string, @Query('country') country: string = 'US') {
    return this.detailsService.getAlbum(parseInt(id), country);
  }
}
