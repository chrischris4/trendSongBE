import { Controller, Get } from '@nestjs/common';
import { COUNTRIES } from './countries.data';

@Controller('countries')
export class CountriesController {
  @Get()
  findAll() {
    return COUNTRIES;
  }
}
