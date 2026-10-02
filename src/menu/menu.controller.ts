import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';

import { PanelAuth } from '../auth/auth.decorators.js';
import { ErrorResponseSchema } from '../errors/error-response.schema.js';
import { Idempotent } from '../idempotency/idempotent.decorator.js';
import { IdPipe, NotFoundResponse, OwnerOnly } from '../units/unit-access.js';
import { MenuService } from './menu.service.js';
import {
  CategoryListSchema,
  CreatePriceListRequestSchema,
  type PriceListDto,
  PriceListListSchema,
  type PriceListPricesDto,
  PriceListPricesSchema,
  PriceListSchema,
  type ProductPricesDto,
  ProductPricesSchema,
  PutPriceListPricesRequestSchema,
  PutProductPricesRequestSchema,
  UpdatePriceListRequestSchema,
  CategoryOrderRequestSchema,
  CategorySchema,
  type CategoryDto,
  CreateCategoryRequestSchema,
  CreateModifierGroupRequestSchema,
  CreateModifierRequestSchema,
  CreateProductRequestSchema,
  type MenuDto,
  MenuSchema,
  type ModifierDto,
  type ModifierGroupDto,
  ModifierGroupSchema,
  ModifierSchema,
  type ProductDto,
  ProductListSchema,
  ProductOrderRequestSchema,
  ProductSchema,
  UpdateCategoryRequestSchema,
  UpdateModifierGroupRequestSchema,
  UpdateModifierRequestSchema,
  UpdateProductRequestSchema,
} from './menu.schemas.js';
import { ModifiersService } from './modifiers.service.js';
import { PriceListsService } from './price-lists.service.js';
import { ProductsService } from './products.service.js';

const REFERENCE_DOC =
  '`INVALID_REFERENCE` (item de outra unidade ou inexistente), `INVALID_PREP_STATION` (RN-03.08), `INVALID_ORDER`, `INVALID_MODIFIER_LIMITS` (RN-03.13) ou `VALIDATION_FAILED`.';

/** Menu of the unit (spec 03, section 5). Owner only, except reading the menu and sold-out. */
@ApiTags('menu')
@Controller()
export class MenuController {
  constructor(
    private readonly menu: MenuService,
    private readonly products: ProductsService,
    private readonly modifiers: ModifiersService,
    private readonly priceLists: PriceListsService,
  ) {}

  @Get('units/:id/menu')
  @PanelAuth()
  @ApiOperation({ summary: 'Cardápio completo da unidade (dono e colaboradores da unidade)' })
  @ApiOkResponse({ standardSchema: MenuSchema })
  @NotFoundResponse()
  @ApiForbiddenResponse({
    description: '`FORBIDDEN`: colaborador sem acesso à unidade.',
    standardSchema: ErrorResponseSchema,
  })
  readMenu(@Param('id', IdPipe) id: string): Promise<MenuDto> {
    return this.menu.read(id);
  }

  // ---------------------------------------------------------------------------------------------
  // Price lists (spec 03, section 5.3)
  // ---------------------------------------------------------------------------------------------

  @Get('units/:id/price-lists')
  @PanelAuth()
  @ApiOperation({
    summary:
      'Tabelas de preço da unidade, com quantos produtos têm preço e qual é a vigente (dono: todas; colaborador: as ativas)',
  })
  @ApiOkResponse({ standardSchema: PriceListListSchema })
  @NotFoundResponse()
  @ApiForbiddenResponse({
    description: '`FORBIDDEN`: colaborador sem acesso à unidade.',
    standardSchema: ErrorResponseSchema,
  })
  async listPriceLists(@Param('id', IdPipe) id: string): Promise<{ data: PriceListDto[] }> {
    return { data: await this.priceLists.list(id) };
  }

  @Post('units/:id/price-lists')
  @OwnerOnly()
  @Idempotent()
  @ApiOperation({ summary: 'Cria uma tabela de preço na unidade (RN-03.20)' })
  @ApiCreatedResponse({ standardSchema: PriceListSchema })
  @NotFoundResponse()
  @ApiConflictResponse({
    description: '`PRICE_LIST_NAME_TAKEN` ou `PRICE_LIST_NAME_RESERVED` ("Normal"), CA-03.10.',
    standardSchema: ErrorResponseSchema,
  })
  createPriceList(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CreatePriceListRequestSchema })
    body: z.infer<typeof CreatePriceListRequestSchema>,
  ): Promise<PriceListDto> {
    return this.priceLists.create(id, body);
  }

  @Get('price-lists/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Tabela de preço com os preços que ela tem (tela da tabela, RN-03.22)' })
  @ApiOkResponse({ standardSchema: PriceListPricesSchema })
  @NotFoundResponse()
  getPriceList(@Param('id', IdPipe) id: string): Promise<PriceListPricesDto> {
    return this.priceLists.get(id);
  }

  @Patch('price-lists/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Renomeia, ordena, ativa ou desativa a tabela (RN-03.20, RN-03.23)' })
  @ApiOkResponse({ standardSchema: PriceListSchema })
  @NotFoundResponse()
  @ApiConflictResponse({
    description:
      '`PRICE_LIST_IN_USE` (vigente ou de evento agendado ou em andamento, CA-03.10), `PRICE_LIST_NAME_TAKEN`, `PRICE_LIST_NAME_RESERVED` ou `VERSION_CONFLICT`.',
    standardSchema: ErrorResponseSchema,
  })
  updatePriceList(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdatePriceListRequestSchema })
    body: z.infer<typeof UpdatePriceListRequestSchema>,
  ): Promise<PriceListDto> {
    return this.priceLists.update(id, body);
  }

  @Put('price-lists/:id/prices')
  @OwnerOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Preços de vários produtos numa tabela; `null` remove o preço (RN-03.22). Vale para itens novos (RN-03.24)',
  })
  @ApiOkResponse({ standardSchema: PriceListPricesSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({
    description: '`INVALID_REFERENCE` (produto de outra unidade) ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  putPriceListPrices(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutPriceListPricesRequestSchema })
    body: z.infer<typeof PutPriceListPricesRequestSchema>,
  ): Promise<PriceListPricesDto> {
    return this.priceLists.putListPrices(id, body.prices);
  }

  @Put('products/:id/prices')
  @OwnerOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preços de um produto em várias tabelas; `null` remove o preço (RN-03.22)',
  })
  @ApiOkResponse({ standardSchema: ProductPricesSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({
    description: '`INVALID_REFERENCE` (tabela de outra unidade) ou `VALIDATION_FAILED`.',
    standardSchema: ErrorResponseSchema,
  })
  putProductPrices(
    @Param('id', IdPipe) id: string,
    @Body({ schema: PutProductPricesRequestSchema })
    body: z.infer<typeof PutProductPricesRequestSchema>,
  ): Promise<ProductPricesDto> {
    return this.priceLists.putProductPrices(id, body.prices);
  }

  // ---------------------------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------------------------

  @Post('categories')
  @OwnerOnly()
  @Idempotent()
  @ApiOperation({ summary: 'Cria uma categoria (estação de preparo padrão: Cozinha)' })
  @ApiCreatedResponse({ standardSchema: CategorySchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  @ApiConflictResponse({
    description: '`CATEGORY_NAME_TAKEN`.',
    standardSchema: ErrorResponseSchema,
  })
  createCategory(
    @Body({ schema: CreateCategoryRequestSchema })
    body: z.infer<typeof CreateCategoryRequestSchema>,
  ): Promise<CategoryDto> {
    return this.menu.createCategory(body);
  }

  @Patch('categories/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Altera uma categoria' })
  @ApiOkResponse({ standardSchema: CategorySchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  @ApiConflictResponse({
    description: '`CATEGORY_NAME_TAKEN`.',
    standardSchema: ErrorResponseSchema,
  })
  updateCategory(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateCategoryRequestSchema })
    body: z.infer<typeof UpdateCategoryRequestSchema>,
  ): Promise<CategoryDto> {
    return this.menu.updateCategory(id, body);
  }

  @Put('units/:id/categories/order')
  @OwnerOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reordena as categorias da unidade' })
  @ApiOkResponse({ standardSchema: CategoryListSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  async reorderCategories(
    @Param('id', IdPipe) id: string,
    @Body({ schema: CategoryOrderRequestSchema }) body: z.infer<typeof CategoryOrderRequestSchema>,
  ): Promise<{ data: CategoryDto[] }> {
    return { data: await this.menu.reorderCategories(id, body.categoryIds) };
  }

  // ---------------------------------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------------------------------

  @Post('products')
  @OwnerOnly()
  @Idempotent()
  @ApiOperation({ summary: 'Cria um produto (preço em centavos)' })
  @ApiCreatedResponse({ standardSchema: ProductSchema })
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  createProduct(
    @Body({ schema: CreateProductRequestSchema }) body: z.infer<typeof CreateProductRequestSchema>,
  ): Promise<ProductDto> {
    return this.products.create(body);
  }

  @Patch('products/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Altera um produto (vale para pedidos novos, RN-03.12)' })
  @ApiOkResponse({ standardSchema: ProductSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  @ApiConflictResponse({ description: '`VERSION_CONFLICT`.', standardSchema: ErrorResponseSchema })
  updateProduct(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateProductRequestSchema }) body: z.infer<typeof UpdateProductRequestSchema>,
  ): Promise<ProductDto> {
    return this.products.update(id, body);
  }

  @Put('categories/:id/products/order')
  @OwnerOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reordena os produtos da categoria' })
  @ApiOkResponse({ standardSchema: ProductListSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  async reorderProducts(
    @Param('id', IdPipe) id: string,
    @Body({ schema: ProductOrderRequestSchema }) body: z.infer<typeof ProductOrderRequestSchema>,
  ): Promise<{ data: ProductDto[] }> {
    return { data: await this.products.reorder(id, body.productIds) };
  }

  @Post('products/:id/sold-out')
  @PanelAuth()
  @Idempotent()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Marca o produto como esgotado (dono e colaboradores com estação na unidade, RN-03.11)',
  })
  @ApiOkResponse({ standardSchema: ProductSchema })
  @NotFoundResponse()
  @ApiForbiddenResponse({
    description: '`FORBIDDEN`: colaborador sem estação na unidade.',
    standardSchema: ErrorResponseSchema,
  })
  markSoldOut(@Param('id', IdPipe) id: string): Promise<ProductDto> {
    return this.products.setSoldOut(id, true);
  }

  @Delete('products/:id/sold-out')
  @PanelAuth()
  @Idempotent()
  @ApiOperation({
    summary: 'Desmarca o esgotado (dono e colaboradores com estação na unidade, RN-03.11)',
  })
  @ApiOkResponse({ standardSchema: ProductSchema })
  @NotFoundResponse()
  @ApiForbiddenResponse({
    description: '`FORBIDDEN`: colaborador sem estação na unidade.',
    standardSchema: ErrorResponseSchema,
  })
  unmarkSoldOut(@Param('id', IdPipe) id: string): Promise<ProductDto> {
    return this.products.setSoldOut(id, false);
  }

  // ---------------------------------------------------------------------------------------------
  // Modifiers
  // ---------------------------------------------------------------------------------------------

  @Post('modifier-groups')
  @OwnerOnly()
  @Idempotent()
  @ApiOperation({ summary: 'Cria um grupo de modificadores (com as opções, se enviadas)' })
  @ApiCreatedResponse({ standardSchema: ModifierGroupSchema })
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  createModifierGroup(
    @Body({ schema: CreateModifierGroupRequestSchema })
    body: z.infer<typeof CreateModifierGroupRequestSchema>,
  ): Promise<ModifierGroupDto> {
    return this.modifiers.createGroup(body);
  }

  @Patch('modifier-groups/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Altera um grupo de modificadores' })
  @ApiOkResponse({ standardSchema: ModifierGroupSchema })
  @NotFoundResponse()
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  updateModifierGroup(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateModifierGroupRequestSchema })
    body: z.infer<typeof UpdateModifierGroupRequestSchema>,
  ): Promise<ModifierGroupDto> {
    return this.modifiers.updateGroup(id, body);
  }

  @Delete('modifier-groups/:id')
  @OwnerOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove um grupo de modificadores e as suas opções' })
  @ApiNoContentResponse({ description: 'Grupo removido.' })
  @NotFoundResponse()
  deleteModifierGroup(@Param('id', IdPipe) id: string): Promise<void> {
    return this.modifiers.deleteGroup(id);
  }

  @Post('modifiers')
  @OwnerOnly()
  @Idempotent()
  @ApiOperation({ summary: 'Cria uma opção num grupo de modificadores' })
  @ApiCreatedResponse({ standardSchema: ModifierSchema })
  @ApiBadRequestResponse({ description: REFERENCE_DOC, standardSchema: ErrorResponseSchema })
  createModifier(
    @Body({ schema: CreateModifierRequestSchema })
    body: z.infer<typeof CreateModifierRequestSchema>,
  ): Promise<ModifierDto> {
    return this.modifiers.createModifier(body);
  }

  @Patch('modifiers/:id')
  @OwnerOnly()
  @ApiOperation({ summary: 'Altera ou desativa uma opção' })
  @ApiOkResponse({ standardSchema: ModifierSchema })
  @NotFoundResponse()
  updateModifier(
    @Param('id', IdPipe) id: string,
    @Body({ schema: UpdateModifierRequestSchema })
    body: z.infer<typeof UpdateModifierRequestSchema>,
  ): Promise<ModifierDto> {
    return this.modifiers.updateModifier(id, body);
  }
}
