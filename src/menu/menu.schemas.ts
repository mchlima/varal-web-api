import { z } from 'zod';

import type {
  Category,
  Modifier,
  ModifierGroup,
  PriceList,
  Product,
} from '../generated/prisma/client.js';
import { resolvePrepStationId } from '../units/routing.js';
import { ExpectedVersionSchema, NameSchema, SortOrderSchema } from '../units/units.schemas.js';

/** RN-03.09: integer cents, zero or more. */
const PriceCentsSchema = z
  .int()
  .min(0, { message: 'O preço não pode ser negativo.' })
  .max(100_000_000)
  .meta({ description: 'Preço em centavos (inteiro, maior ou igual a zero; RN-03.09).' });

const PriceDeltaCentsSchema = z
  .int()
  .min(0, { message: 'O acréscimo não pode ser negativo.' })
  .max(100_000_000)
  .meta({ description: 'Acréscimo ao preço do produto, em centavos (pode ser zero).' });

const DescriptionSchema = z
  .string()
  .trim()
  .max(120, { message: 'Use no máximo 120 caracteres.' })
  .meta({ description: 'Descrição curta, até 120 caracteres.' });

const ChoicesSchema = z.int().min(0).max(50);

// ------------------------------------------------------------------------------------------------
// Responses
// ------------------------------------------------------------------------------------------------

export const ModifierSchema = z
  .object({
    id: z.uuid(),
    modifierGroupId: z.uuid(),
    name: z.string(),
    priceDeltaCents: z.int(),
    sortOrder: z.int(),
    active: z.boolean(),
  })
  .meta({ id: 'Modifier' });

export const ModifierGroupSchema = z
  .object({
    id: z.uuid(),
    productId: z.uuid(),
    name: z.string(),
    minChoices: z.int(),
    maxChoices: z.int(),
    required: z.boolean().meta({
      description:
        'Mínimo ≥ 1: o balcão não envia o item sem escolher (RN-03.13; CA-03.06, aplicado no envio do pedido, spec 04).',
    }),
    sortOrder: z.int(),
    modifiers: z.array(ModifierSchema),
  })
  .meta({ id: 'ModifierGroup' });

export const ProductSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    categoryId: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    priceCents: z.int(),
    stationId: z
      .uuid()
      .nullable()
      .meta({ description: 'Estação de preparo própria; `null` usa a da categoria.' }),
    prepStationId: z.uuid().meta({
      description:
        'Estação de preparo resolvida: a do produto ou, sem ela, a da categoria (RN-03.08).',
    }),
    sortOrder: z.int(),
    active: z.boolean(),
    soldOut: z.boolean(),
    version: z.int().meta({ description: 'Versão do produto (`product.sold_out_changed`).' }),
  })
  .meta({ id: 'Product' });

export const ProductListPriceSchema = z
  .object({
    priceListId: z.uuid(),
    priceCents: z.int().meta({ description: 'Preço do produto nesta tabela (RN-03.21).' }),
  })
  .meta({ id: 'ProductListPrice' });

export const MenuProductSchema = ProductSchema.extend({
  modifierGroups: z.array(ModifierGroupSchema),
  prices: z.array(ProductListPriceSchema).meta({
    description:
      'Preços do produto nas tabelas da unidade que aparecem em `priceLists` (sem linha = preço normal, RN-03.21).',
  }),
  effectivePriceCents: z.int().meta({
    description:
      'Preço que um item novo usa agora: o da tabela efetiva da unidade ou o preço normal (RN-04.32, RN-04.33).',
  }),
}).meta({ id: 'MenuProduct' });

export const CategorySchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    name: z.string(),
    sortOrder: z.int(),
    defaultStationId: z.uuid().meta({ description: 'Estação de preparo padrão dos produtos.' }),
    active: z.boolean(),
  })
  .meta({ id: 'Category' });

export const MenuCategorySchema = CategorySchema.extend({
  products: z.array(MenuProductSchema),
}).meta({ id: 'MenuCategory' });

export const PriceListSchema = z
  .object({
    id: z.uuid(),
    unitId: z.uuid(),
    name: z.string(),
    sortOrder: z.int(),
    active: z.boolean(),
    productCount: z.int().meta({ description: 'Quantos produtos têm preço nesta tabela.' }),
    current: z.boolean().meta({ description: 'É a tabela vigente da unidade (RN-04.06).' }),
    version: z.int(),
  })
  .meta({ id: 'PriceList', description: 'Tabela de preço da unidade (spec 03, seção 5.3).' });

export type PriceListDto = z.infer<typeof PriceListSchema>;

export const MenuSchema = z
  .object({
    unitId: z.uuid(),
    version: z.int().meta({ description: 'Versão do cardápio (`menu.updated`).' }),
    priceLists: z.array(PriceListSchema).meta({
      description:
        'Tabelas de preço da unidade: todas para o dono, só as ativas para o colaborador.',
    }),
    currentPriceListId: z.uuid().nullable().meta({
      description: 'Tabela vigente da unidade (RN-04.06); `null` = "Normal".',
    }),
    effectivePriceListId: z.uuid().nullable().meta({
      description:
        'Tabela efetiva: a do evento em andamento, ou a vigente (RN-04.32); `null` = "Normal".',
    }),
    effectivePriceListName: z.string().meta({
      description: 'Nome da tabela efetiva para a faixa do balcão ("Normal", "Evento"; RN-04.33).',
    }),
    categories: z.array(MenuCategorySchema),
  })
  .meta({
    id: 'Menu',
    description:
      'Cardápio da unidade em ordem. O dono recebe tudo (com `active`); o colaborador só categorias, produtos e modificadores ativos (RN-03.10).',
  });

export type ModifierDto = z.infer<typeof ModifierSchema>;
export type ModifierGroupDto = z.infer<typeof ModifierGroupSchema>;
export type ProductDto = z.infer<typeof ProductSchema>;
export type CategoryDto = z.infer<typeof CategorySchema>;
export type MenuDto = z.infer<typeof MenuSchema>;

// ------------------------------------------------------------------------------------------------
// Requests
// ------------------------------------------------------------------------------------------------

export const CreateCategoryRequestSchema = z
  .object({
    unitId: z.uuid(),
    name: NameSchema,
    defaultStationId: z.uuid().optional().meta({
      description:
        'Estação de fila da unidade; sem ela, a Cozinha (ou a primeira estação de fila).',
    }),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CreateCategoryRequest' });

export const UpdateCategoryRequestSchema = z
  .object({
    name: NameSchema.optional(),
    defaultStationId: z.uuid().optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'UpdateCategoryRequest' });

export const CategoryOrderRequestSchema = z
  .object({
    categoryIds: z
      .array(z.uuid())
      .max(500)
      .meta({ description: 'Todas as categorias da unidade, na nova ordem.' }),
  })
  .meta({ id: 'CategoryOrderRequest' });

export const CategoryListSchema = z
  .object({ data: z.array(CategorySchema) })
  .meta({ id: 'CategoryList' });

export const CreateProductRequestSchema = z
  .object({
    categoryId: z.uuid(),
    name: NameSchema,
    description: DescriptionSchema.nullable().optional(),
    priceCents: PriceCentsSchema,
    stationId: z.uuid().nullable().optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CreateProductRequest' });

export const UpdateProductRequestSchema = z
  .object({
    categoryId: z.uuid().optional().meta({ description: 'Outra categoria da mesma unidade.' }),
    name: NameSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    priceCents: PriceCentsSchema.optional(),
    stationId: z.uuid().nullable().optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'UpdateProductRequest' });

export const ProductOrderRequestSchema = z
  .object({
    productIds: z
      .array(z.uuid())
      .max(1000)
      .meta({ description: 'Todos os produtos da categoria, na nova ordem.' }),
  })
  .meta({ id: 'ProductOrderRequest' });

export const ProductListSchema = z
  .object({ data: z.array(ProductSchema) })
  .meta({ id: 'ProductList' });

const NewModifierSchema = z.object({
  name: NameSchema,
  priceDeltaCents: PriceDeltaCentsSchema.default(0),
  sortOrder: SortOrderSchema.optional(),
  active: z.boolean().optional(),
});

export const CreateModifierGroupRequestSchema = z
  .object({
    productId: z.uuid(),
    name: NameSchema,
    minChoices: ChoicesSchema.meta({
      description: 'Mínimo de escolhas; ≥ 1 torna o grupo obrigatório (RN-03.13).',
    }),
    maxChoices: ChoicesSchema.meta({ description: 'Máximo de escolhas, pelo menos 1.' }),
    sortOrder: SortOrderSchema.optional(),
    modifiers: z
      .array(NewModifierSchema)
      .max(50)
      .default([])
      .meta({ description: 'Opções criadas junto com o grupo.' }),
  })
  .meta({ id: 'CreateModifierGroupRequest' });

export const UpdateModifierGroupRequestSchema = z
  .object({
    name: NameSchema.optional(),
    minChoices: ChoicesSchema.optional(),
    maxChoices: ChoicesSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .meta({ id: 'UpdateModifierGroupRequest' });

export const CreateModifierRequestSchema = NewModifierSchema.extend({
  modifierGroupId: z.uuid(),
}).meta({ id: 'CreateModifierRequest' });

export const UpdateModifierRequestSchema = z
  .object({
    name: NameSchema.optional(),
    priceDeltaCents: PriceDeltaCentsSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'UpdateModifierRequest' });

export const PriceListListSchema = z
  .object({ data: z.array(PriceListSchema) })
  .meta({ id: 'PriceListList' });

const PriceListNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Informe o nome da tabela.' })
  .max(30, { message: 'Use no máximo 30 caracteres.' })
  .meta({
    description: 'De 1 a 30 caracteres, único na unidade; "Normal" é reservado (RN-03.20).',
  });

export const CreatePriceListRequestSchema = z
  .object({
    name: PriceListNameSchema,
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'CreatePriceListRequest' });

export const UpdatePriceListRequestSchema = z
  .object({
    name: PriceListNameSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
    active: z.boolean().optional().meta({
      description:
        'Desativar a tabela vigente ou a de um evento agendado ou em andamento é recusado (`PRICE_LIST_IN_USE`, RN-03.23).',
    }),
    version: ExpectedVersionSchema.optional(),
  })
  .meta({ id: 'UpdatePriceListRequest' });

const NullablePriceSchema = PriceCentsSchema.nullable().meta({
  description:
    'Preço em centavos; `null` remove o preço da tabela (o produto volta ao preço normal).',
});

export const PutPriceListPricesRequestSchema = z
  .object({
    prices: z
      .array(z.object({ productId: z.uuid(), priceCents: NullablePriceSchema }))
      .max(1000)
      .refine(
        (rows) => new Set(rows.map((row) => row.productId.toLowerCase())).size === rows.length,
        {
          message: 'Cada produto aparece uma vez só.',
        },
      ),
  })
  .meta({
    id: 'PutPriceListPricesRequest',
    description: 'Preços de vários produtos numa tabela, salvos de uma vez (RN-03.22).',
  });

export const PutProductPricesRequestSchema = z
  .object({
    prices: z
      .array(z.object({ priceListId: z.uuid(), priceCents: NullablePriceSchema }))
      .max(100)
      .refine(
        (rows) => new Set(rows.map((row) => row.priceListId.toLowerCase())).size === rows.length,
        { message: 'Cada tabela aparece uma vez só.' },
      ),
  })
  .meta({
    id: 'PutProductPricesRequest',
    description: 'Preços de um produto em várias tabelas, do editor do produto (RN-03.22).',
  });

export const PriceListPricesSchema = z
  .object({
    priceList: PriceListSchema,
    prices: z.array(z.object({ productId: z.uuid(), priceCents: z.int() })),
  })
  .meta({ id: 'PriceListPrices', description: 'A tabela com os preços que ela tem.' });

export type PriceListPricesDto = z.infer<typeof PriceListPricesSchema>;

export const ProductPricesSchema = z
  .object({ productId: z.uuid(), prices: z.array(ProductListPriceSchema) })
  .meta({ id: 'ProductPrices' });

export type ProductPricesDto = z.infer<typeof ProductPricesSchema>;

// ------------------------------------------------------------------------------------------------
// Mapping
// ------------------------------------------------------------------------------------------------

export function toPriceListDto(
  list: PriceList,
  extra: { productCount: number; current: boolean },
): PriceListDto {
  return {
    id: list.id,
    unitId: list.unitId,
    name: list.name,
    sortOrder: list.sortOrder,
    active: list.active,
    productCount: extra.productCount,
    current: extra.current,
    version: list.version,
  };
}

export function toCategoryDto(category: Category): CategoryDto {
  return {
    id: category.id,
    unitId: category.unitId,
    name: category.name,
    sortOrder: category.sortOrder,
    defaultStationId: category.defaultStationId,
    active: category.active,
  };
}

export function toProductDto(product: Product, category: { defaultStationId: string }): ProductDto {
  return {
    id: product.id,
    unitId: product.unitId,
    categoryId: product.categoryId,
    name: product.name,
    description: product.description,
    priceCents: product.priceCents,
    stationId: product.stationId,
    prepStationId: resolvePrepStationId(product, category),
    sortOrder: product.sortOrder,
    active: product.active,
    soldOut: product.soldOut,
    version: product.version,
  };
}

export function toModifierDto(modifier: Modifier): ModifierDto {
  return {
    id: modifier.id,
    modifierGroupId: modifier.modifierGroupId,
    name: modifier.name,
    priceDeltaCents: modifier.priceDeltaCents,
    sortOrder: modifier.sortOrder,
    active: modifier.active,
  };
}

export function toModifierGroupDto(group: ModifierGroup, modifiers: Modifier[]): ModifierGroupDto {
  return {
    id: group.id,
    productId: group.productId,
    name: group.name,
    minChoices: group.minChoices,
    maxChoices: group.maxChoices,
    required: group.minChoices >= 1,
    sortOrder: group.sortOrder,
    modifiers: modifiers.map(toModifierDto),
  };
}
