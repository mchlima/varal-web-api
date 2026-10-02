import { Module } from '@nestjs/common';

import { UnitsModule } from '../units/units.module.js';
import { MenuController } from './menu.controller.js';
import { MenuService } from './menu.service.js';
import { ModifiersService } from './modifiers.service.js';
import { PriceListsService } from './price-lists.service.js';
import { ProductsService } from './products.service.js';

/**
 * Menu of the units (spec 03, section 5): categories, products, modifiers, sold-out and price lists.
 */
@Module({
  imports: [UnitsModule],
  controllers: [MenuController],
  providers: [MenuService, ModifiersService, PriceListsService, ProductsService],
})
export class MenuModule {}
